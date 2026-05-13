# Modal integration

How `divide-and-cover` offloads demucs to [Modal](https://modal.com) for GPU
separation, while keeping the FastAPI host on a tiny CPU container.

## Two pieces

| File | Role |
|---|---|
| `modal_app.py` | Defines the remote GPU function. Deployed once to Modal. |
| `app/main.py`  | FastAPI host. Looks up the deployed function by name and streams from it. |

The two communicate over Modal's own gRPC — there is **no public HTTP
endpoint**. Auth is via `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` env vars,
which the Modal SDK picks up automatically when present. Drop them into a
gitignored `.env` (see [README](README.md#where-does-demucs-run)).

## The Modal function — `modal_app.py`

### Image

```python
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("demucs>=4.0.1")
    .run_commands(
        "python -c \"from demucs.pretrained import get_model; get_model('htdemucs')\""
    )
)
```

That `run_commands` step matters: it imports `get_model('htdemucs')` at image
build time so the ~80 MB weights are baked into the image. Cold starts don't
redownload them — only VRAM warm-up (~2–5 s) remains.

### Function config

```python
@app.function(gpu="T4", timeout=600, scaledown_window=60)
def separate(audio: bytes, suffix: str = ".wav"):
    ...
```

- **`gpu="T4"`** — cheapest CUDA card on Modal; plenty for htdemucs.
- **`timeout=600`** — 10-minute hard cap per call. A 3-min song separates in
  ~15–25 s warm, so this is mostly insurance against a stuck subprocess.
- **`scaledown_window=60`** — Modal keeps the container warm for 60 s after
  the last call. Back-to-back splits reuse the same container; idle gaps
  longer than a minute pay the cold-start tax again.
- **Concurrency** — Modal scales horizontally by default: 5 simultaneous
  callers → 5 parallel T4 containers. No knob to twist, no queue to manage.

### The function body — a streaming generator

`separate` is **not** a regular function that returns a dict. It's a
generator that yields events while demucs runs:

```python
def separate(audio: bytes, suffix: str = ".wav"):
    # ... spawn `python -m demucs` with bufsize=0 and parse stdout ...
    while True:
        chunk = proc.stdout.read(512)
        if not chunk: break
        # find lines, look for `(\d+)%\|`, dedupe percents
        yield {"event": "progress", "stage": "separate", "percent": pct}

    # ... on success ...
    yield {"event": "done", "stems": {stem: mp3_bytes, ...}}
```

The generator shape is what lets progress events stream back live. With a
plain return-the-dict function, the FastAPI host would block on a single
`await` until separation finished and the browser would see no percentages.

## The FastAPI caller — `app/main.py`

### Function discovery

```python
USE_MODAL = os.environ.get("DAC_USE_MODAL") == "1"

if USE_MODAL:
    import modal
    modal_separate = modal.Function.from_name("divide-and-cover", "separate")
```

The pair `("divide-and-cover", "separate")` is `(app_name, function_name)`
from `modal_app.py`. Resolution happens at FastAPI startup, not on first
call. If you haven't deployed yet, FastAPI still starts cleanly — the error
surfaces on the first split with a `function not found`-style message.

### Calling the generator

```python
async for evt in modal_separate.remote_gen.aio(audio_bytes, suffix):
    if evt.get("event") == "progress":
        yield _ndjson(evt)            # forward straight to the browser
    elif evt.get("event") == "done":
        stems = evt.get("stems")
        break
```

`.remote_gen.aio(...)` is the async-iterator counterpart of `.remote.aio(...)`.
Each `yield` on the Modal side becomes one item the async-for receives over
gRPC. Progress events forward straight into the NDJSON stream the browser is
reading from `POST /api/separate`, so the existing client renders them the
same way it renders local-subprocess events — neither side has to know which
backend is running.

### Event shape parity with the local path

Both `_stream_separation_modal` and `_stream_separation_local` emit the same
NDJSON shapes:

```
{"event": "stage",    "stage": "starting",  "message": "uploading to gpu…"}
{"event": "stage",    "stage": "separate",  "message": "separating on modal…"}
{"event": "progress", "stage": "separate",  "percent": 12}
{"event": "progress", "stage": "separate",  "percent": 24}
...
{"event": "stage",    "stage": "saving",    "message": "saving stems…"}
{"event": "done",     "job_id": "...", "name": "...", "stems": {...}}
```

The frontend's progress bar binds purely to these events. Local and Modal
paths are interchangeable as far as the UI is concerned.

## Deploy

```bash
make modal-deploy        # uv run --env-file .env modal deploy modal_app.py
```

You redeploy only when `modal_app.py` itself changes. The FastAPI container
can ship independently — it just calls whatever version of `separate` is
currently deployed.

Deploy creates (or updates) the named function in Modal's registry. The
deploy command also rebuilds the image only when something in the image
recipe changes (apt deps, pip deps, run_commands); otherwise it reuses the
cached image layer.

## Toggle

Switch between local subprocess and Modal at start time:

```bash
DAC_USE_MODAL=1 uv run --env-file .env uvicorn app.main:app ...   # Modal
uv run uvicorn app.main:app ...                                   # local
```

The toggle is checked once at import time, so flipping it requires restarting
the FastAPI process. In the Docker compose files, `DAC_USE_MODAL` defaults
to `"1"` for the prod stack and is parameterized in the dev stack
(`make dev-modal` / `make dev-local`).

## Cost & performance

| Phase | Time |
|---|---|
| Audio upload (FastAPI → Modal, ~30 MB) | 1–3 s |
| Cold start (container + VRAM warm-up) | ~30 s, first call only |
| Separation (3-min song, T4) | 15–25 s warm |
| Stem download (Modal → FastAPI, ~32 MB) | 1–3 s |

Modal's free tier is $30/month of compute, which at T4 prices (~$0.000164/s)
covers ~50 hours of GPU time — thousands of songs.

## Failure modes worth knowing

- **Function not found** — Modal SDK error on first split. You haven't run
  `make modal-deploy` yet, or you deployed under a different app name.
- **Auth error** — `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` missing or wrong.
  Check that `--env-file .env` is on the uvicorn invocation (or that the
  container has them via `env_file:` in compose).
- **Cold start every call** — `scaledown_window` is too short for your
  traffic pattern. Either raise it (more $$$) or accept the cold start.
- **Timeout** — `demucs failed: rc=...` after 600 s. Unusually long song, or
  demucs hung. Bump `timeout=600` in `modal_app.py` and redeploy.
- **Container build flake** — `modal deploy` retries are cheap; just rerun.
