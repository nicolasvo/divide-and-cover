const STEMS = ['vocals', 'drums', 'bass', 'other'];

const $ = id => document.getElementById(id);
const drop = $('drop');
const fileInput = $('file');
const browseBtn = $('browse');
const statusEl = $('status');
const statusStage = $('status-stage');
const statusPercent = $('status-percent');
const statusBar = $('status-bar');
const statusMessage = $('status-message');
const player = $('player');
const trackName = $('track-name');
const playpause = $('playpause');
const back5 = $('back5');
const fwd5 = $('fwd5');
const seek = $('seek');
const timeLabel = $('time');
const stemList = $('stems');
const resetBtn = $('reset');
const library = $('library');
const libraryList = $('library-list');

let ctx = null;
let buffers = {};
let gains = {};
let sources = {};
let muted = {};
let volumes = {};

let playing = false;
let startCtxTime = 0;
let startOffset = 0;
let duration = 0;
let rafId = null;

const TOGGLE_BASE = 'toggle w-28 px-3 py-1.5 rounded-md border text-sm capitalize transition';
const TOGGLE_ON = 'bg-claude text-paper-50 border-claude hover:bg-claude-300';
const TOGGLE_OFF = 'bg-transparent text-stone-500 dark:text-stone-500 border-stone-300 dark:border-stone-700 hover:border-stone-500 dark:hover:border-stone-500';
const DROP_IDLE = ['border-stone-300', 'dark:border-stone-700', 'bg-white', 'dark:bg-paper-800'];
const DROP_HOT = ['border-claude', 'bg-claude/10'];

// --- drop / browse ---------------------------------------------------------

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) upload(f);
});

['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.remove(...DROP_IDLE);
    drop.classList.add(...DROP_HOT);
  }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.remove(...DROP_HOT);
    drop.classList.add(...DROP_IDLE);
  }));
drop.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0];
  if (f) upload(f);
});

// --- upload + separate -----------------------------------------------------

async function upload(file) {
  show(statusEl); hide(drop); hide(player);
  setStatus({ stage: 'uploading', percent: 0, message: file.name });

  const fd = new FormData();
  fd.append('file', file);

  let resp;
  try {
    resp = await fetch('/api/separate', { method: 'POST', body: fd });
  } catch (e) {
    return fail(`upload failed: ${e}`);
  }
  if (!resp.ok || !resp.body) {
    const err = await resp.text();
    return fail(`split failed: ${err.slice(0, 400)}`);
  }

  let done = null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done: rdone, value } = await reader.read();
    if (rdone) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }
      if (evt.event === 'progress') {
        setStatus({ stage: evt.stage, percent: evt.percent });
      } else if (evt.event === 'stage') {
        setStatus({ stage: evt.stage, percent: 0, message: evt.message });
      } else if (evt.event === 'log') {
        setStatus({ stage: evt.stage, message: evt.message });
      } else if (evt.event === 'error') {
        return fail(evt.message);
      } else if (evt.event === 'done') {
        done = evt;
      }
    }
  }
  if (!done) return fail('no result from server');

  setStatus({ stage: 'loading', percent: 100, message: 'decoding stems…' });
  await loadPlayer(done);
  refreshLibrary();
}

const STAGE_LABELS = {
  uploading: 'uploading',
  starting: 'starting demucs',
  download: 'downloading model',
  separate: 'separating stems',
  saving: 'saving stems',
  loading: 'decoding stems',
};

function setStatus({ stage, percent, message }) {
  if (stage) statusStage.textContent = STAGE_LABELS[stage] || stage;
  if (typeof percent === 'number') {
    const p = Math.max(0, Math.min(100, percent));
    statusBar.style.width = p + '%';
    statusPercent.textContent = p + '%';
  }
  if (message != null) statusMessage.textContent = message;
}

function fail(msg) {
  statusStage.textContent = 'failed';
  statusPercent.textContent = '';
  statusBar.style.width = '0%';
  statusMessage.textContent = msg;
  setTimeout(() => { hide(statusEl); show(drop); }, 4000);
}

