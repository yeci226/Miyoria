"""``POST /karaoke/voice`` of the song worker: the pitch of a singer's recording for the official score
(workers/sing/server.py, karaoke.py). Mock backend: its RMVPE answers a C major scale as long as the
recording. No GPU, no network; the recordings are a few seconds of sine waves made here."""

from __future__ import annotations

import importlib.util
import io
import math
import os
import shutil
import sys
import threading
import time
import wave
from array import array
from pathlib import Path
from typing import Any

import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))

import contracts  # noqa: E402
import karaoke  # noqa: E402

SCALE = {60.0, 62.0, 64.0, 65.0, 67.0, 69.0, 71.0, 72.0}


@pytest.fixture(scope="module")
def worker(tmp_path_factory):
    root = tmp_path_factory.mktemp("songs-karaoke-voice")
    os.environ.update({"SING_BACKEND": "mock", "SING_DATA_DIR": str(root), "SING_MOCK_SECONDS": "2"})
    server = sys.modules.get("sing_server")
    if server is None:
        spec = importlib.util.spec_from_file_location("sing_server", SING / "server.py")
        assert spec and spec.loader
        server = importlib.util.module_from_spec(spec)
        sys.modules["sing_server"] = server
        spec.loader.exec_module(server)
    from fastapi.testclient import TestClient

    with TestClient(server.app) as c:
        yield c, server, root
    shutil.rmtree(root, ignore_errors=True)


def recording(seconds: float = 2.0, rate: int = 16_000, amp: float = 0.25, channels: int = 1) -> bytes:
    n = int(seconds * rate)
    samples = array("h")
    for i in range(n):
        v = int(32767 * amp * math.sin(2 * math.pi * 330 * i / rate))
        samples.extend([v] * channels)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return buf.getvalue()


def post(client, body: bytes, content_type: str = "audio/wav"):
    return client.post("/karaoke/voice", content=body, headers={"content-type": content_type})


def voice_files(root: Path) -> list[str]:
    d = root / karaoke.VOICE_DIR
    return sorted(p.name for p in d.iterdir()) if d.is_dir() else []


class Recorder:
    """An arbitration that places on the card at once and records what it was asked."""

    name = "recorder"

    def __init__(self, place: Any = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self._place = place

    def start(self, job, audio_s):
        self.calls.append(("start", job))
        job.gpu = object()

    def place(self, job, stage, resumed):
        self.calls.append(("place", stage))
        return self._place(job) if self._place is not None else "gpu"

    def arm(self, job, stage, work):
        self.calls.append(("arm", stage))

    def run_begins(self, job, stage, device, resumed):
        self.calls.append(("run_begins", device))

    def run_ended(self, job, stage, how):
        self.calls.append(("run_ended", how))

    def close_window(self, job):
        self.calls.append(("close_window", None))

    def give_back(self, job):
        self.calls.append(("give_back", None))

    def finish(self, job):
        self.calls.append(("finish", None))
        return None

    def names(self) -> list[str]:
        return [c for c, _ in self.calls]


@pytest.fixture
def arbiter(worker, monkeypatch):
    _client, server, _root = worker

    def use(arb: Any) -> Any:
        monkeypatch.setattr(server.state, "arbitration", arb)
        return arb

    return use


def test_the_answer_is_the_contracts_and_the_recording_is_gone(worker, arbiter):
    client, server, root = worker
    b = server.state.backend
    arbiter(Recorder())
    before = client.get("/cache").json()
    r = post(client, recording(2.0), "audio/wav")
    assert r.status_code == 200, r.text
    got = contracts.WorkersKaraokeVoicePitch.model_validate_json(r.content, strict=True)
    assert got.hz == 50 and got.method == "rmvpe"
    assert got.seconds == pytest.approx(2.0, abs=0.01)
    # A frame every 20 ms from the recording's first sample.
    assert len(got.midi) == round(got.seconds * 50) == 100
    voiced = [m for m in got.midi if m is not None]
    assert voiced and set(voiced) <= SCALE and got.midi[0] == 60.0
    assert None in got.midi  # the scale's gaps between notes
    # A 0.25 sine: about -15 dBFS while sung; the floor of its frames is not far below.
    assert got.level_db == pytest.approx(-15.1, abs=1.0)
    assert got.floor_db is not None and got.floor_db <= got.level_db
    # Nothing of it is left, and nothing of it was ever a song or in the cache.
    assert voice_files(root) == []
    assert b.karaoke_f0_inputs[-1][0].endswith(".wav")
    assert (root / karaoke.VOICE_DIR).is_dir() and not (root / "_karaoke" / karaoke.VOICE_DIR).exists()
    after = client.get("/cache").json()
    assert (after["songs"], after["karaoke"], after["sources"]) == (before["songs"], before["karaoke"], before["sources"])


def test_a_codec_parameter_in_the_content_type_is_fine(worker, arbiter):
    client, _server, _root = worker
    arbiter(Recorder())
    r = post(client, recording(1.0), "audio/wav; codecs=1")
    assert r.status_code == 200, r.text


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_a_compressed_recording_is_decoded(worker, arbiter, tmp_path):
    import subprocess

    client, _server, root = worker
    arbiter(Recorder())
    src = tmp_path / "in.wav"
    src.write_bytes(recording(1.5, rate=48_000, channels=2))
    out = tmp_path / "rec.ogg"
    r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                        "-c:a", "libopus", "-b:a", "48k", str(out)], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        pytest.skip(f"ffmpeg cannot encode opus here: {r.stderr[:200]}")
    got = post(client, out.read_bytes(), "audio/ogg")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["seconds"] == pytest.approx(1.5, abs=0.05) and len(body["midi"]) == round(body["seconds"] * 50)
    assert voice_files(root) == []


