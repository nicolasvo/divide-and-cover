<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { fmtDate } from '$lib/format';
  import { deleteTrack, type Track } from '$lib/api';

  type Props = {
    open: boolean;
    onClose: () => void;
    onLoad: (jobId: string, name: string) => void;
    onAfterDelete: () => void;
  };
  let { open, onClose, onLoad, onAfterDelete }: Props = $props();

  let dialog: HTMLDialogElement | null = $state(null);
  let filter = $state('');
  let confirming = $state<string | null>(null); // job_id being confirmed for delete

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      filter = '';
      confirming = null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return app.tracks;
    return app.tracks.filter((t) => (t.name || '').toLowerCase().includes(q));
  });

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  async function confirmDelete(t: Track) {
    try {
      await deleteTrack(t.job_id);
    } catch {
      /* swallow — caller refreshes anyway */
    }
    confirming = null;
    onAfterDelete();
  }

  function onItemClick(t: Track) {
    confirming = null;
    onClose();
    onLoad(t.job_id, t.name);
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') confirming = null;
  }}
  onclick={() => {
    // dismiss confirm if user clicks elsewhere
    confirming = null;
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
      <h2 class="text-xl italic">library</h2>
      <button
        type="button"
        aria-label="close"
        onclick={onClose}
        class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
      >
        <span class="material-symbols-outlined" style="font-size:20px">close</span>
      </button>
    </header>

    <div class="px-5 py-4">
      <input
        type="search"
        autocomplete="off"
        placeholder="filter by title"
        bind:value={filter}
        class="w-full h-11 px-4 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-paper-800 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-claude transition"
      />
    </div>

    <div class="flex-1 overflow-y-auto px-5 pb-5">
      {#if filtered.length === 0}
        <p class="mt-3 text-sm text-stone-500 dark:text-stone-400 italic text-center">
          no tracks match
        </p>
      {:else}
        <ul class="grid gap-2 list-none p-0">
          {#each filtered as t (t.job_id)}
            <li
              class="relative overflow-hidden flex items-center gap-2 px-3 py-2 bg-white dark:bg-paper-800 rounded-lg transition"
            >
              <button
                class="flex-1 min-w-0 text-left truncate hover:text-claude transition"
                title={t.name}
                onclick={(e) => {
                  e.stopPropagation();
                  onItemClick(t);
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
    </div>
  </div>
</dialog>
