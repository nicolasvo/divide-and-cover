<script lang="ts">
  import { onMount } from 'svelte';
  import { engine, app, STEMS, type Stem } from '$lib/state.svelte';
  import {
    listTracks,
    readNdjson,
    separateFile,
    separateYouTube,
    stemUrlsFor,
    type StreamEvent
  } from '$lib/api';

  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import DropZone from '$lib/components/DropZone.svelte';
  import ProgressView from '$lib/components/ProgressView.svelte';
  import Player from '$lib/components/Player.svelte';
  import Library from '$lib/components/Library.svelte';
  import YouTubeSearch from '$lib/components/YouTubeSearch.svelte';
  import Lyrics from '$lib/components/Lyrics.svelte';

  let libraryOpen = $state(false);
  let searchOpen = $state(false);

  async function refreshLibrary() {
    try {
      app.tracks = await listTracks();
    } catch {
      app.tracks = [];
    }
  }

  onMount(() => {
    refreshLibrary();
  });

  // --- upload + youtube separation flow (NDJSON streaming) ------------------

  async function runSeparation(makeRequest: () => Promise<Response>) {
    let res: Response;
    try {
      res = await makeRequest();
    } catch (e) {
      return fail(`request failed: ${e}`);
    }
    if (!res.ok || !res.body) {
      const err = await res.text();
      return fail(`split failed: ${err.slice(0, 400)}`);
    }

    let done: Extract<StreamEvent, { event: 'done' }> | null = null;
    try {
      for await (const evt of readNdjson(res)) {
        if (evt.event === 'progress') {
          app.status = { stage: evt.stage, percent: evt.percent, message: app.status.message };
        } else if (evt.event === 'stage') {
          app.status = { stage: evt.stage, percent: 0, message: evt.message ?? '' };
        } else if (evt.event === 'log') {
          app.status = { stage: evt.stage, percent: app.status.percent, message: evt.message };
        } else if (evt.event === 'error') {
          return fail(evt.message);
        } else if (evt.event === 'done') {
          done = evt;
        }
      }
    } catch (e) {
      return fail(`stream error: ${e}`);
    }
    if (!done) return fail('no result from server');

    app.status = { stage: 'loading', percent: 0, message: 'decoding tracks…' };
    await loadPlayer(done.job_id, done.name, done.stems);
    refreshLibrary();
  }

  async function loadPlayer(
    jobId: string,
    name: string,
    stemUrls: Record<Stem, string>
  ): Promise<void> {
    app.view = 'status';
    try {
      await engine.load(stemUrls, (pct) => {
        app.status = { ...app.status, percent: pct };
      });
    } catch (e) {
      return fail(`load failed: ${e}`);
    }
    app.currentTrack = { jobId, name };
    app.view = 'player';
  }

  function fail(msg: string) {
    app.status = { stage: 'failed', percent: 0, message: msg };
    setTimeout(() => {
      if (app.view === 'status') app.view = 'drop';
    }, 4000);
  }

  async function onFile(file: File) {
    app.view = 'status';
    app.status = { stage: 'uploading', percent: 0, message: file.name };
    await runSeparation(() => separateFile(file));
  }

  async function onYoutubePick(videoId: string, title: string) {
    app.view = 'status';
    app.status = { stage: 'downloading_audio', percent: 0, message: title };
    await runSeparation(() => separateYouTube(videoId, title));
  }

  async function loadFromLibrary(jobId: string, name: string) {
    engine.pause();
    app.view = 'status';
    app.status = { stage: 'loading', percent: 0, message: name };
    try {
      await engine.load(stemUrlsFor(jobId), (pct) => {
        app.status = { ...app.status, percent: pct };
      });
      app.currentTrack = { jobId, name };
      app.view = 'player';
    } catch (e) {
      fail(`load failed: ${e}`);
    }
  }

  function onReset() {
    engine.reset();
    app.currentTrack = null;
    app.view = 'drop';
    refreshLibrary();
  }

  // --- keyboard shortcuts (only when player visible) ------------------------

  function isTextEntry(el: HTMLElement | null): boolean {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      // text-like inputs swallow keys; range / checkbox / radio / buttons don't
      const t = (el as HTMLInputElement).type;
      return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit';
    }
    return false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (isTextEntry(e.target as HTMLElement | null)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      engine.toggle();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      engine.nudge(-5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      engine.nudge(5);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<main class="mx-auto max-w-2xl px-6 py-14 lg:max-w-none lg:px-10">
  <header class="mb-10 flex items-center justify-between gap-4 lg:max-w-[36rem]">
    <h1 class="text-4xl font-semibold tracking-tight italic text-claude leading-none">
      divide and cover
    </h1>
    <ThemeToggle />
  </header>

  <div class="lg:flex lg:items-start lg:gap-8">
    <div class="lg:w-[36rem] lg:flex-none lg:min-w-0">
      <h3 class="text-xs uppercase tracking-[0.2em] text-stone-500 mb-3">player</h3>

      {#if app.view === 'drop'}
        <DropZone
          onFile={onFile}
          onOpenSearch={() => (searchOpen = true)}
          onOpenLibrary={() => (libraryOpen = true)}
        />
      {:else if app.view === 'status'}
        <ProgressView />
      {:else}
        <Player onReset={onReset} />
      {/if}
    </div>

    <Lyrics />
  </div>
</main>

<Library
  open={libraryOpen}
  onClose={() => (libraryOpen = false)}
  onLoad={loadFromLibrary}
  onAfterDelete={() => {
    refreshLibrary();
    // close if library went empty
    if (app.tracks.length === 0) libraryOpen = false;
  }}
/>

<YouTubeSearch
  open={searchOpen}
  onClose={() => (searchOpen = false)}
  onLoadLibrary={loadFromLibrary}
  onPickYouTube={onYoutubePick}
/>
