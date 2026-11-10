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

import threading

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


def test_downloads_ask_for_byte_ranges():
    # bilibili's CDN answers a GET without a Range header with HTTP 567; yt-dlp sends Range on
    # every request only with http_chunk_size.
    import engine

    assert engine.ydl_options()["http_chunk_size"] >= 1024 * 1024
    assert engine.ydl_options({"quiet": False})["quiet"] is False


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
def offload(sing, monkeypatch, tmp_path):
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
    monkeypatch.setattr(server.state, "busy_get", lambda url, timeout: {"busy": 0}, raising=False)
    monkeypatch.setenv("SING_OFFLOAD_URLS", "http://tts, http://asr/")
    monkeypatch.setenv("SING_GPU_POLICY", "offload")
    monkeypatch.setenv("SING_MOCK_DEVICE", "cuda")
    server.state.machine.profile = server.Profile(tmp_path)
    server.state.machine.audience = server.Audience()
    server.state.machine.gap_until = 0.0
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


def _stuck_lookup():
    threading.Event().wait(30)


def test_yt_dlp_keeps_its_cache_where_the_worker_says(monkeypatch):
    from engine import ydl_options

    monkeypatch.setenv("SING_YTDLP_CACHE", "songs/_ytdlp-cache")
    assert ydl_options()["cachedir"] == "songs/_ytdlp-cache"
    monkeypatch.delenv("SING_YTDLP_CACHE")
    assert "cachedir" not in ydl_options()


def test_a_lookup_that_never_returns_fails_instead_of_holding_the_queue():
    import server
    from engine import JobError

    with pytest.raises(JobError, match="took longer"):
        server._bounded(_stuck_lookup, lambda: False, 0.2)


def test_a_stuck_lookup_can_be_cancelled():
    import server
    from engine import Cancelled

    with pytest.raises(Cancelled):
        server._bounded(_stuck_lookup, lambda: True, 30)


def test_a_bounded_step_returns_its_value_and_raises_its_error():
    import server
    from engine import JobError

    assert server._bounded(lambda: 7, lambda: False, 5) == 7

    def fail():
        raise JobError("no such song")

    with pytest.raises(JobError, match="no such song"):
        server._bounded(fail, lambda: False, 5)


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


# ── lyrics search: queries, matching, checks, the language model (network mocked) ────────────────────


def _lrc(n: int = 12, step: float = 18.0) -> str:
    return "\n".join(f"[{int(i * step) // 60:02d}:{(i * step) % 60:05.2f}]line number {i} of the song" for i in range(n))


def _lrclib_item(track, artist, duration, lrc=None, plain=None):
    return {"trackName": track, "artistName": artist, "duration": duration, "syncedLyrics": lrc, "plainLyrics": plain}


class FakeNet:
    """lrclib search + NetEase + a language model, over a dict of songs: no network."""

    def __init__(self, lrclib=(), netease=(), llm=None):
        self.lrclib = list(lrclib)
        self.netease = list(netease)  # (id, name, artist, seconds, lrc)
        self.calls: list[tuple[str, dict]] = []
        self.llm = llm  # [{"title","artist","alt_titles"}]
        self.llm_calls = 0

    def http_json(self, method, url, *, params=None, data=None, timeout=8.0):
        from lyrics import norm

        self.calls.append((url, params or data or {}))
        if "lrclib" in url:
            q = norm(" ".join((params or {}).values()))
            return [i for i in self.lrclib if norm(i["trackName"]) in q]
        if url.endswith("/api/search/get/web"):
            q = norm(data["s"])
            hits = [n for n in self.netease if norm(n[1]) in q]
            return {"result": {"songs": [{"id": n[0], "name": n[1], "artists": [{"name": n[2]}], "duration": n[3] * 1000}
                                         for n in hits]}}
        if url.endswith("/api/song/lyric"):
            n = next((n for n in self.netease if n[0] == params["id"]), None)
            return {"lrc": {"lyric": n[4]}} if n else {"nolyric": True}
        return None

    def chat(self, cfg, messages, timeout):
        import json

        self.llm_calls += 1
        return json.dumps({"is_song": bool(self.llm), "songs": self.llm or []})


@pytest.fixture
def net(monkeypatch):
    import lyrics
    import lyricsllm

    def make(**kw):
        n = FakeNet(**kw)
        monkeypatch.setattr(lyrics, "http_json", n.http_json)
        monkeypatch.setattr(lyricsllm, "chat", n.chat)
        return n

    return make


def _queries(hints):
    from lyrics import direct_queries

    return [(q.title, q.artist) for q in direct_queries(hints)]


def test_direct_queries_read_the_title_both_ways_and_the_metadata_first():
    qs = _queries({"raw_title": "【MV】ヨルシカ「又三郎」(Official Video) feat. X", "title": "又三郎", "artist": "ヨルシカ",
                   "track": "Matasaburo", "meta_artist": "Yorushika", "uploader": "ヨルシカ / n-buna Official"})
    assert qs[0] == ("Matasaburo", "Yorushika")  # yt-dlp's own music metadata first
    assert ("又三郎", "ヨルシカ") in qs
    qs = _queries({"raw_title": "プロポーズ / 可不", "title": "可不", "artist": "プロポーズ"})
    assert ("可不", "プロポーズ") in qs and ("プロポーズ", "可不") in qs  # swapped, as the title read it


def test_direct_queries_strip_noise_and_use_brackets_and_channel():
    qs = _queries({"raw_title": "Sakura no Uta 歌ってみた cover by Someone", "title": "Sakura no Uta", "artist": None,
                   "uploader": "Someone Channel"})
    assert ("Sakura no Uta", None) in qs
    assert not any("歌ってみた" in t for t, _ in qs)
    qs = _queries({"raw_title": "夜に駆ける 中字 | YOASOBI", "title": "夜に駆ける", "artist": "YOASOBI", "uploader": "YOASOBI Official"})
    assert ("夜に駆ける", "YOASOBI") in qs
    qs = _queries({"raw_title": "ヨルシカ「又三郎」MV", "title": "又三郎", "artist": None})
    assert ("又三郎", "ヨルシカ") in qs  # 「」 is the title, the rest the artist


