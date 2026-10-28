'use strict';

/*
 * ════════════════════════════════════════════════════════════════════════════
 *  GIN-Sync · CLIENT (Vanilla JavaScript, tanpa framework)
 *
 *  Aturan keamanan di berkas ini:
 *  • TIDAK ADA innerHTML / outerHTML / insertAdjacentHTML / document.write.
 *    Semua teks dari pengguna masuk lewat `textContent` → selalu dianggap teks biasa.
 *  • Tidak ada style inline dari data pengguna (warna avatar = kelas CSS tetap).
 *  • Tidak menyimpan apa pun di localStorage/cookie. Token sesi dan kode akses ruang
 *    privat hanya hidup di memori tab, dan dihapus saat keluar ruangan.
 *  • Server adalah sumber kebenaran: identitas pengirim berasal dari server,
 *    client hanya membandingkan `uid` untuk membedakan pesan sendiri vs orang lain.
 * ════════════════════════════════════════════════════════════════════════════
 */
(() => {
  /* ───────────── Konstanta ───────────── */
  const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,19}$/;
  const MESSAGE_MAX = 500;
  const ACK_TIMEOUT_MS = 6000;
  const TYPING_IDLE_MS = 1600; // berhenti mengetik → kirim "stop" setelah jeda ini
  const TYPING_KEEPALIVE_MS = 2500; // selama masih mengetik, segarkan sinyal tiap ±2,5 dtk
  const TYPING_EXPIRE_MS = 4500; // sisi penerima: hapus indikator bila sinyal berhenti datang
  const NEAR_BOTTOM_PX = 96;
  const MAX_DOM_MESSAGES = 300; // batasi memori DOM di sisi client
  const MAX_SEEN_IDS = 600;
  const AVATAR_VARIANTS = 8;
  const GROUP_WINDOW_MS = 2 * 60 * 1000;

  /* ───────────── Referensi DOM ───────────── */
  const $ = (id) => document.getElementById(id);
  const dom = {
    banner: $('conn-banner'),
    bannerText: $('conn-banner-text'),
    viewLogin: $('view-login'),
    viewChat: $('view-chat'),
    loginForm: $('login-form'),
    inputName: $('input-name'),
    roomTrigger: $('room-trigger'),
    roomTriggerTitle: $('room-trigger-title'),
    roomTriggerSub: $('room-trigger-sub'),
    roomList: $('room-list'),
    fieldCode: $('field-code'),
    inputCode: $('input-code'),
    btnEye: $('btn-eye'),
    loginError: $('login-error'),
    btnJoin: $('btn-join'),
    sidebar: $('sidebar'),
    backdrop: $('backdrop'),
    btnDrawer: $('btn-drawer'),
    btnCloseDrawer: $('btn-close-drawer'),
    sideRoomName: $('side-room-name'),
    sideRoomTopic: $('side-room-topic'),
    userList: $('user-list'),
    userCount: $('user-count'),
    meAvatar: $('me-avatar'),
    meName: $('me-name'),
    btnLeave: $('btn-leave'),
    roomTitle: $('room-title'),
    roomBadge: $('room-badge'),
    roomTopic: $('room-topic'),
    stream: $('stream'),
    messages: $('messages'),
    btnLatest: $('btn-latest'),
    latestCount: $('latest-count'),
    typing: $('typing'),
    typingText: $('typing-text'),
    composer: $('composer'),
    inputMessage: $('input-message'),
    charCount: $('char-count'),
    btnSend: $('btn-send'),
    toast: $('toast'),
    connEls: document.querySelectorAll('[data-conn]'),
    connLabels: document.querySelectorAll('[data-conn-label]'),
    accessIcons: document.querySelectorAll('[data-access-icon]'),
  };

  /** Daftar ruang untuk dropdown, dibaca dari HTML (tetap tampil walau server belum tersambung). */
  const roomOptions = Array.from(dom.roomList.querySelectorAll('[role="option"]')).map((el) => ({
    id: el.dataset.room,
    name: el.dataset.name,
    access: el.dataset.access,
    el,
    subEl: el.querySelector('.opt__sub'),
    baseSub: el.querySelector('.opt__sub').textContent,
  }));

  /* ───────────── State aplikasi ───────────── */
  const state = {
    token: null, // rahasia sesi (acak 128-bit); membuktikan "ini saya" saat sambung ulang
    session: null, // { name, roomId, code } → dipakai untuk auto-rejoin setelah reconnect
    me: null, // { uid, name } dari server
    room: null, // { id, name, topic, access }
    stats: new Map(), // roomId -> { online }  (dari server; ruang privat tidak membocorkan angka)
    pick: roomOptions[0].id, // ruang yang dipilih di dropdown
    activeIdx: 0, // opsi yang disorot di dropdown (keyboard/mouse)
    lockUntil: 0, // waktu (ms) sampai kode ruang privat terkunci (anti brute-force dari server)
    lockTimer: null,
    joined: false,
    joining: false,
    busy: false,
    sending: false,
    lastMsg: null, // { uid, ts } untuk pengelompokan pesan berurutan
    lastDay: null,
    seen: new Set(), // id pesan yang sudah dirender (mencegah duplikat saat rejoin)
    unread: 0,
    following: true, // true = pengguna sedang di dasar percakapan → ikuti pesan baru
    titleUnread: 0,
    typingRemote: new Map(), // uid -> { name, timer }
    typingActive: false,
    typingLastEmit: 0,
    typingTimer: null,
    toastTimer: null,
  };

  const conn = { everConnected: false, down: false, hideTimer: null, retryTimer: null };

  /* ───────────── Utilitas ───────────── */
  /** Membuat elemen dengan teks AMAN (textContent). Satu-satunya jalur data → DOM. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function formatTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '--:--';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function dayLabel(ts) {
    const key = dayKey(ts);
    const now = Date.now();
    if (key === dayKey(now)) return 'Hari ini';
    if (key === dayKey(now - 86400000)) return 'Kemarin';
    try {
      return new Date(ts).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
    } catch {
      return `${pad2(new Date(ts).getDate())}/${pad2(new Date(ts).getMonth() + 1)}`;
    }
  }

  function newToken() {
    // getRandomValues tersedia juga di http:// (randomUUID hanya di HTTPS/localhost).
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function avatarIndex(uid) {
    let h = 0;
    for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % AVATAR_VARIANTS;
  }

  function initials(name) {
    const parts = String(name).split(/[\s._-]+/).filter(Boolean);
    const letters = parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    return letters || '?';
  }

  function makeAvatar(uid, name, extraClass) {
    const a = el('span', `avatar av-${avatarIndex(uid)}${extraClass ? ' ' + extraClass : ''}`, initials(name));
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  function toast(text, tone) {
    clearTimeout(state.toastTimer);
    dom.toast.textContent = text;
    dom.toast.dataset.tone = tone || 'info';
    dom.toast.hidden = false;
    state.toastTimer = setTimeout(() => {
      dom.toast.hidden = true;
    }, 3800);
  }

  function isValidMessage(m) {
    return (
      m &&
      typeof m === 'object' &&
      typeof m.id === 'string' && m.id.length <= 64 &&
      typeof m.uid === 'string' && m.uid.length <= 32 &&
      typeof m.name === 'string' && m.name.length <= 40 &&
      typeof m.text === 'string' && m.text.length <= MESSAGE_MAX * 4 &&
      typeof m.ts === 'number'
    );
  }

  const pickedRoom = () => roomOptions.find((r) => r.id === state.pick) || roomOptions[0];
  const isLocked = () => state.lockUntil > Date.now() && pickedRoom().access === 'private';

  /* ───────────── Banner & status koneksi ───────────── */
  function showBanner(kind, text) {
    clearTimeout(conn.hideTimer);
    dom.banner.dataset.kind = kind;
    dom.bannerText.textContent = text;
    dom.banner.hidden = false;
  }
  function hideBanner() {
    clearTimeout(conn.hideTimer);
    dom.banner.hidden = true;
  }

  function setStatus(status) {
    const label = { online: 'Terhubung', offline: 'Terputus', connecting: 'Menyambung…' }[status];
    dom.connEls.forEach((d) => { d.dataset.state = status; });
    dom.connLabels.forEach((l) => { l.textContent = label; });
    dom.userList.classList.toggle('is-stale', status !== 'online');
    updateControls();
  }

  function updateControls() {
    const online = Boolean(socket && socket.connected);
    dom.btnJoin.disabled = !online || state.busy || isLocked();
    const canWrite = online && state.joined;
    dom.inputMessage.disabled = !canWrite;
    dom.btnSend.disabled = !canWrite || state.sending || dom.inputMessage.value.trim() === '';
    dom.inputMessage.placeholder = canWrite ? 'Tulis pesan…' : 'Menunggu koneksi ke server…';
  }

  /* ───────────── Socket.IO ───────────── */
  if (typeof io !== 'function') {
    showBanner('offline', 'Pustaka Socket.IO gagal dimuat. Pastikan server berjalan, lalu muat ulang halaman.');
    dom.btnJoin.disabled = true;
    return;
  }

  const socket = io({
    transports: ['websocket', 'polling'], // utamakan WebSocket; polling hanya cadangan
    reconnection: true,
    reconnectionDelay: 800, // jeda awal antar percobaan …
    reconnectionDelayMax: 5000, // … naik bertahap (exponential backoff) hingga 5 dtk
    randomizationFactor: 0.4, // jitter: mencegah semua client menyerbu server di detik yang sama
    timeout: 8000,
  });

  socket.on('connect', () => {
    const wasDown = conn.everConnected && conn.down;
    conn.everConnected = true;
    conn.down = false;
    clearTimeout(conn.retryTimer);
    setStatus('online');

    if (wasDown) {
      showBanner('restored', 'Koneksi pulih — tersambung kembali ke server.');
      conn.hideTimer = setTimeout(hideBanner, 2600);
    } else {
      hideBanner();
    }
    // Server mungkin baru restart (memori kosong) → bergabung ulang otomatis dengan token yang sama.
    if (state.session && !state.joining) resumeSession();
  });

  socket.on('disconnect', (reason) => {
    conn.down = true;
    state.joined = false;
    state.joining = false;
    stopLocalTyping(false);
    clearRemoteTyping();
    setStatus('offline');
    showBanner('offline', 'Terputus dari server, mencoba menghubungkan kembali…');

    // 'io server disconnect' = server sendiri yang menutup; Socket.IO TIDAK akan mencoba lagi
    // otomatis, jadi kita jadwalkan sambungan ulang manual.
    if (reason === 'io server disconnect') {
      clearTimeout(conn.retryTimer);
      conn.retryTimer = setTimeout(() => socket.connect(), 2500);
    }
  });

  socket.on('connect_error', (err) => {
    conn.down = true;
    setStatus('offline');
    const code = err && err.message;
    if (code === 'TOO_MANY_CONNECTIONS' || code === 'SERVER_BUSY' || code === 'RATE_LIMITED') {
      showBanner('offline', 'Server menolak sambungan untuk sementara (terlalu ramai). Mencoba lagi…');
    } else if (!conn.everConnected) {
      showBanner('offline', 'Server belum dapat dijangkau. Mencoba menghubungkan…');
    } else {
      showBanner('offline', 'Terputus dari server, mencoba menghubungkan kembali…');
    }
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    setStatus('connecting');
    const base = conn.everConnected
      ? 'Terputus dari server, mencoba menghubungkan kembali…'
      : 'Server belum dapat dijangkau. Mencoba menghubungkan…';
    showBanner('offline', `${base} (percobaan ke-${attempt})`);
  });

  /* ── Event dari server ── */
  socket.on('chat:message', (msg) => {
    if (!state.joined || !isValidMessage(msg)) return;
    dropRemoteTyping(msg.uid);
    appendMessage(msg);
  });

  socket.on('chat:system', (sys) => {
    if (!state.joined || !sys || typeof sys.text !== 'string') return;
    appendSystem(sys.text, sys.kind, typeof sys.ts === 'number' ? sys.ts : Date.now());
  });

  socket.on('room:users', (payload) => {
    if (!state.joined || !payload || !state.room || payload.roomId !== state.room.id) return;
    renderUsers(payload.users);
  });

  socket.on('typing', (payload) => {
    if (!state.joined || !payload || typeof payload.uid !== 'string' || typeof payload.name !== 'string') return;
    if (state.me && payload.uid === state.me.uid) return;
    if (payload.isTyping === true) setRemoteTyping(payload.uid, payload.name);
    else dropRemoteTyping(payload.uid);
  });

  socket.on('rooms:stats', (list) => {
    if (!Array.isArray(list)) return;
    state.stats.clear();
    list.forEach((r) => {
      if (r && typeof r.id === 'string') state.stats.set(r.id, { online: typeof r.online === 'number' ? r.online : null });
    });
    renderPicker();
  });

  socket.on('session:kicked', (p) => returnToLogin((p && p.message) || 'Anda diputus oleh server.', 'error'));
  socket.on('session:replaced', (p) => returnToLogin((p && p.message) || 'Sesi dipindahkan ke tab lain.', 'info'));

  /* ───────────── Dropdown ruang (listbox kustom, bisa dipakai dengan keyboard) ───────────── */
  function subText(room) {
    if (room.access === 'private') return room.baseSub; // jumlah online ruang privat sengaja tidak ditampilkan
    const s = state.stats.get(room.id);
    return s && s.online !== null ? `${room.baseSub} · ${s.online} online` : room.baseSub;
  }

  function renderPicker() {
    const room = pickedRoom();
    roomOptions.forEach((r, i) => {
      r.el.setAttribute('aria-selected', String(r.id === room.id));
      r.el.classList.toggle('is-active', i === state.activeIdx && !dom.roomList.hidden);
      r.subEl.textContent = subText(r);
    });
    dom.roomTriggerTitle.textContent = room.name;
    dom.roomTriggerSub.textContent = subText(room);
    dom.accessIcons.forEach((ic) => {
      if (ic.closest('#room-trigger')) ic.toggleAttribute('hidden', ic.dataset.accessIcon !== room.access);
    });
  }

  function isPickerOpen() {
    return !dom.roomList.hidden;
  }
  function openPicker() {
    if (isPickerOpen()) return;
    state.activeIdx = Math.max(0, roomOptions.findIndex((r) => r.id === state.pick));
    dom.roomList.hidden = false;
    dom.roomTrigger.setAttribute('aria-expanded', 'true');
    setActive(state.activeIdx);
    dom.roomList.focus({ preventScroll: true });
  }
  function closePicker(restoreFocus) {
    if (!isPickerOpen()) return;
    dom.roomList.hidden = true;
    dom.roomList.removeAttribute('aria-activedescendant');
    dom.roomTrigger.setAttribute('aria-expanded', 'false');
    roomOptions.forEach((r) => r.el.classList.remove('is-active'));
    if (restoreFocus) dom.roomTrigger.focus();
  }
  function setActive(idx) {
    state.activeIdx = (idx + roomOptions.length) % roomOptions.length;
    roomOptions.forEach((r, i) => r.el.classList.toggle('is-active', i === state.activeIdx));
    dom.roomList.setAttribute('aria-activedescendant', roomOptions[state.activeIdx].el.id);
  }

  function choosePick(id) {
    const changed = id !== state.pick;
    state.pick = id;
    closePicker(true);
    renderPicker();
    const priv = pickedRoom().access === 'private';
    dom.fieldCode.hidden = !priv;
    if (!priv) dom.inputCode.value = '';
    if (changed) {
      clearLoginMessage();
      if (isLocked()) showLockMessage();
    }
    updateControls();
    if (priv) dom.inputCode.focus();
  }

  dom.roomTrigger.addEventListener('click', () => (isPickerOpen() ? closePicker(false) : openPicker()));
  dom.roomTrigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openPicker();
    }
  });
  dom.roomList.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive(state.activeIdx + 1); break;
      case 'ArrowUp': e.preventDefault(); setActive(state.activeIdx - 1); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(roomOptions.length - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); choosePick(roomOptions[state.activeIdx].id); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); closePicker(true); break;
      case 'Tab': closePicker(false); break;
      default: break;
    }
  });
  roomOptions.forEach((r, i) => {
    r.el.addEventListener('click', () => choosePick(r.id));
    r.el.addEventListener('mousemove', () => { if (state.activeIdx !== i) setActive(i); });
  });
  document.addEventListener('click', (e) => {
    if (isPickerOpen() && e.target instanceof Node && !e.target.closest('#room-picker')) closePicker(false);
  });

  dom.btnEye.addEventListener('click', () => {
    const show = dom.inputCode.type === 'password';
    dom.inputCode.type = show ? 'text' : 'password';
    dom.btnEye.setAttribute('aria-pressed', String(show));
    dom.btnEye.setAttribute('aria-label', show ? 'Sembunyikan kode' : 'Tampilkan kode');
    dom.inputCode.focus();
  });

  /* ───────────── Masuk / sambung ulang ───────────── */
  function validateName(name) {
    if (!name) return 'Nama pengguna wajib diisi.';
    if (!NAME_PATTERN.test(name)) return 'Nama 2–20 karakter: huruf, angka, spasi, titik, _ atau -.';
    return null;
  }

  function showLoginMessage(text, tone, focusEl) {
    dom.loginError.textContent = text;
    dom.loginError.dataset.tone = tone || 'error';
    dom.loginError.hidden = false;
    dom.inputName.removeAttribute('aria-invalid');
    dom.inputCode.removeAttribute('aria-invalid');
    if (focusEl && tone !== 'info') {
      focusEl.setAttribute('aria-invalid', 'true');
      focusEl.classList.remove('is-shake');
      void focusEl.offsetWidth; // restart animasi
      focusEl.classList.add('is-shake');
      focusEl.focus();
    }
  }
  function clearLoginMessage() {
    dom.loginError.hidden = true;
    dom.loginError.textContent = '';
    dom.inputName.removeAttribute('aria-invalid');
    dom.inputCode.removeAttribute('aria-invalid');
  }

  /** Server mengunci percobaan kode (anti brute-force) → tampilkan hitung mundur dan nonaktifkan tombol. */
  function showLockMessage() {
    const left = Math.max(0, state.lockUntil - Date.now());
    const mins = Math.max(1, Math.ceil(left / 60000));
    showLoginMessage(`Terlalu banyak kode salah. Coba lagi dalam sekitar ${mins} menit. Ruang publik tetap bisa dimasuki.`, 'error');
  }
  function startLock(ms) {
    state.lockUntil = Date.now() + Math.max(1000, Number(ms) || 0);
    clearInterval(state.lockTimer);
    let shownMins = Math.ceil((state.lockUntil - Date.now()) / 60000);
    showLockMessage();
    state.lockTimer = setInterval(() => {
      const left = state.lockUntil - Date.now();
      if (left <= 0) {
        clearInterval(state.lockTimer);
        state.lockUntil = 0;
        clearLoginMessage();
        updateControls();
        return;
      }
      const mins = Math.ceil(left / 60000);
      if (mins !== shownMins) {
        shownMins = mins;
        if (isLocked()) showLockMessage();
      }
    }, 1000);
    updateControls();
  }

  function setBusy(value) {
    state.busy = value;
    updateControls();
  }

  dom.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) return;
    clearLoginMessage();

    const room = pickedRoom();
    const name = dom.inputName.value.replace(/\s+/g, ' ').trim();
    const problem = validateName(name);
    if (problem) return showLoginMessage(problem, 'error', dom.inputName);

    const code = room.access === 'private' ? dom.inputCode.value.trim() : '';
    if (room.access === 'private' && !code) {
      return showLoginMessage(`Ruang ${room.name} bersifat privat. Masukkan kode akses.`, 'error', dom.inputCode);
    }
    if (isLocked()) return showLockMessage();
    if (!socket.connected) {
      return showLoginMessage('Belum tersambung ke server. Tunggu hingga status berubah menjadi "Terhubung".');
    }
    state.token = newToken();
    setBusy(true);
    sendJoin({ name, roomId: room.id, code }, 'login');
  });

  /** mode: 'login' (masuk baru) | 'rejoin' (otomatis setelah reconnect) */
  function sendJoin(session, mode) {
    state.joining = true;
    const payload = { name: session.name, room: session.roomId, token: state.token };
    if (session.code) payload.code = session.code;
    socket.timeout(ACK_TIMEOUT_MS).emit('session:join', payload, (err, res) => {
      state.joining = false;
      setBusy(false);
      if (err) return onJoinFailed({ code: 'TIMEOUT', message: 'Server tidak merespons. Silakan coba lagi.' }, mode, session);
      if (!res || res.ok !== true) return onJoinFailed(res || {}, mode, session);
      onJoined(res, mode, session);
    });
  }

  function resumeSession() {
    sendJoin(state.session, 'rejoin');
  }

  function onJoinFailed(res, mode) {
    const message = typeof res.message === 'string' ? res.message : 'Gagal bergabung ke ruang.';
    if (mode === 'rejoin') {
      // Gagal sementara (timeout / rate limit) → coba lagi; gagal permanen (nama diambil, kode salah, dll.) → ke layar masuk.
      if ((res.code === 'TIMEOUT' || res.code === 'RATE_LIMIT') && socket.connected) {
        clearTimeout(conn.retryTimer);
        conn.retryTimer = setTimeout(() => {
          if (socket.connected && state.session && !state.joined && !state.joining) resumeSession();
        }, 2000);
        return;
      }
      if (res.code === 'LOCKED') startLock(res.retryAfterMs);
      return returnToLogin(`Tidak bisa masuk kembali: ${message}`, 'error');
    }
    switch (res.code) {
      case 'LOCKED':
        return startLock(res.retryAfterMs);
      case 'BAD_CODE':
      case 'CODE_REQUIRED':
        dom.inputCode.select();
        return showLoginMessage(message, 'error', dom.inputCode);
      case 'INVALID_NAME':
      case 'RESERVED_NAME':
      case 'NAME_TAKEN':
        return showLoginMessage(message, 'error', dom.inputName);
      default:
        return showLoginMessage(message, 'error');
    }
  }

  function applyRoomChrome(room) {
    dom.roomTitle.textContent = room.name;
    dom.roomTopic.textContent = room.topic;
    dom.sideRoomName.textContent = room.name;
    dom.sideRoomTopic.textContent = room.topic;
    dom.roomBadge.dataset.access = room.access;
    dom.roomBadge.textContent = room.access === 'private' ? 'Privat' : 'Publik';
    dom.accessIcons.forEach((ic) => {
      if (!ic.closest('#room-trigger') && !ic.closest('#room-list')) ic.toggleAttribute('hidden', ic.dataset.accessIcon !== room.access);
    });
  }

  function onJoined(res, mode, session) {
    state.me = res.me;
    state.room = res.room;
    // Kode akses disimpan di memori HANYA agar bisa bergabung ulang otomatis setelah server restart.
    state.session = { name: res.me.name, roomId: res.room.id, code: res.room.access === 'private' ? session.code || '' : '' };
    state.joined = true;
    dom.inputCode.value = ''; // tidak membiarkan kode tergeletak di kolom input
    clearLoginMessage();

    if (mode !== 'rejoin') {
      resetStream();
      clearRemoteTyping();
    }

    applyRoomChrome(res.room);
    dom.meName.textContent = res.me.name;
    dom.meAvatar.className = `avatar av-${avatarIndex(res.me.uid)}`;
    dom.meAvatar.textContent = initials(res.me.name);
    document.title = `${res.room.name} · GIN-Sync`;

    const history = Array.isArray(res.history) ? res.history.filter(isValidMessage) : [];
    if (mode !== 'rejoin' && history.length > 0) {
      appendSystem(`Riwayat ${history.length} pesan terakhir`, 'info', history[0].ts);
    }
    history.forEach((m) => appendMessage(m, { fromHistory: true }));

    if (mode === 'rejoin') appendSystem('Tersambung kembali ke ruangan', 'info', Date.now());
    else appendSystem(`Anda masuk sebagai ${res.me.name}`, 'join', Date.now());

    renderUsers(res.users);
    showChat();
    closeDrawer();
    scrollToBottom();
    updateControls();
    if (mode !== 'rejoin' || document.activeElement === document.body) dom.inputMessage.focus({ preventScroll: true });
  }

  function returnToLogin(message, tone) {
    stopLocalTyping(false);
    clearRemoteTyping();
    state.session = null;
    state.me = null;
    state.room = null;
    state.joined = false;
    state.token = null;
    dom.inputCode.value = '';
    resetStream();
    closeDrawer();
    dom.viewChat.hidden = true;
    dom.viewLogin.hidden = false;
    document.title = 'GIN-Sync · Portal Diskusi Mahasiswa';
    clearLoginMessage();
    if (message) showLoginMessage(message, tone);
    updateControls();
    if (dom.inputName.value) dom.btnJoin.focus();
    else dom.inputName.focus();
  }

  function showChat() {
    dom.viewLogin.hidden = true;
    dom.viewChat.hidden = false;
  }

  dom.btnLeave.addEventListener('click', () => {
    stopLocalTyping(false);
    const roomName = state.room ? state.room.name : 'ruangan';
    if (socket.connected) socket.emit('session:leave', {}, () => {});
    dom.inputName.value = state.me ? state.me.name : '';
    returnToLogin(`Anda keluar dari ${roomName}. Pilih ruang lain atau masuk kembali.`, 'info');
  });

  /* ───────────── Render pesan ───────────── */
  function rememberId(id) {
    state.seen.add(id);
    if (state.seen.size > MAX_SEEN_IDS) state.seen.delete(state.seen.values().next().value);
  }

  function isNearBottom() {
    const s = dom.stream;
    return s.scrollHeight - s.scrollTop - s.clientHeight < NEAR_BOTTOM_PX;
  }

  /** Scroll programatik dibuat instan (bukan smooth) agar tidak ada posisi "di tengah jalan"
   *  yang membuat pesan beruntun (burst) salah dianggap "pengguna sedang membaca riwayat". */
  function scrollToBottom() {
    state.following = true;
    setUnread(0);
    dom.stream.scrollTop = dom.stream.scrollHeight;
    requestAnimationFrame(() => {
      dom.stream.scrollTop = dom.stream.scrollHeight; // ulangi setelah layout selesai
    });
  }

  function setUnread(n) {
    state.unread = n;
    dom.latestCount.textContent = String(n);
    dom.btnLatest.hidden = n === 0;
  }

  function trimStream() {
    while (dom.messages.childElementCount > MAX_DOM_MESSAGES) dom.messages.firstElementChild.remove();
  }

  /** Menyisipkan pemisah "Hari ini / Kemarin / tanggal" bila hari berganti. */
  function ensureDayDivider(ts) {
    const key = dayKey(ts);
    if (state.lastDay === key) return;
    state.lastDay = key;
    const li = el('li', 'day');
    li.appendChild(el('span', null, dayLabel(ts)));
    dom.messages.appendChild(li);
  }

  /** Pesan chat: kelas `msg--mine` (pengirim) vs `msg--theirs` (penerima) menentukan tampilan. */
  function appendMessage(msg, opts) {
    if (state.seen.has(msg.id)) return;
    rememberId(msg.id);

    const fromHistory = Boolean(opts && opts.fromHistory);
    const mine = Boolean(state.me) && msg.uid === state.me.uid;
    ensureDayDivider(msg.ts);
    const grouped =
      state.lastMsg !== null &&
      state.lastMsg.uid === msg.uid &&
      msg.ts >= state.lastMsg.ts &&
      msg.ts - state.lastMsg.ts < GROUP_WINDOW_MS;

    const li = el('li', `msg ${mine ? 'msg--mine' : 'msg--theirs'} av-${avatarIndex(msg.uid)}${grouped ? ' msg--cont' : ''}`);
    li.dataset.id = msg.id;

    if (!mine) li.appendChild(makeAvatar(msg.uid, msg.name, grouped ? 'avatar--ghost' : ''));

    const col = el('div', 'msg__col');
    if (!mine && !grouped) col.appendChild(el('span', 'msg__name', msg.name));
    const bubble = el('div', 'msg__bubble');
    bubble.appendChild(el('p', 'msg__text', msg.text)); // ← textContent: HTML/skrip tampil sebagai teks
    const time = el('time', 'msg__time', formatTime(msg.ts));
    time.dateTime = new Date(msg.ts).toISOString();
    bubble.appendChild(time);
    col.appendChild(bubble);
    li.appendChild(col);

    dom.messages.appendChild(li);
    state.lastMsg = { uid: msg.uid, ts: msg.ts };
    trimStream();

    if (fromHistory) return;
    if (mine || state.following) scrollToBottom();
    else setUnread(state.unread + 1);
    notifyTitle(mine);
  }

  /** Pesan sistem (join/leave/info) di tengah layar. */
  function appendSystem(text, kind, ts) {
    const safeKind = kind === 'join' || kind === 'leave' ? kind : 'info';
    ensureDayDivider(ts);
    const li = el('li', `sys sys--${safeKind}`);
    const pill = el('span', 'sys__text');
    pill.appendChild(document.createTextNode(text));
    pill.appendChild(el('time', 'sys__time', formatTime(ts)));
    li.appendChild(pill);
    dom.messages.appendChild(li);
    state.lastMsg = null;
    trimStream();
    if (state.following) scrollToBottom();
  }

  function resetStream() {
    dom.messages.replaceChildren();
    state.seen.clear();
    state.lastMsg = null;
    state.lastDay = null;
    setUnread(0);
  }

  dom.stream.addEventListener('scroll', () => {
    state.following = isNearBottom();
    if (state.following && state.unread > 0) setUnread(0);
  }, { passive: true });
  dom.btnLatest.addEventListener('click', () => scrollToBottom());

  // Jika ukuran area percakapan berubah (banner koneksi muncul, papan ketik mobile, rotasi layar)
  // dan pengguna sedang mengikuti percakapan, tetap tempel di dasar.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (state.following) dom.stream.scrollTop = dom.stream.scrollHeight;
    }).observe(dom.stream);
  }

  // Judul tab menampilkan jumlah pesan baru saat tab tidak aktif
  function notifyTitle(mine) {
    if (!document.hidden || mine || !state.room) return;
    state.titleUnread += 1;
    document.title = `(${state.titleUnread}) ${state.room.name} · GIN-Sync`;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.room) {
      state.titleUnread = 0;
      document.title = `${state.room.name} · GIN-Sync`;
    }
  });

  /* ───────────── Pengguna online ───────────── */
  function renderUsers(list) {
    const users = (Array.isArray(list) ? list : [])
      .filter((u) => u && typeof u.uid === 'string' && typeof u.name === 'string')
      .map((u) => ({ uid: u.uid, name: u.name }));
    const myUid = state.me ? state.me.uid : null;
    users.sort((a, b) => (a.uid === myUid ? -1 : b.uid === myUid ? 1 : a.name.localeCompare(b.name, 'id')));

    const frag = document.createDocumentFragment();
    users.forEach((u) => {
      const li = el('li');
      const wrap = el('span', 'avatar-wrap');
      wrap.appendChild(makeAvatar(u.uid, u.name));
      const dot = el('span', 'presence'); // titik hijau = sedang online
      dot.setAttribute('aria-hidden', 'true');
      wrap.appendChild(dot);
      li.appendChild(wrap);
      li.appendChild(el('span', 'roster__name', u.name));
      if (u.uid === myUid) li.appendChild(el('span', 'roster__tag', 'Anda'));
      frag.appendChild(li);
    });
    if (users.length === 0) frag.appendChild(el('li', 'roster__empty', 'Belum ada yang online.'));
    dom.userList.replaceChildren(frag);
    dom.userCount.textContent = String(users.length);
  }

  /* ───────────── Drawer (layar kecil) ───────────── */
  function openDrawer() {
    dom.sidebar.classList.add('is-open');
    dom.backdrop.hidden = false;
    dom.btnDrawer.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    dom.sidebar.classList.remove('is-open');
    dom.backdrop.hidden = true;
    dom.btnDrawer.setAttribute('aria-expanded', 'false');
  }
  dom.btnDrawer.addEventListener('click', openDrawer);
  dom.btnCloseDrawer.addEventListener('click', closeDrawer);
  dom.backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  /* ───────────── Indikator mengetik ───────────── */
  function setRemoteTyping(uid, name) {
    const existing = state.typingRemote.get(uid);
    if (existing) clearTimeout(existing.timer);
    // Pengaman: jika sinyal "berhenti" hilang di jaringan, indikator tetap padam sendiri.
    const timer = setTimeout(() => dropRemoteTyping(uid), TYPING_EXPIRE_MS);
    state.typingRemote.set(uid, { name, timer });
    renderTyping();
  }
  function dropRemoteTyping(uid) {
    const existing = state.typingRemote.get(uid);
    if (!existing) return;
    clearTimeout(existing.timer);
    state.typingRemote.delete(uid);
    renderTyping();
  }
  function clearRemoteTyping() {
    state.typingRemote.forEach((v) => clearTimeout(v.timer));
    state.typingRemote.clear();
    renderTyping();
  }
  function renderTyping() {
    const names = Array.from(state.typingRemote.values()).map((v) => v.name);
    let text = '';
    if (names.length === 1) text = `${names[0]} sedang mengetik…`;
    else if (names.length === 2) text = `${names[0]} dan ${names[1]} sedang mengetik…`;
    else if (names.length > 2) text = `${names[0]}, ${names[1]}, dan ${names.length - 2} lainnya sedang mengetik…`;
    dom.typingText.textContent = text;
    dom.typing.classList.toggle('is-active', names.length > 0);
  }

  function emitTyping(isTyping) {
    if (!socket.connected || !state.joined) return;
    socket.volatile.emit('typing', isTyping); // volatile: dibuang bila offline, tidak ditumpuk
  }
  function stopLocalTyping(notify) {
    clearTimeout(state.typingTimer);
    if (state.typingActive && notify !== false) emitTyping(false);
    state.typingActive = false;
  }
  function onLocalTyping() {
    if (dom.inputMessage.value.trim() === '') return stopLocalTyping(true);
    const now = Date.now();
    if (!state.typingActive || now - state.typingLastEmit > TYPING_KEEPALIVE_MS) {
      emitTyping(true);
      state.typingActive = true;
      state.typingLastEmit = now;
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => stopLocalTyping(true), TYPING_IDLE_MS);
  }

  /* ───────────── Penulis pesan ───────────── */
  function autoGrow() {
    const t = dom.inputMessage;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
    if (state.following) dom.stream.scrollTop = dom.stream.scrollHeight;
  }

  function updateCounter() {
    const len = Array.from(dom.inputMessage.value).length;
    const show = len > MESSAGE_MAX * 0.8;
    dom.charCount.hidden = !show;
    if (show) {
      dom.charCount.textContent = `${len}/${MESSAGE_MAX}`;
      dom.charCount.dataset.warn = String(len >= MESSAGE_MAX);
    }
  }

  dom.inputMessage.addEventListener('input', () => {
    autoGrow();
    updateCounter();
    updateControls();
    onLocalTyping();
  });

  dom.inputMessage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  dom.inputMessage.addEventListener('blur', () => stopLocalTyping(true));

  dom.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  function sendMessage() {
    const text = dom.inputMessage.value.replace(/\r\n?/g, '\n').trim();
    if (!text || state.sending) return;
    if (!socket.connected || !state.joined) {
      toast('Belum tersambung ke server. Draf Anda tetap tersimpan.', 'error');
      return;
    }
    state.sending = true;
    updateControls();
    stopLocalTyping(true);

    socket.timeout(ACK_TIMEOUT_MS).emit('chat:message', { text }, (err, res) => {
      state.sending = false;
      if (err) {
        toast('Server tidak merespons. Pesan belum terkirim; draf Anda masih ada.', 'error');
      } else if (!res || res.ok !== true) {
        toast((res && res.message) || 'Pesan ditolak server.', 'error');
      } else {
        dom.inputMessage.value = ''; // dikosongkan HANYA setelah server mengonfirmasi (tidak ada pesan hilang)
        autoGrow();
        updateCounter();
      }
      updateControls();
      dom.inputMessage.focus({ preventScroll: true });
    });
  }

  /* ───────────── Inisialisasi ───────────── */
  renderPicker();
  setStatus('connecting');
  showBanner('connecting', 'Menghubungkan ke server…');
  dom.inputName.focus();
})();
