# GIN-Sync · Portal Diskusi Mahasiswa

> **Beda ide. Satu frekuensi.**

Aplikasi chat real-time berbasis web untuk Tugas Mandiri **Sistem Paralel dan Terdistribusi** (Pemrograman Socket pada Web).
Dibangun dengan **Node.js, Express, Socket.IO (WebSocket)**, serta HTML/CSS/JavaScript murni tanpa framework.

## Ruang diskusi

| Ruang | Jenis | Akses |
|---|---|---|
| **Chat Global** | Publik | Siapa saja, cukup isi nama |
| **TI25F** | Privat | Nama **dan kode akses** (bawaan: `ti25f_f`) |

Kode tidak peka huruf besar/kecil. Mengganti kode tanpa mengubah source code:

```bash
# Linux / macOS
TI25F_CODE=kode-rahasia-baru npm start

# Windows PowerShell
$env:TI25F_CODE="kode-rahasia-baru"; npm start
```

## Fitur

| Fitur | Keterangan |
|---|---|
| SPA | Login → ruang chat tanpa reload halaman |
| Ruang publik & privat | Ruang privat butuh kode; isinya tidak bocor sebelum kode benar |
| Sidebar | Nama ruang aktif, **Pengguna Online** (titik hijau, real-time), tombol **Keluar Ruangan** di bawah |
| Header | Nama ruang, badge Publik/Privat, status koneksi (indikator bar sinyal: Terhubung / Menyambung / Terputus) |
| Riwayat chat | Server menyimpan 50 pesan terakhir **per ruang** (in-memory); user baru langsung menerimanya |
| Indikator real-time | "X sedang mengetik…" (equalizer), timestamp HH:MM, pesan sistem join/leave di tengah layar, pemisah hari (Hari ini/Kemarin) |
| Fault tolerance | Server mati/restart → banner "Terputus dari server, mencoba menghubungkan kembali…"; sambung ulang otomatis (exponential backoff + jitter); masuk kembali ke ruang yang sama; draf pesan tidak hilang |
| Auto-scroll | Mengikuti pesan baru; saat Anda membaca riwayat muncul tombol "N pesan baru" |
| Responsif | Sidebar menjadi drawer di layar kecil; dropdown ruang bisa dipakai dengan keyboard |

## Persyaratan

- **Node.js 18 atau lebih baru** (cek: `node -v`). Unduh di https://nodejs.org
- Internet hanya dibutuhkan saat `npm install`. Setelah itu aplikasi berjalan **offline** (tanpa CDN).

## Instalasi dan menjalankan

```bash
cd gin-sync        # masuk ke folder proyek
npm install        # pasang dependensi (express + socket.io)
npm start          # jalankan server
```

Buka **http://localhost:3000**. Untuk uji multi-user, buka beberapa tab (atau satu jendela biasa + satu incognito) dan masuk dengan nama berbeda.

Mode pengembangan (restart otomatis saat file berubah): `npm run dev`

### Mencoba dari perangkat lain (satu Wi-Fi/LAN)

1. Cari IP komputer server (`ipconfig` di Windows, `ifconfig` / `ip a` di Linux/Mac), misal `192.168.1.20`.
2. Dari HP/laptop lain buka `http://192.168.1.20:3000`.
3. Jika tidak bisa terbuka, izinkan port 3000 di firewall.

### Variabel lingkungan (opsional)

| Variabel | Default | Fungsi |
|---|---|---|
| `TI25F_CODE` | `ti25f_f` | Kode akses ruang privat TI25F |
| `PORT` | `3000` | Port server. Contoh: `PORT=4000 npm start` (PowerShell: `$env:PORT=4000; npm start`) |
| `HOST` | `0.0.0.0` | Alamat bind. Isi `127.0.0.1` agar hanya bisa diakses dari komputer sendiri |
| `MAX_CONN_PER_IP` | `20` | Batas koneksi bersamaan per alamat IP |
| `ALLOWED_ORIGINS` | kosong | Origin tambahan yang boleh membuka WebSocket (pisahkan koma) |
| `TRUST_PROXY` | kosong | Isi `1` hanya jika di belakang reverse proxy tepercaya (Nginx, dsb.) |

## Struktur proyek

```
gin-sync/
├── package.json
├── server.js          # Express + Socket.IO: ruang, kode akses, riwayat, daftar user, validasi, rate limit
└── public/
    ├── index.html     # layar masuk + layar chat (semantik, tanpa inline script/style)
    ├── style.css      # CSS variables, grid/flexbox, responsif
    └── client.js      # event socket, DOM aman XSS, auto-reconnect, typing, auto-scroll
```

Menambah ruang baru cukup dengan satu entri di `ROOM_CATALOG` pada `server.js` (riwayat dan daftar anggotanya dibuat otomatis); untuk ruang privat tambahkan juga kodenya di `ROOM_CODES`, lalu tambahkan satu `<li role="option">` di dropdown pada `index.html`.

## Cara menguji fitur (untuk laporan dan video demo)

