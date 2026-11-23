'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PLAYLISTS_CSV_URL =
  'https://raw.githubusercontent.com/oleuml/musicminds-hitster-playlists/main/playlists.csv';
const HITSTER_HOST = 'hitstergame.com';

// Face-down detection. normalZ is the z-component of the screen normal:
// +1 = screen up, -1 = screen down. Hysteresis avoids flapping at the edge.
const FACE_DOWN_ENTER = -0.8;
const FACE_DOWN_LEAVE = -0.6;
// Linear acceleration (m/s², gravity removed) above which the phone counts as moved.
const MOTION_THRESHOLD = 2.5;
// The phone must lie still and face down this long before playback (re)starts.
const SETTLE_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function normalizeKey(code) {
  return code.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

// Same rules as composeApp db/CsvParser.kt
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const values = parseCsvLine(l);
    const row = {};
    header.forEach((h, i) => { row[h] = values[i]; });
    return row;
  });
}

function videoIdFrom(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s.includes('://') ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  if (host === 'youtu.be') return u.pathname.split('/')[1] || null;
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (u.searchParams.get('v')) return u.searchParams.get('v');
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Card store (localStorage; falls back to memory if storage is unavailable)
// ---------------------------------------------------------------------------
const STORE_KEY = 'mm.store.v1';
const store = (() => {
  let data = { bundles: {}, cards: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) data = JSON.parse(raw);
  } catch { /* private mode etc. */ }
  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch { toast('Could not save bundles on this device'); }
  };
  return {
    get: (key) => {
      const c = data.cards[normalizeKey(key)];
      return c && { url: c[0], artist: c[1], title: c[2], year: c[3] };
    },
    hasBundle: (id) => !!data.bundles[id],
    bundles: () => data.bundles,
    addBundle(id, name, rows) {
      let n = 0;
      for (const r of rows) {
        if (!r.qr_code_value || !r.youtube_url) continue;
        data.cards[normalizeKey(r.qr_code_value)] =
          [r.youtube_url, r.artist || '', r.title || '', r.release_year || '', id];
        n++;
      }
      data.bundles[id] = { name, count: n };
      save();
    },
    removeBundle(id) {
      for (const [k, c] of Object.entries(data.cards)) if (c[4] === id) delete data.cards[k];
      delete data.bundles[id];
      save();
    },
  };
})();

let playlistsCache = null;
async function fetchPlaylists() {
  if (playlistsCache) return playlistsCache;
  const res = await fetch(PLAYLISTS_CSV_URL);
  if (!res.ok) throw new Error('Could not load bundle list');
  const base = PLAYLISTS_CSV_URL.slice(0, PLAYLISTS_CSV_URL.lastIndexOf('/') + 1);
  playlistsCache = parseCsv(await res.text()).map((r) => ({
    id: r.bundle_id, name: r.game_title, url: base + r.file,
  }));
  return playlistsCache;
}

async function downloadBundle(p) {
  const res = await fetch(p.url);
  if (!res.ok) throw new Error('Download failed: ' + p.name);
  store.addBundle(p.id, p.name, parseCsv(await res.text()));
}

