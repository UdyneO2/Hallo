'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Avatar from 'boring-avatars';

type Message = {
  id: string;
  kind: 'chat' | 'system';
  clientId: string;
  name: string;
  text: string;
  ts: number;
};

type DM = { id: string; from: string; to: string; text: string; ts: number };
type User = { clientId: string; name: string; nick?: string; customStatus?: string };
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

type Row = {
  id: string;
  kind: 'chat' | 'system';
  seed: string;
  name: string;
  text: string;
  mine: boolean;
};

type Status = 'connecting' | 'online' | 'offline';

const MAX_RENDERED = 200;
const TYPING_THROTTLE_MS = 2000;
const TYPING_CLEAR_MS = 3000;

function wsUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/api/ws`;
}

const chip = (on: boolean) =>
  `shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
    on
      ? 'bg-blue-600 text-white'
      : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
  }`;

export default function Chat({
  clientId,
  nick,
  secret,
  onLeave,
  onNickError,
}: {
  clientId: string;
  nick: string;
  secret: string;
  onLeave?: () => void;
  onNickError?: (reason: 'invalid' | 'taken') => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<Status>('connecting');
  const [draft, setDraft] = useState('');
  const [showProfile, setShowProfile] = useState(false);
  const [myStatus, setMyStatus] = useState('sedang online');
  const [popups, setPopups] = useState<PopupEvent[]>([]);
  
  // ERROR HANDLING STATE
  const [sysError, setSysError] = useState<string | null>(null);

  const showPopup = (message: string, userStatus: 'online' | 'offline') => {
    const id = Math.random().toString(36).substring(2, 9);
    setPopups((prev) => [...(prev || []), { id, message, status: userStatus }]);
    setTimeout(() => {
      setPopups((prev) => (prev || []).filter((p) => p && p.id !== id));
    }, 3000);
  };

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

  useEffect(() => {
    onNickErrorRef.current = onNickError;
  }, [onNickError]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1000;
    const timers = typingTimers.current;

    function connect() {
      if (cancelled) return;
      setStatus('connecting');
      setSysError(null); // Reset error saat mencoba connect ulang
      
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectDelay = 1000;
        setStatus('online');
        try {
          socket.send(JSON.stringify({ type: 'join', clientId, name: nick })); 
          socket.send(JSON.stringify({ type: 'setNick', nick, secret }));
          if (activeRef.current) {
            socket.send(JSON.stringify({ type: 'dmHistory', with: activeRef.current }));
          }
        } catch (err) {
          console.error("Error sending join payload:", err);
          setSysError("Gagal mengirim data login ke server.");
        }
      });

      socket.addEventListener('message', (event) => {
        try {
          // Tangkap error jika server mengirim data yang cacat/bukan JSON
          let data: ServerEvent;
          try {
            data = JSON.parse(event.data);
          } catch {
            return; // Abaikan pesan non-JSON
          }

          switch (data.type) {
            case 'user_joined':
              if (data.nick && data.nick !== nick) showPopup(`@${data.nick} bergabung`, 'online');
              break;
            case 'user_left':
              if (data.nick && data.nick !== nick) showPopup(`@${data.nick} keluar`, 'offline');
              break;
            case 'history':
              if (Array.isArray(data.messages)) {
                setMessages(data.messages.slice(-MAX_RENDERED));
              }
              break;
            case 'message': {
              if (data.message && data.message.id) {
                setMessages((prev) => [...(prev || []), data.message].slice(-MAX_RENDERED));
                const sender = data.message.clientId;
                if (sender) {
                  const pending = timers.get(sender);
                  if (pending) {
                    clearTimeout(pending);
                    timers.delete(sender);
                  }
                  setTyping((prev) => {
                    if (!prev || !(sender in prev)) return prev;
                    const next = { ...prev };
                    delete next[sender];
                    return next;
                  });
                }
              }
              break;
            }
            case 'presence':
              setCount(data.count || 0);
              setUsers(Array.isArray(data.users) ? data.users : []);
              break;
            case 'typing': {
              if (data.clientId === clientId) break;
              const { clientId: who, name: whoName } = data;
              if (who) {
                setTyping((prev) => ({ ...prev, [who]: whoName || 'anon' }));
                const existing = timers.get(who);
                if (existing) clearTimeout(existing);
                timers.set(
                  who,
                  setTimeout(() => {
                    timers.delete(who);
                    setTyping((prev) => {
                      if (!prev) return prev;
                      const next = { ...prev };
                      delete next[who];
                      return next;
                    });
                  }, TYPING_CLEAR_MS),
                );
              }
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
              if (data.message && data.message.id) {
                const m = data.message;
                const other = m.from === nick ? m.to : m.from;
                setDms((prev) => {
                  const safePrev = prev || {};
                  return { ...safePrev, [other]: [...(safePrev[other] ?? []), m].slice(-MAX_RENDERED) };
                });
                setContacts((prev) => {
                  const safePrev = prev || [];
                  return safePrev.includes(other) ? safePrev : [...safePrev, other].sort();
                });
                if (m.from !== nick && activeRef.current !== other) {
                  setUnread((prev) => {
                    const safePrev = prev || {};
                    return { ...safePrev, [other]: (safePrev[other] ?? 0) + 1 };
                  });
                }
              }
              break;
            }
            case 'dm_history':
              if (data.with && Array.isArray(data.messages)) {
                setDms((prev) => ({ ...(prev || {}), [data.with]: data.messages }));
              }
              break;
          }
        } catch (err: any) {
          console.error("[WebSocket Processing Error]:", err);
          // Jika ada error fatal saat memproses pesan, tampilkan di UI bukan blank
          setSysError(err?.message || "Terjadi kesalahan saat memproses data chat.");
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) return;
        setStatus('offline');
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      });

      socket.addEventListener('error', (event) => {
        console.error("WebSocket Network Error:", event);
        // Error koneksi websocket biasanya tertangkap di sini
      });
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
  }, [clientId, nick, secret]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing, dms, active]);

  const updateStatus = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const newStatus = fd.get('status') as string;
    const cleanStatus = newStatus || 'sedang online';
    setMyStatus(cleanStatus);
    setShowProfile(false); 
    sendJson({ type: 'setStatus', status: cleanStatus }); 
  };

  const sendJson = (payload: object): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  const selectChat = (who: string | null) => {
    activeRef.current = who;
    setActive(who);
    if (who) {
      setUnread((prev) => {
        const safePrev = { ...(prev || {}) };
        delete safePrev[who];
        return safePrev;
      });
      sendJson({ type: 'dmHistory', with: who });
    }
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
    const socket = socketRef.current;
    const now = Date.now();
    if (
      !active && 
      value &&
      socket?.readyState === WebSocket.OPEN &&
      now - lastTypingSent.current > TYPING_THROTTLE_MS
    ) {
      lastTypingSent.current = now;
      socket.send(JSON.stringify({ type: 'typing' }));
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const ok = active
      ? sendJson({ type: 'dm', to: active, text })
      : sendJson({ type: 'message', text });
    if (!ok) return;
    setDraft('');
    lastTypingSent.current = 0;
  };

  // UI RENDER: ERROR SCREEN
  // Jika terjadi error fatal pada data UI, maka tampilkan layar ini
  if (sysError) {
    return (
      <div className="flex flex-1 w-full flex-col items-center justify-center bg-white dark:bg-zinc-950 px-6 text-center">
        <div className="bg-red-100 text-red-600 p-4 rounded-xl border border-red-200">
          <h2 className="font-bold text-lg mb-2">Terjadi Kesalahan Sinkronisasi</h2>
          <p className="text-sm mb-4">{sysError}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="px-4 py-2 bg-red-600 text-white rounded-full text-sm font-medium"
          >
            Muat Ulang Halaman
          </button>
        </div>
      </div>
    );
  }

  // UI RENDER: LOADING SCREEN
  if (status === 'connecting') {
    return (
      <div className="flex flex-1 w-full flex-col items-center justify-center bg-white dark:bg-zinc-950">
        <h2 className="text-2xl font-bold mb-6 text-zinc-800 dark:text-zinc-100 animate-pulse">
          Hallo?
        </h2>
        <div className="w-48 h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden relative">
          <div className="absolute top-0 bottom-0 left-0 w-1/3 bg-blue-600 rounded-full animate-bounce" />
        </div>
        <p className="mt-4 text-xs text-zinc-400">Menghubungkan ke server...</p>
      </div>
    );
  }

  const typingNames = active ? [] : Object.values(typing || {});
  const typingLabel =
    typingNames.length === 0
      ? ''
      : typingNames.length === 1
        ? `${typingNames[0]} is typing…`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing…`
          : 'Several people are typing…';

  const safeDms = Array.isArray(dms[active || '']) ? dms[active || ''] : [];
  const safeMessages = Array.isArray(messages) ? messages : [];

  const rows: Row[] = active
    ? safeDms.filter(Boolean).map((m) => ({
        id: m.id || Math.random().toString(),
        kind: 'chat' as const,
        seed: m.from || 'anon',
        name: m.from || 'anon',
        text: m.text || '',
        mine: m.from === nick,
      }))
    : safeMessages.filter(Boolean).map((m) => ({
        id: m.id || Math.random().toString(),
        kind: m.kind || 'chat',
        seed: m.clientId || 'anon',
        name: m.name || m.clientId || 'anon',
        text: m.text || '',
        mine: m.clientId === clientId,
      }));

  return (
    <div className="flex flex-1 w-full max-w-2xl flex-col relative">
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none">
        {(popups || []).filter(Boolean).map((popup) => (
          <div
            key={popup.id}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full shadow-md text-[11px] font-medium transition-all duration-300 ${
              popup.status === 'online' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-zinc-100 text-zinc-600 border border-zinc-200'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${popup.status === 'online' ? 'bg-green-500' : 'bg-zinc-400'}`} />
            {popup.message}
          </div>
        ))}
      </div>

      {showProfile && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl w-full max-w-xs p-6 flex flex-col items-center shadow-xl">
            <Avatar size={72} name={clientId || 'anon'} variant="beam" />
            <h2 className="mt-4 text-lg font-bold">@{nick || 'anon'}</h2>
            <form onSubmit={updateStatus} className="w-full mt-4 flex flex-col gap-3">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Status Profil</label>
                <input 
                  name="status"
                  defaultValue={myStatus}
                  placeholder="Mis: Sedang makan..."
                  className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15"
                />
              </div>
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={() => setShowProfile(false)} className="flex-1 py-2 text-sm text-zinc-600 bg-zinc-100 dark:bg-zinc-800 rounded-lg">Batal</button>
                <button type="submit" className="flex-1 py-2 text-sm text-white bg-blue-600 rounded-lg font-medium">Simpan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-black/10 bg-white px-4 py-3 dark:border-white/15 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <button onClick={() => setShowProfile(true)} className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left">
            <Avatar size={32} name={clientId || 'anon'} variant="beam" />
            <div className="flex flex-col">
              <span className="text-sm font-bold leading-none">@{nick || 'anon'}</span>
              <span className="text-[10px] text-zinc-500 mt-1 truncate max-w-[100px]">{myStatus}</span>
            </div>
          </button>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {(users || []).filter(Boolean).slice(0, 5).map((user) => (
              <span
                key={user.clientId || Math.random().toString()}
                title={`@${user.nick || user.name || 'anon'} - ${user.customStatus || 'sedang online'}`}
                className="inline-flex rounded-full ring-2 ring-white dark:ring-zinc-950"
              >
                <Avatar size={24} name={user.clientId || 'anon'} variant="beam" />
              </span>
            ))}
          </div>

          {onLeave && (
            <button onClick={onLeave} className="text-xs text-red-500 hover:underline">
              Keluar
            </button>
          )}
        </div>
      </header>

      <nav className="flex items-center gap-2 overflow-x-auto border-b border-black/10 px-4 py-2 dark:border-white/15">
        <button type="button" onClick={() => selectChat(null)} className={chip(active === null)}>
          Global
        </button>
        {(contacts || []).filter(Boolean).map((contact) => (
          <button
            key={contact}
            type="button"
            onClick={() => selectChat(contact)}
            className={chip(active === contact)}
          >
            @{contact}
            {unread[contact] ? (
              <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] text-white">
                {unread[contact]}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <form onSubmit={addContact} className="flex items-center gap-2 border-b border-black/10 px-4 py-2 dark:border-white/15">
        <input
          value={contactInput}
          onChange={(event) => setContactInput(event.target.value)}
          placeholder="Tambah kontak (nick)"
          autoCapitalize="none"
          autoCorrect="off"
          className="min-w-0 flex-1 rounded-full border border-black/10 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/15"
        />
        <button
          type="submit"
          disabled={status !== 'online' || !contactInput.trim()}
          className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Tambah
        </button>
        <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
          Nick kamu: @{nick || 'anon'}
        </span>
      </form>
      {contactError && <p className="px-4 pt-1 text-xs text-red-500">{contactError}</p>}

      <ol className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {active && rows.length === 0 && (
          <li className="self-center text-xs text-zinc-400 dark:text-zinc-500">
            Belum ada pesan dengan @{active}. Mulai ngobrol!
          </li>
        )}
        {rows.map((row) => {
          if (row.kind === 'system') {
            return (
              <li key={row.id} className="self-center px-3 py-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                {row.text}
              </li>
            );
          }
          return (
            <li key={row.id} className={`flex items-end gap-2 ${row.mine ? 'flex-row-reverse' : 'flex-row'}`}>
              <span className="shrink-0">
                <Avatar size={28} name={row.seed || 'anon'} variant="beam" />
              </span>
              <div className={`flex min-w-0 max-w-[75%] flex-col ${row.mine ? 'items-end' : 'items-start'}`}>
                <span className="px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                  {row.mine ? 'You' : `@${row.name || 'anon'}`}
                </span>
                <span className={`w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${row.mine ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'}`}>
                  {row.text}
                </span>
              </div>
            </li>
          );
        })}
        <li ref={bottomRef} className="h-0 w-0 p-0 m-0" aria-hidden="true" />
      </ol>

      <div className="h-5 px-4 text-xs text-zinc-400 dark:text-zinc-500" aria-live="polite">
        {typingLabel}
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-black/10 p-3 dark:border-white/15">
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={active ? `Pesan ke @${active}` : 'Message'}
          className="flex-1 rounded-full border border-black/10 bg-transparent px-4 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15"
        />
        <button
          type="submit"
          disabled={status !== 'online' || !draft.trim()}
          className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
