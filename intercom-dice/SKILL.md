# SKILL — intercom-dice

> Instruksi agent untuk mengoperasikan dan berinteraksi dengan **intercom-dice**.  
> Mengikuti konvensi Intercom SKILL.md dari Trac Systems.

---

## Apa Itu Aplikasi Ini?

**intercom-dice** adalah **Dadu P2P Provably-Fair** menggunakan protokol **commit-reveal** di atas Hyperswarm / Trac Network.

Setiap roll dadu melibatkan semua peer yang terhubung — tidak ada satu pun peer yang bisa curang karena hasil akhir adalah XOR dari seed rahasia semua peserta.

---

## Bagaimana Commit-Reveal Bekerja

```
Peer A                    Peer B                    Peer C
  │                         │                         │
  │── COMMIT(hash_A) ──────>│── COMMIT(hash_A) ──────>│
  │<─ COMMIT(hash_B) ───────│── COMMIT(hash_B) ──────>│
  │<─ COMMIT(hash_C) ───────│<─ COMMIT(hash_C) ───────│
  │                         │                         │
  │  (semua telah commit)   │                         │
  │                         │                         │
  │── REVEAL(seed_A) ──────>│── REVEAL(seed_A) ──────>│
  │<─ REVEAL(seed_B) ───────│── REVEAL(seed_B) ──────>│
  │<─ REVEAL(seed_C) ───────│<─ REVEAL(seed_C) ───────│
  │                         │                         │
  └─── XOR(seed_A, seed_B, seed_C) % sides + 1 ──────┘
                      HASIL FINAL
```

### Langkah Detail
1. Initiator broadcast `ROLL_REQ` dengan `roundId` dan `sides` (jumlah sisi dadu).
2. Setiap peer (termasuk initiator) generate `secret = crypto.randomBytes(32)`.
3. Setiap peer broadcast `COMMIT = SHA256(secret)`.
4. Setelah **semua** peer commit → fase reveal dimulai.
5. Setiap peer broadcast `REVEAL = secret` dalam hex.
6. Setiap peer memverifikasi `SHA256(seed) === commit` yang diterima sebelumnya.
7. Jika ada yang tidak cocok → ronde dibatalkan, fraud terdeteksi.
8. Hasil = `XOR(semua seed)` dipetakan ke `[1, sides]`.

---

## Kebutuhan Runtime

| Kebutuhan | Versi |
|---|---|
| Node.js | ≥ 18.0.0 |
| Pear Runtime | opsional, direkomendasikan |
| OS | Linux, macOS, Windows, Termux (Android) |

---

## Checklist First-Run

1. Clone atau copy repository.
2. Jalankan `npm install` di root proyek.
3. Mulai dengan `node index.js` atau `pear run . dice1`.
4. Alias acak seperti `player-a3f2` otomatis diberikan. Ganti dengan `--alias NamaKamu`.
5. Bagikan **channel name** ke peer yang ingin ikut. Default: `intercom-dice-v1-global`.
6. Tunggu minimal 1 peer terhubung, lalu `/roll d20`.

---

## Referensi CLI

| Perintah | Keterangan |
|---|---|
| `/roll d6` | Mulai ronde commit-reveal dengan dadu 6 sisi |
| `/roll d4\|d8\|d10\|d12\|d20\|d100` | Dadu lain yang didukung |
| `/peers` | Lihat peer yang terhubung |
| `/leaderboard` | Skor sesi saat ini |
| `/log` | 10 hasil terakhir dari file log |
| `/verify <seed> <commit>` | Verifikasi manual SHA256(seed) === commit |
| `/alias <nama>` | Ganti nama tampilan |
| `/help` | Tampilkan menu perintah |
| `/exit` | Keluar dengan bersih |

---

## Opsi Launch

```bash
node index.js [--channel <nama>] [--alias <nama>]
```

| Flag | Default | Fungsi |
|---|---|---|
| `--channel` | `intercom-dice-v1-global` | Nama channel DHT; semua peer harus sama |
| `--alias` | `player-<4 hex char>` | Nama tampilan di swarm |

### Contoh

```bash
# Channel publik default
node index.js

# Channel privat dengan alias
node index.js --channel game-malam-ini --alias budi

# Pear runtime
pear run . dice1 --channel game-malam-ini --alias siti
```

---

## Protokol Wire (NDJSON)

Semua pesan adalah newline-delimited JSON via stream terenkripsi Hyperswarm.

### `ROLL_REQ` — Inisiasi Ronde
```json
{
  "type": "ROLL_REQ",
  "roundId": "a1b2c3d4",
  "sides": 20
}
```

### `COMMIT` — Fase Commit
```json
{
  "type": "COMMIT",
  "roundId": "a1b2c3d4",
  "commit": "sha256hexstring..."
}
```

### `REVEAL` — Fase Reveal
```json
{
  "type": "REVEAL",
  "roundId": "a1b2c3d4",
  "seed": "32bytehexstring..."
}
```

### `RESULT` — Hasil Final (dikirim initiator)
```json
{
  "type": "RESULT",
  "roundId": "a1b2c3d4",
  "sides": 20,
  "roll": 17,
  "participants": ["budi", "siti", "player-a3f2"],
  "seeds": { "<peerId>": "<seedHex>", "...": "..." },
  "commits": { "<peerId>": "<commitHex>", "...": "..." },
  "combined": "xor-of-all-seeds-hex"
}
```

### `CANCEL` — Batalkan Ronde
```json
{
  "type": "CANCEL",
  "roundId": "a1b2c3d4",
  "reason": "commit_mismatch | reveal_timeout"
}
```

---

## Format File Log

Setiap hasil disimpan ke `dice-log.txt` dengan format:
```
[ISO timestamp] ROLL d20 → 17 | participants: budi, siti | combined: 3af9bc12... | roundId: a1b2c3d4
```

---

## Catatan Keamanan

- Semua koneksi dienkripsi end-to-end (Noise protocol via Hyperswarm).
- Tidak ada peer yang bisa memprediksi hasil sebelum semua seed terungkap.
- Jika ada peer yang mengirim seed yang tidak cocok dengan commitnya → ronde otomatis dibatalkan.
- Timeout 30 detik untuk fase reveal — peer yang tidak reveal akan membatalkan ronde.
- Channel name dihash SHA-256 sebelum digunakan sebagai DHT topic.

---

## Integrasi Agent / Otomasi

```bash
# Jalankan proses
node index.js --alias bot-roller --channel game-privat

# Kirim command via stdin
echo "/roll d6" | node index.js --alias bot

# Filter hasil dari stdout
node index.js | grep "HASIL ROLL"
```

---

## Troubleshooting

| Gejala | Kemungkinan Penyebab | Solusi |
|---|---|---|
| Tidak ada peer | Firewall UDP | Izinkan UDP keluar |
| Ronde selalu timeout | Peer lambat / bad network | Coba channel privat, kurangi jumlah peer |
| `ERR_MODULE_NOT_FOUND` | Belum `npm install` | Jalankan `npm install` |
| Crash di Termux | Node terlalu lama | `pkg upgrade nodejs` |

---

*intercom-dice — Intercom Vibe Competition Submission*  
*Trac Address: [INSERT_YOUR_TRAC_ADDRESS_HERE]*
