<script lang="ts">
  import { engine, app } from '$lib/state.svelte';

  type Props = {
    open: boolean;
    onClose: () => void;
  };
  let { open, onClose }: Props = $props();

  let dialog: HTMLDialogElement | null = $state(null);
  const pitch = $derived(app.player.pitch);
  const processing = $derived(app.player.pitchProcessing);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  function onLiveChange(e: Event) {
    // visual + state update only — the audio doesn't actually re-render until
    // the user releases the slider (oncommit).
    engine.setPitchPreview(parseInt((e.target as HTMLInputElement).value, 10));
  }

  function onCommit(e: Event) {
    void engine.commitPitch(parseInt((e.target as HTMLInputElement).value, 10));
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  function reset() {
    void engine.commitPitch(0);
  }

  const label = $derived(pitch === 0 ? 'original key' : `${pitch > 0 ? '+' : ''}${pitch} st`);
</script>

<dialog
  bind:this={dialog}
  onclose={onClose}
  onclick={onBackdrop}
  class="app-dialog bg-paper-50 text-paper-900 dark:bg-paper-900 dark:text-paper-50 font-serif"
>
  <div class="flex flex-col">
    <header
      class="flex items-center justify-between px-5 py-4 border-b border-stone-200 dark:border-stone-800"
    >
      <h2 class="text-xl italic">pitch</h2>
      <button
        type="button"
        aria-label="close"
        onclick={onClose}
        class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
      >
        <span class="material-symbols-outlined" style="font-size:20px">close</span>
      </button>
    </header>

    <div class="px-6 py-6 flex flex-col items-center gap-4">
      <p class="text-3xl italic text-claude tabular-nums font-mono">{label}</p>

      <input
        type="range"
        min="-12"
        max="12"
        step="1"
        value={pitch}
        style:--p={((pitch + 12) / 24) * 100}
        oninput={onLiveChange}
        onchange={onCommit}
        disabled={processing}
        class="w-full {processing ? 'opacity-60 cursor-wait' : ''}"
      />
      <div
        class="w-full flex justify-between text-xs text-stone-500 dark:text-stone-400 tabular-nums font-mono"
      >
        <span>-12</span>
        <span>0</span>
        <span>+12</span>
      </div>

      {#if processing}
        <p class="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400 italic">
          <span
            class="material-symbols-outlined"
            style="font-size:18px;animation:spin 1.2s linear infinite">progress_activity</span
          >
          rendering stems with the new pitch…
        </p>
      {/if}

      <button
        type="button"
        onclick={reset}
        disabled={pitch === 0 || processing}
        class="mt-2 px-4 py-2 rounded-lg border border-stone-300 dark:border-stone-700 hover:border-claude/70 hover:text-claude text-sm transition disabled:opacity-50 disabled:cursor-default disabled:hover:border-stone-300 dark:disabled:hover:border-stone-700 disabled:hover:text-current"
      >
        reset to original
      </button>
      <p class="text-xs italic text-stone-500 dark:text-stone-400 text-center mt-1 max-w-sm">
        each shift re-renders all four stems offline with formant preservation
        — takes a few seconds, then plays at full quality.
      </p>
    </div>
  </div>
</dialog>
