"""
Modal deployment for the demucs separator.

Deploy once:
    uv run --env-file .env modal deploy modal_app.py

The FastAPI server in `app/main.py` then calls the named function
`divide-and-cover/separate` over the network for each split. It is a
generator: yields {"event": "progress", ...} as demucs reports stdout,
then a final {"event": "done", "stems": {...}}.
"""
import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("demucs>=4.0.1")
    .run_commands(
        # pre-cache htdemucs weights into the image so the first cold start
        # doesn't pay the ~80 MB model download
        "python -c \"from demucs.pretrained import get_model; get_model('htdemucs')\""
    )
)

app = modal.App("divide-and-cover", image=image)

STEMS = ("vocals", "drums", "bass", "other")
MODEL = "htdemucs"


@app.function(
    gpu="T4",
    timeout=600,
    scaledown_window=60,
)
def separate(audio: bytes, suffix: str = ".wav"):
    """Run demucs on `audio` bytes, streaming progress events.

    Yields:
        {"event": "progress", "stage": "separate", "percent": int}
        {"event": "done", "stems": {stem_name: mp3_bytes}}
    """
    import re
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    pct_re = re.compile(rb"(\d+)%\|")

    with tempfile.TemporaryDirectory() as work_str:
        work = Path(work_str)
        src = work / f"input{suffix}"
        src.write_bytes(audio)
        out = work / "out"
        out.mkdir()

        proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "demucs",
             "--mp3", "--mp3-bitrate", "192",
             "-n", MODEL, "-o", str(out), str(src)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            env={"PYTHONUNBUFFERED": "1"},
        )

        stage = "separate"  # demucs weights are pre-cached, so we go straight here
        last_pct = -1
        buf = b""
        assert proc.stdout is not None
        try:
            while True:
                chunk = proc.stdout.read(512)
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
                    m = pct_re.search(line)
                    if m:
                        pct = int(m.group(1))
                        if pct != last_pct:
                            last_pct = pct
                            yield {"event": "progress", "stage": stage, "percent": pct}
        finally:
            rc = proc.wait()

        if rc != 0:
            tail = buf.decode(errors="replace")[-500:]
            raise RuntimeError(f"demucs failed (rc={rc}): {tail}")

        produced = out / MODEL / src.stem
        stems = {s: (produced / f"{s}.mp3").read_bytes() for s in STEMS}
        yield {"event": "done", "stems": stems}
