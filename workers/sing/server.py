"""Miyoria song worker: song requests → AI covers in her voice (docs/protocols/voice-link.md, 「歌曲 Worker」).

    POST   /jobs                {query | url | path, title?, artist?, pitch?, key?, force?, exclusive_ack?}
                                -> {"job"}
    POST   /jobs/{id}/exclusive -> {"job"}                 go ahead and take the GPU (see exclusive.py)
    GET    /jobs                -> {"jobs": [...]}         newest first
    GET    /jobs/{id}           -> {"job"}                 state, stage, progress, song when done
    DELETE /jobs/{id}           -> {"job"}                 cancels a queued or running job
    GET    /songs               -> {"songs": [meta...]}    cached covers, newest first
    GET    /songs/{id}          -> {"song": meta}
    GET    /songs/{id}/files/{name}   mix.wav · vocals.wav · instrumental.wav · lyrics.lrc ·
                                      play_mix.pcm · play_vocals.pcm (s16le mono 48 kHz) · meta.json ·
                                      video.mp4 (library: video.<ext>) when ``has_video``
    GET    /library             -> {"entries": [...]}      the owner's local song folder
    GET    /health

Pipeline per job (one job at a time; models load per stage and are freed after it):
    resolve   library match / yt-dlp search (``ytsearch1:``) / link (allowed hosts only), ≤ SING_MAX_SECONDS
    download  bestaudio → 44.1 kHz stereo WAV (ffmpeg)
    separate  Demucs (SING_SEPARATOR_MODEL, default htdemucs) → vocals + instrumental; skipped for
              library folders that already have both stems, and for sources separated before
    convert   Seed-VC singing model (F0-conditioned, 44.1 kHz) with her reference voice, on a
              cleaned F0 contour (octave errors, spikes, dropouts: pitch.py); the pitch shift is
              ``pitch`` when given, else auto: the octave from the song's median and its top (95th
              percentile) against her range, and when the top is still over her ceiling the whole
              song goes down a few semitones (``auto_key``, SING_KEY_MIN..SING_KEY_MAX); plus
              ``key`` (whole-song transpose, which turns the auto key off)
    mix       converted vocal at the original vocal's level + instrumental (moved by the key with
              Rubber Band when ffmpeg has it), loudness-normalised to SING_TARGET_LUFS, peak ≤ -1 dBFS
    lyrics    lrclib.net synced LRC by title / artist / duration (best effort)
    video     (in parallel, once the audio is downloaded) the link's video, video only, H.264 <= 1080p
              preferred, into video.mp4 for the stream to show while she sings; library entries
              use a video next to the audio. The song is ready once both are done; a video that
              fails or is still not there SING_VIDEO_WAIT_S after the audio leaves the song
              ready without one (``has_video: false``, ``video_error``). Songs cached before
              videos existed get theirs on the next request.

GPU: with SING_OFFLOAD_URLS (the TTS / ASR workers) the job has the GPU to itself from the first
GPU stage (separate, else convert) to the end of the conversion: stage ``exclusive`` and the job's
``exclusive`` field (waiting · offloading · active · reloading · done) tell Core; see exclusive.py.

A finished song is cached under SING_DATA_DIR/<song id>; asking again (same query, link or file
and the same pitch settings) answers at once with ``cached: true``.

Environment
    SING_BACKEND           seed-vc | mock                         (default seed-vc)
    SING_DATA_DIR          cache root                             (default <repo>/data/songs)
    SING_LIBRARY_DIR       local songs                            (default <data dir>/library)
    SING_LIBRARY_FIRST     1 = a query that matches a library entry uses it (default 1)
    SING_REF               her reference voice                    (default ../voices/deepseek-chan/ref.wav)
    SING_SEEDVC_DIR        Seed-VC checkout                       (default ../models/seed-vc)
    SING_DEVICE            cuda | cpu                             (default cuda when available)
    SING_SEPARATE_DEVICE   device of the separator                (default SING_DEVICE; VRAM OOM → CPU)
    SING_SEPARATOR_MODEL   Demucs model                           (default htdemucs; htdemucs_ft = better, 4x slower)
    SING_DIFFUSION_STEPS   Seed-VC steps                          (default 30)
    SING_CFG_RATE          Seed-VC inference cfg rate             (default 0.7)
    SING_TARGET_OFFSET     her singing median vs her speaking median, semitones (default 2)
    SING_MAX_NOTE          her ceiling: a note (A5) or Hz          (default: speech median + SING_CEILING_OFFSET)
    SING_CEILING_OFFSET    her ceiling above her speaking median, semitones (default 16)
    SING_KEY_MIN / MAX     range of the automatic whole-song key   (default -5 / 3; 0 / 0 = octave only)
    SING_F0_CLEAN          0 = convert on the raw RMVPE contour    (default 1)
    SING_TARGET_LUFS       loudness of the mix                    (default -16)
    SING_MAX_SECONDS       longest song                           (default 480)
    SING_URL_HOSTS         hosts links may point to               (default youtube.com, youtu.be, music.youtube.com,
                                                                   soundcloud.com, bilibili.com, nicovideo.jp)
    SING_JS_RUNTIMES       yt-dlp JavaScript runtimes for YouTube (default deno,node)
    SING_LYRICS            0 = no lrclib lookup                   (default 1)
    SING_KEEP_MODELS       1 = keep models in VRAM between jobs   (default 0)
    SING_GPU_CHILD         1 = GPU stages in a child process that ends with the job, so the idle
                           worker holds no CUDA context (default 0; ignored with SING_KEEP_MODELS=1)
    SING_VIDEO             0 = no videos                          (default 1)
    SING_VIDEO_MAX_HEIGHT  tallest video                          (default 1080)
    SING_VIDEO_MAX_MB      largest video                          (default 300)
    SING_VIDEO_WAIT_S      wait for the video after the audio     (default 120)
    SING_OFFLOAD_URLS      workers to offload while converting, comma separated (default none),
                           e.g. http://127.0.0.1:8002,http://127.0.0.1:8003
    SING_EXCLUSIVE_WAIT_S  wait this long for Core's go (exclusive_ack) (default 30)
    SING_RELOAD_TIMEOUT_S  longest wait for a worker to reload    (default 300)
    SING_MOCK_SECONDS      mock: song length                      (default 3)
    SING_MOCK_STAGE_MS     mock: delay per stage                  (default 0)
    HOST / PORT            bind address                           (default 127.0.0.1 / 8005)
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import secrets
import sys
import threading
import time
import wave
from array import array
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Cancelled, JobError, allowed_url, env_float, env_int  # noqa: E402
from exclusive import Exclusive, http_post, parse_urls  # noqa: E402
from gpu_child import GpuChild  # noqa: E402
from songs import (  # noqa: E402
    PLAY_RATE,
    SONG_FILES,
    Source,
    Store,
    find_video,
    link_or_copy,
    safe_id,
    short_hash,
    song_id,
)

log = logging.getLogger("miyoria.sing")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MAX_JOBS_KEPT = 100
# Share of the job's progress per stage.
WEIGHTS = {"resolve": 0.04, "download": 0.12, "exclusive": 0.0, "separate": 0.30, "convert": 0.44, "mix": 0.07, "lyrics": 0.03,
           "video": 0.0}
# Sources whose link has a video to fetch (a library entry brings its own file).
VIDEO_KINDS = ("youtube", "url", "mock")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ── mock backend (pure Python: CI and Core tests) ────────────────────────────


def _tone(seconds: float, rate: int, freq: float, amp: float = 0.25) -> array:
    n = int(seconds * rate)
    return array("h", (int(32767 * amp * math.sin(2 * math.pi * freq * i / rate)) for i in range(n)))


def _write_wav(p: Path, samples: array, rate: int) -> None:
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())


class MockBackend:
    """Sine waves instead of songs: same files, same metadata, no GPU, no network."""

    name = "mock"
    device = "cpu"
    model_name = "mock"

    def __init__(self, store: Store) -> None:
        self.store = store
        self.seconds = env_float("SING_MOCK_SECONDS", 3.0)
        self.delay = env_int("SING_MOCK_STAGE_MS", 0) / 1000

    def _wait(self) -> None:
        if self.delay:
            time.sleep(self.delay)

    def resolve_search(self, query: str) -> Source:
        self._wait()
        if query.strip().lower() == "fail":
            raise JobError("no search result for 'fail'")
        return Source(key=f"mock-{short_hash(query, 10)}", kind="mock", title=query.strip(), artist="Mock Artist",
                      duration_s=self.seconds, url=f"https://www.youtube.com/watch?v=mock{short_hash(query, 6)}")

    def resolve_url(self, url: str) -> Source:
        if not allowed_url(url):
            raise JobError("that link is not on an allowed host (SING_URL_HOSTS)")
        return Source(key=f"mock-{short_hash(url, 10)}", kind="url", title="Mock Link", artist=None,
                      duration_s=self.seconds, url=url)

    def fetch(self, src: Source, dest: Path, progress: Callable[[float], None]) -> None:
        self._wait()
        _write_wav(dest, _tone(self.seconds, 16_000, 330), 16_000)

    def fetch_video(self, src: Source, dest: Path, progress: Callable[[float], None],
                    cancelled: Callable[[], bool]) -> dict[str, Any]:
        """A few bytes named video.mp4; titles with "novideo" have none (like a SoundCloud link)."""
        self._wait()
        if cancelled():
            raise Cancelled()
        if "novideo" in src.title.lower():
            raise JobError("no video: Requested format is not available")
        dest.write_bytes(b"\x00\x00\x00\x18ftypmp42mock video")
        progress(1.0)
        return {"width": 1920, "height": 1080, "vcodec": "avc1.mock", "fps": 30, "format_id": "mock"}

    def library_video(self, v: Path, sdir: Path) -> dict[str, Any]:
        link_or_copy(v, sdir / f"video{v.suffix.lower()}")
        return {"source": "library", "bytes": v.stat().st_size}

    def fetch_library(self, src: Source, sdir: Path) -> None:
        self.fetch(src, sdir / "source.wav", lambda _: None)

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Callable[[float], None]) -> None:
        self._wait()
        _write_wav(vocals_out, _tone(self.seconds, 16_000, 440), 16_000)
        _write_wav(inst_out, _tone(self.seconds, 16_000, 220, 0.1), 16_000)

    def median_f0(self, path: Path) -> float | None:
        return env_float("SING_MOCK_F0_HZ", 440.0)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        return env_float("SING_MOCK_F0_HZ", 440.0), env_float("SING_MOCK_F0_TOP_HZ", 440.0)

    def ref_f0(self) -> float | None:
        return 440.0

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Callable[[float], None],
                cancelled: Callable[[], bool]) -> None:
        if os.environ.get("SING_MOCK_CONVERT_FAIL") == "1":
            raise JobError("mock conversion failed")
        for i in range(4):
            if cancelled():
                raise Cancelled()
            self._wait()
            progress((i + 1) / 4)
        _write_wav(out_wav, _tone(self.seconds, 16_000, 440 * 2 ** (shift / 12)), 16_000)

    def mix(self, sdir: Path, converted: Path, key: int, out: Path) -> dict[str, Any]:
        self._wait()
        mix = _tone(self.seconds, PLAY_RATE, 440)
        vocals = _tone(self.seconds, PLAY_RATE, 440, 0.2)
        _write_wav(out / "mix.wav", mix, PLAY_RATE)
        _write_wav(out / "vocals.wav", vocals, PLAY_RATE)
        _write_wav(out / "instrumental.wav", _tone(self.seconds, PLAY_RATE, 220, 0.1), PLAY_RATE)
        (out / "play_mix.pcm").write_bytes(mix.tobytes())
        (out / "play_vocals.pcm").write_bytes(vocals.tobytes())
        return {"vocal_gain": 1.0, "lufs": -16.0, "samples": len(mix), "duration_s": round(len(mix) / PLAY_RATE, 2)}

    def lyrics(self, src: Source, duration: float | None, query: str | None = None) -> dict[str, Any] | None:
        if os.environ.get("SING_LYRICS", "1") == "0":
            return None
        lines = [f"[00:{i:02d}.00]mock line {i + 1}" for i in range(max(1, int(self.seconds)))]
        return {"provider": "mock", "synced": True, "lrc": "\n".join(lines), "plain": None,
                "track": src.title, "artist": src.artist}

    def unload(self) -> None:
        return None


def make_backend(store: Store) -> Any:
    name = os.environ.get("SING_BACKEND", "seed-vc").lower()
    if name == "mock":
        return MockBackend(store)
    if name in ("seed-vc", "seedvc", "real"):
        from engine import RealBackend

        return _RealAdapter(RealBackend(store))
    raise RuntimeError(f"unknown SING_BACKEND={name!r} (expected seed-vc | mock)")


def gpu_child_on() -> bool:
    """``SING_GPU_CHILD=1``: each job runs its GPU stages in a child process (not with kept models)."""
    return os.environ.get("SING_GPU_CHILD", "0") == "1" and os.environ.get("SING_KEEP_MODELS", "0") != "1"


class _GpuRouted:
    """A job's backend with its GPU stages (``separate``, ``f0_stats``, ``ref_f0``, ``convert``) in
    the job's ``GpuChild``; everything else (downloads, mix, lyrics, video) stays here."""

    def __init__(self, b: Any, child: GpuChild) -> None:
        self.b = b
        self.child = child
        self.separate, self.f0_stats, self.convert = child.separate, child.f0_stats, child.convert
        self.ref_f0 = child.ref_f0

    @property
    def device(self) -> str:
        return self.child.device or self.b.device

    def __getattr__(self, item: str) -> Any:
        return getattr(self.b, item)


