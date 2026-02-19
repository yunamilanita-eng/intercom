# intercom-dice 🎲

> **Provably-Fair P2P Dice Roller via Commit-Reveal Protocol**  
> Submission untuk **Intercom Vibe Competition** — dibangun di atas Trac Network / Hyperswarm

[![Node ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Pear Runtime](https://img.shields.io/badge/pear-compatible-blue)](https://pears.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## Apa Itu intercom-dice?

**intercom-dice** memungkinkan sekelompok peer melempar dadu secara **provably fair** tanpa server, tanpa trusted third party — murni P2P.

Menggunakan protokol **commit-reveal**:
- Setiap peer menyumbang entropi rahasia mereka sendiri.
- Hasil akhir adalah **XOR dari semua seed** → tidak ada satu peer pun yang bisa memanipulasi hasilnya.
- Semua verifikasi bisa dilakukan oleh siapa saja secara lokal.

```
┌─────────────┐     COMMIT → REVEAL → XOR     ┌─────────────┐
│  Player A   │ ─────── Hyperswarm P2P ─────── │  Player B   │
│  d20 roller │    Noise-encrypted · No server  │  d20 roller │
└─────────────┘                                 └─────────────┘
       │                                               │
       └──────────── shared channel topic ─────────────┘
                     HASIL: provably fair
```

---

## Fitur

- **Provably Fair** — commit-reveal dengan verifikasi SHA256 otomatis
- **Custom Dice** — d4, d6, d8, d10, d12, d20, d100
- **Fraud Detection** — peer yang commit palsu langsung terdeteksi & ronde dibatalkan
- **File Log** — semua hasil disimpan otomatis ke `dice-log.txt`
- **Leaderboard Sesi** — skor per sesi di memori
- **Manual Verify** — perintah `/verify` untuk audit manual
- **Termux-native** — jalan di Android tanpa setup rumit
- **Pear Runtime compatible** — ekosistem Holepunch

---

## Instalasi

### Standard (Node.js)

```bash
git clone https://github.com/USERNAME_KAMU/intercom-dice.git
cd intercom-dice
npm install
node index.js
```

### Dengan Pear Runtime

```bash
npm install -g pear
cd intercom-dice
npm install
pear run . dice1
```

---

## Termux (Android) — Quick Start

```bash
# Update packages
pkg update && pkg upgrade -y

# Install Node.js dan git
pkg install nodejs git -y

# Clone repo
git clone https://github.com/USERNAME_KAMU/intercom-dice.git
cd intercom-dice

# Install dependencies
npm install

# Jalankan
node index.js --alias namaKamu
```

---

## Cara Bermain

### 1. Semua pemain bergabung ke channel yang sama

```bash
# Pemain A (desktop)
node index.js --channel game-malam-ini --alias budi

# Pemain B (Termux)
node index.js --channel game-malam-ini --alias siti

# Pemain C (server lain)
node index.js --channel game-malam-ini --alias player3
```

### 2. Salah satu pemain memulai roll

```
> /roll d20
```

### 3. Semua peer otomatis ikut proses commit-reveal

```
[14:22:01] 🎲 budi mengajak roll d20! Membuat commit…
[14:22:01] 🔒 Commit saya dikirim: [3af9bc12d7e4a1b2…]
[14:22:02] 🔒 Commit diterima dari siti  [7c3d9f21a8b4e5c6…]
[14:22:02] 🔒 Commit diterima dari player3  [1e5f8a3c2b7d4e9f…]
[14:22:02] ✅ Semua 3 peer telah commit! Memulai fase reveal…
[14:22:02] 🔓 Reveal valid dari siti
[14:22:02] 🔓 Reveal valid dari player3

╔══════════════════════════════════════════╗
║           🎲  HASIL ROLL  🎲             ║
╚══════════════════════════════════════════╝
  Jenis Dadu  : d20
  Hasil       : 17   [ 17 ]
  Peserta     : budi, siti, player3
  Combined XOR: a3f9bc12d7e4a1b2c3d4e5f6a7b8c9d0…

  Verifikasi:
  budi               seed=3af9bc12d7e4… → ✓ VALID
  siti               seed=7c3d9f21a8b4… → ✓ VALID
  player3            seed=1e5f8a3c2b7d… → ✓ VALID
```

---

## Daftar Perintah

| Perintah | Keterangan |
|---|---|
| `/roll d6` | Roll dadu (ganti d6 dengan pilihan lain) |
| `/peers` | Lihat peer yang terhubung |
| `/leaderboard` | Skor sesi ini |
| `/log` | 10 hasil terakhir dari file log |
| `/verify <seed> <commit>` | Verifikasi manual provably-fair |
| `/alias <nama>` | Ganti nama tampilan |
| `/help` | Menu lengkap |
| `/exit` | Keluar |

**Dadu tersedia:** `d4` `d6` `d8` `d10` `d12` `d20` `d100`

---

## Arsitektur

```
index.js
├── Hyperswarm (DHT discovery + Noise encryption)
├── topicFromString (SHA256 channel → 32-byte DHT key)
├── Commit-Reveal Engine
│   ├── Phase 1: COMMIT (broadcast SHA256(secret))
│   ├── Phase 2: REVEAL (broadcast secret setelah semua commit)
│   ├── Fraud Detection (verifikasi hash tiap reveal)
│   └── XOR Aggregation → roll result
├── CLI (readline interactive prompt)
├── File Logger (append dice-log.txt)
└── Session Leaderboard (in-memory Map)
```

---

## Keamanan & Fairness

- Semua traffic dienkripsi end-to-end (Noise protocol).
- Tidak ada peer yang bisa tahu hasil sebelum semua seed terungkap.
- Jika ada yang kirim seed palsu → ronde dibatalkan secara otomatis.
- Timeout 30 detik untuk fase reveal — peer yang diam akan membatalkan ronde.
- Channel name di-hash SHA-256 → tidak pernah dikirim ke jaringan.

---

## File Log

Setiap hasil disimpan ke `dice-log.txt`:

```
[2025-08-15T14:22:02.000Z] ROLL d20 → 17 | participants: budi, siti, player3 | combined: a3f9bc12... | roundId: f4a2b8c1
[2025-08-15T14:25:11.000Z] ROLL d6 → 4 | participants: budi, siti | combined: 2c8d7e3f... | roundId: 9b3c1d2e
```

---

## Lisensi

MIT — lihat [LICENSE](LICENSE)

---

## Trac Address

trac1c6g343y50ps9lrccgpawe4n43wau4zxxyryq4remrvg8qapdj98qgytmdp

---

*Dibangun dengan ♥ untuk Intercom Vibe Competition — Trac Network*
