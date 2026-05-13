// Web Audio engine — N independent stem buffers playing in lockstep with
// per-stem gain/mute. Pitch shift is OFFLINE: when the user commits a new
// pitch, we re-render all stems through Rubber Band (with formant
// preservation) into fresh AudioBuffers, then swap them in. No realtime
// pitch filter in the graph.

import { shiftBuffer } from './pitchShift';

export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export type PlayerSnapshot = {
  playing: boolean;
  currentTime: number;
  duration: number;
  muted: Record<Stem, boolean>;
  volumes: Record<Stem, number>;
  pitch: number;
  pitchProcessing: boolean;
};

export class StemPlayer {
  private ctx: AudioContext | null = null;
  // originals are the un-shifted decoded MP3s; play is what's actually
  // wired to BufferSources. They're identical at pitch=0, diverge otherwise.
  private originals: Partial<Record<Stem, AudioBuffer>> = {};
  private play_: Partial<Record<Stem, AudioBuffer>> = {};
  private gains: Partial<Record<Stem, GainNode>> = {};
  private sources: Partial<Record<Stem, AudioBufferSourceNode>> = {};
  private muted: Record<Stem, boolean> = { vocals: false, drums: false, bass: false, other: false };
  private volumes: Record<Stem, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };
  private pitch = 0;
  private pitchProcessing = false;
  private pitchInflightToken = 0; // ratchets on every commit; lets in-flight runs cancel themselves

  private playing = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private duration = 0;
  private rafId: number | null = null;

  onUpdate: (snap: PlayerSnapshot) => void = () => {};
  onEnded: () => void = () => {};

  async load(
    stemUrls: Record<Stem, string>,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    this.stopRaf();
    this.detachSources();
    this.originals = {};
    this.play_ = {};
    this.gains = {};

    if (!this.ctx) {
      const Ctor =
        (window.AudioContext as typeof AudioContext) ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    const ctx = this.ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    const received: Record<Stem, number> = { vocals: 0, drums: 0, bass: 0, other: 0 };
    const total: Record<Stem, number> = { vocals: 0, drums: 0, bass: 0, other: 0 };
    const report = () => {
      if (!onProgress) return;
      let r = 0;
      let t = 0;
      for (const k of STEMS) {
        r += received[k];
        t += total[k];
      }
      if (t > 0) onProgress(Math.min(100, (r / t) * 100));
    };

    const decoded = await Promise.all(
      STEMS.map(async (s): Promise<[Stem, AudioBuffer]> => {
        const res = await fetch(stemUrls[s]);
        if (!res.ok || !res.body) throw new Error(`fetch ${s}: ${res.status}`);
        const len = Number(res.headers.get('content-length')) || 0;
        total[s] = len;

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let got = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          received[s] = got;
          report();
        }

        const merged = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        const buf = await ctx.decodeAudioData(merged.buffer);
        return [s, buf];
      })
    );

    if (onProgress) onProgress(100);

    for (const [s, buf] of decoded) {
      this.originals[s] = buf;
      this.play_[s] = buf;
      const g = ctx.createGain();
      g.gain.value = this.muted[s] ? 0 : this.volumes[s];
      g.connect(ctx.destination);
      this.gains[s] = g;
    }

    this.duration = decoded[0][1].duration;
    this.startOffset = 0;
    this.playing = false;
    this.pitch = 0;
    this.pitchProcessing = false;
    this.emit();
  }

  play(): void {
    if (this.playing || !this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const when = this.ctx.currentTime + 0.05;
    this.startCtxTime = when;

    for (const s of STEMS) {
      const buf = this.play_[s];
      const gain = this.gains[s];
      if (!buf || !gain) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(when, this.startOffset);
      this.sources[s] = src;
    }

    this.playing = true;
    this.emit();
    this.startRaf();
  }

  pause(): void {
    if (!this.playing || !this.ctx) return;
    this.startOffset += Math.max(0, this.ctx.currentTime - this.startCtxTime);
    this.detachSources();
    this.playing = false;
    this.stopRaf();
    this.emit();
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  seekTo(t: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.startOffset = Math.max(0, Math.min(this.duration, t));
    this.emit();
    if (wasPlaying) this.play();
  }

  nudge(seconds: number): void {
    if (!this.duration) return;
    this.seekTo(this.getTime() + seconds);
  }

  setMuted(stem: Stem, m: boolean): void {
    this.muted[stem] = m;
    const g = this.gains[stem];
    if (g) g.gain.value = m ? 0 : this.volumes[stem];
    this.emit();
  }

  setVolume(stem: Stem, v: number): void {
    this.volumes[stem] = v;
    const g = this.gains[stem];
    if (g && !this.muted[stem]) g.gain.value = v;
    this.emit();
  }

  /** Update the displayed pitch value without re-rendering. Used for live
   *  slider feedback while the user is dragging. */
  setPitchPreview(semitones: number): void {
    this.pitch = semitones;
    this.emit();
  }

  /** Commit a pitch value: pause, render all stems through Rubber Band with
   *  formant preservation, swap buffers, and resume from the same position. */
  async commitPitch(semitones: number): Promise<void> {
    if (!this.ctx) return;
    this.pitch = semitones;
    const myToken = ++this.pitchInflightToken;

    const wasPlaying = this.playing;
    const resumeAt = this.getTime();
    this.pause();

    if (semitones === 0) {
      // shortcut: nothing to render — point play_ at originals
      for (const s of STEMS) {
        const o = this.originals[s];
        if (o) this.play_[s] = o;
      }
      this.startOffset = Math.min(resumeAt, this.duration);
      this.pitchProcessing = false;
      this.emit();
      if (wasPlaying) this.play();
      return;
    }

    this.pitchProcessing = true;
    this.emit();

    try {
      const ctx = this.ctx;
      const shifted = await Promise.all(
        STEMS.map(async (s) => {
          const orig = this.originals[s];
          if (!orig) return [s, null] as const;
          const buf = await shiftBuffer(orig, semitones, ctx);
          return [s, buf] as const;
        })
      );
      if (myToken !== this.pitchInflightToken) return; // superseded by a newer commit
      for (const [s, buf] of shifted) {
        if (buf) this.play_[s] = buf;
      }
      this.startOffset = Math.min(resumeAt, this.duration);
    } finally {
      if (myToken === this.pitchInflightToken) {
        this.pitchProcessing = false;
        this.emit();
        if (wasPlaying) this.play();
      }
    }
  }

  getPitch(): number {
    return this.pitch;
  }

  getTime(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime);
  }

  getDuration(): number {
    return this.duration;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  reset(): void {
    this.pause();
    this.originals = {};
    this.play_ = {};
    this.gains = {};
    this.duration = 0;
    this.startOffset = 0;
    this.muted = { vocals: false, drums: false, bass: false, other: false };
    this.volumes = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.pitch = 0;
    this.pitchProcessing = false;
    this.emit();
  }

  private snapshot(): PlayerSnapshot {
    return {
      playing: this.playing,
      currentTime: this.getTime(),
      duration: this.duration,
      muted: { ...this.muted },
      volumes: { ...this.volumes },
      pitch: this.pitch,
      pitchProcessing: this.pitchProcessing
    };
  }

  private emit(): void {
    this.onUpdate(this.snapshot());
  }

  private startRaf(): void {
    const tick = () => {
      if (!this.playing) return;
      const t = this.getTime();
      if (t >= this.duration) {
        this.pause();
        this.startOffset = 0;
        this.emit();
        this.onEnded();
        return;
      }
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private detachSources(): void {
    for (const s of STEMS) {
      const src = this.sources[s];
      if (src) {
        try {
          src.stop();
        } catch {
          /* not started */
        }
      }
    }
    this.sources = {};
  }
}
