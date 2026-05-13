<script lang="ts">
  import { engine, app } from '$lib/state.svelte';
  import { fetchLyrics, selectLyrics, type LyricsResult } from '$lib/api';
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
  };

  const EMPTY: LyricsState = {
    found: false,
    hasSynced: false,
    lines: [],
    plain: '',
    title: '',
    artist: '',
    instrumental: false
  };

  let lyrics = $state<LyricsState>(EMPTY);
  let loading = $state(false);
  let activeIdx = $state(-1);
  let userScrolled = $state(false);
  let fetchSeq = 0;

  let dialogOpen = $state(false);
  let contentEl: HTMLDivElement | null = $state(null);
  let linesEl: HTMLOListElement | null = $state(null);
  let headerEl: HTMLElement | null = $state(null);
  let paneEl: HTMLElement | null = $state(null);
  let isLg = $state(false);
  let lastProgrammaticScrollTs = 0;
  let followBtnVisible = $state(false);

  // load lyrics whenever the current track changes
  $effect(() => {
    const tr = app.currentTrack;
    if (!tr) {
      lyrics = EMPTY;
      activeIdx = -1;
      userScrolled = false;
      followBtnVisible = false;
      return;
    }
    void loadLyrics(tr.jobId, tr.name);
  });

  // track active line whenever player time changes
  $effect(() => {
    const t = app.player.currentTime;
    updateActive(t);
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    isLg = mq.matches;
    const cb = () => (isLg = mq.matches);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  });

  async function loadLyrics(jobId: string, fallbackName: string, opts: { refresh?: boolean } = {}) {
    const myId = ++fetchSeq;
    loading = true;
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
    applyLyrics(data, fallbackName);
  }

  function applyLyrics(data: LyricsResult, fallbackName: string) {
    const hasContent = data?.found && ((data.lines?.length ?? 0) > 0 || !!data.plain);
    if (!hasContent) {
      lyrics = { ...EMPTY, found: false };
      return;
    }
    lyrics = {
      found: true,
      hasSynced: !!(data.lines && data.lines.length),
      lines: data.lines ?? [],
      plain: data.plain ?? '',
      title: data.title ?? fallbackName ?? '',
      artist: data.artist ?? '',
      instrumental: !!data.instrumental
    };
    activeIdx = -1;
    userScrolled = false;
    if (contentEl) contentEl.scrollTop = 0;
    // sync to current playback
    updateActive(app.player.currentTime);
  }

  function updateActive(t: number) {
    if (!lyrics.hasSynced || !lyrics.lines.length) return;
    let lo = 0,
      hi = lyrics.lines.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrics.lines[mid].t <= t) {
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
    if (!el) return;
    if (isLg && contentEl) {
      const target = Math.max(0, el.offsetTop - contentEl.clientHeight * 0.28);
      contentEl.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      const rect = el.getBoundingClientRect();
      const target = window.scrollY + rect.top - window.innerHeight * 0.28;
      lastProgrammaticScrollTs = Date.now();
      window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }

  function setFollowing(following: boolean) {
    if (following) {
      userScrolled = false;
      followBtnVisible = false;
      scrollActiveIntoView();
      return;
    }
    if (!app.player.playing || !lyrics.hasSynced) return;
    userScrolled = true;
    updateFollowVisibility();
  }

  function updateFollowVisibility() {
    if (!userScrolled || !app.player.playing || !lyrics.hasSynced) {
      followBtnVisible = false;
      return;
    }
    if (isLg) {
      followBtnVisible = true;
      return;
    }
    if (!headerEl || !paneEl) return;
    const headerRect = headerEl.getBoundingClientRect();
    const btnTop = window.innerHeight - 52;
    if (headerRect.bottom > btnTop) {
      followBtnVisible = false;
      return;
    }
    const asideRect = paneEl.getBoundingClientRect();
    if (asideRect.bottom < 0 || asideRect.top > window.innerHeight) {
      followBtnVisible = false;
      return;
    }
    followBtnVisible = true;
  }

  function onWheel() {
    setFollowing(false);
  }
  function onTouch() {
    setFollowing(false);
  }

  function onMobileScroll() {
    if (isLg) return;
    if (Date.now() - lastProgrammaticScrollTs < 700) return;
    setFollowing(false);
    updateFollowVisibility();
  }
  function onWindowScroll() {
    if (isLg) return;
    if (userScrolled) updateFollowVisibility();
  }

  function onLineClick(line: LyricLine) {
    engine.seekTo(line.t);
    if (!app.player.playing) engine.play();
  }

  async function onPickLyrics(lrclibId: number) {
    if (!app.currentTrack) return;
    const jobId = app.currentTrack.jobId;
    dialogOpen = false;
    loading = true;
    lyrics = EMPTY;
    activeIdx = -1;
    let data: LyricsResult;
    try {
      data = await selectLyrics(jobId, lrclibId);
    } catch (e) {
      data = { found: false, reason: String(e) };
    }
    if (app.currentTrack?.jobId !== jobId) return;
    loading = false;
    applyLyrics(data, app.currentTrack.name);
  }

  const showLoading = $derived(loading);
  const showNone = $derived(!loading && !!app.currentTrack && !lyrics.found);
  const showContent = $derived(!loading && lyrics.found);
</script>

<svelte:window
  onwheel={onMobileScroll}
  ontouchmove={onMobileScroll}
  onscroll={onWindowScroll}
/>

{#if app.currentTrack}
<aside
  bind:this={paneEl}
  class="order-3 flex flex-col mt-14 lg:mt-0 lg:h-[calc(100vh-12rem)] lg:flex-1 lg:min-w-0 lg:sticky lg:top-6 lg:self-start lg:relative"
>
  <div class="flex-none flex items-center justify-between mb-3">
    <h3 class="text-xs uppercase tracking-[0.2em] text-stone-500">lyrics</h3>
    {#if app.currentTrack}
      <button
        type="button"
        title="search lyrics"
        aria-label="search lyrics"
        onclick={() => (dialogOpen = true)}
        class="w-7 h-7 -my-1 rounded-full text-stone-500 hover:text-claude transition flex items-center justify-center"
      >
        <span class="material-symbols-outlined" style="font-size:18px">search</span>
      </button>
    {/if}
  </div>

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
      <p class="flex items-center gap-2 text-stone-500 dark:text-stone-400 italic">
        <span
          class="material-symbols-outlined"
          style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
        >
        fetching lyrics…
      </p>
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
      class="flex-1 overflow-y-auto overflow-x-hidden pr-6"
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
        {:else if lyrics.hasSynced}
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
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 lg:absolute lg:-translate-x-1/2 px-4 h-9 rounded-full bg-claude hover:bg-claude-300 text-paper-50 text-sm font-medium shadow-lg flex items-center gap-1.5 transition"
    >
      <span class="material-symbols-outlined" style="font-size:18px">steps</span>
      follow
    </button>
  {/if}
</aside>
{/if}

<LyricsSearch
  open={dialogOpen}
  seed={lyrics.title || app.currentTrack?.name || ''}
  trackDuration={app.player.duration}
  onClose={() => (dialogOpen = false)}
  onPick={onPickLyrics}
/>
