"""``POST /karaoke/stream`` of the song worker: the live voices of a karaoke room's singers
(workers/sing/karaoke_stream.py, server.py). Mock backend: its stream pitch tracker reads the zero
crossings of 40 ms around each frame, so a window of a signal answers what the whole signal does.
No GPU, no network, nothing on disk; the voices are sine tunes made here."""

from __future__ import annotations

import base64
import importlib.util
import math
import os
import random
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))

import contracts  # noqa: E402
import karaoke  # noqa: E402
import karaoke_stream as ks  # noqa: E402

RATE = ks.RATE


@pytest.fixture(scope="module")
def worker(tmp_path_factory):
    root = tmp_path_factory.mktemp("songs-karaoke-stream")
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


@pytest.fixture(autouse=True)
def fresh_book(request, monkeypatch):
    """Every test starts with no stream open (the book is the worker's, across rooms)."""
    if "worker" in request.fixturenames:
        _client, server, _root = request.getfixturevalue("worker")
        monkeypatch.setattr(server.state, "streams", server._new_streams())
        server.state.backend.karaoke_stream_release()


# ── signals ──────────────────────────────────────────────────────────────────


def ulaw_encode(x: np.ndarray) -> bytes:
    """int16 -> G.711 µ-law (the classic encoder, bias 0x84, clip 32635)."""
    v = np.asarray(x, dtype=np.int32)
    sign = (v < 0).astype(np.int32)
    mag = np.minimum(np.abs(v), 32635) + 0x84
    exp = np.floor(np.log2(mag)).astype(np.int32) - 7
    mant = (mag >> (exp + 3)) & 0x0F
    return (~((sign << 7) | (exp << 4) | mant) & 0xFF).astype(np.uint8).tobytes()


TUNE = [(0.6, 220.0), (0.2, 0.0), (0.7, 330.0), (0.2, 0.0), (0.9, 262.0), (0.2, 0.0), (0.8, 392.0), (0.4, 0.0)]


def tune(parts: list[tuple[float, float]] = TUNE, amp: float = 0.3) -> np.ndarray:
    """Sine notes and silences, as int16."""
    out = []
    for seconds, hz in parts:
        n = int(round(seconds * RATE))
        t = np.arange(n) / RATE
        out.append(np.zeros(n) if hz == 0 else amp * np.sin(2 * math.pi * hz * t))
    return np.round(np.concatenate(out) * 32767).astype(np.int16)


def as_ulaw(samples: np.ndarray) -> tuple[bytes, np.ndarray]:
    """(µ-law bytes, what they decode to as float32 in [-1, 1)): what the worker hears."""
    data = ulaw_encode(samples)
    return data, ks.mulaw_decode(data).astype(np.float32) / np.float32(32768.0)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def whole_pitch(backend: Any, heard: np.ndarray) -> dict[str, Any]:
    """The one-shot answer for the same audio: the tracker over all of it, then voice_pitch."""
    f0 = backend.karaoke_f0_audio(heard, RATE, "cpu")
    return karaoke.voice_pitch(f0, heard, RATE, heard.size / RATE, clean=True)


def pieces(total: int, rng: random.Random, lo: int = 900, hi: int = 12_000) -> list[tuple[int, int]]:
    """[a, b) sample ranges of random lengths covering [0, total)."""
    out, a = [], 0
    while a < total:
        b = min(total, a + rng.randint(lo, hi))
        out.append((a, b))
        a = b
    return out


def schedule(total: int, rng: random.Random) -> list[tuple[int, int]]:
    """Random chunks in order, with a retried chunk, an overlapping one and an old one arriving late."""
    ps = pieces(total, rng)
    out: list[tuple[int, int]] = []
    for i, (a, b) in enumerate(ps):
        out.append((a, b))
        if i == 1:
            out.append((a, b))  # a retry of the same chunk
        if i == 2 and i + 1 < len(ps):
            mid = (a + b) // 2
            out.append((mid, min(total, ps[i + 1][0] + 400)))  # half old, a little new
        if i == 4:
            out.append(ps[0])  # an old one, late
    return out


