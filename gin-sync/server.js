'use strict';

/*
 * ════════════════════════════════════════════════════════════════════════════
 *  GIN-Sync · Portal Diskusi Mahasiswa — SERVER
 *  Mata kuliah : Sistem Paralel dan Terdistribusi (Tugas Mandiri Sesi 5)
 *  Stack       : Node.js · Express (HTTP statis) · Socket.IO (WebSocket)
 *
 *  Prinsip rancangan
 *  1. Server adalah SATU-SATUNYA sumber kebenaran (authoritative server):
 *     identitas pengirim, id pesan, dan waktu ditentukan server, bukan client.
 *  2. Semua input dianggap tidak tepercaya → divalidasi, dinormalisasi, dibatasi.
 *  3. Semua memori dibatasi (bounded): riwayat 50 pesan/ruang, jumlah user dan
 *     koneksi dibatasi, ruang hanya dari katalog (whitelist).
 *  4. Ruang PRIVAT dilindungi kode akses: kode diverifikasi di server (hash +
 *     perbandingan waktu-konstan + penguncian brute-force), dan isi ruang
 *     (riwayat, daftar user, jumlah online) tidak dibocorkan sebelum lolos verifikasi.
 *  5. Toleransi kegagalan: error di satu handler tidak menjatuhkan server, dan
 *     client dapat bergabung ulang otomatis memakai token sesi.
 * ════════════════════════════════════════════════════════════════════════════
 */

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

/* ───────────────────────────── 1. KONFIGURASI ───────────────────────────── */

