#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  INTERCOM-DICE  v1.0.0                      ║
 * ║       Provably-Fair P2P Dice Roller · Commit-Reveal          ║
 * ║       Built for the Intercom Vibe Competition                ║
 * ║       Trac Network | Hyperswarm | Termux-Ready               ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HOW COMMIT-REVEAL WORKS:
 *   1. Each peer generates a secret random seed.
 *   2. Every peer broadcasts COMMIT = SHA256(seed).
 *   3. Once ALL peers have committed, everyone broadcasts their seed (REVEAL).
 *   4. Final result = XOR of all seeds → mapped to dice range.
 *   5. Anyone can verify: hash(seed) === their commit.
 *   → No single peer can cheat; the result depends on everyone's entropy.
 *
 * Author : [INSERT_YOUR_TRAC_ADDRESS_HERE]
 * License: MIT
 */

import Hyperswarm   from 'hyperswarm'
import b4a          from 'b4a'
import crypto       from 'crypto'
import readline     from 'readline'
import fs           from 'fs'
import path         from 'path'
import { fileURLToPath } from 'url'

// ─── Constants ─────────────────────────────────────────────────────────────

const APP_NAME    = 'INTERCOM-DICE'
const APP_VERSION = '1.0.0'
const DEFAULT_CHANNEL = 'intercom-dice-v1-global'
const LOG_FILE    = 'dice-log.txt'

// Supported dice types
const VALID_DICE  = [4, 6, 8, 10, 12, 20, 100]

// Commit-reveal phase timeouts (ms)
const REVEAL_TIMEOUT_MS = 30_000   // wait max 30 s for all reveals

// ─── ANSI colours (Termux-safe) ─────────────────────────────────────────────

const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  red    : '\x1b[31m',
  magenta: '\x1b[35m',
  blue   : '\x1b[34m',
  white  : '\x1b[97m',
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function topicFromString (str) {
  return crypto.createHash('sha256').update(str).digest()
}