// --- player ----------------------------------------------------------------

async function loadPlayer(data) {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();

  const decoded = await Promise.all(STEMS.map(async s => {
    const r = await fetch(data.stems[s]);
    const ab = await r.arrayBuffer();
    return [s, await ctx.decodeAudioData(ab)];
  }));

  buffers = Object.fromEntries(decoded);
  duration = buffers.vocals.duration;

  STEMS.forEach(s => {
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(ctx.destination);
    gains[s] = g;
    muted[s] = false;
    volumes[s] = 1;
  });

  trackName.textContent = data.name;
  seek.min = 0;
  seek.max = duration;
  seek.value = 0;
  setProgress(seek, 0);
  startOffset = 0;
  playing = false;
  setPlayIcon();
  updateTimeLabel(0);

  renderStems();

  hide(statusEl);
  show(player);
}

function renderStems() {
  stemList.innerHTML = '';
  STEMS.forEach(stem => {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-3 px-3 py-2.5 bg-paper-100 dark:bg-paper-900/60 rounded-lg';
    li.innerHTML = `
      <button data-stem="${stem}" class="${TOGGLE_BASE} ${TOGGLE_ON}">${stem}</button>
      <input type="range" class="vol flex-1" data-stem="${stem}" min="0" max="1" step="0.01" value="1">
    `;
    stemList.appendChild(li);
  });
  stemList.querySelectorAll('input[type=range]').forEach(v => setProgress(v, 1));
}

function setPlayIcon() {
  const span = playpause.querySelector('.material-symbols-outlined');
  if (span) span.textContent = playing ? 'pause' : 'play_arrow';
  playpause.setAttribute('aria-label', playing ? 'pause' : 'play');
}

function paintToggle(btn, on) {
  btn.className = `${TOGGLE_BASE} ${on ? TOGGLE_ON : TOGGLE_OFF}`;
  btn.dataset.on = on ? '1' : '0';
}

function play() {
  if (playing || !ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const when = ctx.currentTime + 0.05;
  startCtxTime = when;

  STEMS.forEach(s => {
    const src = ctx.createBufferSource();
    src.buffer = buffers[s];
    src.connect(gains[s]);
    src.start(when, startOffset);
    sources[s] = src;
  });

  playing = true;
  setPlayIcon();
  tick();
}

function pause() {
  if (!playing) return;
  startOffset += Math.max(0, ctx.currentTime - startCtxTime);
  STEMS.forEach(s => {
    try { sources[s].stop(); } catch (_) {}
  });
  sources = {};
  playing = false;
  setPlayIcon();
  cancelAnimationFrame(rafId);
}

function seekTo(t) {
  const wasPlaying = playing;
  if (playing) pause();
  startOffset = Math.max(0, Math.min(duration, t));
  setProgress(seek, duration ? startOffset / duration : 0);
  updateTimeLabel(startOffset);
  if (wasPlaying) play();
}

function currentTime() {
  if (playing) return startOffset + (ctx.currentTime - startCtxTime);
  return startOffset;
}

function setMuted(stem, m) {
  muted[stem] = m;
  gains[stem].gain.value = m ? 0 : volumes[stem];
}

function setVolume(stem, v) {
  volumes[stem] = v;
  if (!muted[stem]) gains[stem].gain.value = v;
}

function setProgress(input, fraction) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  input.style.setProperty('--p', pct.toFixed(2));
}

function tick() {
  if (!playing) return;
  const t = currentTime();
  if (t >= duration) {
    pause();
    startOffset = 0;
    seek.value = 0;
    setProgress(seek, 0);
    updateTimeLabel(0);
    return;
  }
  seek.value = t;
  setProgress(seek, t / duration);
  updateTimeLabel(t);
  rafId = requestAnimationFrame(tick);
}

function updateTimeLabel(t) {
  timeLabel.textContent = `${fmt(t)} / ${fmt(duration)}`;
}

