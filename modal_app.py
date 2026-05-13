"""
Modal deployment for the demucs separator.

Deploy once:
    uv run modal deploy modal_app.py

The FastAPI server in `app/main.py` then calls the named function
`divide-and-cover/separate` over the network for each split.
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
def separate(audio: bytes, suffix: str = ".wav") -> dict[str, bytes]:
    """Run demucs on `audio` bytes, return each stem as mp3 bytes."""
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as work_str:
        work = Path(work_str)
        src = work / f"input{suffix}"
        src.write_bytes(audio)
        out = work / "out"
        out.mkdir()

        result = subprocess.run(
            [sys.executable, "-u", "-m", "demucs",
             "--mp3", "-n", MODEL, "-o", str(out), str(src)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()[-500:]
            raise RuntimeError(f"demucs failed: {tail}")

        produced = out / MODEL / src.stem
        return {s: (produced / f"{s}.mp3").read_bytes() for s in STEMS}
