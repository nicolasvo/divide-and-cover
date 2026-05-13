// Web Audio engine — N independent stem buffers playing in lockstep with per-stem gain/mute.
// Ported from app/static/app.js (lines 191-396). Framework-agnostic; components subscribe via callbacks.

export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export type PlayerSnapshot = {
  playing: boolean;
  currentTime: number;
  duration: number;
  muted: Record<Stem, boolean>;
  volumes: Record<Stem, number>;
};

export class StemPlayer {
  private ctx: AudioContext | null = null;
  private buffers: Partial<Record<Stem, AudioBuffer>> = {};
  private gains: Partial<Record<Stem, GainNode>> = {};
  private sources: Partial<Record<Stem, AudioBufferSourceNode>> = {};
  private muted: Record<Stem, boolean> = { vocals: false, drums: false, bass: false, other: false };
  private volumes: Record<Stem, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };

  private playing = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private duration = 0;
  private rafId: number | null = null;

  // listener invoked every animation frame while playing, plus once on every state change
  onUpdate: (snap: PlayerSnapshot) => void = () => {};
  onEnded: () => void = () => {};

  /** Decode all stems and prepare gain nodes. Resets prior state. */
  async load(stemUrls: Record<Stem, string>): Promise<void> {
    this.stopRaf();
    this.detachSources();
    this.buffers = {};
    this.gains = {};

    if (!this.ctx) {
      const Ctor =
        (window.AudioContext as typeof AudioContext) ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    const ctx = this.ctx;

    const decoded = await Promise.all(
      STEMS.map(async (s): Promise<[Stem, AudioBuffer]> => {
        const res = await fetch(stemUrls[s]);
        const ab = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        return [s, buf];
      })
    );

    for (const [s, buf] of decoded) {
      this.buffers[s] = buf;
      const g = ctx.createGain();
      g.gain.value = this.muted[s] ? 0 : this.volumes[s];
      g.connect(ctx.destination);
      this.gains[s] = g;
    }

    this.duration = decoded[0][1].duration;
    this.startOffset = 0;
    this.playing = false;
    this.emit();
  }

  play(): void {
    if (this.playing || !this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const when = this.ctx.currentTime + 0.05;
    this.startCtxTime = when;

    for (const s of STEMS) {
      const buf = this.buffers[s];
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

  /** Tear down all per-track state. Keep the AudioContext for reuse. */
  reset(): void {
    this.pause();
    this.buffers = {};
    this.gains = {};
    this.duration = 0;
    this.startOffset = 0;
    this.muted = { vocals: false, drums: false, bass: false, other: false };
    this.volumes = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.emit();
  }

  private snapshot(): PlayerSnapshot {
    return {
      playing: this.playing,
      currentTime: this.getTime(),
      duration: this.duration,
      muted: { ...this.muted },
      volumes: { ...this.volumes }
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
