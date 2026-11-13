"""The song cache cleans up after itself (workers/sing/cache.py): least recently used first, never
what is in use, downloads only once no song needs them. Pure Python: no soundfile, no GPU."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))

from cache import GB, Cache, CacheLimits, Protected  # noqa: E402
from songs import Store  # noqa: E402

DAY = 86400.0
NOW = 1_800_000_000.0


class Clock:
    def __init__(self, t: float = NOW) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def song(root: Path, sid: str, source: str, size: int = 1000, title: str | None = None) -> Path:
    d = root / sid
    d.mkdir(parents=True)
    meta = {"id": sid, "title": title or sid, "source": {"key": source, "kind": "youtube"}}
    (d / "meta.json").write_text(json.dumps(meta), "utf-8")
    (d / "play_mix.pcm").write_bytes(b"\0" * size)
    return d


def source(root: Path, key: str, size: int = 500) -> Path:
    d = root / "_sources" / key
    d.mkdir(parents=True)
    (d / "info.json").write_text(json.dumps({"key": key, "kind": "youtube", "title": key}), "utf-8")
    (d / "source.wav").write_bytes(b"\0" * size)
    return d


def used(cache: Cache, clock: Clock, at: float, song_id: str | None = None, src: str | None = None) -> None:
    """Records a use ``at`` seconds before NOW."""
    before = clock.t
    clock.t = NOW - at
    cache.touch(song=song_id, source=src)
    clock.t = before


def limits(gb: float = 0.0, days: float = 0.0, hours: float = 0.0, max_bytes: int | None = None) -> CacheLimits:
    return CacheLimits(max_bytes=max_bytes if max_bytes is not None else int(gb * GB), max_days=days,
                       protect_hours=hours)


def ids(summary: dict) -> list[tuple[str, str]]:
    return [(r["kind"], r["id"]) for r in summary["removed"]]


@pytest.fixture()
def setup(tmp_path):
    clock = Clock()
    protected = Protected()
    cache = Cache(tmp_path, tmp_path / "library", lambda: protected, Store(tmp_path).forget_sources, clock)
    return tmp_path, cache, clock, protected


def test_the_least_recently_used_song_goes_first_until_under_the_cap(setup):
    root, cache, clock, _ = setup
    for i, ago in enumerate((3, 1, 2)):  # a: 3 days, b: 1 day, c: 2 days
        name = "abc"[i]
        song(root, name, f"src-{name}")
        source(root, f"src-{name}")
        used(cache, clock, ago * DAY, name, f"src-{name}")
    total = cache.status()["bytes"]
    assert 3 * 1500 < total < 3 * 1500 + 3000  # the audio and the small json files
    # Room for two of the three: the oldest (a) goes with its download, nothing else.
    out = cache.prune(limits=limits(max_bytes=total - 1))
    assert ids(out) == [("song", "a"), ("source", "src-a")]
    assert out["after_bytes"] <= total - 1 and not out["over_cap"]
    assert not (root / "a").exists() and not (root / "_sources" / "src-a").exists()
    assert (root / "b").exists() and (root / "c").exists()
    # Room for one: c (2 days) goes before b (1 day).
    out = cache.prune(limits=limits(max_bytes=cache.status()["bytes"] - 1))
    assert ids(out) == [("song", "c"), ("source", "src-c")]
    assert [d.name for d in root.iterdir() if d.is_dir() and not d.name.startswith("_")] == ["b"]


def test_a_song_not_used_for_max_days_goes_even_under_the_cap(setup):
    root, cache, clock, _ = setup
    song(root, "old", "s-old")
    song(root, "new", "s-new")
    used(cache, clock, 15 * DAY, "old")
    used(cache, clock, 13 * DAY, "new")
    out = cache.prune(limits=limits(gb=100, days=14))
    assert ids(out) == [("song", "old")]
    assert out["removed"][0]["why"] == "age"


def test_songs_without_a_recorded_use_go_by_their_dir_time(setup):
    root, cache, _clock, _ = setup
    old = song(root, "old", "x")
    song(root, "new", "y")
    os.utime(old, (NOW - 20 * DAY, NOW - 20 * DAY))
    os.utime(root / "new", (NOW - 1 * DAY, NOW - 1 * DAY))
    assert ids(cache.prune(limits=limits(days=14))) == [("song", "old")]


def test_recent_and_in_flight_songs_stay_even_over_the_cap(setup):
    root, cache, clock, protected = setup
    for name, ago in (("recent", 2 * 3600), ("job", 30 * DAY), ("idle", 10 * DAY)):
        song(root, name, f"s-{name}")
        source(root, f"s-{name}")
        used(cache, clock, ago, name, f"s-{name}")
    protected.songs.add("job")
    protected.sources.add("s-job")
    out = cache.prune(limits=limits(max_bytes=1, days=7, hours=6))
    assert ids(out) == [("song", "idle"), ("source", "s-idle")]
    assert out["over_cap"] is True
    assert out["protected"] == 4  # the two songs and their downloads
    assert (root / "recent").exists() and (root / "job").exists()


def test_a_download_goes_only_once_no_song_is_made_from_it(setup):
    root, cache, clock, _ = setup
    source(root, "shared")
    song(root, "shared", "shared")
    song(root, "shared-k-2", "shared")
    used(cache, clock, 3 * DAY, "shared", "shared")
    used(cache, clock, 1 * DAY, "shared-k-2")
    # One of the two songs: the other still needs the download.
    total = cache.status()["bytes"]
    out = cache.prune(limits=limits(max_bytes=total - 1))
    assert ids(out) == [("song", "shared")]
    assert (root / "_sources" / "shared").exists()
    # The last one goes: so does the download.
    out = cache.prune(limits=limits(max_bytes=1))
    assert ids(out) == [("song", "shared-k-2"), ("source", "shared")]


def test_a_download_no_song_needs_goes_once_out_of_the_protect_window(setup):
    root, cache, clock, _ = setup
    source(root, "failed-job")  # a job that failed after the download
    source(root, "fresh")
    used(cache, clock, 10 * 3600, src="failed-job")
    used(cache, clock, 1 * 3600, src="fresh")
    out = cache.prune(limits=limits(gb=100, hours=6))
    assert ids(out) == [("source", "failed-job")]
    assert out["removed"][0]["why"] == "unused"
    assert (root / "_sources" / "fresh").exists()


def test_a_dry_run_says_what_would_go_and_removes_nothing(setup):
    root, cache, clock, _ = setup
    for name, ago in (("a", 5), ("b", 1)):
        song(root, name, name)
        source(root, name)
        used(cache, clock, ago * DAY, name, name)
    before = sorted(p.name for p in root.rglob("*"))
    dry = cache.prune(dry_run=True, limits=limits(days=3))
    assert ids(dry) == [("song", "a"), ("source", "a")]
    assert dry["dry_run"] is True and dry["freed_bytes"] > 0
    assert sorted(p.name for p in root.rglob("*")) == before
    assert cache.last is None  # a dry run is not the last cleanup
    real = cache.prune(limits=limits(days=3))
    assert ids(real) == ids(dry) and real["freed_bytes"] == dry["freed_bytes"]
    assert cache.status()["last"]["removed_songs"] == 1


def test_both_limits_off_turns_the_cleanup_off(setup):
    root, cache, clock, _ = setup
    song(root, "a", "a")
    source(root, "orphan")
    used(cache, clock, 400 * DAY, "a")
    assert cache.prune(limits=limits())["removed"] == []
    assert (root / "a").exists() and (root / "_sources" / "orphan").exists()


def test_a_hard_linked_video_counts_once_and_frees_only_with_its_last_link(setup):
    root, cache, clock, _ = setup
    s = source(root, "v", size=10)
    (s / "video.mp4").write_bytes(b"\1" * 5000)
    d = song(root, "v", "v", size=10)
    try:
        os.link(s / "video.mp4", d / "video.mp4")
    except OSError:
        pytest.skip("no hard links here")
    used(cache, clock, 2 * DAY, "v", "v")
    assert 5000 < cache.status()["bytes"] < 2 * 5000
    out = cache.prune(dry_run=True, limits=limits(max_bytes=1))
    by = {(r["kind"], r["id"]): r["bytes"] for r in out["removed"]}
    assert by[("song", "v")] < 5000  # the video is still the download's
    assert by[("source", "v")] > 5000  # and goes with it


def test_the_queries_of_a_removed_download_are_dropped(setup):
    root, cache, clock, _ = setup
    store = Store(root)
    song(root, "gone", "gone")
    source(root, "gone")
    song(root, "kept", "kept")
    source(root, "kept")
    store.remember_query("Gone Song", "gone")
    store.remember_query("Kept Song", "kept")
    used(cache, clock, 30 * DAY, "gone", "gone")
    used(cache, clock, 1 * DAY, "kept", "kept")
    cache.prune(limits=limits(days=14))
    assert store.query_source("Gone Song") is None
    assert store.query_source("Kept Song") == "kept"


def test_only_songs_and_downloads_are_ever_removed(setup):
    root, cache, clock, _ = setup
    (root / "library" / "Artist - Title").mkdir(parents=True)
    (root / "library" / "Artist - Title" / "vocals.wav").write_bytes(b"x")
    (root / "_ytdlp-cache").mkdir()
    (root / "_lyrics").mkdir()
    (root / "notes").mkdir()  # not a song: no song files in it
    (root / "notes" / "todo.txt").write_text("keep")
    (root / "_gpu-profile.json").write_text("{}")
    for d in ("library", "_ytdlp-cache", "_lyrics", "notes"):
        os.utime(root / d, (NOW - 400 * DAY, NOW - 400 * DAY))
    out = cache.prune(limits=limits(max_bytes=1, days=1))
    assert out["removed"] == []
    for p in ("library/Artist - Title/vocals.wav", "_ytdlp-cache", "_lyrics", "notes/todo.txt", "_gpu-profile.json"):
        assert (root / p).exists()


def test_an_unfinished_song_dir_counts_and_goes_by_the_same_rules(setup):
    root, cache, _clock, protected = setup
    d = root / "src-p-3"
    d.mkdir()
    (d / "_converted.wav").write_bytes(b"\0" * 100)  # a job that died mid conversion
    os.utime(d, (NOW - 30 * DAY, NOW - 30 * DAY))
    assert cache.status()["incomplete_songs"] == 1
    protected.songs.add("src-p-3")  # its job runs again: it stays
    assert cache.prune(limits=limits(days=14))["removed"] == []
    protected.songs.clear()
    assert ids(cache.prune(limits=limits(days=14))) == [("song", "src-p-3")]


def test_a_song_used_while_the_cleanup_runs_stays(setup):
    root, cache, clock, _ = setup
    song(root, "a", "a")
    used(cache, clock, 30 * DAY, "a")
    # Core fetches its audio between the plan and the removal.
    original = cache.plan

    def plan_then_use(*args, **kwargs):
        out = original(*args, **kwargs)
        cache.touch(song="a")
        return out

    cache.plan = plan_then_use
    out = cache.prune(limits=limits(days=14, hours=1))
    assert out["removed"] == [] and out["errors"] == ["song a: used meanwhile"]
    assert (root / "a" / "play_mix.pcm").exists()


def test_the_last_use_survives_a_restart(setup):
    root, cache, clock, _ = setup
    song(root, "a", "a")
    used(cache, clock, 20 * DAY, "a")
    again = Cache(root, clock=clock)
    assert ids(again.prune(limits=limits(days=14))) == [("song", "a")]
    assert json.loads((root / "_usage.json").read_text("utf-8"))["songs"] == {}


# ── through the worker (mock backend) ───────────────────────────────────────


@pytest.fixture(scope="module")
def worker(tmp_path_factory):
    root = tmp_path_factory.mktemp("songs-cache")
    os.environ.update({"SING_BACKEND": "mock", "SING_DATA_DIR": str(root), "SING_MOCK_SECONDS": "1"})
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


def _wait(client, job_id: str) -> dict:
    t0 = time.time()
    while time.time() - t0 < 60:
        job = client.get(f"/jobs/{job_id}").json()["job"]
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_a_song_the_cleanup_removed_is_made_again_when_asked_for(worker, monkeypatch):
    client, server, root = worker
    monkeypatch.setattr(server.state, "janitor", None)  # the test runs the cleanup itself
    job = _wait(client, client.post("/jobs", json={"query": "Cache Me Song"}).json()["job"]["id"])
    assert job["state"] == "done"
    sid = job["song_id"]
    assert client.get(f"/songs/{sid}/files/play_mix.pcm").status_code == 200
    status = client.get("/cache").json()
    assert status["songs"] >= 1 and status["bytes"] > 0
    assert status["limits"] == {"max_gb": 6.0, "max_bytes": 6 * GB, "max_days": 14.0, "protect_hours": 6.0}
    # Used just now: the defaults keep it.
    assert client.post("/cache/prune").json()["removed"] == []

    monkeypatch.setenv("SING_CACHE_MAX_GB", "0.000000001")
    monkeypatch.setenv("SING_CACHE_PROTECT_HOURS", "0")
    dry = client.post("/cache/prune?dry_run=true").json()
    assert ("song", sid) in ids(dry) and (root / sid).exists()
    out = client.post("/cache/prune", json={"dry_run": False}).json()
    assert ("song", sid) in ids(out)
    assert not (root / sid).exists()
    assert not (root / "_sources" / job["source"]["key"]).exists()
    assert client.get(f"/songs/{sid}/files/play_mix.pcm").status_code == 404
    assert client.get("/cache").json()["last"]["removed_songs"] >= 1

    # Asked for again: no cache hit, the song is made again (the download too).
    again = client.post("/jobs", json={"query": "Cache Me Song"}).json()["job"]
    assert again["cached"] is False
    again = _wait(client, again["id"])
    assert again["state"] == "done" and again["song_id"] == sid and again["cached"] is False
    assert client.get(f"/songs/{sid}/files/play_mix.pcm").status_code == 200


def test_the_cleanup_leaves_a_running_jobs_song_and_download_alone(worker, monkeypatch):
    client, server, root = worker
    monkeypatch.setattr(server.state, "janitor", None)
    monkeypatch.setenv("SING_CACHE_MAX_GB", "0.000000001")
    monkeypatch.setenv("SING_CACHE_PROTECT_HOURS", "0")
    gate = threading.Event()
    original = server.state.backend.convert

    def held(*args, **kwargs):
        gate.wait(10)
        return original(*args, **kwargs)

    monkeypatch.setattr(server.state.backend, "convert", held)
    job = client.post("/jobs", json={"query": "Held Song"}).json()["job"]
    try:
        t0 = time.time()
        while client.get(f"/jobs/{job['id']}").json()["job"]["song_id"] is None and time.time() - t0 < 10:
            time.sleep(0.02)
        running = client.get(f"/jobs/{job['id']}").json()["job"]
        key = running["source"]["key"]
        out = client.post("/cache/prune").json()
        assert ("source", key) not in ids(out) and ("song", running["song_id"]) not in ids(out)
        assert (root / "_sources" / key).exists()
    finally:
        gate.set()
    assert _wait(client, job["id"])["state"] == "done"
