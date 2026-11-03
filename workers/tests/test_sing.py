"""Song worker (workers/sing/server.py) contract, in mock mode: no GPU, no network.

To check the real worker against the same contract (slow: it converts a song):
    WORKER_SING_URL=http://127.0.0.1:8005 WORKER_SING_QUERY="..." pytest tests/test_sing.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))


@pytest.fixture(scope="module")
def sing(tmp_path_factory):
    live = os.environ.get("WORKER_SING_URL")
    if live:
        import httpx

        with httpx.Client(base_url=live, timeout=60) as c:
            yield c
        return
    root = tmp_path_factory.mktemp("songs")
    lib = root / "library"
    (lib / "Owner - Split Song").mkdir(parents=True)
    for name in ("vocals.wav", "instrumental.wav"):
        (lib / "Owner - Split Song" / name).write_bytes(b"")
    (lib / "Owner - Split Song" / "video.mkv").write_bytes(b"video")
    (lib / "Someone - Local Tune.mp3").write_bytes(b"")
    os.environ.update({"SING_BACKEND": "mock", "SING_DATA_DIR": str(root), "SING_MOCK_SECONDS": "2"})
    # By path: the TTS and ASR workers have a `server` module too.
    spec = importlib.util.spec_from_file_location("sing_server", SING / "server.py")
    assert spec and spec.loader
    server = importlib.util.module_from_spec(spec)
    sys.modules["sing_server"] = server
    spec.loader.exec_module(server)
    from fastapi.testclient import TestClient

    with TestClient(server.app) as c:
        yield c


def wait(client, job_id: str, timeout: float = 600) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        job = client.get(f"/jobs/{job_id}").json()["job"]
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def is_mock() -> bool:
    return "WORKER_SING_URL" not in os.environ


def test_health(sing):
    body = sing.get("/health").json()
    assert body["status"] == "ok"
    assert isinstance(body["model"], str) and body["model"]
    assert isinstance(body["busy"], bool)
    assert isinstance(body["queued"], int)


def test_request_needs_exactly_one_source(sing):
    assert sing.post("/jobs", json={}).status_code == 400
    r = sing.post("/jobs", json={"query": "a", "url": "https://youtu.be/x"})
    assert r.status_code == 400
    assert "exactly one" in r.json()["error"]


def test_links_must_be_on_allowed_hosts(sing):
    r = sing.post("/jobs", json={"url": "http://127.0.0.1:8002/tts"})
    assert r.status_code == 400
    assert "allowed host" in r.json()["error"]
    r = sing.post("/jobs", json={"url": "file:///etc/passwd"})
    assert r.status_code == 400


def test_pitch_is_bounded(sing):
    assert sing.post("/jobs", json={"query": "x", "pitch": 40}).status_code == 400
    assert sing.post("/jobs", json={"query": "x", "key": -13}).status_code == 400


def test_job_runs_to_a_cached_song(sing):
    query = os.environ.get("WORKER_SING_QUERY", "twinkle twinkle little star")
    r = sing.post("/jobs", json={"query": query})
    assert r.status_code == 200
    job = r.json()["job"]
    assert job["state"] in ("queued", "running", "done")
    assert job["id"]
    done = wait(sing, job["id"])
    assert done["state"] == "done", done
    song = done["song"]
    assert song["id"] == done["song_id"]
    assert song["play"]["sample_rate"] == 48_000
    assert song["play"]["samples"] > 0
    assert set(song["timings"]) >= {"convert_s", "mix_s", "total_s"}
    assert isinstance(song["pitch"]["vocal_shift"], int)
    if is_mock():
        assert song["title"] == query
        assert song["lyrics"]["synced"] is True
        assert song["lyrics"]["lines"][0] == {"t": 0.0, "text": "mock line 1"}

    pcm = sing.get(f"/songs/{song['id']}/files/play_mix.pcm")
    assert pcm.status_code == 200
    assert pcm.headers["x-sample-rate"] == "48000"
    assert len(pcm.content) == song["play"]["samples"] * 2
    vocals = sing.get(f"/songs/{song['id']}/files/play_vocals.pcm")
    assert vocals.status_code == 200 and len(vocals.content) > 0

    # Asking again is answered from the cache at once.
    again = sing.post("/jobs", json={"query": query}).json()["job"]
    assert again["state"] == "done" and again["cached"] is True
    assert again["song_id"] == song["id"]
    assert any(s["id"] == song["id"] for s in sing.get("/songs").json()["songs"])
    assert sing.get(f"/songs/{song['id']}").json()["song"]["id"] == song["id"]


def test_key_change_is_a_separate_song(sing):
    if not is_mock():
        pytest.skip("converts a whole song again")
    a = wait(sing, sing.post("/jobs", json={"query": "keyed"}).json()["job"]["id"])
    b = wait(sing, sing.post("/jobs", json={"query": "keyed", "key": 2}).json()["job"]["id"])
    assert a["song_id"] != b["song_id"]
    assert b["song"]["pitch"]["key"] == 2
    assert b["song"]["pitch"]["vocal_shift"] == a["song"]["pitch"]["vocal_shift"] + 2


def test_failures_are_reported(sing):
    if not is_mock():
        pytest.skip("mock search failure")
    job = wait(sing, sing.post("/jobs", json={"query": "fail"}).json()["job"]["id"])
    assert job["state"] == "failed"
    assert "no search result" in job["error"]


def test_library(sing):
    if not is_mock():
        pytest.skip("depends on the local library")
    entries = sing.get("/library").json()["entries"]
    by_path = {e["path"]: e for e in entries}
    assert by_path["Owner - Split Song"]["split"] is True
    assert by_path["Someone - Local Tune.mp3"] == {
        "path": "Someone - Local Tune.mp3", "title": "Local Tune", "artist": "Someone", "split": False,
    }
    assert sing.post("/jobs", json={"path": "../secret.wav"}).status_code == 200  # fails in the job
    bad = wait(sing, sing.get("/jobs").json()["jobs"][0]["id"])
    assert bad["state"] == "failed" and "outside" in bad["error"]
    # A query that matches a library entry uses it instead of searching.
    job = wait(sing, sing.post("/jobs", json={"query": "local tune"}).json()["job"]["id"])
    assert job["state"] == "done" and job["source"]["kind"] == "library"


def test_the_video_comes_with_the_song(sing):
    if not is_mock():
        pytest.skip("mock video")
    done = wait(sing, sing.post("/jobs", json={"query": "with a video"}).json()["job"]["id"])
    assert done["state"] == "done", done
    song = done["song"]
    assert song["has_video"] is True and song["video_error"] is None
    assert song["video"]["file"] == "video.mp4"
    assert song["video"]["height"] == 1080 and song["video"]["source"] == "mock"
    assert "video_s" in song["timings"]
    assert done["video"]["state"] == "done"
    r = sing.get(f"/songs/{song['id']}/files/video.mp4")
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content.startswith(b"\x00\x00\x00\x18ftyp")
    # A key change of the same source reuses the downloaded video.
    keyed = wait(sing, sing.post("/jobs", json={"query": "with a video", "key": 1}).json()["job"]["id"])
    assert keyed["song"]["has_video"] is True and keyed["video"] is None


def test_a_song_without_a_video_is_still_ready(sing):
    if not is_mock():
        pytest.skip("mock video")
    done = wait(sing, sing.post("/jobs", json={"query": "novideo tune"}).json()["job"]["id"])
    assert done["state"] == "done", done
    song = done["song"]
    assert song["has_video"] is False and song["video"] is None
    assert "no video" in song["video_error"]
    assert done["video"]["state"] == "failed"
    assert sing.get(f"/songs/{song['id']}/files/video.mp4").status_code == 404


def test_videos_can_be_turned_off(sing, monkeypatch):
    if not is_mock():
        pytest.skip("mock video")
    monkeypatch.setenv("SING_VIDEO", "0")
    done = wait(sing, sing.post("/jobs", json={"query": "videos off"}).json()["job"]["id"])
    assert done["song"]["has_video"] is False and "SING_VIDEO" in done["song"]["video_error"]
    assert done["video"] is None


def test_a_song_cached_before_videos_gets_its_video(sing, tmp_path):
    if not is_mock():
        pytest.skip("edits the cache")
    import json

    first = wait(sing, sing.post("/jobs", json={"query": "old song"}).json()["job"]["id"])
    sid = first["song_id"]
    root = Path(os.environ["SING_DATA_DIR"])
    # As the worker wrote it before videos existed.
    meta_path = root / sid / "meta.json"
    meta = json.loads(meta_path.read_text("utf-8"))
    for k in ("has_video", "video", "video_error"):
        meta.pop(k)
    meta_path.write_text(json.dumps(meta), "utf-8")
    for p in [root / sid / "video.mp4", *(root / "_sources").glob("*/video.*")]:
        p.unlink(missing_ok=True)

    again = sing.post("/jobs", json={"query": "old song"}).json()["job"]
    assert again["state"] in ("queued", "running")  # not answered from the cache at once
    done = wait(sing, again["id"])
    assert done["state"] == "done" and done["cached"] is True
    assert done["song"]["has_video"] is True
    assert (root / sid / "video.mp4").exists()
    # Now it is a plain cache hit.
    assert sing.post("/jobs", json={"query": "old song"}).json()["job"]["state"] == "done"


def test_library_videos(sing):
    if not is_mock():
        pytest.skip("depends on the local library")
    done = wait(sing, sing.post("/jobs", json={"path": "Owner - Split Song"}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert done["song"]["has_video"] is True
    assert done["song"]["video"] == {"source": "library", "bytes": 5, "file": "video.mkv"}
    r = sing.get(f"/songs/{done['song_id']}/files/video.mkv")
    assert r.status_code == 200 and r.content == b"video"
    plain = wait(sing, sing.post("/jobs", json={"path": "Someone - Local Tune.mp3"}).json()["job"]["id"])
    assert plain["song"]["has_video"] is False
    assert plain["song"]["video_error"] == "no video next to the library entry"


def test_library_video_lookup(tmp_path):
    from songs import Store

    store = Store(tmp_path, tmp_path / "lib")
    lib = tmp_path / "lib"
    (lib / "Folder").mkdir(parents=True)
    (lib / "Folder" / "vocals.wav").write_bytes(b"")
    (lib / "Folder" / "instrumental.wav").write_bytes(b"")
    (lib / "Folder" / "video.webm").write_bytes(b"")
    (lib / "A - B.mp3").write_bytes(b"")
    (lib / "A - B.mp4").write_bytes(b"")
    (lib / "C - D.webm").write_bytes(b"")
    assert store.library_video("Folder") == lib / "Folder" / "video.webm"
    assert store.library_video("A - B.mp3") == lib / "A - B.mp4"
    assert store.library_video("C - D.webm") is None  # the audio itself is not its video
    assert store.library_video("../x.mp3") is None


@pytest.fixture
def offload(sing, monkeypatch):
    """The TTS / ASR workers as a recorder: (url, body, the job's state at that moment)."""
    if not is_mock():
        pytest.skip("mock offload")
    server = sys.modules["sing_server"]
    calls: list[tuple[str, str]] = []
    fail: set[str] = set()

    def post(url, body, timeout):
        running = server.state.running
        job = server.state.jobs.get(running) if running else None
        calls.append((url, job.stage if job else "-"))
        if url in fail:
            raise RuntimeError("connection refused")
        return {"offload_ms": 5} if url.endswith("/offload") else {"reload_ms": 9}

    monkeypatch.setattr(server.state, "offload_post", post, raising=False)
    monkeypatch.setenv("SING_OFFLOAD_URLS", "http://tts, http://asr/")
    return calls, fail


def test_the_gpu_is_exclusive_while_converting(sing, offload):
    calls, _ = offload
    done = wait(sing, sing.post("/jobs", json={"query": "exclusive song"}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert [c[0] for c in calls] == ["http://tts/offload", "http://asr/offload", "http://tts/reload",
                                     "http://asr/reload"]
    assert calls[0][1] == "exclusive"  # before separating
    assert calls[2][1] in ("mix", "lyrics", "video", "convert")  # right after converting
    assert done["exclusive"] == "done"
    assert done["exclusive_info"]["offloaded"] == ["http://tts", "http://asr"]
    # A cached song needs no GPU.
    calls.clear()
    assert sing.post("/jobs", json={"query": "exclusive song"}).json()["job"]["exclusive"] is None
    assert calls == []


def test_exclusive_waits_for_cores_go(sing, offload):
    calls, _ = offload
    job = sing.post("/jobs", json={"query": "ack song", "exclusive_ack": True}).json()["job"]
    t0 = time.time()
    while sing.get(f"/jobs/{job['id']}").json()["job"]["exclusive"] != "waiting":
        assert time.time() - t0 < 10
        time.sleep(0.02)
    assert sing.get(f"/jobs/{job['id']}").json()["job"]["stage"] == "exclusive"
    time.sleep(0.2)
    assert calls == []  # she is still talking
    assert sing.post(f"/jobs/{job['id']}/exclusive").status_code == 200
    done = wait(sing, job["id"])
    assert done["state"] == "done" and len(calls) == 4
    assert sing.post("/jobs/nope/exclusive").status_code == 404


def test_the_gpu_comes_back_after_a_failure_or_a_cancel(sing, offload, monkeypatch):
    calls, fail = offload
    monkeypatch.setenv("SING_MOCK_CONVERT_FAIL", "1")
    fail.add("http://asr/offload")  # one worker that cannot offload is skipped
    done = wait(sing, sing.post("/jobs", json={"query": "failing conversion"}).json()["job"]["id"])
    assert done["state"] == "failed" and "mock conversion failed" in done["error"]
    # The worker that did not offload in time is reloaded too: its offload may have finished late.
    assert [c[0] for c in calls] == ["http://tts/offload", "http://asr/offload", "http://tts/reload",
                                     "http://asr/reload"]
    assert done["exclusive"] == "done" and "offload http://asr" in done["exclusive_info"]["errors"][0]

    calls.clear()
    monkeypatch.delenv("SING_MOCK_CONVERT_FAIL")
    job = sing.post("/jobs", json={"query": "cancelled while waiting", "exclusive_ack": True}).json()["job"]
    t0 = time.time()
    while sing.get(f"/jobs/{job['id']}").json()["job"]["exclusive"] != "waiting":
        assert time.time() - t0 < 10
        time.sleep(0.02)
    sing.delete(f"/jobs/{job['id']}")
    end = wait(sing, job["id"])
    assert end["state"] == "cancelled" and calls == []


def test_unknown_things_are_404(sing):
    assert sing.get("/jobs/nope").status_code == 404
    assert sing.get("/songs/nope").status_code == 404
    assert sing.get("/songs/nope/files/mix.wav").status_code == 404
    assert sing.get("/songs/x/files/secret.txt").status_code == 404


def test_cancel_a_queued_job(sing):
    if not is_mock():
        pytest.skip("mock timing")
    job = sing.post("/jobs", json={"query": "to cancel"}).json()["job"]
    r = sing.delete(f"/jobs/{job['id']}")
    assert r.status_code == 200
    end = wait(sing, job["id"])
    assert end["state"] in ("cancelled", "done")


# ── lyrics helpers ───────────────────────────────────────────────────────────


def test_parse_lrc():
    from lyrics import parse_lrc

    text = "[ar:x]\n[offset:+500]\n[00:01.50]one\n[00:03.00][00:10.25]two\n[00:05.123]\n"
    assert parse_lrc(text) == [
        {"t": 1.0, "text": "one"},
        {"t": 2.5, "text": "two"},
        {"t": 4.623, "text": ""},
        {"t": 9.75, "text": "two"},
    ]


@pytest.mark.parametrize(
    "raw,uploader,expected",
    [
        ("YOASOBI - 夜に駆ける (Official Music Video)", None, ("YOASOBI", "夜に駆ける")),
        ("【MV】Song Name", "Artist - Topic", ("Artist", "Song Name")),
        ("Some Song | Live at Home", None, (None, "Some Song")),
    ],
)
def test_guess_artist_title(raw, uploader, expected):
    from lyrics import guess_artist_title

    assert guess_artist_title(raw, uploader) == expected


def _lrclib(answers):
    """An httpx client whose lrclib answers come from ``answers(params) -> (status, json)``."""
    import httpx

    seen: list[dict[str, str]] = []

    def handler(request):
        params = dict(request.url.params)
        seen.append(params)
        status, body = answers(params)
        return httpx.Response(status, json=body)

    return httpx.Client(base_url="https://lrclib.test", transport=httpx.MockTransport(handler)), seen


_HIT = [{"trackName": "Song", "artistName": "A", "duration": 100, "syncedLyrics": "[00:01.00]hi",
         "plainLyrics": "hi"}]


def test_lyrics_retries_after_503():
    from lyrics import lookup

    calls = iter([(503, {}), (200, _HIT)])
    client, seen = _lrclib(lambda _p: next(calls))
    slept: list[float] = []
    found = lookup("Song", None, 100, client=client, sleep=slept.append)
    assert found is not None and found["synced"] is True
    assert slept == [1.0] and len(seen) == 2


def test_lyrics_gives_up_after_3_attempts():
    from lyrics import lookup

    client, seen = _lrclib(lambda _p: (503, {}))
    slept: list[float] = []
    assert lookup("Song", None, 100, client=client, sleep=slept.append) is None
    assert len(seen) == 3 and slept == [1.0, 3.0]


@pytest.mark.parametrize("answer", [(404, {}), (200, [])])
def test_lyrics_no_retry_on_404_or_empty(answer):
    from lyrics import lookup

    client, seen = _lrclib(lambda _p: answer)
    slept: list[float] = []
    assert lookup("Song", None, 100, client=client, sleep=slept.append) is None
    assert len(seen) == 1 and slept == []
    client, seen = _lrclib(lambda _p: answer)
    assert lookup("Song", "A", 100, client=client, sleep=slept.append) is None
    assert len(seen) == 2 and seen[1] == {"q": "A Song"} and slept == []


def test_lyrics_falls_back_to_query():
    from lyrics import lookup

    client, seen = _lrclib(lambda p: (200, _HIT) if p.get("q") == "櫻之詩" else (200, []))
    found = lookup("Sakura no Uta MV", "Channel", 100, query="櫻之詩", client=client, sleep=lambda _s: None)
    assert found is not None and found["synced"] is True
    assert seen[-1] == {"q": "櫻之詩"}


def test_cached_song_without_lyrics_gets_them_later(sing, monkeypatch):
    if not is_mock():
        pytest.skip("edits the cache")
    import json

    server = sys.modules["sing_server"]
    b = server.state.backend
    calls: list[str | None] = []
    found: dict = {"value": None}

    def fake_lyrics(src, duration, query=None):
        calls.append(query)
        return found["value"]

    monkeypatch.setattr(b, "lyrics", fake_lyrics)
    first = wait(sing, sing.post("/jobs", json={"query": "lyricless song"}).json()["job"]["id"])
    assert first["state"] == "done" and first["song"]["lyrics"] is None
    assert calls == ["lyricless song"]
    sid = first["song_id"]
    root = Path(os.environ["SING_DATA_DIR"])
    meta_path = root / sid / "meta.json"
    assert json.loads(meta_path.read_text("utf-8"))["lyrics_checked_at"] > time.time() - 60

    # Within 10 minutes: a plain cache hit, no new lookup.
    assert sing.post("/jobs", json={"query": "lyricless song"}).json()["job"]["state"] == "done"
    assert len(calls) == 1

    meta = json.loads(meta_path.read_text("utf-8"))
    meta["lyrics_checked_at"] = time.time() - 11 * 60
    meta_path.write_text(json.dumps(meta), "utf-8")
    found["value"] = {"provider": "mock", "synced": True, "lrc": "[00:00.50]now found", "plain": None,
                      "track": "lyricless song", "artist": None}
    again = sing.post("/jobs", json={"query": "lyricless song"}).json()["job"]
    assert again["state"] in ("queued", "running")  # not answered from the cache at once
    done = wait(sing, again["id"])
    assert done["state"] == "done" and done["cached"] is True
    assert done["song"]["lyrics"]["synced"] is True
    assert done["song"]["lyrics"]["lines"] == [{"t": 0.5, "text": "now found"}]
    assert (root / sid / "lyrics.lrc").exists()
    assert len(calls) == 2


# ── pitch: F0 cleanup and the auto key ───────────────────────────────────────


def _midi(f):
    import numpy as np

    f = np.asarray(f, dtype=float)
    return np.where(f > 1, 69 + 12 * np.log2(np.maximum(f, 1e-9) / 440), 0)


def test_clean_f0_folds_octave_jumps_and_spikes():
    import numpy as np
    from pitch import clean_f0

    f = np.full(200, 660.0)  # E5 held for 2 s
    f[80:86] = 1320.0  # a 60 ms octave jump up (a tracking error at the top)
    f[120:124] = 330.0  # and one down
    f[150] = 900.0  # a spike
    out = clean_f0(f)
    assert np.allclose(_midi(out), _midi(660.0), atol=0.05)


def test_clean_f0_keeps_real_leaps_and_bridges_short_gaps():
    import numpy as np
    from pitch import clean_f0

    f = np.concatenate([np.full(100, 440.0), np.full(100, 880.0)])  # a held octave leap
    out = clean_f0(f)
    assert np.allclose(out[:95], 440.0, rtol=1e-3) and np.allclose(out[110:], 880.0, rtol=1e-3)

    g = np.concatenate([np.full(50, 440.0), np.zeros(3), np.full(50, 494.0), np.zeros(30), np.full(50, 440.0)])
    out = clean_f0(g)
    assert (out[50:53] > 440).all() and (out[50:53] < 494).all()  # 30 ms dropout bridged
    assert (out[103:133] == 0).all()  # a 300 ms rest stays a rest


def test_choose_key_keeps_the_top_under_her_ceiling():
    from pitch import choose_key, note_name, parse_note

    assert parse_note("A5") == 81 and parse_note("C#6") == 85 and parse_note("Bb4") == 70
    assert round(parse_note("440")) == 69 and parse_note("high") is None
    ref = 220.0  # A3 speech: sings around B3, ceiling C#5 (A3 + 16)
    # A song in her range: no change.
    k = choose_key(247.0, 494.0, ref)
    assert (k["octave_shift"], k["auto_key"]) == (0, 0)
    # A low male song: up an octave as before.
    k = choose_key(123.0, 247.0, ref)
    assert (k["octave_shift"], k["auto_key"]) == (12, 0)
    # A song whose top an octave up would be far over her ceiling.
    k = choose_key(165.0, 440.0, ref)  # E3 median, A4 top
    assert k["octave_shift"] == 0 or k["auto_key"] < 0
    k = choose_key(262.0, 740.0, ref)  # a high female song: F#5 top
    assert k["octave_shift"] == 0 and k["auto_key"] == -5  # capped at key_min
    assert k["top_after_note"] == note_name(parse_note("F#5") - 5)
    # Octave only (an explicit key): no transposition.
    assert choose_key(262.0, 740.0, ref, key_min=0, key_max=0)["auto_key"] == 0
    # A ceiling as a note.
    assert choose_key(262.0, 739.0, ref, ceiling=parse_note("F5"))["auto_key"] == -1


def test_auto_key_moves_the_whole_song(sing, monkeypatch):
    if not is_mock():
        pytest.skip("mock pitch")
    monkeypatch.setenv("SING_MOCK_F0_HZ", "440")
    monkeypatch.setenv("SING_MOCK_F0_TOP_HZ", "1400")  # far over A4 + 16
    done = wait(sing, sing.post("/jobs", json={"query": "very high song"}).json()["job"]["id"])
    p = done["song"]["pitch"]
    assert p["auto_key"] == -5 and p["song_key"] == -5 and p["vocal_shift"] == p["octave_shift"] - 5
    # An explicit key wins over the automatic one.
    done = wait(sing, sing.post("/jobs", json={"query": "very high song", "key": 2}).json()["job"]["id"])
    p = done["song"]["pitch"]
    assert p["auto_key"] == 0 and p["song_key"] == 2
