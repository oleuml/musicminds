'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PLAYLISTS_CSV_URL =
  'https://raw.githubusercontent.com/oleuml/musicminds-hitster-playlists/main/playlists.csv';
const HITSTER_HOST = 'hitstergame.com';

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
  $('btn-back').hidden = name === 'home';
  $('btn-reveal').hidden = name !== 'play';
  placeStage();
  if (name === 'play') requestWakeLock(); else releaseWakeLock();
}
const setStatus = (t) => { $('home-status').textContent = t || ''; };

// ---------------------------------------------------------------------------
// Wake lock (keeps the screen on, so the song isn't cut off by auto-lock)
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
//   'loading' – video requested with autoplay
//   'blocked' – the browser refused to autoplay (iOS without a prior tap):
//               the user taps the circle, which lands in the iframe and starts it
//   'ready'   – playing or paused
//   'ended'   – song finished
// After one tap in the player, iOS lets later rounds autoplay.
const AUTOPLAY_TIMEOUT_MS = 2500;
let player = null;
let playerReady = false;
let pendingVideoId = null;
let autoplayTimer = 0;
const round = { phase: 'idle', card: null, playing: false };

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
        if (pendingVideoId) { load(pendingVideoId); pendingVideoId = null; }
      },
      onStateChange: onPlayerState,
      onError: async (e) => {
        clearTimeout(autoplayTimer);
        if (round.phase === 'idle') return;
        // The embed answers 150 both for "embedding forbidden" and for deleted videos,
        // so ask oEmbed whether the video still exists: gone -> search for the song,
        // otherwise open the video in YouTube itself.
        const id = round.videoId;
        const missing = e.data === 2 || e.data === 100 || !(await videoExists(id));
        if (round.phase === 'idle' || round.videoId !== id) return; // moved on meanwhile
        showFallback(missing ? 'missing' : 'blocked', `YouTube error ${e.data}`);
      },
    },
  });
};

// oEmbed: 200 = embeddable, 401/403 = exists but not embeddable/private,
// 400/404 = no such video. On network trouble assume it exists.
async function videoExists(id) {
  try {
    const url = 'https://www.youtube.com/watch?v=' + id;
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
    return !(res.status === 400 || res.status === 404);
  } catch {
    return true;
  }
}

// Load and start right away; fall back to "tap to play" if autoplay is refused.
function load(videoId) {
  if (!playerReady) { pendingVideoId = videoId; return; }
  player.unMute();
  player.loadVideoById(videoId);
  clearTimeout(autoplayTimer);
  autoplayTimer = setTimeout(checkAutoplay, AUTOPLAY_TIMEOUT_MS);
}

// Still not playing after the timeout? While YouTube keeps buffering (slow network,
// waiting for an ad) look again later. If it fell back to UNSTARTED, the browser
// refused to autoplay (iOS without a tap in the player): offer "tap to play".
function checkAutoplay() {
  if (round.phase !== 'loading') return;
  if (round.ytState === YT.PlayerState.BUFFERING) {
    autoplayTimer = setTimeout(checkAutoplay, 1000);
    return;
  }
  round.phase = 'blocked';
  renderPlay();
}

function onPlayerState(e) {
  const S = YT.PlayerState;
  if (round.phase === 'idle') return;
  round.ytState = e.data;
  if (e.data === S.PLAYING) {
    round.playingSince = performance.now();
    clearTimeout(autoplayTimer);
    round.phase = 'ready';
    round.playing = true; // wanted; audible is decided by the progress watcher
  } else if (e.data === S.PAUSED) {
    round.playing = false;
    resetProgress();
  } else if (e.data === S.ENDED) {
    round.playing = false;
    round.phase = 'ended';
    resetProgress();
  }
  renderPlay();
}

function play() { if (playerReady) { player.unMute(); player.playVideo(); } }
function pause() { if (playerReady) player.pauseVideo(); }

