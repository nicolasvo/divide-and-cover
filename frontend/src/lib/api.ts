// Typed API client + NDJSON stream reader. Mirrors app/main.py endpoints.

import { STEMS, type Stem } from './player';

export type StreamEvent =
  | { event: 'stage'; stage: string; message?: string }
  | { event: 'progress'; stage: string; percent: number }
  | { event: 'log'; stage: string; message: string }
  | { event: 'done'; job_id: string; name: string; stems: Record<Stem, string> }
  | { event: 'error'; message: string };

export type Track = {
  job_id: string;
  name: string;
  created_at: number;
  video_id?: string | null;
};

export type YTHit = {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string;
  url: string;
};

export type LyricsResult = {
  found: boolean;
  reason?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  instrumental?: boolean;
  lines?: { t: number; text: string }[];
  plain?: string;
  query?: string;
};

export type LyricsSearchHit = {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  duration: number | null;
  instrumental: boolean;
  has_sync: boolean;
  has_plain: boolean;
};

export async function* readNdjson(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
  }
  const tail = buf.trim();
  if (tail) yield JSON.parse(tail) as StreamEvent;
}

export function stemUrlsFor(jobId: string): Record<Stem, string> {
  const out = {} as Record<Stem, string>;
  for (const s of STEMS) out[s] = `/api/stem/${jobId}/${s}`;
  return out;
}

export async function listTracks(): Promise<Track[]> {
  const res = await fetch('/api/tracks');
  if (!res.ok) throw new Error(`listTracks: ${res.status}`);
  const data = await res.json();
  return data.tracks ?? [];
}

export async function deleteTrack(jobId: string): Promise<void> {
  const res = await fetch(`/api/tracks/${jobId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteTrack: ${res.status}`);
}

export async function renameTrack(jobId: string, name: string): Promise<{ name: string }> {
  const res = await fetch(`/api/tracks/${jobId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function separateFile(file: File): Promise<Response> {
  const fd = new FormData();
  fd.append('file', file);
  return fetch('/api/separate', { method: 'POST', body: fd });
}

export function separateYouTube(videoId: string, name?: string): Promise<Response> {
  return fetch('/api/separate-youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, name: name ?? null })
  });
}

export async function ytSearch(
  q: string,
  limit = 10,
  offset = 0
): Promise<{ results: YTHit[]; has_more: boolean }> {
  const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
  const r = await fetch(`/api/search?${params}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchLyrics(
  jobId: string,
  opts: { q?: string; refresh?: boolean } = {}
): Promise<LyricsResult> {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.refresh) params.set('refresh', '1');
  const url = `/api/lyrics/${jobId}${params.toString() ? '?' + params : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

export async function searchLyrics(q: string): Promise<LyricsSearchHit[]> {
  const r = await fetch(`/api/lyrics-search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data.results ?? [];
}

export async function selectLyrics(jobId: string, lrclibId: number): Promise<LyricsResult> {
  const r = await fetch(`/api/lyrics/${jobId}/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lrclib_id: lrclibId })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
