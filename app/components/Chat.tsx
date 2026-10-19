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

// 1. LIMIT HISTORI MENJADI 50 PESAN
const MAX_RENDERED = 50; 
const TYPING_THROTTLE_MS = 2000;
const TYPING_CLEAR_MS = 3000;
const MAX_POPUPS = 3; // Limit notifikasi popup anti-spam

function wsUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/api/ws`;
}

const chip = (on: boolean) =>
  `shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
    on
      ? 'bg-blue-600 text-white'
      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
  }`;

// Fungsi memutar suara ringan
const playPopSound = () => {
  try {
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
    audio.volume = 0.4;
    audio.play().catch(() => {}); // catch agar tidak error jika browser memblokir auto-play
  } catch (e) {}
};

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
  
  // Fitur Lanjutan State
  const [popups, setPopups] = useState<PopupEvent[]>([]);
  const [replyTo, setReplyTo] = useState<{name: string, text: string} | null>(null);
  const [showDmOptions, setShowDmOptions] = useState(false);
  const [sysError, setSysError] = useState<string | null>(null);

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

  // Update Title Tab Browser untuk Unread Messages
  useEffect(() => {
    const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) Pesan Baru - Chat` : 'Chat Application';
  }, [unread]);

  const showPopup = (message: string, userStatus: 'online' | 'offline') => {
    const id = Math.random().toString(36).substring(2, 9);
    setPopups((prev) => {
      // Membatasi popup tidak boleh dari MAX_POPUPS
      const next = [...(prev || []), { id, message, status: userStatus }];
      return next.slice(-MAX_POPUPS);
    });
    setTimeout(() => {
      setPopups((prev) => (prev || []).filter((p) => p && p.id !== id));
    }, 3500);
  };

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
      setSysError(null);
      
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
        } catch (err) {}
      });

      socket.addEventListener('message', (event) => {
        try {
          let data: ServerEvent;
          try { data = JSON.parse(event.data); } catch { return; }

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
              if (data.message && data.message.id) {
                setMessages((prev) => [...(prev || []), data.message].slice(-MAX_RENDERED));
                const sender = data.message.clientId;
                if (sender !== clientId) playPopSound(); // Bunyikan notif
                if (sender) {
                  const pending = timers.get(sender);
                  if (pending) { clearTimeout(pending); timers.delete(sender); }
                  setTyping((prev) => {
                    if (!prev || !(sender in prev)) return prev;
                    const next = { ...prev }; delete next[sender]; return next;
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
                      const next = { ...prev }; delete next[who]; return next;
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
                if (m.from !== nick) playPopSound(); // Bunyikan notif
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
                setDms((prev) => ({ ...(prev || {}), [data.with]: data.messages.slice(-MAX_RENDERED) }));
              }
              break;
          }
        } catch (err: any) {
          console.error("[WebSocket Error]:", err);
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
    setShowDmOptions(false);
    if (who) {
      setUnread((prev) => {
        const safePrev = { ...(prev || {}) };
        delete safePrev[who];
        return safePrev;
      });
      sendJson({ type: 'dmHistory', with: who });
    }
  };

  // FUNGSI OPSI DM: Bersihkan Riwayat & Tutup Tab
  const clearDmHistory = () => {
    if (active) setDms((prev) => ({ ...prev, [active]: [] }));
    setShowDmOptions(false);
  };

  const closeActiveDm = () => {
    if (active) {
      setContacts((prev) => prev.filter(c => c !== active));
      setActive(null);
      activeRef.current = null;
      setShowDmOptions(false);
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
    if (!active && value && socket?.readyState === WebSocket.OPEN && now - lastTypingSent.current > TYPING_THROTTLE_MS) {
      lastTypingSent.current = now;
      socket.send(JSON.stringify({ type: 'typing' }));
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    let finalDraft = draft.trim();
    if (!finalDraft) return;

    // Menempelkan quote reply ke pesan jika sedang mereply
    if (replyTo) {
      finalDraft = `> ${replyTo.name}:\n> ${replyTo.text}\n\n${finalDraft}`;
      setReplyTo(null);
    }

    const ok = active
      ? sendJson({ type: 'dm', to: active, text: finalDraft })
      : sendJson({ type: 'message', text: finalDraft });
    
    if (!ok) return;
    setDraft('');
    lastTypingSent.current = 0;
  };

  // Helper untuk merender Quote Balasan (Reply Blockquote)
  const renderMessageText = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, i) => {
      if (line.startsWith('>')) {
        return (
          <span key={i} className="block border-l-2 border-white/40 pl-2 text-white/80 dark:border-zinc-500 dark:text-zinc-400 text-xs italic mb-0.5">
            {line.substring(1).trim()}
          </span>
        );
      }
      return <span key={i} className="block mt-0.5">{line}</span>;
    });
  };

  if (sysError) {
    return (
      <div className="flex flex-1 w-full flex-col items-center justify-center bg-white dark:bg-zinc-950 px-6 text-center">
        <div className="bg-red-100 text-red-600 p-4 rounded-xl border border-red-200">
          <h2 className="font-bold text-lg mb-2">Terjadi Kesalahan Sinkronisasi</h2>
          <p className="text-sm mb-4">{sysError}</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-red-600 text-white rounded-full text-sm font-medium">Muat Ulang Halaman</button>
        </div>
      </div>
    );
  }

  if (status === 'connecting') {
    return (
      <div className="flex flex-1 w-full flex-col items-center justify-center bg-white dark:bg-zinc-950">
        <h2 className="text-2xl font-bold mb-6 text-zinc-800 dark:text-zinc-100 animate-pulse">Hallo?</h2>
        <div className="w-48 h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden relative">
          <div className="absolute top-0 bottom-0 left-0 w-1/3 bg-blue-600 rounded-full animate-bounce" />
        </div>
        <p className="mt-4 text-xs text-zinc-400">Menghubungkan ke server...</p>
      </div>
    );
  }

  const typingNames = active ? [] : Object.values(typing || {});
  const typingLabel = typingNames.length === 0 ? '' : typingNames.length === 1 ? `${typingNames[0]} is typing…` : 'Several people are typing…';

  const safeDms = Array.isArray(dms[active || '']) ? dms[active || ''] : [];
  const safeMessages = Array.isArray(messages) ? messages : [];

  const rows: Row[] = active
    ? safeDms.filter(Boolean).map((m) => ({
        id: m.id || Math.random().toString(), kind: 'chat' as const, seed: m.from || 'anon',
        name: m.from || 'anon', text: m.text || '', mine: m.from === nick,
      }))
    : safeMessages.filter(Boolean).map((m) => ({
        id: m.id || Math.random().toString(), kind: m.kind || 'chat', seed: m.clientId || 'anon',
        name: m.name || m.clientId || 'anon', text: m.text || '', mine: m.clientId === clientId,
      }));

  // Cari data status khusus untuk header DM aktif
  const activeUserObj = active ? users.find((u) => u.nick === active || u.name === active) : null;
  const isOpponentOnline = !!activeUserObj;

  return (
    <div className="flex flex-1 w-full max-w-2xl flex-col relative">
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none">
        {(popups || []).filter(Boolean).map((popup) => (
          <div key={popup.id} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-lg text-xs font-semibold transition-all duration-300 animate-in slide-in-from-top-5 ${
              popup.status === 'online' ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-red-50 text-red-600 border border-red-100'
            }`}>
            <span className={`w-2 h-2 rounded-full ${popup.status === 'online' ? 'bg-green-400' : 'bg-red-500'}`} />
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
                <input name="status" defaultValue={myStatus} placeholder="Mis: Sedang makan..." maxLength={40} className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15" />
              </div>
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={() => setShowProfile(false)} className="flex-1 py-2 text-sm text-zinc-600 bg-zinc-100 dark:bg-zinc-800 rounded-lg">Batal</button>
                <button type="submit" className="flex-1 py-2 text-sm text-white bg-blue-600 rounded-lg font-medium">Simpan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* HEADER DINAMIS (GLOBAL vs DM) */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-black/10 bg-white px-4 py-3 dark:border-white/15 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          {active ? (
            <div className="flex items-center gap-3">
               <Avatar size={32} name={active} variant="beam" />
               <div className="flex flex-col">
                 <span className="text-sm font-bold leading-none">@{active}</span>
                 <span className={`text-[10px] mt-1 truncate max-w-[150px] font-medium ${isOpponentOnline ? 'text-green-500' : 'text-zinc-400'}`}>
                   {isOpponentOnline ? (activeUserObj.customStatus || 'sedang online') : 'Offline'}
                 </span>
               </div>
            </div>
          ) : (
            <button onClick={() => setShowProfile(true)} className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left">
              <Avatar size={32} name={clientId || 'anon'} variant="beam" />
              <div className="flex flex-col">
                <span className="text-sm font-bold leading-none">@{nick || 'anon'}</span>
                <span className="text-[10px] text-zinc-500 mt-1 truncate max-w-[100px]">{myStatus}</span>
              </div>
            </button>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          {active ? (
            <div className="relative">
              <button onClick={() => setShowDmOptions(!showDmOptions)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 font-bold">⋮</button>
              {showDmOptions && (
                <div className="absolute right-0 top-10 w-40 bg-white dark:bg-zinc-800 border border-black/10 dark:border-white/10 rounded-xl shadow-lg py-1 z-50 overflow-hidden text-sm">
                  <button onClick={clearDmHistory} className="w-full text-left px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200">Bersihkan Chat</button>
                  <button onClick={closeActiveDm} className="w-full text-left px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600">Tutup DM</button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex -space-x-2">
                {(users || []).filter(Boolean).slice(0, 5).map((user) => (
                  <span key={user.clientId || Math.random().toString()} title={`@${user.nick || user.name || 'anon'} - ${user.customStatus || 'sedang online'}`} className="inline-flex rounded-full ring-2 ring-white dark:ring-zinc-950">
                    <Avatar size={24} name={user.clientId || 'anon'} variant="beam" />
                  </span>
                ))}
              </div>
              {onLeave && <button onClick={onLeave} className="text-xs text-red-500 hover:underline">Keluar</button>}
            </div>
          )}
        </div>
      </header>

      <nav className="flex items-center gap-2 overflow-x-auto border-b border-black/10 px-4 py-2 dark:border-white/15 scrollbar-hide">
        <button type="button" onClick={() => selectChat(null)} className={chip(active === null)}>Global</button>
        {(contacts || []).filter(Boolean).map((contact) => (
          <button key={contact} type="button" onClick={() => selectChat(contact)} className={chip(active === contact)}>
            @{contact}
            {unread[contact] ? <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] text-white">{unread[contact]}</span> : null}
          </button>
        ))}
      </nav>

      <form onSubmit={addContact} className="flex items-center gap-2 border-b border-black/10 px-4 py-2 dark:border-white/15">
        <input value={contactInput} onChange={(event) => setContactInput(event.target.value)} placeholder="Tambah kontak DM (nick)" autoCapitalize="none" autoCorrect="off" className="min-w-0 flex-1 rounded-full border border-black/10 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/15" />
        <button type="submit" disabled={status !== 'online' || !contactInput.trim()} className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">Tambah</button>
      </form>
      {contactError && <p className="px-4 pt-1 text-xs text-red-500">{contactError}</p>}

      <ol className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 scroll-smooth">
        {active && rows.length === 0 && <li className="self-center text-xs text-zinc-400 dark:text-zinc-500 mt-10">Belum ada obrolan dengan @{active}. Mulai sapa!</li>}
        {rows.map((row) => {
          if (row.kind === 'system') return <li key={row.id} className="self-center px-3 py-0.5 text-[11px] font-medium text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded-full">{row.text}</li>;
          
          return (
            <li key={row.id} className={`group flex items-end gap-2 ${row.mine ? 'flex-row-reverse' : 'flex-row'}`}>
              <span className="shrink-0"><Avatar size={28} name={row.seed || 'anon'} variant="beam" /></span>
              
              <div className={`flex min-w-0 max-w-[75%] flex-col ${row.mine ? 'items-end' : 'items-start'}`}>
                <span className="px-1 text-[11px] text-zinc-400 dark:text-zinc-500 mb-0.5">{row.mine ? 'Kamu' : `@${row.name || 'anon'}`}</span>
                <div className={`flex items-center gap-2 ${row.mine ? 'flex-row-reverse' : 'flex-row'}`}>
                  <span className={`w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${row.mine ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 rounded-bl-sm'}`}>
                    {renderMessageText(row.text)}
                  </span>
                  
                  {/* Tombol Reply Muncul saat dihover */}
                  <button onClick={() => setReplyTo({name: row.name || 'anon', text: row.text})} title="Balas" className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-blue-500 transition-opacity text-lg px-1">
                    ↩
                  </button>
                </div>

                {/* INDIKATOR STATUS PESAN DM (Centang) */}
                {row.mine && active && (
                  <span className="text-[10px] pr-1 mt-0.5 flex items-center">
                    {status === 'offline' ? (
                      <span className="text-zinc-300" title="Menunggu koneksi">🕒</span>
                    ) : isOpponentOnline ? (
                      <span className="text-blue-500 font-bold tracking-tighter" title="Dibaca / Online">✓✓</span>
                    ) : (
                      <span className="text-zinc-400 font-bold" title="Terkirim">✓</span>
                    )}
                  </span>
                )}
              </div>
            </li>
          );
        })}
        <li ref={bottomRef} className="h-0 w-0 p-0 m-0" aria-hidden="true" />
      </ol>

      <div className="h-5 px-4 text-xs font-medium text-blue-500" aria-live="polite">{typingLabel}</div>

      <div className="border-t border-black/10 dark:border-white/15 bg-white dark:bg-zinc-950 px-3 py-3">
        {/* Box Preview Reply */}
        {replyTo && (
          <div className="mb-2 flex items-center justify-between bg-zinc-100 dark:bg-zinc-800 p-2 rounded-lg border-l-4 border-blue-500">
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] font-bold text-blue-500">Membalas @{replyTo.name}</span>
              <span className="text-xs text-zinc-500 truncate max-w-xs">{replyTo.text}</span>
            </div>
            <button onClick={() => setReplyTo(null)} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 text-xs font-bold">X</button>
          </div>
        )}

        <form onSubmit={send} className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={active ? `Pesan privat ke @${active}...` : 'Ketik pesan global...'}
            className="flex-1 rounded-full border border-black/10 bg-transparent px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/15 transition-all"
          />
          <button type="submit" disabled={status !== 'online' || !draft.trim()} className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 shadow-sm hover:bg-blue-700 transition-colors">
            Kirim
          </button>
        </form>
      </div>
    </div>
  );
}