class _RealAdapter:
    """Gives ``RealBackend`` the same method shapes as the mock (paths in, files out)."""

    def __init__(self, b: Any) -> None:
        self.b = b
        self.name = b.name
        self.model_name = b.model_name

    @property
    def device(self) -> str:
        # In child mode the main process does not import torch to find out.
        if gpu_child_on():
            return os.environ.get("SING_DEVICE") or "gpu-child"
        return self.b.device

    def __getattr__(self, item: str) -> Any:
        return getattr(self.b, item)

    def median_f0(self, path: Path) -> float | None:
        from engine import read_audio

        x, sr = read_audio(path)
        return self.b.median_f0(x.mean(axis=1), sr)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        from engine import read_audio

        x, sr = read_audio(path)
        return self.b.f0_stats(x.mean(axis=1), sr)

    def mix(self, sdir: Path, converted: Path, key: int, out: Path) -> dict[str, Any]:
        from engine import mix_song

        return mix_song(sdir / "vocals.wav", converted, sdir / "instrumental.wav", key, out, self.b,
                        env_float("SING_TARGET_LUFS", -16.0))

    def lyrics(self, src: Source, duration: float | None, query: str | None = None) -> dict[str, Any] | None:
        if os.environ.get("SING_LYRICS", "1") == "0":
            return None
        from lyrics import lookup

        return lookup(src.title, src.artist, duration, query=query)


