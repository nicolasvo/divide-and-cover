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
const libraryList = $('library-list');
const libraryEmpty = $('library-empty');
const libraryFilter = $('library-filter');
const libraryDialog = $('library-dialog');
const libraryDialogClose = $('library-dialog-close');
const openLibraryBtn = $('open-library');
const libraryDivider = $('library-divider');
let libraryTracks = [];
const searchDialog = $('search-dialog');
const openSearchBtn = $('open-search');
const dialogCloseBtn = $('dialog-close');
const clearSearchBtn = $('clear-search');
const searchForm = $('search-form');
const searchInput = $('q');
const searchBtn = $('search-btn');
const searchResults = $('search-results');
const searchEmpty = $('search-empty');
const searchHint = $('search-hint');
const loadMoreBtn = $('load-more');
const lyricsPane = $('lyrics-pane');
const lyricsHeader = $('lyrics-header');
const lyricsTitle = $('lyrics-title');
const lyricsArtist = $('lyrics-artist');
const lyricsEmpty = $('lyrics-empty');
const lyricsLoading = $('lyrics-loading');
const lyricsNone = $('lyrics-none');
const lyricsContent = $('lyrics-content');
const lyricsLinesEl = $('lyrics-lines');
const lyricsFollowBtn = $('lyrics-follow-btn');
const lyricsNoneSearchBtn = $('lyrics-none-search');

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

let currentJobId = null;
let lyrics = { found: false, hasSynced: false, lines: [], plain: '' };
let activeLyricIdx = -1;
let lyricsFetchId = 0;
let userScrolledLyrics = false;

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
  await runSeparation(() => fetch('/api/separate', { method: 'POST', body: formData('file', file) }));
}

function formData(key, value) {
  const fd = new FormData();
  fd.append(key, value);
  return fd;
}

async function runSeparation(makeRequest) {
  let resp;
  try {
    resp = await makeRequest();
  } catch (e) {
    return fail(`request failed: ${e}`);
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

  setStatus({ stage: 'loading', percent: 100, message: 'downloading tracks...' });
  await loadPlayer(done);
  refreshLibrary();
}

const STAGE_LABELS = {
  uploading: 'uploading',
  downloading_audio: 'downloading audio',
  starting: 'starting demucs',
  download: 'downloading model',
  separate: 'separating tracks',
  saving: 'saving tracks',
  loading: 'downloading tracks',
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

  // kick off lyrics fetch in parallel with audio decode
  currentJobId = data.job_id;
  lyricsPane.classList.remove('hidden');
  lyricsPane.classList.add('flex');
  loadLyrics(data.job_id, data.name);

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
      <button data-stem="${stem}" data-on="1" class="${TOGGLE_BASE} ${TOGGLE_ON}">${stem}</button>
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
  userScrolledLyrics = false;
  hide(lyricsFollowBtn);
  updateActiveLyric(startOffset);
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
    updateActiveLyric(0);
    return;
  }
  seek.value = t;
  setProgress(seek, t / duration);
  updateTimeLabel(t);
  updateActiveLyric(t);
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
  currentJobId = null;
  resetLyricsUI();
  lyricsPane.classList.add('hidden');
  lyricsPane.classList.remove('flex');
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
    if (r.ok) tracks = (await r.json()).tracks || [];
  } catch (_) {}
  libraryTracks = tracks;

  if (tracks.length) {
    show(openLibraryBtn);
    show(libraryDivider);
  } else {
    hide(openLibraryBtn);
    hide(libraryDivider);
  }

  if (libraryDialog.open) {
    if (!tracks.length) {
      closeLibraryDialog();
    } else {
      renderLibraryList();
    }
  }
}

