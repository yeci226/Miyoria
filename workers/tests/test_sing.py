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
from conftest import NO_BODY, send

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


def test_yt_dlp_uses_the_cookies_it_is_given(monkeypatch, tmp_path):
    import engine
    from engine import ydl_options

    monkeypatch.delenv("SING_YTDLP_COOKIES_FROM_BROWSER", raising=False)
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File" + chr(10))
    monkeypatch.setenv("SING_YTDLP_COOKIES", str(cookies))
    assert ydl_options()["cookiefile"] == str(cookies)
    monkeypatch.setenv("SING_YTDLP_COOKIES", str(tmp_path / "missing.txt"))
    monkeypatch.setattr(engine, "__file__", str(tmp_path / "sing" / "engine.py"))  # no cookies.txt beside it
    assert "cookiefile" not in ydl_options()
    monkeypatch.setenv("SING_YTDLP_COOKIES_FROM_BROWSER", "firefox")
    assert ydl_options()["cookiesfrombrowser"] == ("firefox",)
    assert ydl_options({"cookiefile": "other.txt"})["cookiefile"] == "other.txt"


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
        # Only an artist's own channel stands for the artist; anyone else's channel is nobody.
        ("夜に駆ける 歌ってみた", "owen0924", (None, "夜に駆ける")),
        ("Some Song", "YOASOBI Official", ("YOASOBI", "Some Song")),
        ("Some Song", "TaylorSwiftVEVO", ("TaylorSwift", "Some Song")),
        ("Some Song", "ヨルシカ 公式", ("ヨルシカ", "Some Song")),
    ],
)
def test_guess_artist_title(raw, uploader, expected):
    from lyrics import guess_artist_title

    assert guess_artist_title(raw, uploader) == expected


def test_a_sources_artist_is_never_the_uploaders_own_channel():
    import engine

    def artist(**info):
        return engine.RealBackend._source_of(None, {"id": "x", "extractor_key": "Youtube", **info}, "youtube").artist

    # The requester's channel (a cover they uploaded): no artist, not "owen0924".
    assert artist(title="櫻ノ詩", uploader="owen0924") is None
    # yt-dlp's music metadata first, then the title's split, then an artist's channel.
    assert artist(title="櫻ノ詩", uploader="owen0924", artist="Lia, 麻枝准") == "Lia"
    assert artist(title="Lia - 櫻ノ詩", uploader="owen0924") == "Lia"
    assert artist(title="櫻ノ詩", uploader="Lia - Topic") == "Lia"


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