class View:
    """What Core keeps of a stream: each answer replaces its frames from ``from`` on."""

    def __init__(self) -> None:
        self.midi: list[float | None] = []
        self.final: dict[str, Any] | None = None
        self.froms: list[int] = []

    def take(self, frames: dict[str, Any]) -> None:
        start = frames["from"]
        assert start <= len(self.midi), "an answer may not leave a hole"
        self.froms.append(start)
        if frames["final"]:
            self.final = frames
            return
        self.midi = self.midi[:start] + list(frames["midi"])


def assert_close_to_final(view: View, final: list[float | None], share: float = 0.9) -> None:
    n = len(view.midi)
    assert n > 0.6 * len(final)
    same = sum(1 for a, b in zip(view.midi, final[:n]) if a == b)
    assert same >= share * n, f"{same} of {n} provisional frames equal to the final"


# ── µ-law ────────────────────────────────────────────────────────────────────


def test_mulaw_round_trip_is_within_g711():
    t = np.arange(RATE) / RATE
    x = np.round(0.8 * 32767 * np.sin(2 * math.pi * 440 * t)).astype(np.int32)
    back = ks.mulaw_decode(ulaw_encode(x)).astype(np.int32)
    # 4 bits of mantissa: the step of a segment is a sixteenth of its bottom, bias included.
    assert np.all(np.abs(back - x) <= (np.abs(x) + 0x84) / 16 + 1)
    assert ks.MULAW.min() == -32124 and ks.MULAW.max() == 32124
    assert ks.mulaw_decode(ulaw_encode(np.zeros(3, dtype=np.int16))).tolist() == [0, 0, 0]


def test_decode_chunk_refuses_garbage_and_long_chunks():
    with pytest.raises(ks.ChunkError) as e:
        ks.decode_chunk("not base64!!")
    assert e.value.status == 400
    with pytest.raises(ks.ChunkError) as e:
        ks.decode_chunk(b64(b"\xff" * (ks.MAX_CHUNK + 1)))
    assert e.value.status == 413
    assert ks.decode_chunk(b64(b"\xff" * ks.MAX_CHUNK)).size == ks.MAX_CHUNK
    assert ks.decode_chunk("").size == 0


# ── the stream logic, without the web ────────────────────────────────────────


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def feed(book: ks.Streams, backend: Any, data: bytes, plan_of: list[tuple[int, int]], clock: Clock,
         room: str = "r", sid: str = "s") -> tuple[View, list[ks.Window]]:
    view, windows = View(), []
    limits = ks.Limits()
    for i, (a, b) in enumerate(plan_of):
        clock.t += 0.5
        end = i == len(plan_of) - 1
        chunk = ks.Chunk(sid, a, ks.mulaw_decode(data[a:b]), end)
        with book.room(room):
            plan = book.plan(room, [chunk], [], limits)
            assert plan.lost == []
            windows += plan.windows
            f0s = [backend.karaoke_f0_audio(w.x, RATE, "cpu") for w in plan.windows]
            got = book.commit(plan, f0s)
        assert [g["stream"] for g in got] == [sid]
        view.take(got[0])
    return view, windows


def test_the_final_curve_is_the_whole_signals_frame_for_frame(worker):
    """The key property: whatever the chunks, the final answer is the one-shot answer of the same
    audio, and what was said before it converges to it."""
    _client, server, _root = worker
    backend = server.state.backend
    data, heard = as_ulaw(tune())
    want = whole_pitch(backend, heard)
    voiced = [m for m in want["midi"] if m is not None]
    # The mock tracker reads the tune's notes (A3, E4, C4, G4).
    assert {round(m) for m in voiced} >= {57, 64, 60, 67}
    t0 = time.perf_counter()
    for seed in range(6):
        rng = random.Random(seed)
        order = schedule(len(data), rng)
        # The late old chunk comes after the end in one run: the end must be the last chunk sent.
        last = max(b for _a, b in order)
        order = [c for c in order if c[1] < last] + [c for c in order if c[1] == last][-1:]
        book = ks.Streams(clock=Clock())
        view, windows = feed(book, backend, data, order, book.clock)
        assert view.final is not None, seed
        assert view.final["from"] == 0
        assert view.final["midi"] == want["midi"], seed
        assert (view.final["level_db"], view.final["floor_db"]) == (want["level_db"], want["floor_db"])
        assert view.final["seconds"] == pytest.approx(heard.size / RATE, abs=1e-3)
        assert len(view.final["midi"]) == round(heard.size / RATE * 50)
        assert_close_to_final(view, want["midi"])
        assert len(book) == 0  # forgotten
        # Bounded windows: never the whole song, a second of context at most before what is new.
        assert all(w.x.size <= ks.CONTEXT + ks.MAX_CHUNK + ks.LOOKAHEAD + ks.HOP for w in windows)
        assert time.perf_counter() - t0 < 30
    # ``from`` goes back a second before what is new, never before 0.
    assert view.froms[0] == 0 and all(f >= 0 for f in view.froms)


