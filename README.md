# Americano Padel Scheduler

Rotasi pasangan otomatis, istirahat merata, dan jadwal yang mengikuti durasi
sewa lapangan — bukan target jumlah match. Dilengkapi lobby multi-acara,
format skor poin/tenis, klasemen, dan statistik keadilan rotasi.

## Menjalankan secara lokal

```bash
npm install
npm run dev
```

Buka `http://localhost:5173`.

## Build production

```bash
npm run build
npm run preview   # untuk cek hasil build secara lokal
```

## Deploy ke GitHub

```bash
git init
git add .
git commit -m "Initial commit: Americano Padel Scheduler"
git branch -M main
git remote add origin https://github.com/<username>/<repo-name>.git
git push -u origin main
```

⚠️ File `.env` **tidak ikut ter-push** ke GitHub (memang sengaja, lihat `.gitignore`) karena isinya config Firebase. Ini normal — env var yang sama akan ditambahkan manual di Vercel pada langkah berikut.

## Deploy ke Vercel

1. Buka [vercel.com](https://vercel.com) → **Add New Project**
2. Import repo GitHub yang baru saja kamu push
3. Vercel otomatis mendeteksi ini project **Vite** — framework preset: `Vite`,
   build command: `vite build`, output directory: `dist`. Tidak perlu diubah.
4. **Sebelum klik Deploy**, buka bagian **Environment Variables** di halaman
   import, lalu tambahkan 7 variabel ini (isi persis dari file `.env` di
   project ini):

   | Key | Value |
   |---|---|
   | `VITE_FIREBASE_API_KEY` | isi dari `.env` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | isi dari `.env` |
   | `VITE_FIREBASE_DATABASE_URL` | isi dari `.env` |
   | `VITE_FIREBASE_PROJECT_ID` | isi dari `.env` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | isi dari `.env` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | isi dari `.env` |
   | `VITE_FIREBASE_APP_ID` | isi dari `.env` |

5. Klik **Deploy**. Kamu dapat URL publik (`https://<project>.vercel.app`)
   yang bisa langsung dibuka & di-"Add to Home Screen" di Android/iPhone.

Kalau nanti ganti nilai env var di Vercel, perlu **Redeploy** manual dari tab
Deployments — Vercel tidak otomatis rebuild hanya karena env var berubah.

## ⚠️ Wajib: kunci Database Rules di Firebase (sebelum 30 hari)

Realtime Database yang dibuat dalam "test mode" itu **otomatis terkunci total
setelah ~30 hari** kalau rules-nya tidak diganti — nanti app tiba-tiba error
semua. Ganti sekarang juga:

1. Buka [Firebase Console](https://console.firebase.google.com) → project kamu
2. **Build → Realtime Database → tab Rules**
3. Ganti isinya jadi:
   ```json
   {
     "rules": {
       ".read": false,
       ".write": false,
       "kv": {
         ".read": true,
         ".write": true
       }
     }
   }
   ```
4. Klik **Publish**

Rules ini membuka akses baca/tulis hanya untuk path `kv` (tempat semua data
lobby/jadwal/skor app ini disimpan), tanpa perlu login — sesuai kebutuhan
grup teman main. Path lain di database tetap tertutup rapat.

## Soal penyimpanan data (real-time, shared antar HP)

Project ini sekarang pakai **Firebase Realtime Database** sebagai backend
(lihat `src/lib/storage.js`), menggantikan `window.storage` bawaan Claude.ai.
Karena ini database sungguhan (bukan localStorage), lobby, jadwal, dan skor
**otomatis tersinkron real-time ke semua HP** yang membuka app atau link
pemantau (view only) — persis seperti waktu masih di Claude.ai.

Firebase paket gratis (Spark) cukup jauh lebih dari cukup untuk skala
pemakaian ini (sekelompok teman main padel) — tanpa batas waktu, tanpa perlu
kartu kredit.

## Struktur project

```
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env               # config Firebase (tidak ikut git, isi manual di Vercel)
├── .env.example       # template kosong, ikut git
└── src/
    ├── main.jsx        # entry point, memasang storage shim
    ├── App.jsx          # seluruh aplikasi (lobby, setup, sesi, klasemen, statistik)
    ├── index.css        # Tailwind directives
    └── lib/
        └── storage.js   # backend Firebase Realtime Database
```
