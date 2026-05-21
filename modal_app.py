"""
Modal deployment for the demucs separator.

Strategy: fan out the htdemucs_ft bag (4 fine-tuned sub-models) across
4 parallel Modal containers. Each worker runs apply_model on one
sub-model with shifts=2 and overlap=0.5. The orchestrator weight-
averages the 4 outputs using bag.weights and encodes the stems to MP3.

This is ~4x faster than the serial CLI path that runs all 4 sub-models
back-to-back, at roughly flat GPU-second cost.

Deploy:
    uv run --env-file .env modal deploy modal_app.py

The FastAPI server in `app/main.py` calls `divide-and-cover/separate`,
which is a generator yielding {"event": "progress"|"stage"|"done", ...}.
"""
import io
import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("demucs>=4.0.1")
    .run_commands(
        # pre-cache the 4 htdemucs_ft checkpoints (~320 MB total) so cold
        # starts skip the download
        "python -c \"from demucs.pretrained import get_model; get_model('htdemucs_ft')\""
    )
)

app = modal.App("divide-and-cover", image=image)

MODEL = "htdemucs_ft"
N_MODELS = 4


def _decode_audio(audio: bytes, suffix: str, samplerate: int, channels: int):
    """demucs's AudioFile takes a filesystem path, so write to a tempfile."""
    import tempfile
    from pathlib import Path
    from demucs.audio import AudioFile

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio)
        path = Path(f.name)
    try:
        return AudioFile(path).read(streams=0, samplerate=samplerate, channels=channels)
    finally:
        path.unlink(missing_ok=True)


@app.function(gpu="T4", timeout=900)
def apply_one_model(audio: bytes, suffix: str, model_idx: int) -> tuple[int, bytes]:
    """Run one sub-model of htdemucs_ft on the audio.

    Returns (model_idx, tensor_bytes) so the orchestrator can weight-average
    without depending on map ordering. The tensor is (n_sources, channels, T)
    serialized as float16 to halve transfer size.
    """
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    bag = get_model(MODEL)
    sub_model = bag.models[model_idx].to("cuda").eval()

    wav = _decode_audio(audio, suffix, bag.samplerate, bag.audio_channels)
    # Standard demucs normalization (matches demucs.separate CLI).
    ref = wav.mean(0)
    wav_norm = (wav - ref.mean()) / ref.std()

    with torch.no_grad():
        sources = apply_model(
            sub_model,
            wav_norm[None],
            device="cuda",
            shifts=2,
            overlap=0.5,
            split=True,
            progress=False,
        )[0]
    sources = sources * ref.std() + ref.mean()

    buf = io.BytesIO()
    torch.save(sources.to(torch.float16).cpu(), buf)
    return model_idx, buf.getvalue()


@app.function(timeout=1800)
def separate(audio: bytes, suffix: str = ".wav"):
    """Orchestrator: fan out across the 4 sub-models, average, encode."""
    import tempfile
    from pathlib import Path
    import torch
    from demucs.audio import save_audio
    from demucs.pretrained import get_model

    yield {"event": "stage", "stage": "starting", "message": "fanning out across 4 gpus…"}

    # Loaded for metadata only (weights, sources, samplerate); no GPU needed.
    bag = get_model(MODEL)
    weights = torch.tensor(bag.weights, dtype=torch.float32)
    sources_names = list(bag.sources)
    samplerate = bag.samplerate

    accumulated = None
    weight_sums = torch.zeros(len(sources_names), dtype=torch.float32)
    done_count = 0

    args = [(audio, suffix, i) for i in range(N_MODELS)]
    for model_idx, tensor_bytes in apply_one_model.starmap(args):
        sources = torch.load(io.BytesIO(tensor_bytes), weights_only=True).to(torch.float32)
        if accumulated is None:
            accumulated = torch.zeros_like(sources)
        for s in range(sources.shape[0]):
            accumulated[s] += sources[s] * weights[model_idx, s]
            weight_sums[s] += weights[model_idx, s]
        done_count += 1
        yield {"event": "progress", "stage": "separate", "percent": done_count * 25}

    for s in range(accumulated.shape[0]):
        accumulated[s] /= weight_sums[s]

    yield {"event": "stage", "stage": "saving", "message": "encoding stems…"}

    stems = {}
    with tempfile.TemporaryDirectory() as work:
        for s_idx, name in enumerate(sources_names):
            out_path = Path(work) / f"{name}.mp3"
            save_audio(
                accumulated[s_idx],
                str(out_path),
                samplerate=samplerate,
                bitrate=192,
                clip="rescale",
            )
            stems[name] = out_path.read_bytes()

    yield {"event": "done", "stems": stems}
