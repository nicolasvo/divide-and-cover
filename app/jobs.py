"""In-memory registry of detached separation jobs.

A job runs as a fire-and-forget asyncio task that consumes one of the
`_stream_separation` / `youtube_pipeline` async generators (which yield ndjson
*bytes*, one event per chunk). Instead of streaming those events back over the
originating request, `run_job` parses each event, folds it into the job's state,
and fans it out to any number of live subscribers. Clients subscribe over a
separate endpoint and can come and go (reload, tab switch, reconnect) without
affecting the job — the work keeps running server-side until it finishes.

State is in-memory only: jobs survive client disconnects but not a server
restart.
"""

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable

# how long a finished (done/error) job lingers in the registry so reconnecting
# / late clients can still observe its terminal state before it's swept.
TERMINAL_TTL = 600.0


@dataclass
class Job:
    id: str
    name: str
    kind: str  # "upload" | "youtube"
    video_id: str | None = None
    status: str = "running"  # "running" | "done" | "error"
    stage: str = "starting"
    percent: int = 0
    message: str = ""
    stems: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = field(default=None, repr=False, compare=False)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "video_id": self.video_id,
            "status": self.status,
            "stage": self.stage,
            "percent": self.percent,
            "message": self.message,
            "stems": self.stems,
            "error": self.error,
            "created_at": self.created_at,
        }


JOBS: dict[str, Job] = {}
# keep strong refs to detached tasks so they aren't garbage-collected mid-run.
_TASKS: set[asyncio.Task] = set()


def get(job_id: str) -> Job | None:
    return JOBS.get(job_id)


def prune() -> None:
    """Drop terminal jobs with no live subscribers past their TTL."""
    now = time.time()
    for jid in [
        j.id
        for j in JOBS.values()
        if j.status != "running"
        and not j.subscribers
        and now - j.updated_at > TERMINAL_TTL
    ]:
        JOBS.pop(jid, None)


def create(job_id: str, name: str, kind: str, video_id: str | None = None) -> Job:
    prune()
    job = Job(id=job_id, name=name, kind=kind, video_id=video_id)
    JOBS[job_id] = job
    return job


def list_active() -> list[dict]:
    """Running jobs plus recently-finished ones (the dialog shows both)."""
    prune()
    jobs = sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return [j.snapshot() for j in jobs]


def publish(job: Job, evt: dict) -> None:
    """Fold one stream event into job state and fan it out to subscribers."""
    kind = evt.get("event")
    if kind == "progress":
        job.stage = evt.get("stage", job.stage)
        job.percent = int(evt.get("percent", job.percent))
    elif kind == "stage":
        job.stage = evt.get("stage", job.stage)
        job.percent = 0
        job.message = evt.get("message", "") or job.message
    elif kind == "log":
        job.message = evt.get("message", job.message)
    elif kind == "done":
        job.status = "done"
        job.percent = 100
        job.stems = evt.get("stems")
    elif kind == "error":
        job.status = "error"
        job.error = evt.get("message", "failed")
    job.updated_at = time.time()
    for q in list(job.subscribers):
        q.put_nowait(evt)


def spawn(job: Job, gen: AsyncIterator[bytes], cleanup: Callable[[], None] | None = None) -> None:
    """Run `gen` to completion in a detached task, publishing each event."""

    async def runner() -> None:
        try:
            async for chunk in gen:
                publish(job, json.loads(chunk))
            if job.status == "running":
                # generator ended without an explicit done/error
                publish(job, {"event": "error", "message": "ended unexpectedly"})
        except asyncio.CancelledError:
            # user cancelled — the generator's finally has already torn down any
            # subprocess; tell subscribers so their streams close.
            publish(job, {"event": "error", "message": "cancelled"})
            raise
        except Exception as e:  # noqa: BLE001 — surface any failure as a job error
            publish(job, {"event": "error", "message": str(e)[:240]})
        finally:
            if cleanup is not None:
                cleanup()

    task = asyncio.create_task(runner())
    job.task = task
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def cancel(job: Job) -> None:
    """Interrupt a running job — cancels its task, which unwinds the generator
    (terminating any demucs/yt-dlp subprocess via its finally block)."""
    if job.task is not None and not job.task.done():
        job.task.cancel()


async def events(job: Job) -> AsyncIterator[dict]:
    """Yield a catch-up snapshot, then tail live events until terminal."""
    # 1) catch-up: reflect current state so a late/reconnecting client sees it
    yield {"event": "stage", "stage": job.stage, "percent": job.percent, "message": job.message}
    if job.status == "done":
        yield {"event": "done", "job_id": job.id, "name": job.name, "stems": job.stems}
        return
    if job.status == "error":
        yield {"event": "error", "message": job.error or "failed"}
        return

    # 2) tail live events
    q: asyncio.Queue = asyncio.Queue()
    job.subscribers.add(q)
    try:
        while True:
            evt = await q.get()
            yield evt
            if evt.get("event") in ("done", "error"):
                return
    finally:
        job.subscribers.discard(q)
