import type { WebSocket } from "ws";
import type Redis from "ioredis";
import { createHash } from "node:crypto";
import { fieldsToObject, redis } from "./redis";

/**
 * Chat hub — coordinates one global room across Vercel Function instances.
 *
 * A WebSocket connection is pinned to a single instance, so cross-instance
 * delivery works by broadcasting locally now and fanning out through Redis.
 * One ioredis client (see ./redis) serves the app; the hub uses a duplicated
 * connection that blocks on XREAD to receive entries in realtime, because a
 * blocking read can't share a connection with regular commands:
 *
 *   - presence → every connection is a member of a sorted set scored by "last
 *                seen". Heartbeats keep it fresh; stale members are pruned. The
 *                roster is deduped by clientId so the count is distinct users.
 *   - messages → broadcast to local sockets immediately, then XADD to a stream.
 *                Each instance parks on a blocking XREAD and fans out entries
 *                that originated elsewhere the instant they land. New clients
 *                replay recent history.
 *   - typing   → same as messages but on a separate, transient stream that is
 *                never replayed as history.
 *
 * Without a TCP Redis URL it degrades to a single in-memory instance, so the
 * example still runs before Upstash is provisioned.
 */

export type Message = { id: string; kind: "chat" | "system"; clientId: string; name: string; text: string; ts: number; avatarUrl?: string };
export type User = { clientId: string; name: string; customStatus?: string; avatarUrl?: string };
export type DM = { id: string; from: string; to: string; text: string; ts: number };

type ServerEvent =
  | { type: "history"; messages: Message[] }
  | { type: "message"; message: Message }
  | { type: "presence"; count: number; users: User[] }
  | { type: "typing"; clientId: string; name: string }
  | { type: "nick_ok"; nick: string; contacts: string[] }
  | { type: "nick_error"; reason: "invalid" | "taken" }
  | { type: "contacts"; contacts: string[] }
  | { type: "contact_error"; reason: "self" | "not_found" }
  | { type: "dm"; message: DM }
  | { type: "dm_history"; with: string; messages: DM[] }
  | { type: "user_joined"; nick: string }
  | { type: "user_left"; nick: string };


const CONNS_KEY = "chat:conns"; // ZSET connectionId -> lastSeen ms
const META_KEY = "chat:connmeta"; // HASH connectionId -> { clientId, name }
const MSG_STREAM = "chat:messages"; // durable message log + cross-instance relay
const TYPING_STREAM = "chat:typing"; // transient typing relay
const DM_STREAM = "chat:dm"; // relay DM lintas instance
const NOTIF_STREAM = "chat:notifs";
const DM_MAXLEN = 500;
const DMLOG_MAXLEN = 100; // riwayat per pasangan nick
const DM_HISTORY = 50;
const NICK_RE = /^[a-z0-9_]{3,20}$/;

const CONN_TTL_MS = 30_000; // a connection is gone if not refreshed within this window
const HEARTBEAT_MS = 10_000; // how often we refresh our local connections
const PRESENCE_MS = 3_000; // how often we recompute + broadcast presence
const BLOCK_MS = 5_000; // XREAD BLOCK timeout — wakes the loop to observe shutdown
const MSG_MAXLEN = 200; // cap the message stream
const TYPING_MAXLEN = 50;
const NOTIF_MAXLEN = 50; // cap the typing stream
const HISTORY = 50; // messages replayed to a newly-joined client

type ConnMeta = { clientId: string; name: string; avatarUrl?: string; customStatus?: string };
type Conn = { connectionId: string; clientId: string; name: string; nick: string; avatarUrl?: string; customStatus?: string };
type StreamFields = { d: string; o: string };

type Hub = {
  instanceId: string;
  conns: Map<WebSocket, Conn>;
  lastMsgId: string;
  lastTypingId: string;
  lastDmId: string;
  heartbeat: ReturnType<typeof setInterval> | null;
  presence: ReturnType<typeof setInterval> | null;
  streamClient: Redis | null; // TCP client running the blocking read loop
  streaming: boolean; // is the read loop currently active?
  lastNotifId: string;
  lastPresence: string; // serialized last-broadcast presence, for change detection
};

