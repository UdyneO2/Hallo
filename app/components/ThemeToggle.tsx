'use client';

import { useEffect, useState } from 'react';

const KEY = 'chat:theme';
type Theme = 'light' | 'dark';

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Tombol mode malam. Pilihan disimpan di localStorage; default mengikuti sistem. */
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(KEY);
      } catch {}
      const initial: Theme =
        saved === 'light' || saved === 'dark'
          ? saved
          : window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';
      apply(initial);
      setTheme(initial);
    });
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    apply(next);
    setTheme(next);
  };

  // Belum tahu temanya (SSR / render pertama): tahan tempatnya saja, hindari mismatch.
  if (!theme) return <span className={`inline-block h-8 w-8 ${className}`} aria-hidden="true" />;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode malam'}
      title={theme === 'dark' ? 'Mode terang' : 'Mode malam'}
      className={`flex h-8 w-8 items-center justify-center rounded-full text-base hover:bg-zinc-100 dark:hover:bg-zinc-800 ${className}`}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
