"""The model in its own process (workers/engine_process.py) with REAL child processes.

The fakes elsewhere keep the model in this process, which says nothing about the one thing this is
for: that an offload ends a process, at once, whatever it is doing. No GPU: the stand-in packages are
files on the path, so the child imports them for real.
"""

from __future__ import annotations

import importlib.util
import sys
import threading
import time
from pathlib import Path

import pytest
from conftest import ROOT, make_wav
from fastapi.testclient import TestClient

sys.path.insert(0, str(ROOT))

import device_memory  # noqa: E402
from engine_process import EngineGone, EngineProcess, RemoteError  # noqa: E402

HOST = '''
import os, time

class Target:
    def add(self, a, b):
        return a + b

    def fail(self):
        raise ValueError("no")

    def api(self):
        e = ValueError("unknown voice")
        e.status = 404
        raise e

    def count(self, n):
        for i in range(n):
            yield i

    def slow(self):
        i = 0
        while True:
            yield i
            i += 1
            time.sleep(0.01)

    def hang(self):
        time.sleep(600)

    def die(self):
        os._exit(3)

def make():
    return Target()

def describe(t):
    return {"pid": os.getpid()}

def make_slowly():
    time.sleep(600)

def make_broken():
    raise RuntimeError("no model here")
'''


@pytest.fixture
def host(tmp_path):
    p = tmp_path / "host_server.py"
    p.write_text(HOST, "utf-8")
    made: list[EngineProcess] = []

    def start(factory="make", describe="describe"):
        e = EngineProcess(p, factory, describe)
        made.append(e)
        return e

    yield start
    for e in made:
        e.kill()


def test_a_call_and_its_answer(host):
    e = host()
    assert e.wait_ready()["pid"] == e.pid
    assert e.call("add", 2, b=3) == 5


def test_a_failed_request_is_not_a_dead_engine(host):
    e = host()
    e.wait_ready()
    with pytest.raises(RemoteError) as info:
        e.call("fail")
    assert info.value.kind == "ValueError" and info.value.status is None
    with pytest.raises(RemoteError) as info:
        e.call("api")
    assert info.value.status == 404 and info.value.message == "unknown voice"
    assert e.call("add", 1, 1) == 2


def test_a_stream_and_one_closed_early(host):
    e = host()
    e.wait_ready()
    assert list(e.stream("count", 3)) == [0, 1, 2]
    gen = e.stream("slow")
    assert [next(gen), next(gen)] == [0, 1]
    gen.close()
    assert e.call("add", 1, 1) == 2  # the pipe is clean again
    assert list(e.stream("count", 2)) == [0, 1]


def test_a_kill_ends_it_at_once_whatever_it_is_doing(host):
    e = host()
    e.wait_ready()
    caught = []

    def waiting():
        try:
            e.call("hang")
        except EngineGone as err:
            caught.append(err)

    t = threading.Thread(target=waiting)
    t.start()
    time.sleep(0.2)
    t0 = time.monotonic()
    e.kill()
    assert time.monotonic() - t0 < 3 and not e.alive()
    t.join(5)
    assert caught and not t.is_alive()


def test_a_kill_stops_a_load(host):
    e = host("make_slowly", None)
    caught = []

    def loading():
        try:
            e.wait_ready()
        except EngineGone as err:
            caught.append(err)

    t = threading.Thread(target=loading)
    t.start()
    time.sleep(0.2)
    e.kill()
    t.join(5)
    assert caught


def test_a_model_that_does_not_load_says_why(host):
    e = host("make_broken", None)
    with pytest.raises(RemoteError) as info:
        e.wait_ready()
    assert "no model here" in info.value.message


def test_a_crash_is_seen(host):
    e = host()
    e.wait_ready()
    with pytest.raises(EngineGone):
        e.call("die")
    assert not e.alive()


# ── the TTS worker with its engine in a real child ───────────────────────────

FASTER = '''
import os, time
import numpy as np

class FasterQwen3TTS:
    sample_rate = 24000

    @classmethod
    def from_pretrained(cls, name, **kw):
        delay = os.environ.get("FAKE_LOAD_S")
        if delay:
            time.sleep(float(delay))
        return cls()

    def warmup(self, prefill_len=100):
        pass

    def generate_voice_clone_streaming(self, text, language, ref_audio, ref_text, xvec_only, chunk_size, **kw):
        if text == "bad":
            raise RuntimeError("model failed")
        for _ in range(3):
            time.sleep(float(os.environ.get("FAKE_CHUNK_S", "0")))
            yield np.full(240, 0.25, dtype=np.float32), 24000, {}
'''


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def tts(tmp_path, monkeypatch):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "faster_qwen3_tts.py").write_text(FASTER, "utf-8")
    voice = tmp_path / "voices" / "miyo"
    voice.mkdir(parents=True)
    (voice / "ref.wav").write_bytes(make_wav(0.1))
    (voice / "ref.txt").write_text("你好", "utf-8")
    monkeypatch.syspath_prepend(str(tmp_path / "pkg"))
    monkeypatch.syspath_prepend(str(ROOT / "tts"))
    for k, v in {"TTS_ENGINE_PROCESS": "1", "TTS_BACKEND": "faster", "VOICES_DIR": str(tmp_path / "voices"),
                 "TTS_DEVICE": "cpu", "TTS_SAMPLE_RATE": "24000"}.items():
        monkeypatch.setenv(k, v)
    server = _load("tts_server_process", ROOT / "tts" / "server.py")
    with TestClient(server.app) as client:
        yield client, server


