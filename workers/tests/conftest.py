"""Contract tests for the inference workers.

By default they run against the in-process fake worker (fake/fake_server.py), no GPU needed.
To check a REAL worker against the same contract, point the tests at it:

    WORKER_ASR_URL=http://127.0.0.1:8001 WORKER_TTS_URL=http://127.0.0.1:8002 pytest tests/test_contract.py

Fake-only assertions (exact PCM byte length, canned text) are skipped for live workers.
"""

from __future__ import annotations

import io
import math
import os
import sys
import wave
from array import array
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
# The stubbed model packages live in this process; test_engine_process.py covers the real child.
os.environ["TTS_ENGINE_PROCESS"] = "0"
os.environ["ASR_ENGINE_PROCESS"] = "0"
for sub in ("fake", "tts", "asr"):
    sys.path.insert(0, str(ROOT / sub))


def make_wav(seconds: float = 0.5, rate: int = 16_000, channels: int = 1, freq: float = 440.0) -> bytes:
    """PCM s16le sine WAV."""
    n = int(seconds * rate)
    frames = array("h")
    for i in range(n):
        v = int(12000 * math.sin(2 * math.pi * freq * i / rate))
        frames.extend([v] * channels)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames.tobytes())
    return buf.getvalue()


def pcm_to_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


@pytest.fixture(scope="session")
def fake_client():
    from fake_server import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


def _live(url_env: str):
    url = os.environ.get(url_env)
    if not url:
        return None
    import httpx

    return httpx.Client(base_url=url, timeout=120)


@pytest.fixture(scope="session")
def asr_client(fake_client):
    return _live("WORKER_ASR_URL") or fake_client


@pytest.fixture(scope="session")
def tts_client(fake_client):
    return _live("WORKER_TTS_URL") or fake_client


@pytest.fixture(scope="session")
def tts_is_fake() -> bool:
    return "WORKER_TTS_URL" not in os.environ


@pytest.fixture(scope="session")
def asr_is_fake() -> bool:
    return "WORKER_ASR_URL" not in os.environ