def test_name_similarity_ignores_script_case_and_punctuation():
    from lyrics import sim

    assert sim("Bad Apple!!", "bad apple") == 1.0
    assert sim("ロストワンの号哭", "ロストワンの号哭 (feat. Kagamine Rin)") > 0.7
    assert sim("ヨルシカ", "よるしか") == 1.0  # katakana ~ hiragana
    assert sim("abc", "xyz") < 0.3 and sim("", "x") == 0.0


def test_clean_lrc_drops_credit_lines_and_stray_json():
    from lyrics import clean_lrc, parse_lrc

    raw = '[00:00.000] 作词 : 某人\n[00:01.000] 作曲 : 某人\n{"t":0,"c":[{"tx":"x"}]}\n[00:12.50]first line\n[00:20.00]second'
    assert [ln["text"] for ln in parse_lrc(clean_lrc(raw))] == ["first line", "second"]


def test_lrc_fit_needs_the_lyrics_to_span_the_song():
    from lyrics import lrc_fit, parse_lrc

    lines = parse_lrc(_lrc(12, 18.0))  # last line at 198 s
    assert lrc_fit(lines, 210)["ok"] is True
    assert lrc_fit(lines, 400)["ok"] is False  # the lyrics end at half the song
    assert lrc_fit(lines, 150)["ok"] is False  # and they run past it
    assert lrc_fit(parse_lrc(_lrc(3)), 100)["ok"] is False
    assert lrc_fit(lines, None)["ok"] is True


def test_find_lyrics_direct_hit_reports_where_from_and_how_sure(net):
    from lyrics import find_lyrics

    n = net(lrclib=[_lrclib_item("又三郎", "ヨルシカ", 230, _lrc(12, 19.0))])
    r = find_lyrics({"raw_title": "ヨルシカ - 又三郎 (MV)", "title": "又三郎", "artist": "ヨルシカ"}, 230.4, llm=None)
    assert r["provider"] == "lrclib" and r["synced"] and r["how"] == "title"
    assert r["confidence"] > 0.9 and r["checks"]["duration_diff_s"] < 1 and r["checks"]["fit"]["ok"]
    assert r["llm"] is None and n.llm_calls == 0


def test_find_lyrics_finds_swapped_title_and_artist(net):
    from lyrics import find_lyrics

    net(lrclib=[_lrclib_item("プロポーズ", "内緒のピアス", 233, _lrc(12, 19.0))])
    # the resolver read "プロポーズ / 可不" backwards, and 可不 (the singer) is no artist in the database
    r = find_lyrics({"raw_title": "プロポーズ / 可不", "title": "可不", "artist": "プロポーズ"}, 233.1, llm=None)
    assert r and r["track"] == "プロポーズ"


def test_find_lyrics_rejects_a_wrong_length_instead_of_showing_wrong_lyrics(net):
    from lyrics import find_lyrics

    net(lrclib=[_lrclib_item("Song", "Artist", 120, _lrc(12, 10.0))])
    assert find_lyrics({"title": "Song", "artist": "Artist"}, 300, llm=None) is None  # 3 + minutes vs 2


def test_find_lyrics_rejects_synced_lyrics_that_do_not_span_the_audio(net):
    from lyrics import find_lyrics

    # the database says 230 s too, but the lines stop at 60 s: a different edit of the song
    net(lrclib=[_lrclib_item("Song", "Artist", 230, _lrc(4, 15.0))])
    assert find_lyrics({"title": "Song", "artist": "Artist"}, 230, llm=None) is None


def test_find_lyrics_falls_back_to_the_language_model(net):
    import lyricsllm
    from lyrics import find_lyrics

    n = net(lrclib=[_lrclib_item("又三郎", "ヨルシカ", 226, _lrc(12, 18.0))],
            llm=[{"title": "又三郎", "artist": "ヨルシカ", "alt_titles": ["Matasaburo"]}])
    hints = {"key": "yt-x", "raw_title": "Matasaburo (cover by Minato Yukina)", "title": "Matasaburo cover",
             "artist": "Dannis", "uploader": "Dannis", "description": "cover of Yorushika"}
    propose = lyricsllm.make_proposer({"base_url": "x", "api_key": "", "model": "m"}, None)
    r = find_lyrics(hints, 226.5, llm=propose)
    assert r["how"] == "llm" and r["track"] == "又三郎" and r["confidence"] > 0.9
    assert r["llm"]["songs"][0]["artist"] == "ヨルシカ" and n.llm_calls == 1


def test_language_model_is_skipped_when_the_direct_lookup_is_sure(net):
    import lyricsllm
    from lyrics import find_lyrics

    n = net(lrclib=[_lrclib_item("Song", "Artist", 200, _lrc(12, 16.0))], llm=[{"title": "x", "artist": "y"}])
    r = find_lyrics({"title": "Song", "artist": "Artist"}, 200, llm=lyricsllm.make_proposer({"base_url": "x", "model": "m"}, None))
    assert r["how"] == "title" and n.llm_calls == 0


def test_language_model_failure_and_nonsense_leave_no_lyrics(net):
    import lyricsllm
    from lyrics import find_lyrics

    net()
    boom = lambda hints, tried: (_ for _ in ()).throw(RuntimeError("down"))  # noqa: E731
    assert find_lyrics({"title": "Nothing", "artist": "Nobody"}, 200, llm=boom) is None
    n = net(llm=[])  # "I do not know that song"
    assert find_lyrics({"title": "Nothing"}, 200,
                       llm=lyricsllm.make_proposer({"base_url": "x", "model": "m"}, None)) is None
    assert n.llm_calls == 1  # and it does not keep asking


def test_find_lyrics_uses_netease_and_drops_its_credit_lines(net):
    from lyrics import find_lyrics

    lrc = "[00:00.00]作词 : A\n[00:01.00]作曲 : B\n" + _lrc(12, 19.0)
    net(netease=[(7, "夜に駆ける", "YOASOBI", 261, lrc)])
    r = find_lyrics({"title": "夜に駆ける", "artist": "YOASOBI"}, 261, llm=None)
    assert r["provider"] == "netease" and r["synced"] and "作词" not in r["lrc"]


