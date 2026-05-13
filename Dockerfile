FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./

# Prod (default) installs only the base dependencies — no demucs.
# Dev images pass INSTALL_DEV=1 to also install the `dev` group (demucs + torch),
# which the local-subprocess separation path needs.
ARG INSTALL_DEV=0
RUN if [ "$INSTALL_DEV" = "1" ]; then \
      uv sync --frozen ; \
    else \
      uv sync --frozen --no-dev ; \
    fi

COPY app/ ./app/

ENV DAC_USE_MODAL=1 \
    DAC_TRACKS_DIR=/data/tracks \
    PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
