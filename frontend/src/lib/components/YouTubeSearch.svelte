<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { fmtTime } from '$lib/format';
  import { ytSearch, type YTHit } from '$lib/api';

  type Props = {
    open: boolean;
    onClose: () => void;
    onLoadLibrary: (jobId: string, name: string) => void;
    onPickYouTube: (videoId: string, title: string) => void;
  };
  let { open, onClose, onLoadLibrary, onPickYouTube }: Props = $props();

  const PAGE = 10;
  const DUR_TOL = 0.5;

  let dialog: HTMLDialogElement | null = $state(null);
  let q = $state(''); // current input value (live)
  let activeQuery = $state(''); // last submitted query — what load-more paginates against
  let results = $state<YTHit[]>([]);
  let offset = $state(0);
  let hasMore = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  let errMsg = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      reset();
      dialog.showModal();
      setTimeout(() => inputEl?.focus(), 0);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  function reset() {
    q = '';
    activeQuery = '';
    results = [];
    offset = 0;
    hasMore = false;
    loading = false;
    loadingMore = false;
    errMsg = '';
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  function onInput() {
    // typing doesn't touch results / offset / hasMore — those belong to
    // `activeQuery` (the last submitted search). Library matches refresh
    // live via $derived. The load-more button stays valid against the
    // previous search until a new submit replaces it.
    errMsg = '';
  }

  function clearQuery() {
    // explicit "start over" — wipe everything pagination-related
    q = '';
    activeQuery = '';
    results = [];
    offset = 0;
    hasMore = false;
    errMsg = '';
    inputEl?.focus();
  }

  function dedupeById(arr: YTHit[]): YTHit[] {
    // YouTube can return the same video twice within one page, and overlapping
    // videos across paginated pages. Keep first occurrence so the rendered
    // {#each ... (r.id)} block has unique keys.
    const seen = new Set<string>();
    const out: YTHit[] = [];
    for (const r of arr) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  async function fetchPage(isFirst: boolean) {
    if (loading) return;
    let query: string;
    let pageOffset: number;
    if (isFirst) {
      query = q.trim();
      if (!query) return;
      activeQuery = query;
      pageOffset = 0;
    } else {
      if (!activeQuery) return;
      query = activeQuery;
      pageOffset = offset;
    }
    loading = true;
    loadingMore = !isFirst;
    try {
      const data = await ytSearch(query, PAGE, pageOffset);
      const newResults = data.results ?? [];
      results = isFirst ? dedupeById(newResults) : dedupeById([...results, ...newResults]);
      // offset stays in YouTube-API space (count of consumed page rows), not
      // displayed-row count — otherwise pagination drifts when dups are removed
      offset = pageOffset + newResults.length;
      hasMore = !!data.has_more;
      errMsg = '';
    } catch (e) {
      errMsg = String(e).slice(0, 200);
      hasMore = false;
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    fetchPage(true);
  }

  const trimmedQ = $derived(q.trim().toLowerCase());

  const libraryHits = $derived.by(() => {
    if (!trimmedQ) return [];
    return app.tracks.filter((t) => (t.name || '').toLowerCase().includes(trimmedQ));
  });

  // map video_id → library track for "already in library" replacement
  const byVideoId = $derived.by(() => {
    const m = new Map<string, (typeof app.tracks)[number]>();
    for (const t of app.tracks) if (t.video_id) m.set(t.video_id, t);
    return m;
  });

  // YT results, splitting into library-replacements vs fresh hits
  const ytSplit: { libReplacements: typeof app.tracks; fresh: YTHit[] } = $derived.by(() => {
    const renderedJobs = new Set(libraryHits.map((t) => t.job_id));
    const libReplacements: typeof app.tracks = [];
    const fresh: YTHit[] = [];
    for (const r of results) {
      const lib = byVideoId.get(r.id);
      if (lib) {
        if (!renderedJobs.has(lib.job_id)) {
          libReplacements.push(lib);
          renderedJobs.add(lib.job_id);
        }
      } else {
        fresh.push(r);
      }
    }
    return { libReplacements, fresh };
  });

  function pickLibrary(jobId: string, name: string) {
    onClose();
    onLoadLibrary(jobId, name);
  }
  function pickYT(r: YTHit) {
    onClose();
    onPickYouTube(r.id, r.title);
  }

  const totalShown = $derived(
    libraryHits.length + ytSplit.libReplacements.length + ytSplit.fresh.length
  );
</script>

<dialog
  bind:this={dialog}
  onclose={onClose}
  onclick={onBackdrop}
  class="app-dialog bg-paper-50 text-paper-900 dark:bg-paper-900 dark:text-paper-50 font-serif"
>
  <div class="flex flex-col max-h-[calc(100vh-64px)]">
    <header
      class="flex items-center justify-between px-5 py-4 border-b border-stone-200 dark:border-stone-800"
    >
      <h2 class="text-xl italic">search youtube</h2>
      <button
        type="button"
        aria-label="close"
        onclick={onClose}
        class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
      >
        <span class="material-symbols-outlined" style="font-size:20px">close</span>
      </button>
    </header>

    <form onsubmit={onSubmit} class="flex gap-2 px-5 py-4">
      <div class="relative flex-1">
        <input
          bind:this={inputEl}
          bind:value={q}
          oninput={onInput}
          type="search"
          autocomplete="off"
          placeholder="search youtube…"
          class="w-full h-11 pl-4 pr-10 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-paper-800 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-claude transition"
        />
        {#if q.length > 0}
          <button
            type="button"
            aria-label="clear"
            onclick={clearQuery}
            class="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full text-stone-500 hover:text-claude transition flex items-center justify-center"
          >
            <span class="material-symbols-outlined" style="font-size:18px">close</span>
          </button>
        {/if}
      </div>
      <button
        type="submit"
        aria-label="search"
        disabled={loading}
        class="h-11 w-11 rounded-lg bg-claude hover:bg-claude-300 text-paper-50 flex items-center justify-center transition shrink-0 {loading
          ? 'opacity-60 cursor-wait'
          : ''}"
      >
        <span class="material-symbols-outlined" style="font-size:22px">search</span>
      </button>
    </form>

    <div class="flex-1 overflow-y-auto px-5 pb-5">
      {#if !trimmedQ && !loading && !results.length && !errMsg}
        <p class="text-sm text-stone-500 dark:text-stone-400 italic text-center py-8">
          type a query and press enter
        </p>
      {:else if totalShown === 0 && !loading && !errMsg}
        <p class="mt-3 text-sm text-stone-500 dark:text-stone-400 italic text-center">no results</p>
      {:else}
        <ul class="grid gap-2 list-none p-0">
          {#each libraryHits as t (t.job_id)}
            <li>
              <button
                onclick={() => pickLibrary(t.job_id, t.name)}
                class="w-full flex gap-3 p-2 bg-white dark:bg-paper-800 border border-claude/40 rounded-lg hover:border-claude cursor-pointer transition group text-left"
              >
                <div
                  class="w-32 aspect-video flex items-center justify-center rounded bg-claude/10 shrink-0"
                >
                  <span class="material-symbols-outlined text-claude" style="font-size:28px"
                    >library_music</span
                  >
                </div>
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                  <p class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition">
                    {t.name}
                  </p>
                  <p class="mt-1 text-xs text-claude font-medium uppercase tracking-[0.15em]">
                    in library
                  </p>
                </div>
              </button>
            </li>
          {/each}
          {#each ytSplit.libReplacements as t (t.job_id)}
            <li>
              <button
                onclick={() => pickLibrary(t.job_id, t.name)}
                class="w-full flex gap-3 p-2 bg-white dark:bg-paper-800 border border-claude/40 rounded-lg hover:border-claude cursor-pointer transition group text-left"
              >
                <div
                  class="w-32 aspect-video flex items-center justify-center rounded bg-claude/10 shrink-0"
                >
                  <span class="material-symbols-outlined text-claude" style="font-size:28px"
                    >library_music</span
                  >
                </div>
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                  <p class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition">
                    {t.name}
                  </p>
                  <p class="mt-1 text-xs text-claude font-medium uppercase tracking-[0.15em]">
                    in library
                  </p>
                </div>
              </button>
            </li>
          {/each}
          {#each ytSplit.fresh as r (r.id)}
            <li>
              <button
                onclick={() => pickYT(r)}
                class="w-full flex gap-3 p-2 bg-white dark:bg-paper-800 border border-stone-200 dark:border-stone-800 rounded-lg hover:border-claude/60 cursor-pointer transition group text-left"
              >
                <img
                  src={r.thumbnail}
                  alt=""
                  loading="lazy"
                  class="w-32 aspect-video object-cover rounded bg-stone-200 dark:bg-stone-700 shrink-0"
                />
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                  <p class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition">
                    {r.title}
                  </p>
                  <p class="mt-1 text-xs text-stone-500 dark:text-stone-400 truncate">
                    {r.channel ?? ''}{r.duration
                      ? ` · `
                      : ''}{#if r.duration}<span class="font-mono tabular-nums"
                        >{fmtTime(r.duration)}</span
                      >{/if}
                  </p>
                </div>
              </button>
            </li>
          {/each}
          {#if loading}
            <li class="flex items-center gap-2 text-sm text-stone-500 italic px-2 py-2">
              <span
                class="material-symbols-outlined"
                style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
              >
              {loadingMore ? 'loading more songs…' : totalShown ? 'searching youtube…' : 'searching…'}
            </li>
          {:else if errMsg}
            <li class="text-sm text-red-400 px-2 py-2">search failed: {errMsg}</li>
          {/if}
        </ul>

        {#if hasMore && !loading}
          <button
            type="button"
            onclick={() => fetchPage(false)}
            class="mt-3 w-full px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-800 hover:border-claude/70 hover:text-claude transition"
          >
            load more
          </button>
        {/if}
      {/if}
    </div>
  </div>
</dialog>
