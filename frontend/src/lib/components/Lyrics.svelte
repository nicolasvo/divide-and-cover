<script lang="ts">
  import { engine, app } from '$lib/state.svelte';
  import {
    fetchLyrics,
    selectLyrics,
    saveLyricsOffset,
    type LyricsResult,
    type LyricsSearchHit
  } from '$lib/api';
  import LyricsSearch from './LyricsSearch.svelte';

  type LyricLine = { t: number; text: string };
  type LyricsState = {
    found: boolean;
    hasSynced: boolean;
    lines: LyricLine[];
    plain: string;
    title: string;
    artist: string;
    instrumental: boolean;
    id: number | null; // lrclib id of currently-displayed record
  };

  const EMPTY: LyricsState = {
    found: false,
    hasSynced: false,
    lines: [],
    plain: '',
    title: '',
    artist: '',
    instrumental: false,
    id: null
  };

  let lyrics = $state<LyricsState>(EMPTY);
  let loading = $state(false);
  let loadingQuery = $state(''); // cleaned query shown under the spinner
  let activeIdx = $state(-1);
  let userScrolled = $state(false);
  let fetchSeq = 0;

  // sync mode: user tells us "this line is what I'm hearing right now" so we
  // can offset every timestamp. Persisted to lyrics.json on the backend.
  let offset = $state(0);
  let syncing = $state(false);

  // Per-track toggle for auto-sync. Off = render synced lyrics as static text
  // (e.g. live recordings where lrclib's timestamps don't apply). Persisted
  // per-jobId in localStorage so the choice sticks across reloads.
  let syncEnabled = $state(true);
  function loadSyncPref(jobId: string): boolean {
    try {
      const v = localStorage.getItem(`lyrics-sync:${jobId}`);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  }
  function saveSyncPref(jobId: string, on: boolean) {
    try {
      localStorage.setItem(`lyrics-sync:${jobId}`, on ? '1' : '0');
    } catch {}
  }
  function toggleSyncEnabled() {
    if (!app.currentTrack) return;
    syncEnabled = !syncEnabled;
    saveSyncPref(app.currentTrack.jobId, syncEnabled);
    if (!syncEnabled) {
      // Turning sync off mid-playback: stop following but leave the user's
      // current scroll position alone. activeIdx is cleared so re-enabling
      // sync forces a fresh scroll back to the current line.
      syncing = false;
      userScrolled = false;
      followBtnVisible = false;
      activeIdx = -1;
    } else {
      updateActive(app.player.currentTime);
    }
  }

  // Mirrors `_clean_lyric_query` in app/main.py so the user sees the same
  // string the backend will send to lrclib while the fetch is in flight.
  const LRC_NOISE_RE =
    /\s*[\(\[](?:official[^)\]]*|audio|video|lyrics?|hd|hq|m\/?v|live|cover|remix|edit|feat\.?[^)\]]*|ft\.?[^)\]]*|prod\.?[^)\]]*|visualizer|with\s+lyrics?)[\)\]]\s*/gi;
  function cleanLyricQuery(name: string): string {
    return name
      .replace(LRC_NOISE_RE, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[ \-–—|·•_]+|[ \-–—|·•_]+$/g, '')
      .trim();
  }

  // Prefill helper for the search input — drops "artist - title" style
  // separators (dash flanked by whitespace) but keeps in-word dashes like
  // "well-known" or "Numb-Acoustic" intact. Supports ASCII -, en –, em —.
  function cleanSeed(name: string): string {
    return name
      .replace(/\s+[-–—]\s+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let dialogOpen = $state(false);
  let contentEl: HTMLDivElement | null = $state(null);
  let linesEl: HTMLOListElement | null = $state(null);
  let headerEl: HTMLElement | null = $state(null);
  let paneEl: HTMLElement | null = $state(null);
  let followBtnVisible = $state(false);

  // load lyrics whenever the current track changes
  $effect(() => {
    const tr = app.currentTrack;
    if (!tr) {
      lyrics = EMPTY;
      activeIdx = -1;
      userScrolled = false;
      followBtnVisible = false;
      offset = 0;
      syncing = false;
      syncEnabled = true;
      return;
    }
    syncEnabled = loadSyncPref(tr.jobId);
    void loadLyrics(tr.jobId, tr.name);
  });

  // exit sync mode if playback stops — capturing the offset only makes sense
  // while a track is actually playing
  $effect(() => {
    if (!app.player.playing) syncing = false;
  });

  // Re-center the active line whenever the scroll container itself resizes
  // (player expanded/collapsed, keyboard opened, device rotated). Coalesced
  // through rAF so a burst of resize events only triggers one scroll, and
  // uses instant scroll so the next burst doesn't cancel a still-animating
  // smooth scroll.
  $effect(() => {
    if (!contentEl) return;
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (userScrolled || !syncEnabled) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!contentEl || !linesEl || activeIdx < 0) return;
        const el = linesEl.children[activeIdx] as HTMLElement | undefined;
        if (!el) return;
        const target = Math.max(0, el.offsetTop - contentEl.clientHeight * 0.28);
        contentEl.scrollTo({ top: target, behavior: 'auto' });
      });
    });
    ro.observe(contentEl);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  });

  // track active line whenever player time changes
  $effect(() => {
    const t = app.player.currentTime;
    updateActive(t);
  });

  async function loadLyrics(jobId: string, fallbackName: string, opts: { refresh?: boolean } = {}) {
    const myId = ++fetchSeq;
    loading = true;
    loadingQuery = cleanLyricQuery(fallbackName || '');
    activeIdx = -1;
    userScrolled = false;
    let data: LyricsResult;
    try {
      data = await fetchLyrics(jobId, { refresh: opts.refresh });
    } catch (e) {
      data = { found: false, reason: String(e) };
    }
    if (myId !== fetchSeq || app.currentTrack?.jobId !== jobId) return;
    loading = false;
    loadingQuery = '';
    applyLyrics(data, fallbackName);
  }

  function applyLyrics(data: LyricsResult, fallbackName: string) {
    const hasContent = data?.found && ((data.lines?.length ?? 0) > 0 || !!data.plain);
    if (!hasContent) {
      lyrics = { ...EMPTY, found: false };
      offset = 0;
      syncing = false;
      return;
    }
    lyrics = {
      found: true,
      hasSynced: !!(data.lines && data.lines.length),
      lines: data.lines ?? [],
      plain: data.plain ?? '',
      title: data.title ?? fallbackName ?? '',
      artist: data.artist ?? '',
      instrumental: !!data.instrumental,
      id: data.id ?? null
    };
    offset = data.offset ?? 0;
    syncing = false;
    activeIdx = -1;
    userScrolled = false;
    if (contentEl) contentEl.scrollTop = 0;
    // sync to current playback
    updateActive(app.player.currentTime);
  }

  function updateActive(t: number) {
    if (!lyrics.hasSynced || !lyrics.lines.length || !syncEnabled) return;
    // playback time `t` maps back to a raw line index by subtracting offset:
    // a line at raw_t is "active" when t >= raw_t + offset  ⇔  raw_t <= t - offset
    const adjusted = t - offset;
    let lo = 0,
      hi = lyrics.lines.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrics.lines[mid].t <= adjusted) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans === activeIdx) return;
    activeIdx = ans;
    if (!userScrolled) scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    if (activeIdx < 0 || !linesEl) return;
    const el = linesEl.children[activeIdx] as HTMLElement | undefined;
    if (!el || !contentEl) return;
    // lyrics always scroll inside contentEl (constrained-height aside on both
    // desktop and mobile — no more window-scroll fallback)
    const target = Math.max(0, el.offsetTop - contentEl.clientHeight * 0.28);
    contentEl.scrollTo({ top: target, behavior: 'smooth' });
  }

  function setFollowing(following: boolean) {
    if (following) {
      userScrolled = false;
      followBtnVisible = false;
      scrollActiveIntoView();
      return;
    }
    if (!app.player.playing || !lyrics.hasSynced || !syncEnabled) return;
    userScrolled = true;
    updateFollowVisibility();
  }

  function updateFollowVisibility() {
    followBtnVisible = !!(userScrolled && app.player.playing && lyrics.hasSynced && syncEnabled);
  }

  function onWheel() {
    setFollowing(false);
  }
  function onTouch() {
    setFollowing(false);
  }

  function onLineClick(line: LyricLine) {
    if (!syncEnabled && app.currentTrack) {
      // Clicking a line while sync is toggled off re-enables sync and jumps
      // playback to that line — same seek behavior as a normal click in
      // synced mode. We do NOT touch the offset here: capturing offset is
      // reserved for the dedicated sync button.
      syncEnabled = true;
      syncing = false;
      userScrolled = false;
      activeIdx = -1;
      saveSyncPref(app.currentTrack.jobId, true);
      engine.seekTo(line.t + offset);
      if (!app.player.playing) engine.play();
      updateActive(app.player.currentTime);
      return;
    }
    if (syncing && app.currentTrack) {
      // user says "this line is what I'm hearing right now" — capture the gap
      // between playback and the line's raw timestamp, persist, exit sync mode
      const newOffset = app.player.currentTime - line.t;
      offset = newOffset;
      syncing = false;
      const jobId = app.currentTrack.jobId;
      void saveLyricsOffset(jobId, newOffset).catch(() => {});
      // refresh the active highlight against the new offset
      updateActive(app.player.currentTime);
      return;
    }
    engine.seekTo(line.t + offset);
    if (!app.player.playing) engine.play();
  }

  function resetOffset() {
    if (!app.currentTrack) return;
    offset = 0;
    syncing = false;
    const jobId = app.currentTrack.jobId;
    void saveLyricsOffset(jobId, 0).catch(() => {});
    updateActive(app.player.currentTime);
  }

  async function onPickLyrics(hit: LyricsSearchHit) {
    if (!app.currentTrack) return;
    const jobId = app.currentTrack.jobId;
    dialogOpen = false;
    loading = true;
    loadingQuery = [hit.title, hit.artist].filter(Boolean).join(' — ');
    lyrics = EMPTY;
    activeIdx = -1;
    let data: LyricsResult;
    try {
      data = await selectLyrics(jobId, hit.id);
    } catch (e) {
      data = { found: false, reason: String(e) };
    }
    if (app.currentTrack?.jobId !== jobId) return;
    loading = false;
    loadingQuery = '';
    applyLyrics(data, app.currentTrack.name);
  }

  const showLoading = $derived(loading);
  const showNone = $derived(!loading && !!app.currentTrack && !lyrics.found);
  const showContent = $derived(!loading && lyrics.found);