function fmt(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

// --- controls --------------------------------------------------------------

playpause.addEventListener('click', () => {
  if (playing) pause(); else play();
});

back5.addEventListener('click', () => nudge(-5));
fwd5.addEventListener('click', () => nudge(5));

function nudge(seconds) {
  if (!duration) return;
  seekTo(currentTime() + seconds);
}

seek.addEventListener('input', () => seekTo(parseFloat(seek.value)));

stemList.addEventListener('click', e => {
  const btn = e.target.closest('.toggle');
  if (!btn) return;
  const on = btn.dataset.on !== '1';
  paintToggle(btn, on);
  setMuted(btn.dataset.stem, !on);
});

stemList.addEventListener('input', e => {
  if (!e.target.classList.contains('vol')) return;
  const v = parseFloat(e.target.value);
  setVolume(e.target.dataset.stem, v);
  setProgress(e.target, v);
});

resetBtn.addEventListener('click', () => {
  pause();
  buffers = {}; gains = {}; sources = {}; muted = {}; volumes = {};
  duration = 0; startOffset = 0;
  fileInput.value = '';
  hide(player); show(drop);
});

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// --- keyboard --------------------------------------------------------------

document.addEventListener('keydown', e => {
  if (player.classList.contains('hidden')) return;
  if (e.target.matches('input, button')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) pause(); else play();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    nudge(-5);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    nudge(5);
  }
});

// --- library ---------------------------------------------------------------

async function refreshLibrary() {
  let tracks = [];
  try {
    const r = await fetch('/api/tracks');
    if (r.ok) tracks = (await r.json()).tracks;
  } catch (_) {}

  if (!tracks.length) {
    hide(library);
    libraryList.innerHTML = '';
    return;
  }

  libraryList.innerHTML = '';
  for (const t of tracks) {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-2 px-3 py-2 bg-white dark:bg-paper-800 border border-stone-200 dark:border-stone-800 rounded-lg hover:border-claude/40 transition';
    li.innerHTML = `
      <button class="lib-load flex-1 text-left truncate hover:text-claude transition" data-job="${t.job_id}" data-name="${escapeAttr(t.name)}" title="${escapeAttr(t.name)}">${escapeHtml(t.name)}</button>
      <span class="text-xs text-stone-500 tabular-nums font-mono">${fmtDate(t.created_at)}</span>
      <button class="lib-del px-2 py-1 text-stone-500 hover:text-claude transition" data-job="${t.job_id}" title="delete">✕</button>
    `;
    libraryList.appendChild(li);
  }
  show(library);
}

libraryList.addEventListener('click', async e => {
  const load = e.target.closest('.lib-load');
  const del = e.target.closest('.lib-del');
  if (load) {
    const jobId = load.dataset.job;
    loadFromLibrary({ job_id: jobId, name: load.dataset.name });
    return;
  }
  if (del) {
    const jobId = del.dataset.job;
    if (!confirm('delete this track?')) return;
    try {
      await fetch(`/api/tracks/${jobId}`, { method: 'DELETE' });
    } catch (_) {}
    refreshLibrary();
  }
});

async function loadFromLibrary(item) {
  pause();
  show(statusEl); hide(drop); hide(player);
  setStatus({ stage: 'loading', percent: 100, message: item.name });
  const data = {
    job_id: item.job_id,
    name: item.name,
    stems: Object.fromEntries(STEMS.map(s => [s, `/api/stem/${item.job_id}/${s}`])),
  };
  try {
    await loadPlayer(data);
  } catch (e) {
    fail(`load failed: ${e}`);
  }
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

refreshLibrary();

// --- theme toggle ----------------------------------------------------------

const themeToggle = $('theme-toggle');

function paintThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  const span = themeToggle.querySelector('.material-symbols-outlined');
  if (span) span.textContent = isDark ? 'light_mode' : 'dark_mode';
}

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  paintThemeIcon();
});

paintThemeIcon();
