"""ASR worker offload / reload (the song worker borrows the GPU), with a stub backend."""

from __future__ import annotations

import importlib.util
import sys
import time

import pytest
from conftest import NO_BODY, ROOT, make_wav, send
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


def test_the_lock_serves_utterances_before_guesses_and_in_order(asr):
    import threading

    _, server = asr
    lock = server.RankedLock()
    order: list[str] = []
    lock.acquire()  # the model is busy: everyone below waits
    started = []

    def wait(name: str, rank: int) -> None:
        started.append(name)
        with lock.hold(rank):
            order.append(name)

    threads = []
    for name, rank in (("ahead", server.RANK_AHEAD), ("first", server.RANK_NOW), ("second", server.RANK_NOW)):
        t = threading.Thread(target=wait, args=(name, rank))
        t.start()
        threads.append(t)
        deadline = time.monotonic() + 2
        while len(lock._waiting) < len(threads) and time.monotonic() < deadline:  # queued in this order
            time.sleep(0.005)
    lock.release()
    for t in threads:
        t.join(2)
    assert order == ["first", "second", "ahead"]


def test_priority_ahead_reaches_the_lock(asr, monkeypatch):
    client, server = asr
    ranks: list[int] = []
    real = server.RankedLock.hold

    def spy(self, rank):
        ranks.append(rank)
        return real(self, rank)

    monkeypatch.setattr(server.RankedLock, "hold", spy)
    client.post("/asr", files={"audio": ("a.wav", make_wav(0.3), "audio/wav")}, data={"priority": "ahead"})
    post(client)
    assert ranks == [server.RANK_AHEAD, server.RANK_NOW]


# ── what /offload takes and refuses ──────────────────────────────────────────
# Pinned with the hand-written request model, before it was generated from the JSON Schema: the
# generated one must take and refuse exactly the same, with the same status and error body.

INVALID = "invalid request: "

OFFLOAD_TAKEN = [
    NO_BODY,
    b"null",
    {},
    {"reason": "sing", "max_s": 0},
    {"reason": None, "max_s": None},
    {"max_s": "0"},
    {"max_s": False},
    {"reason": "x" * 500, "max_s": 0, "drain_s": 3, "unknown": [1]},
]

OFFLOAD_REFUSED = [
    ({"reason": 5}, INVALID + "reason: Input should be a valid string"),
    ({"reason": ["sing"]}, INVALID + "reason: Input should be a valid string"),
    ({"max_s": "soon"}, INVALID + "max_s: Input should be a valid number, unable to parse string as a number"),
    ({"max_s": [0]}, INVALID + "max_s: Input should be a valid number"),
    ({"max_s": {}}, INVALID + "max_s: Input should be a valid number"),
    ({"reason": 1, "max_s": "x"}, INVALID + "reason: Input should be a valid string"),
    (b"[]", INVALID + "body: Input should be a valid dictionary or object to extract fields from"),
    (b"5", INVALID + "body: Input should be a valid dictionary or object to extract fields from"),
    (b"nope", INVALID + "0: JSON decode error"),
]


@pytest.mark.parametrize("body", OFFLOAD_TAKEN)
def test_offload_takes(asr, body):
    client, _ = asr
    status, answer = send(client, "POST", "/offload", body)
    assert status == 200 and answer["state"] == "offloaded"


@pytest.mark.parametrize("body,error", OFFLOAD_REFUSED)
def test_offload_refuses(asr, body, error):
    client, _ = asr
    assert send(client, "POST", "/offload", body) == (400, {"error": error})
    assert client.get("/health").json()["offloaded"] is False