def test_provisional_frames_follow_the_stream(worker):
    _client, server, _root = worker
    backend = server.state.backend
    data, heard = as_ulaw(tune())
    want = whole_pitch(backend, heard)["midi"]
    book = ks.Streams(clock=Clock())
    limits = ks.Limits()
    half = RATE // 2
    view = View()
    froms = []
    for a in range(0, len(data), half):
        book.clock.t += 0.5
        with book.room("r"):
            plan = book.plan("r", [ks.Chunk("s", a, ks.mulaw_decode(data[a:a + half]))], [], limits)
            got = book.commit(plan, [backend.karaoke_f0_audio(w.x, RATE, "cpu") for w in plan.windows])[0]
        assert not got["final"] and got["level_db"] is None and got["floor_db"] is None
        froms.append(got["from"])
        view.take(got)
        s = book.get("r", "s")
        # Committed up to the end less the lookahead; answered to the committed end.
        assert s.nf == (s.n - ks.LOOKAHEAD) // ks.HOP + 1
        assert got["from"] + len(got["midi"]) == s.nf // ks.STEP
        assert got["seconds"] == pytest.approx(s.n / RATE)
    # Each answer starts a second (50 frames) before the first frame that was new.
    # (0.5 s a request is 25 frames at 50 Hz; the first answers start at 0.)
    assert froms[:3] == [0, 0, 0] and all(b - a == 25 for a, b in zip(froms[3:], froms[4:]))
    assert_close_to_final(view, want, 0.95)


def test_gaps_retries_and_old_chunks():
    book = ks.Streams(clock=Clock())
    limits = ks.Limits()
    ones = np.full(1000, 7, dtype=np.int16)
    with book.room("r"):
        book.plan("r", [ks.Chunk("s", 0, ones)], [], limits)
        s = book.get("r", "s")
        book.plan("r", [ks.Chunk("s", 3000, ones)], [], limits)  # 2000 samples never came
        assert s.n == 4000 and not s.audio.view(1000, 3000).any() and (s.audio.view(3000, 4000) == 7).all()
        before = s.audio.view().copy()
        book.plan("r", [ks.Chunk("s", 3000, np.full(1000, 9, dtype=np.int16))], [], limits)  # a retry
        book.plan("r", [ks.Chunk("s", 0, np.full(500, 9, dtype=np.int16))], [], limits)  # an old one
        assert np.array_equal(s.audio.view(), before)
        book.plan("r", [ks.Chunk("s", 3500, np.full(1000, 9, dtype=np.int16))], [], limits)  # half new
        assert s.n == 4500 and (s.audio.view(3500, 4000) == 7).all() and (s.audio.view(4000, 4500) == 9).all()


def test_the_clock_and_the_length_caps():
    clock = Clock()
    book = ks.Streams(clock=clock)
    limits = ks.Limits(max_seconds=6.0, ahead_s=5.0)
    four = np.zeros(4 * RATE, dtype=np.int16)
    with book.room("r"):
        assert book.plan("r", [ks.Chunk("a", 0, four)], [], limits).lost == []
        # 8 s read 0 s after it opened: ahead of the clock.
        assert book.plan("r", [ks.Chunk("a", 4 * RATE, four)], [], limits).lost == ["a"]
        assert book.get("r", "a") is None
        assert book.plan("r", [ks.Chunk("b", 0, four)], [], limits).lost == []
        clock.t += 10
        # Longer than the longest song allowed (6 s here).
        assert book.plan("r", [ks.Chunk("b", 4 * RATE, four)], [], limits).lost == ["b"]