// Persist the hub across dev HMR reloads so we don't leak timers / sockets.
const globalForHub = globalThis as unknown as { __chatHub?: Hub };

const hub: Hub =
  globalForHub.__chatHub ??
  (globalForHub.__chatHub = {
    instanceId: crypto.randomUUID(),
    conns: new Map<WebSocket, Conn>(),
    lastMsgId: "0-0",
    lastTypingId: "0-0",
    lastDmId: "0-0",
    lastNotifId: "0-0",
    heartbeat: null,
    presence: null,
    streamClient: null,
    streaming: false,
    lastPresence: "",
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Defensive JSON parse: stream payloads arrive as strings, but tolerate objects. */
function parseJson<T>(value: unknown): T | null {
  try {
    const obj = typeof value === "string" ? JSON.parse(value) : value;
    return obj && typeof obj === "object" ? (obj as T) : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, event: ServerEvent): void {
  // 1 === WebSocket.OPEN
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // best-effort; a failed send surfaces as a 'close' event
  }
}

function broadcast(event: ServerEvent): void {
  for (const ws of hub.conns.keys()) send(ws, event);
}

/** Mark a connection as recently seen (presence + metadata). */
async function touch(conn: Conn): Promise<void> {
  if (!redis || !conn.clientId) return;
  try {
    await redis.zadd(CONNS_KEY, Date.now(), conn.connectionId);
    await redis.hset(
      META_KEY,
      conn.connectionId,
      JSON.stringify({
        clientId: conn.clientId,
        name: conn.name,
        customStatus: conn.customStatus || "sedang online",
      } satisfies ConnMeta),
    );
  } catch (err) {
    console.error("[chat] touch failed", err);
  }
}

/** Compute the current distinct-user roster and count. */
async function computePresence(): Promise<{ count: number; users: User[] }> {
  const seen = new Map<string, User>();

  if (!redis) {
    for (const conn of hub.conns.values()) {
      if (conn.clientId)
        seen.set(conn.clientId, { clientId: conn.clientId, name: conn.name, customStatus: conn.customStatus || "sedang online" });
    }
    return { count: seen.size, users: [...seen.values()] };
  }

  try {
    // Prune connections we haven't heard from within the TTL (members + metadata).
    const cutoff = Date.now() - CONN_TTL_MS;
    const stale = await redis.zrangebyscore(CONNS_KEY, "-inf", cutoff);
    if (stale.length) {
      await redis.zrem(CONNS_KEY, ...stale);
      await redis.hdel(META_KEY, ...stale);
    }

    const members = await redis.zrange(CONNS_KEY, 0, -1);
    if (members.length === 0) return { count: 0, users: [] };

    const meta = await redis.hmget(META_KEY, ...members);
    for (const raw of meta) {
      const entry = parseJson<ConnMeta>(raw);
      if (entry?.clientId) {
        seen.set(entry.clientId, {
          clientId: entry.clientId,
          name: entry.name,
          customStatus: entry.customStatus || "sedang online",
        });
      }
    }
    return { count: seen.size, users: [...seen.values()] };
  } catch (err) {
    console.error("[chat] computePresence failed", err);
    return { count: seen.size, users: [...seen.values()] };
  }
}

/** Is a given clientId currently connected anywhere (this instance or another)? */
async function isOnline(clientId: string): Promise<boolean> {
  if (!redis) {
    for (const conn of hub.conns.values()) {
      if (conn.clientId === clientId) return true;
    }
    return false;
  }
  try {
    const members = await redis.zrange(CONNS_KEY, 0, -1);
    if (members.length === 0) return false;
    const meta = await redis.hmget(META_KEY, ...members);
    for (const raw of meta) {
      if (parseJson<ConnMeta>(raw)?.clientId === clientId) return true;
    }
    return false;
  } catch (err) {
    console.error("[chat] isOnline failed", err);
    return false;
  }
}

/** Recompute presence and broadcast it when it changed (or when forced). */
async function broadcastPresence(force = false): Promise<void> {
  const { count, users } = await computePresence();
  const snapshot = JSON.stringify({ count, users });
  if (force || snapshot !== hub.lastPresence) {
    hub.lastPresence = snapshot;
    broadcast({ type: "presence", count, users });
  }
}

/**
 * Blocking read loop: park on the message + typing streams over the TCP client
 * and fan out new entries the instant they arrive. Replaces the old ~1.5s
 * polling drain. Runs while `hub.streaming` is true (i.e. while any socket is
 * connected); `BLOCK_MS` bounds each block so the loop wakes to observe a
 * shutdown even when no traffic is flowing.
 */
async function runReadLoop(): Promise<void> {
  const client = hub.streamClient;
  if (!client) return;

  while (hub.streaming) {
    try {
      const res = (await client.xread(
        "BLOCK",
        BLOCK_MS,
        "STREAMS",
        MSG_STREAM,
        TYPING_STREAM,
        DM_STREAM,
        NOTIF_STREAM,
        hub.lastMsgId,
        hub.lastTypingId,
        hub.lastDmId,
        hub.lastNotifId,
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!res) continue; // BLOCK timed out with no new entries

      for (const [key, entries] of res) {
        for (const [id, flat] of entries) {
          const fields = fieldsToObject(flat) as StreamFields;
          if (key === MSG_STREAM) {
            hub.lastMsgId = id;
            if (fields.o === hub.instanceId) continue; // our own — already delivered
            const message = parseJson<Message>(fields.d);
            if (message) broadcast({ type: "message", message });
          } else if (key === DM_STREAM) {
            hub.lastDmId = id;
            if (fields.o === hub.instanceId) continue;
            const dm = parseJson<DM>(fields.d);
            if (dm) deliverDm(dm);
          } else if (key === TYPING_STREAM) {
            hub.lastTypingId = id;
            if (fields.o === hub.instanceId) continue;
            const typing = parseJson<User>(fields.d);
            if (typing) {
              broadcast({
                type: "typing",
                clientId: typing.clientId,
                name: typing.name,
              });
            }
          } else if (key === NOTIF_STREAM) {
            // [BARU] Handler stream notifikasi join/leave
            hub.lastNotifId = id;
            if (fields.o === hub.instanceId) continue;
            const notif = parseJson<{type: "user_joined" | "user_left"; nick: string}>(fields.d);
            if (notif) broadcast(notif);
          }
        }
      }
    } catch (err) {
      if (!hub.streaming) break;
      console.error("[chat] read loop failed", err);
      await sleep(1_000); // brief backoff; ioredis reconnects the socket under us
    }
  }
}

async function heartbeat(): Promise<void> {
  if (!redis) return;
  for (const conn of hub.conns.values()) await touch(conn);
}

/**
 * Start the presence/heartbeat timers and the realtime read loop on the first
 * connection. Fire-and-forget from the (synchronous) `register`, so a `join`
 * frame sent immediately on open is never blocked behind this setup.
 */
async function startStream(): Promise<void> {
  if (!hub.heartbeat)
    hub.heartbeat = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  if (!hub.presence)
    hub.presence = setInterval(() => void broadcastPresence(), PRESENCE_MS);

  if (hub.streaming) return; // reader already running
  if (!redis) return; // no Redis — single-instance fallback (timers still run)

  // A blocking XREAD monopolizes its connection, so the reader runs on its own
  // duplicated connection rather than the shared command client. Claim it
  // synchronously (no await before this) so a second concurrent register() bails
  // at the `hub.streaming` guard above instead of opening a duplicate.
  hub.streamClient = redis.duplicate();
  hub.streaming = true;

  // Start the stream cursors at the current tail so we only pick up new entries.
  for (const [key, field] of [
    [MSG_STREAM, "lastMsgId"],
    [TYPING_STREAM, "lastTypingId"],
    [DM_STREAM, "lastDmId"],
    [NOTIF_STREAM, "lastNotifId"], 
  ] as const) {
    try {
      const tail = await redis.xrevrange(key, "+", "-", "COUNT", 1);
      hub[field] = tail[0]?.[0] ?? "0-0";
    } catch {
      hub[field] = "0-0";
    }
  }

  void runReadLoop();
}

/** Stop the read loop and timers once the last local connection goes away. */
function stopStream(): void {
  hub.streaming = false;
  if (hub.streamClient) {
    void hub.streamClient.quit().catch(() => {});
    hub.streamClient = null;
  }
  if (hub.heartbeat) {
    clearInterval(hub.heartbeat);
    hub.heartbeat = null;
  }
  if (hub.presence) {
    clearInterval(hub.presence);
    hub.presence = null;
  }
}

const clamp = (value: unknown, max: number, fallback = "") =>
  String(value ?? fallback)
    .slice(0, max)
    .trim();

/**
 * Register a freshly-connected socket (identity arrives later via join).
 *
 * Synchronous on purpose: the upgrade handler must add the connection and
 * attach its socket listeners in the same tick, before any `await`, so a
 * `join` frame the client sends immediately on open isn't dropped. The timer
 * setup runs fire-and-forget (it does its own error handling).
 */
export function register(ws: WebSocket): void {
  hub.conns.set(ws, {
    connectionId: crypto.randomUUID(),
    clientId: "",
    name: "",
    nick: "",
    customStatus: "sedang online",
  });
  void startStream();
}

/** Record the client's identity, replay history, and announce presence. */
export async function join(
  ws: WebSocket,
  clientId: string,
  name: string,
): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn) return;
  const cid = clamp(clientId, 64) || crypto.randomUUID();
  const nm = clamp(name, 40) || "anon";
  // Only announce if this user isn't already connected elsewhere (other tab or
  // instance), so reconnects/extra tabs don't spam "joined".
  conn.clientId = cid;
  conn.name = nm;
  await touch(conn);
  send(ws, { type: "history", messages: await loadHistory() });
  await broadcastPresence(true);
}

export async function setStatus(ws: WebSocket, status: string, avatarUrl?: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn) return;
  conn.customStatus = clamp(status, 60, "sedang online");
  
  if (avatarUrl !== undefined) {
    conn.avatarUrl = clamp(avatarUrl, 500, ""); // Mengizinkan URL gambar hingga 500 karakter
  }
  
  await touch(conn);
  await broadcastPresence(true);
}