function parsePort(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const PORT = parsePort(process.env.PORT, 3000);
const HOST = process.env.HOST || '0.0.0.0';
// Aktifkan hanya bila berjalan di belakang reverse proxy tepercaya (Nginx, dsb.)
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Origin tambahan yang boleh membuka WebSocket (pisahkan dengan koma), mis. https://chat.kampus.ac.id
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Kode akses ruang privat TI25F. Dapat diganti tanpa mengubah kode: TI25F_CODE=rahasia npm start
const DEFAULT_TI25F_CODE = 'ti25f_f';
const TI25F_CODE = process.env.TI25F_CODE || DEFAULT_TI25F_CODE;

// Peta kode akses per ruang privat. Ruang privat tanpa entri di sini tidak bisa dimasuki siapa pun.
const ROOM_CODES = Object.freeze({ ti25f: TI25F_CODE });

const PUBLIC_DIR = path.join(__dirname, 'public');

const LIMITS = Object.freeze({
  historyPerRoom: 50, // riwayat per ruang (ring buffer)
  nameMax: 20,
  messageMax: 500, // karakter (code point)
  messageMaxLines: 8,
  codeMax: 64,
  maxUsersPerRoom: 100,
  maxConnections: 500, // total koneksi bersamaan
  maxConnectionsPerIp: parsePort(process.env.MAX_CONN_PER_IP, 20),
  handshakesPerMinutePerIp: 120,
  maxPayloadBytes: 8 * 1024, // batas ukuran satu paket dari client
  maxStrikes: 10, // pelanggaran rate-limit sebelum diputus
  strikeWindowMs: 60 * 1000,
  codeMaxFails: 5, // salah kode berturut-turut per IP …
  codeWindowMs: 10 * 60 * 1000, // … dalam jendela waktu ini …
  codeLockMs: 5 * 60 * 1000, // … memicu penguncian selama ini
});

/**
 * Katalog ruang (whitelist). Client TIDAK bisa membuat ruang baru (mencegah kebocoran memori).
 * Menambah ruang = menambah satu entri di sini; state-nya (riwayat + anggota) dibuat otomatis.
 *   access  : 'public' | 'private'
 *   topic   : deskripsi asli, hanya dikirim setelah user resmi masuk
 *   teaser  : deskripsi singkat yang boleh dilihat siapa saja di layar masuk
 */
const ROOM_CATALOG = Object.freeze([
  Object.freeze({
    id: 'chat-global',
    name: 'Chat Global',
    access: 'public',
    topic: 'Ruang terbuka untuk semua mahasiswa. Saling sapa dan tukar ide.',
    teaser: 'Terbuka untuk semua mahasiswa',
  }),
  Object.freeze({
    id: 'ti25f',
    name: 'TI25F',
    access: 'private',
    topic: 'Ruang khusus kelas TI25F: info kuliah, tugas, dan koordinasi.',
    teaser: 'Khusus kelas TI25F · butuh kode akses',
  }),
]);

const ALLOWED_EVENTS = new Set(['session:join', 'session:leave', 'chat:message', 'typing']);

/* ──────────────────────────── 2. UTILITAS UMUM ──────────────────────────── */

function log(level, event, meta = {}) {
  const time = new Date().toTimeString().slice(0, 8);
  const pairs = Object.entries(meta)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ').slice(0, 120)}`)
    .join(' ');
  const line = `[${time}] ${level.toUpperCase().padEnd(5)} ${event}${pairs ? ' ' + pairs : ''}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

/** Token bucket: mengizinkan lonjakan singkat (burst) tetapi membatasi laju rata-rata. */
class TokenBucket {
  constructor(capacity, refillPerSecond) {
    this.capacity = capacity;
    this.rate = refillPerSecond;
    this.tokens = capacity;
    this.last = Date.now();
  }
  take(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

/* ─────────────────────── 3. VALIDASI & SANITASI INPUT ───────────────────── */

// Nama dibatasi ASCII agar tidak ada penyamaran dengan huruf mirip (homoglyph,
// mis. 'а' Sirilik vs 'a' Latin) dan tidak ada karakter tak terlihat.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,19}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** Kunci unik nama: huruf kecil, tanpa pemisah, dan huruf mirip dilipat (0→o, 1/i→l). */
function foldName(name) {
  return name.toLowerCase().replace(/[\s._-]+/g, '').replace(/0/g, 'o').replace(/[1i]/g, 'l');
}
const RESERVED_NAMES = new Set(
  ['sistem', 'system', 'admin', 'administrator', 'moderator', 'server', 'gin-sync', 'ginsync', 'dosen'].map(foldName),
);

/** Kode akses tidak peka huruf besar/kecil dan spasi di tepi diabaikan (ramah pengguna). */
function normalizeCode(code) {
  return code.normalize('NFKC').trim().toLowerCase();
}
const hashCode = (code) => sha256(normalizeCode(code));

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g; // C0 + DEL + C1 (kecuali \t dan \n)
// Karakter tak terlihat & kontrol arah teks (bidi) yang sering dipakai untuk spoofing.
const INVISIBLE_AND_BIDI = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const bad = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });

function validateJoin(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return bad('BAD_REQUEST', 'Permintaan tidak valid.');
  }
  const { name: rawName, room: roomId, token, code } = payload;
  if (typeof rawName !== 'string' || typeof roomId !== 'string' || typeof token !== 'string') {
    return bad('BAD_REQUEST', 'Permintaan tidak valid.');
  }
  if (code !== undefined && code !== null && (typeof code !== 'string' || code.length > LIMITS.codeMax)) {
    return bad('BAD_REQUEST', 'Permintaan tidak valid.');
  }
  if (rawName.length > 80) return bad('INVALID_NAME', 'Nama terlalu panjang.');

  const name = rawName.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!NAME_PATTERN.test(name)) {
    return bad('INVALID_NAME', 'Nama 2–20 karakter: huruf, angka, spasi, titik, garis bawah, atau strip.');
  }
  const nameKey = foldName(name);
  if (nameKey.length < 2 || RESERVED_NAMES.has(nameKey)) {
    return bad('RESERVED_NAME', 'Nama ini dicadangkan sistem. Silakan pilih nama lain.');
  }
  if (!TOKEN_PATTERN.test(token)) return bad('BAD_REQUEST', 'Token sesi tidak valid.');

  const tokenHash = sha256(token);
  // uid publik diturunkan dari hash token → stabil saat reconnect, tidak bisa ditebak.
  const uid = tokenHash.toString('hex').slice(0, 12);
  return { ok: true, name, nameKey, roomId, tokenHash, uid, code: typeof code === 'string' ? code : '' };
}

function sanitizeMessage(raw) {
  if (typeof raw !== 'string') return bad('BAD_REQUEST', 'Format pesan tidak valid.');
  if (raw.length > LIMITS.messageMax * 4) return bad('TOO_LONG', `Pesan melebihi ${LIMITS.messageMax} karakter.`);

  let s = raw.normalize('NFC');
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed(); // buang surrogate yatim
  s = s
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_AND_BIDI, '')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1') // batasi tumpukan tanda diakritik ("zalgo")
    .replace(/ {3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!s) return bad('EMPTY', 'Pesan tidak boleh kosong.');
  if ([...s].length > LIMITS.messageMax) return bad('TOO_LONG', `Pesan melebihi ${LIMITS.messageMax} karakter.`);
  if ((s.match(/\n/g) || []).length >= LIMITS.messageMaxLines) {
    return bad('TOO_MANY_LINES', `Maksimal ${LIMITS.messageMaxLines} baris per pesan.`);
  }
  return { ok: true, text: s };
}

/* ─────────────────────── 4. HEADER KEAMANAN HTTP ────────────────────────── */

const HOST_HEADER_PATTERN = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Content-Security-Policy ketat: hanya skrip & gaya dari origin sendiri,
 * tanpa inline script/style, tanpa eval → jika ada celah XSS, browser tetap menolak eksekusi.
 * Host WebSocket ditulis eksplisit karena sebagian browser (Safari lama) tidak menganggap
 * ws:// sebagai bagian dari 'self'. Nilai Host divalidasi regex agar tidak bisa menyuntik header.
 */
function buildCsp(hostHeader) {
  const connect = ["'self'"];
  if (typeof hostHeader === 'string' && hostHeader.length <= 255 && HOST_HEADER_PATTERN.test(hostHeader)) {
    connect.push(`ws://${hostHeader}`, `wss://${hostHeader}`);
  }
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', buildCsp(req.headers.host));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

function readOnlyMethods(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET, HEAD').status(405).type('text/plain').send('405 — Metode tidak diizinkan');
}

/** Mencegah Cross-Site WebSocket Hijacking: origin browser harus sama dengan host server. */
function isOriginAllowed(origin, host) {
  if (!origin) return true; // klien non-browser (curl, skrip uji) tidak mengirim Origin
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/* ───────────────────────── 5. SERVER & LOGIKA REAL-TIME ─────────────────── */

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  if (TRUST_PROXY) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(readOnlyMethods);
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  });
  app.use(
    express.static(PUBLIC_DIR, {
      dotfiles: 'ignore',
      index: 'index.html',
      redirect: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  app.use((req, res) => res.status(404).type('text/plain').send('404 — Halaman tidak ditemukan'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log('error', 'http_error', { message: err && err.message });
    res.status(500).type('text/plain').send('500 — Terjadi kesalahan pada server');
  });

  const server = http.createServer(app);
  // Perlindungan Slowloris / koneksi menggantung
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  const io = new Server(server, {
    // Tanpa opsi `cors` → server tidak mengirim header CORS, hanya same-origin.
    allowRequest: (req, callback) => callback(null, isOriginAllowed(req.headers.origin, req.headers.host)),
    maxHttpBufferSize: LIMITS.maxPayloadBytes,
    pingInterval: 10_000, // heartbeat: server cek client tiap 10 dtk …
    pingTimeout: 8_000, // … dan memutus bila tak ada balasan dalam 8 dtk
    connectTimeout: 10_000,
    perMessageDeflate: false, // hindari beban CPU/memori kompresi (vektor DoS)
    transports: ['websocket', 'polling'],
  });

  /* ── State di memori (sengaja tanpa database: sesuai lingkup tugas) ── */
  const state = {
    rooms: new Map(), // roomId -> { meta, codeHash, history: Message[], members: Map<socketId, User> }
    connections: 0,
    perIp: new Map(), // ip -> jumlah koneksi aktif
    handshakes: new Map(), // ip -> { count, resetAt }
    codeGuard: new Map(), // ip -> { fails, windowStart, lockedUntil }  (anti brute-force kode ruang privat)
  };

  /** Membuat state sebuah ruang secara dinamis dari entri katalog. */
  function ensureRoom(meta) {
    let room = state.rooms.get(meta.id);
    if (!room) {
      room = {
        meta,
        codeHash: meta.access === 'private' ? hashCode(ROOM_CODES[meta.id] || randomHex(16)) : null,
        history: [],
        members: new Map(),
      };
      state.rooms.set(meta.id, room);
    }
    return room;
  }
  ROOM_CATALOG.forEach(ensureRoom);

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of state.handshakes) if (now >= entry.resetAt) state.handshakes.delete(ip);
    for (const [ip, e] of state.codeGuard) {
      if (e.lockedUntil <= now && now - e.windowStart > LIMITS.codeWindowMs) state.codeGuard.delete(ip);
    }
  }, 60_000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  /* ── Anti brute-force kode akses (per IP) ── */
  function codeLockRemaining(ip) {
    const e = state.codeGuard.get(ip);
    return e && e.lockedUntil > Date.now() ? e.lockedUntil - Date.now() : 0;
  }
  function codeRegisterFail(ip) {
    const now = Date.now();
    let e = state.codeGuard.get(ip);
    if (!e) e = { fails: 0, windowStart: now, lockedUntil: 0 };
    if (now - e.windowStart > LIMITS.codeWindowMs) {
      e.fails = 0;
      e.windowStart = now;
    }
    e.fails += 1;
    if (e.fails >= LIMITS.codeMaxFails) {
      e.lockedUntil = now + LIMITS.codeLockMs;
      e.fails = 0;
      e.windowStart = now;
    }
    state.codeGuard.set(ip, e);
    return { locked: e.lockedUntil > now, attemptsLeft: Math.max(0, LIMITS.codeMaxFails - e.fails) };
  }

  function codeMatches(room, provided) {
    // Hash dulu → panjang sama → timingSafeEqual: tidak membocorkan panjang/prefix kode lewat waktu respons.
    return crypto.timingSafeEqual(hashCode(provided), room.codeHash);
  }

  /* ── Helper domain ── */
  const listUsers = (room) =>
    [...room.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((u) => ({ uid: u.uid, name: u.name }));

  /** Statistik untuk layar masuk. Ruang privat TIDAK membocorkan jumlah online maupun deskripsi aslinya. */
  const roomStats = () =>
    ROOM_CATALOG.map((r) => ({
      id: r.id,
      name: r.name,
      access: r.access,
      teaser: r.teaser,
      online: r.access === 'public' ? state.rooms.get(r.id).members.size : null,
    }));

  let statsTimer = null;
  function scheduleStats() {
    // Digabung (debounce) agar lonjakan join/leave tidak membanjiri semua client.
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      io.emit('rooms:stats', roomStats());
    }, 200);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
  }

  const systemMessage = (text, kind) => ({ id: randomHex(6), kind, text, ts: Date.now() });

  function pushHistory(room, message) {
    room.history.push(message);
    if (room.history.length > LIMITS.historyPerRoom) {
      room.history.splice(0, room.history.length - LIMITS.historyPerRoom); // buang yang paling lama
    }
  }

  const reply = (ack, payload) => {
    if (typeof ack === 'function') ack(payload);
  };
  const fail = (ack, code, message, extra) => reply(ack, bad(code, message, extra));

  function strike(socket) {
    const d = socket.data;
    const now = Date.now();
    if (now - d.strikeSince > LIMITS.strikeWindowMs) {
      d.strikeSince = now;
      d.strikes = 0;
    }
    d.strikes += 1;
    if (d.strikes >= LIMITS.maxStrikes) {
      log('warn', 'kick_flood', { id: socket.id, ip: d.ip });
      socket.emit('session:kicked', { message: 'Anda diputus karena mengirim permintaan terlalu cepat.' });
      socket.disconnect(true);
    }
  }

  function leaveRoom(socket, verb) {
    const user = socket.data.user;
    if (!user) return;
    socket.data.user = null;
    const room = state.rooms.get(user.roomId);
    if (room) room.members.delete(socket.id);
    socket.leave(user.roomId);
    io.to(user.roomId).emit('typing', { uid: user.uid, name: user.name, isTyping: false });
    io.to(user.roomId).emit('chat:system', systemMessage(`${user.name} ${verb}`, 'leave'));
    if (room) io.to(user.roomId).emit('room:users', { roomId: user.roomId, users: listUsers(room) });
    scheduleStats();
    log('info', 'leave', { user: user.name, room: user.roomId, verb });
  }

  /** Pembungkus: error tak terduga di handler tidak boleh menjatuhkan proses server. */
  const handler = (name, fn) =>
    function wrapped(...args) {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      try {
        fn.call(this, args[0], ack);
      } catch (err) {
        log('error', 'handler_error', { event: name, message: err && err.message });
        fail(ack, 'INTERNAL', 'Terjadi kesalahan pada server. Silakan coba lagi.');
      }
    };

  /* ── Middleware koneksi: batas global, per-IP, dan laju handshake ── */
  function clientIp(socket) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (TRUST_PROXY && typeof xff === 'string' && xff) return xff.split(',').pop().trim() || socket.handshake.address;
    return socket.handshake.address;
  }

  io.use((socket, next) => {
    const ip = clientIp(socket);
    const now = Date.now();
    let hit = state.handshakes.get(ip);
    if (!hit || now >= hit.resetAt) {
      hit = { count: 0, resetAt: now + 60_000 };
      state.handshakes.set(ip, hit);
    }
    hit.count += 1;
    if (hit.count > LIMITS.handshakesPerMinutePerIp) return next(new Error('RATE_LIMITED'));
    if (state.connections >= LIMITS.maxConnections) return next(new Error('SERVER_BUSY'));
    if ((state.perIp.get(ip) || 0) >= LIMITS.maxConnectionsPerIp) return next(new Error('TOO_MANY_CONNECTIONS'));
    socket.data.ip = ip;
    next();
  });

  /* ── Event utama ── */
  io.on('connection', (socket) => {
    const ip = socket.data.ip;
    state.connections += 1;
    state.perIp.set(ip, (state.perIp.get(ip) || 0) + 1);

    socket.data.user = null;
    socket.data.strikes = 0;
    socket.data.strikeSince = Date.now();
    socket.data.buckets = {
      any: new TokenBucket(40, 20), // semua event
      message: new TokenBucket(5, 1.2), // pesan chat: burst 5, rata-rata ±1/dtk
      typing: new TokenBucket(10, 4),
      join: new TokenBucket(6, 0.2),
    };
    log('info', 'connect', { id: socket.id, ip, total: state.connections });

    socket.on('error', (err) => log('warn', 'socket_error', { id: socket.id, message: err && err.message }));

    // Middleware per-paket: daftar putih event + batas laju global per socket.
    socket.use(([event], next) => {
      if (typeof event !== 'string' || !ALLOWED_EVENTS.has(event)) {
        strike(socket);
        return next(new Error('UNKNOWN_EVENT'));
      }
      if (!socket.data.buckets.any.take()) {
        strike(socket);
        return next(new Error('FLOOD'));
      }
      next();
    });

    socket.emit('rooms:stats', roomStats());

    function snapshot(user, room) {
      return {
        ok: true,
        me: { uid: user.uid, name: user.name },
        room: { id: room.meta.id, name: room.meta.name, topic: room.meta.topic, access: room.meta.access },
        history: room.history, // maks. 50 pesan terakhir
        users: listUsers(room),
        serverTime: Date.now(),
      };
    }

    /* —— Bergabung / sambung ulang ke ruang —— */
    socket.on(
      'session:join',
      handler('session:join', (payload, ack) => {
        if (!socket.data.buckets.join.take()) {
          strike(socket);
          return fail(ack, 'RATE_LIMIT', 'Terlalu sering mencoba bergabung. Tunggu sebentar.');
        }
        const v = validateJoin(payload);
        if (!v.ok) return fail(ack, v.code, v.message);

        const room = state.rooms.get(v.roomId); // Map → aman dari kunci "__proto__"
        if (!room) return fail(ack, 'INVALID_ROOM', 'Ruang tidak tersedia.');

        const current = socket.data.user;
        if (current && current.roomId === v.roomId && current.nameKey === v.nameKey) {
          // Sudah (dan sah) berada di ruang ini → idempoten, kirim ulang snapshot.
          return reply(ack, snapshot(current, room));
        }

        /* Gerbang akses ruang privat. Urutan penting: kode diperiksa SEBELUM cek bentrok nama,
           agar pihak luar tidak bisa mengintip siapa yang ada di dalam ruang privat. */
        if (room.meta.access === 'private') {
          const wait = codeLockRemaining(ip);
          if (wait > 0) {
            return fail(ack, 'LOCKED', 'Terlalu banyak kode salah. Coba lagi nanti.', { retryAfterMs: wait });
          }
          if (!v.code.trim()) return fail(ack, 'CODE_REQUIRED', 'Ruang ini privat. Masukkan kode akses.');
          if (!codeMatches(room, v.code)) {
            const r = codeRegisterFail(ip);
            log('warn', 'bad_code', { ip, room: room.meta.id, locked: r.locked });
            if (r.locked) {
              return fail(ack, 'LOCKED', 'Terlalu banyak kode salah. Coba lagi nanti.', { retryAfterMs: LIMITS.codeLockMs });
            }
            return fail(ack, 'BAD_CODE', `Kode akses salah. Sisa percobaan: ${r.attemptsLeft}.`, { attemptsLeft: r.attemptsLeft });
          }
          state.codeGuard.delete(ip); // sukses → reset hitungan gagal
        }

        // Bentrok nama. Token sama = pemilik sesi yang sama (sambung ulang) → ganti socket lama.
        let stale = null;
        for (const m of room.members.values()) {
          if (m.socketId === socket.id || m.nameKey !== v.nameKey) continue;
          if (crypto.timingSafeEqual(m.tokenHash, v.tokenHash)) stale = m;
          else return fail(ack, 'NAME_TAKEN', 'Nama sudah dipakai di ruang ini. Pilih nama lain.');
        }
        const effectiveSize = room.members.size - (stale ? 1 : 0) - (current && current.roomId === v.roomId ? 1 : 0);
        if (effectiveSize >= LIMITS.maxUsersPerRoom) return fail(ack, 'ROOM_FULL', 'Ruang sudah penuh.');

        if (current) leaveRoom(socket, 'pindah ke ruang lain');

        if (stale) {
          room.members.delete(stale.socketId);
          const old = io.sockets.sockets.get(stale.socketId);
          if (old) {
            old.data.user = null;
            old.leave(v.roomId);
            old.emit('session:replaced', { message: 'Sesi Anda dipindahkan ke koneksi baru.' });
            old.disconnect(true);
          }
        }

        const user = {
          uid: v.uid,
          name: v.name,
          nameKey: v.nameKey,
          tokenHash: v.tokenHash,
          socketId: socket.id,
          roomId: v.roomId,
          joinedAt: Date.now(),
        };
        room.members.set(socket.id, user);
        socket.data.user = user;
        socket.join(v.roomId);

        // Pengumuman & daftar user hanya untuk anggota LAIN (yang bersangkutan menerimanya lewat ack).
        if (!stale) socket.to(v.roomId).emit('chat:system', systemMessage(`${user.name} bergabung`, 'join'));
        socket.to(v.roomId).emit('room:users', { roomId: v.roomId, users: listUsers(room) });
        scheduleStats();
        log('info', 'join', { user: user.name, room: v.roomId, size: room.members.size, resumed: Boolean(stale) });
        reply(ack, snapshot(user, room));
      }),
    );

    /* —— Keluar dari ruang (tombol "Keluar Ruangan") —— */
    socket.on(
      'session:leave',
      handler('session:leave', (payload, ack) => {
        leaveRoom(socket, 'keluar dari ruangan');
        reply(ack, { ok: true });
      }),
    );

    /* —— Kirim pesan —— */
    socket.on(
      'chat:message',
      handler('chat:message', (payload, ack) => {
        const user = socket.data.user;
        if (!user) return fail(ack, 'NOT_JOINED', 'Anda belum bergabung ke ruang.');
        if (!socket.data.buckets.message.take()) {
          strike(socket);
          return fail(ack, 'RATE_LIMIT', 'Terlalu cepat. Beri jeda sebentar sebelum mengirim lagi.');
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return fail(ack, 'BAD_REQUEST', 'Format pesan tidak valid.');
        }
        const clean = sanitizeMessage(payload.text);
        if (!clean.ok) return fail(ack, clean.code, clean.message);

        const room = state.rooms.get(user.roomId);
        // Identitas, id, dan waktu SELALU dari server — client tidak bisa memalsukan pengirim.
        const message = Object.freeze({
          id: randomHex(8),
          kind: 'message',
          uid: user.uid,
          name: user.name,
          text: clean.text,
          ts: Date.now(),
        });
        pushHistory(room, message);
        io.to(user.roomId).emit('chat:message', message); // ke semua anggota ruang, termasuk pengirim
        reply(ack, { ok: true, id: message.id });
      }),
    );

    /* —— Indikator mengetik (tidak disimpan; hanya diteruskan ke anggota lain) —— */
    socket.on(
      'typing',
      handler('typing', (payload) => {
        const user = socket.data.user;
        if (!user || typeof payload !== 'boolean') return;
        if (!socket.data.buckets.typing.take()) return; // abaikan diam-diam
        socket.to(user.roomId).emit('typing', { uid: user.uid, name: user.name, isTyping: payload });
      }),
    );

    /* —— Terputus (tab ditutup, jaringan putus, heartbeat habis, atau diputus server) —— */
    socket.on('disconnect', (reason) => {
      try {
        leaveRoom(socket, 'terputus');
      } finally {
        state.connections -= 1;
        const left = (state.perIp.get(ip) || 1) - 1;
        if (left <= 0) state.perIp.delete(ip);
        else state.perIp.set(ip, left);
        log('info', 'disconnect', { id: socket.id, reason, total: state.connections });
      }
    });
  });

  return { app, server, io, state };
}