# ── jobs ─────────────────────────────────────────────────────────────────────


class JobRequest(BaseModel):
    query: str | None = Field(None, max_length=200)
    url: str | None = Field(None, max_length=500)
    path: str | None = Field(None, max_length=300)
    title: str | None = Field(None, max_length=120)
    artist: str | None = Field(None, max_length=120)
    pitch: int | None = Field(None, ge=-24, le=24)
    key: int = Field(0, ge=-12, le=12)
    force: bool = False
    # Wait for POST /jobs/{id}/exclusive before taking the GPU (Core lets her speak first).
    exclusive_ack: bool = False


@dataclass
class Job:
    id: str
    request: JobRequest
    state: str = "queued"  # queued | running | done | failed | cancelled
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    song_id: str | None = None
    source: dict[str, Any] | None = None
    cached: bool = False
    created_at: str = field(default_factory=now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    video: "VideoFetch | None" = None
    exclusive: Exclusive | None = None
    go: threading.Event = field(default_factory=threading.Event)
    gpu: GpuChild | None = None

    def public(self, store: Store, position: int | None) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "state": self.state,
            "stage": self.stage,
            "progress": round(self.progress, 3),
            "error": self.error,
            "song_id": self.song_id,
            "source": self.source,
            "cached": self.cached,
            "request": self.request.model_dump(exclude_none=True),
            "position": position,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "song": None,
            "video": self.video.public() if self.video else None,
            "exclusive": self.exclusive.state if self.exclusive else None,
            "exclusive_info": self.exclusive.public() if self.exclusive else None,
        }
        if self.state == "done" and self.song_id:
            d["song"] = store.meta(self.song_id)
        return d