function renderLibraryList() {
  const q = (libraryFilter.value || '').trim().toLowerCase();
  const filtered = q
    ? libraryTracks.filter(t => (t.name || '').toLowerCase().includes(q))
    : libraryTracks;

  libraryList.innerHTML = '';
  if (!filtered.length) {
    show(libraryEmpty);
    return;
  }
  hide(libraryEmpty);
  for (const t of filtered) {
    const li = document.createElement('li');
    li.className = 'relative overflow-hidden flex items-center gap-2 px-3 py-2 bg-white dark:bg-paper-800 rounded-lg transition';
    li.innerHTML = `
      <button class="lib-load flex-1 min-w-0 text-left truncate hover:text-claude transition" data-job="${t.job_id}" data-name="${escapeAttr(t.name)}" title="${escapeAttr(t.name)}">${escapeHtml(t.name)}</button>
      <span class="text-xs text-stone-500 tabular-nums font-mono shrink-0">${fmtDate(t.created_at)}</span>
      <button class="lib-del px-2 py-1 text-stone-500 hover:text-claude transition shrink-0" data-job="${t.job_id}" title="delete">✕</button>
      <button class="lib-confirm absolute inset-0 bg-red-500 hover:bg-red-400 text-white text-sm font-medium flex items-center justify-between px-4 gap-6 translate-x-full transition-transform duration-200" data-job="${t.job_id}" tabindex="-1" style="transition:none">
        <span class="flex-1 min-w-0 truncate text-left">${escapeHtml(t.name)}</span>
        <span class="flex items-center gap-1.5 shrink-0">
          are you sure?
          <span class="material-symbols-outlined" style="font-size:18px">delete</span>
        </span>
      </button>
    `;
    libraryList.appendChild(li);
  }
  // re-enable the slide transition only after layout has settled, so the rows
  // don't briefly animate translate-x-full when the dialog first opens
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      libraryList.querySelectorAll('.lib-confirm').forEach(b => {
        b.style.transition = '';
      });
    });
  });
}

function openLibraryDialog() {
  libraryFilter.value = '';
  renderLibraryList();
  libraryDialog.showModal();
  setTimeout(() => libraryFilter.focus(), 0);
}

function closeLibraryDialog() {
  closeAllLibConfirms();
  libraryDialog.close();
}

openLibraryBtn.addEventListener('click', openLibraryDialog);
libraryDialogClose.addEventListener('click', closeLibraryDialog);
libraryDialog.addEventListener('click', e => {
  if (e.target === libraryDialog) closeLibraryDialog();
});
libraryFilter.addEventListener('input', renderLibraryList);

function closeAllLibConfirms(except) {
  libraryList.querySelectorAll('.lib-confirm').forEach(b => {
    if (b === except) return;
    b.classList.add('translate-x-full');
    b.classList.remove('translate-x-0');
  });
}

libraryList.addEventListener('click', async e => {
  const confirmBtn = e.target.closest('.lib-confirm');
  if (confirmBtn) {
    if (confirmBtn.classList.contains('translate-x-full')) return; // not yet revealed
    const jobId = confirmBtn.dataset.job;
    try {
      await fetch(`/api/tracks/${jobId}`, { method: 'DELETE' });
    } catch (_) {}
    refreshLibrary();
    return;
  }

  const del = e.target.closest('.lib-del');
  if (del) {
    const overlay = del.closest('li').querySelector('.lib-confirm');
    closeAllLibConfirms(overlay);
    overlay.classList.remove('translate-x-full');
    overlay.classList.add('translate-x-0');
    return;
  }

  const load = e.target.closest('.lib-load');
  if (load) {
    const jobId = load.dataset.job;
    const name = load.dataset.name;
    closeLibraryDialog();
    loadFromLibrary({ job_id: jobId, name });
    return;
  }
});

// dismiss any open confirm when clicking elsewhere
document.addEventListener('click', e => {
  if (e.target.closest('.lib-del') || e.target.closest('.lib-confirm')) return;
  closeAllLibConfirms();
});

// dismiss on Esc
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllLibConfirms();
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

// --- lyrics ----------------------------------------------------------------

function resetLyricsUI() {
  lyrics = { found: false, hasSynced: false, lines: [], plain: '' };
  activeLyricIdx = -1;
  userScrolledLyrics = false;
  lyricsLinesEl.innerHTML = '';
  lyricsTitle.textContent = '';
  lyricsArtist.textContent = '';
  hide(lyricsHeader);
  hide(lyricsLoading);
  hide(lyricsNone);
  hide(lyricsContent);
  hide(lyricsFollowBtn);
  show(lyricsEmpty);
}

