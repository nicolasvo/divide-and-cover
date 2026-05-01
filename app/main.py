import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
TRACKS = ROOT.parent / "tracks"
TRACKS.mkdir(parents=True, exist_ok=True)

STEMS = ("vocals", "drums", "bass", "other")
MODEL = "htdemucs"

PCT_RE = re.compile(rb"(\d+)%\|")

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _track_dir(job_id: str) -> Path:
    if not job_id.isalnum():
        raise HTTPException(400, "bad job id")
    return TRACKS / job_id


def _ndjson(event: dict) -> bytes:
    return (json.dumps(event) + "\n").encode()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (STATIC / "index.html").read_text()


@app.post("/api/separate")
async def separate(file: UploadFile = File(...)):
    job_id = uuid.uuid4().hex[:12]
    suffix = Path(file.filename or "song").suffix.lower() or ".wav"
    name = Path(file.filename or "song").stem

    work = Path(tempfile.mkdtemp(prefix="demucs-"))
    src = work / f"input{suffix}"
    with src.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    out = work / "out"
    out.mkdir()

    async def event_stream():
        cmd = [
            sys.executable, "-u", "-m", "demucs",
            "--mp3", "-n", MODEL,
            "-o", str(out),
            str(src),
        ]
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
        )
        try:
            yield _ndjson({"event": "stage", "stage": "starting", "message": "starting demucs…"})

            stage = "starting"
            last_pct = -1
            buf = b""
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(512)
                if not chunk:
                    break
                buf += chunk
                while True:
                    cuts = [j for j in (buf.find(b"\r"), buf.find(b"\n")) if j != -1]
                    if not cuts:
                        break
                    i = min(cuts)
                    line, buf = buf[:i], buf[i + 1 :]
                    if not line:
                        continue
                    low = line.lower()
                    if b"download" in low:
                        stage = "download"
                    elif b"separating" in low:
                        stage = "separate"
                    m = PCT_RE.search(line)
                    if m:
                        pct = int(m.group(1))
                        if pct != last_pct:
                            last_pct = pct
                            yield _ndjson({
                                "event": "progress",
                                "stage": stage,
                                "percent": pct,
                            })
                    else:
                        text = line.decode(errors="replace").strip()
                        if text and len(text) < 240:
                            yield _ndjson({
                                "event": "log",
                                "stage": stage,
                                "message": text,
                            })

            rc = await proc.wait()
            if rc != 0:
                yield _ndjson({"event": "error", "message": f"demucs exited {rc}"})
                return

            produced = out / MODEL / src.stem
            if not produced.exists():
                yield _ndjson({"event": "error", "message": f"stems missing at {produced}"})
                return

            yield _ndjson({"event": "stage", "stage": "saving", "message": "saving stems…"})

            final = TRACKS / job_id
            final.mkdir(parents=True)
            for stem in STEMS:
                shutil.move(str(produced / f"{stem}.mp3"), str(final / f"{stem}.mp3"))
            (final / "meta.json").write_text(
                json.dumps({"name": name, "created_at": time.time()})
            )

            yield _ndjson({
                "event": "done",
                "job_id": job_id,
                "name": name,
                "stems": {s: f"/api/stem/{job_id}/{s}" for s in STEMS},
            })
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    proc.kill()
            shutil.rmtree(work, ignore_errors=True)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@app.get("/api/tracks")
def list_tracks() -> dict:
    items = []
    for p in TRACKS.iterdir():
        if not p.is_dir():
            continue
        meta_file = p / "meta.json"
        if not meta_file.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text())
        except json.JSONDecodeError:
            continue
        items.append({
            "job_id": p.name,
            "name": meta.get("name", p.name),
            "created_at": meta.get("created_at", 0),
        })
    items.sort(key=lambda x: -x["created_at"])
    return {"tracks": items}


@app.delete("/api/tracks/{job_id}")
def delete_track(job_id: str) -> dict:
    d = _track_dir(job_id)
    if not d.exists():
        raise HTTPException(404, "not found")
    shutil.rmtree(d)
    return {"ok": True}


@app.get("/api/stem/{job_id}/{stem}")
def get_stem(job_id: str, stem: str) -> FileResponse:
    if stem not in STEMS:
        raise HTTPException(404, "unknown stem")
    path = _track_dir(job_id) / f"{stem}.mp3"
    if not path.exists():
        raise HTTPException(404, "stem missing")
    return FileResponse(path, media_type="audio/mpeg")