/* ───────────────────────────── 6. START & SHUTDOWN ──────────────────────── */

function start() {
  const { server, io } = createServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') log('error', 'startup', { message: `Port ${PORT} sedang dipakai. Jalankan dengan PORT=3001 npm start` });
    else log('error', 'server_error', { message: err.message });
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  GIN-Sync · Portal Diskusi Mahasiswa');
    console.log(`  Lokal   : http://localhost:${PORT}`);
    console.log(`  Bind    : ${HOST}:${PORT}   (jaringan LAN: gunakan IP komputer ini)`);
    console.log('  Ruang   : Chat Global (publik) · TI25F (privat, butuh kode akses)');
    if (TI25F_CODE === DEFAULT_TI25F_CODE) {
      console.log('  Catatan : kode TI25F masih bawaan. Ganti dengan: TI25F_CODE=kode-baru npm start');
    } else {
      console.log('  Kode TI25F diambil dari variabel lingkungan TI25F_CODE.');
    }
    console.log('  Berhenti: tekan Ctrl+C');
    console.log('');
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log('info', 'shutdown', { signal });
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    io.close(() => process.exit(0)); // io.close() juga menutup http server
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => log('error', 'unhandled_rejection', { reason: reason && reason.message ? reason.message : reason }));
  process.on('uncaughtException', (err) => {
    // State bisa tidak konsisten → catat lalu keluar; pengawas proses (pm2/Docker) menjalankan ulang,
    // dan client otomatis tersambung kembali serta bergabung ulang ke ruangnya.
    log('error', 'uncaught_exception', { message: err && err.stack ? err.stack.split('\n')[0] : err });
    process.exit(1);
  });
}

if (require.main === module) start();

module.exports = {
  createServer,
  validateJoin,
  sanitizeMessage,
  foldName,
  normalizeCode,
  buildCsp,
  isOriginAllowed,
  TokenBucket,
  LIMITS,
  ROOM_CATALOG,
};