function sha256hex (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function shortId (hexStr) {
  return hexStr.slice(0, 8) + '…' + hexStr.slice(-4)
}

function ts () {
  return new Date().toLocaleTimeString()
}

function log (icon, color, msg) {
  process.stdout.write(`\r${C[color] ?? ''}[${ts()}] ${icon}${C.reset} ${msg}\n> `)
}

function encode (obj) {
  return Buffer.from(JSON.stringify(obj) + '\n')
}

function decode (str) {
  try { return JSON.parse(str.trim()) } catch { return null }
}

// XOR two Buffers of arbitrary length (pads shorter one with zeros)
function xorBuffers (...bufs) {
  const len = Math.max(...bufs.map(b => b.length))
  const out = Buffer.alloc(len, 0)
  for (const buf of bufs) {
    for (let i = 0; i < buf.length; i++) out[i] ^= buf[i]
  }
  return out
}

// Map a buffer to integer in [1, sides]
function bufToRoll (buf, sides) {
  const num = buf.readUInt32BE(0) >>> 0   // unsigned 32-bit
  return (num % sides) + 1
}

// ─── State ──────────────────────────────────────────────────────────────────

let myAlias   = ''
let myPeerId  = ''    // hex public key

const peers   = new Map()  // peerId hex → { conn, alias }

// Active round state (null when idle)
let round = null
/*
  round = {
    id       : string (hex),
    sides    : number,
    initiator: string (peerId hex),
    commits  : Map<peerId, commitHex>,
    reveals  : Map<peerId, seedHex>,
    mySecret : Buffer,
    timer    : Timeout,
    phase    : 'commit' | 'reveal' | 'done',
  }
*/

// Session win counts  { alias → wins }
const leaderboard = new Map()

// ─── Log file ───────────────────────────────────────────────────────────────

function appendLog (entry) {
  const line = `[${new Date().toISOString()}] ${entry}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* ignore */ }
}

// ─── Message types ──────────────────────────────────────────────────────────

const MSG = {
  INFO    : 'INFO',     // peer announce
  ROLL_REQ: 'ROLL_REQ', // initiate a round
  COMMIT  : 'COMMIT',   // phase 1: hash(seed)
  REVEAL  : 'REVEAL',   // phase 2: seed
  RESULT  : 'RESULT',   // broadcast final result (by initiator)
  CANCEL  : 'CANCEL',   // abort current round
}

// ─── Networking ─────────────────────────────────────────────────────────────

let swarm

function broadcast (obj) {
  const frame = encode(obj)
  for (const [, peer] of peers) {
    try { peer.conn.write(frame) } catch { /* ignore */ }
  }
}

function sendTo (peerId, obj) {
  const peer = peers.get(peerId)
  if (!peer) return
  try { peer.conn.write(encode(obj)) } catch { /* ignore */ }
}

function handleConnection (conn, info) {
  const pid   = b4a.toString(info.publicKey, 'hex')
  const short = shortId(pid)
  peers.set(pid, { conn, alias: short })

  log('⟳', 'green', `Peer terhubung: ${short}  (total: ${peers.size})`)

  // Announce ourselves
  try {
    conn.write(encode({ type: MSG.INFO, alias: myAlias, version: APP_VERSION }))
  } catch { /* ignore */ }

  let buf = ''
  conn.on('data', data => {
    buf += data.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = decode(line)
      if (msg) handleMessage(pid, short, msg)
    }
  })

  conn.on('close', () => {
    peers.delete(pid)
    log('✕', 'dim', `${short} terputus  (sisa: ${peers.size})`)
    // Cancel round if a participant disconnected mid-round
    if (round && round.phase !== 'done') {
      log('⚠', 'yellow', 'Peer terputus saat ronde berjalan — ronde dibatalkan.')
      clearRound()
    }
  })

  conn.on('error', err => {
    if (err.code !== 'ECONNRESET') log('✕', 'red', `${short}: ${err.message}`)
    peers.delete(pid)
  })
}

// ─── Message handler ────────────────────────────────────────────────────────

function handleMessage (pid, short, msg) {
  const peer = peers.get(pid)

  switch (msg.type) {

    // ── Peer announced itself ──────────────────────────────────────────────
    case MSG.INFO:
      if (peer) peer.alias = msg.alias || short
      log('ℹ', 'blue', `${msg.alias || short} terhubung (v${msg.version || '?'})`)
      break

    // ── Someone initiated a roll ───────────────────────────────────────────
    case MSG.ROLL_REQ: {
      if (round) {
        log('⚠', 'yellow', 'Ada ronde yang sedang berjalan — permintaan roll diabaikan.')
        break
      }
      const sides = Number(msg.sides)
      if (!VALID_DICE.includes(sides)) {
        log('✕', 'red', `Jenis dadu tidak valid: d${sides}`)
        break
      }
      const initiatorAlias = (peer && peer.alias) || short
      log('🎲', 'cyan', `${initiatorAlias} mengajak roll d${sides}! Membuat commit…`)

      startRound(msg.roundId, sides, pid)
      break
    }

    // ── Received a commit ──────────────────────────────────────────────────
    case MSG.COMMIT: {
      if (!round || round.id !== msg.roundId) break
      if (round.commits.has(pid)) break   // duplicate, ignore

      round.commits.set(pid, msg.commit)
      const pAlias = (peer && peer.alias) || short
      log('🔒', 'magenta', `Commit diterima dari ${pAlias}  [${msg.commit.slice(0, 16)}…]`)

      checkAllCommitted()
      break
    }

    // ── Received a reveal ─────────────────────────────────────────────────
    case MSG.REVEAL: {
      if (!round || round.id !== msg.roundId || round.phase !== 'reveal') break
      if (round.reveals.has(pid)) break   // duplicate

      const commit = round.commits.get(pid)
      const seed   = Buffer.from(msg.seed, 'hex')
      const check  = sha256hex(seed)

      if (check !== commit) {
        log('🚨', 'red', `PERINGATAN: Commit dari ${(peer && peer.alias) || short} TIDAK COCOK dengan seednya! Ronde dibatalkan.`)
        appendLog(`FRAUD DETECTED — peer ${pid} commit=${commit} seed=${msg.seed} hash=${check}`)
        broadcast({ type: MSG.CANCEL, roundId: round.id, reason: 'commit_mismatch' })
        clearRound()
        break
      }

      round.reveals.set(pid, seed)
      log('🔓', 'green', `Reveal valid dari ${(peer && peer.alias) || short}`)

      checkAllRevealed()
      break
    }

    // ── Final result (sent by initiator) ──────────────────────────────────
    case MSG.RESULT: {
      if (!round || round.id !== msg.roundId) break
      displayResult(msg)
      clearRound()
      break
    }

    // ── Round cancelled ───────────────────────────────────────────────────
    case MSG.CANCEL:
      if (round && round.id === msg.roundId) {
        log('✕', 'red', `Ronde dibatalkan: ${msg.reason || 'unknown'}`)
        clearRound()
      }
      break
  }
}

// ─── Commit-Reveal Logic ─────────────────────────────────────────────────────

function startRound (roundId, sides, initiatorPid) {
  const mySecret = crypto.randomBytes(32)
  const myCommit = sha256hex(mySecret)

  round = {
    id       : roundId,
    sides,
    initiator: initiatorPid,
    commits  : new Map(),
    reveals  : new Map(),
    mySecret,
    timer    : null,
    phase    : 'commit',
  }

  // Store our own commit first
  round.commits.set(myPeerId, myCommit)

  // Broadcast our commit
  broadcast({ type: MSG.COMMIT, roundId, commit: myCommit })
  log('🔒', 'magenta', `Commit saya dikirim: [${myCommit.slice(0, 16)}…]`)
}

function checkAllCommitted () {
  if (!round || round.phase !== 'commit') return

  // All connected peers + self must have committed
  const expected = new Set([myPeerId, ...peers.keys()])
  const have     = new Set(round.commits.keys())

  for (const pid of expected) {
    if (!have.has(pid)) return  // still waiting
  }

  log('✅', 'green', `Semua ${expected.size} peer telah commit! Memulai fase reveal…`)
  round.phase = 'reveal'

  // Send our reveal
  const mySeedHex = round.mySecret.toString('hex')
  round.reveals.set(myPeerId, round.mySecret)
  broadcast({ type: MSG.REVEAL, roundId: round.id, seed: mySeedHex })

  // Set timeout in case someone never reveals
  round.timer = setTimeout(() => {
    log('⏱', 'red', 'Timeout menunggu reveal — ronde dibatalkan.')
    broadcast({ type: MSG.CANCEL, roundId: round.id, reason: 'reveal_timeout' })
    clearRound()
  }, REVEAL_TIMEOUT_MS)
}

function checkAllRevealed () {
  if (!round || round.phase !== 'reveal') return

  const expected = new Set([myPeerId, ...peers.keys()])
  const have     = new Set(round.reveals.keys())

  for (const pid of expected) {
    if (!have.has(pid)) return  // still waiting
  }

  // All reveals in — compute result
  clearTimeout(round.timer)

  const seeds     = [...round.reveals.values()]
  const combined  = xorBuffers(...seeds)
  const rollValue = bufToRoll(combined, round.sides)

  // Collect participant names for display
  const participants = [...round.reveals.keys()].map(pid => {
    if (pid === myPeerId) return myAlias
    const p = peers.get(pid)
    return (p && p.alias) || shortId(pid)
  })

  const result = {
    type        : MSG.RESULT,
    roundId     : round.id,
    sides       : round.sides,
    roll        : rollValue,
    participants,
    seeds       : Object.fromEntries(
      [...round.reveals.entries()].map(([pid, seed]) => [pid, seed.toString('hex')])
    ),
    commits     : Object.fromEntries(round.commits),
    combined    : combined.toString('hex'),
  }

  // Only initiator broadcasts the final result (others compute locally too)
  if (round.initiator === myPeerId) {
    broadcast(result)
  }

  displayResult(result)
  clearRound()
}

function displayResult (msg) {
  const dice  = `d${msg.sides}`
  const roll  = msg.roll
  const names = (msg.participants || []).join(', ')

  process.stdout.write(`\r
${C.bold}${C.yellow}╔══════════════════════════════════════════╗
║           🎲  HASIL ROLL  🎲             ║
╚══════════════════════════════════════════╝${C.reset}
  Jenis Dadu  : ${C.cyan}${C.bold}${dice}${C.reset}
  Hasil       : ${C.white}${C.bold}${roll}${C.reset}   ${rollArt(roll, msg.sides)}
  Peserta     : ${C.dim}${names}${C.reset}
  Combined XOR: ${C.dim}${(msg.combined || '').slice(0, 32)}…${C.reset}

${C.dim}  Verifikasi:${C.reset}
`)

  // Print each participant's seed → hash verification
  for (const [pid, seed] of Object.entries(msg.seeds || {})) {
    const commit  = (msg.commits || {})[pid] || '?'
    const recheck = sha256hex(Buffer.from(seed, 'hex'))
    const ok      = recheck === commit
    const pAlias  = pid === myPeerId ? myAlias : ((peers.get(pid) && peers.get(pid).alias) || shortId(pid))
    const status  = ok ? `${C.green}✓ VALID${C.reset}` : `${C.red}✗ INVALID${C.reset}`
    process.stdout.write(`  ${pAlias.padEnd(18)} seed=${seed.slice(0, 12)}… → ${status}\n`)
  }

  process.stdout.write('\n> ')

  // Update leaderboard: highest roller wins the session point
  // (only meaningful if roll == sides i.e. max roll)
  if (roll === msg.sides && msg.participants && msg.participants.length > 0) {
    // Award point to initiator alias on nat-max roll (fun mechanic)
    const initiatorAlias = msg.participants[0]
    const cur = leaderboard.get(initiatorAlias) || 0
    leaderboard.set(initiatorAlias, cur + 1)
  }

  // Append to log
  const logLine = `ROLL d${msg.sides} → ${roll} | participants: ${names} | combined: ${(msg.combined || '').slice(0, 16)}… | roundId: ${msg.roundId}`
  appendLog(logLine)
}

// Little ASCII art for dice faces (d6 only; others get a number block)
function rollArt (roll, sides) {
  if (sides !== 6) return `${C.cyan}[ ${roll} ]${C.reset}`
  const faces = ['', '⚀','⚁','⚂','⚃','⚄','⚅']
  return `${C.cyan}${faces[roll] || roll}${C.reset}`
}

function clearRound () {
  if (round && round.timer) clearTimeout(round.timer)
  round = null
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printHelp () {
  process.stdout.write(`
${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗
║         INTERCOM-DICE  COMMANDS                  ║
╚══════════════════════════════════════════════════╝${C.reset}
  ${C.yellow}/roll <d4|d6|d8|d10|d12|d20|d100>${C.reset}
      Mulai ronde commit-reveal dengan semua peer.
      Contoh: /roll d20

  ${C.yellow}/peers${C.reset}
      Lihat daftar peer yang terhubung.

  ${C.yellow}/leaderboard${C.reset}
      Tampilkan skor sesi ini.

  ${C.yellow}/log${C.reset}
      Tampilkan 10 hasil terakhir dari file log.

  ${C.yellow}/verify <seed> <commit>${C.reset}
      Verifikasi manual: apakah SHA256(seed) == commit?

  ${C.yellow}/alias <nama>${C.reset}
      Ganti nama tampilan kamu.

  ${C.yellow}/help${C.reset}
      Tampilkan menu ini.

  ${C.yellow}/exit${C.reset}
      Keluar dengan bersih.

${C.dim}  Dadu tersedia: d4 d6 d8 d10 d12 d20 d100${C.reset}
${C.dim}  Semua hasil disimpan otomatis ke ${LOG_FILE}${C.reset}
\n> `)
}

function printPeers () {
  if (peers.size === 0) {
    log('ℹ', 'yellow', 'Belum ada peer terhubung.')
    return
  }
  process.stdout.write(`\r${C.bold}Peer terhubung:${C.reset}\n`)
  for (const [pid, peer] of peers) {
    process.stdout.write(`  ${C.cyan}${shortId(pid)}${C.reset}  alias=${peer.alias}\n`)
  }
  process.stdout.write('> ')
}

function printLeaderboard () {
  if (leaderboard.size === 0) {
    log('ℹ', 'yellow', 'Belum ada skor sesi ini.')
    return
  }
  process.stdout.write(`\r${C.bold}${C.yellow}🏆 Leaderboard Sesi:${C.reset}\n`)
  const sorted = [...leaderboard.entries()].sort((a, b) => b[1] - a[1])
  sorted.forEach(([alias, score], i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  '
    process.stdout.write(`  ${medal} ${alias.padEnd(20)} ${score} poin\n`)
  })
  process.stdout.write('> ')
}

function printLog () {
  if (!fs.existsSync(LOG_FILE)) {
    log('ℹ', 'yellow', `File log belum ada: ${LOG_FILE}`)
    return
  }
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-10)
  process.stdout.write(`\r${C.bold}Log terakhir (${LOG_FILE}):${C.reset}\n`)
  for (const l of lines) {
    process.stdout.write(`  ${C.dim}${l}${C.reset}\n`)
  }
  process.stdout.write('> ')
}

function handleCommand (line) {
  const raw = line.trim()
  if (!raw) return

  if (!raw.startsWith('/')) {
    log('ℹ', 'dim', 'Ketik /help untuk daftar perintah.')
    return
  }

  const parts = raw.slice(1).split(' ')
  const cmd   = parts[0].toLowerCase()
  const rest  = parts.slice(1).join(' ').trim()

  switch (cmd) {

    case 'roll': {
      if (round) {
        log('⚠', 'yellow', 'Ada ronde yang sedang berjalan. Tunggu selesai dulu.')
        break
      }
      if (peers.size === 0) {
        log('⚠', 'yellow', 'Belum ada peer! Butuh minimal 1 peer untuk commit-reveal yang fair.')
        break
      }

      const diceStr = (rest || '').toLowerCase().replace('d', '')
      const sides   = Number(diceStr)

      if (!VALID_DICE.includes(sides)) {
        log('✕', 'red', `Dadu tidak valid. Pilih salah satu: d${VALID_DICE.join(', d')}`)
        break
      }

      const roundId = crypto.randomBytes(4).toString('hex')
      log('🎲', 'cyan', `Memulai ronde ${roundId} — d${sides} dengan ${peers.size} peer…`)

      // Broadcast roll request
      broadcast({ type: MSG.ROLL_REQ, roundId, sides })

      // Also start our own round (we are the initiator)
      startRound(roundId, sides, myPeerId)
      break
    }

    case 'peers':
      printPeers()
      break

    case 'leaderboard':
      printLeaderboard()
      break

    case 'log':
      printLog()
      break

    case 'verify': {
      // /verify <seedHex> <commitHex>
      const [seedHex, commitHex] = rest.split(' ')
      if (!seedHex || !commitHex) {
        log('✕', 'red', 'Usage: /verify <seedHex> <commitHex>')
        break
      }
      try {
        const recalc = sha256hex(Buffer.from(seedHex, 'hex'))
        const ok     = recalc === commitHex
        log(ok ? '✓' : '✕', ok ? 'green' : 'red',
          ok
            ? `VALID — SHA256(seed) cocok dengan commit.`
            : `TIDAK VALID — SHA256(seed)=${recalc.slice(0, 16)}… ≠ ${commitHex.slice(0, 16)}…`)
      } catch {
        log('✕', 'red', 'Input hex tidak valid.')
      }
      break
    }

    case 'alias':
      if (!rest) { log('✕', 'red', 'Usage: /alias <nama>'); break }
      myAlias = rest.slice(0, 24)
      log('✓', 'green', `Alias diubah ke "${myAlias}"`)
      break

    case 'help':
      printHelp()
      break

    case 'exit':
    case 'quit':
      log('✓', 'green', 'Keluar dari swarm…')
      process.exit(0)
      break

    default:
      log('✕', 'yellow', `Perintah tidak dikenal: /${cmd}. Ketik /help.`)
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main () {
  const args    = process.argv.slice(2)
  let channel   = DEFAULT_CHANNEL
  let alias     = ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && args[i + 1]) channel = args[++i]
    if (args[i] === '--alias'   && args[i + 1]) alias   = args[++i]
  }

  myAlias = alias || `player-${crypto.randomBytes(2).toString('hex')}`

  // Banner
  process.stdout.write(`
${C.bold}${C.yellow}
  ██████╗ ██╗ ██████╗███████╗
  ██╔══██╗██║██╔════╝██╔════╝
  ██║  ██║██║██║     █████╗
  ██║  ██║██║██║     ██╔══╝
  ██████╔╝██║╚██████╗███████╗
  ╚═════╝ ╚═╝ ╚═════╝╚══════╝${C.reset}${C.dim} intercom-dice v${APP_VERSION}${C.reset}
${C.cyan}  Provably-Fair P2P Dice Roller · Commit-Reveal Protocol${C.reset}
${C.dim}  Intercom Vibe Competition · Trac Network${C.reset}

`)

  // Init swarm
  swarm    = new Hyperswarm()
  myPeerId = b4a.toString(swarm.keyPair.publicKey, 'hex')

  log('⚡', 'green', `Peer ID  : ${shortId(myPeerId)}`)
  log('⚡', 'green', `Alias    : ${myAlias}`)
  log('⚡', 'green', `Channel  : ${channel}`)
  log('⚡', 'green', `Log file : ${path.resolve(LOG_FILE)}`)

  swarm.on('connection', handleConnection)

  const topic = topicFromString(channel)
  const disc  = swarm.join(topic, { server: true, client: true })
  await disc.flushed()

  log('✓', 'green', 'Bergabung ke DHT — menunggu peer. Ketik /help untuk mulai.\n')

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log('⟳', 'yellow', 'Meninggalkan swarm…')
      await swarm.destroy()
      process.exit(0)
    })
  }

  // CLI
  const rl = readline.createInterface({
    input   : process.stdin,
    output  : process.stdout,
    prompt  : '> ',
    terminal: true,
  })

  rl.prompt()
  rl.on('line',  line => { handleCommand(line); rl.prompt() })
  rl.on('close', async () => {
    await swarm.destroy()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