def test_the_tracker_is_let_go_when_the_last_stream_is_forgotten():
    released = []
    book = ks.Streams(on_empty=lambda: released.append(1), clock=Clock())
    limits = ks.Limits()
    with book.room("r"):
        book.plan("r", [ks.Chunk("a", 0, np.zeros(10, dtype=np.int16)),
                        ks.Chunk("b", 0, np.zeros(10, dtype=np.int16))], [], limits)
    book.forget("r", ["a"])
    assert released == [] and len(book) == 1
    book.clock.t += 31
    assert book.sweep(30.0) == 1 and released == [1] and len(book) == 0


# ── the endpoint ─────────────────────────────────────────────────────────────


def post(client, room: str, chunks: list[dict[str, Any]], drop: list[str] | None = None):
    body: dict[str, Any] = {"room": room, "chunks": chunks}
    if drop is not None:
        body["drop"] = drop
    return client.post("/karaoke/stream", json=body)


def chunk(stream: str, at: int, data: bytes, end: bool = False) -> dict[str, Any]:
    return {"stream": stream, "at": at, "audio": b64(data), "end": end}


def answer(r) -> contracts.WorkersKaraokeStreamAnswer:
    assert r.status_code == 200, r.text
    got = contracts.WorkersKaraokeStreamAnswer.model_validate_json(r.content)
    assert got.hz == 50 and got.method == "rmvpe" and got.device in ("cpu", "cuda")
    for s in r.json()["streams"]:
        assert "from" in s and "from_" not in s  # by the contract's name
    return got


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


def files_under(root: Path) -> set[str]:
    return {str(p.relative_to(root)) for p in root.rglob("*")}


def test_a_room_sings_and_ends_through_the_endpoint(worker, arbiter):
    client, server, root = worker
    b = server.state.backend
    arbiter(Recorder())
    before_files = files_under(root)
    loads = b.stream_loads
    releases = b.stream_releases
    data_a, heard_a = as_ulaw(tune())
    data_b, heard_b = as_ulaw(tune([(0.5, 0.0), (1.5, 294.0), (0.5, 0.0), (1.0, 440.0)], amp=0.2))
    rng = random.Random(7)
    order_a, order_b = schedule(len(data_a), rng), pieces(len(data_b), rng, 4000, 9000)
    views = {"a": View(), "b": View()}
    for i in range(max(len(order_a), len(order_b))):
        chunks = []
        for sid, order, data in (("a", order_a, data_a), ("b", order_b, data_b)):
            if i < len(order):
                a, e = order[i]
                chunks.append(chunk(sid, a, data[a:e]))
        got = answer(post(client, "room1", chunks))
        assert got.lost == [] and {s.stream for s in got.streams} == {c["stream"] for c in chunks}
        for s in got.streams:
            assert not s.final and s.level_db is None
            views[s.stream].take(s.model_dump(by_alias=True))
    assert b.stream_loads == loads + 1  # loaded once, kept between the requests
    wants = {"a": whole_pitch(b, heard_a), "b": whole_pitch(b, heard_b)}
    got = answer(post(client, "room1", [chunk("a", len(data_a), b"", end=True),
                                        chunk("b", len(data_b), b"", end=True)]))
    for s in got.streams:
        views[s.stream].take(s.model_dump(by_alias=True))
    for sid in ("a", "b"):
        final, want = views[sid].final, wants[sid]
        assert final is not None and final["from"] == 0 and final["final"]
        assert final["midi"] == want["midi"] and final["level_db"] == want["level_db"]
        assert final["floor_db"] == want["floor_db"]
        assert_close_to_final(views[sid], want["midi"])
    # Both forgotten, the tracker with them; a late chunk of either is lost.
    assert len(server.state.streams) == 0
    assert b.stream_releases == releases + 1 and not b.stream_loaded
    late = answer(post(client, "room1", [chunk("a", len(data_a), data_a[:800])]))
    assert late.lost == ["a"] and late.streams == []
    # Nothing was written under the data dir.
    assert files_under(root) == before_files


