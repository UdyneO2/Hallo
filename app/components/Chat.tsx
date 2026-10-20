'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Avatar from 'boring-avatars';
import ThemeToggle from './ThemeToggle';

type Message = { id: string; kind: 'chat' | 'system'; clientId: string; name: string; text: string; ts: number; avatarUrl?: string };
type DM = { id: string; from: string; to: string; text: string; ts: number };
type User = { clientId: string; name: string; nick?: string; customStatus?: string; avatarUrl?: string };
type PopupEvent = { id: string; message: string; status: 'online' | 'offline' };

type ServerEvent =
  | { type: 'history'; messages: Message[] }
  | { type: 'message'; message: Message }
  | { type: 'presence'; count: number; users: User[] }
  | { type: 'typing'; clientId: string; name: string }
  | { type: 'nick_ok'; nick: string; contacts: string[] }
  | { type: 'nick_error'; reason: 'invalid' | 'taken' }
  | { type: 'contacts'; contacts: string[] }
  | { type: 'contact_error'; reason: 'self' | 'not_found' }
  | { type: 'dm'; message: DM }
  | { type: 'dm_history'; with: string; messages: DM[] }
  | { type: 'user_joined'; nick: string }
  | { type: 'user_left'; nick: string };

// seed = nick pengirim; avatar aslinya dicari dari daftar online (selalu terbaru).
type Row = { id: string; kind: 'chat' | 'system'; seed: string; name: string; text: string; mine: boolean; avatarUrl?: string };
type Status = 'connecting' | 'online' | 'offline';
type Tick = 'wait' | 'read' | 'sent' | null;