async function loadLyrics(jobId, fallbackName, opts = {}) {
  if (!jobId) return;
  const myFetchId = ++lyricsFetchId;
  hide(lyricsEmpty); hide(lyricsNone); hide(lyricsContent); hide(lyricsHeader);
  show(lyricsLoading);
  lyricsLinesEl.innerHTML = '';
  activeLyricIdx = -1;

  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.refresh) params.set('refresh', '1');
  const url = `/api/lyrics/${jobId}${params.toString() ? '?' + params : ''}`;

  let data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    data = await r.json();
  } catch (e) {
    data = { found: false, reason: String(e) };
  }

  if (myFetchId !== lyricsFetchId || jobId !== currentJobId) return;

  hide(lyricsLoading);

  const hasContent = data && data.found && ((data.lines && data.lines.length) || data.plain);
  if (!hasContent) {
    show(lyricsNone);
    return;
  }

  lyrics = {
    found: true,
    hasSynced: !!(data.lines && data.lines.length),
    lines: data.lines || [],
    plain: data.plain || '',
    title: data.title || fallbackName || '',
    artist: data.artist || '',
    instrumental: !!data.instrumental,
  };

  lyricsTitle.textContent = lyrics.title;
  lyricsArtist.textContent = lyrics.artist;
  show(lyricsHeader);

  renderLyrics();
  show(lyricsContent);
  // reset scroll to top so first active line scrolls in naturally
  lyricsContent.scrollTop = 0;
  // sync immediately to current playback position
  updateActiveLyric(currentTime ? (playing ? currentTime() : startOffset) : 0);
}

function renderLyrics() {
  lyricsLinesEl.innerHTML = '';
  userScrolledLyrics = false;
  hide(lyricsFollowBtn);
  lyricsContent.scrollTop = 0;
  if (lyrics.instrumental && !lyrics.hasSynced && !lyrics.plain) {
    const li = document.createElement('li');
    li.className = 'lyric-line lyric-plain text-stone-500 dark:text-stone-400';
    li.textContent = '♪ instrumental ♪';
    lyricsLinesEl.appendChild(li);
    return;
  }
  if (lyrics.hasSynced) {
    for (let i = 0; i < lyrics.lines.length; i++) {
      const ln = lyrics.lines[i];
      const li = document.createElement('li');
      li.className = 'lyric-line' + (ln.text ? '' : ' gap');
      li.dataset.t = ln.t;
      li.dataset.i = i;
      if (ln.text) li.textContent = ln.text;
      lyricsLinesEl.appendChild(li);
    }
  } else if (lyrics.plain) {
    for (const raw of lyrics.plain.split('\n')) {
      const li = document.createElement('li');
      li.className = 'lyric-line lyric-plain';
      li.textContent = raw || ' ';
      lyricsLinesEl.appendChild(li);
    }
  }
}

function updateActiveLyric(t) {
  if (!lyrics.hasSynced || !lyrics.lines.length) return;
  // binary search: largest i where lines[i].t <= t
  let lo = 0, hi = lyrics.lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics.lines[mid].t <= t) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (ans === activeLyricIdx) return;

  if (activeLyricIdx >= 0) {
    const prev = lyricsLinesEl.children[activeLyricIdx];
    if (prev) {
      prev.classList.remove('active');
      prev.classList.add('passed');
    }
  }
  activeLyricIdx = ans;
  if (ans < 0) return;

  // mark all passed lines (in case of large seek)
  for (let i = 0; i < ans; i++) {
    const el = lyricsLinesEl.children[i];
    if (el && !el.classList.contains('passed')) el.classList.add('passed');
  }
  for (let i = ans + 1; i < lyrics.lines.length; i++) {
    const el = lyricsLinesEl.children[i];
    if (el) el.classList.remove('passed');
  }

  const el = lyricsLinesEl.children[ans];
  if (!el) return;
  el.classList.remove('passed');
  el.classList.add('active');

  if (!userScrolledLyrics) scrollActiveLyricIntoView();
}

const lgMedia = window.matchMedia('(min-width: 1024px)');