def test_plain_lyrics_are_a_fallback_and_never_fully_confident(net):
    from lyrics import find_lyrics

    net(lrclib=[_lrclib_item("Song", "Artist", 200, None, "la la la\nla la")])
    r = find_lyrics({"title": "Song", "artist": "Artist"}, 200, llm=None)
    assert r["synced"] is False and r["plain"] and r["lrc"] is None and r["confidence"] <= 0.7
    net(lrclib=[_lrclib_item("Song", "Artist", 200, _lrc(12, 16.0), "la"), _lrclib_item("Song", "Artist", 200, None, "la")])
    assert find_lyrics({"title": "Song", "artist": "Artist"}, 200, llm=None)["synced"] is True


def test_asr_spot_check_rejects_lyrics_the_singer_does_not_sing(net, monkeypatch, tmp_path):
    import lyrics

    net(lrclib=[_lrclib_item("Song", "Artist", 200, _lrc(12, 16.0))])
    audio = tmp_path / "lead.wav"
    audio.write_bytes(b"x")
    monkeypatch.setattr(lyrics, "_clip", lambda *a: b"wav")
    heard = {"text": "完全に違う言葉を歌っている"}
    monkeypatch.setattr(lyrics, "asr_text", lambda wav, url, timeout: heard["text"])
    hints = {"title": "Song", "artist": None}
    assert lyrics.find_lyrics(hints, 200, llm=None, audio=audio, asr_url="http://asr", asr_mode="1") is None
    heard["text"] = "line number 3 of the song"
    r = lyrics.find_lyrics(hints, 200, llm=None, audio=audio, asr_url="http://asr", asr_mode="1")
    assert r["checks"]["asr"]["ok"] is True
    # ASR away: no verdict, no rejection
    monkeypatch.setattr(lyrics, "asr_text", lambda wav, url, timeout: None)
    assert lyrics.find_lyrics(hints, 200, llm=None, audio=audio, asr_url="http://asr", asr_mode="1") is not None


def test_coverage_of_a_line():
    from lyrics import coverage

    assert coverage("line number 3", "Line number 3!") == 1.0
    assert coverage("line number 3", "") == 0.0
    assert coverage("あいうえおかきくけこ", "さしすせそたちつてと") < 0.2


def test_llm_config_follows_core_and_its_provider_kind(tmp_path, monkeypatch):
    import lyricsllm

    (tmp_path / "profiles" / "p").mkdir(parents=True)
    (tmp_path / "profiles" / "p" / "profile.toml").write_text('[llm.purposes]\nfast = ["go:model-fast"]\n', "utf-8")
    (tmp_path / "miyoria.toml").write_text(
        '[core]\nprofile = "p"\n[llm.providers.go]\nkind = "opencode"\nbase_url = "https://x.test/v1"\n'
        'api_key = "${LYRICS_TEST_KEY:-fallback}"\n[llm.purposes]\nchat = ["other:chat-model"]\n', "utf-8")
    monkeypatch.delenv("SING_LYRICS_LLM_URL", raising=False)
    monkeypatch.delenv("SING_LYRICS_LLM", raising=False)
    monkeypatch.delenv("MIYORIA_CONFIG", raising=False)
    monkeypatch.setenv("LYRICS_TEST_KEY", "k1")
    cfg = lyricsllm.load_config(tmp_path)
    assert cfg["model"] == "model-fast" and cfg["base_url"] == "https://x.test/v1" and cfg["api_key"] == "k1"
    assert cfg["headers"] == {"x-opencode-session": "miyoria-sing-lyrics"} and cfg["body"]["thinking"]["type"] == "disabled"
    monkeypatch.setenv("SING_LYRICS_LLM_URL", "http://127.0.0.1:1/v1")
    monkeypatch.setenv("SING_LYRICS_LLM_MODEL", "mine")
    assert lyricsllm.load_config(tmp_path)["model"] == "mine"  # the worker's own setting wins
    monkeypatch.setenv("SING_LYRICS_LLM", "0")
    assert lyricsllm.load_config(tmp_path) is None
    monkeypatch.delenv("SING_LYRICS_LLM")
    monkeypatch.delenv("SING_LYRICS_LLM_URL")
    assert lyricsllm.load_config(tmp_path / "nowhere") is None


def test_llm_answer_parsing_and_cache(tmp_path):
    import lyricsllm

    text = '<think>hm</think>```json\n{"is_song": true, "songs": [{"title": "A", "artist": "B", "alt_titles": ["a"]}, {"x": 1}]}\n```'
    assert [s["title"] for s in lyricsllm.parse_songs(text)] == ["A"]
    assert lyricsllm.parse_songs('{"is_song": false, "songs": [{"title": "A"}]}') == []
    assert lyricsllm.parse_songs("no idea") == []
    calls = []

    def chat(cfg, messages, timeout):
        calls.append(messages[-1]["content"])
        return '{"songs": [{"title": "A", "artist": "B"}]}'

    propose = lyricsllm.make_proposer({"base_url": "x", "model": "m"}, tmp_path, chat_fn=chat)
    hints = {"key": "yt-abc", "raw_title": "A (cover)", "description": "d" * 5000}
    assert propose(hints, [])[0].artist == "B" and propose(hints, [])[0].title == "A"
    assert len(calls) == 1 and len(calls[0]) < 1500  # cached by source key, and the prompt is bounded
    from lyrics import Query

    propose(hints, [Query("A", "B", "title")])  # a second round says what failed, and is not cached
    assert len(calls) == 2 and "not found" in calls[1]


def test_refetch_endpoint_updates_one_songs_lyrics_only(sing):
    if not is_mock():
        pytest.skip("mock")
    job = sing.post("/jobs", json={"query": "lyrics refetch song"}).json()["job"]
    song = wait(sing, job["id"])["song"]
    assert song["lyrics"]["how"] == "mock" and song["lyrics"]["confidence"] == 1.0
    assert song["lyrics_input"]["title"] == "lyrics refetch song"
    before = sing.get(f"/songs/{song['id']}/files/play_mix.pcm").content
    r = sing.post(f"/songs/{song['id']}/lyrics", json={"title": "Another Title", "artist": "Someone"})
    assert r.status_code == 200 and r.json()["found"] is True and r.json()["previous"]["provider"] == "mock"
    again = sing.get(f"/songs/{song['id']}").json()["song"]
    assert again["lyrics"]["track"] == "Another Title" and again["lyrics"]["synced"] is True
    assert again["lyrics_input"]["track"] == "Another Title"
    assert sing.get(f"/songs/{song['id']}/files/lyrics.lrc").text.startswith("[00:00.00]mock line 1")
    assert sing.get(f"/songs/{song['id']}/files/play_mix.pcm").content == before  # the audio is untouched
    assert sing.post("/songs/nosuchsong/lyrics").status_code == 404