// For an unknown Hitster code, guess the bundle from the URL path and download it.
// www.hitstergame.com/de/aaaa0007/00001 -> de/aaaa0007
// www.hitstergame.com/de/00001          -> some de/* bundle (try each until found)
async function autoImportFor(key) {
  const path = key.split('/').slice(1);
  if (path.length < 2) return false;
  const lists = await fetchPlaylists();
  const candidates = path.length >= 3
    ? lists.filter((p) => p.id === `${path[0]}/${path[1]}`)
    : lists.filter((p) => p.id.startsWith(path[0] + '/'));
  for (const p of candidates) {
    if (store.hasBundle(p.id)) continue;
    setStatus(`Downloading “${p.name}”…`);
    await downloadBundle(p);
    if (store.get(key)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const views = ['home', 'scan', 'bundles', 'play'];
let currentView = 'home';
function show(name) {
  currentView = name;
  for (const v of views) $('view-' + v).hidden = v !== name;
  if (name !== 'scan') stopCamera();
  placeStage();
  if (name === 'play') requestWakeLock(); else releaseWakeLock();
}
const setStatus = (t) => { $('home-status').textContent = t || ''; };

// ---------------------------------------------------------------------------
// Sensors (orientation + motion)
// ---------------------------------------------------------------------------
const sensors = {
  available: false, // set once a real orientation event arrives
  faceDown: false,
  faceDownSince: 0,
  lastMoveAt: 0,
};

// Must be called synchronously from a user gesture (iOS permission prompt).
// Resolves once the prompt is answered, so the camera prompt doesn't collide with it.
let sensorPermissionAsked = false;
function requestSensorPermission() {
  if (sensorPermissionAsked) return Promise.resolve();
  sensorPermissionAsked = true;
  const reqs = [];
  for (const E of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
    if (E && typeof E.requestPermission === 'function') reqs.push(E.requestPermission());
  }
  return Promise.all(reqs)
    .then((r) => { if (r.some((s) => s !== 'granted')) throw new Error(); })
    .catch(() => toast('No motion access – use “Play without flipping”'));
}

window.addEventListener('deviceorientation', (e) => {
  if (e.beta == null || e.gamma == null) return;
  sensors.available = true;
  const rad = Math.PI / 180;
  const normalZ = Math.cos(e.beta * rad) * Math.cos(e.gamma * rad);
  const now = performance.now();
  if (!sensors.faceDown && normalZ < FACE_DOWN_ENTER) {
    sensors.faceDown = true;
    sensors.faceDownSince = now;
  } else if (sensors.faceDown && normalZ > FACE_DOWN_LEAVE) {
    sensors.faceDown = false;
  }
});

window.addEventListener('devicemotion', (e) => {
  let mag;
  const a = e.acceleration;
  if (a && a.x != null) {
    mag = Math.hypot(a.x, a.y, a.z);
  } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
    const g = e.accelerationIncludingGravity;
    mag = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
  } else return;
  if (mag > MOTION_THRESHOLD) sensors.lastMoveAt = performance.now();
});

// ---------------------------------------------------------------------------
// Wake lock (keeps the page alive while the phone lies face down)
// ---------------------------------------------------------------------------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentView === 'play') requestWakeLock();
});

// ---------------------------------------------------------------------------
// YouTube player
// ---------------------------------------------------------------------------
// Phases of a round:
//   'arm'   – video cued & muted; the user taps the circle (lands in the iframe),
//             which counts as user-initiated playback on iOS.
//   'armed' – playback unlocked; sensors (or the manual button) start/pause it.
//   'ended' – song finished.
let player = null;
let playerReady = false;
let pendingVideoId = null;
const round = { phase: 'idle', card: null, manual: false, playing: false };

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('yt-player', {
    width: 260, height: 260,
    playerVars: {
      playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        playerReady = true;
        if (pendingVideoId) { cue(pendingVideoId); pendingVideoId = null; }
      },
      onStateChange: onPlayerState,
      onError: (e) => {
        const reasons = {
          2: 'invalid video ID',
          5: 'HTML5 player error',
          100: 'video not found or private',
          101: 'owner does not allow embedding',
          150: 'owner does not allow embedding',
          152: 'embedding blocked',
          153: 'player configuration error (missing referrer/origin)',
        };
        toast(`YouTube error ${e.data}: ${reasons[e.data] || 'unknown'}`, 8000);
        round.phase = 'ended';
        renderPlay();
      },
    },
  });
};

function cue(videoId) {
  if (!playerReady) { pendingVideoId = videoId; return; }
  player.mute();
  player.cueVideoById(videoId);
}

function onPlayerState(e) {
  const S = YT.PlayerState;
  if (e.data === S.PLAYING) {
    if (round.phase === 'arm') {
      // The user's tap started the (muted) video: stop it, rewind, unmute. From now on
      // the page may start it programmatically.
      player.pauseVideo();
      player.seekTo(0, true);
      player.unMute();
      round.phase = 'armed';
      round.playing = false;
      renderPlay();
      return;
    }
    round.playing = true;
  } else if (e.data === S.PAUSED || e.data === S.BUFFERING) {
    if (e.data === S.PAUSED) round.playing = false;
  } else if (e.data === S.ENDED) {
    round.playing = false;
    round.phase = 'ended';
  }
  renderPlay();
}

function play() { if (playerReady) { player.unMute(); player.playVideo(); } }
function pause() { if (playerReady) player.pauseVideo(); }