class State:
    store: Store
    backend: Any = None
    jobs: dict[str, Job]
    order: list[str]
    pending: "queue.Queue[str]"
    lock: threading.Lock
    running: str | None = None
    thread: threading.Thread | None = None
    stopping: threading.Event
    #: Cached songs whose lyrics are being looked up again.
    refilling: set[str]
    offload_post = staticmethod(http_post)  # replaced in tests


state = State()


def _position(job_id: str) -> int | None:
    with state.lock:
        waiting = [j for j in state.order if state.jobs[j].state == "queued"]
    return waiting.index(job_id) if job_id in waiting else None


def _public(job: Job) -> dict[str, Any]:
    return job.public(state.store, _position(job.id))


def _set(job: Job, stage: str, within: float = 0.0) -> None:
    before = 0.0
    for name, w in WEIGHTS.items():
        if name == stage:
            job.progress = min(0.999, before + w * max(0.0, min(1.0, within)))
            break
        before += w
    job.stage = stage


def _source_from_request(job: Job) -> Source:
    req, store, b = job.request, state.store, state.backend
    if req.path:
        rel = req.path.strip().replace("\\", "/")
        try:
            p = store.library_path(rel)
        except ValueError as e:
            raise JobError(str(e)) from e
        entry = next((e for e in store.library_entries() if e["path"] == rel), None)
        if entry is None:
            raise JobError(f"not a song in the library: {rel}")
        return Source(key=f"lib-{short_hash(str(p))}", kind="library", title=entry["title"],
                      artist=entry.get("artist"), path=rel, split=bool(entry["split"]))
    if req.url:
        return b.resolve_url(req.url.strip())
    q = (req.query or "").strip()
    known = store.query_source(q)
    if known and not req.force:
        info = store.source_info(known)
        if info:
            return Source(**info)
    if os.environ.get("SING_LIBRARY_FIRST", "1") != "0":
        entry = store.match_library(q)
        if entry:
            p = store.library_path(entry["path"])
            return Source(key=f"lib-{short_hash(str(p))}", kind="library", title=entry["title"],
                          artist=entry.get("artist"), path=entry["path"], split=bool(entry["split"]))
    src = b.resolve_search(q)
    store.remember_query(q, src.key)
    return src


def _auto_shift(sdir: Path, auto_key: bool, b: Any) -> tuple[int, int, dict[str, Any]]:
    """(octave −12 / 0 / +12 for her voice, whole-song key, info): the octave whose median lands
    closest to her singing median without the song's top going over her ceiling, and with
    ``auto_key`` a transposition down (or a little up) when the top is still out of her range."""
    from pitch import choose_key, parse_note

    stats = b.f0_stats(sdir / "vocals.wav")
    ref_hz = b.ref_f0()
    info: dict[str, Any] = {"ref_median_hz": ref_hz}
    if stats is None or not ref_hz:
        return 0, 0, info
    med, top = stats
    info.update({"source_median_hz": round(med, 1), "source_top_hz": round(top, 1)})
    lo, hi = (env_int("SING_KEY_MIN", -5), env_int("SING_KEY_MAX", 3)) if auto_key else (0, 0)
    chosen = choose_key(med, top, ref_hz, target_offset=env_float("SING_TARGET_OFFSET", 2.0),
                        ceiling=parse_note(os.environ.get("SING_MAX_NOTE", "")),
                        ceiling_offset=env_float("SING_CEILING_OFFSET", 16.0), key_min=min(lo, 0), key_max=max(hi, 0))
    info.update(chosen)
    return chosen["octave_shift"], chosen["auto_key"], info