def test_too_big_wrong_type_and_garbage_are_refused(worker, arbiter, monkeypatch):
    client, server, root = worker
    rec = arbiter(Recorder())
    big = post(client, b"\x00" * (karaoke.VOICE_MAX_BYTES + 1))
    assert big.status_code == 413 and "larger" in big.json()["error"]
    for ct in ("text/plain", "application/octet-stream", "video/webm", ""):
        assert post(client, recording(0.5), ct).status_code == 415, ct
    assert post(client, b"not audio at all", "audio/wav").status_code == 400
    assert post(client, b"", "audio/wav").status_code == 400
    # Longer than the longest song and half a minute.
    monkeypatch.setenv("SING_MAX_SECONDS", "2")
    long = post(client, recording(33.0))
    assert long.status_code == 413 and "longer" in long.json()["error"]
    assert rec.calls == [] and voice_files(root) == []


def test_the_card_when_no_job_runs(worker, arbiter):
    client, server, _root = worker
    b = server.state.backend
    rec = arbiter(Recorder())
    jobs = client.get("/jobs").json()["jobs"]
    r = post(client, recording(1.0))
    assert r.status_code == 200, r.text
    assert b.karaoke_f0_inputs[-1][1] is None  # where the arbitration placed it: the worker's device
    assert rec.names() == ["start", "place", "arm", "run_begins", "run_ended", "give_back", "finish"]
    job = rec.calls[0][1]
    # A karaoke job's stage (share only, never urgent), reference's VRAM profile; no list shows it.
    assert job.id.startswith("voice-") and job.is_karaoke and rec.calls[1] == ("place", "reference")
    assert job.id not in server.state.jobs and client.get("/jobs").json()["jobs"] == jobs
    assert not server._queued() and server.state.running is None and not server._urgent(job)


def test_the_cpu_at_once_while_a_job_runs(worker, arbiter):
    client, server, _root = worker
    b = server.state.backend
    rec = arbiter(Recorder())
    held = server.state.voice_lock.acquire(timeout=10)  # as the job loop does around a job
    assert held
    try:
        r = post(client, recording(1.0))
    finally:
        server.state.voice_lock.release()
    assert r.status_code == 200 and r.json()["device"] == "cpu"
    assert b.karaoke_f0_inputs[-1][1] == "cpu" and rec.calls == []  # nobody asked, nothing paused


def test_a_running_job_is_not_paused_for_a_singer(worker, monkeypatch):
    client, server, _root = worker
    b = server.state.backend
    go = threading.Event()
    monkeypatch.setattr(b, "lyrics_gate", lambda: go.wait(30))  # holds the job in its lyrics stage
    job_id = client.post("/jobs", json={"query": "voice next to a job"}).json()["job"]["id"]
    try:
        t0 = time.time()
        while client.get(f"/jobs/{job_id}").json()["job"]["state"] != "running":
            assert time.time() - t0 < 30
            time.sleep(0.02)
        r = post(client, recording(1.0))
        assert r.status_code == 200 and r.json()["device"] == "cpu" and b.karaoke_f0_inputs[-1][1] == "cpu"
    finally:
        go.set()
    t0 = time.time()
    while (job := client.get(f"/jobs/{job_id}").json()["job"])["state"] not in ("done", "failed", "cancelled"):
        assert time.time() - t0 < 60
        time.sleep(0.02)
    assert job["state"] == "done", job


def test_a_job_waits_for_a_singer_on_the_card(worker, monkeypatch):
    client, server, _root = worker
    assert server.state.voice_lock.acquire(timeout=10)  # a voice on the card
    try:
        job_id = client.post("/jobs", json={"query": "after a voice"}).json()["job"]["id"]
        time.sleep(0.4)
        assert client.get(f"/jobs/{job_id}").json()["job"]["state"] == "queued"
    finally:
        server.state.voice_lock.release()
    t0 = time.time()
    while (job := client.get(f"/jobs/{job_id}").json()["job"])["state"] not in ("done", "failed", "cancelled"):
        assert time.time() - t0 < 60
        time.sleep(0.02)
    assert job["state"] == "done", job


