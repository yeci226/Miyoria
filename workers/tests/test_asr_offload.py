"""ASR worker offload / reload (the song worker borrows the GPU), with a stub backend."""

from __future__ import annotations

import importlib.util
import sys
import time

import pytest
from conftest import ROOT, make_wav
from fastapi.testclient import TestClient


class StubBackend:
    name = "stub"
    model_name = "stub-asr"
    device = "cpu"
    loads = 0

    def __init__(self) -> None:
        StubBackend.loads += 1

    def transcribe(self, x, language, prompt):
        return {"text": "你好", "language": "zh"}


@pytest.fixture
def asr(monkeypatch):
    StubBackend.loads = 0
    spec = importlib.util.spec_from_file_location("asr_server_under_test", ROOT / "asr" / "server.py")
    server = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "asr_server_under_test", server)
    spec.loader.exec_module(server)
    server.make_backend = StubBackend
    server.device_memory = None  # the real card has nothing to do with these stubs
    server.decode_wav = lambda data: ([0.0] * 4800, 300)  # no soundfile in the test venv
    with TestClient(server.app) as client:
        yield client, server


def post(client):
    return client.post("/asr", files={"audio": ("a.wav", make_wav(0.3), "audio/wav")})


def test_offload_and_reload(asr):
    client, server = asr
    assert post(client).json()["text"] == "你好"
    r = client.post("/offload", json={"reason": "sing", "max_s": 0}).json()
    assert r["state"] == "offloaded"
    h = client.get("/health").json()
    assert h["status"] == "ok" and h["offloaded"] is True and h["model"] == "stub-asr" and h["reason"] == "sing"
    res = post(client)
    assert res.status_code == 503 and res.json() == {"error": "offloaded"}
    assert client.post("/offload").json()["already"] is True
    assert client.post("/reload").json()["state"] == "ready"
    assert StubBackend.loads == 2
    assert client.get("/health").json()["offloaded"] is False
    assert post(client).status_code == 200


def test_reloads_by_itself(asr):
    client, _ = asr
    client.post("/offload", json={"max_s": 0.2})
    deadline = time.time() + 5
    while client.get("/health").json()["offloaded"] and time.time() < deadline:
        time.sleep(0.05)
    assert client.get("/health").json()["offloaded"] is False


def test_an_offload_does_not_wait_behind_queued_requests(asr):
    """A busy voice channel queues transcriptions on the (unfair) lock; the offload goes first."""
    import threading

    client, server = asr
    server.make_backend = None  # unused from here
    started = threading.Event()

    class Slow:
        def transcribe(self, x, language, prompt):
            started.set()
            time.sleep(0.4)
            return {"text": "慢", "language": "zh"}

    server.state.backend = Slow()
    server.state.pool._max_workers = 4
    results = []
    threads = [threading.Thread(target=lambda: results.append(post(client).status_code)) for _ in range(6)]
    for t in threads:
        t.start()
    assert started.wait(5)
    t0 = time.monotonic()
    assert client.post("/offload", json={"max_s": 0}).json()["state"] == "offloaded"
    took = time.monotonic() - t0
    for t in threads:
        t.join(10)
    assert took < 1.5  # one running transcription at most, not all six
    assert results.count(503) >= 4


def test_busy_counts_clips_being_transcribed(asr):
    client, server = asr
    seen = []
    backend = server.state.backend
    transcribe = backend.transcribe

    def spying(x, language, prompt):
        seen.append(server.state.busy)
        return transcribe(x, language, prompt)

    backend.transcribe = spying
    assert client.get("/busy").json() == {"busy": 0}
    assert post(client).status_code == 200
    assert seen == [1]
    assert client.get("/busy").json() == {"busy": 0}