def _peak_vram_reset() -> None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()


def _peak_vram_mb() -> int | None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        return round(torch.cuda.max_memory_allocated() / 2**20)
    return None


def _video_on() -> bool:
    return os.environ.get("SING_VIDEO", "1") != "0"


#: A cached song without lyrics is looked up again (lrclib may have been busy): 10 minutes after
#: the first lookup, an hour after the second, then once a day (most of those lrclib just lacks).
LYRICS_RECHECK_S = (600, 3600, 86400)


def _needs_lyrics(meta: dict[str, Any]) -> bool:
    """A cached song without lyrics whose last lookup is older than its ``LYRICS_RECHECK_S`` wait."""
    if os.environ.get("SING_LYRICS", "1") == "0" or meta.get("lyrics") is not None:
        return False
    checks = int(meta.get("lyrics_checks") or 0)
    wait = LYRICS_RECHECK_S[min(max(checks - 1, 0), len(LYRICS_RECHECK_S) - 1)]
    return time.time() - float(meta.get("lyrics_checked_at") or 0) > wait


def _refill_lyrics(sid: str, meta: dict[str, Any], query: str | None) -> None:
    """Looks up a cached song's lyrics again on the side, so the request is still answered at once
    (not queued behind a song being made); the next request for it has them."""
    with state.lock:
        if sid in state.refilling:
            return
        state.refilling.add(sid)

    def work() -> None:
        try:
            src = SimpleNamespace(title=meta.get("title") or "", artist=meta.get("artist"))
            found = state.backend.lyrics(src, meta.get("duration_s"), query)
            fresh = state.store.meta(sid) or meta
            if fresh.get("lyrics") is None:
                fresh["lyrics"] = _lyrics_meta(found, state.store.song_dir(sid))
            fresh["lyrics_checked_at"] = time.time()
            fresh["lyrics_checks"] = int(fresh.get("lyrics_checks") or 0) + 1
            state.store.write_meta(sid, fresh)
            log.info("song %s: lyrics looked up again (%s)", sid, "found" if fresh["lyrics"] else "none")
        except Exception:  # noqa: BLE001  (lyrics are best effort)
            log.exception("song %s: looking up its lyrics again failed", sid)
        finally:
            with state.lock:
                state.refilling.discard(sid)

    threading.Thread(target=work, name="sing-lyrics", daemon=True).start()


def _lyrics_meta(found: dict[str, Any] | None, out: Path) -> dict[str, Any] | None:
    """The ``lyrics`` part of a song's meta from a lookup result (writes ``lyrics.lrc``)."""
    if not found:
        return None
    from lyrics import parse_lrc

    lines = parse_lrc(found["lrc"]) if found.get("lrc") else []
    if found.get("lrc"):
        (out / "lyrics.lrc").write_text(found["lrc"], "utf-8")
    return {"provider": found["provider"], "synced": bool(lines), "track": found.get("track"),
            "artist": found.get("artist"), "lines": lines,
            "plain": None if lines else (found.get("plain") or "")[:4000]}


def _needs_video(meta: dict[str, Any], kind: str | None) -> bool:
    """A cached song made before videos existed (no ``has_video`` at all) whose source has one."""
    return _video_on() and "has_video" not in meta and (kind in VIDEO_KINDS or kind == "library")


class VideoFetch:
    """A source's video, fetched on its own thread while the audio pipeline runs."""

    def __init__(self, src: Source, sdir: Path, job_cancel: threading.Event) -> None:
        self.src, self.sdir = src, sdir
        self.state = "running"  # running | done | failed | cancelled
        self.progress = 0.0
        self.error: str | None = None
        self.seconds: float | None = None
        self._stop = threading.Event()
        self._job_cancel = job_cancel
        self._thread = threading.Thread(target=self._run, name="sing-video", daemon=True)

    def start(self) -> "VideoFetch":
        self._thread.start()
        return self

    def cancelled(self) -> bool:
        return self._stop.is_set() or self._job_cancel.is_set()

    def stop(self) -> None:
        self._stop.set()

    def running(self) -> bool:
        return self._thread.is_alive()

    def _run(self) -> None:
        t0 = time.perf_counter()
        dest = self.sdir / "video.mp4"
        try:
            info = state.backend.fetch_video(self.src, dest, self._progressed, self.cancelled)
            info = {**info, "source": self.src.kind, "bytes": dest.stat().st_size}
            (self.sdir / "video.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), "utf-8")
            self.state, self.progress = "done", 1.0
        except Cancelled:
            self.state, self.error = "cancelled", "cancelled"
        except JobError as e:
            self.state, self.error = "failed", str(e)
            log.info("no video for %s: %s", self.src.key, e)
        except Exception as e:  # noqa: BLE001
            log.exception("video download of %s crashed", self.src.key)
            self.state, self.error = "failed", f"{type(e).__name__}: {e}"[:300]
        finally:
            self.seconds = round(time.perf_counter() - t0, 2)
            if self.state != "done":
                dest.unlink(missing_ok=True)

    def _progressed(self, f: float) -> None:
        self.progress = max(0.0, min(1.0, f))

    def wait(self, timeout_s: float, job_cancel: threading.Event) -> None:
        """Until it ends, at most ``timeout_s`` (then it is stopped); raises Cancelled with the job."""
        deadline = time.monotonic() + max(0.0, timeout_s)
        while self._thread.is_alive():
            if job_cancel.is_set():
                self.stop()
                raise Cancelled()
            if time.monotonic() >= deadline:
                self.stop()
                self._thread.join(5)
                if self.state != "done":
                    self.state = "failed"
                    self.error = f"the video took longer than {timeout_s:.0f} s after the audio"
                return
            self._thread.join(0.1)

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "progress": round(self.progress, 3), "error": self.error}


