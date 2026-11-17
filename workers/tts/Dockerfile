# TTS worker (Qwen3-TTS). Built from workers/ (the image also needs workers/contracts.py).
# FlashAttention 2 needs nvcc: use a -devel base and --build-arg FLASH_ATTN=1
#   docker build -f tts/Dockerfile --build-arg BASE=nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04 --build-arg FLASH_ATTN=1 -t miyoria-tts .
# Without it the worker falls back to PyTorch SDPA (a bit more VRAM / slower, otherwise identical).
#
# Backend = which requirements file gets installed (the two packages conflict, so one image has one):
#   docker build -f tts/Dockerfile -t miyoria-tts .                                                          # qwen-tts, sentence-level streaming
#   docker build -f tts/Dockerfile --build-arg REQUIREMENTS=requirements-faster.txt -t miyoria-tts-faster .  # faster-qwen3-tts, true streaming
# The worker picks the backend by what is importable (TTS_BACKEND=faster|qwen-tts overrides).
ARG BASE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
FROM ${BASE}

ARG FLASH_ATTN=0
ARG REQUIREMENTS=requirements.txt
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu128

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/opt/venv/bin:$PATH

# sox: qwen-tts warns/fails in its audio helpers when SoX is missing; libsndfile1 for soundfile
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev build-essential libsndfile1 sox ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY tts/requirements.txt tts/requirements-faster.txt ./
RUN pip install torch --index-url "$TORCH_INDEX" && pip install -r "$REQUIREMENTS" \
    && if [ "$FLASH_ATTN" = "1" ]; then pip install flash-attn --no-build-isolation; fi

RUN useradd --create-home --uid 10001 worker && mkdir -p /voices /home/worker/.cache/huggingface \
    && chown -R worker /voices /home/worker/.cache
USER worker
ENV HF_HOME=/home/worker/.cache/huggingface \
    VOICES_DIR=/voices PROFILES_DIR=/profiles \
    HOST=0.0.0.0 PORT=8002

COPY --chown=worker tts/server.py tts/text_split.py tts/design_voice.py contracts.py service_auth.py ./
EXPOSE 8002
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8002/health', timeout=4).status == 200 else 1)"
CMD ["python3", "server.py"]
