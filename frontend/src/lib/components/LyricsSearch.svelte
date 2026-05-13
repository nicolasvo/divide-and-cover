<script lang="ts">
  import { fmtTime } from '$lib/format';
  import { searchLyrics, type LyricsSearchHit } from '$lib/api';

  type Props = {
    open: boolean;
    seed: string;
    trackDuration: number;
    currentId: number | null;
    onClose: () => void;
    onPick: (hit: LyricsSearchHit) => void;
  };
  let { open, seed, trackDuration, currentId, onClose, onPick }: Props = $props();

  const DUR_TOL = 0.5;

  let dialog: HTMLDialogElement | null = $state(null);
  let q = $state(''); // live input value
  let activeQuery = $state(''); // last submitted query — gates the "no results" message
  let results = $state<LyricsSearchHit[]>([]);
  let loading = $state(false);
  let errMsg = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      q = seed;
      activeQuery = '';
      results = [];
      errMsg = '';
      dialog.showModal();
      setTimeout(() => {
        inputEl?.focus();
        inputEl?.select();
      }, 0);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  async function submit(e: Event) {
    e.preventDefault();
    const query = q.trim();
    if (!query || loading) return;
    activeQuery = query;
    results = []; // clear before showing the spinner
    loading = true;
    errMsg = '';
    try {
      results = await searchLyrics(query);
    } catch (err) {
      errMsg = String(err).slice(0, 200);
      results = [];
    } finally {
      loading = false;
    }
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  function durationMatches(r: LyricsSearchHit): boolean {
    return (
      !!trackDuration && !!r.duration && Math.abs(r.duration - trackDuration) <= DUR_TOL
    );
  }

  function flagsFor(r: LyricsSearchHit): string[] {
    const out: string[] = [];
    if (r.has_sync) out.push('synced');
    else if (r.has_plain) out.push('plain');
    if (r.instrumental) out.push('instrumental');
    return out;
  }
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
      <h2 class="text-xl italic">search lyrics</h2>
      <button
        type="button"
        aria-label="close"
        onclick={onClose}
        class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
      >
        <span class="material-symbols-outlined" style="font-size:20px">close</span>
      </button>
    </header>

    <form onsubmit={submit} class="flex gap-2 px-5 py-4">
      <input
        bind:this={inputEl}
        bind:value={q}
        type="search"
        autocomplete="off"
        placeholder="artist - title"
        class="flex-1 h-11 px-4 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-paper-800 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-claude transition"
      />
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
      {#if !activeQuery && !loading && !errMsg}
        <p class="text-sm text-stone-500 dark:text-stone-400 italic text-center py-8">
          type a query and press enter
        </p>
      {/if}
      {#if loading && !results.length}
        <ul class="grid gap-2 list-none p-0">
          <li class="flex items-center gap-2 text-sm text-stone-500 italic px-2 py-2">
            <span
              class="material-symbols-outlined"
              style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
            >
            searching…
          </li>
        </ul>
      {/if}
      {#if errMsg}
        <p class="text-sm text-red-400 px-2 py-2">search failed: {errMsg}</p>
      {/if}
      {#if results.length}
        <ul class="grid gap-2 list-none p-0">
          {#each results as r (r.id)}
            {@const matches = durationMatches(r)}
            {@const flags = flagsFor(r)}
            {@const isCurrent = currentId === r.id}
            <li>
              <button
                onclick={() => onPick(r)}
                class="w-full flex items-baseline gap-3 px-3 py-2 bg-white dark:bg-paper-800 border rounded-lg cursor-pointer transition group text-left {isCurrent
                  ? 'border-claude/60 hover:border-claude'
                  : 'border-stone-200 dark:border-stone-800 hover:border-claude/60'}"
              >
                <div class="flex-1 min-w-0">
                  <p class="text-sm leading-snug truncate group-hover:text-claude transition">
                    <span class="italic">{r.title ?? ''}</span>
                  </p>
                  <p class="mt-0.5 text-xs text-stone-500 dark:text-stone-400 truncate">
                    {r.artist ?? ''}{r.album ? ` · ${r.album}` : ''}{flags.length
                      ? ` · ${flags.join(', ')}`
                      : ''}{isCurrent ? ' · ' : ''}{#if isCurrent}<span
                        class="text-claude font-medium uppercase tracking-[0.15em]">current</span
                      >{/if}
                  </p>
                </div>
                <span
                  class="text-sm font-mono tabular-nums shrink-0 {matches
                    ? 'text-claude font-semibold'
                    : 'text-stone-500 dark:text-stone-400'}"
                >
                  {r.duration ? fmtTime(r.duration) : '—'}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if activeQuery && !results.length && !loading && !errMsg}
        <p class="mt-3 text-sm text-stone-500 dark:text-stone-400 italic text-center">no results</p>
      {/if}
    </div>
  </div>
</dialog>