</script>

{#if app.currentTrack}
<aside
  bind:this={paneEl}
  class="order-3 relative flex flex-col flex-1 min-h-0 mt-4 lg:mt-0 lg:h-[calc(100vh-12rem)] lg:min-w-0 lg:sticky lg:top-6 lg:self-start"
>
  <div class="flex-none flex items-start justify-between mb-3">
    <div class="flex items-center gap-2">
      <h3 class="text-xs uppercase tracking-[0.2em] text-stone-500">lyrics</h3>
      {#if lyrics.hasSynced}
        <button
          type="button"
          title={syncEnabled
            ? 'auto-sync on — click to show all lyrics statically (e.g. live versions)'
            : 'auto-sync off — click to follow playback'}
          aria-label={syncEnabled ? 'disable lyrics auto-sync' : 'enable lyrics auto-sync'}
          aria-pressed={syncEnabled}
          onclick={toggleSyncEnabled}
          class="w-7 h-7 -my-1 rounded-full transition flex items-center justify-center {syncEnabled
            ? 'text-claude bg-claude/10'
            : 'text-stone-500 hover:text-claude'}"
        >
          <span class="material-symbols-outlined" style="font-size:18px">steps</span>
        </button>
      {/if}
    </div>
    {#if app.currentTrack}
      <div class="flex flex-col items-end gap-0.5">
        <div class="flex items-center gap-1">
          {#if app.player.playing && lyrics.hasSynced && syncEnabled}
            <button
              type="button"
              title={syncing
                ? 'cancel — or click the line you hear right now'
                : 'tap, then click the line currently being sung to re-time lyrics'}
              aria-label={syncing ? 'cancel lyrics sync' : 'sync lyrics to playback'}
              onclick={() => (syncing = !syncing)}
              class="w-7 h-7 -my-1 rounded-full transition flex items-center justify-center {syncing
                ? 'text-claude bg-claude/10'
                : 'text-stone-500 hover:text-claude'}"
            >
              <span class="material-symbols-outlined" style="font-size:18px">center_focus_weak</span
              >
            </button>
          {/if}
          <button
            type="button"
            title="search for different lyrics for this song"
            aria-label="search for different lyrics for this song"
            onclick={() => (dialogOpen = true)}
            class="w-7 h-7 -my-1 rounded-full text-stone-500 hover:text-claude transition flex items-center justify-center"
          >
            <span class="material-symbols-outlined" style="font-size:18px">search</span>
          </button>
        </div>
        {#if offset !== 0 && lyrics.hasSynced && syncEnabled}
          <p
            class="text-xs font-mono tabular-nums text-stone-500 dark:text-stone-400"
            title="lyrics offset relative to playback"
          >
            offset {offset > 0 ? '+' : ''}{offset.toFixed(2)}s
          </p>
        {/if}
      </div>
    {/if}
  </div>
  {#if syncing}
    <div class="flex-none px-2 pb-2 text-center">
      <p class="text-xs italic text-claude">
        click the line you hear right now to re-align timestamps
      </p>
      {#if offset !== 0}
        <button
          type="button"
          onclick={resetOffset}
          class="mt-1 text-xs italic text-stone-500 hover:text-claude underline underline-offset-2 transition"
        >
          reset offset ({offset > 0 ? '+' : ''}{offset.toFixed(2)}s)
        </button>
      {/if}
    </div>
  {/if}

  {#if showContent}
    <header bind:this={headerEl} class="flex-none px-2 pb-3">
      <p class="text-lg italic truncate">{lyrics.title}</p>
      <p class="text-xs uppercase tracking-[0.2em] text-stone-500 dark:text-stone-400 truncate">
        {lyrics.artist}
      </p>
    </header>
  {/if}

  {#if showLoading}
    <div class="flex-1 flex items-start justify-center">
      <div class="flex flex-col items-center gap-1">
        <p class="flex items-center gap-2 text-stone-500 dark:text-stone-400 italic">
          <span
            class="material-symbols-outlined"
            style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
          >
          fetching lyrics…
        </p>
        {#if loadingQuery}
          <p class="text-xs text-stone-400 dark:text-stone-500 font-mono truncate max-w-full px-4">
            {loadingQuery}
          </p>
        {/if}
      </div>
    </div>
  {/if}

  {#if showNone}
    <div class="flex-1 flex flex-col items-center justify-start px-2 text-center gap-3">
      <p class="text-stone-500 dark:text-stone-400 italic">no lyrics found</p>
      <button
        type="button"
        onclick={() => (dialogOpen = true)}
        class="px-4 h-10 rounded-lg bg-claude hover:bg-claude-300 text-paper-50 transition text-sm font-medium flex items-center gap-2"
      >
        <span class="material-symbols-outlined" style="font-size:18px">search</span>
        search lyrics
      </button>
    </div>
  {/if}

  {#if showContent}
    <div
      id="lyrics-content"
      bind:this={contentEl}
      onwheel={onWheel}
      ontouchmove={onTouch}
      onkeydown={(e) => {
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key))
          setFollowing(false);
      }}
      class="relative flex-1 overflow-y-auto overflow-x-hidden pr-6"
    >
      <ol
        bind:this={linesEl}
        class="list-none m-0 p-0 space-y-6"
        style="padding-top:0;padding-bottom:70vh"
      >
        {#if lyrics.instrumental && !lyrics.hasSynced && !lyrics.plain}
          <li class="lyric-line lyric-plain text-stone-500 dark:text-stone-400">
            ♪ instrumental ♪
          </li>
        {:else if lyrics.hasSynced && syncEnabled}
          {#each lyrics.lines as ln, i (i)}
            <li
              class="lyric-line {!ln.text ? 'gap' : ''} {i === activeIdx
                ? 'active'
                : i < activeIdx
                  ? 'passed'
                  : ''}"
              onclick={() => onLineClick(ln)}
              role="button"
              tabindex="0"
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onLineClick(ln);
                }
              }}
            >
              {ln.text ?? ''}
            </li>
          {/each}
        {:else if lyrics.hasSynced}
          {#each lyrics.lines as ln, i (i)}
            <li
              class="lyric-line unsynced {!ln.text ? 'gap' : ''}"
              onclick={() => onLineClick(ln)}
              role="button"
              tabindex="0"
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onLineClick(ln);
                }
              }}
            >
              {ln.text ?? ''}
            </li>
          {/each}
        {:else if lyrics.plain}
          {#each lyrics.plain.split('\n') as raw, i (i)}
            <li class="lyric-line lyric-plain">{raw || ' '}</li>
          {/each}
        {/if}
      </ol>
    </div>
  {/if}

  {#if followBtnVisible}
    <button
      type="button"
      onclick={() => setFollowing(true)}
      class="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-4 h-9 rounded-full bg-claude hover:bg-claude-300 text-paper-50 text-sm font-medium shadow-lg flex items-center gap-1.5 transition"
    >
      <span class="material-symbols-outlined" style="font-size:18px">steps</span>
      follow
    </button>
  {/if}

  {#if syncing}
    <button
      type="button"
      onclick={() => (syncing = false)}
      class="absolute left-1/2 -translate-x-1/2 z-30 px-4 h-9 rounded-full bg-white dark:bg-paper-800 border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude text-sm font-medium shadow-lg flex items-center gap-1.5 transition {followBtnVisible
        ? 'bottom-16'
        : 'bottom-4'}"
    >
      <span class="material-symbols-outlined" style="font-size:18px">close</span>
      cancel sync
    </button>
  {/if}
</aside>
{/if}

<LyricsSearch
  open={dialogOpen}
  seed={cleanSeed(app.currentTrack?.name || '')}
  trackDuration={app.player.duration}
  currentId={lyrics.id}
  onClose={() => (dialogOpen = false)}
  onPick={onPickLyrics}
/>
