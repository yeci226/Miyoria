# ASR worker. Build one backend per image, from workers/ (the image also needs workers/contracts.py):
#   docker build -f asr/Dockerfile --build-arg BACKEND=sensevoice -t miyoria-asr .   (CPU ONNX, tiny)
#   docker build -f asr/Dockerfile --build-arg BACKEND=qwen3      -t miyoria-asr .   (PyTorch + qwen-asr, GPU)
# The CUDA runtime base is only needed for qwen3 / sensevoice with ASR_SENSEVOICE_PROVIDER=cuda;
# the pip torch wheels bundle their own CUDA libs, the base image supplies the driver-facing bits.
# FlashAttention 2 needs nvcc: use a -devel base and --build-arg FLASH_ATTN=1 (slow build).
ARG BASE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
FROM ${BASE}

ARG BACKEND=sensevoice
ARG FLASH_ATTN=0
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu128

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev build-essential libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY asr/requirements.txt asr/requirements-sensevoice.txt asr/requirements-qwen3.txt ./
RUN if [ "$BACKEND" = "qwen3" ]; then \
        pip install torch --index-url "$TORCH_INDEX" && pip install -r requirements-qwen3.txt; \
        if [ "$FLASH_ATTN" = "1" ]; then pip install flash-attn --no-build-isolation; fi; \
    else \
        pip install -r requirements-sensevoice.txt; \
    fi

# Non-root user (uid 10001; Ubuntu 24.04's default `ubuntu` is uid 1000)
RUN useradd --create-home --uid 10001 worker && mkdir -p /models /home/worker/.cache/huggingface \
    && chown -R worker /models /home/worker/.cache
USER worker
ENV HF_HOME=/home/worker/.cache/huggingface \
    ASR_BACKEND=${BACKEND} \
    HOST=0.0.0.0 PORT=8001

COPY --chown=worker asr/server.py asr/tags.py contracts.py service_auth.py ./
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=4).status == 200 else 1)"
CMD ["python3", "server.py"]
