'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Avatar from 'boring-avatars';
import Chat from './Chat';

const ID_KEY = 'chat:clientId';
const NICK_KEY = 'chat:nick';
const SECRET_KEY = 'chat:secret';
const NICK_RE = /^[a-z0-9_]{3,20}$/;

export default function ChatRoom() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [nick, setNick] = useState<string | null>(null);
  const [nickDraft, setNickDraft] = useState('');
  const [nickError, setNickError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      let id = sessionStorage.getItem(ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(ID_KEY, id);
      }
      setClientId(id);

      let sec = localStorage.getItem(SECRET_KEY);
      if (!sec) {
        sec = crypto.randomUUID();
        localStorage.setItem(SECRET_KEY, sec);
      }
      setSecret(sec);

      const savedNick = localStorage.getItem(NICK_KEY) ?? '';
      setNickDraft(savedNick);
      // Auto login jika nick valid sudah tersimpan di browser
      setNick(NICK_RE.test(savedNick) ? savedNick : null);
      setReady(true);
    });
  }, []);

  if (!ready || !clientId || !secret) return null;

  // Render komponen Chat jika nick sudah di-set
  if (nick) {
    return (
      <Chat
        clientId={clientId}
        nick={nick} // Kita hanya mengirim nick, name sudah tidak perlu
        secret={secret}
        onNickError={(reason) => {
          setNick(null);
          setNickError(
            reason === 'taken'
              ? 'Nick sudah dipakai. Pilih nick lain.'
              : 'Nick tidak valid (3–20 karakter: huruf kecil, angka, _).'
          );
        }}
        onLeave={() => {
          setNick(null);
        }}
      />
    );
  }

  const nickValue = nickDraft.trim().toLowerCase().replace(/^@/, '');
  const nickValid = NICK_RE.test(nickValue);

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!nickValid) return;
    localStorage.setItem(NICK_KEY, nickValue);
    setNickError('');
    setNick(nickValue);
  };

  return (
    <form
      onSubmit={join}
      className="mx-auto flex flex-1 w-full max-w-sm flex-col items-center justify-center gap-5 px-6"
    >
      <Avatar size={64} name={clientId} variant="beam" />
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Login Chat</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Masukkan nick kamu untuk masuk.
        </p>
      </div>
      <div className="w-full">
        <input
          autoFocus
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
        disabled={!nickValid}
        className="rounded-full bg-blue-600 px-6 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        Masuk
      </button>
    </form>
  );
}
