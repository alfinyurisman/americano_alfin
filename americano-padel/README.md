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

## Deploy ke Vercel

1. Buka [vercel.com](https://vercel.com) → **Add New Project**
2. Import repo GitHub yang baru saja kamu push
3. Vercel otomatis mendeteksi ini project **Vite** — framework preset: `Vite`,
   build command: `vite build`, output directory: `dist`. Tidak perlu
   diubah, langsung **Deploy**.
4. Setelah selesai, kamu dapat URL publik (`https://<project>.vercel.app`)
   yang bisa langsung dibuka & di-"Add to Home Screen" di Android/iPhone.

## ⚠️ Penting: soal penyimpanan data (localStorage vs shared/real-time)

Versi ini awalnya dibuat sebagai Claude.ai artifact, yang punya `window.storage`
bawaan berupa database **shared** — semua orang yang buka link yang sama
melihat data yang sama secara real-time.

Di luar Claude.ai, backend itu tidak tersedia. Project ini sudah dilengkapi
`src/lib/storage.js` sebagai pengganti sementara yang memakai
**localStorage** milik browser, supaya app tetap jalan penuh begitu di-deploy.

**Konsekuensinya:** localStorage itu per-browser, per-device. Artinya:
- Lobby, jadwal, dan skor **tidak otomatis tersinkron** antar HP yang berbeda
- Tiap orang yang buka link dari HP-nya masing-masing akan punya data
  sendiri-sendiri, terpisah

Kalau kamu tetap butuh semua orang di grup melihat sesi & skor yang sama
secara real-time (seperti sebelumnya di Claude.ai), kamu perlu mengganti isi
`src/lib/storage.js` dengan backend sungguhan, misalnya:
- **Firebase Realtime Database / Firestore** (gratis untuk skala kecil, paling mudah)
- **Supabase** (Postgres + realtime subscriptions)
- API kecil buatan sendiri + database apa saja

Struktur fungsi di `storage.js` (`get`, `set`, `delete`, `list`) sengaja
dibuat meniru API aslinya, jadi kamu bisa ganti isinya saja tanpa menyentuh
`App.jsx` sama sekali. Kalau mau, saya bisa bantu wire up Firebase supaya
sinkronisasi antar HP jalan lagi — tinggal bilang.

## Struktur project

```
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── src/
    ├── main.jsx        # entry point, memasang storage shim
    ├── App.jsx          # seluruh aplikasi (lobby, setup, sesi, klasemen, statistik)
    ├── index.css        # Tailwind directives
    └── lib/
        └── storage.js   # pengganti window.storage (localStorage-based)
```