export async function postMessage(ws: WebSocket, text: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.clientId) return;
  const clean = clamp(text, 2000);
  if (!clean) return;
  const message: Message = {
    id: crypto.randomUUID(),
    kind: "chat",
    clientId: conn.clientId,
    name: conn.name,
    text: clean,
    ts: Date.now(),
    avatarUrl: conn.avatarUrl // [BARU] Sematkan avatar pengirim di pesan
  };
  await publishMessage(message);
}

/** Deliver a message to local sockets now, then persist + fan out via the stream. */
async function publishMessage(message: Message): Promise<void> {
  broadcast({ type: "message", message });
  if (!redis) return;
  try {
    await redis.xadd(
      MSG_STREAM,
      "MAXLEN",
      "~",
      MSG_MAXLEN,
      "*",
      "d",
      JSON.stringify(message),
      "o",
      hub.instanceId,
    );
  } catch (err) {
    console.error("[chat] message xadd failed", err);
  }
}

/** Relay a transient "typing" signal locally and to other instances. */
export async function postTyping(ws: WebSocket): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.clientId) return;
  const payload: User = { clientId: conn.clientId, name: conn.name };
  broadcast({ type: "typing", clientId: payload.clientId, name: payload.name });
  if (!redis) return;
  try {
    await redis.xadd(
      TYPING_STREAM,
      "MAXLEN",
      "~",
      TYPING_MAXLEN,
      "*",
      "d",
      JSON.stringify(payload),
      "o",
      hub.instanceId,
    );
  } catch (err) {
    console.error("[chat] typing xadd failed", err);
  }
}
async function publishNotif(type: "user_joined" | "user_left", nick: string): Promise<void> {
  broadcast({ type, nick }); // Tembak ke koneksi lokal instance ini
  if (!redis) return;
  try {
    await redis.xadd(NOTIF_STREAM, "MAXLEN", "~", NOTIF_MAXLEN, "*", "d", JSON.stringify({ type, nick }), "o", hub.instanceId);
  } catch (err) {
    console.error("[chat] notif xadd failed", err);
  }
}

