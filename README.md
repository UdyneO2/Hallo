# 💬 Real-time Chat App (Next.js + WebSocket + Redis)

Aplikasi obrolan real-time yang dibangun menggunakan **Next.js**, **Vercel WebSockets**, dan **Redis**. Aplikasi ini mendukung obrolan global (grup) serta pesan privat (DM) antar pengguna, dilengkapi dengan fitur-fitur modern layaknya aplikasi pesan instan profesional.

## ✨ Fitur Utama

* **🌍 Obrolan Global & 🔒 Privat (DM):** Ngobrol dengan semua orang di ruang utama atau kirim pesan rahasia secara empat mata.
* **🟢 Kehadiran Real-time:** Melihat jumlah user online secara langsung dan indikator "Sedang mengetik...".
* **👤 Profil & Avatar Kustom:** Atur status kustom (misal: "Sedang sibuk") dan gunakan avatar sendiri menggunakan link gambar (Mendukung JPG, PNG, hingga GIF animasi).
* **🔔 Notifikasi Pintar:** 
  * Bunyi suara "Pop" ringan saat ada pesan masuk.
  * Tab browser otomatis berubah menunjukkan jumlah pesan belum terbaca `(X) Pesan Baru`.
  * Popup notifikasi (Toast) melayang di tengah atas saat ada user yang bergabung atau keluar (dilengkapi filter Anti-Spam maksimal 3 popup).
* **↩️ Balas Pesan (Reply):** Kutip pesan teman obrolan Anda untuk membalas konteks obrolan yang spesifik.
* **✓ Indikator Terbaca:** Ketahui status pesan DM Anda dengan indikator centang satu abu-abu (Terkirim) dan centang dua biru (Tersampaikan/Online).
* **🧹 Manajemen Obrolan:** Fitur "Bersihkan Chat" untuk menghapus layar riwayat obrolan dan "Tutup DM" untuk merapikan tab obrolan privat Anda.
* **💾 Persistensi Lokal:** Nama panggilan (Nick), Status, dan Avatar disimpan dengan aman di perangkat menggunakan `localStorage` & `sessionStorage`.

## 🛠️ Tech Stack

* **Frontend:** Next.js (App Router), React, Tailwind CSS, TypeScript.
* **Backend / Real-time:** `@vercel/functions` (`experimental_upgradeWebSocket`).
* **Database / Sinkronisasi:** Upstash Redis (menggunakan `ioredis` untuk pub/sub dan persistensi sementara).
* **UI Komponen Tambahan:** `boring-avatars` (untuk fallback avatar unik).

## 🚀 Cara Instalasi & Menjalankan Lokal

### 1. Persyaratan
Pastikan Anda telah menginstal **Node.js** (versi 18+) dan memiliki instance **Redis** (direkomendasikan menggunakan [Upstash](https://upstash.com/) untuk mode *serverless*).

### 2. Kloning Repositori & Instalasi Dependensi
```bash
git clone <url-repo-anda>
cd <nama-folder-repo>
npm install