def test_end_with_audio_and_an_empty_stream(worker, arbiter):
    client, server, _root = worker
    arbiter(Recorder())
    data, heard = as_ulaw(tune([(1.0, 330.0)]))
    got = answer(post(client, "r", [chunk("x", 0, data, end=True), chunk("y", 0, b"", end=True)]))
    by = {s.stream: s for s in got.streams}
    assert by["x"].final and by["x"].midi == whole_pitch(server.state.backend, heard)["midi"]
    assert by["y"].final and by["y"].midi == [] and by["y"].seconds == 0 and by["y"].level_db is None
    assert len(server.state.streams) == 0


def test_refused_requests(worker, arbiter, monkeypatch):
    client, server, _root = worker
    rec = arbiter(Recorder())
    bad = post(client, "r", [{"stream": "s", "at": 0, "audio": "%%%not base64"}])
    assert bad.status_code == 400 and "base64" in bad.json()["error"]
    long = post(client, "r", [chunk("s", 0, b"\xff" * (ks.MAX_CHUNK + 1))])
    assert long.status_code == 413
    nine = post(client, "r", [chunk(f"s{i}", 0, b"\xff") for i in range(9)])
    assert nine.status_code == 400
    assert post(client, "bad room!", [chunk("s", 0, b"\xff")]).status_code == 400
    assert client.post("/karaoke/stream", content=b"{not json", headers={"content-type": "application/json"}).status_code == 400
    huge = client.post("/karaoke/stream", content=b" " * (ks.MAX_BODY + 1), headers={"content-type": "application/json"})
    assert huge.status_code == 413
    # Nothing was opened by any of them (a bad chunk refuses the whole request).
    assert len(server.state.streams) == 0 and rec.calls == []


def test_over_the_cap_unknown_and_dropped_streams_are_lost(worker, arbiter, monkeypatch):
    client, server, _root = worker
    arbiter(Recorder())
    monkeypatch.setenv("SING_KARAOKE_STREAMS_MAX", "2")
    data, _heard = as_ulaw(tune([(0.5, 330.0)]))
    got = answer(post(client, "r", [chunk("a", 0, data), chunk("b", 0, data), chunk("c", 0, data)]))
    assert got.lost == ["c"] and [s.stream for s in got.streams] == ["a", "b"]
    # A stream it never had (it started on another worker): lost, no audio is made up.
    got = answer(post(client, "r2", [chunk("z", 8000, data)]))
    assert got.lost == ["z"] and got.streams == []
    # A singer who left.
    got = answer(post(client, "r", [chunk("a", len(data), data)], drop=["b"]))
    assert got.lost == [] and [s.stream for s in got.streams] == ["a"]
    assert server.state.streams.get("r", "b") is None
    got = answer(post(client, "r", [chunk("b", len(data), data)]))
    assert got.lost == ["b"]
    # Streams are per room: the same id in another room is another stream.
    got = answer(post(client, "r3", [chunk("a", 0, data)]))
    assert got.lost == [] and server.state.streams.get("r", "a") is not server.state.streams.get("r3", "a")


def test_ahead_of_the_clock_and_too_long_are_lost(worker, arbiter, monkeypatch):
    client, server, _root = worker
    arbiter(Recorder())
    four, _ = as_ulaw(np.zeros(ks.MAX_CHUNK, dtype=np.int16))
    assert answer(post(client, "r", [chunk("a", 0, four)])).lost == []
    assert answer(post(client, "r", [chunk("a", ks.MAX_CHUNK, four)])).lost == ["a"]  # 8 s in no time
    monkeypatch.setenv("SING_MAX_SECONDS", "-28")  # 2 s
    one, _ = as_ulaw(np.zeros(RATE, dtype=np.int16))
    assert answer(post(client, "r", [chunk("b", 0, one)])).lost == []
    got = answer(post(client, "r", [chunk("b", RATE, one + one), chunk("c", 0, one + one + one)]))
    assert sorted(got.lost) == ["b", "c"]


def test_idle_streams_are_forgotten(worker, arbiter, monkeypatch):
    client, server, _root = worker
    b = server.state.backend
    arbiter(Recorder())
    data, _ = as_ulaw(tune([(0.5, 330.0)]))
    assert answer(post(client, "r", [chunk("a", 0, data)])).lost == []
    releases = b.stream_releases
    monkeypatch.setenv("SING_KARAOKE_STREAM_IDLE_S", "0.2")
    time.sleep(0.3)
    got = answer(post(client, "r", [chunk("a", len(data), data)]))
    assert got.lost == ["a"] and b.stream_releases == releases + 1