def _start_video(job: Job, src: Source, sdir: Path) -> None:
    """Gets the source's video under way: a library entry's own file at once, a link's on a thread
    (unless an earlier job already fetched it)."""
    if not _video_on() or find_video(sdir) is not None:
        return
    if src.kind == "library":
        v = state.store.library_video(src.path or "")
        if v is not None:
            try:
                info = state.backend.library_video(v, sdir)
            except JobError as e:
                log.info("no video for %s: %s", src.key, e)
                return
            (sdir / "video.json").write_text(json.dumps(info, indent=2), "utf-8")
    elif src.kind in VIDEO_KINDS:
        job.video = VideoFetch(src, sdir, job.cancel).start()


def _attach_video(job: Job, src: Source, sdir: Path, out: Path, timings: dict[str, float]) -> dict[str, Any]:
    """Waits for the video (stage ``video``), links it into the song and returns the meta fields."""
    if not _video_on():
        return {"has_video": False, "video": None, "video_error": "videos are off (SING_VIDEO=0)"}
    vf = job.video
    if vf is not None:
        if vf.running():
            _set(job, "video")
            t0 = time.perf_counter()
            vf.wait(env_float("SING_VIDEO_WAIT_S", 120.0), job.cancel)
            timings["video_wait_s"] = round(time.perf_counter() - t0, 2)
        if vf.seconds is not None:
            timings["video_s"] = vf.seconds
    for old in out.glob("video.*"):
        old.unlink(missing_ok=True)
    v = find_video(sdir)
    if v is None:
        why = vf.error if vf is not None else (
            "no video next to the library entry" if src.kind == "library" else "the source has no video")
        return {"has_video": False, "video": None, "video_error": why}
    link_or_copy(v, out / v.name)
    try:
        info = json.loads((sdir / "video.json").read_text("utf-8"))
    except (OSError, ValueError):
        info = {}
    return {"has_video": True, "video": {**info, "file": v.name}, "video_error": None}


def _take_gpu(job: Job) -> None:
    """Before the first GPU stage: the offload workers drop their models (once per job)."""
    urls = parse_urls(os.environ.get("SING_OFFLOAD_URLS"))
    if not urls or job.exclusive is not None:
        return
    job.exclusive = Exclusive(urls, state.offload_post, ack_wait_s=env_float("SING_EXCLUSIVE_WAIT_S", 30.0),
                              reload_timeout_s=env_float("SING_RELOAD_TIMEOUT_S", 300.0))
    stage = job.stage
    _set(job, "exclusive")
    job.exclusive.begin(job.cancel.is_set, job.go if job.request.exclusive_ack else None)
    job.stage = stage


def _give_gpu_back(job: Job) -> None:
    if job.exclusive is not None:
        job.exclusive.end()


def run_job(job: Job) -> None:
    try:
        _run_job(job)
    finally:
        if job.video is not None:
            job.video.stop()
        # The GPU child ends first: its CUDA context is VRAM the offloaded workers want back.
        # Also after a failure or a cancel; the job is only over once they are back.
        try:
            if job.gpu is not None:
                job.gpu.close()
        finally:
            _give_gpu_back(job)
        if job.exclusive is not None:
            job.exclusive.join()