def test_refetch_without_a_result_keeps_what_the_song_has(sing, monkeypatch):
    if not is_mock():
        pytest.skip("mock")
    job = sing.post("/jobs", json={"query": "lyrics keep song"}).json()["job"]
    song = wait(sing, job["id"])["song"]
    monkeypatch.setenv("SING_LYRICS", "0")
    r = sing.post(f"/songs/{song['id']}/lyrics").json()
    assert r["found"] is False and r["kept"] is True
    assert sing.get(f"/songs/{song['id']}").json()["song"]["lyrics"]["provider"] == "mock"


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


# ── sharing the GPU: she stays in the channel ────────────────────────────────


@pytest.fixture
def share(offload, monkeypatch):
    """SING_GPU_SHARE with a mock card and mock workers answering /busy."""
    server = sys.modules["sing_server"]
    polled: list[str] = []
    busy = {"n": 0}

    def get(url, timeout):
        polled.append(url)
        return {"busy": busy["n"]}

    monkeypatch.setattr(server.state, "busy_get", get, raising=False)
    monkeypatch.delenv("SING_GPU_POLICY")
    monkeypatch.setenv("SING_GPU_SHARE", "1")  # what `auto` was called before
    monkeypatch.setenv("SING_MOCK_FREE_MB", "6000")
    monkeypatch.setenv("SING_YIELD_POLL_MS", "5")
    monkeypatch.setenv("SING_YIELD_HOLD_MS", "100")
    return offload[0], polled, busy