/** Remove a closed socket and announce the updated presence. */
export async function unregister(ws: WebSocket): Promise<void> {
  const conn = hub.conns.get(ws);
  hub.conns.delete(ws);
  if (redis && conn?.connectionId) {
    try {
      await redis.zrem(CONNS_KEY, conn.connectionId);
      await redis.hdel(META_KEY, conn.connectionId);
    } catch (err) {
      console.error("[chat] unregister cleanup failed", err);
    }
  }
  await broadcastPresence(true);
  if (conn?.clientId && !(await isOnline(conn.clientId))) {
    if (conn.nick) {
      await publishNotif("user_left", conn.nick);
    }
  }
  if (hub.conns.size === 0) stopStream();
}
/** Load the most recent messages in chronological order for a new client. */
export async function loadHistory(): Promise<Message[]> {
  if (!redis) return [];
  try {
    // xrevrange returns newest-first; reverse to chronological order.
    const res = await redis.xrevrange(MSG_STREAM, "+", "-", "COUNT", HISTORY);
    return res
      .reverse()
      .map(([, flat]) => parseJson<Message>(fieldsToObject(flat).d))
      .filter((m): m is Message => m !== null);
  } catch (err) {
    console.error("[chat] loadHistory failed", err);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Private chat (DM) + nick + kontak                                    */
/*   chat:nick:<nick>        STRING  hash(secret) pemilik nick           */
/*   chat:contacts:<nick>    SET     nick kontak milik <nick>            */
/*   chat:dm                 STREAM  relay lintas instance (transient)   */
/*   chat:dmlog:<a>:<b>      STREAM  riwayat DM pasangan (a<b, urut abjad)*/
/* ------------------------------------------------------------------ */

// Fallback tanpa Redis (single instance, hilang saat restart).
const memNicks = new Map<string, string>();
const memContacts = new Map<string, Set<string>>();
const memDmLog = new Map<string, DM[]>();

const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");
const pairKey = (a: string, b: string) => [a, b].sort().join(":");
const normNick = (v: unknown) => clamp(v, 20).toLowerCase();

async function nickExists(nick: string): Promise<boolean> {
  try {
    return redis ? (await redis.exists(`chat:nick:${nick}`)) === 1 : memNicks.has(nick);
  } catch (err) {
    console.error("[chat] nickExists failed", err);
    return false;
  }
}

async function listContacts(nick: string): Promise<string[]> {
  try {
    const list = redis
      ? await redis.smembers(`chat:contacts:${nick}`)
      : [...(memContacts.get(nick) ?? [])];
    return list.sort();
  } catch (err) {
    console.error("[chat] listContacts failed", err);
    return [];
  }
}

/** Kirim DM ke semua socket lokal milik pengirim dan penerima. */
function deliverDm(dm: DM): void {
  for (const [ws, conn] of hub.conns) {
    if (conn.nick && (conn.nick === dm.to || conn.nick === dm.from)) {
      send(ws, { type: "dm", message: dm });
    }
  }
}

/**
 * Klaim / masuk dengan nick. `secret` dibuat klien (simpan di localStorage):
 * yang pertama klaim jadi pemilik, hanya secret yang sama yang bisa pakai lagi.
 */
export async function setNick(ws: WebSocket, rawNick: string, rawSecret: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn) return;
  const nick = normNick(rawNick);
  const secret = clamp(rawSecret, 128);
  if (!NICK_RE.test(nick) || secret.length < 8) {
    send(ws, { type: "nick_error", reason: "invalid" });
    return;
  }
  const h = hashSecret(secret);
  let ok = false;
  try {
    if (!redis) {
      const cur = memNicks.get(nick);
      if (!cur) memNicks.set(nick, h);
      ok = !cur || cur === h;
    } else {
      const key = `chat:nick:${nick}`;
      ok = (await redis.set(key, h, "NX")) === "OK" || (await redis.get(key)) === h;
    }
  } catch (err) {
    console.error("[chat] setNick failed", err);
  }
  if (!ok) {
    send(ws, { type: "nick_error", reason: "taken" });
    return;
  }
  conn.nick = nick;
  send(ws, { type: "nick_ok", nick, contacts: await listContacts(nick) });
await publishNotif("user_joined", nick);
}

/** Tambah kontak berdasarkan nick (nick harus sudah terdaftar). */
export async function addContact(ws: WebSocket, rawNick: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.nick) return;
  const other = normNick(rawNick);
  if (other === conn.nick) {
    send(ws, { type: "contact_error", reason: "self" });
    return;
  }
  if (!NICK_RE.test(other) || !(await nickExists(other))) {
    send(ws, { type: "contact_error", reason: "not_found" });
    return;
  }
  try {
    if (redis) await redis.sadd(`chat:contacts:${conn.nick}`, other);
    else (memContacts.get(conn.nick) ?? memContacts.set(conn.nick, new Set()).get(conn.nick)!).add(other);
  } catch (err) {
    console.error("[chat] addContact failed", err);
    return;
  }
  send(ws, { type: "contacts", contacts: await listContacts(conn.nick) });
}

