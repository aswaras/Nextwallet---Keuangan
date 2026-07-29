# NexWallet — Aplikasi Keuangan (PWA + Google Apps Script + Spreadsheet)

Aplikasi keuangan pribadi/UMKM berbasis mockup NexWallet, dibuat FULL berfungsi:
- Frontend: HTML/JS statis (siap deploy ke **Vercel**)
- Backend/API: **Google Apps Script**
- Database: **Google Spreadsheet**
- Bisa **diinstall (PWA)** di HP/Desktop
- Loading data **tidak pernah menutup layar** — hanya indikator kecil di pojok kanan atas. Input tetap bisa dipakai sambil data sync di background.

## Isi Folder

```
index.html      -> Halaman utama (UI)
app.js          -> Semua logic aplikasi (state, sync, fitur)
manifest.json   -> Konfigurasi PWA
sw.js           -> Service worker (offline shell + installable)
icons/          -> Ikon PWA
vercel.json     -> Konfigurasi header untuk Vercel
Code.gs         -> Backend Google Apps Script (API + akses Spreadsheet)
```

---

## LANGKAH 1 — Setup Backend (Google Apps Script)

1. Buka https://script.google.com → **New project**.
2. Hapus semua isi editor, lalu copy-paste seluruh isi file **`Code.gs`** ke sana.
3. Di dropdown fungsi (atas), pilih **`setup`**, lalu klik **Run** (▶).
   - Google akan minta izin akses Spreadsheet & Drive → klik **Allow**.
   - Fungsi ini otomatis membuat Spreadsheet baru bernama **"NexWallet Database"** lengkap dengan sheet: `Wallets`, `Transactions`, `Debts`, `Settings`.
   - Cek log (**View → Logs**) untuk melihat URL spreadsheet yang dibuat.
4. Klik **Deploy → New deployment**.
   - Klik ikon gerigi (⚙) di samping "Select type" → pilih **Web app**.
   - **Execute as**: `Me`
   - **Who has access**: `Anyone`
   - Klik **Deploy**, lalu **Authorize access** jika diminta.
5. Copy **Web app URL** yang muncul (formatnya: `https://script.google.com/macros/s/XXXXXXXXXX/exec`). URL ini akan dipakai di frontend.

> Setiap kali Anda mengubah isi `Code.gs`, Anda harus membuat **New deployment** lagi (atau **Manage deployments → Edit → New version**) agar perubahan aktif di Web App URL.

---

## LANGKAH 2 — Deploy Frontend ke Vercel

**Opsi A — Vercel CLI**
```bash
npm i -g vercel
cd folder-nexwallet
vercel
```

**Opsi B — Import via Dashboard**
1. Upload folder ini ke GitHub repository (atau drag-drop di https://vercel.com/new sebagai project baru, pilih "Other" framework preset — karena ini static site, tidak perlu build command).
2. Build command: kosongkan. Output directory: `.` (root).
3. Deploy.

Setelah selesai, Anda akan mendapat URL seperti `https://nexwallet-anda.vercel.app`.

---

## LANGKAH 3 — Hubungkan Frontend ke Backend

1. Buka aplikasi yang sudah live di Vercel.
2. Masuk (buat PIN baru saat pertama kali dibuka — aplikasi tetap bisa dipakai offline dengan PIN lokal).
3. Ke tab **Atur (Settings)** → scroll ke bagian **"URL Backend (Apps Script)"**.
4. Tempel **Web app URL** dari Langkah 1, klik **Simpan**.
5. Selesai — semua data (transaksi, dompet, hutang) sekarang otomatis tersinkron ke Google Spreadsheet Anda di background, tanpa loading yang menutup layar (hanya ikon kecil berputar di pojok kanan atas saat proses sync).

> Anda juga bisa menanam URL ini secara permanen dengan mengedit `Sync.getApiUrl()` di `app.js` atau menambahkan default value, supaya user tidak perlu isi manual.

---

## LANGKAH 4 — Install sebagai Aplikasi (PWA)

- **Android/Chrome**: buka situs Vercel Anda → menu (⋮) → "Add to Home screen" / akan muncul tombol **"Install aplikasi ini ke perangkat"** di halaman Settings.
- **iOS/Safari**: tombol Share → "Add to Home Screen".
- **Desktop (Chrome/Edge)**: ikon install (+) muncul di address bar.

Service worker (`sw.js`) meng-cache file inti aplikasi sehingga tetap bisa dibuka meski koneksi terputus (data transaksi lokal tetap tersimpan di localStorage & disinkronkan begitu online kembali).

---

## Fitur yang Sudah Berfungsi Penuh

- 🔐 **PIN Lock** — buat PIN 6 digit saat pertama kali, verifikasi setiap buka app (hash SHA-256, tersimpan lokal + di-backup ke server).
- 🏠 **Dashboard** — total saldo semua dompet, ringkasan pemasukan/pengeluaran bulan berjalan, grafik statistik 6 bulan (real data, bukan dummy), sembunyikan saldo (mata icon).
- 💰 **Dompet** — tambah/edit/hapus dompet (Bank, Cash, E-Wallet, Investasi, Lainnya), saldo otomatis terupdate dari setiap transaksi.
- 📝 **Transaksi** — tambah/edit/hapus pemasukan & pengeluaran, kategori dinamis, tanggal/jam, catatan, upload foto struk (kamera), pencarian & filter (semua/pemasukan/pengeluaran/bulan ini).
- 🤝 **Hutang Piutang** — catat hutang saya & piutang, bayar sebagian/lunas (otomatis membuat transaksi & update saldo dompet), edit/hapus.
- ⚙️ **Pengaturan** — ganti nama, dark mode, 5 pilihan warna tema, ganti PIN, export data (CSV untuk Excel & PDF via cetak), import data (JSON), backup & restore data lengkap.
- ☁️ **Sync Background** — semua perubahan langsung tampil di UI (optimistic update) sambil dikirim ke Google Spreadsheet di background; retry otomatis bila koneksi gagal; indikator kecil non-blocking di pojok kanan atas (bukan animasi loading layar penuh).
- 📱 **PWA** — installable, punya manifest & service worker, bisa dipakai offline (data lokal), otomatis sync ulang saat online.

## Struktur Data di Spreadsheet

| Sheet | Kolom |
|---|---|
| Wallets | id, name, type, balance, color, icon, createdAt, updatedAt |
| Transactions | id, type, amount, category, walletId, date, time, desc, photoUrl, createdAt, updatedAt |
| Debts | id, name, type, amount, originalAmount, status, dueDate, note, createdAt, updatedAt |
| Settings | key, value |

## Catatan Teknis

- Request ke Apps Script dikirim sebagai `POST` dengan `Content-Type: text/plain` agar tidak memicu CORS preflight (keterbatasan umum Apps Script Web App).
- Foto struk disimpan sementara sebagai base64 lokal; saat backend aktif, disimpan permanen di Google Drive folder **"NexWallet Receipts"** melalui aksi `uploadReceipt` (opsional, bisa dikembangkan lebih lanjut sesuai kebutuhan).
- Untuk multi-user sungguhan (banyak akun berbeda), tambahkan Apps Script menjadi multi-spreadsheet per user (saat ini didesain single-user/single-spreadsheet, cocok untuk pemakaian pribadi/UMKM kecil).
"# Nextwallet---Keuangan" 
