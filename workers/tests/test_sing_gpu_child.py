"""The song worker's GPU child (workers/sing/gpu_child.py, ``SING_GPU_CHILD=1``): the GPU stages run
in a child process that ends with the job, so the idle worker holds no CUDA context."""

from __future__ import annotations

import importlib.util
import json
import multiprocessing
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
SING = TESTS.parent / "sing"
sys.path.insert(0, str(SING))


def _child(monkeypatch, **env: str):
    from gpu_child import GpuChild

    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return GpuChild("fake_gpu:make")


def test_child_runs_and_reports_progress(monkeypatch, tmp_path):
    child = _child(monkeypatch)
    seen: list[float] = []
    try:
        child.convert(tmp_path / "v.wav", tmp_path / "out.wav", 0, seen.append, lambda: False)
        assert child.f0_stats(tmp_path / "v.wav") == (440.0, 440.0)
        assert child.ref_f0() == 440.0
        assert child.peak_vram_mb() == 123
        assert child.device == "fake"
    finally:
        child.close()
    assert seen == [0.2, 0.4, 0.6, 0.8, 1.0]
    assert (tmp_path / "out.wav").read_bytes() == b"converted"


def test_child_cancel_stops_it(monkeypatch, tmp_path):
    from engine import Cancelled

    child = _child(monkeypatch, FAKE_GPU_STEP_S="0.3")
    seen: list[float] = []
    t0 = time.monotonic()
    try:
        with pytest.raises(Cancelled):
            child.convert(tmp_path / "v.wav", tmp_path / "out.wav", 0, seen.append, lambda: len(seen) >= 2)
    finally:
        child.close()
    assert time.monotonic() - t0 < 10
    assert not (tmp_path / "out.wav").exists()
    assert multiprocessing.active_children() == []


def test_child_crash_fails_the_job(monkeypatch, tmp_path):
    from engine import JobError

    child = _child(monkeypatch, FAKE_GPU_CRASH="1")
    with pytest.raises(JobError, match="GPU process"):
        child.convert(tmp_path / "v.wav", tmp_path / "out.wav", 0, lambda _f: None, lambda: False)
    child.close()
    assert multiprocessing.active_children() == []


def test_closing_an_unstarted_child_is_free():
    from gpu_child import GpuChild

    child = GpuChild("fake_gpu:make")
    assert child.peak_vram_mb() is None
    child.close()
    child.close()
    assert multiprocessing.active_children() == []


@pytest.fixture
def server(tmp_path, monkeypatch):
    """The worker in mock mode with its GPU stages in a fake child."""
    monkeypatch.setenv("SING_BACKEND", "mock")
    monkeypatch.setenv("SING_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SING_MOCK_SECONDS", "1")
    monkeypatch.setenv("SING_VIDEO", "0")
    monkeypatch.setenv("SING_GPU_CHILD", "1")
    monkeypatch.setenv("SING_GPU_CHILD_FACTORY", "fake_gpu:make")
    spec = importlib.util.spec_from_file_location("sing_server_gpu_child", SING / "server.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sing_server_gpu_child"] = mod
    spec.loader.exec_module(mod)
    from fastapi.testclient import TestClient

    with TestClient(mod.app) as c:
        yield mod, c


def _wait(c, job_id: str) -> dict:
    t0 = time.time()
    while time.time() - t0 < 60:
        job = c.get(f"/jobs/{job_id}").json()["job"]
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_job_runs_its_gpu_stages_in_the_child(server):
    _mod, c = server
    done = _wait(c, c.post("/jobs", json={"query": "child song"}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert done["song"]["peak_vram_mb"] == 123
    assert done["song"]["engine"]["device"] == "fake"
    assert multiprocessing.active_children() == []


def test_job_gives_gpu_back_when_child_dies(server, monkeypatch):
    mod, c = server
    monkeypatch.setenv("FAKE_GPU_CRASH", "1")
    given: list[str] = []
    original = mod._give_gpu_back
    monkeypatch.setattr(mod, "_give_gpu_back", lambda job: (given.append(job.id), original(job)))
    job = c.post("/jobs", json={"query": "crashing song"}).json()["job"]
    done = _wait(c, job["id"])
    assert done["state"] == "failed" and "GPU process" in done["error"]
    assert job["id"] in given
    assert multiprocessing.active_children() == []


def test_job_gives_gpu_back_even_when_closing_the_child_fails(server, monkeypatch):
    mod, c = server
    given: list[str] = []
    original_give, original_close = mod._give_gpu_back, mod.GpuChild.close

    def failing_close(self):
        original_close(self)
        raise RuntimeError("close failed")

    monkeypatch.setattr(mod, "_give_gpu_back", lambda job: (given.append(job.id), original_give(job)))
    monkeypatch.setattr(mod.GpuChild, "close", failing_close)
    job = c.post("/jobs", json={"query": "close fails"}).json()["job"]
    done = _wait(c, job["id"])
    assert done["state"] == "failed"
    assert given.count(job["id"]) == 2  # after the conversion, and again at the end of the job
    assert multiprocessing.active_children() == []


SCRIPT = r"""
import importlib.util, json, os, sys, time, wave
from pathlib import Path
sing, tests, tmp = map(Path, sys.argv[1:4])
sys.path[:0] = [str(sing), str(tests)]
os.environ.update({"SING_BACKEND": "mock", "SING_DATA_DIR": str(tmp / "songs"), "SING_MOCK_SECONDS": "1",
                   "SING_VIDEO": "0", "SING_GPU_CHILD": "1", "SING_GPU_CHILD_FACTORY": "fake_gpu:make"})
spec = importlib.util.spec_from_file_location("sing_server", sing / "server.py")
server = importlib.util.module_from_spec(spec)
sys.modules["sing_server"] = server
spec.loader.exec_module(server)
from fastapi.testclient import TestClient
with TestClient(server.app) as c:
    job = c.post("/jobs", json={"query": "no torch here"}).json()["job"]
    while job["state"] not in ("done", "failed", "cancelled"):
        time.sleep(0.05)
        job = c.get("/jobs/" + job["id"]).json()["job"]
    health = c.get("/health").json()
# The real backend, built in the main process, must not need torch either.
(tmp / "seedvc" / "modules").mkdir(parents=True)
with wave.open(str(tmp / "ref.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 1600)
os.environ.update({"SING_SEEDVC_DIR": str(tmp / "seedvc"), "SING_REF": str(tmp / "ref.wav")})
import engine
engine.RealBackend(server.state.store)
print(json.dumps({"state": job["state"], "health": health["status"], "torch": "torch" in sys.modules}))
"""


def test_main_process_does_not_import_torch(tmp_path):
    r = subprocess.run([sys.executable, "-c", SCRIPT, str(SING), str(TESTS), str(tmp_path)],
                       capture_output=True, text=True, timeout=120, env={**os.environ, "PYTHONUTF8": "1"})
    assert r.returncode == 0, r.stderr[-2000:]
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out == {"state": "done", "health": "ok", "torch": False}