def test_llm_config_comes_from_hostd_or_the_worker_never_from_cores_files(tmp_path, monkeypatch):
    import lyricsllm

    for name in ("SING_LYRICS_LLM", "SING_LYRICS_LLM_URL", "SING_LYRICS_LLM_KEY", "SING_LYRICS_LLM_MODEL",
                 "MIYORIA_HOSTD_URL", "MIYORIA_SERVICE_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    # Core's config next to the worker is not read any more.
    (tmp_path / "miyoria.toml").write_text('[llm.providers.go]\nbase_url = "https://x.test/v1"\n'
                                          '[llm.purposes]\nfast = ["go:m"]\n', "utf-8")
    monkeypatch.setenv("MIYORIA_CONFIG", str(tmp_path / "miyoria.toml"))
    monkeypatch.chdir(tmp_path)
    assert lyricsllm.load_config() is None
    monkeypatch.setenv("SING_LYRICS_LLM_URL", "http://127.0.0.1:1/v1/")
    monkeypatch.setenv("SING_LYRICS_LLM_MODEL", "mine")
    assert lyricsllm.load_config() == {"base_url": "http://127.0.0.1:1/v1", "api_key": "", "model": "mine"}
    # hostd runs the worker: Core's model through hostd, the worker's own kept for when hostd is not linked
    monkeypatch.setenv("MIYORIA_HOSTD_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", "t")
    cfg = lyricsllm.load_config()
    assert cfg["via"] == "hostd" and cfg["model"] == "core:fast" and cfg["fallback"]["model"] == "mine"
    monkeypatch.setenv("SING_LYRICS_LLM", "0")
    assert lyricsllm.load_config() is None


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


# ── running parts of a job side by side ──────────────────────────────────────


def test_lyrics_are_looked_up_while_the_song_converts(sing, monkeypatch):
    """The lookup starts once the lead is there, not after the mix; its ASR check waits for the conversion."""
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    server = _sing_server()
    b = server.state.backend
    seen: list[tuple[str, bool]] = []

    def gate():
        job = server.state.jobs[server.state.running]
        seen.append((job.stage, job.converted.is_set()))

    monkeypatch.setattr(b, "lyrics_gate", gate)
    monkeypatch.setattr(b, "delay", 0.05)
    monkeypatch.setenv("SING_MOCK_LYRICS_ASR", "1")
    after = len(b.lyrics_after_asr_wait)
    song = _job(sing, "lyrics side by side")["song"]
    stage, converted = seen[-1]
    assert stage in ("lead", "convert") and converted is False
    assert b.lyrics_after_asr_wait[after:] == [True]  # the ASR check came after the conversion
    assert song["lyrics"]["synced"] and song["timings"]["lyrics_s"] >= 0
    assert b.lyrics_calls[-1] == pytest.approx(2.0)  # the lead's length, the mix's to come


def test_the_next_song_is_found_and_downloaded_while_one_is_made(sing, monkeypatch):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    b = _sing_server().state.backend
    monkeypatch.setattr(b, "delay", 0.25)
    first = sing.post("/jobs", json={"query": "prefetch first one"}).json()["job"]["id"]
    second = sing.post("/jobs", json={"query": "prefetch second one"}).json()["job"]["id"]
    assert wait(sing, first)["state"] == "done"
    done = wait(sing, second)
    assert done["state"] == "done", done
    timings = done["song"]["timings"]
    assert timings.get("prefetched") == 1
    assert "resolve_s" not in timings and "download_s" not in timings


def test_no_prefetch_when_it_is_off(sing, monkeypatch):
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    b = _sing_server().state.backend
    monkeypatch.setattr(b, "delay", 0.25)
    monkeypatch.setenv("SING_PREFETCH", "0")
    first = sing.post("/jobs", json={"query": "no prefetch first"}).json()["job"]["id"]
    second = sing.post("/jobs", json={"query": "no prefetch second"}).json()["job"]["id"]
    wait(sing, first)
    timings = wait(sing, second)["song"]["timings"]
    assert "prefetched" not in timings and "download_s" in timings


def test_a_download_cut_short_leaves_no_source_behind(sing, monkeypatch, tmp_path):
    if not is_mock():
        pytest.skip("mock only")
    server = _sing_server()

    def broken(src, dest, progress):
        dest.write_bytes(b"half a song")
        raise RuntimeError("connection reset")

    monkeypatch.setattr(server.state.backend, "fetch", broken)
    dest = tmp_path / "source.wav"
    with pytest.raises(RuntimeError):
        server._fetch(server.Source(key="mock-cut", kind="mock", title="T"), dest, lambda f: None)
    assert list(tmp_path.iterdir()) == []


def test_a_source_is_downloaded_once_at_a_time(sing, monkeypatch, tmp_path):
    """A job and the prefetch of the next one wanting the same song: never two writers of one file."""
    if not is_mock():
        pytest.skip("mock only")
    server = _sing_server()
    lock, live, calls = threading.Lock(), [0], []

    def slow(src, dest, progress):
        with lock:
            live[0] += 1
            calls.append(live[0])
        time.sleep(0.2)
        dest.write_bytes(b"a song")
        with lock:
            live[0] -= 1

    monkeypatch.setattr(server.state.backend, "fetch", slow)
    src, dest = server.Source(key="mock-twice", kind="mock", title="T"), tmp_path / "source.wav"
    runs = [threading.Thread(target=server._fetch, args=(src, dest, lambda f: None)) for _ in range(2)]
    for t in runs:
        t.start()
    for t in runs:
        t.join()
    assert calls == [1] and dest.read_bytes() == b"a song"  # the second one took the first one's file
    server._fetch(src, dest, lambda f: None, again=True)  # a forced job downloads it again
    assert calls == [1, 1]


def test_the_next_job_is_marked_before_its_prefetch_starts(sing, monkeypatch):
    """Marked under the lock the worker starts jobs under: a job that starts meanwhile waits for it."""
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    server = _sing_server()
    monkeypatch.setattr(server.state.backend, "delay", 0.25)
    seen: list[tuple[str | None, str]] = []
    original = server._prefetch

    def spy(job, running):
        seen.append((job.prefetch, job.state))
        original(job, running)

    monkeypatch.setattr(server, "_prefetch", spy)
    first = sing.post("/jobs", json={"query": "marked first"}).json()["job"]["id"]
    second = sing.post("/jobs", json={"query": "marked second"}).json()["job"]["id"]
    wait(sing, first)
    assert wait(sing, second)["state"] == "done"
    assert seen and seen[0][0] == "running"


def test_the_models_are_let_go_when_the_queued_jobs_are_cancelled(sing, monkeypatch):
    """Kept for the next job, which was then cancelled: let go once the queue is empty."""
    if not is_mock():
        pytest.skip("reads the mock backend's log")
    server = _sing_server()
    b = server.state.backend
    monkeypatch.setattr(b, "delay", 0.2)
    monkeypatch.setenv("SING_PREFETCH", "0")
    ids: list[str] = []

    def cancel_the_rest(more):
        if more:
            for j in ids[1:]:
                sing.delete(f"/jobs/{j}")

    monkeypatch.setattr(b, "idle_hook", cancel_the_rest)
    before = len(b.idles)
    ids += [sing.post("/jobs", json={"query": f"let go {i}"}).json()["job"]["id"] for i in range(2)]
    wait(sing, ids[0])
    assert wait(sing, ids[1])["state"] == "cancelled"
    t0 = time.time()
    while b.idles[before:] != [True, False] and time.time() - t0 < 5:
        time.sleep(0.05)
    assert b.idles[before:] == [True, False]


def test_the_prepared_instrumental_mixes_exactly_the_same(tmp_path):
    np = pytest.importorskip("numpy")
    sf = pytest.importorskip("soundfile")
    import engine

    sr, n = 44100, 44100
    t = np.arange(n) / sr

    def tone(hz, a):
        return (a * np.sin(2 * np.pi * hz * t)).astype("float32")[:, None].repeat(2, axis=1)

    for name, hz, a in (("lead", 440, 0.4), ("conv", 440, 0.1), ("inst", 220, 0.2), ("backing", 330, 0.1)):
        sf.write(tmp_path / f"{name}.wav", tone(hz, a), sr)

    class Backend:
        def transpose(self, x, sr, key):
            return np.roll(x, key * 10, axis=0) * 0.9  # any change, the same both times

    plain, ready = tmp_path / "plain", tmp_path / "ready"
    plain.mkdir()
    ready.mkdir()
    args = (tmp_path / "lead.wav", tmp_path / "conv.wav", tmp_path / "inst.wav", -2)
    engine.mix_song(*args, plain, Backend(), -16.0, tmp_path / "backing.wav")
    prepared = engine.instrumental_for_mix(tmp_path / "inst.wav", -2, Backend(), tmp_path / "backing.wav")
    engine.mix_song(*args, ready, Backend(), -16.0, tmp_path / "backing.wav", prepared=prepared)
    for f in ("mix.wav", "instrumental.wav", "play_mix.pcm"):
        assert (plain / f).read_bytes() == (ready / f).read_bytes(), f


def test_find_lyrics_waits_once_for_the_asr_and_not_on_its_budget(net, monkeypatch, tmp_path):
    import lyrics

    net(lrclib=[_lrclib_item("Song", "Artist", 200, _lrc(12, 16.0))])
    audio = tmp_path / "lead.wav"
    audio.write_bytes(b"x")
    monkeypatch.setattr(lyrics, "_clip", lambda *a: b"wav")
    order: list[str] = []
    monkeypatch.setattr(lyrics, "asr_text", lambda wav, url, timeout: order.append("asr") or "line number 3 of the song")
    hints = {"title": "Song", "artist": None}

    def slow_wait():
        order.append("wait")
        time.sleep(0.3)

    r = lyrics.find_lyrics(hints, 200, llm=None, audio=audio, asr_url="http://asr", asr_mode="1", asr_wait=slow_wait,
                           budget_s=0.2)
    assert r is not None and r["checks"]["asr"]["ok"] is True
    assert order[0] == "wait" and order.count("wait") == 1 and "asr" in order
    order.clear()
    assert lyrics.find_lyrics(hints, 200, llm=None, audio=audio, asr_url="http://asr", asr_mode="0",
                              asr_wait=slow_wait) is not None
    assert order == []  # no spot check, no wait


def test_the_rvc_pass_falls_back_to_a_fresh_process(monkeypatch, tmp_path):
    import rvcpass

    env = {"SING_APPLIO_DIR": str(tmp_path / "applio"), "SING_RVC_MODEL": str(tmp_path / "m.pth")}
    srv = rvcpass.Server(env)
    args = srv._args("A.wav", "B.wav", -3)
    assert args[args.index("--input-path") + 1] == "A.wav" and args[args.index("--output-path") + 1] == "B.wav"
    assert args[args.index("--pitch") + 1] == "-3" and "core.py" not in args and "infer" not in args

    calls: list[str] = []

    class Broken:
        def start(self, warm_up=True):
            pass

        def run(self, *a):
            calls.append("server")
            raise RuntimeError("it died")

        def stop(self):
            calls.append("stop")

    monkeypatch.setattr(rvcpass, "available", lambda env=None: True)
    monkeypatch.setattr(rvcpass, "_server", Broken())
    monkeypatch.setattr(rvcpass, "run_once", lambda i, o, e=None, p=0: calls.append("fresh") or o)
    monkeypatch.delenv("SING_RVC_SERVER", raising=False)
    assert rvcpass.run(tmp_path / "in.wav", tmp_path / "out.wav") == tmp_path / "out.wav"
    assert calls == ["server", "stop", "fresh"] and rvcpass._server is None
    monkeypatch.setenv("SING_RVC_SERVER", "0")
    calls.clear()
    rvcpass.run(tmp_path / "in.wav", tmp_path / "out.wav")
    assert calls == ["fresh"]


def test_an_applio_without_the_pitch_hook_keeps_its_warm_process(monkeypatch, tmp_path):
    """It cannot be asked for the pitch, but converts with a given shift: it stays up, and is not asked again."""
    import rvcpass

    calls: list[str] = []

    class NoHook:
        def start(self, warm_up=True):
            pass

        def run(self, i, o, pitch=0, choose=None, ref=None):
            calls.append("ask" if choose else "run")
            if choose is not None:
                raise rvcpass.CannotAsk("no pitch hook")
            return o

        def stop(self):
            calls.append("stop")

    srv = NoHook()
    monkeypatch.setattr(rvcpass, "available", lambda env=None: True)
    monkeypatch.setattr(rvcpass, "_server", srv)
    monkeypatch.setattr(rvcpass, "_cannot_ask", False)
    monkeypatch.delenv("SING_RVC_SERVER", raising=False)
    with pytest.raises(rvcpass.CannotAsk):
        rvcpass.run_choosing(tmp_path / "in.wav", tmp_path / "out.wav", lambda q: 0)
    assert rvcpass.run(tmp_path / "in.wav", tmp_path / "out.wav", pitch=3) == tmp_path / "out.wav"
    with pytest.raises(rvcpass.CannotAsk):
        rvcpass.run_choosing(tmp_path / "in.wav", tmp_path / "out.wav", lambda q: 0)
    assert calls == ["ask", "run"] and rvcpass._server is srv


def test_a_cancelled_download_stops_without_a_second_try(monkeypatch, tmp_path):
    """The prefetch's progress raises once its job is cancelled; yt-dlp wraps it, the download ends."""
    import engine
    from songs import Source

    tries: list[str] = []

    class FakeYdl:
        def __init__(self, opts):
            self.hooks = opts["progress_hooks"]

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def _go(self, what):
            tries.append(what)
            try:
                for h in self.hooks:
                    h({"status": "downloading", "total_bytes": 10, "downloaded_bytes": 5})
            except Exception as e:  # what yt-dlp does with a hook's error
                raise RuntimeError("ERROR: download failed") from e

        def process_ie_result(self, info, download=True):
            self._go("answer")

        def download(self, urls):
            self._go("page")

    b = object.__new__(engine.RealBackend)
    b.max_s = 480
    monkeypatch.setattr(b, "_ydl", lambda extra=None: FakeYdl(extra), raising=False)

    def cancelled(_f):
        raise engine.Cancelled()

    info = {"id": "x", "formats": [{"format_id": "251", "url": "https://example.test/a"}]}
    src = Source(key="yt-x", kind="youtube", title="T", url="https://youtu.be/x", info=info, info_at=time.monotonic())
    with pytest.raises(engine.Cancelled):
        b.fetch(src, tmp_path / "source.wav", cancelled)
    assert tries == ["answer"]  # not read again from the page
    tries.clear()
    with pytest.raises(engine.Cancelled):
        b.fetch(Source(key="yt-y", kind="youtube", title="T", url="https://youtu.be/y"), tmp_path / "s.wav", cancelled)
    assert tries == ["page"]


def test_the_lyrics_of_a_job_that_ended_ask_the_asr_nothing(sing):
    """A failed or cancelled job's lookup stops before its spot check: it would run next to the next job."""
    if not is_mock():
        pytest.skip("mock only")
    import types

    server = _sing_server()
    job = types.SimpleNamespace(converted=threading.Event(), cancel=threading.Event(), exclusive=None, aborted=False)
    job.converted.set()
    lookup = server.LyricsLookup(job, None, None, Path("."), None)
    lookup.asr_wait()  # a job that goes on: the spot check runs
    job.aborted = True
    with pytest.raises(server.Cancelled):
        lookup.asr_wait()


def test_the_download_reuses_the_lookups_answer_while_it_is_fresh(monkeypatch):
    import time as _time

    import engine
    from songs import Source

    info = {"id": "x", "formats": [{"format_id": "251", "url": "https://example.test/a"}]}
    src = Source(key="yt-x", kind="youtube", title="T", info=info, info_at=_time.monotonic())
    got = engine.fresh_info(src)
    assert got == info and got is not info  # a copy: the audio and the video threads each get one
    got["formats"].clear()
    assert info["formats"]  # what one thread does to its copy leaves the other's alone
    assert "info" not in src.public() and "info_at" not in src.public()
    monkeypatch.setenv("SING_INFO_REUSE_S", "5")
    src.info_at = _time.monotonic() - 10
    assert engine.fresh_info(src) is None  # links that may have expired: read the page again
    monkeypatch.delenv("SING_INFO_REUSE_S")
    assert engine.fresh_info(Source(key="k", kind="url", title="T")) is None
    assert engine.fresh_info(Source(key="k", kind="url", title="T", info={"id": "x"}, info_at=_time.monotonic())) is None


def test_her_rvc_model_picks_the_key_from_the_pitch_it_reads(sing, monkeypatch):
    """SING_VOICE=rvc with the auto key: no pitch analysis in the worker, the RVC pass answers with it."""
    if not is_mock():
        pytest.skip("replaces the mock backend's conversion")
    server = _sing_server()
    b = server.state.backend
    asked: list[tuple] = []

    def convert_auto(vocal, out, choose, progress, cancelled):
        shift = choose((220.0, 300.0), 440.0)  # an octave under her: up an octave
        asked.append((vocal.name, shift))
        server._write_wav(out, server._tone(1, 16000, 440), 16000)
        progress(1.0)

    monkeypatch.setattr(b, "voice", "rvc", raising=False)
    monkeypatch.setattr(b, "convert_auto", convert_auto, raising=False)
    f0_before = len(b.f0_inputs)
    song = _job(sing, "rvc reads the pitch")["song"]
    assert asked == [("lead.wav", 12)]
    assert len(b.f0_inputs) == f0_before  # the worker read no pitch itself
    p = song["pitch"]
    assert p["auto"] is True and p["octave_shift"] == 12 and p["vocal_shift"] == 12
    assert p["source_median_hz"] == 220.0 and p["ref_median_hz"] == 440.0
    # An explicit pitch is the requester's: the plain conversion, no question asked.
    _job(sing, "rvc reads the pitch", pitch=-3)
    assert len(asked) == 1


# ── what the request bodies take and refuse ──────────────────────────────────
# Pinned with the hand-written request models, before they were generated from the JSON Schema:
# the generated ones must take and refuse exactly the same, with the same status and error body.

INVALID = "invalid request: "
NOT_AN_OBJECT = INVALID + "body: Input should be a valid dictionary or object to extract fields from"
ONE_SOURCE = {"error": "give exactly one of query, url or path"}

# The model takes these; the handler then refuses them for their sources, before any job exists.
JOB_TAKEN_BY_THE_MODEL = [
    {},
    {"query": None, "url": None, "path": None, "title": None, "artist": None, "pitch": None},
    {"query": "  "},
    {"query": "q" * 200, "url": "https://youtu.be/" + "u" * 483},
    {"url": "https://youtu.be/" + "u" * 483, "path": "p" * 300},
    {"title": "t" * 120, "artist": "a" * 120},
    {"pitch": 24, "key": -12},
    {"pitch": -24, "key": 12},
    {"pitch": 2.0, "key": "3"},
    {"backing": "acapella"},
    {"backing": "drop", "force": True, "exclusive_ack": True},
    {"backing": "convert", "force": "true", "exclusive_ack": 1},
    {"unknown": {"a": 1}},
]

JOB_REFUSED = [
    ({"query": "q" * 201}, "query: String should have at most 200 characters"),
    ({"url": "u" * 501}, "url: String should have at most 500 characters"),
    ({"path": "p" * 301}, "path: String should have at most 300 characters"),
    ({"title": "t" * 121}, "title: String should have at most 120 characters"),
    ({"artist": "a" * 121}, "artist: String should have at most 120 characters"),
    ({"query": 5}, "query: Input should be a valid string"),
    ({"pitch": 25}, "pitch: Input should be less than or equal to 24"),
    ({"pitch": -25}, "pitch: Input should be greater than or equal to -24"),
    ({"pitch": 1.5}, "pitch: Input should be a valid integer, got a number with a fractional part"),
    ({"pitch": "up"}, "pitch: Input should be a valid integer, unable to parse string as an integer"),
    ({"key": 13}, "key: Input should be less than or equal to 12"),
    ({"key": -13}, "key: Input should be greater than or equal to -12"),
    ({"key": None}, "key: Input should be a valid integer"),
    ({"backing": "loud"}, "backing: Input should be 'keep', 'drop', 'convert' or 'acapella'"),
    ({"backing": "KEEP"}, "backing: Input should be 'keep', 'drop', 'convert' or 'acapella'"),
    ({"backing": None}, "backing: Input should be 'keep', 'drop', 'convert' or 'acapella'"),
    ({"force": "maybe"}, "force: Input should be a valid boolean, unable to interpret input"),
    ({"force": None}, "force: Input should be a valid boolean"),
    ({"exclusive_ack": None}, "exclusive_ack: Input should be a valid boolean"),
    ({"key": 13, "pitch": 25}, "pitch: Input should be less than or equal to 24"),
    (b"[]", "body: Input should be a valid dictionary or object to extract fields from"),
    (b"null", "body: Input should be a valid dictionary or object to extract fields from"),
    (b"nope", "0: JSON decode error"),
    (NO_BODY, "body: Field required"),
]


def test_job_request_bodies(sing):
    for body in JOB_TAKEN_BY_THE_MODEL:
        assert send(sing, "POST", "/jobs", body) == (400, ONE_SOURCE), body
    for body, error in JOB_REFUSED:
        assert send(sing, "POST", "/jobs", body) == (400, {"error": INVALID + error}), body


def test_a_job_keeps_its_request_as_given_with_the_defaults(sing):
    if not is_mock():
        pytest.skip("makes songs")
    status, a = send(sing, "POST", "/jobs", {"query": "pinned defaults"})
    assert status == 200
    status, b = send(sing, "POST", "/jobs", {"query": "pinned request", "url": None, "pitch": None, "key": "3",
                                             "backing": "drop", "force": True, "unknown": 1})
    assert status == 200
    for job in (a["job"], b["job"]):
        sing.delete(f"/jobs/{job['id']}")
        wait(sing, job["id"])
    assert a["job"]["request"] == {"query": "pinned defaults", "key": 0, "backing": "keep", "force": False,
                                   "exclusive_ack": False, "purpose": "cover", "karaoke_video": True}
    assert b["job"]["request"] == {"query": "pinned request", "key": 3, "backing": "drop", "force": True,
                                   "exclusive_ack": False, "purpose": "cover", "karaoke_video": True}


def test_lyrics_request_bodies(sing):
    no_song = (404, {"error": "no song nosuchsong"})
    for body in (NO_BODY, b"null", {}, {"title": None, "artist": None, "fresh": False},
                 {"title": "t" * 200, "artist": "a" * 200, "fresh": True}, {"fresh": "yes"}, {"unknown": 1}):
        assert send(sing, "POST", "/songs/nosuchsong/lyrics", body) == no_song, body
    for body, error in (
        ({"title": "t" * 201}, "title: String should have at most 200 characters"),
        ({"artist": "a" * 201}, "artist: String should have at most 200 characters"),
        ({"artist": 5}, "artist: Input should be a valid string"),
        ({"fresh": "maybe"}, "fresh: Input should be a valid boolean, unable to interpret input"),
        ({"fresh": None}, "fresh: Input should be a valid boolean"),
        (b"[]", "body: Input should be a valid dictionary or object to extract fields from"),
        (b"nope", "0: JSON decode error"),
    ):
        assert send(sing, "POST", "/songs/nosuchsong/lyrics", body) == (400, {"error": INVALID + error}), body


def test_gpu_context_request_bodies(sing):
    if not is_mock():
        pytest.skip("tells the worker who listens")
    server = sys.modules["sing_server"]
    try:
        for body in ({}, {"in_voice": True, "listeners": 3, "live": False, "urgent": ["j"] * 200},
                     {"in_voice": "true", "listeners": "2", "live": 0}, {"unknown": 1}):
            assert send(sing, "POST", "/gpu/context", body) == (200, {"ok": True}), body
        for body, error in (
            ({"listeners": -1}, "listeners: Input should be greater than or equal to 0"),
            ({"listeners": 1.5}, "listeners: Input should be a valid integer, got a number with a fractional part"),
            ({"listeners": None}, "listeners: Input should be a valid integer"),
            ({"in_voice": None}, "in_voice: Input should be a valid boolean"),
            ({"live": "maybe"}, "live: Input should be a valid boolean, unable to interpret input"),
            ({"urgent": ["j"] * 201}, "urgent: List should have at most 200 items after validation, not 201"),
            ({"urgent": "j"}, "urgent: Input should be a valid list"),
            ({"urgent": [1]}, "urgent.0: Input should be a valid string"),
            ({"urgent": None}, "urgent: Input should be a valid list"),
            (b"[]", "body: Input should be a valid dictionary or object to extract fields from"),
            (b"null", "body: Input should be a valid dictionary or object to extract fields from"),
            (NO_BODY, "body: Field required"),
        ):
            assert send(sing, "POST", "/gpu/context", body) == (400, {"error": INVALID + error}), body
    finally:
        server.state.machine.audience = server.Audience()


def test_prune_request_bodies(sing):
    for body in (NO_BODY, b"null", {}, {"dry_run": True}, {"dry_run": False}, {"dry_run": "yes"}, {"unknown": 1}):
        status, _ = send(sing, "POST", "/cache/prune?dry_run=true", body)
        assert status == 200, body
    for body, error in (
        ({"dry_run": "maybe"}, "dry_run: Input should be a valid boolean, unable to interpret input"),
        ({"dry_run": None}, "dry_run: Input should be a valid boolean"),
        (b"[]", "body: Input should be a valid dictionary or object to extract fields from"),
        (b"nope", "0: JSON decode error"),
    ):
        assert send(sing, "POST", "/cache/prune?dry_run=true", body) == (400, {"error": INVALID + error}), body