def _run_job(job: Job) -> None:
    store, b, req = state.store, state.backend, job.request
    check = job.cancel.is_set
    timings: dict[str, float] = {}
    t_job = time.perf_counter()

    def timed(name: str, fn: Callable[[], Any]) -> Any:
        if check():
            raise Cancelled()
        _set(job, name)
        t0 = time.perf_counter()
        out = fn()
        timings[f"{name}_s"] = round(time.perf_counter() - t0, 2)
        return out

    src: Source = timed("resolve", lambda: _source_from_request(job))
    if req.title:
        src.title = req.title.strip()
    if req.artist:
        src.artist = req.artist.strip()
    job.source = src.public()
    sid = song_id(src.key, req.pitch, req.key)
    job.song_id = sid
    sdir = store.source_dir(src.key)
    cached = None if req.force else store.meta(sid)
    if cached is not None:
        job.cached = True
        if _needs_video(cached, src.kind):
            # Made before videos existed: fetch just the video.
            sdir.mkdir(parents=True, exist_ok=True)
            _start_video(job, src, sdir)
            cached.update(_attach_video(job, src, sdir, store.song_dir(sid), cached.setdefault("timings", {})))
            store.write_meta(sid, cached)
        if _needs_lyrics(cached):
            _refill_lyrics(sid, cached, req.query)
        return

    _peak_vram_reset()
    if gpu_child_on():
        job.gpu = GpuChild(os.environ.get("SING_GPU_CHILD_FACTORY", "engine:make_gpu_steps"))
        b = _GpuRouted(b, job.gpu)
    sdir.mkdir(parents=True, exist_ok=True)
    store.write_source_info(src)
    if req.force:
        for old in list(sdir.glob("video.*")):
            old.unlink(missing_ok=True)
    have_stems = (sdir / "vocals.wav").exists() and (sdir / "instrumental.wav").exists()
    redo = not have_stems or req.force
    if redo:
        if src.kind == "library":
            timed("download", lambda: b.fetch_library(src, sdir))
        elif not (sdir / "source.wav").exists() or req.force:
            timed("download", lambda: b.fetch(src, sdir / "source.wav", lambda f: _set(job, "download", f)))
    # Only after the audio download: bilibili answers HTTP 567 to both when two run at once. The
    # video still downloads next to the long stages (separate, convert).
    _start_video(job, src, sdir)
    if redo and not (src.kind == "library" and src.split):
        _take_gpu(job)
        timed("separate", lambda: b.separate(sdir / "source.wav", sdir / "vocals.wav", sdir / "instrumental.wav",
                                             lambda f: _set(job, "separate", f)))

    out = store.song_dir(sid)
    out.mkdir(parents=True, exist_ok=True)
    converted = out / "_converted.wav"

    def convert() -> dict[str, Any]:
        _take_gpu(job)
        try:
            return convert_on_gpu()
        finally:
            try:
                if job.gpu is not None:
                    job.gpu.close()
            finally:
                _give_gpu_back(job)

    def convert_on_gpu() -> dict[str, Any]:
        if req.pitch is not None:
            shift, auto_key, info = req.pitch, 0, {"auto": False, "octave_shift": None}
        else:
            # An explicit key is the requester's choice: only the octave stays automatic.
            shift, auto_key, info = _auto_shift(sdir, auto_key=req.key == 0, b=b)
            info["auto"] = True
        song_key = req.key + auto_key
        shift += song_key
        info.update({"vocal_shift": shift, "key": req.key, "auto_key": auto_key, "song_key": song_key,
                     "f0_clean": os.environ.get("SING_F0_CLEAN", "1") != "0",
                     "transposer": getattr(b, "transposer", None) if song_key else None})
        b.convert(sdir / "vocals.wav", converted, shift, lambda f: _set(job, "convert", f), check)
        return info

    pitch_info = timed("convert", convert)
    mixed = timed("mix", lambda: b.mix(sdir, converted, pitch_info["song_key"], out))
    converted.unlink(missing_ok=True)
    duration = mixed.get("duration_s") or src.duration_s
    found = timed("lyrics", lambda: b.lyrics(src, duration, req.query))
    lyrics_meta = _lyrics_meta(found, out)
    video = _attach_video(job, src, sdir, out, timings)
    timings["total_s"] = round(time.perf_counter() - t_job, 2)
    meta = {
        "id": sid,
        "title": src.title,
        "artist": src.artist,
        "duration_s": duration,
        "source": src.public(),
        "pitch": pitch_info,
        "lyrics": lyrics_meta,
        "lyrics_checked_at": time.time(),
        "lyrics_checks": 1,
        **video,
        "play": {"sample_rate": PLAY_RATE, "samples": mixed.get("samples"), "format": "s16le", "channels": 1},
        "mix": mixed,
        "engine": {"backend": b.name, "model": b.model_name, "device": b.device,
                   "diffusion_steps": env_int("SING_DIFFUSION_STEPS", 30)},
        "timings": timings,
        "peak_vram_mb": job.gpu.peak_vram_mb() if job.gpu is not None else _peak_vram_mb(),
        "created_at": now_iso(),
    }
    store.write_meta(sid, meta)
    log.info("song %s ready: %s (%s)", sid, src.title, timings)


def worker_loop() -> None:
    while not state.stopping.is_set():
        try:
            job_id = state.pending.get(timeout=0.5)
        except queue.Empty:
            continue
        job = state.jobs.get(job_id)
        if job is None or job.state != "queued":
            continue
        job.state, job.started_at = "running", now_iso()
        state.running = job.id
        try:
            run_job(job)
            job.state, job.progress, job.stage = "done", 1.0, "done"
        except Cancelled:
            job.state, job.error = "cancelled", "cancelled"
        except JobError as e:
            job.state, job.error = "failed", str(e)
            log.info("job %s failed: %s", job.id, e)
        except Exception as e:  # noqa: BLE001
            log.exception("job %s crashed", job.id)
            job.state, job.error = "failed", f"{type(e).__name__}: {e}"[:500]
            try:
                state.backend.unload()
            except Exception:  # noqa: BLE001
                pass
        finally:
            job.finished_at = now_iso()
            state.running = None