def speak(client, text="你好世界,今天天氣很好。"):
    return client.post("/tts", json={"text": text, "voice": "miyo", "language": "zh"})


def wait_until(fn, seconds=20.0):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if fn():
            return
        time.sleep(0.02)
    raise AssertionError("it did not happen")


def test_tts_speaks_through_the_child_and_the_voices_are_known_here(tts):
    client, server = tts
    assert isinstance(server.state.engine, server.RemoteEngine)
    h = client.get("/health").json()
    assert h["backend"] == "faster" and h["voices"] == ["miyo"] and h["engine_pid"] == server.state.engine.process.pid
    r = speak(client)
    assert r.status_code == 200 and len(r.content) == 3 * 240 * 2
    assert r.headers["x-tts-reference"] == "ref"
    assert client.post("/tts", json={"text": "你好世界。", "voice": "nobody"}).status_code == 404


def test_tts_offload_ends_the_process_and_the_worker_stays_up(tts):
    client, server = tts
    eng = server.state.engine
    pid = eng.process.pid
    r = client.post("/offload", json={"reason": "sing", "max_s": 0}).json()
    assert r["state"] == "offloaded" and not eng.process.alive()
    assert "released_mb" in r or device_memory.read() is None
    h = client.get("/health").json()
    assert h["status"] == "ok" and h["offloaded"] is True and h["reason"] == "sing"
    assert speak(client).status_code == 503
    assert client.post("/reload").json()["state"] == "ready"
    assert server.state.engine.process.pid != pid
    assert speak(client).status_code == 200


def test_tts_offload_stops_a_reload_instead_of_waiting_behind_it(tts, monkeypatch):
    client, server = tts
    client.post("/offload", json={"max_s": 0})
    monkeypatch.setenv("FAKE_LOAD_S", "600")  # 11-07: graph capture took 87.5 s, and /offload hung behind it
    results = []
    t = threading.Thread(target=lambda: results.append(client.post("/reload").json()))
    t.start()
    wait_until(lambda: server.state.loading is not None)
    t0 = time.monotonic()
    r = client.post("/offload", json={"max_s": 0}).json()
    assert time.monotonic() - t0 < 5
    assert r["state"] == "offloaded" and r["cancelled_reload"] is True
    t.join(10)
    assert results == [{"state": "offloaded", "cancelled": True}]
    assert server.state.engine is None and client.get("/health").json()["offloaded"] is True


def test_tts_a_stopped_reload_does_not_change_what_an_offload_is_known_to_free(tts, monkeypatch):
    client, server = tts
    client.post("/offload", json={"max_s": 0})
    server.state.released_mb = 4625
    monkeypatch.setenv("FAKE_LOAD_S", "600")
    t = threading.Thread(target=lambda: client.post("/reload"))
    t.start()
    wait_until(lambda: server.state.loading is not None)
    client.post("/offload", json={"max_s": 0})
    t.join(10)
    assert server.state.released_mb == 4625


def test_tts_a_lease_that_is_renewed_does_not_reload(tts):
    client, server = tts
    client.post("/offload", json={"max_s": 0.5})
    for _ in range(5):
        time.sleep(0.2)
        assert client.post("/offload", json={"max_s": 0.5}).json()["already"] is True
    assert client.get("/health").json()["offloaded"] is True  # a second, in leases of half a second
    wait_until(lambda: client.get("/health").json()["offloaded"] is False)  # nobody renews: it comes back


def test_tts_a_crashed_engine_comes_back_by_itself(tts):
    client, server = tts
    server.state.engine.process.kill()
    assert speak(client).status_code == 503
    wait_until(lambda: client.get("/health").json()["offloaded"] is False)
    assert speak(client).status_code == 200


def test_device_numbers_come_from_the_device():
    now = device_memory.read()
    if now is None:
        pytest.skip("no NVML on this machine")
    assert now.total_mb > 0 and now.used_mb + now.free_mb <= now.total_mb and now.name
    assert set(device_memory.fields()) == {"device_total_mb", "device_used_mb", "device_free_mb"}


def test_what_an_offload_reports():
    D = device_memory.DeviceMemory
    assert device_memory.report(D(12000, 9000, 3000, "x"), D(12000, 4600, 7400, "x")) == {
        "device_used_before_mb": 9000, "device_used_after_mb": 4600, "released_mb": 4400}
    assert device_memory.report(None, None)["released_mb"] is None


def test_settled_waits_for_the_driver(monkeypatch):
    D = device_memory.DeviceMemory
    reads = iter([9000, 8000, 6000, 4600, 4600, 4600, 4600, 4600, 4600, 4600, 4600, 4600])
    monkeypatch.setattr(device_memory, "read", lambda: D(12000, next(reads, 4600), 0, "x"))
    assert device_memory.settled(limit_s=2, every_s=0.01, quiet_s=0.05).used_mb == 4600
