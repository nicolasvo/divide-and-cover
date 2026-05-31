<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { jobs } from '$lib/jobs.svelte';
  import { labelStage } from '$lib/format';

  const stageLabel = $derived(labelStage(app.status.stage) || 'starting…');
  const clampedPct = $derived(Math.max(0, Math.min(100, Math.floor(app.status.percent))));
  // only the backend separation job is cancellable — not the local audio-load phase
  const cancellable = $derived(
    jobs.focusedId !== null && jobs.map[jobs.focusedId]?.status === 'running'
  );
</script>

<section class="rounded-2xl bg-white dark:bg-paper-800 p-8">
  <div class="flex items-center justify-between gap-3 mb-3">
    <div class="flex items-center gap-2 min-w-0">
      <span
        class="material-symbols-outlined shrink-0"
        style="font-size:20px;animation:spin 1.2s linear infinite">progress_activity</span
      >
      <p class="text-lg truncate">{stageLabel}</p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <span class="text-sm text-stone-500 dark:text-stone-400 tabular-nums font-mono">
        {app.status.percent > 0 ? `${clampedPct}%` : ''}
      </span>
      {#if cancellable}
        <button
          class="text-stone-400 hover:text-red-500 transition leading-none"
          title="cancel"
          onclick={() => jobs.focusedId && jobs.cancel(jobs.focusedId)}
        >
          <span class="material-symbols-outlined" style="font-size:18px">close</span>
        </button>
      {/if}
    </div>
  </div>
  <div class="h-2 rounded-full bg-stone-200 dark:bg-stone-700 overflow-hidden">
    <div
      class="h-full bg-claude transition-[width] duration-150 ease-linear"
      style:width="{clampedPct}%"
    ></div>
  </div>
  <p class="mt-3 text-xs text-stone-400 dark:text-stone-500 truncate font-mono">
    {app.status.message}
  </p>
</section>
