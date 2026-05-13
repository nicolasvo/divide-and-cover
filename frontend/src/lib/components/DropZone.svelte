<script lang="ts">
  import { app } from '$lib/state.svelte';

  type Props = {
    onFile: (f: File) => void;
    onOpenSearch: () => void;
    onOpenLibrary: () => void;
  };
  let { onFile, onOpenSearch, onOpenLibrary }: Props = $props();

  let hot = $state(false);
  let fileInput: HTMLInputElement;

  const hasLibrary = $derived(app.tracks.length > 0);

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    hot = true;
  }
  function onDragOver(e: DragEvent) {
    e.preventDefault();
    hot = true;
  }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    hot = false;
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    hot = false;
    const f = e.dataTransfer?.files[0];
    if (f) onFile(f);
  }
  function onPick(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) onFile(f);
  }
</script>

<section
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  class="rounded-2xl border border-dashed p-12 text-center transition-colors {hot
    ? 'border-claude bg-claude/10'
    : 'border-stone-300 dark:border-stone-700 bg-white dark:bg-paper-800'}"
>
  <input type="file" accept="audio/*" hidden bind:this={fileInput} onchange={onPick} />
  <p class="text-xl mb-3">drag &amp; drop an audio file</p>

  <button
    type="button"
    onclick={() => fileInput.click()}
    class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude transition"
  >
    <span class="material-symbols-outlined" style="font-size:20px">folder_open</span>
    <span>browse</span>
  </button>

  <div class="flex items-center gap-3 my-6 max-w-xs mx-auto">
    <span class="flex-1 h-px bg-stone-300 dark:bg-stone-700"></span>
    <span class="text-xs uppercase tracking-[0.2em] text-stone-500 dark:text-stone-400">or</span>
    <span class="flex-1 h-px bg-stone-300 dark:bg-stone-700"></span>
  </div>

  <button
    type="button"
    onclick={onOpenSearch}
    class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude transition"
  >
    <span class="material-symbols-outlined" style="font-size:20px">search</span>
    <span>search youtube</span>
  </button>

  {#if hasLibrary}
    <div class="flex items-center gap-3 my-6 max-w-xs mx-auto">
      <span class="flex-1 h-px bg-stone-300 dark:bg-stone-700"></span>
      <span class="text-xs uppercase tracking-[0.2em] text-stone-500 dark:text-stone-400">or</span>
      <span class="flex-1 h-px bg-stone-300 dark:bg-stone-700"></span>
    </div>

    <button
      type="button"
      onclick={onOpenLibrary}
      class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude transition"
    >
      <span class="material-symbols-outlined" style="font-size:20px">library_music</span>
      <span>open library</span>
    </button>
  {/if}
</section>
