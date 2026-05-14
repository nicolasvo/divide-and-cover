# Library polling — current state and upgrade path

How the frontend learns about new tracks added to the shared library, plus
what it would take to swap polling for server-pushed events when (or if)
the latency becomes a problem.

## Current state: HTTP polling

`frontend/src/routes/+page.svelte` polls `GET /api/tracks` every 30 seconds
while the tab is visible.

- `POLL_INTERVAL_MS = 30_000`.
- `refreshLibrary({ silent: true })` runs on the timer, diffs the response
  against `app.tracks`, and adds any newly-seen `job_id`s to
  `app.newTrackIds` (a `$state<Set<string>>`).
- `visibilitychange` listener pauses the interval while the tab is hidden
  and catches up immediately on focus.
- The `+N` badge next to the page title reads `app.newTrackIds.size`. The
  set is cleared when the library dialog closes (`closeSearchAndMarkSeen`).
- User-initiated `refreshLibrary()` (after their own split / load) replaces
  `app.tracks` but **doesn't** clear pending new flags from earlier polls.

### Why polling is good enough today

- **Cheap on the backend**: `listTracks` reads ~20 `meta.json` files per
  call. Single-digit milliseconds. ~2 req/min/tab = trivial load on the
  Hetzner box.
- **No new infra**: works as plain HTTP, no long-lived connections to
  babysit through Caddy / Cloudflare / mobile networks.
- **Natural latency floor**: a new split takes 30–60 s through Modal, so
  30 s polling delay feels invisible to the user.
- **Resilient**: a missed poll just means the next one catches up. No
  reconnect logic needed.

### When polling becomes the wrong choice

Switch to push-based delivery if any of these become true:

1. **Library-update latency starts mattering** — e.g. you want `<5 s` feedback
   for collaborator activity, or chat-style features get added later.
2. **The tab count per user grows** — multiple tabs from the same browser
   each running their own 30 s timer is wasteful.
3. **`listTracks` gets expensive** — if the library grows past a few
   hundred tracks, polling all of them every 30 s starts being noticeable.
4. **Adding any other "live" data** (currently-playing state, presence,
   chat, etc.) — the second channel is the right point to invest in a
   server-push path; building it for one event would be premature.

## Recommended upgrade: Server-Sent Events (SSE)

SSE is the right next step (not WebSockets):

- **HTTP/1.1 with a long-lived response body** — Caddy already proxies
  this correctly via the `flush_interval -1` directive set up for the
  NDJSON separation stream. No new Caddyfile work.
- **One-way (server → client)**, which is all this needs. No protocol
  negotiation, no auth dance, no `Sec-WebSocket-Key` overhead.
- **Auto-reconnect** built into `EventSource` with `Last-Event-ID`
  support — survives network blips without app-level retry logic.
- **No new dependencies** — `EventSource` is a browser primitive;
  FastAPI ships `StreamingResponse` which is what we already use for the
  separation progress stream.

WebSockets would also work, but they're bidirectional and need more
plumbing for nothing we'd use.

## Migration sketch

### Backend — `app/main.py`

A pub-sub primitive (in-process is fine for one server):

```python
import asyncio
from contextlib import suppress

_library_listeners: set[asyncio.Queue[dict]] = set()

def _broadcast_library_event(event: dict) -> None:
    """Fire-and-forget push to every active SSE client."""
    for q in _library_listeners:
        with suppress(asyncio.QueueFull):
            q.put_nowait(event)

@app.get("/api/library/stream")
async def library_stream():
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=64)
    _library_listeners.add(queue)

    async def gen():
        try:
            # initial snapshot so a fresh subscriber catches up
            yield f"event: snapshot\ndata: {json.dumps({'tracks': _list_tracks()})}\n\n"
            while True:
                event = await queue.get()
                yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
        finally:
            _library_listeners.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

Then sprinkle broadcasts where the library mutates:

- After `_write_meta(...)` in the separation flows
  (`_stream_separation_modal`, `_stream_separation_local`):
  `_broadcast_library_event({"type": "added", "track": {...}})`
- After `rename_track`:
  `_broadcast_library_event({"type": "renamed", "job_id": ..., "name": ...})`
- After `delete_track`:
  `_broadcast_library_event({"type": "deleted", "job_id": ...})`

### Frontend — `+page.svelte`

Replace the `setInterval` with an `EventSource`:

```ts
onMount(() => {
  refreshLibrary(); // initial fetch, baseline

  const es = new EventSource('/api/library/stream');
  const knownIds = () => new Set(app.tracks.map((t) => t.job_id));

  es.addEventListener('added', (e) => {
    const { track } = JSON.parse(e.data);
    if (knownIds().has(track.job_id)) return;
    app.tracks = [track, ...app.tracks];
    app.newTrackIds = new Set([...app.newTrackIds, track.job_id]);
  });
  es.addEventListener('renamed', (e) => {
    const { job_id, name } = JSON.parse(e.data);
    app.tracks = app.tracks.map((t) => (t.job_id === job_id ? { ...t, name } : t));
  });
  es.addEventListener('deleted', (e) => {
    const { job_id } = JSON.parse(e.data);
    app.tracks = app.tracks.filter((t) => t.job_id !== job_id);
    app.newTrackIds.delete(job_id);
  });

  return () => es.close();
});
```

The `+N` badge logic, the `mark-seen` on dialog close, and the row
highlighting all stay the same — only the *source* of "what changed"
flips from poll to push.

### Caddy

Already handled. The existing `flush_interval -1` on the `/api/*` reverse
proxy applies to the SSE endpoint too. No new rule needed.

## Gotchas worth knowing

- **Multiple-worker uvicorn**: `--workers 2` in the prod Dockerfile gives
  the backend two processes that don't share memory. An in-process
  `_library_listeners` set only sees broadcasts from its own worker. A
  client connected to worker A wouldn't see a separation that ran on
  worker B.
  - **Acceptable for now** (one user, low concurrency), but worth a note.
  - Fixes: drop to `--workers 1`, or move pub-sub to Redis Pub/Sub (~30
    lines and a Redis container), or use `multiprocessing.Manager`-style
    IPC.
- **Long-lived connections through Cloudflare**: Cloudflare proxies (the
  orange-cloud setting) buffer SSE bodies even with `Cache-Control:
  no-cache`. You'd see events arrive in batches. Solution: keep the
  proxy off for `music.nicotine.dev` (current state — wildcard A record
  is DNS-only), or migrate the subdomain to Cloudflare Tunnel which
  doesn't buffer.
- **Mobile Safari + long-lived HTTP**: the OS may freeze idle connections
  when the app is backgrounded. The auto-reconnect in `EventSource` will
  re-subscribe on resume, but the "snapshot" event on reconnect should
  re-sync state. The migration sketch above does this.
- **Connection limits**: HTTP/1.1 limits browsers to ~6 connections per
  origin. The SSE eats one. Combined with the NDJSON separation stream,
  that's 2 of 6 — fine. HTTP/2 (which Caddy serves) multiplexes, so it's
  not actually a per-connection concern in practice.

## Not recommended for now

- **WebSockets**: bidirectional plumbing for one-way data. More moving
  parts, no upside here.
- **Long-polling**: more requests, more bookkeeping, no real-time wins
  over the current 30 s `setInterval`.
- **Pre-broadcasting via Modal callback**: Modal could call back into
  FastAPI when a separation completes, but the existing
  `_stream_separation_modal` already runs on the FastAPI host and knows
  exactly when the track lands — the broadcast belongs there, not in
  Modal.