const MAX_RENDERED = 50;
const TYPING_THROTTLE_MS = 2000;
const TYPING_CLEAR_MS = 3000;
const MAX_POPUPS = 3;

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/api/ws`;
}

const chip = (on: boolean) =>
  `shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
    on ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
  }`;

// Bunyi notifikasi lewat WebAudio: tanpa unduhan file, satu AudioContext dipakai ulang.
let audioCtx: AudioContext | null = null;
function playPopSound() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audioCtx ??= new AC();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.12);
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  } catch {}
}

// Avatar custom (https saja) atau avatar bawaan; jatuh ke bawaan kalau gambar gagal dimuat.
const UserAvatar = memo(function UserAvatar({ seed, url, size = 32 }: { seed: string; url?: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (url && /^https:\/\//i.test(url) && failed !== url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(url)}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full object-cover ring-2 ring-white dark:ring-zinc-950"
      />
    );
  }
  return (
    <span className="shrink-0 rounded-full ring-2 ring-white dark:ring-zinc-950">
      <Avatar size={size} name={seed} variant="beam" />
    </span>
  );
});

function renderMessageText(text: string) {
  return text.split('\n').map((line, i) =>
    line.startsWith('>') ? (
      <span key={i} className="mb-0.5 block border-l-2 border-white/40 pl-2 text-xs italic text-white/80 dark:border-zinc-500 dark:text-zinc-400">
        {line.substring(1).trim()}
      </span>
    ) : (
      <span key={i} className="mt-0.5 block">{line}</span>
    ),
  );
}

// Satu baris pesan. memo: ketikan/presence/popup tidak membuat semua baris dirender ulang.
const MessageRow = memo(function MessageRow({
  row,
  avatarUrl,
  tick,
  onReply,
}: {
  row: Row;
  avatarUrl?: string;
  tick: Tick;
  onReply: (r: { name: string; text: string }) => void;
}) {
  if (row.kind === 'system') {
    return <li className="self-center rounded-full bg-zinc-100 px-3 py-0.5 text-[11px] font-medium text-zinc-400 dark:bg-zinc-800">{row.text}</li>;
  }
  return (
    <li className={`group flex items-end gap-2 ${row.mine ? 'flex-row-reverse' : 'flex-row'}`}>
      <UserAvatar seed={row.seed} url={avatarUrl} size={28} />
      <div className={`flex min-w-0 max-w-[75%] flex-col ${row.mine ? 'items-end' : 'items-start'}`}>
        <span className="mb-0.5 px-1 text-[11px] text-zinc-400 dark:text-zinc-500">{row.mine ? 'Kamu' : `@${row.name}`}</span>
        <div className={`flex items-center gap-2 ${row.mine ? 'flex-row-reverse' : 'flex-row'}`}>
          <span className={`w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${row.mine ? 'rounded-br-sm bg-blue-600 text-white' : 'rounded-bl-sm bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'}`}>
            {renderMessageText(row.text)}
          </span>
          <button onClick={() => onReply({ name: row.name, text: row.text })} title="Balas" className="px-1 text-lg text-zinc-400 opacity-0 transition-opacity hover:text-blue-500 group-hover:opacity-100">
            ↩
          </button>
        </div>
        {tick && (
          <span className="mt-0.5 flex items-center pr-1 text-[10px]">
            {tick === 'wait' ? (
              <span className="text-zinc-300" title="Menunggu koneksi">🕒</span>
            ) : tick === 'read' ? (
              <span className="font-bold tracking-tighter text-blue-500" title="Dibaca / Online">✓✓</span>
            ) : (
              <span className="font-bold text-zinc-400" title="Terkirim">✓</span>
            )}
          </span>
        )}
      </div>
    </li>
  );
});

export default function Chat({ clientId, nick, secret, onLeave, onNickError }: { clientId: string; nick: string; secret: string; onLeave?: () => void; onNickError?: (reason: 'invalid' | 'taken') => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<Status>('connecting');
  const [everConnected, setEverConnected] = useState(false);
  const [draft, setDraft] = useState('');

  const [showProfile, setShowProfile] = useState(false);
  const [myStatus, setMyStatus] = useState(() => localStorage.getItem('chat:status') || 'sedang online');
  const [myAvatar, setMyAvatar] = useState(() => localStorage.getItem('chat:avatar') || '');

  const [popups, setPopups] = useState<PopupEvent[]>([]);
  const [replyTo, setReplyTo] = useState<{ name: string; text: string } | null>(null);
  const [showDmOptions, setShowDmOptions] = useState(false);

  const [typing, setTyping] = useState<Record<string, string>>({});
  const [contacts, setContacts] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dms, setDms] = useState<Record<string, DM[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [contactInput, setContactInput] = useState('');
  const [contactError, setContactError] = useState('');

  const socketRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLLIElement | null>(null);
  const lastTypingSent = useRef(0);
  const activeRef = useRef<string | null>(null);
  const onNickErrorRef = useRef(onNickError);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Status & avatar dibaca lewat ref saat (re)connect, jadi mengubahnya TIDAK memutus koneksi.
  const statusRef = useRef(myStatus);
  const avatarRef = useRef(myAvatar);

  useEffect(() => {
    onNickErrorRef.current = onNickError;
  }, [onNickError]);

  useEffect(() => {
    const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) Pesan Baru` : 'Chat App';
  }, [unread]);

  const showPopup = useCallback((message: string, userStatus: 'online' | 'offline') => {
    const id = Math.random().toString(36).slice(2, 9);
    setPopups((prev) => [...prev, { id, message, status: userStatus }].slice(-MAX_POPUPS));
    setTimeout(() => setPopups((prev) => prev.filter((p) => p.id !== id)), 3500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1000;
    const timers = typingTimers.current;

    function connect() {
      if (cancelled) return;
      setStatus('connecting');
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectDelay = 1000;
        setStatus('online');
        setEverConnected(true);
        socket.send(JSON.stringify({ type: 'join', clientId, name: nick }));
        socket.send(JSON.stringify({ type: 'setNick', nick, secret }));
        socket.send(JSON.stringify({ type: 'setStatus', status: statusRef.current, avatarUrl: avatarRef.current }));
        if (activeRef.current) socket.send(JSON.stringify({ type: 'dmHistory', with: activeRef.current }));
      });

      socket.addEventListener('message', (event) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (data.type) {
          case 'user_joined':
            if (data.nick && data.nick !== nick) showPopup(`@${data.nick} bergabung`, 'online');
            break;
          case 'user_left':
            if (data.nick && data.nick !== nick) showPopup(`@${data.nick} keluar`, 'offline');
            break;
          case 'history':
            if (Array.isArray(data.messages)) setMessages(data.messages.slice(-MAX_RENDERED));
            break;
          case 'message': {
            if (!data.message?.id) break;
            setMessages((prev) => [...prev, data.message].slice(-MAX_RENDERED));
            const sender = data.message.clientId;
            if (sender !== clientId) playPopSound();
            if (sender) {
              const pending = timers.get(sender);
              if (pending) {
                clearTimeout(pending);
                timers.delete(sender);
              }
              setTyping((prev) => {
                if (!(sender in prev)) return prev;
                const next = { ...prev };
                delete next[sender];
                return next;
              });
            }
            break;
          }
          case 'presence':
            setCount(data.count || 0);
            setUsers(Array.isArray(data.users) ? data.users : []);
            break;
          case 'typing': {
            if (data.clientId === clientId || !data.clientId) break;
            const who = data.clientId;
            setTyping((prev) => ({ ...prev, [who]: data.name || 'anon' }));
            const existing = timers.get(who);
            if (existing) clearTimeout(existing);
            timers.set(
              who,
              setTimeout(() => {
                timers.delete(who);
                setTyping((prev) => {
                  const next = { ...prev };
                  delete next[who];
                  return next;
                });
              }, TYPING_CLEAR_MS),
            );
            break;
          }
          case 'nick_ok':
            setContacts(Array.isArray(data.contacts) ? data.contacts : []);
            break;
          case 'nick_error':
            onNickErrorRef.current?.(data.reason);
            break;
          case 'contacts':
            setContacts(Array.isArray(data.contacts) ? data.contacts : []);
            setContactError('');
            break;
          case 'contact_error':
            setContactError(data.reason === 'self' ? 'Itu nick kamu sendiri.' : 'Nick tidak ditemukan.');
            break;
          case 'dm': {
            const m = data.message;
            if (!m?.id) break;
            const other = m.from === nick ? m.to : m.from;
            if (m.from !== nick) playPopSound();
            setDms((prev) => ({ ...prev, [other]: [...(prev[other] ?? []), m].slice(-MAX_RENDERED) }));
            setContacts((prev) => (prev.includes(other) ? prev : [...prev, other].sort()));
            if (m.from !== nick && activeRef.current !== other) {
              setUnread((prev) => ({ ...prev, [other]: (prev[other] ?? 0) + 1 }));
            }
            break;
          }
          case 'dm_history':
            if (data.with && Array.isArray(data.messages)) {
              setDms((prev) => ({ ...prev, [data.with]: data.messages.slice(-MAX_RENDERED) }));
            }
            break;
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) return;
        setStatus('offline');
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      });
      socket.addEventListener('error', () => socket.close());
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [clientId, nick, secret, showPopup]);

  // Avatar terbaru semua user online, dicari lewat nick. Inilah yang membuat perubahan avatar langsung terlihat.
  const avatarByNick = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) if (u?.avatarUrl) map.set(u.nick || u.name, u.avatarUrl);
    return map;
  }, [users]);

  const rows: Row[] = useMemo(
    () =>
      active
        ? (dms[active] ?? []).map((m) => ({ id: m.id, kind: 'chat' as const, seed: m.from, name: m.from, text: m.text, mine: m.from === nick }))
        : messages.map((m) => ({
            id: m.id,
            kind: m.kind || ('chat' as const),
            seed: m.name || m.clientId,
            name: m.name || m.clientId,
            text: m.text,
            mine: m.clientId === clientId,
            avatarUrl: m.avatarUrl, // cadangan untuk pengirim yang sudah offline
          })),
    [active, dms, messages, nick, clientId],
  );

  // Scroll hanya saat jumlah pesan / chat aktif berubah (bukan tiap ada yang mengetik).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [rows.length, active]);

  const sendJson = (payload: object): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  const updateStatus = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const cleanStatus = String(fd.get('status') ?? '').trim() || 'sedang online';
    const cleanAvatar = String(fd.get('avatarUrl') ?? '').trim();

    localStorage.setItem('chat:status', cleanStatus);
    localStorage.setItem('chat:avatar', cleanAvatar);
    statusRef.current = cleanStatus;
    avatarRef.current = cleanAvatar;
    setMyStatus(cleanStatus);
    setMyAvatar(cleanAvatar);
    setShowProfile(false);
    sendJson({ type: 'setStatus', status: cleanStatus, avatarUrl: cleanAvatar });
  };

  const selectChat = (who: string | null) => {
    activeRef.current = who;
    setActive(who);
    setShowDmOptions(false);
    if (who) {
      setUnread((prev) => {
        if (!prev[who]) return prev;
        const next = { ...prev };
        delete next[who];
        return next;
      });
      sendJson({ type: 'dmHistory', with: who });
    }
  };

  const clearDmHistory = () => {
    if (active) setDms((prev) => ({ ...prev, [active]: [] }));
    setShowDmOptions(false);
  };

  const closeActiveDm = () => {
    if (!active) return;
    const toRemove = active;
    selectChat(null);
    setContacts((prev) => prev.filter((c) => c !== toRemove));
  };

  const addContact = (event: FormEvent) => {
    event.preventDefault();
    const value = contactInput.trim().toLowerCase().replace(/^@/, '');
    if (!value) return;
    setContactError('');
    sendJson({ type: 'addContact', nick: value });
    setContactInput('');
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    const now = Date.now();
    if (!active && value && now - lastTypingSent.current > TYPING_THROTTLE_MS && sendJson({ type: 'typing' })) {
      lastTypingSent.current = now;
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    let text = draft.trim();
    if (!text) return;
    if (replyTo) text = `> ${replyTo.name}:\n> ${replyTo.text}\n\n${text}`;
    const ok = active ? sendJson({ type: 'dm', to: active, text }) : sendJson({ type: 'message', text });
    if (!ok) return;
    setReplyTo(null);
    setDraft('');
    lastTypingSent.current = 0;
  };

  // Loading penuh hanya saat pertama kali; reconnect berikutnya tidak mengganti seluruh layar.
  if (status === 'connecting' && !everConnected) {
    return (
      <div className="flex w-full flex-1 flex-col items-center justify-center bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <h2 className="mb-6 animate-pulse text-2xl font-bold">Hallo?</h2>
        <div className="relative h-1.5 w-48 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="absolute bottom-0 left-0 top-0 w-1/3 animate-bounce rounded-full bg-blue-600" />
        </div>
        <p className="mt-4 text-xs text-zinc-400">Menghubungkan ke server...</p>
      </div>
    );
  }

  const typingNames = active ? [] : Object.values(typing);
  const typingLabel = typingNames.length === 0 ? '' : typingNames.length === 1 ? `${typingNames[0]} is typing…` : 'Several people are typing…';

  const activeUserObj = active ? users.find((u) => (u.nick || u.name) === active) : undefined;
  const isOpponentOnline = !!activeUserObj;
  const onlineCount = status === 'online' ? Math.max(count, 1) : count;
  const tick: Tick = active ? (status !== 'online' ? 'wait' : isOpponentOnline ? 'read' : 'sent') : null;

  return (
    <div className="relative flex w-full max-w-2xl flex-1 flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="pointer-events-none absolute left-1/2 top-4 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {popups.map((popup) => (
          <div key={popup.id} className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-lg ${popup.status === 'online' ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'border border-red-100 bg-red-50 text-red-600'}`}>
            <span className={`h-2 w-2 rounded-full ${popup.status === 'online' ? 'bg-green-400' : 'bg-red-500'}`} />
            {popup.message}
          </div>
        ))}
      </div>

      {showProfile && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex w-full max-w-xs flex-col items-center rounded-2xl bg-white p-6 shadow-xl dark:bg-zinc-900">
            <UserAvatar seed={nick} url={myAvatar} size={72} />
            <h2 className="mt-4 text-lg font-bold">@{nick}</h2>
            <form onSubmit={updateStatus} className="mt-4 flex w-full flex-col gap-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Status Profil</label>
                <input name="status" defaultValue={myStatus} placeholder="Mis: Sedang makan..." maxLength={40} className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Link Avatar Custom (https, opsional)</label>
                <input name="avatarUrl" defaultValue={myAvatar} inputMode="url" maxLength={500} placeholder="https://... .jpg/.png" className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15" />
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setShowProfile(false)} className="flex-1 rounded-lg bg-zinc-100 py-2 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Batal</button>
                <button type="submit" className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white">Simpan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-black/10 bg-white px-4 py-3 dark:border-white/15 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          {active ? (
            <div className="flex items-center gap-3">
              <UserAvatar seed={active} url={activeUserObj?.avatarUrl} size={32} />
              <div className="flex flex-col">
                <span className="text-sm font-bold leading-none">@{active}</span>
                <span className={`mt-1 max-w-[150px] truncate text-[10px] font-medium ${isOpponentOnline ? 'text-green-500' : 'text-zinc-400'}`}>
                  {isOpponentOnline ? activeUserObj?.customStatus || 'sedang online' : 'Offline'}
                </span>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowProfile(true)} className="flex items-center gap-2 text-left transition-opacity hover:opacity-80">
              <UserAvatar seed={nick} url={myAvatar} size={32} />
              <div className="flex flex-col">
                <span className="text-sm font-bold leading-none">@{nick}</span>
                <span className="mt-1 max-w-[100px] truncate text-[10px] text-zinc-500">{myStatus}</span>
              </div>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          {active ? (
            <div className="relative">
              <button onClick={() => setShowDmOptions((v) => !v)} className="flex h-8 w-8 items-center justify-center rounded-full font-bold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">⋮</button>
              {showDmOptions && (
                <div className="absolute right-0 top-10 z-50 w-40 overflow-hidden rounded-xl border border-black/10 bg-white py-1 text-sm shadow-lg dark:border-white/10 dark:bg-zinc-800">
                  <button onClick={clearDmHistory} className="w-full px-4 py-2 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700">Bersihkan Chat</button>
                  <button onClick={closeActiveDm} className="w-full px-4 py-2 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30">Tutup DM</button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end">
                <div className="flex -space-x-2">
                  {users.slice(0, 5).map((user) => (
                    <span key={user.clientId} title={`@${user.nick || user.name} - ${user.customStatus || 'sedang online'}`}>
                      <UserAvatar seed={user.nick || user.name} url={user.avatarUrl} size={24} />
                    </span>
                  ))}
                </div>
                <span className="mt-1 pr-1 text-[10px] font-bold tracking-tight text-green-500">{onlineCount} Online</span>
              </div>
              {onLeave && <button onClick={onLeave} className="text-xs text-red-500 hover:underline">Keluar</button>}
            </div>
          )}
        </div>
      </header>

      <nav className="scrollbar-hide flex items-center gap-2 overflow-x-auto border-b border-black/10 px-4 py-2 dark:border-white/15">
        <button type="button" onClick={() => selectChat(null)} className={chip(active === null)}>Global</button>
        {contacts.map((contact) => (
          <button key={contact} type="button" onClick={() => selectChat(contact)} className={chip(active === contact)}>
            @{contact}
            {unread[contact] ? <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] text-white">{unread[contact]}</span> : null}
          </button>
        ))}
      </nav>

      {!active && (
        <form onSubmit={addContact} className="flex items-center gap-2 border-b border-black/10 px-4 py-2 dark:border-white/15">
          <input value={contactInput} onChange={(event) => setContactInput(event.target.value)} placeholder="Tambah kontak DM (nick)" autoCapitalize="none" autoCorrect="off" className="min-w-0 flex-1 rounded-full border border-black/10 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/15" />
          <button type="submit" disabled={status !== 'online' || !contactInput.trim()} className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">Tambah</button>
        </form>
      )}
      {!active && contactError && <p className="px-4 pt-1 text-xs text-red-500">{contactError}</p>}

      <ol className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {active && rows.length === 0 && <li className="mt-10 self-center text-xs text-zinc-400 dark:text-zinc-500">Belum ada obrolan dengan @{active}. Mulai sapa!</li>}
        {rows.map((row) => (
          <MessageRow
            key={row.id}
            row={row}
            avatarUrl={row.mine ? myAvatar : (avatarByNick.get(row.seed) ?? row.avatarUrl)}
            tick={row.mine ? tick : null}
            onReply={setReplyTo}
          />
        ))}
        <li ref={bottomRef} className="m-0 h-0 w-0 p-0" aria-hidden="true" />
      </ol>

      <div className="h-5 px-4 text-xs font-medium text-blue-500" aria-live="polite">{typingLabel}</div>

      <div className="border-t border-black/10 bg-white px-3 py-3 dark:border-white/15 dark:bg-zinc-950">
        {replyTo && (
          <div className="mb-2 flex items-center justify-between rounded-lg border-l-4 border-blue-500 bg-zinc-100 p-2 dark:bg-zinc-800">
            <div className="flex min-w-0 flex-col">
              <span className="text-[10px] font-bold text-blue-500">Membalas @{replyTo.name}</span>
              <span className="max-w-xs truncate text-xs text-zinc-500">{replyTo.text}</span>
            </div>
            <button onClick={() => setReplyTo(null)} className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700">X</button>
          </div>
        )}
        <form onSubmit={send} className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={active ? `Pesan privat ke @${active}...` : 'Ketik pesan global...'}
            className="flex-1 rounded-full border border-black/10 bg-transparent px-4 py-2 text-sm outline-none transition-all focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/15"
          />
          <button type="submit" disabled={status !== 'online' || !draft.trim()} className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-40">
            Kirim
          </button>
        </form>
      </div>
    </div>
  );
}
