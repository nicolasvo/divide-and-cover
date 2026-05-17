// Small formatting helpers — same behavior as app/static/app.js fmt() / fmtDate().

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${ss}`;
}

export function fmtDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const STAGE_LABELS: Record<string, string> = {
  uploading: 'uploading',
  downloading_audio: 'downloading audio',
  starting: 'starting demucs',
  download: 'downloading model',
  separate: 'separating tracks',
  saving: 'saving tracks',
  loading: 'downloading tracks'
};

export function labelStage(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}