function scrollActiveLyricIntoView() {
  if (activeLyricIdx < 0) return;
  const el = lyricsLinesEl.children[activeLyricIdx];
  if (!el) return;
  if (lgMedia.matches) {
    // desktop: scroll within the lyrics column
    const target = Math.max(0, el.offsetTop - lyricsContent.clientHeight * 0.28);
    lyricsContent.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    // mobile: lyrics flow inline — scroll the page so the active line sits ~28% from top of viewport
    const rect = el.getBoundingClientRect();
    const target = window.scrollY + rect.top - window.innerHeight * 0.28;
    lastProgrammaticScrollTs = Date.now();
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

function setLyricFollowing(following) {
  if (following) {
    userScrolledLyrics = false;
    hide(lyricsFollowBtn);
    scrollActiveLyricIntoView();
    return;
  }
  // user scrolled away — only flag if playback is engaged
  if (!playing || !lyrics.hasSynced) return;
  userScrolledLyrics = true;
  updateFollowBtnVisibility();
}

function updateFollowBtnVisibility() {
  if (!userScrolledLyrics || !playing || !lyrics.hasSynced) {
    hide(lyricsFollowBtn);
    return;
  }
  if (lgMedia.matches) {
    show(lyricsFollowBtn);
    return;
  }
  // mobile: the button is fixed bottom-4 — only show when the song title has
  // scrolled above it and the aside is still in view
  const headerRect = lyricsHeader.getBoundingClientRect();
  const btnTop = window.innerHeight - 52; // ~bottom-4 (16) + button height (~36)
  if (headerRect.bottom > btnTop) {
    hide(lyricsFollowBtn);
    return;
  }
  const asideRect = lyricsPane.getBoundingClientRect();
  if (asideRect.bottom < 0 || asideRect.top > window.innerHeight) {
    hide(lyricsFollowBtn);
    return;
  }
  show(lyricsFollowBtn);
}

// detect manual scroll (wheel / touch / keyboard) to stop auto-following
lyricsContent.addEventListener('wheel', () => setLyricFollowing(false), { passive: true });
lyricsContent.addEventListener('touchmove', () => setLyricFollowing(false), { passive: true });
lyricsContent.addEventListener('keydown', e => {
  if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) {
    setLyricFollowing(false);
  }
});

// on mobile the page scrolls (not lyrics-content) — listen on the window
let lastProgrammaticScrollTs = 0;
function onMobileScrollEvent() {
  if (lgMedia.matches) return;
  if (Date.now() - lastProgrammaticScrollTs < 700) return;
  setLyricFollowing(false);
  updateFollowBtnVisibility();
}
window.addEventListener('wheel', onMobileScrollEvent, { passive: true });
window.addEventListener('touchmove', onMobileScrollEvent, { passive: true });
window.addEventListener('scroll', () => {
  if (lgMedia.matches) return;
  if (userScrolledLyrics) updateFollowBtnVisibility();
}, { passive: true });

lyricsFollowBtn.addEventListener('click', () => setLyricFollowing(true));

lyricsLinesEl.addEventListener('click', e => {
  const li = e.target.closest('.lyric-line');
  if (!li || li.dataset.t === undefined) return;
  const t = parseFloat(li.dataset.t);
  if (!isFinite(t)) return;
  seekTo(t);
  if (!playing && ctx) play();
});

lyricsNoneSearchBtn.addEventListener('click', () => {
  if (!currentJobId) return;
  openLyricsDialog();
});

resetLyricsUI();

// --- lyrics search dialog --------------------------------------------------

const openLyricsSearchBtn = $('open-lyrics-search');
const lyricsDialog = $('lyrics-dialog');
const lyricsDialogClose = $('lyrics-dialog-close');
const lyricsSearchForm = $('lyrics-search-form');
const lyricsSearchInput = $('lyrics-search-q');
const lyricsSearchSubmit = $('lyrics-search-submit');
const lyricsSearchResults = $('lyrics-search-results');
const lyricsSearchEmpty = $('lyrics-search-empty');
const lyricsSearchHint = $('lyrics-search-hint');

const DURATION_MATCH_TOL = 0.5; // seconds — highlight only when displayed m:ss matches
let lyricsSearching = false;

function openLyricsDialog() {
  const seed = (trackName.textContent || '').trim();
  lyricsSearchInput.value = seed;
  lyricsSearchResults.innerHTML = '';
  hide(lyricsSearchEmpty);
  show(lyricsSearchHint);
  lyricsDialog.showModal();
  setTimeout(() => { lyricsSearchInput.focus(); lyricsSearchInput.select(); }, 0);
}

function closeLyricsDialog() { lyricsDialog.close(); }

openLyricsSearchBtn.addEventListener('click', () => {
  if (!currentJobId) return;
  openLyricsDialog();
});

lyricsDialogClose.addEventListener('click', closeLyricsDialog);

lyricsDialog.addEventListener('click', e => {
  if (e.target === lyricsDialog) closeLyricsDialog();
});

lyricsSearchForm.addEventListener('submit', e => {
  e.preventDefault();
  submitLyricsSearch();
});

async function submitLyricsSearch() {
  const q = lyricsSearchInput.value.trim();
  if (!q || lyricsSearching) return;
  lyricsSearching = true;
  setLyricsSearchBusy(true);
  hide(lyricsSearchEmpty);
  hide(lyricsSearchHint);
  // only show the "searching…" placeholder when there are no existing results;
  // subsequent searches keep prior results visible until new ones arrive.
  if (!lyricsSearchResults.querySelector('li[data-id]')) {
    lyricsSearchResults.innerHTML = `<li class="flex items-center gap-2 text-sm text-stone-500 italic px-2 py-2"><span class="material-symbols-outlined" style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span>searching…</li>`;
  }
  try {
    const r = await fetch(`/api/lyrics-search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    renderLyricsSearchResults(data.results || []);
  } catch (err) {
    lyricsSearchResults.innerHTML = `<li class="text-sm text-red-400 px-2 py-2">search failed: ${escapeHtml(String(err).slice(0, 200))}</li>`;
  } finally {
    lyricsSearching = false;
    setLyricsSearchBusy(false);
  }
}

function setLyricsSearchBusy(busy) {
  lyricsSearchSubmit.disabled = busy;
  lyricsSearchSubmit.classList.toggle('opacity-60', busy);
  lyricsSearchSubmit.classList.toggle('cursor-wait', busy);
}

function renderLyricsSearchResults(results) {
  lyricsSearchResults.innerHTML = '';
  if (!results.length) {
    show(lyricsSearchEmpty);
    return;
  }
  hide(lyricsSearchEmpty);
  const trackDuration = duration || 0;
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'flex items-baseline gap-3 px-3 py-2 bg-white dark:bg-paper-800 border border-stone-200 dark:border-stone-800 rounded-lg hover:border-claude/60 cursor-pointer transition group';
    li.dataset.id = r.id;

    const dur = typeof r.duration === 'number' ? r.duration : 0;
    const matches = trackDuration && dur && Math.abs(dur - trackDuration) <= DURATION_MATCH_TOL;
    const durClass = matches
      ? 'text-claude font-semibold'
      : 'text-stone-500 dark:text-stone-400';

    const flags = [];
    if (r.has_sync) flags.push('synced');
    else if (r.has_plain) flags.push('plain');
    if (r.instrumental) flags.push('instrumental');

    li.innerHTML = `
      <div class="flex-1 min-w-0">
        <p class="text-sm leading-snug truncate group-hover:text-claude transition">
          <span class="italic">${escapeHtml(r.title || '')}</span>
        </p>
        <p class="mt-0.5 text-xs text-stone-500 dark:text-stone-400 truncate">
          ${escapeHtml(r.artist || '')}${r.album ? ` · ${escapeHtml(r.album)}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}
        </p>
      </div>
      <span class="text-sm font-mono tabular-nums shrink-0 ${durClass}">${dur ? fmt(dur) : '—'}</span>
    `;
    lyricsSearchResults.appendChild(li);
  }
}

lyricsSearchResults.addEventListener('click', async e => {
  const li = e.target.closest('li[data-id]');
  if (!li || !currentJobId) return;
  const lrclibId = parseInt(li.dataset.id, 10);
  if (!isFinite(lrclibId)) return;

  const jobId = currentJobId;
  closeLyricsDialog();
  hide(lyricsEmpty); hide(lyricsNone); hide(lyricsContent); hide(lyricsHeader);
  show(lyricsLoading);
  lyricsLinesEl.innerHTML = '';
  activeLyricIdx = -1;

  let data;
  try {
    const r = await fetch(`/api/lyrics/${jobId}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lrclib_id: lrclibId }),
    });
    if (!r.ok) throw new Error(await r.text());
    data = await r.json();
  } catch (err) {
    data = { found: false, reason: String(err) };
  }

  if (jobId !== currentJobId) return;

  hide(lyricsLoading);

  if (!data.found || (!data.lines?.length && !data.plain)) {
    show(lyricsNone);
    return;
  }

  lyrics = {
    found: true,
    hasSynced: !!(data.lines && data.lines.length),
    lines: data.lines || [],
    plain: data.plain || '',
    title: data.title || '',
    artist: data.artist || '',
    instrumental: !!data.instrumental,
  };
  lyricsTitle.textContent = lyrics.title;
  lyricsArtist.textContent = lyrics.artist;
  show(lyricsHeader);
  renderLyrics();
  show(lyricsContent);
  lyricsContent.scrollTop = 0;
  updateActiveLyric(playing ? currentTime() : startOffset);
});

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

// --- youtube search dialog -------------------------------------------------

const SEARCH_PAGE_SIZE = 10;
let searchState = { q: '', offset: 0, hasMore: false };
let searching = false;

function openSearchDialog() {
  searchDialog.showModal();
  setTimeout(() => searchInput.focus(), 0);
}

function closeSearchDialog() {
  searchDialog.close();
}

let searchYtResults = [];
let searchYtLoading = false;
let searchYtError = '';

function resetSearch() {
  searchState = { q: '', offset: 0, hasMore: false };
  searchInput.value = '';
  searchYtResults = [];
  searchYtLoading = false;
  searchYtError = '';
  searchResults.innerHTML = '';
  hide(searchEmpty);
  hide(loadMoreBtn);
  show(searchHint);
  toggleClearVisibility();
}

function toggleClearVisibility() {
  if (searchInput.value.length > 0) show(clearSearchBtn);
  else hide(clearSearchBtn);
}

openSearchBtn.addEventListener('click', openSearchDialog);
dialogCloseBtn.addEventListener('click', closeSearchDialog);

searchDialog.addEventListener('close', resetSearch);

searchDialog.addEventListener('click', e => {
  // close when clicking on the backdrop (the dialog element itself)
  if (e.target === searchDialog) closeSearchDialog();
});

searchInput.addEventListener('input', () => {
  toggleClearVisibility();
  // changing the query invalidates the YT search; library matches refresh live
  searchYtResults = [];
  searchYtError = '';
  searchState = { q: '', offset: 0, hasMore: false };
  hide(loadMoreBtn);
  refreshSearchDialog();
});

clearSearchBtn.addEventListener('click', () => {
  searchState = { q: '', offset: 0, hasMore: false };
  searchInput.value = '';
  searchYtResults = [];
  searchYtError = '';
  hide(loadMoreBtn);
  toggleClearVisibility();
  refreshSearchDialog();
  searchInput.focus();
});

searchForm.addEventListener('submit', async e => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q || searching) return;
  searchState = { q, offset: 0, hasMore: false };
  searchYtError = '';
  hide(loadMoreBtn);
  await fetchSearchPage(true);
});

loadMoreBtn.addEventListener('click', () => fetchSearchPage(false));

async function fetchSearchPage(isFirstPage) {
  if (searching || !searchState.q) return;
  searching = true;
  setSearchBusy(true);

  if (isFirstPage) {
    searchYtResults = [];
    searchYtLoading = true;
    refreshSearchDialog();
  } else {
    hide(loadMoreBtn);
    searchYtLoading = true;
    refreshSearchDialog();
  }

  try {
    const url = `/api/search?q=${encodeURIComponent(searchState.q)}&limit=${SEARCH_PAGE_SIZE}&offset=${searchState.offset}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const newResults = data.results || [];
    searchYtResults = isFirstPage ? newResults : [...searchYtResults, ...newResults];
    searchState.offset += newResults.length;
    searchState.hasMore = !!data.has_more;
    searchYtLoading = false;
    refreshSearchDialog();
    if (searchState.hasMore) show(loadMoreBtn); else hide(loadMoreBtn);
  } catch (err) {
    searchYtLoading = false;
    searchYtError = String(err).slice(0, 200);
    refreshSearchDialog();
    hide(loadMoreBtn);
  } finally {
    searching = false;
    setSearchBusy(false);
  }
}

function setSearchBusy(busy) {
  searchBtn.disabled = busy;
  loadMoreBtn.disabled = busy;
  searchBtn.classList.toggle('opacity-60', busy);
  searchBtn.classList.toggle('cursor-wait', busy);
}

function _libraryHitLi(t) {
  const li = document.createElement('li');
  li.className = 'flex gap-3 p-2 bg-white dark:bg-paper-800 border border-claude/40 rounded-lg hover:border-claude cursor-pointer transition group';
  li.dataset.jobId = t.job_id;
  li.dataset.name = t.name;
  li.innerHTML = `
    <div class="w-32 aspect-video flex items-center justify-center rounded bg-claude/10 shrink-0">
      <span class="material-symbols-outlined text-claude" style="font-size:28px">library_music</span>
    </div>
    <div class="flex-1 min-w-0 flex flex-col justify-center">
      <p class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition">${escapeHtml(t.name)}</p>
      <p class="mt-1 text-xs text-claude font-medium uppercase tracking-[0.15em]">in library</p>
    </div>
  `;
  return li;
}

function _youtubeHitLi(r) {
  const li = document.createElement('li');
  li.className = 'flex gap-3 p-2 bg-white dark:bg-paper-800 border border-stone-200 dark:border-stone-800 rounded-lg hover:border-claude/60 cursor-pointer transition group';
  li.dataset.id = r.id;
  li.dataset.name = r.title;
  li.innerHTML = `
    <img src="${escapeAttr(r.thumbnail)}" alt="" loading="lazy"
      class="w-32 aspect-video object-cover rounded bg-stone-200 dark:bg-stone-700 shrink-0">
    <div class="flex-1 min-w-0 flex flex-col justify-center">
      <p class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition">${escapeHtml(r.title)}</p>
      <p class="mt-1 text-xs text-stone-500 dark:text-stone-400 truncate">
        ${escapeHtml(r.channel || '')}${r.duration ? ` · <span class="font-mono tabular-nums">${fmt(r.duration)}</span>` : ''}
      </p>
    </div>
  `;
  return li;
}

function refreshSearchDialog() {
  const q = searchInput.value.trim();
  const ql = q.toLowerCase();
  searchResults.innerHTML = '';

  if (!q && !searchYtLoading && !searchYtResults.length && !searchYtError) {
    show(searchHint);
    hide(searchEmpty);
    return;
  }
  hide(searchHint);

  const rendered = new Set();
  // 1. library matches by title (live as user types)
  if (ql) {
    for (const t of libraryTracks) {
      if ((t.name || '').toLowerCase().includes(ql)) {
        searchResults.appendChild(_libraryHitLi(t));
        rendered.add(t.job_id);
      }
    }
  }
  // 2. YT results — replace ones that are already in the library by video_id
  const byVideoId = new Map(
    libraryTracks.filter(t => t.video_id).map(t => [t.video_id, t])
  );
  for (const r of searchYtResults) {
    const libMatch = byVideoId.get(r.id);
    if (libMatch) {
      if (!rendered.has(libMatch.job_id)) {
        searchResults.appendChild(_libraryHitLi(libMatch));
        rendered.add(libMatch.job_id);
      }
    } else {
      searchResults.appendChild(_youtubeHitLi(r));
    }
  }

  if (searchYtLoading) {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-2 text-sm text-stone-500 italic px-2 py-2';
    li.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span>${searchResults.children.length ? 'searching youtube…' : 'searching…'}`;
    searchResults.appendChild(li);
  } else if (searchYtError) {
    const li = document.createElement('li');
    li.className = 'text-sm text-red-400 px-2 py-2';
    li.textContent = `search failed: ${searchYtError}`;
    searchResults.appendChild(li);
  }

  if (!searchResults.children.length) {
    show(searchEmpty);
  } else {
    hide(searchEmpty);
  }
}

searchResults.addEventListener('click', e => {
  const li = e.target.closest('li[data-job-id], li[data-id]');
  if (!li) return;
  closeSearchDialog();
  if (li.dataset.jobId) {
    loadFromLibrary({ job_id: li.dataset.jobId, name: li.dataset.name });
  } else if (li.dataset.id) {
    startYoutubeSeparation({ id: li.dataset.id, title: li.dataset.name });
  }
});

async function startYoutubeSeparation(item) {
  show(statusEl); hide(drop); hide(player);
  setStatus({ stage: 'downloading_audio', percent: 0, message: item.title });
  await runSeparation(() => fetch('/api/separate-youtube', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: item.id, name: item.title }),
  }));
}
