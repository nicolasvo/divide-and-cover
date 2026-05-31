// Client-side mirror of the backend's detached separation jobs.
//
// Subscriptions live here, in a module-level store — NOT inside any component —
// so progress keeps flowing while the user switches views, opens the library
// dialog, or backgrounds the tab. `discover()` re-syncs from the server
// (authoritative) and reconnects dropped streams, which is what makes progress
// survive reloads and mobile tab suspension.

import { app } from './state.svelte';
import { cancelJob, jobEvents, listJobs, readNdjson, type JobSnapshot, type StreamEvent } from './api';
import type { Stem } from './player';

export type JobProgress = {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  percent: number;
  message: string;
  videoId?: string | null;
  stems: Record<Stem, string> | null;
  error?: string | null;
  createdAt: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class JobsState {
  /** All known jobs keyed by id (running + recently finished). */
  map = $state<Record<string, JobProgress>>({});
  /** The job whose progress drives the main status view, if any. */
  focusedId = $state<string | null>(null);

  /** Set by the page: invoked once when a job reaches a terminal state. */
  onComplete: ((job: JobProgress) => void) | null = null;

  // ids with a live subscription / already-handled terminal — guards re-entry.
  #subs = new Set<string>();
  #completed = new Set<string>();

  /** Running jobs, newest first — what the library dialog pins at the top. */
  get active(): JobProgress[] {
    return Object.values(this.map)
      .filter((j) => j.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Start tracking a freshly-created job and open its progress stream. */
  start(jobId: string, name: string, opts: { focus?: boolean; videoId?: string | null } = {}) {
    if (!this.map[jobId]) {
      this.map[jobId] = {
        id: jobId,
        name,
        status: 'running',
        stage: 'starting',
        percent: 0,
        message: name,
        videoId: opts.videoId ?? null,
        stems: null,
        createdAt: Date.now() / 1000
      };
    }
    if (opts.focus) this.focusedId = jobId;
    void this.#subscribe(jobId);
  }

  /** Re-sync from the server and reconnect to any running job. */
  async discover() {
    let snaps: JobSnapshot[];
    try {
      snaps = await listJobs();
    } catch {
      return;
    }
    for (const s of snaps) {
      const cur = this.map[s.id];
      // don't let a stale snapshot clobber a job we're actively streaming
      if (!cur || cur.status === 'running') this.#fromSnapshot(s);
      if (s.status === 'running') void this.#subscribe(s.id);
    }
  }

  /** Interrupt a job: drop it locally right away, tell the server to stop. */
  async cancel(jobId: string) {
    const wasFocused = this.focusedId === jobId;
    this.forget(jobId);
    if (wasFocused && app.view === 'status') app.view = 'drop';
    try {
      await cancelJob(jobId);
    } catch {
      // fake/unknown job, or already gone — it's been removed locally regardless
    }
  }

  /** Drop a job from the local store (e.g. once it's in the library list). */
  forget(jobId: string) {
    delete this.map[jobId];
    this.#completed.delete(jobId);
    if (this.focusedId === jobId) this.focusedId = null;
  }

  /** DEV: inject a fake job stuck mid-progress so the UI can be tweaked
   *  without running a real separation. Enable with `?fakejob` in the URL. */
  seedFake(percent = 50) {
    const id = 'fake-job';
    this.map[id] = {
      id,
      name: 'fake song — stuck for UI tweaking',
      status: 'running',
      stage: 'separate',
      percent,
      message: 'separating tracks…',
      videoId: null,
      stems: null,
      createdAt: Date.now() / 1000
    };
  }

  #fromSnapshot(s: JobSnapshot) {
    this.map[s.id] = {
      id: s.id,
      name: s.name,
      status: s.status,
      stage: s.stage,
      percent: s.percent,
      message: s.message,
      videoId: s.video_id ?? null,
      stems: s.stems,
      error: s.error ?? null,
      createdAt: s.created_at || Date.now() / 1000
    };
  }

  #apply(id: string, evt: StreamEvent) {
    const j = this.map[id];
    if (!j) return;
    if (evt.event === 'progress') {
      j.stage = evt.stage;
      j.percent = evt.percent;
    } else if (evt.event === 'stage') {
      j.stage = evt.stage;
      j.percent = 0;
      if (evt.message) j.message = evt.message;
    } else if (evt.event === 'log') {
      j.message = evt.message;
    } else if (evt.event === 'done') {
      j.status = 'done';
      j.percent = 100;
      j.stems = evt.stems;
    } else if (evt.event === 'error') {
      j.status = 'error';
      j.error = evt.message;
      j.message = evt.message;
    }

    // mirror the focused job into the shared status view (ProgressView reads it)
    if (id === this.focusedId && j.status === 'running') {
      app.status = { stage: j.stage, percent: j.percent, message: j.message };
    }

    if (j.status !== 'running' && !this.#completed.has(id)) {
      this.#completed.add(id);
      this.onComplete?.(j);
    }
  }

  async #subscribe(jobId: string) {
    if (this.#subs.has(jobId)) return;
    this.#subs.add(jobId);
    try {
      // reconnect loop: if the stream drops while the job is still running
      // (tab suspended, network blip) we re-open it.
      while (this.map[jobId]?.status === 'running') {
        const ac = new AbortController();
        try {
          const res = await jobEvents(jobId, ac.signal);
          if (res.status === 404) break; // job gone server-side
          if (!res.ok || !res.body) {
            await sleep(1000);
            continue;
          }
          for await (const evt of readNdjson(res)) this.#apply(jobId, evt);
        } catch {
          // network error — fall through to the reconnect delay
        }
        if (this.map[jobId]?.status === 'running') await sleep(1000);
      }
    } finally {
      this.#subs.delete(jobId);
    }
  }
}

export const jobs = new JobsState();