def test_with_room_on_the_card_nothing_is_offloaded(sing, share):
    calls, polled, _ = share
    done = wait(sing, sing.post("/jobs", json={"query": "shared song", "exclusive_ack": True}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert calls == []  # she keeps her voice and her ears
    assert done["exclusive"] == "shared"


def test_without_room_the_offload_is_the_last_resort(sing, share, monkeypatch):
    calls, _, _ = share
    monkeypatch.setenv("SING_MOCK_FREE_MB", "2000")
    done = wait(sing, sing.post("/jobs", json={"query": "no room song"}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert [c[0] for c in calls] == ["http://tts/offload", "http://asr/offload", "http://tts/reload",
                                     "http://asr/reload"]
    assert done["exclusive"] == "done"


def test_an_unknown_card_is_not_shared(sing, share, monkeypatch):
    calls, _, _ = share
    monkeypatch.delenv("SING_MOCK_FREE_MB")
    done = wait(sing, sing.post("/jobs", json={"query": "unknown card song"}).json()["job"]["id"])
    assert done["exclusive"] == "done" and len(calls) == 4


def test_sharing_is_the_default_and_the_old_switch_still_turns_it_off(sing, offload, monkeypatch):
    calls, _ = offload
    monkeypatch.delenv("SING_GPU_POLICY")
    monkeypatch.setenv("SING_MOCK_FREE_MB", "9000")
    done = wait(sing, sing.post("/jobs", json={"query": "default song"}).json()["job"]["id"])
    assert done["exclusive"] == "shared" and calls == []
    monkeypatch.setenv("SING_GPU_SHARE", "0")
    done = wait(sing, sing.post("/jobs", json={"query": "old offload song"}).json()["job"]["id"])
    assert done["exclusive"] == "done" and len(calls) == 4


def test_a_job_waits_for_room_when_told_to(sing, share, monkeypatch):
    server = sys.modules["sing_server"]
    calls, _, _ = share
    monkeypatch.setenv("SING_SHARE_WAIT_S", "5")
    readings = iter([1000, 6000])
    monkeypatch.setattr(server.state.backend, "free_vram_mb", lambda: next(readings, 6000))
    done = wait(sing, sing.post("/jobs", json={"query": "patient song"}).json()["job"]["id"])
    assert done["exclusive"] == "shared" and calls == []


def test_the_conversion_gives_way_while_she_speaks(sing, share):
    server = sys.modules["sing_server"]
    _, polled, busy = share
    busy["n"] = 1
    job = sing.post("/jobs", json={"query": "yielding song"}).json()["job"]["id"]
    deadline = time.time() + 10
    while time.time() < deadline:
        j = sing.get(f"/jobs/{job}").json()["job"]
        if j["stage"] == "convert" and (j["yielded"] or {}).get("pauses", 0) > 0:
            break
        time.sleep(0.01)
    time.sleep(0.05)
    held = sing.get(f"/jobs/{job}").json()["job"]
    assert held["state"] == "running" and held["stage"] == "convert"  # it is waiting for her
    busy["n"] = 0
    done = wait(sing, job)
    assert done["state"] == "done", done
    assert done["yielded"]["yielded_s"] > 0 and polled
    assert server.state.backend.gate is None


def test_a_cancel_reaches_a_job_that_is_giving_way(sing, share):
    _, _, busy = share
    busy["n"] = 1
    job = sing.post("/jobs", json={"query": "cancelled while yielding"}).json()["job"]["id"]
    deadline = time.time() + 10
    while time.time() < deadline and (sing.get(f"/jobs/{job}").json()["job"]["yielded"] or {}).get("pauses", 0) == 0:
        time.sleep(0.01)
    sing.delete(f"/jobs/{job}")
    done = wait(sing, job)
    busy["n"] = 0
    assert done["state"] == "cancelled"


def test_running_out_of_vram_while_sharing_takes_the_gpu_after_all(sing, share, monkeypatch):
    calls, _, _ = share
    monkeypatch.setenv("SING_MOCK_CONVERT_OOM", "1")
    done = wait(sing, sing.post("/jobs", json={"query": "oom song"}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert [c[0] for c in calls][:2] == ["http://tts/offload", "http://asr/offload"]
    assert done["exclusive"] == "done"


def test_yielding_never_stops_a_song_for_good():
    from yielding import SpeechYield

    y = SpeechYield(["http://tts"], lambda url, timeout: {"busy": 1}, poll_s=0.005, hold_s=0.05, max_s=0.05).start()
    time.sleep(0.03)
    t0 = time.monotonic()
    y.wait()
    assert time.monotonic() - t0 < 1 and y.yielded_s >= 0.04
    t0 = time.monotonic()
    y.wait()  # the allowance is used up
    assert time.monotonic() - t0 < 0.02
    y.stop()


def test_a_worker_that_does_not_answer_counts_as_idle():
    from yielding import SpeechYield

    def down(url, timeout):
        raise RuntimeError("connection refused")

    y = SpeechYield(["http://tts"], down, poll_s=0.005).start()
    time.sleep(0.03)
    assert y.busy() is False
    t0 = time.monotonic()
    y.wait()
    assert time.monotonic() - t0 < 0.05
    y.stop()


# ── lead / backing split ─────────────────────────────────────────────────────


def _sing_server():
    return sys.modules["sing_server"]


def _stems(key: str) -> Path:
    return Path(os.environ["SING_DATA_DIR"]) / "_sources" / key


def _job(sing, query: str, **kw) -> dict:
    done = wait(sing, sing.post("/jobs", json={"query": query, **kw}).json()["job"]["id"])
    assert done["state"] == "done", done
    return done


def test_the_lead_comes_from_the_song_and_is_all_that_is_converted(sing):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    b = _sing_server().state.backend
    n = len(b.convert_inputs)
    done = _job(sing, "lead stage order")
    song = done["song"]
    # The backing kept as recorded: no vocal separation, the lead straight from the song.
    assert list(song["timings"])[:5] == ["resolve_s", "download_s", "lead_s", "convert_s", "mix_s"]
    assert song["lead_split"] == {"used": True, "cached": False}
    # The karaoke model reads the whole song (it was trained on mixes).
    assert b.lead_sources[-1] == "source.wav"
    # The converter reads the lead, and so do the F0 statistics behind the auto key.
    assert b.convert_inputs[n:] == ["lead.wav"]
    assert b.f0_inputs[-1] == "lead.wav"
    # The mix gets the lead and the rest of the song (song - lead), nothing separated.
    split, files = b.mix_inputs[-1]
    assert split is True and {"lead.wav", "rest.wav"} <= set(files) and "vocals.wav" not in files
    key = song["source"]["key"]
    assert (_stems(key) / "lead.wav").exists() and (_stems(key) / "rest.wav").exists()

    # Dropping the backing needs it apart: the vocals are separated now, the lead is reused and
    # the backing (vocals - lead) is taken from them.
    dropped = _job(sing, "lead stage order", backing="drop")["song"]
    assert list(dropped["timings"])[:3] == ["resolve_s", "separate_s", "convert_s"]
    assert dropped["lead_split"] == {"used": True, "cached": True}
    split, files = b.mix_inputs[-1]
    assert {"lead.wav", "backing.wav", "vocals.wav", "instrumental.wav"} <= set(files)


def test_the_backing_is_kept_by_default_and_each_mode_is_a_song_of_its_own(sing):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    b = _sing_server().state.backend
    kept = _job(sing, "backing modes")["song"]
    assert b.mix_backing[-1] == "keep" and kept["backing"] == "keep"
    for mode, suffix in (("drop", "-nobk"), ("convert", "-cvbk"), ("acapella", "-acap")):
        n = len(b.convert_inputs)
        done = _job(sing, "backing modes", backing=mode)
        assert done["cached"] is False and done["song"]["id"] == kept["id"] + suffix
        assert done["song"]["backing"] == mode and b.mix_backing[-1] == mode
        # Converting the backing is one more conversion, of the backing stem.
        assert b.convert_inputs[n:] == (["lead.wav", "backing.wav"] if mode == "convert" else ["lead.wav"])
        assert _job(sing, "backing modes", backing=mode)["cached"] is True
    assert _job(sing, "backing modes")["song"]["id"] == kept["id"]
    assert sing.post("/jobs", json={"query": "x", "backing": "loud"}).status_code in (400, 422)


def test_the_split_is_off_with_its_switch_and_the_pipeline_is_the_old_one(sing, monkeypatch):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    monkeypatch.setenv("SING_LEAD_SPLIT", "0")
    b = _sing_server().state.backend
    leads, n = len(b.lead_devices), len(b.convert_inputs)
    song = _job(sing, "lead switch off")["song"]
    assert song["lead_split"] == {"used": False, "reason": "off"}
    assert "lead_s" not in song["timings"]
    assert len(b.lead_devices) == leads
    assert b.convert_inputs[n:] == ["vocals.wav"] and b.f0_inputs[-1] == "vocals.wav"
    assert b.mix_inputs[-1][0] is False
    assert not (_stems(song["source"]["key"]) / "lead.wav").exists()


def test_without_the_model_file_the_split_is_skipped(sing, monkeypatch):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    monkeypatch.setenv("SING_MOCK_LEAD_MODEL", "0")
    song = _job(sing, "lead no model")["song"]
    assert song["lead_split"] == {"used": False, "reason": "no_model"}
    assert "lead_s" not in song["timings"]


def test_stems_cached_before_the_split_are_split_on_demand_and_then_reused(sing, monkeypatch):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    b = _sing_server().state.backend
    with monkeypatch.context() as m:
        m.setenv("SING_LEAD_SPLIT", "0")
        old = _job(sing, "lead old cache")["song"]
    stems = _stems(old["source"]["key"])
    assert (stems / "vocals.wav").exists() and not (stems / "lead.wav").exists()
    separated = len(b.separate_devices)
    leads, n = len(b.lead_devices), len(b.convert_inputs)
    # Another key is another song, from the same cached stems.
    new = _job(sing, "lead old cache", key=1)["song"]
    assert len(b.separate_devices) == separated  # not separated again
    assert len(b.lead_devices) == leads + 1  # but split from the cached vocals
    assert new["lead_split"] == {"used": True, "cached": False}
    assert (stems / "lead.wav").exists() and (stems / "backing.wav").exists()
    assert b.convert_inputs[n:] == ["lead.wav"]
    # The next song from these stems finds the split there.
    again = _job(sing, "lead old cache", key=2)["song"]
    assert again["lead_split"] == {"used": True, "cached": True}
    assert len(b.lead_devices) == leads + 1


def test_a_failed_split_falls_back_to_the_whole_vocal_stem(sing, monkeypatch):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    monkeypatch.setenv("SING_MOCK_LEAD_FAIL", "1")
    b = _sing_server().state.backend
    n = len(b.convert_inputs)
    song = _job(sing, "lead split fails")["song"]
    assert song["lead_split"]["used"] is False and song["lead_split"]["reason"] == "failed"
    assert "mock lead split failed" in song["lead_split"]["error"]
    assert b.convert_inputs[n:] == ["vocals.wav"]
    assert not (_stems(song["source"]["key"]) / "lead.wav").exists()


def test_a_forced_song_splits_the_stems_it_made_again(sing):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    b = _sing_server().state.backend
    first = _job(sing, "lead forced")["song"]
    leads = len(b.lead_devices)
    forced = _job(sing, "lead forced", force=True)["song"]
    assert forced["lead_split"] == {"used": True, "cached": False}
    assert len(b.lead_devices) == leads + 1
    assert first["id"] == forced["id"]


def test_the_worker_and_its_split_import_without_torch():
    import subprocess

    code = (
        "import sys; sys.modules['torch'] = None; sys.modules['librosa'] = None; "
        f"sys.path.insert(0, {str(SING)!r}); import os; os.environ['SING_BACKEND'] = 'mock'; "
        "import leadsplit, gpu, engine, importlib.util as u; "
        f"s = u.spec_from_file_location('sing_server', {str(SING / 'server.py')!r}); m = u.module_from_spec(s); "
        "sys.modules['sing_server'] = m; s.loader.exec_module(m); "
        "assert leadsplit.available({'SING_LEAD_MODEL': 'nowhere.ckpt'}) is False; print('ok')"
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and r.stdout.strip() == "ok", r.stderr[-800:]


def test_the_split_looks_for_its_model_and_its_config(tmp_path):
    import leadsplit

    ckpt = tmp_path / "m.ckpt"
    assert leadsplit.model_path({"SING_LEAD_MODEL": str(ckpt)}) == ckpt
    # The BS-RoFormer karaoke model when it is there, else the Mel-Band one.
    assert leadsplit.model_path({}).name in (leadsplit.BS_CKPT.name, leadsplit.CKPT_NAME)
    assert leadsplit.tag(env := {"SING_LEAD_MODEL": str(ckpt)}) == "m@mix"
    assert leadsplit.tag({**env, "SING_LEAD_INPUT": "vocals"}) == "m@vocals"
    env = {"SING_LEAD_MODEL": str(ckpt)}
    assert leadsplit.available(env) is False  # no file
    ckpt.write_bytes(b"x")
    assert leadsplit.available(env) is False  # no config
    (tmp_path / "config.yaml").write_text("audio: {}")
    assert leadsplit.available(env) is True
    assert leadsplit.available({**env, "SING_LEAD_SPLIT": "0"}) is False
    (tmp_path / "m.yaml").write_text("audio: {}")
    assert leadsplit.config_path(ckpt) == tmp_path / "m.yaml"  # the one named like the checkpoint wins


def test_chunked_inference_cross_fades_back_to_the_input():
    torch = pytest.importorskip("torch")
    import numpy as np
    import leadsplit

    class Half(torch.nn.Module):  # a "model" that keeps half of what it hears
        def forward(self, x):
            return x * 0.5

    s = leadsplit.LeadSplitter.__new__(leadsplit.LeadSplitter)
    s.model, s.device, s.chunk, s.sr, s.overlap, s._hooked = Half(), "cpu", 4000, 44100, 4, False
    calls: list[int] = []
    s.gate = lambda: calls.append(1)
    rng = np.random.default_rng(0)
    for n in (9000, 4000, 1234, 30000):
        x = rng.standard_normal((n, 2)).astype("float32")
        seen: list[float] = []
        y = s.lead(x, 44100, seen.append)
        assert y.shape == x.shape
        assert np.allclose(y, x * 0.5, atol=1e-5)
        assert seen[-1] == pytest.approx(1.0)
    assert calls  # the step gate ran before the chunks
    with pytest.raises(ValueError):
        s.lead(x, 16000)


def test_the_backing_joins_the_instrumental_at_its_own_level(tmp_path):
    import numpy as np
    import soundfile as sf
    import engine

    sr, n = 44100, 44100
    t = np.arange(n) / sr

    def tone(hz, a):
        return (a * np.sin(2 * np.pi * hz * t)).astype("float32")[:, None].repeat(2, axis=1)

    sf.write(tmp_path / "lead.wav", tone(440, 0.4), sr)
    sf.write(tmp_path / "conv.wav", tone(440, 0.1), sr)
    sf.write(tmp_path / "inst.wav", tone(220, 0.2), sr)
    sf.write(tmp_path / "backing.wav", tone(330, 0.1), sr)

    class Backend:
        def transpose(self, x, sr, key):
            return x

    plain, split = tmp_path / "plain", tmp_path / "split"
    plain.mkdir()
    split.mkdir()
    engine.mix_song(tmp_path / "lead.wav", tmp_path / "conv.wav", tmp_path / "inst.wav", 0, plain, Backend(), -16.0)
    engine.mix_song(tmp_path / "lead.wav", tmp_path / "conv.wav", tmp_path / "inst.wav", 0, split, Backend(), -16.0,
                    tmp_path / "backing.wav")
    inst_plain, _ = sf.read(plain / "instrumental.wav")
    inst_split, _ = sf.read(split / "instrumental.wav")
    f = np.fft.rfftfreq(n, 1 / sr)

    def level(x, hz):
        return np.abs(np.fft.rfft(x[:, 0]))[np.argmin(np.abs(f - hz))]

    assert level(inst_plain, 330) < 5  # nothing of the backing without it
    assert level(inst_split, 330) > 1000
    # Same scale as the 220 Hz instrument it was recorded with: 0.1 against 0.2, whatever the mix gain.
    assert level(inst_split, 330) / level(inst_split, 220) == pytest.approx(0.5, rel=0.1)
    assert (split / "mix.wav").exists() and (split / "play_mix.pcm").exists()

    # Converted backing joins her vocal at the backing's own level; a cappella drops the instrumental.
    sf.write(tmp_path / "bconv.wav", tone(330, 0.2), sr)
    conv, acap = tmp_path / "conv_b", tmp_path / "acap"
    conv.mkdir()
    acap.mkdir()
    engine.mix_song(tmp_path / "lead.wav", tmp_path / "conv.wav", tmp_path / "inst.wav", 0, conv, Backend(), -16.0,
                    backing_conv=tmp_path / "bconv.wav", backing_src=tmp_path / "backing.wav")
    v_conv, _ = sf.read(conv / "vocals.wav")
    inst_conv, _ = sf.read(conv / "instrumental.wav")
    assert level(inst_conv, 330) < 5 and level(v_conv[:, None], 330) > 1000
    # Lead 0.4 and backing 0.1 as in the source, after the converters' levels are undone.
    assert level(v_conv[:, None], 330) / level(v_conv[:, None], 440) == pytest.approx(0.25, rel=0.1)
    engine.mix_song(tmp_path / "lead.wav", tmp_path / "conv.wav", tmp_path / "inst.wav", 0, acap, Backend(), -16.0,
                    instrumental=False)
    mix_acap, _ = sf.read(acap / "mix.wav")
    assert level(mix_acap, 220) < 5 and level(mix_acap, 440) > 1000


def test_the_vocal_separator_is_the_roformer_when_its_files_are_there(tmp_path):
    import engine

    ckpt = tmp_path / "v.ckpt"
    env = {"SING_VOCAL_MODEL": str(ckpt)}
    assert engine.vocal_model_path(env) == ckpt
    assert engine.vocal_model_path({}).name == engine.VOCAL_CKPT
    assert engine.default_separator(env) == "htdemucs"  # no file
    ckpt.write_bytes(b"x")
    assert engine.default_separator(env) == "htdemucs"  # no config
    (tmp_path / "v.yaml").write_text("audio: {}", "utf-8")
    assert engine.default_separator(env) == engine.MELBAND
    assert engine.default_separator({**env, "SING_SEPARATOR_MODEL": "htdemucs_ft"}) == "htdemucs_ft"


def test_the_roformer_separation_leaves_the_rest_as_the_instrumental(tmp_path):
    import numpy as np
    import soundfile as sf
    import engine

    class Half:  # stands in for the RoFormer runner: "the vocals" are half the song
        device, sr, gate = "cpu", 44100, None

        def lead(self, x, sr, progress=None, overlap=None):
            if progress:
                progress(1.0)
            return x * 0.5

    b = object.__new__(engine.RealBackend)
    b.separator, b._demucs, b.gate, b.vocal_overlap, b.keep, b.separate_device = engine.MELBAND, Half(), None, 2, True, "cpu"
    x = (np.random.default_rng(1).standard_normal((44100, 2)) * 0.1).astype("float32")
    sf.write(tmp_path / "source.wav", x, 44100, subtype="FLOAT")
    seen: list[float] = []
    b._separate_on("cpu", tmp_path / "source.wav", tmp_path / "vocals.wav", tmp_path / "inst.wav", seen.append)
    v, _ = sf.read(tmp_path / "vocals.wav", dtype="float32")
    i, _ = sf.read(tmp_path / "inst.wav", dtype="float32")
    assert np.allclose(v + i, x, atol=1e-3)
    assert np.allclose(v, x * 0.5, atol=1e-3)
    assert seen and seen[-1] == 1.0


def test_the_voice_chain_leaves_out_what_is_missing(tmp_path):
    import engine

    ying = tmp_path / "ying"
    applio = tmp_path / "applio"
    env = {"SING_YING_DIR": str(ying), "SING_APPLIO_DIR": str(applio)}
    assert engine.voice_chain(env) == "seedvc"  # neither is there
    (ying / "modules").mkdir(parents=True)
    (ying / "ckpt").mkdir()
    (ying / "configs").mkdir()
    (ying / engine.YING_CKPT).write_bytes(b"x")
    (ying / engine.YING_CONFIG).write_text("model_params: {}", "utf-8")
    assert engine.voice_chain(env) == "ying"
    (applio / "venv" / "Scripts").mkdir(parents=True)
    (applio / "venv" / "Scripts" / "python.exe").write_bytes(b"")
    (applio / "core.py").write_text("", "utf-8")
    model = applio / "logs" / "m" / "m.pth"
    model.parent.mkdir(parents=True)
    model.write_bytes(b"x")
    env["SING_RVC_MODEL"] = str(model)
    # Her RVC model alone by default; YingMusic / Seed-VC first only when asked.
    assert engine.voice_chain(env) == "rvc"
    assert engine.voice_chain({**env, "SING_VOICE": "ying+rvc"}) == "ying+rvc"
    assert engine.voice_chain({**env, "SING_VOICE": "seedvc"}) == "seedvc"
    assert engine.voice_chain({**env, "SING_VOICE": "seedvc+rvc"}) == "seedvc+rvc"
    assert engine.voice_chain({**env, "SING_VOICE": "nonsense"}) == "rvc"


def test_the_rvc_pass_command_keeps_pitch_and_turns_retrieval_off(tmp_path):
    import rvcpass

    model = tmp_path / "logs" / "m" / "m.pth"
    model.parent.mkdir(parents=True)
    model.write_bytes(b"x")
    env = {"SING_APPLIO_DIR": str(tmp_path), "SING_RVC_MODEL": str(model)}
    assert rvcpass.index_path(env) is None
    cmd = rvcpass.command(tmp_path / "in.wav", tmp_path / "out.wav", env)
    assert cmd[1:3] == ["core.py", "infer"]
    assert cmd[cmd.index("--pitch") + 1] == "0"
    alone = rvcpass.command(tmp_path / "in.wav", tmp_path / "out.wav", env, pitch=-3)
    assert alone[alone.index("--pitch") + 1] == "-3"  # RVC alone moves the lead by the job's shift
    assert cmd[cmd.index("--index-rate") + 1] == "0"
    assert "--index-path" not in cmd
    (model.parent / "m.index").write_bytes(b"x")
    assert "--index-path" in rvcpass.command(tmp_path / "in.wav", tmp_path / "out.wav", env)


def test_a_failed_rvc_pass_keeps_the_converted_vocal(tmp_path, monkeypatch):
    import numpy as np
    import soundfile as sf
    import engine

    class Vc:
        step_gate = None

        def convert(self, mono, sr, ref, rsr, shift, steps, cfg, progress, cancelled, clean=True, work=None):
            return mono * 0.5

    b = object.__new__(engine.RealBackend)
    b._vc, b.keep, b.gate, b.steps, b.cfg_rate, b.f0_clean, b.rvc = Vc(), True, None, 30, 0.7, True, True
    b._ref = (np.zeros(44100, dtype="float32"), 44100)
    monkeypatch.setattr(engine, "vocal_gate", lambda src, y: y)
    x = (np.random.default_rng(2).standard_normal((44100, 2)) * 0.1).astype("float32")
    sf.write(tmp_path / "lead.wav", x, 44100, subtype="FLOAT")

    def boom(self, src, y, workdir):
        raise RuntimeError("applio broke")

    monkeypatch.setattr(engine.RealBackend, "_rvc_pass", boom)
    b.convert(tmp_path / "lead.wav", tmp_path / "out.wav", 0, lambda f: None, lambda: False)
    y, _ = sf.read(tmp_path / "out.wav", dtype="float32")
    assert np.allclose(y, x.mean(axis=1) * 0.5, atol=1e-3)
    assert b.rvc_error == "applio broke"

    monkeypatch.setattr(engine.RealBackend, "_rvc_pass", lambda self, src, y, workdir: y * 0.0 + 0.25)
    b.convert(tmp_path / "lead.wav", tmp_path / "out.wav", 0, lambda f: None, lambda: False)
    y, _ = sf.read(tmp_path / "out.wav", dtype="float32")
    assert np.allclose(y, 0.25, atol=1e-3) and b.rvc_error is None


def test_a_song_made_with_another_voice_chain_is_made_again():
    import server

    class B:
        voice = "ying+rvc"

    assert server._other_voice({"engine": {"voice": "ying+rvc"}}, B()) is False
    assert server._other_voice({"engine": {"voice": "seedvc"}}, B()) is True
    assert server._other_voice({"engine": {}}, B()) is True  # before the chain was recorded: Seed-VC
    assert server._other_voice({}, object()) is False  # the mock backend has no chain


def test_stems_and_songs_of_another_separator_are_made_again(tmp_path):
    import server

    class B:
        voice = "ying+rvc"
        separator = "melband"

    # A song: the separator is the last part of the model name.
    assert server._other_voice({"engine": {"voice": "ying+rvc", "model": "ying+rvc+melband"}}, B()) is False
    assert server._other_voice({"engine": {"voice": "ying+rvc", "model": "ying+rvc+htdemucs"}}, B()) is True

    # The lead split: a song whose lead came from another karaoke model is made again.
    class L(B):
        lead_tag = "bs_karaoke@mix"

    made = {"engine": {"voice": "ying+rvc", "model": "ying+rvc+melband", "lead": "bs_karaoke@mix"},
            "lead_split": {"used": True}}
    assert server._other_voice(made, L()) is False
    assert server._other_voice({**made, "engine": {**made["engine"], "lead": None}}, L()) is True  # legacy lead
    assert server._other_voice({**made, "lead_split": {"used": False}}, L()) is False  # no lead to differ
    # Stems: the lead is recorded beside them, and new vocals drop it.
    server._write_stems_info(tmp_path, lead="bs_karaoke@mix")
    assert server._stems_lead(tmp_path) == "bs_karaoke@mix"
    server._write_stems_separator(tmp_path, "htdemucs")
    assert server._stems_lead(tmp_path) == server.LEGACY_LEAD
    # Stems: recorded beside them; stems from before that were htdemucs.
    assert server._stems_separator(tmp_path) == "htdemucs"
    server._write_stems_separator(tmp_path, "melband")
    assert server._stems_separator(tmp_path) == "melband"
    server._write_stems_separator(tmp_path / "x", None)  # the mock backend: nothing written
    assert not (tmp_path / "x").exists()


def test_one_outlying_peak_does_not_set_the_vram_estimate():
    import gpu

    # 11-09: one fp32 separation among fp16 runs sent every later one to the CPU.
    assert gpu.typical_peak([2349, 2222, 2222, 9136, 2100]) == 2349
    assert gpu.typical_peak([3000]) == 3000
    assert gpu.typical_peak([2000, 4100, 4200]) == 4200  # a real rise shows in more than one run


def test_the_split_from_the_song_alone_leaves_the_rest_of_it(tmp_path):
    import numpy as np
    import soundfile as sf
    import engine

    class Half:  # the karaoke model: "the lead" is half the song
        device, sr, gate = "cpu", 44100, None

        def lead(self, x, sr, progress=None, overlap=None):
            return x * 0.5

    b = object.__new__(engine.RealBackend)
    b._lead, b.gate, b.lead_overlap, b.keep, b.lead_device = Half(), None, 2, True, "cpu"
    x = (np.random.default_rng(3).standard_normal((44100, 2)) * 0.1).astype("float32")
    sf.write(tmp_path / "source.wav", x, 44100, subtype="FLOAT")
    b._split_on("cpu", tmp_path / "vocals.wav", tmp_path / "lead.wav", tmp_path / "backing.wav", lambda f: None,
                tmp_path / "source.wav", tmp_path / "rest.wav")
    lead, _ = sf.read(tmp_path / "lead.wav", dtype="float32")
    rest, _ = sf.read(tmp_path / "rest.wav", dtype="float32")
    assert np.allclose(lead + rest, x, atol=1e-4)
    assert not (tmp_path / "backing.wav").exists()  # no vocals, no backing
    # Separated later: the backing comes from the vocals by subtraction, the lead is kept.
    sf.write(tmp_path / "vocals.wav", x * 0.8, 44100, subtype="FLOAT")
    b.complete_stems(tmp_path)
    backing, _ = sf.read(tmp_path / "backing.wav", dtype="float32")
    assert np.allclose(backing, x * 0.3, atol=1e-4)