1. **Ruang publik**: buka 2–3 tab, masuk **Chat Global** dengan nama berbeda → daftar Pengguna Online bertambah di semua tab.
2. **Ruang privat**: pilih **TI25F** → kolom kode muncul. Coba kode salah (muncul sisa percobaan), lalu `ti25f_f` (berhasil).
3. **Anti brute-force**: salah kode 5 kali → terkunci 5 menit (ruang publik tetap bisa dimasuki).
4. **Riwayat**: kirim beberapa pesan, buka tab baru, masuk ruang yang sama → pesan lama langsung tampil. Riwayat Chat Global dan TI25F terpisah.
5. **Typing**: ketik di satu tab tanpa mengirim → tab lain menampilkan "… sedang mengetik…".
6. **Fault tolerance**: tekan `Ctrl+C` di terminal server → banner merah dan status "Terputus". Jalankan `npm start` lagi → banner hijau, semua user otomatis masuk kembali (termasuk ke ruang privat). Riwayat kosong karena disimpan di memori, sesuai batas tugas.
7. **XSS**: kirim `<img src=x onerror=alert(1)>` → tampil sebagai teks biasa, tidak ada alert.
8. **Keluar Ruangan**: tombol di bawah sidebar → kembali ke layar masuk, layar chat dibersihkan.

## Ringkasan keamanan

**Ruang privat**
- Kode diverifikasi **di server** (hash SHA-256 + perbandingan waktu-konstan), tidak pernah dikirim ke client dan tidak disimpan di browser (hanya di memori tab untuk sambung ulang otomatis, dihapus saat keluar).
- **Anti brute-force**: 5 kode salah dalam 10 menit dari satu IP mengunci percobaan kode selama 5 menit, termasuk untuk kode yang benar.
- **Tanpa kebocoran**: sebelum kode benar, orang luar tidak bisa melihat riwayat, daftar pengguna, jumlah online, maupun mengetahui apakah sebuah nama ada di dalam. Kode diperiksa sebelum pengecekan bentrok nama.
- Pesan ruang privat hanya dikirim ke anggota yang sudah lolos verifikasi (room Socket.IO terpisah).

**Umum**
- **Anti-XSS**: seluruh data dirender dengan `textContent`; tidak ada `innerHTML`/`eval`. Ditambah **Content-Security-Policy** ketat (`script-src 'self'`, tanpa inline) sebagai lapis kedua.
- **Server sebagai sumber kebenaran**: nama pengirim, id, dan waktu pesan ditentukan server; client tidak bisa menyamar sebagai user lain.
- **Validasi input**: nama ASCII 2–20 karakter (anti penyamaran huruf mirip), nama dicadangkan (Admin, Sistem, GIN-Sync, dst.), pesan maks. 500 karakter/8 baris, karakter kontrol dan arah teks (bidi) dibuang, tipe data dicek ketat.
- **Daftar putih**: hanya ruang dalam katalog, hanya 4 event yang diterima server; selain itu ditolak.
- **Anti-penyalahgunaan**: rate limit pesan/typing/join (token bucket), pemutusan otomatis bila membanjiri, batas koneksi per IP dan global, batas payload 8 KB, kompresi per-pesan dimatikan.
- **Anti Cross-Site WebSocket Hijacking**: header `Origin` diperiksa terhadap host server.
- **Header HTTP**: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP; hanya method GET/HEAD; `x-powered-by` dimatikan.
- **Memori terbatas**: riwayat 50 pesan/ruang, ruang tidak bisa dibuat client, DOM client dibatasi 300 pesan.
- **Tahan error**: setiap handler dibungkus try/catch; server tidak jatuh karena payload sampah.

### Catatan untuk penggunaan di luar tugas

- Gunakan **HTTPS/WSS** (mis. di belakang Nginx + sertifikat TLS). Lewat HTTP biasa, data dan kode akses dapat disadap di jaringan.
- Kode akses ruang privat adalah *shared secret*, bukan akun per pengguna. Di jaringan yang berbagi satu IP (NAT kampus), penguncian anti brute-force berlaku per IP sehingga satu orang yang salah berulang kali dapat mengunci percobaan kode bagi yang lain selama 5 menit.
- Data di memori: restart server menghapus riwayat. Untuk produksi gunakan database (Redis/PostgreSQL) dan Socket.IO Redis adapter bila server lebih dari satu.
- Tidak ada autentikasi akun: nama hanya identitas sesi.

## Pemecahan masalah

| Masalah | Solusi |
|---|---|
| `EADDRINUSE` / port dipakai | Jalankan dengan port lain: `PORT=3001 npm start` |
| `Cannot find module 'express'` | Jalankan `npm install` di folder yang berisi `package.json` |
| Halaman terbuka tapi banner "Pustaka Socket.IO gagal dimuat" | Server belum berjalan; jalankan `npm start` lalu muat ulang |
| Dari HP tidak bisa terbuka | Pastikan satu jaringan, pakai IP LAN (bukan `localhost`), izinkan port di firewall |
| "Kode akses salah" padahal sudah benar | Kode bawaan `ti25f_f`; periksa apakah server dijalankan dengan `TI25F_CODE` lain |
| "Terlalu banyak kode salah" | Tunggu 5 menit, atau restart server (hitungan ada di memori) |
