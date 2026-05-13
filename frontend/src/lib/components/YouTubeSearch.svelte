<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { fmtTime, fmtDate } from '$lib/format';
  import {
    ytSearch,
    fetchVideoInfo,
    deleteTrack,
    type YTHit,
    type Track
  } from '$lib/api';

  type Props = {
    open: boolean;
    onClose: () => void;
    onLoadLibrary: (jobId: string, name: string) => void;
    onPickYouTube: (videoId: string, title: string) => void;
    onAfterDelete: () => void;
    onFile: (file: File) => void;
  };
  let {
    open,
    onClose,
    onLoadLibrary,
    onPickYouTube,
    onAfterDelete,
    onFile
  }: Props = $props();

  const PAGE = 10;

  // Recognize a bare 11-char video ID (typical YouTube ID) or any common URL form.
  const YT_BARE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const YT_URL_RE =
    /(?:youtube\.com\/(?:watch\?(?:[^&\s]*&)*v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
  const YT_URLISH_RE = /^\s*(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\b/i;

  function extractVideoId(text: string): string | null {
    const t = text.trim();
    if (!t) return null;
    if (YT_BARE_ID_RE.test(t)) return t;
    const m = t.match(YT_URL_RE);
    return m ? m[1] : null;
  }

  function looksLikeYouTubeUrl(text: string): boolean {
    return YT_URLISH_RE.test(text);
  }

  let videoLookupSeq = 0;

  let dialog: HTMLDialogElement | null = $state(null);
  let q = $state(''); // current input value (live)
  let activeQuery = $state(''); // last submitted query — switches view to youtube mode
  let results = $state<YTHit[]>([]);
  let offset = $state(0);
  let hasMore = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  let errMsg = $state('');
  let inputEl: HTMLInputElement | null = $state(null);
  let fileInputEl: HTMLInputElement | null = $state(null);
  let confirming = $state<string | null>(null); // job_id whose delete swipe is revealed

  function handleFilePick(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    onClose();
    onFile(f);
    // reset the input so picking the same file twice still fires `change`
    if (fileInputEl) fileInputEl.value = '';
  }

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
    confirming = null;
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  function onInput() {
    errMsg = '';
    // typing dismisses any in-flight delete-confirm overlay
    confirming = null;
  }

  async function lookupVideo(id: string) {
    const seq = ++videoLookupSeq;
    results = [];
    offset = 0;
    hasMore = false;
    activeQuery = id; // switches mode to 'youtube'
    loading = true;
    loadingMore = false;
    try {
      const info = await fetchVideoInfo(id);
      if (seq !== videoLookupSeq) return;
      results = [info];
      offset = 0;
      hasMore = false;
      errMsg = '';
    } catch {
      if (seq !== videoLookupSeq) return;
      errMsg = "couldn't find that video — check the url";
    } finally {
      if (seq === videoLookupSeq) loading = false;
    }
  }

  function clearQuery() {
    // explicit "back to library" — wipes search state, dialog reverts to library mode
    q = '';
    activeQuery = '';
    results = [];
    offset = 0;
    hasMore = false;
    errMsg = '';
    inputEl?.focus();
  }

  function dedupeById(arr: YTHit[]): YTHit[] {
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
      results = [];
      offset = 0;
      hasMore = false;
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
    const id = extractVideoId(q);
    if (id) {
      void lookupVideo(id);
      return;
    }
    if (looksLikeYouTubeUrl(q)) {
      results = [];
      offset = 0;
      hasMore = false;
      activeQuery = q.trim();
      errMsg = 'that url looks incomplete — paste the full youtube link';
      return;
    }
    void fetchPage(true);
  }

  // --- library-mode data (shown when activeQuery is empty) -----------------

  const trimmedQ = $derived(q.trim().toLowerCase());

  const filteredLibrary = $derived.by(() => {
    if (!trimmedQ) return app.tracks;
    return app.tracks.filter((t) => (t.name || '').toLowerCase().includes(trimmedQ));
  });

  // --- youtube-mode data (shown after a search has been submitted) --------

  // map video_id → library track so YT hits that are already in the library
  // render as "in library" rather than as a re-download option
  const byVideoId = $derived.by(() => {
    const m = new Map<string, Track>();
    for (const t of app.tracks) if (t.video_id) m.set(t.video_id, t);
    return m;
  });

  const ytSplit: { libReplacements: Track[]; fresh: YTHit[] } = $derived.by(() => {
    const seen = new Set<string>();
    const libReplacements: Track[] = [];
    const fresh: YTHit[] = [];
    for (const r of results) {
      const lib = byVideoId.get(r.id);
      if (lib) {
        if (!seen.has(lib.job_id)) {
          libReplacements.push(lib);
          seen.add(lib.job_id);
        }
      } else {
        fresh.push(r);
      }
    }
    return { libReplacements, fresh };
  });

  const ytTotalShown = $derived(ytSplit.libReplacements.length + ytSplit.fresh.length);

  // --- actions --------------------------------------------------------------

  function pickLibrary(t: Track) {
    confirming = null;
    onClose();
    onLoadLibrary(t.job_id, t.name);
  }

  function pickYT(r: YTHit) {
    onClose();
    onPickYouTube(r.id, r.title);
  }

  async function confirmDelete(t: Track) {
    try {
      await deleteTrack(t.job_id);
    } catch {
      /* ignore — caller refreshes the library either way */
    }
    confirming = null;
    onAfterDelete();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') confirming = null;
  }}
/>

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
      <h2 class="text-xl italic">
        {activeQuery ? 'search youtube' : 'library'}
      </h2>
      <div class="flex items-center gap-2">
        <input
          bind:this={fileInputEl}
          type="file"
          accept="audio/*"
          hidden
          onchange={handleFilePick}
        />
        <button
          type="button"
          aria-label="upload audio file"
          title="upload audio file"
          onclick={() => fileInputEl?.click()}
          class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
        >
          <span class="material-symbols-outlined" style="font-size:20px">upload_file</span>
        </button>
        <button
          type="button"
          aria-label="close"
          onclick={onClose}
          class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
        >
          <span class="material-symbols-outlined" style="font-size:20px">close</span>
        </button>
      </div>
    </header>

    <form onsubmit={onSubmit} class="flex gap-2 px-5 py-4">
      <div class="relative flex-1">
        <input
          bind:this={inputEl}
          bind:value={q}
          oninput={onInput}
          type="search"
          autocomplete="off"
          placeholder={activeQuery ? 'search youtube…' : 'filter library or search youtube…'}
          class="w-full h-11 pl-4 pr-10 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-paper-800 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-claude transition"
        />
        {#if q.length > 0 || activeQuery}
          <button
            type="button"
            aria-label={activeQuery ? 'back to library' : 'clear'}
            onclick={clearQuery}
            class="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full text-stone-500 hover:text-claude transition flex items-center justify-center"
          >
            <span class="material-symbols-outlined" style="font-size:18px">close</span>
          </button>
        {/if}
      </div>
      <button
        type="submit"
        aria-label="search youtube"
        disabled={loading}
        class="h-11 w-11 rounded-lg bg-claude hover:bg-claude-300 text-paper-50 flex items-center justify-center transition shrink-0 {loading
          ? 'opacity-60 cursor-wait'
          : ''}"
      >
        <span class="material-symbols-outlined" style="font-size:22px">search</span>
      </button>
    </form>

    <div class="flex-1 overflow-y-auto px-5 pb-5">
      {#if !activeQuery}
        <!-- ============ LIBRARY MODE ============ -->
        {#if filteredLibrary.length === 0}
          <p class="mt-3 text-sm text-stone-500 dark:text-stone-400 italic text-center">
            {app.tracks.length === 0 ? 'no tracks yet' : 'no tracks match'}
          </p>
        {:else}
          <ul class="grid gap-2 list-none p-0">
            {#each filteredLibrary as t (t.job_id)}
              <li
                class="relative overflow-hidden flex items-center gap-2 px-3 py-2 bg-white dark:bg-paper-800 rounded-lg transition"
              >
                <button
                  class="flex-1 min-w-0 text-left truncate hover:text-claude transition"
                  title={t.name}
                  onclick={(e) => {
                    e.stopPropagation();
                    pickLibrary(t);
                  }}
                >
                  {t.name}
                </button>
                <span class="text-xs text-stone-500 tabular-nums font-mono shrink-0">
                  {fmtDate(t.created_at)}
                </span>
                <button
                  class="px-2 py-1 text-stone-500 hover:text-claude transition shrink-0"
                  title="delete"
                  onclick={(e) => {
                    e.stopPropagation();
                    confirming = t.job_id;
                  }}
                >
                  ✕
                </button>

                <button
                  tabindex="-1"
                  onclick={(e) => {
                    e.stopPropagation();
                    if (confirming === t.job_id) confirmDelete(t);
                  }}
                  class="absolute inset-0 bg-red-500 hover:bg-red-400 text-white text-sm font-medium flex items-center justify-between px-4 gap-6 transition-transform duration-200 {confirming ===
                  t.job_id
                    ? 'translate-x-0'
                    : 'translate-x-full'}"
                >
                  <span class="flex-1 min-w-0 truncate text-left">{t.name}</span>
                  <span class="flex items-center gap-1.5 shrink-0">
                    are you sure?
                    <span class="material-symbols-outlined" style="font-size:18px">delete</span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <!-- ============ YOUTUBE MODE ============ -->
        {#if ytTotalShown === 0 && !loading && !errMsg}
          <p class="mt-3 text-sm text-stone-500 dark:text-stone-400 italic text-center">
            no results
          </p>
        {:else}
          <ul class="grid gap-2 list-none p-0">
            {#if loading && !loadingMore}
              <li class="flex items-center gap-2 text-sm text-stone-500 italic px-2 py-2">
                <span
                  class="material-symbols-outlined"
                  style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
                >
                {ytTotalShown ? 'searching youtube…' : 'searching…'}
              </li>
            {/if}
            {#each ytSplit.libReplacements as t (t.job_id)}
              <li>
                <button
                  onclick={() => pickLibrary(t)}
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
                    <p
                      class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition"
                    >
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
              <li class="flex gap-2 items-stretch">
                <button
                  onclick={() => pickYT(r)}
                  class="flex-1 min-w-0 flex gap-3 p-2 bg-white dark:bg-paper-800 border border-stone-200 dark:border-stone-800 rounded-lg hover:border-claude/60 cursor-pointer transition group text-left"
                >
                  <img
                    src={r.thumbnail}
                    alt=""
                    loading="lazy"
                    class="w-32 aspect-video object-cover rounded bg-stone-200 dark:bg-stone-700 shrink-0"
                  />
                  <div class="flex-1 min-w-0 flex flex-col justify-center">
                    <p
                      class="text-sm leading-snug line-clamp-2 group-hover:text-claude transition"
                    >
                      {r.title}
                    </p>
                    <p class="mt-1 text-xs text-stone-500 dark:text-stone-400 truncate">
                      {r.channel ?? ''}{r.duration ? ` · ` : ''}{#if r.duration}<span
                          class="font-mono tabular-nums">{fmtTime(r.duration)}</span
                        >{/if}
                    </p>
                  </div>
                </button>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="preview on youtube"
                  aria-label="preview on youtube"
                  class="shrink-0 w-10 flex items-center justify-center rounded-lg border border-stone-200 dark:border-stone-800 text-stone-500 hover:text-claude hover:border-claude/60 transition"
                >
                  <span class="material-symbols-outlined" style="font-size:20px">open_in_new</span>
                </a>
              </li>
            {/each}
            {#if loading && loadingMore}
              <li class="flex items-center gap-2 text-sm text-stone-500 italic px-2 py-2">
                <span
                  class="material-symbols-outlined"
                  style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
                >
                loading more songs…
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
      {/if}
    </div>
  </div>
</dialog>
