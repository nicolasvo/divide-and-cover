<script lang="ts">
  import { engine, app, STEMS, type Stem } from '$lib/state.svelte';

  function toggleStem(s: Stem) {
    engine.setMuted(s, !app.player.muted[s]);
  }
  function setVol(s: Stem, ev: Event) {
    engine.setVolume(s, parseFloat((ev.target as HTMLInputElement).value));
  }

  const toggleBase =
    'toggle w-28 px-3 py-1.5 rounded-md border text-sm capitalize transition';
  const toggleOn = 'bg-claude text-paper-50 border-claude hover:bg-claude-300';
  const toggleOff =
    'bg-transparent text-stone-500 dark:text-stone-500 border-stone-300 dark:border-stone-700 hover:border-stone-500 dark:hover:border-stone-500';
</script>

<ul class="grid gap-2 mb-4 list-none p-0">
  {#each STEMS as stem (stem)}
    {@const on = !app.player.muted[stem]}
    {@const v = app.player.volumes[stem]}
    <li class="flex items-center gap-3 px-3 py-2.5 bg-paper-100 dark:bg-paper-900/60 rounded-lg">
      <button class="{toggleBase} {on ? toggleOn : toggleOff}" onclick={() => toggleStem(stem)}>
        {stem}
      </button>
      <input
        type="range"
        class="vol flex-1"
        min="0"
        max="1"
        step="0.01"
        value={v}
        style:--p={(v * 100).toFixed(2)}
        oninput={(e) => setVol(stem, e)}
      />
    </li>
  {/each}
</ul>