def test_on_the_card_when_no_job_runs_one_placement_a_request(worker, arbiter):
    client, server, _root = worker
    b = server.state.backend
    rec = arbiter(Recorder())
    data, _ = as_ulaw(tune([(1.0, 330.0)]))
    n = len(b.karaoke_stream_inputs)
    got = answer(post(client, "r", [chunk("a", 0, data), chunk("b", 0, data), chunk("c", 0, data)]))
    assert len(got.streams) == 3
    assert [d for _n, d in b.karaoke_stream_inputs[n:]] == [None, None, None]  # where it was placed
    assert rec.names() == ["start", "place", "arm", "run_begins", "run_ended", "give_back", "finish"]
    job = rec.calls[0][1]
    assert job.id.startswith("stream-") and job.is_karaoke and rec.calls[1] == ("place", "reference")
    assert job.id not in server.state.jobs and not server._urgent(job)


def test_the_cpu_at_once_while_a_job_runs(worker, arbiter):
    client, server, _root = worker
    b = server.state.backend
    rec = arbiter(Recorder())
    data, _ = as_ulaw(tune([(1.0, 330.0)]))
    assert server.state.voice_lock.acquire(timeout=10)  # as the job loop does around a job
    try:
        t0 = time.perf_counter()
        got = answer(post(client, "r", [chunk("a", 0, data), chunk("b", 0, data)]))
        took = time.perf_counter() - t0
    finally:
        server.state.voice_lock.release()
    assert got.device == "cpu" and [d for _n, d in b.karaoke_stream_inputs[-2:]] == ["cpu", "cpu"]
    assert rec.calls == [] and took < 2.0  # nobody asked, nothing waited, nothing paused


def test_not_placed_in_time_goes_to_the_cpu(worker, arbiter, monkeypatch):
    from engine import Cancelled

    client, server, _root = worker
    b = server.state.backend
    monkeypatch.setenv("SING_KARAOKE_STREAM_WAIT_S", "0.1")

    def wait_for_room(job):  # a card that never has room
        while not job.cancel.wait(0.01):
            pass
        raise Cancelled()

    rec = arbiter(Recorder(place=wait_for_room))
    data, _ = as_ulaw(tune([(1.0, 330.0)]))
    t0 = time.perf_counter()
    got = answer(post(client, "r", [chunk("a", 0, data)]))
    assert got.device == "cpu" and time.perf_counter() - t0 < 5
    assert b.karaoke_stream_inputs[-1][1] == "cpu"
    assert rec.names() == ["start", "place", "give_back", "finish"]


def test_a_failure_on_the_card_goes_to_the_cpu(worker, arbiter, monkeypatch):
    client, server, _root = worker
    b = server.state.backend
    arbiter(Recorder())
    real = b.karaoke_f0_audio

    def flaky(x, sr, device=None):
        if device is None:
            raise RuntimeError("CUDA out of memory")
        return real(x, sr, device)

    monkeypatch.setattr(b, "karaoke_f0_audio", flaky)
    data, _ = as_ulaw(tune([(1.0, 330.0)]))
    got = answer(post(client, "r", [chunk("a", 0, data)]))
    assert got.device == "cpu" and len(got.streams) == 1 and got.streams[0].midi


def test_rooms_overlap(worker, arbiter):
    client, server, _root = worker
    arbiter(Recorder())
    data, heard = as_ulaw(tune([(2.0, 262.0)]))
    want = whole_pitch(server.state.backend, heard)["midi"]
    results: dict[str, Any] = {}

    def sing(room: str) -> None:
        for a, e in pieces(len(data), random.Random(room), 4000, 8000):
            post(client, room, [chunk("s", a, data[a:e])])
        results[room] = post(client, room, [chunk("s", len(data), b"", end=True)]).json()

    threads = [threading.Thread(target=sing, args=(f"room{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert len(results) == 4
    for got in results.values():
        assert got["streams"][0]["final"] and got["streams"][0]["midi"] == want
    assert len(server.state.streams) == 0
