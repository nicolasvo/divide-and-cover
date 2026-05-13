<script lang="ts">
  import { tick } from 'svelte';
  import { engine, app } from '$lib/state.svelte';
  import { fmtTime } from '$lib/format';
  import { renameTrack } from '$lib/api';
  import StemControls from './StemControls.svelte';

  type Props = { onReset: () => void };
  let { onReset }: Props = $props();

  const trackName = $derived(app.currentTrack?.name ?? '');
  const t = $derived(app.player.currentTime);
  const dur = $derived(app.player.duration);
  const playing = $derived(app.player.playing);
  const seekPct = $derived(dur ? (t / dur) * 100 : 0);

  function onSeek(ev: Event) {
    engine.seekTo(parseFloat((ev.target as HTMLInputElement).value));
  }

  // --- inline rename --------------------------------------------------------

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  async function startEdit() {
    if (!app.currentTrack || editing) return;
    draft = app.currentTrack.name;
    editing = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function cancelEdit() {
    editing = false;
    draft = '';
  }

  async function commitEdit() {
    if (!editing || !app.currentTrack || saving) return;
    const normalized = draft.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      cancelEdit();
      return;
    }
    if (normalized === app.currentTrack.name) {
      editing = false;
      return;
    }
    saving = true;
    try {
      const { name } = await renameTrack(app.currentTrack.jobId, normalized);
      const jobId = app.currentTrack.jobId;
      app.currentTrack = { ...app.currentTrack, name };
      app.tracks = app.tracks.map((tr) => (tr.job_id === jobId ? { ...tr, name } : tr));
      editing = false;
    } catch {
      // keep editing mode so the user can retry; field stays focused
    } finally {
      saving = false;
    }
  }

  function onEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      startEdit();
    }
  }
</script>

<section class="rounded-2xl bg-white dark:bg-paper-800 p-6">
  {#if editing}
    <input
      bind:this={inputEl}
      bind:value={draft}
      onkeydown={onEditKeydown}
      onblur={commitEdit}
      disabled={saving}
      type="text"
      class="block w-full text-xl mb-5 italic bg-transparent border-b border-claude/60 focus:border-claude outline-none transition disabled:opacity-60"
    />
  {:else}
    <h2
      onclick={startEdit}
      onkeydown={onTitleKeydown}
      role="button"
      tabindex="0"
      title="click to rename"
      class="text-xl mb-5 break-words italic cursor-text hover:text-claude transition"
    >
      {trackName}
    </h2>
  {/if}

  <div class="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 lg:gap-2 mb-6">
    <div class="flex items-center gap-2 lg:order-2 lg:flex-1">
      <input
        id="seek"
        type="range"
        min="0"
        max={dur || 100}
        step="0.01"
        value={t}
        style:--p={seekPct.toFixed(2)}
        oninput={onSeek}
        class="flex-1"
      />
      <span class="text-sm text-stone-500 dark:text-stone-400 tabular-nums font-mono">
        {fmtTime(t)} / {fmtTime(dur)}
      </span>
    </div>
    <div class="flex items-center justify-center lg:justify-start gap-2 lg:order-1">
      <button
        onclick={() => engine.nudge(-5)}
        title="back 5s (←)"
        class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude text-sm tabular-nums font-mono transition"
        >−5s</button
      >
      <button
        onclick={() => engine.toggle()}
        aria-label={playing ? 'pause' : 'play'}
        class="w-12 h-12 rounded-full bg-claude hover:bg-claude-300 text-paper-50 flex items-center justify-center transition shrink-0"
      >
        <span class="material-symbols-outlined" style="font-size:28px">
          {playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <button
        onclick={() => engine.nudge(5)}
        title="forward 5s (→)"
        class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude text-sm tabular-nums font-mono transition"
        >+5s</button
      >
    </div>
  </div>

  <StemControls />

  <button
    onclick={onReset}
    class="w-full px-3 py-2.5 rounded-lg border border-claude/50 text-claude hover:bg-claude hover:text-paper-50 hover:border-claude transition text-sm font-medium flex items-center justify-center gap-2"
  >
    select another song
  </button>
</section>