// Drive playback from the sensors.
setInterval(() => {
  if (currentView !== 'play' || round.phase !== 'armed' || round.manual) return;
  if (!sensors.available) return;
  const now = performance.now();
  const shouldPlay = sensors.faceDown
    && now - sensors.faceDownSince > SETTLE_MS
    && now - sensors.lastMoveAt > SETTLE_MS;
  // Act on the intent, not the reported state, so a lift pauses immediately.
  if (shouldPlay && !round.wantPlay) { round.wantPlay = true; play(); }
  else if (!shouldPlay && round.wantPlay) { round.wantPlay = false; pause(); }
}, 100);

// ---------------------------------------------------------------------------
// Play view
// ---------------------------------------------------------------------------
function startRound(card) {
  const id = videoIdFrom(card.url);
  if (!id) { toast('Not a YouTube link: ' + card.url); show('home'); return; }
  Object.assign(round, { phase: 'arm', card, manual: false, playing: false, wantPlay: false });
  $('reveal').hidden = true;
  cue(id);
  show('play');
  renderPlay();
}

function renderPlay() {
  if (currentView !== 'play') return;
  const { phase, playing, manual } = round;
  const stage = $('stage');
  const label = $('shield-label');
  stage.classList.toggle('playing', playing);
  stage.classList.toggle('visible', phase !== 'idle');

  let hint;
  if (phase === 'arm') {
    hint = 'Tap the circle, then flip the phone face down';
    label.textContent = 'Tap to arm';
  } else if (phase === 'armed') {
    if (manual) hint = playing ? 'Playing' : 'Paused';
    else if (!sensors.available) hint = 'No motion sensor – use the button below';
    else hint = playing ? 'Playing – pick it up to pause' : 'Flip the phone face down to play';
    label.textContent = playing ? '♪' : (manual ? '❚❚' : 'Flip me');
  } else if (phase === 'ended') {
    hint = 'Song finished';
    label.textContent = '✓';
  }
  $('play-hint').textContent = hint || '';

  const manualBtn = $('btn-manual-play');
  manualBtn.hidden = phase !== 'armed';
  manualBtn.textContent = manual ? (playing ? 'Pause' : 'Play') : 'Play without flipping';
}

$('btn-manual-play').addEventListener('click', () => {
  if (!round.manual) { round.manual = true; round.wantPlay = false; }
  if (round.playing) pause(); else play();
  renderPlay();
});

$('btn-reveal').addEventListener('click', () => {
  const c = round.card || {};
  let title = c.title, artist = c.artist;
  if (!title && playerReady) {
    const d = player.getVideoData();
    title = d.title; artist = d.author;
  }
  $('reveal-year').textContent = c.year || '';
  $('reveal-title').textContent = title || 'Unknown';
  $('reveal-artist').textContent = artist || '';
  $('reveal').hidden = false;
  placeStage();
});

$('btn-next').addEventListener('click', () => {
  pause();
  round.phase = 'idle';
  requestSensorPermission().then(startScan);
});

// Keep the fixed player stage on top of the spacer in the play view.
function placeStage() {
  const stage = $('stage');
  if (currentView !== 'play') {
    stage.style.left = '-9999px';
    stage.classList.remove('visible');
    return;
  }
  const r = $('play-spacer').getBoundingClientRect();
  stage.style.left = r.left + 'px';
  stage.style.top = r.top + 'px';
}
window.addEventListener('resize', placeStage);
window.addEventListener('scroll', placeStage, { passive: true });

// ---------------------------------------------------------------------------
// Code handling
// ---------------------------------------------------------------------------
async function handleCode(raw) {
  const key = normalizeKey(raw);
  let card = store.get(key);
  if (!card && key.includes(HITSTER_HOST)) {
    show('home');
    try {
      if (await autoImportFor(key)) card = store.get(key);
    } catch (e) {
      toast(e.message);
    }
    setStatus('');
  }
  if (!card && videoIdFrom(raw)) card = { url: raw.trim() };
  if (!card) {
    show('home');
    setStatus('No song found for: ' + raw);
    return;
  }
  setStatus('');
  startRound(card);
}

$('manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('manual-input').value;
  if (!v.trim()) return;
  requestSensorPermission();
  handleCode(v);
});