def test_not_placed_in_time_goes_to_the_cpu(worker, arbiter, monkeypatch):
    from engine import Cancelled

    client, server, _root = worker
    b = server.state.backend
    monkeypatch.setenv("SING_KARAOKE_VOICE_WAIT_S", "0.2")

    def wait_for_room(job):  # a card that never has room
        while not job.cancel.wait(0.01):
            pass
        raise Cancelled()

    rec = arbiter(Recorder(place=wait_for_room))
    t0 = time.time()
    r = post(client, recording(1.0))
    assert r.status_code == 200 and r.json()["device"] == "cpu" and time.time() - t0 < 10
    assert b.karaoke_f0_inputs[-1][1] == "cpu"
    assert rec.names() == ["start", "place", "give_back", "finish"]  # the lease is ended all the same


def test_self_arbitration_shares_the_card(worker, monkeypatch, tmp_path):
    from gpu import Audience, Profile

    client, server, _root = worker
    b = server.state.backend
    monkeypatch.setattr(server.state, "arbitration", server._SELF)
    monkeypatch.setattr(b, "uses_cuda", lambda: True)
    monkeypatch.setattr(b, "vram", lambda peek=False: (20000, 24576))
    monkeypatch.setenv("SING_GPU_POLICY", "share")
    monkeypatch.delenv("SING_OFFLOAD_URLS", raising=False)
    m = server.state.machine
    monkeypatch.setattr(m, "profile", Profile(tmp_path))
    monkeypatch.setattr(m, "audience", Audience())
    r = post(client, recording(1.0))
    assert r.status_code == 200, r.text
    assert r.json()["device"] == "cuda" and b.karaoke_f0_inputs[-1][1] is None


def test_hostd_arbitration_is_asked_for_a_shared_lease(worker, arbiter):
    import lease

    client, server, _root = worker
    asked: list[tuple[str, dict]] = []

    def call(method: str, params: dict, timeout: float) -> Any:
        asked.append((method, params))
        if method == "gpu.state":
            return {"policy": "yield", "policy_source": "default"}
        if method == "gpu.acquire":
            return {"type": "granted", "lease": params["job"], "mode": "share", "code": "fits", "reason": "",
                    "free_mb": 9000}
        if method == "gpu.renew":
            return {"ok": True, "action": None, "clear_steps": False, "learned": None}
        if method == "gpu.release":
            return {"reloaded": [], "errors": [], "reload_s": None, "closed": True, "summary": None}
        raise AssertionError(method)

    arbiter(lease.HostdArbitration(lambda: server.state.backend, server.state.machine.profile,
                                   stage_pauses=server._stage_pauses, stage_uses_gpu=server._stage_uses_gpu,
                                   queued=server._queued_behind, call=call))
    r = post(client, recording(1.0))
    assert r.status_code == 200, r.text
    methods = [m for m, _ in asked]
    assert methods[0] == "gpu.state" and "gpu.acquire" in methods and methods[-1] == "gpu.release"
    acquire = next(p for m, p in asked if m == "gpu.acquire")
    assert acquire["job"].startswith("voice-") and acquire["stage"] == "reference"
    assert acquire["mode"] == "share" and acquire["queued"] == [] and acquire["pauses"] is False
    release = asked[-1][1]
    assert release["done"] is True and release["lease"] == acquire["job"]


def test_leftovers_are_swept(worker, arbiter):
    client, _server, root = worker
    arbiter(Recorder())
    d = root / karaoke.VOICE_DIR
    d.mkdir(parents=True, exist_ok=True)
    old, fresh = d / "old.webm", d / "fresh.webm"
    for p in (old, fresh):
        p.write_bytes(b"x")
    long_ago = time.time() - karaoke.VOICE_KEEP_S - 60
    os.utime(old, (long_ago, long_ago))
    assert post(client, recording(0.5)).status_code == 200
    assert voice_files(root) == ["fresh.webm"]
    fresh.unlink()
    assert karaoke.sweep_voice(d, now=time.time()) == 0
    assert karaoke.sweep_voice(root / "nowhere") == 0


def test_the_pitch_is_the_references_treatment():
    import numpy as np

    sr = 16_000
    seconds = 1.0
    t = np.arange(int(sr * seconds)) / sr
    mono = 0.3 * np.sin(2 * math.pi * 220 * t)
    mono[: sr // 2] *= 0.001  # the first half 60 dB down: gated, whatever RMVPE says
    f0 = np.full(101, 440.0)
    f0[70:72] = 880.0  # an octave error for 20 ms: cleaned
    got = karaoke.voice_pitch(f0, mono, sr, seconds)
    assert len(got["midi"]) == 50
    assert all(m is None for m in got["midi"][:24]) and all(m == 69.0 for m in got["midi"][26:])
    assert got["level_db"] == pytest.approx(20 * math.log10(0.3 / math.sqrt(2)), abs=0.5)
    assert got["floor_db"] < -60
    silent = karaoke.voice_pitch(np.zeros(101), np.zeros(sr), sr, seconds)
    assert silent["level_db"] is None and all(m is None for m in silent["midi"])
    assert karaoke.voice_type("audio/webm;codecs=opus") == ".webm" and karaoke.voice_type("audio/mpeg") is None