// YouTube reports PLAYING before anything is heard (e.g. while an ad, or a blocked
// ad, is being waited out). The song only counts as audible once its playback
// position actually moves; a stall of STALL_TICKS ticks shows the spinner again.
const PROGRESS_TICK_MS = 250;
const STALL_TICKS = 3;
const progress = { lastTime: null, stalled: 0 };
function resetProgress() {
  progress.lastTime = null;
  progress.stalled = 0;
  round.audible = false;
}
setInterval(() => {
  if (currentView !== 'play') return;
  if (!playerReady || round.phase !== 'ready' || !round.playing) {
    if (round.audible) resetProgress();
    progress.lastTime = null;
  } else {
    const t = player.getCurrentTime() || 0;
    const moved = progress.lastTime !== null && t > progress.lastTime + 0.05;
    progress.lastTime = t;
    if (moved) { progress.stalled = 0; round.audible = true; }
    else if (++progress.stalled >= STALL_TICKS) round.audible = false;
  }
  renderPlay();
}, PROGRESS_TICK_MS);

// The IFrame API has no ad events. While an ad runs, YouTube reports PLAYING but the
// song's own position stays put; after AD_AFTER_MS of that we call it an ad.
const AD_AFTER_MS = 1500;
// Waiting this long without sound gets an extra hint.
const LONG_WAIT_MS = 15000;
function adLikely() {
  return round.ytState === YT.PlayerState.PLAYING && !round.audible
    && performance.now() - round.playingSince > AD_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Play view
// ---------------------------------------------------------------------------
function startRound(card) {
  const id = videoIdFrom(card.url);
  if (!id && !(card.artist || card.title)) {
    toast('Not a YouTube link: ' + card.url); show('home'); return;
  }
  Object.assign(round, {
    phase: 'loading', card, videoId: id, playing: false, ytState: null, playingSince: 0, waitingSince: 0,
  });
  resetProgress();
  setRevealed(false);
  hideFallback();
  show('play');
  renderPlay();
  if (id) load(id);
  else showFallback('missing', 'No YouTube link for this card');
}

// ---------------------------------------------------------------------------
// Fallback when the song can't play in the app
// ---------------------------------------------------------------------------
// The dialog never shows the song: whoever sits out the round opens it in YouTube.
function showFallback(kind, detail) {
  const c = round.card || {};
  const query = [c.artist, c.title].filter(Boolean).join(' ');
  let title, text, label, href;
  if (kind === 'blocked' && round.videoId) {
    title = "Can't play this song here";
    text = "YouTube doesn't allow this video inside the app. Open it on YouTube and play it for the group.";
    label = 'Open on YouTube';
    href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(round.videoId);
  } else if (query) {
    title = 'Song not found';
    text = "The video for this card isn't on YouTube anymore. Search for the song on YouTube and play it for the group.";
    label = 'Search on YouTube';
    href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
  } else {
    title = "Can't play this song here";
    text = 'Open the link from this card and play it for the group.';
    label = 'Open link';
    href = c.url;
  }
  $('fallback-title').textContent = title;
  $('fallback-text').textContent = detail ? `${text} (${detail})` : text;
  $('fallback-link').textContent = label;
  $('fallback-link').href = href;
  $('fallback').hidden = false;
  round.phase = 'external';
  round.playing = false;
  renderPlay();
}
function hideFallback() { $('fallback').hidden = true; }
$('fallback-close').addEventListener('click', hideFallback);
// Leaving for YouTube: close it, so the game is there when they come back.
$('fallback-link').addEventListener('click', () => setTimeout(hideFallback, 300));

function renderPlay() {
  if (currentView !== 'play') return;
  const { phase, playing, audible } = round;
  // Spinner while loading, and while playback is wanted but nothing is heard yet.
  const waiting = phase === 'loading' || (phase === 'ready' && playing && !audible);
  const now = performance.now();
  if (waiting && !round.waitingSince) round.waitingSince = now;
  if (!waiting) round.waitingSince = 0;
  const ad = waiting && playerReady && adLikely();
  const longWait = waiting && now - round.waitingSince > LONG_WAIT_MS;

  const stage = $('stage');
  stage.classList.toggle('waiting', waiting);
  stage.classList.toggle('ad', ad);
  stage.classList.toggle('playing', phase === 'ready' && playing && audible);
  stage.classList.toggle('visible', phase !== 'idle');

  let waitText = 'Loading…';
  if (ad) waitText = 'Ad playing – your song starts right after';
  else if (longWait) waitText = isIOS() ? 'Still loading… On iPhone and iPad, use Safari.' : 'Still loading…';
  const states = {
    loading: [waitText, ''],
    blocked: ['Tap the circle to start', 'Tap to play'],
    ready: !playing ? ['Paused', '▶'] : audible ? ['Playing', '♪'] : [waitText, ad ? 'Ad' : ''],
    ended: ['Song finished', '✓'],
    external: ['Play it on YouTube', '↗'],
  };
  const [hint, label] = states[phase] || ['', ''];
  $('play-hint').textContent = hint;
  $('shield-label').textContent = label;

  const toggle = $('btn-toggle');
  toggle.hidden = phase !== 'ready';
  toggle.textContent = playing ? 'Pause' : 'Play';
}

$('btn-toggle').addEventListener('click', () => {
  if (round.playing) pause(); else play();
});

// Reveal toggles: tap again to hide the answer.
function setRevealed(on) {
  if (on) {
    const c = round.card || {};
    let title = c.title, artist = c.artist;
    if (!title && playerReady) {
      const d = player.getVideoData();
      title = d.title; artist = d.author;
    }
    $('reveal-year').textContent = c.year || '';
    $('reveal-title').textContent = title || 'Unknown';
    $('reveal-artist').textContent = artist || '';
  }
  $('reveal').hidden = !on;
  $('btn-reveal').textContent = on ? 'Hide' : 'Reveal';
  $('btn-reveal').setAttribute('aria-pressed', String(on));
  placeStage();
}
$('btn-reveal').addEventListener('click', () => setRevealed($('reveal').hidden));

// Back (top left): leave the current screen for home; on the play screen this ends the round.
$('btn-back').addEventListener('click', () => {
  if (currentView === 'play') {
    clearTimeout(autoplayTimer);
    hideFallback();
    round.phase = 'idle';
    pause();
  }
  setStatus('');
  show('home');
});

$('btn-next').addEventListener('click', () => {
  clearTimeout(autoplayTimer);
  hideFallback();
  round.phase = 'idle';
  pause();
  startScan();
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

$('btn-scan').addEventListener('click', startScan);

// Surface unexpected errors on screen (no dev tools on the phone).
window.addEventListener('error', (e) => toast('Error: ' + e.message, 6000));
window.addEventListener('unhandledrejection', (e) => toast('Error: ' + (e.reason?.message || e.reason), 6000));

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

// ---------------------------------------------------------------------------
// PWA
// ---------------------------------------------------------------------------
// A new deploy installs a new service worker that waits; offer to switch to it.
// Never reload in the middle of a round, so the banner only acts on a tap.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const offerUpdate = (worker) => {
    $('update-banner').hidden = false;
    $('btn-update').onclick = () => worker.postMessage('SKIP_WAITING');
  };
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        // Only an update if a previous version controls the page (not the first install).
        if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
      });
    });
    // Installed PWAs stay open for a long time: look for updates when they come back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Brave recommendation (YouTube ads are blocked there)
// ---------------------------------------------------------------------------
const BRAVE_TIP_KEY = 'mm.braveTipDismissed';

// On iPhone/iPad only Safari plays reliably; Brave's ad blocking can stall the
// embedded player there, so don't recommend it on iOS.
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
}

// Brave exposes navigator.brave.isBrave(); other browsers don't.
async function isBrave() {
  try {
    return !!(navigator.brave && await navigator.brave.isBrave());
  } catch {
    return false;
  }
}

(async () => {
  let dismissed = false;
  try { dismissed = localStorage.getItem(BRAVE_TIP_KEY) === '1'; } catch { /* storage blocked */ }
  if (dismissed || isIOS() || await isBrave()) return;
  $('brave-tip').hidden = false;
})();

$('brave-tip-dismiss').addEventListener('click', () => {
  $('brave-tip').hidden = true;
  try { localStorage.setItem(BRAVE_TIP_KEY, '1'); } catch { /* storage blocked */ }
});

show('home');
