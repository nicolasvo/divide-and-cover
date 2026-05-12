import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
TRACKS = ROOT.parent / "tracks"
TRACKS.mkdir(parents=True, exist_ok=True)

STEMS = ("vocals", "drums", "bass", "other")
MODEL = "htdemucs"

DEMUCS_PCT_RE = re.compile(rb"(\d+)%\|")
YT_PCT_RE = re.compile(rb"(\d+(?:\.\d+)?)%")
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,15}$")

LRCLIB_BASE = "https://lrclib.net/api"
LRC_USER_AGENT = "divide-and-cover/0.1 (+https://github.com/)"
LRC_TIME_RE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
LRC_NOISE_RE = re.compile(
    r"\s*[\(\[](?:official[^)\]]*|audio|video|lyrics?|hd|hq|m/?v|live|"
    r"cover|remix|edit|feat\.?[^)\]]*|ft\.?[^)\]]*|prod\.?[^)\]]*|"
    r"visualizer|with\s+lyrics?)[\)\]]\s*",
    re.IGNORECASE,
)

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


# --- demucs streaming ------------------------------------------------------

async def _stream_separation(src: Path, work_out: Path, job_id: str, name: str) -> AsyncIterator[bytes]:
    """Run demucs on `src`, persist stems to TRACKS/{job_id}, yield NDJSON events."""
    cmd = [
        sys.executable, "-u", "-m", "demucs",
        "--mp3", "-n", MODEL,
        "-o", str(work_out),
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
                line, buf = buf[:i], buf[i + 1:]
                if not line:
                    continue
                low = line.lower()
                if b"download" in low:
                    stage = "download"
                elif b"separating" in low:
                    stage = "separate"
                m = DEMUCS_PCT_RE.search(line)
                if m:
                    pct = int(m.group(1))
                    if pct != last_pct:
                        last_pct = pct
                        yield _ndjson({"event": "progress", "stage": stage, "percent": pct})
                else:
                    text = line.decode(errors="replace").strip()
                    if text and len(text) < 240:
                        yield _ndjson({"event": "log", "stage": stage, "message": text})

        rc = await proc.wait()
        if rc != 0:
            yield _ndjson({"event": "error", "message": f"demucs exited {rc}"})
            return

        produced = work_out / MODEL / src.stem
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


# --- file upload + separate ------------------------------------------------

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
        try:
            async for chunk in _stream_separation(src, out, job_id, name):
                yield chunk
        finally:
            shutil.rmtree(work, ignore_errors=True)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


# --- youtube search + download + separate ---------------------------------

@app.get("/api/search")
async def search(q: str, limit: int = 10, offset: int = 0) -> dict:
    q = q.strip()
    if not q:
        raise HTTPException(400, "empty query")
    limit = max(1, min(20, limit))
    offset = max(0, min(100, offset))
    total = offset + limit

    def do_search() -> dict:
        from yt_dlp import YoutubeDL
        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": "in_playlist",
            "default_search": f"ytsearch{total}",
        }
        with YoutubeDL(opts) as ydl:
            return ydl.extract_info(q, download=False) or {}

    info = await asyncio.get_event_loop().run_in_executor(None, do_search)
    entries = [e for e in info.get("entries", []) if e]
    has_more = len(entries) >= total
    page = entries[offset:total]

    items = []
    for entry in page:
        vid = entry.get("id")
        if not vid:
            continue
        items.append({
            "id": vid,
            "title": entry.get("title") or vid,
            "channel": entry.get("channel") or entry.get("uploader") or "",
            "duration": entry.get("duration"),
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return {"results": items, "has_more": has_more, "offset": offset}


class YoutubeJob(BaseModel):
    video_id: str
    name: str | None = None


@app.post("/api/separate-youtube")
async def separate_youtube(payload: YoutubeJob):
    if not VIDEO_ID_RE.match(payload.video_id):
        raise HTTPException(400, "bad video id")
    video_id = payload.video_id
    name = (payload.name or video_id).strip() or video_id
    job_id = uuid.uuid4().hex[:12]

    work = Path(tempfile.mkdtemp(prefix="yt-"))
    out = work / "out"
    out.mkdir()

    async def event_stream():
        try:
            yield _ndjson({"event": "stage", "stage": "downloading_audio", "message": f"downloading {video_id}…"})

            url = f"https://www.youtube.com/watch?v={video_id}"
            cmd = [
                sys.executable, "-u", "-m", "yt_dlp",
                "-x", "--audio-format", "mp3",
                "-o", str(work / "input.%(ext)s"),
                "--no-playlist",
                "--newline",
                url,
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            try:
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
                        line, buf = buf[:i], buf[i + 1:]
                        if not line:
                            continue
                        text = line.decode(errors="replace").strip()
                        if not text:
                            continue
                        if text.startswith("[download]"):
                            m = YT_PCT_RE.search(line)
                            if m:
                                pct = int(float(m.group(1)))
                                if pct != last_pct:
                                    last_pct = pct
                                    yield _ndjson({
                                        "event": "progress",
                                        "stage": "downloading_audio",
                                        "percent": pct,
                                    })
                                continue
                        if len(text) < 240:
                            yield _ndjson({
                                "event": "log",
                                "stage": "downloading_audio",
                                "message": text,
                            })

                rc = await proc.wait()
            finally:
                if proc.returncode is None:
                    proc.terminate()
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        proc.kill()

            if rc != 0:
                yield _ndjson({"event": "error", "message": f"yt-dlp exited {rc}"})
                return

            downloaded = next((p for p in work.iterdir() if p.is_file() and p.name.startswith("input.")), None)
            if downloaded is None:
                yield _ndjson({"event": "error", "message": "audio file not produced"})
                return

            async for chunk in _stream_separation(downloaded, out, job_id, name):
                yield chunk
        finally:
            shutil.rmtree(work, ignore_errors=True)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


# --- library / stems --------------------------------------------------------

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


# --- lyrics (lrclib) -------------------------------------------------------

def _clean_lyric_query(name: str) -> str:
    n = LRC_NOISE_RE.sub(" ", name)
    n = re.sub(r"\s+", " ", n).strip(" -–—|·•_")
    return n


def _parse_lrc(body: str) -> list[dict]:
    """Parse LRC text into a sorted list of {t, text} dicts. Empty-text entries kept (instrumental gaps)."""
    out: list[dict] = []
    for raw in body.splitlines():
        text = raw
        times: list[float] = []
        while True:
            m = LRC_TIME_RE.match(text)
            if not m:
                break
            times.append(int(m.group(1)) * 60 + float(m.group(2)))
            text = text[m.end():]
        text = text.strip()
        for t in times:
            out.append({"t": round(t, 3), "text": text})
    out.sort(key=lambda x: x["t"])
    return out


def _lrclib_search(query: str) -> list[dict]:
    url = f"{LRCLIB_BASE}/search?{urllib.parse.urlencode({'q': query})}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": LRC_USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


@app.get("/api/lyrics/{job_id}")
async def get_lyrics(job_id: str, q: str | None = None, refresh: bool = False) -> dict:
    d = _track_dir(job_id)
    if not d.exists():
        raise HTTPException(404, "track not found")

    cache = d / "lyrics.json"
    if cache.exists() and not refresh and q is None:
        try:
            return json.loads(cache.read_text())
        except json.JSONDecodeError:
            pass

    name = (q or "").strip()
    if not name:
        meta_file = d / "meta.json"
        if meta_file.exists():
            try:
                name = json.loads(meta_file.read_text()).get("name", "")
            except json.JSONDecodeError:
                pass
    name = name.strip()
    if not name:
        return {"found": False, "reason": "no track name"}

    query = _clean_lyric_query(name) or name

    def search() -> dict | list:
        try:
            return _lrclib_search(query)
        except Exception as e:
            return {"error": str(e)[:200]}

    hits = await asyncio.get_event_loop().run_in_executor(None, search)
    if isinstance(hits, dict) and "error" in hits:
        return {"found": False, "query": query, "reason": hits["error"]}
    if not hits:
        return {"found": False, "query": query}

    hits.sort(key=lambda h: (
        not bool(h.get("syncedLyrics")),
        -len(h.get("plainLyrics") or ""),
    ))
    best = hits[0]
    result = {
        "found": True,
        "title": best.get("trackName"),
        "artist": best.get("artistName"),
        "album": best.get("albumName"),
        "duration": best.get("duration"),
        "instrumental": bool(best.get("instrumental")),
        "lines": _parse_lrc(best.get("syncedLyrics") or ""),
        "plain": best.get("plainLyrics") or "",
        "query": query,
    }
    try:
        cache.write_text(json.dumps(result))
    except OSError:
        pass
    return result