/** Kirim pesan privat. Pengirim (`from`) selalu diambil dari koneksi, bukan klien. */
export async function postDm(ws: WebSocket, rawTo: string, text: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.nick) return;
  const to = normNick(rawTo);
  const clean = clamp(text, 2000);
  if (!clean || to === conn.nick || !(await nickExists(to))) return;
  const dm: DM = { id: crypto.randomUUID(), from: conn.nick, to, text: clean, ts: Date.now() };
  deliverDm(dm); // lokal dulu
  if (!redis) {
    const k = pairKey(dm.from, dm.to);
    const log = memDmLog.get(k) ?? [];
    log.push(dm);
    memDmLog.set(k, log.slice(-DMLOG_MAXLEN));
    return;
  }
  try {
    const d = JSON.stringify(dm);
    await redis.xadd(DM_STREAM, "MAXLEN", "~", DM_MAXLEN, "*", "d", d, "o", hub.instanceId);
    await redis.xadd(`chat:dmlog:${pairKey(dm.from, dm.to)}`, "MAXLEN", "~", DMLOG_MAXLEN, "*", "d", d);
  } catch (err) {
    console.error("[chat] dm xadd failed", err);
  }
}

/** Kirim riwayat DM dengan satu nick ke pemintanya. */
export async function loadDmHistory(ws: WebSocket, rawWith: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.nick) return;
  const other = normNick(rawWith);
  if (!NICK_RE.test(other)) return;
  let messages: DM[] = [];
  try {
    const k = pairKey(conn.nick, other);
    if (!redis) messages = (memDmLog.get(k) ?? []).slice(-DM_HISTORY);
    else {
      const res = await redis.xrevrange(`chat:dmlog:${k}`, "+", "-", "COUNT", DM_HISTORY);
      messages = res
        .reverse()
        .map(([, flat]) => parseJson<DM>(fieldsToObject(flat).d))
        .filter((m): m is DM => m !== null);
    }
  } catch (err) {
    console.error("[chat] loadDmHistory failed", err);
  }
  send(ws, { type: "dm_history", with: other, messages });
}