def _prune() -> None:
    with state.lock:
        while len(state.order) > MAX_JOBS_KEPT:
            old = next((j for j in state.order if state.jobs[j].state not in ("queued", "running")), None)
            if old is None:
                break
            state.order.remove(old)
            state.jobs.pop(old, None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    root = Path(os.environ.get("SING_DATA_DIR", REPO / "data" / "songs"))
    lib = os.environ.get("SING_LIBRARY_DIR")
    state.store = Store(root, Path(lib) if lib else None)
    state.jobs, state.order = {}, []
    state.pending = queue.Queue()
    state.lock = threading.Lock()
    state.refilling = set()
    state.stopping = threading.Event()
    t0 = time.perf_counter()
    state.backend = make_backend(state.store)
    log.info("backend %s ready in %.1fs (%s on %s), songs in %s", state.backend.name, time.perf_counter() - t0,
             state.backend.model_name, state.backend.device, root)
    state.thread = threading.Thread(target=worker_loop, name="sing-worker", daemon=True)
    state.thread.start()
    yield
    state.stopping.set()
    for j in state.jobs.values():
        j.cancel.set()


app = FastAPI(title="Miyoria song worker", lifespan=lifespan)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.exception_handler(StarletteHTTPException)
async def _http_exc(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    return _error(exc.status_code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def _validation_exc(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    return _error(400, f"invalid request: {where or 'body'}: {first.get('msg', 'bad value')}")


@app.post("/jobs")
async def submit(req: JobRequest) -> JSONResponse:
    given = [v for v in (req.query, req.url, req.path) if v and v.strip()]
    if len(given) != 1:
        return _error(400, "give exactly one of query, url or path")
    if req.url and not allowed_url(req.url.strip()):
        return _error(400, "that link is not on an allowed host (SING_URL_HOSTS)")
    job = Job(id=secrets.token_hex(6), request=req)
    # Cache hit without resolving: a known query / library path with the same pitch settings.
    if not req.force:
        key = None
        if req.query:
            key = state.store.query_source(req.query)
        sid = song_id(key, req.pitch, req.key) if key else None
        meta = state.store.meta(sid) if sid else None
        info = state.store.source_info(key or "") if meta is not None else None
        # (A song from before videos existed goes through the queue to get its video.)
        if meta is not None and not _needs_video(meta, (info or {}).get("kind")):
            job.state, job.stage, job.progress, job.cached = "done", "done", 1.0, True
            job.song_id, job.source, job.finished_at = sid, info, now_iso()
            if _needs_lyrics(meta):
                _refill_lyrics(sid, meta, req.query)
    with state.lock:
        state.jobs[job.id] = job
        state.order.append(job.id)
    if job.state == "queued":
        state.pending.put(job.id)
    _prune()
    return JSONResponse({"job": _public(job)})


@app.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    with state.lock:
        ids = list(reversed(state.order))
    return {"jobs": [_public(state.jobs[i]) for i in ids if i in state.jobs]}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    job = state.jobs.get(job_id)
    if job is None:
        return _error(404, f"no job {job_id}")
    return JSONResponse({"job": _public(job)})


@app.post("/jobs/{job_id}/exclusive")
async def exclusive_go(job_id: str) -> JSONResponse:
    job = state.jobs.get(job_id)
    if job is None:
        return _error(404, f"no job {job_id}")
    job.go.set()
    return JSONResponse({"job": _public(job)})


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str) -> JSONResponse:
    job = state.jobs.get(job_id)
    if job is None:
        return _error(404, f"no job {job_id}")
    if job.state == "queued":
        job.state, job.error, job.finished_at = "cancelled", "cancelled", now_iso()
    elif job.state == "running":
        job.cancel.set()
    return JSONResponse({"job": _public(job)})


@app.get("/songs")
async def list_songs() -> dict[str, Any]:
    return {"songs": state.store.songs()}


@app.get("/songs/{sid}")
async def get_song(sid: str) -> JSONResponse:
    meta = state.store.meta(safe_id(sid, 96))
    if meta is None:
        return _error(404, f"no song {sid}")
    return JSONResponse({"song": meta})


@app.get("/songs/{sid}/files/{name}")
async def get_file(sid: str, name: str):
    if name not in SONG_FILES:
        return _error(404, f"no file {name}")
    p = state.store.song_dir(safe_id(sid, 96)) / name
    if not p.exists():
        return _error(404, f"song {sid} has no {name}")
    headers = {"X-Sample-Rate": str(PLAY_RATE)} if name.endswith(".pcm") else {}
    media = SONG_FILES[name] + (f"; rate={PLAY_RATE}; channels=1" if name.endswith(".pcm") else "")
    return FileResponse(p, media_type=media, headers=headers)


@app.get("/library")
async def library() -> dict[str, Any]:
    return {"entries": state.store.library_entries()}


@app.get("/health")
async def health() -> dict[str, Any]:
    b = state.backend
    queued = sum(1 for j in state.jobs.values() if j.state == "queued")
    info: dict[str, Any] = {"status": "ok", "model": b.model_name, "device": b.device, "backend": b.name,
                            "busy": state.running is not None, "queued": queued}
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        info["vram_allocated_mb"] = round(torch.cuda.memory_allocated() / 2**20)
    return info


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8005")), log_level="info")


if __name__ == "__main__":
    main()
