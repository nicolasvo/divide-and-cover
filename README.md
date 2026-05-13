# divide and cover

Drop a song, get four stems. Web UI on top of [demucs](https://github.com/adefossez/demucs).

<p align="center">
  <img src="screenshots/1.png" width="50%" />
  <img src="screenshots/2.png" width="50%" />
</p>

## Run

Requires [uv](https://docs.astral.sh/uv/) and Python 3.11.

```bash
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

### Where does demucs run?

By default, demucs runs **locally** as a subprocess. On Apple Silicon a 3-min
song takes ~30–90 s. The first split downloads the `htdemucs` weights into
`~/.cache/torch/hub/`; subsequent splits reuse them.

To offload demucs to a **Modal serverless GPU** instead, drop your Modal
credentials into a gitignored `.env`:

```bash
# .env (gitignored)
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

Then:

```bash
# one-time
uv run --env-file .env modal deploy modal_app.py

# every run — DAC_USE_MODAL=1 makes the toggle explicit at the call site
DAC_USE_MODAL=1 uv run --env-file .env uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Drop the `DAC_USE_MODAL=1` prefix to fall back to local demucs.

Warm Modal splits take ~15–25 s; the first one of a session pays ~30 s of
cold start. The free $30/month credit covers thousands of songs.

## Player

Once split, the four stems (`vocals`, `drums`, `bass`, `other`) play in
sample-accurate sync via the Web Audio API. Click any stem name to mute/unmute,
drag its slider for per-stem volume, the seek bar to scrub, or hit space to
play/pause.

## Library

Past splits show up under the player. Click a track to load it; click `✕` to
delete its folder.

## Storage

Splits live in `tracks/{job_id}/{vocals,drums,bass,other}.mp3` plus a
`meta.json`. The original upload is discarded after the split completes. The
folder is gitignored — clean up via the UI or `rm -rf tracks/`.

## Layout

- `modal_app.py` — Modal app exposing the `divide-and-cover/separate`
  function: pulls demucs + htdemucs weights into the image, runs on a T4 GPU,
  returns the four mp3 stems as bytes.
- `app/main.py` — FastAPI:
  - `POST /api/separate` — uploads bytes to the Modal function, persists stems.
  - `POST /api/separate-youtube` — yt-dlp downloads the audio locally, then
    forwards bytes to Modal.
  - `GET /api/tracks` — list past splits.
  - `DELETE /api/tracks/{job_id}` — remove a split.
  - `GET /api/stem/{job_id}/{stem}` — serve a stem mp3.
  - `GET /api/lyrics/{job_id}` — fetch synced lyrics for a track from lrclib.
- `app/static/` — single-page Tailwind (CDN) + vanilla JS frontend.
