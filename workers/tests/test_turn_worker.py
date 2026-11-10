"""End-of-turn worker with a stubbed `onnxruntime`: no model files, no real inference.

What these tests prove is the plumbing around the two models (tensor names and shapes as the
upstream code uses them, state carried between frames, what happens without a model). Whether Smart
Turn and Silero judge speech well can only be seen with the real files in the live run.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import numpy as np
import pytest
from conftest import ROOT
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


class FakeSession:
    """Answers like the ONNX models, recording what it was given."""

    def __init__(self, path, sess_options=None, providers=None):
        self.path = str(path)
        self.calls: list[dict] = []
        FakeOrt.sessions.append(self)

    def run(self, _outputs, feeds):
        self.calls.append(feeds)
        if "input_features" in feeds:
            return [np.array([[FakeOrt.turn_probability]], dtype=np.float32)]
        return [np.array([[0.75]], dtype=np.float32), feeds["state"] + 1]


class FakeOrt:
    sessions: list[FakeSession] = []
    turn_probability = 0.8


def fake_ort() -> types.ModuleType:
    mod = types.ModuleType("onnxruntime")

    class SessionOptions:
        pass

    mod.SessionOptions = SessionOptions
    mod.ExecutionMode = types.SimpleNamespace(ORT_SEQUENTIAL=0)
    mod.GraphOptimizationLevel = types.SimpleNamespace(ORT_ENABLE_ALL=99)
    mod.InferenceSession = FakeSession
    return mod


@pytest.fixture
def load(monkeypatch, tmp_path):
    """A fresh worker; `models=False` leaves the model files out."""
    FakeOrt.sessions = []
    FakeOrt.turn_probability = 0.8
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort())
    monkeypatch.syspath_prepend(str(ROOT / "turn"))
    for name in ("features", "models"):
        monkeypatch.delitem(sys.modules, name, raising=False)

    def start(models: bool = True, **env: str):
        smart, silero = tmp_path / "smart.onnx", tmp_path / "silero.onnx"
        if models:
            smart.write_bytes(b"x")
            silero.write_bytes(b"x")
        monkeypatch.setenv("TURN_SMART_MODEL", str(smart))
        monkeypatch.setenv("TURN_SILERO_MODEL", str(silero))
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        spec = importlib.util.spec_from_file_location("turn_server_under_test", ROOT / "turn" / "server.py")
        server = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, "turn_server_under_test", server)
        spec.loader.exec_module(server)
        return server

    return start


def pcm(seconds: float, level: int = 3000) -> bytes:
    return (np.ones(int(seconds * 16000), dtype="<i2") * level).tobytes()


def test_health_says_what_is_loaded(load):
    with TestClient(load().app) as c:
        h = c.get("/health").json()
    assert h["status"] == "ok" and h["smart_turn"] is True and h["silero"] is True and h["errors"] == {}


def test_missing_models_leave_the_worker_running(load):
    server = load(models=False)
    with TestClient(server.app) as c:
        h = c.get("/health").json()
        assert h["status"] == "ok" and h["smart_turn"] is False and h["silero"] is False
        assert "not found" in h["errors"]["smart_turn"]
        r = c.post("/turn", content=pcm(1))
        assert r.status_code == 503 and "not loaded" in r.json()["error"]
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/vad") as ws:
                ws.receive_text()


def test_a_broken_model_file_is_a_missing_model(load, monkeypatch):
    server = load()

    def boom(*_a, **_k):
        raise RuntimeError("bad protobuf")

    monkeypatch.setattr(sys.modules["onnxruntime"], "InferenceSession", boom)
    with TestClient(server.app) as c:
        h = c.get("/health").json()
    assert h["smart_turn"] is False and "bad protobuf" in h["errors"]["smart_turn"]


def test_turn_feeds_the_model_what_the_reference_code_does(load):
    with TestClient(load().app) as c:
        r = c.post("/turn", content=pcm(2.5), headers={"x-sample-rate": "16000"})
    assert r.status_code == 200
    body = r.json()
    assert body["complete"] is True and body["probability"] == pytest.approx(0.8)
    smart = FakeOrt.sessions[0]
    feeds = smart.calls[0]
    assert set(feeds) == {"input_features"}
    assert feeds["input_features"].shape == (1, 80, 800) and feeds["input_features"].dtype == np.float32


def test_the_threshold_decides(load):
    FakeOrt.turn_probability = 0.6
    with TestClient(load(TURN_THRESHOLD="0.7").app) as c:
        assert c.post("/turn", content=pcm(1)).json()["complete"] is False


def test_turn_rejects_what_is_not_16k_pcm(load):
    with TestClient(load().app) as c:
        assert c.post("/turn", content=pcm(1), headers={"x-sample-rate": "48000"}).status_code == 400
        assert c.post("/turn", content=b"\x01").status_code == 400
        assert c.post("/turn", content=b"").status_code == 400


def test_a_failing_model_is_a_500_not_a_dead_worker(load, monkeypatch):
    server = load()
    with TestClient(server.app) as c:
        monkeypatch.setattr(server.state.smart, "probability", lambda _a: 1 / 0)
        r = c.post("/turn", content=pcm(1))
        assert r.status_code == 500 and "inference failed" in r.json()["error"]
        assert c.get("/health").json()["status"] == "ok"


def test_vad_keeps_state_and_context_per_connection(load):
    frame = pcm(512 / 16000, 1000)
    with TestClient(load().app) as c:
        with c.websocket_connect("/vad") as ws:
            for _ in range(3):
                ws.send_bytes(frame)
                assert float(ws.receive_text()) == pytest.approx(0.75)
        with c.websocket_connect("/vad") as ws:
            ws.send_bytes(frame)
            ws.receive_text()
    silero = FakeOrt.sessions[1]
    first, second, third, other = silero.calls
    assert set(first) == {"input", "state", "sr"}
    assert first["input"].shape == (1, 576) and first["state"].shape == (2, 1, 128)
    assert first["sr"].dtype == np.int64 and int(first["sr"]) == 16000
    # The state of the last call, and its last 64 samples, go into the next one.
    assert second["state"][0, 0, 0] == 1 and third["state"][0, 0, 0] == 2
    assert np.allclose(second["input"][0, :64], first["input"][0, -64:])
    # A new stream starts clean.
    assert other["state"][0, 0, 0] == 0


def test_vad_refuses_frames_of_the_wrong_size(load):
    with TestClient(load().app) as c:
        with c.websocket_connect("/vad") as ws:
            ws.send_bytes(b"\x00\x00" * 100)
            with pytest.raises(WebSocketDisconnect):
                ws.receive_text()


def test_features_put_short_audio_at_the_end_of_the_window(load):
    load()
    import features

    audio = np.ones(16000, dtype=np.float32)
    window = features.fit_to_window(audio)
    assert window.size == features.N_SAMPLES and window[0] == 0 and window[-1] == 1
    long = np.arange(features.N_SAMPLES + 100, dtype=np.float32)
    assert features.fit_to_window(long)[0] == 100


def test_features_match_transformers_when_it_is_there(load):
    pytest.importorskip("transformers")
    load()
    import features
    from transformers import WhisperFeatureExtractor

    t = np.arange(32000) / 16000
    audio = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    want = WhisperFeatureExtractor(chunk_length=8)(
        features.fit_to_window(audio), sampling_rate=16000, return_tensors="np", padding="max_length",
        max_length=features.N_SAMPLES, truncation=True, do_normalize=True).input_features
    assert np.abs(want - features.log_mel(audio)).max() < 1e-3


def test_calibrate_recommends_the_lowest_safe_threshold(load):
    load()
    spec = importlib.util.spec_from_file_location("calibrate", ROOT / "turn" / "calibrate.py")
    calibrate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(calibrate)
    rows = calibrate.table(complete=[0.9, 0.8, 0.7, 0.4], incomplete=[0.2, 0.3, 0.6])
    assert calibrate.recommend(rows, max_cut=0.0) == pytest.approx(0.65)
    assert calibrate.recommend(calibrate.table([0.9], [0.95]), max_cut=0.0) is None


def test_calibrate_reads_any_wav(load, tmp_path: Path):
    from conftest import make_wav

    load()
    spec = importlib.util.spec_from_file_location("calibrate", ROOT / "turn" / "calibrate.py")
    calibrate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(calibrate)
    path = tmp_path / "a.wav"
    path.write_bytes(make_wav(1.0, rate=48_000, channels=2))
    assert calibrate.read_wav(path).size == 16000


def test_the_fake_worker_speaks_the_same_contract(fake_client, monkeypatch):
    body = fake_client.post("/turn", content=pcm(1)).json()
    assert body["complete"] is True and body["probability"] == pytest.approx(0.9)
    monkeypatch.setenv("FAKE_TURN_PROB", "0.2")
    assert fake_client.post("/turn", content=pcm(1)).json()["complete"] is False
    assert fake_client.get("/busy").json() == {"busy": 0}
    with fake_client.websocket_connect("/vad") as ws:
        ws.send_bytes(pcm(512 / 16000, 5000))
        assert float(ws.receive_text()) > 0.5
        ws.send_bytes(pcm(512 / 16000, 0))
        assert float(ws.receive_text()) < 0.5
