'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Avatar from 'boring-avatars';
import Chat from './Chat';

const ID_KEY = 'chat:clientId';
const NAME_KEY = 'chat:name';
// Nick + secret disimpan di localStorage supaya nick tetap milikmu di semua tab/sesi.
const NICK_KEY = 'chat:nick';
const SECRET_KEY = 'chat:secret';
const NICK_RE = /^[a-z0-9_]{3,20}$/;

const ADJECTIVES = ['Swift', 'Calm', 'Brave', 'Lucky', 'Clever', 'Sunny', 'Quiet', 'Bold'];
const ANIMALS = ['Otter', 'Falcon', 'Fox', 'Panda', 'Heron', 'Lynx', 'Whale', 'Moth'];

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj} ${animal}`;
}

export default function ChatRoom() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [nick, setNick] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [nickDraft, setNickDraft] = useState('');
  const [nickError, setNickError] = useState('');
  // Gate rendering until we've read sessionStorage so SSR and the first client
  // render agree (no hydration mismatch) and we don't flash the join form.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      // Per-tab identity, generated with the Web Crypto API and stored in
      // sessionStorage: it survives reloads of this tab (so messages stay
      // attributed to you) but is NOT shared with other tabs — each tab is a
      // distinct user with its own avatar. localStorage would leak one
      // identity across every tab in the browser.
      let id = sessionStorage.getItem(ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(ID_KEY, id);
      }
      setClientId(id);

      // Secret pemilik nick (satu per browser).
      let sec = localStorage.getItem(SECRET_KEY);
      if (!sec) {
        sec = crypto.randomUUID();
        localStorage.setItem(SECRET_KEY, sec);
      }
      setSecret(sec);

      const savedNick = localStorage.getItem(NICK_KEY) ?? '';
      setNickDraft(savedNick);
      const savedName = sessionStorage.getItem(NAME_KEY);
      setName(savedName);
      // Masuk otomatis hanya kalau nama (tab ini) dan nick (browser ini) sudah ada.
      setNick(savedName && NICK_RE.test(savedNick) ? savedNick : null);
      setDraft(randomName());
      setReady(true);
    });
  }, []);

  if (!ready || !clientId || !secret) return null;

  if (name && nick) {
    return (
      <Chat
        clientId={clientId}
        name={name}
        nick={nick}
        secret={secret}
        onNickError={(reason) => {
          // Nick ditolak server: kembali ke form dengan pesan error.
          sessionStorage.removeItem(NAME_KEY);
          setName(null);
          setNick(null);
          setNickError(
            reason === 'taken'
              ? 'Nick sudah dipakai orang lain. Pilih nick lain.'
              : 'Nick tidak valid (3–20 karakter: huruf kecil, angka, _).',
          );
        }}
        onLeave={() => {
          sessionStorage.removeItem(NAME_KEY);
          setName(null);
          setNick(null);
          setDraft(randomName());
        }}
      />
    );
  }

  const nickValue = nickDraft.trim().toLowerCase().replace(/^@/, '');
  const nickValid = NICK_RE.test(nickValue);

  const join = (event: FormEvent) => {
    event.preventDefault();
    const chosen = draft.trim().slice(0, 40);
    if (!chosen || !nickValid) return;
    sessionStorage.setItem(NAME_KEY, chosen);
    localStorage.setItem(NICK_KEY, nickValue);
    setNickError('');
    setName(chosen);
    setNick(nickValue);
  };

  return (
    <form
      onSubmit={join}
      className="mx-auto flex flex-1 w-full max-w-sm flex-col items-center justify-center gap-5 px-6"
    >
      <Avatar size={64} name={clientId} variant="beam" />
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Join the chat</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Pick a display name and a unique nick for private chat.
        </p>
      </div>
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Your name"
        className="w-full rounded-full border border-black/10 bg-transparent px-4 py-2 text-center text-sm outline-none focus:border-blue-500 dark:border-white/15"
        aria-label="Your name"
      />
      <div className="w-full">
        <input
          value={nickDraft}
          onChange={(event) => setNickDraft(event.target.value)}
          placeholder="nick (mis. budi_21)"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full rounded-full border border-black/10 bg-transparent px-4 py-2 text-center text-sm outline-none focus:border-blue-500 dark:border-white/15"
          aria-label="Nick"
        />
        {nickError && (
          <p className="mt-2 text-center text-xs text-red-500" role="alert">
            {nickError}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={!draft.trim() || !nickValid}
        className="rounded-full bg-blue-600 px-6 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        Enter
      </button>
    </form>
  );
}