// ---------------------------------------------------------------------------
// QR scanner (jsQR on camera frames)
// ---------------------------------------------------------------------------
let camStream = null;
let scanTimer = 0;
const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
const SCAN_SIZE = 720; // px of the center crop handed to the decoder
const debug = (t) => { $('scan-debug').textContent = t; };

let barcodeDetector = null;
try {
  if ('BarcodeDetector' in window) barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
} catch { /* unsupported */ }

async function startScan() {
  show('scan');
  const video = $('camera');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    debug('No camera API (page must be opened via https)');
    return;
  }
  debug('Requesting camera…');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    debug('Camera error: ' + e.name + ' ' + e.message);
    return;
  }
  if (currentView !== 'scan') { stopCamera(); return; }
  video.srcObject = camStream;
  try { await video.play(); } catch (e) { debug('Video play failed: ' + e.message); }

  const decoder = barcodeDetector ? 'BarcodeDetector' : (window.jsQR ? 'jsQR' : 'NONE');
  let frames = 0;
  let busy = false;
  const tick = async () => {
    if (!camStream || busy) return;
    if (video.readyState < 2 || !video.videoWidth) { debug('Waiting for video…'); return; }
    busy = true;
    try {
      // Decode the square in the middle of the frame (where the reticle is).
      const vw = video.videoWidth, vh = video.videoHeight;
      const side = Math.min(vw, vh);
      const sx = (vw - side) / 2, sy = (vh - side) / 2;
      const size = Math.min(SCAN_SIZE, side);
      scanCanvas.width = scanCanvas.height = size;
      scanCtx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
      let text = null;
      if (barcodeDetector) {
        const codes = await barcodeDetector.detect(scanCanvas);
        text = codes[0]?.rawValue || null;
      } else if (window.jsQR) {
        const img = scanCtx.getImageData(0, 0, size, size);
        // Every other frame also try inverted (light-on-dark) codes.
        // ('onlyInvert' is broken in jsQR 1.4.0 and throws.)
        const inversion = frames % 2 ? 'attemptBoth' : 'dontInvert';
        text = jsQR(img.data, size, size, { inversionAttempts: inversion })?.data || null;
      }
      frames++;
      debug(`${decoder} · ${vw}×${vh} · frame ${frames}`);
      if (text) {
        if (navigator.vibrate) navigator.vibrate(50);
        stopCamera();
        handleCode(text);
      }
    } catch (e) {
      debug('Scan error: ' + e.message);
    } finally {
      busy = false;
    }
  };
  scanTimer = setInterval(tick, 120);
}

function stopCamera() {
  clearInterval(scanTimer);
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  $('camera').srcObject = null;
}

$('btn-scan').addEventListener('click', () => {
  requestSensorPermission().then(startScan);
});

// Surface unexpected errors on screen (no dev tools on the phone).
window.addEventListener('error', (e) => toast('Error: ' + e.message, 6000));
window.addEventListener('unhandledrejection', (e) => toast('Error: ' + (e.reason?.message || e.reason), 6000));
$('btn-scan-cancel').addEventListener('click', () => show('home'));

// ---------------------------------------------------------------------------
// Bundles view
// ---------------------------------------------------------------------------
async function renderBundles() {
  const list = $('bundle-list');
  list.textContent = 'Loading…';
  let lists;
  try { lists = await fetchPlaylists(); }
  catch (e) { list.textContent = e.message; return; }
  list.textContent = '';
  for (const p of lists) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const have = store.bundles()[p.id];
    info.innerHTML = '<span></span><small></small>';
    info.firstChild.textContent = p.name;
    info.lastChild.textContent = have ? `${p.id} · ${have.count} cards` : p.id;
    const btn = document.createElement('button');
    btn.textContent = have ? 'Remove' : 'Download';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (have) store.removeBundle(p.id); else await downloadBundle(p);
      } catch (e) { toast(e.message); }
      renderBundles();
    });
    li.append(info, btn);
    list.append(li);
  }
}
$('btn-bundles').addEventListener('click', () => { show('bundles'); renderBundles(); });
$('btn-bundles-back').addEventListener('click', () => show('home'));

// ---------------------------------------------------------------------------
// PWA
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

show('home');
