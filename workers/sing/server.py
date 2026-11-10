"""Miyoria song worker: song requests → AI covers in her voice (docs/protocols/voice-link.md, 「歌曲 Worker」).

    POST   /jobs                {query | url | path, title?, artist?, pitch?, key?, backing?, force?, exclusive_ack?}
                                -> {"job"}
    POST   /jobs/{id}/exclusive -> {"job"}                 go ahead and take the GPU (see exclusive.py)
    POST   /gpu/context         {in_voice, listeners, live, urgent: [job id]} who would notice her
                                going quiet and which songs are needed now (Core, every poll; see gpu.py)
    GET    /jobs                -> {"jobs": [...]}         newest first
    GET    /jobs/{id}           -> {"job"}                 state, stage, progress, song when done
    DELETE /jobs/{id}           -> {"job"}                 cancels a queued or running job
    GET    /songs               -> {"songs": [meta...]}    cached covers, newest first
    GET    /songs/{id}          -> {"song": meta}
    POST   /songs/{id}/lyrics   {title?, artist?, fresh?} -> look the lyrics up again (no new audio)
    POST   /songs/{id}/lyrics   {title?, artist?, fresh?} -> look the lyrics up again (no new audio)
    GET    /songs/{id}/files/{name}   mix.wav · vocals.wav · instrumental.wav · lyrics.lrc ·
                                      play_mix.pcm · play_vocals.pcm (s16le mono 48 kHz) · meta.json ·
                                      video.mp4 (library: video.<ext>) when ``has_video``
    GET    /library             -> {"entries": [...]}      the owner's local song folder
    GET    /health

Pipeline per job (one job at a time; models load per stage and are freed after it):
    resolve   library match / yt-dlp search (``ytsearch1:``) / link (allowed hosts only), ≤ SING_MAX_SECONDS
    download  bestaudio → 44.1 kHz stereo WAV (ffmpeg)
    separate  vocals + instrumental: Kim's Mel-Band RoFormer (SING_SEPARATOR_MODEL=melband, the default
              when its checkpoint is there; the instrumental is the song minus the vocals) or a Demucs
              model (htdemucs, the fallback); only when the request needs them apart (``backing``
              ``drop`` / ``convert``) or the lead cannot come from the song itself; skipped for library
              folders that already have both stems, and for sources separated before
    lead      a karaoke RoFormer (leadsplit.py; SING_LEAD_MODEL, default becruily & Frazer's
              BS-RoFormer reading the whole song) takes the lead voice out; the rest of the vocal stem
              is the backing voices (harmonies, doubles, ad-libs). Stored beside the stems (lead.wav,
              backing.wav; cached with them, per model: stems.json; a song separated before it existed
              is split from its cached stems). Off with SING_LEAD_SPLIT=0 or without the model file (the
              stage is skipped and the next two work on the whole vocal stem, as before); a split that
              fails (not out of VRAM: that goes to the CPU) falls back to that as well, ``lead_split`` in
              the song's meta says which.
    convert   SING_VOICE, of the lead only: ``rvc`` (default) her own RVC model sings it in Applio's
              environment (rvcpass.py), moved by the shift below; or YingMusic-SVC (Seed-VC's architecture
              fine-tuned for singing) / the Seed-VC singing model (F0-conditioned, 44.1 kHz) with her
              reference voice, then (``+rvc``) her RVC model re-sings that (a failed pass keeps the
              converted vocal). With a clean lead RVC alone reads the words as well (2026-11-09). On a
              cleaned F0 contour (octave errors, spikes, dropouts: pitch.py); the pitch shift is
              ``pitch`` when given, else auto: the octave from the song's median and its top (95th
              percentile) against her range, and when the top is still over her ceiling the whole
              song goes down a few semitones (``auto_key``, SING_KEY_MIN..SING_KEY_MAX); plus
              ``key`` (whole-song transpose, which turns the auto key off)
    mix       converted vocal at the original lead's level + instrumental, and the backing voices by
              the request's ``backing`` (songs.BACKING_MODES, each a song of its own): ``keep``
              (default) as recorded, in the instrumental; ``drop``; ``convert``: converted like the
              lead (one more conversion), at their own level; ``acapella``: her lead alone, no
              instrumental. Without a lead split the backing stays in the converted vocal and only
              ``acapella`` changes anything (moved by the key with Rubber Band when ffmpeg has it), loudness-normalised to SING_TARGET_LUFS, peak ≤ -1 dBFS
    lyrics    synced LRC from lrclib.net / NetEase: title readings, the video metadata, a language model when those fail; checked against the audio (lyrics.py)
    video     (in parallel, from the download on) the link's video, video only, H.264 <= 1080p
              preferred, into video.mp4 for the stream to show while she sings; library entries
              use a video next to the audio. The song is ready once both are done; a video that
              fails or is still not there SING_VIDEO_WAIT_S after the audio leaves the song
              ready without one (``has_video: false``, ``video_error``). Songs cached before
              videos existed get theirs on the next request.

GPU: every GPU stage is placed from the state of the machine, and placed again while it runs (see
gpu.py, which has the rules; the job's ``gpu`` field and /health say what was decided and why). It
shares the card with her voice and gives way while she speaks (``exclusive: shared``, yielding.py),
waits for room (stage ``gpu_wait``), moves to the CPU, or, as the last resort and for a bounded time,
has the TTS / ASR workers of SING_OFFLOAD_URLS drop their models (exclusive.py: stage ``exclusive``
and the job's ``exclusive`` field, waiting · offloading · active · reloading · done, tell Core).

A finished song is cached under SING_DATA_DIR/<song id>; asking again (same query, link or file,
the same pitch settings and backing mode) answers at once with ``cached: true``.

Environment
    SING_BACKEND           seed-vc | mock                         (default seed-vc)
    SING_DATA_DIR          cache root                             (default <repo>/data/songs)
    SING_LIBRARY_DIR       local songs                            (default <data dir>/library)
    SING_LIBRARY_FIRST     1 = a query that matches a library entry uses it (default 1)
    SING_REF               her reference voice                    (default ../voices/deepseek-chan/ref.wav)
    SING_SEEDVC_DIR        Seed-VC checkout                       (default ../models/seed-vc)
    SING_DEVICE            cuda | cpu                             (default cuda when available)
    SING_SEPARATE_DEVICE   device of the separator                (default SING_DEVICE; VRAM OOM → CPU)
    SING_SEPARATOR_MODEL   melband | a Demucs model               (default melband when SING_VOCAL_MODEL is there,
                           else htdemucs; htdemucs_ft = better Demucs, 4x slower)
    SING_VOCAL_MODEL       the vocal RoFormer's checkpoint (.ckpt; its .yaml beside it)
                           (default ../models/vocal-split/MelBandRoformer.ckpt, KimberleyJSN/melbandroformer)
    SING_VOCAL_OVERLAP     chunk overlap of the vocal RoFormer, 8 s chunks (default 2)
    SING_LEAD_SPLIT        0 = no lead / backing split: the whole vocal stem is converted (default 1: on
                           when the model file is there)
    SING_LEAD_MODEL        the split's checkpoint (.ckpt; its .yaml beside it) (default
                           ../models/lead-split/becruily-bs/bs_roformer_karaoke_frazer_becruily.ckpt, else
                           ../models/lead-split/mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt)
    SING_LEAD_INPUT        mix | vocals: what the split reads    (default mix, the whole song)
    SING_LEAD_FP16         0 = the split in fp32 on CUDA          (default 1: fp16)
    SING_LEAD_DEVICE       device of the split                    (default SING_SEPARATE_DEVICE; VRAM OOM → CPU)
    SING_LEAD_OVERLAP      chunk overlap of the split, model-sized chunks (default 2; 2 on the CPU at most)
    SING_VOICE             rvc | ying+rvc | ying | seedvc+rvc | seedvc (default rvc; a missing part is left
                           out; cached songs made with another chain or lead split are made again)
    SING_YING_DIR          YingMusic-SVC checkout + ckpt/YingMusic-SVC-full.pt (default ../models/yingmusic-svc)
    SING_APPLIO_DIR / SING_RVC_MODEL / SING_RVC_INDEX / SING_RVC_PROTECT   the RVC pass (rvcpass.py)
    SING_DIFFUSION_STEPS   Seed-VC / YingMusic steps              (default 30)
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
    SING_VIDEO             0 = no videos                          (default 1)
    SING_VIDEO_MAX_HEIGHT  tallest video                          (default 1080)
    SING_VIDEO_MAX_MB      largest video                          (default 300)
    SING_VIDEO_WAIT_S      wait for the video after the audio     (default 120)
    SING_GPU_POLICY        auto | share | offload | wait           (default auto, see gpu.py)
    SING_GPU_SHARE         the older switch, used when SING_GPU_POLICY is not set: 1 = auto, 0 = offload
    SING_OFFLOAD_URLS      who can be asked to give up the GPU, comma separated (default none),
                           e.g. http://127.0.0.1:8002,http://127.0.0.1:8003
    SING_EXCLUSIVE_WAIT_S  wait this long for Core's go (exclusive_ack) (default 30)
    SING_SHARE_MIN_FREE_MB what a stage is assumed to need until it was measured here (default 4096)
    SING_GPU_HEADROOM_PCT  share of the card to keep free           (default 12; a spill raises it)
    SING_SHARE_WAIT_S      wait this long for room before taking speech offline, also with nobody
                           listening                                (default 0)
    SING_DEFER_S           people listening: wait this long before a short silence (default 120)
    SING_WAIT_MAX_S        longest wait for room in all; then windows, or the job fails (default 600)
    SING_SILENCE_MAX_S     longest she is offline at a time while people listen, reload included (default 90)
    SING_SILENCE_GAP_S     back this long before the next window    (default 60)
    SING_OFFLOAD_LEASE_S   a window renews its offload; a worker that died leaves her voice
                           offline this long at most               (default 60)
    SING_SPILL_FACTOR      slower than normal by this much is a spill (default 5)
    SING_SPILL_STEP_S      a spill when the normal step is not known yet (default 2; with little free VRAM)
    SING_DIFFUSION_STEPS_MIN  steps left when spilling with nothing else to free (default 20)
    SING_GPU_CHECK_S       how often a running job looks at the card (default 1)
    SING_CONTEXT_TTL_S     no word from Core for this long: nobody knows who listens (default 20)
    SING_YIELD_URLS        workers to give way to, comma separated  (default SING_OFFLOAD_URLS)
    SING_YIELD_POLL_MS     how often they are asked                 (default 100)
    SING_YIELD_HOLD_MS     stay out of the way this long after they are idle (default 300)
    SING_YIELD_MAX_S       give way at most this much per song that is needed now (default 120)
    SING_YIELD_PATIENT_S   the same for a song nobody is waiting for (default 900)
    SING_RESOLVE_TIMEOUT_S give up finding a song after this long (default 60)
    SING_YTDLP_CACHE       yt-dlp's cache folder                  (default <data dir>/_ytdlp-cache)
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
from typing import Any, Callable, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Cancelled, ConvertWork, JobError, Suspended, allowed_url, env_float, env_int, is_oom  # noqa: E402
from exclusive import Exclusive, http_post, parse_urls  # noqa: E402
from gpu import CPU_FALLBACK, CPU_STAGES, Action, Audience, GpuJob, Limits, Machine, Profile  # noqa: E402
from yielding import SpeechYield, http_get  # noqa: E402
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
WEIGHTS = {"resolve": 0.04, "download": 0.12, "exclusive": 0.0, "separate": 0.26, "lead": 0.08, "convert": 0.40, "mix": 0.07, "lyrics": 0.03,
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
        self.gate: Callable[[], None] | None = None
        self.step_s: Callable[[], float] | None = None  # how long a step takes (tests: a simulated card)
        self.separate_devices: list[str | None] = []
        self.lead_devices: list[str | None] = []
        self.convert_inputs: list[str] = []  # which stem each conversion read
        self.f0_inputs: list[str] = []
        self.mix_inputs: list[tuple[bool, list[str]]] = []  # (split, the files in the stem folder)
        self.mix_backing: list[str] = []
        self.lead_sources: list[str | None] = []
        self.trims = 0

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

    def free_vram_mb(self) -> int | None:
        raw = os.environ.get("SING_MOCK_FREE_MB")
        return int(raw) if raw else None

    def uses_cuda(self) -> bool:
        return bool(os.environ.get("SING_MOCK_FREE_MB")) or os.environ.get("SING_MOCK_DEVICE") == "cuda"

    def gpu_name(self) -> str:
        return "Mock GPU"

    def vram(self, peek: bool = False) -> tuple[int, int] | None:
        free = self.free_vram_mb()
        return None if free is None else (free, env_int("SING_MOCK_TOTAL_MB", free))

    def own_vram_mb(self) -> int:
        return 0

    def trim(self) -> None:
        self.trims += 1

    def idle(self) -> None:
        return None

    def fetch_library(self, src: Source, sdir: Path) -> None:
        self.fetch(src, sdir / "source.wav", lambda _: None)

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Callable[[float], None],
                 device: str | None = None) -> None:
        self._wait()
        self.separate_devices.append(device)
        for _ in range(env_int("SING_MOCK_SEGMENTS", 0)):
            self._step()
        _write_wav(vocals_out, _tone(self.seconds, 16_000, 440), 16_000)
        _write_wav(inst_out, _tone(self.seconds, 16_000, 220, 0.1), 16_000)

    def lead_available(self) -> bool:
        return os.environ.get("SING_LEAD_SPLIT", "1") != "0" and os.environ.get("SING_MOCK_LEAD_MODEL", "1") != "0"

    def split_lead(self, vocals_wav: Path, lead_out: Path, backing_out: Path, progress: Callable[[float], None],
                   device: str | None = None, source_wav: Path | None = None,
                   rest_out: Path | None = None) -> None:
        self._wait()
        self.lead_devices.append(device)
        self.lead_sources.append(source_wav.name if source_wav is not None else None)
        if os.environ.get("SING_MOCK_LEAD_FAIL") == "1":
            raise RuntimeError("mock lead split failed")
        for _ in range(env_int("SING_MOCK_SEGMENTS", 0)):
            self._step()
        _write_wav(lead_out, _tone(self.seconds, 16_000, 440, 0.2), 16_000)
        self.complete_stems(lead_out.parent)
        progress(1.0)

    def complete_stems(self, sdir: Path) -> None:
        if (sdir / "vocals.wav").exists() and not (sdir / "backing.wav").exists():
            _write_wav(sdir / "backing.wav", _tone(self.seconds, 16_000, 330, 0.1), 16_000)
        if (sdir / "source.wav").exists() and not (sdir / "rest.wav").exists():
            _write_wav(sdir / "rest.wav", _tone(self.seconds, 16_000, 220, 0.1), 16_000)

    def lead_reads_mix(self) -> bool:
        return True

    def median_f0(self, path: Path) -> float | None:
        return env_float("SING_MOCK_F0_HZ", 440.0)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        self.f0_inputs.append(path.name)
        return env_float("SING_MOCK_F0_HZ", 440.0), env_float("SING_MOCK_F0_TOP_HZ", 440.0)

    def ref_f0(self) -> float | None:
        return 440.0

    def _step(self) -> None:
        if self.gate is not None:
            self.gate()
        if self.step_s is not None:
            time.sleep(self.step_s())

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Callable[[float], None],
                cancelled: Callable[[], bool], work: ConvertWork | None = None) -> None:
        self.convert_inputs.append(vocals_wav.name)
        if os.environ.get("SING_MOCK_CONVERT_FAIL") == "1":
            raise JobError("mock conversion failed")
        job = state.jobs.get(state.running or "")
        window = job is not None and job.exclusive is not None and job.exclusive.state == "active"
        if os.environ.get("SING_MOCK_CONVERT_OOM") == "1" and not window:
            raise RuntimeError("CUDA out of memory (mock)")
        work = work if work is not None else ConvertWork()
        steps = env_int("SING_MOCK_STEPS", 4)
        for i in range(work.done, steps):
            self._step()
            if cancelled():
                raise Cancelled()
            self._wait()
            work.done = i + 1
            work.chunks.append(work.steps or 30)
            progress((i + 1) / steps)
        _write_wav(out_wav, _tone(self.seconds, 16_000, 440 * 2 ** (shift / 12)), 16_000)

    def mix(self, sdir: Path, converted: Path, key: int, out: Path, split: bool = False,
            backing: str = "keep", backing_conv: Path | None = None) -> dict[str, Any]:
        self._wait()
        self.mix_inputs.append((split, sorted(p.name for p in sdir.glob("*.wav"))))
        self.mix_backing.append(backing if backing_conv is None or backing_conv.exists() else "convert:missing")
        mix = _tone(self.seconds, PLAY_RATE, 440)
        vocals = _tone(self.seconds, PLAY_RATE, 440, 0.2)
        _write_wav(out / "mix.wav", mix, PLAY_RATE)
        _write_wav(out / "vocals.wav", vocals, PLAY_RATE)
        _write_wav(out / "instrumental.wav", _tone(self.seconds, PLAY_RATE, 220, 0.1), PLAY_RATE)
        (out / "play_mix.pcm").write_bytes(mix.tobytes())
        (out / "play_vocals.pcm").write_bytes(vocals.tobytes())
        return {"vocal_gain": 1.0, "lufs": -16.0, "samples": len(mix), "duration_s": round(len(mix) / PLAY_RATE, 2)}

    def lyrics(self, src: Source, duration: float | None, audio: Path | None = None,
               fresh: bool = False) -> dict[str, Any] | None:
        if os.environ.get("SING_LYRICS", "1") == "0":
            return None
        lines = [f"[00:{i:02d}.00]mock line {i + 1}" for i in range(max(1, int(self.seconds)))]
        return {"provider": "mock", "synced": True, "lrc": "\n".join(lines), "plain": None,
                "track": src.title, "artist": src.artist, "how": "mock", "confidence": 1.0}

    def lyrics_hints(self, url: str) -> dict[str, Any]:
        return {}

    def unload(self) -> None:
        return None


def make_backend(store: Store) -> Any:
    name = os.environ.get("SING_BACKEND", "seed-vc").lower()
    if name == "mock":
        return MockBackend(store)
    if name in ("seed-vc", "seedvc", "real"):
        from engine import MELBAND, RealBackend

        real = RealBackend(store)
        # Demucs' separation is only a little slower on the CPU: it goes there when the card is full.
        if real.separator != MELBAND and "SING_CPU_FALLBACK" not in os.environ:
            CPU_FALLBACK.add("separate")
        return _RealAdapter(real)
    raise RuntimeError(f"unknown SING_BACKEND={name!r} (expected seed-vc | mock)")


class _RealAdapter:
    """Gives ``RealBackend`` the same method shapes as the mock (paths in, files out)."""

    def __init__(self, b: Any) -> None:
        self.b = b
        self.name = b.name
        self.device = b.device
        self.model_name = b.model_name

    @property
    def gate(self) -> Callable[[], None] | None:
        return self.b.gate

    @gate.setter
    def gate(self, value: Callable[[], None] | None) -> None:
        self.b.gate = value

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

    def mix(self, sdir: Path, converted: Path, key: int, out: Path, split: bool = False,
            backing: str = "keep", backing_conv: Path | None = None) -> dict[str, Any]:
        """``split``: the lead was converted, the backing voices are beside it; ``backing`` says
        what becomes of them (songs.BACKING_MODES; ``backing_conv`` is the converted backing)."""
        from engine import mix_song

        # Kept backing (or none at all): everything but the lead in one, when the split left it.
        rest = sdir / "rest.wav"
        use_rest = split and backing in ("keep", "acapella") and rest.exists()
        return mix_song(sdir / ("lead.wav" if split else "vocals.wav"), converted,
                        rest if use_rest else sdir / "instrumental.wav", key, out,
                        self.b, env_float("SING_TARGET_LUFS", -16.0),
                        backing_wav=sdir / "backing.wav" if split and backing == "keep" and not use_rest else None,
                        backing_conv=backing_conv if split and backing == "convert" else None,
                        backing_src=sdir / "backing.wav" if split and backing == "convert" else None,
                        instrumental=backing != "acapella")

    def lyrics(self, src: Source, duration: float | None, audio: Path | None = None,
               fresh: bool = False) -> dict[str, Any] | None:
        """Lyrics for the song (lyrics.py: title readings, lrclib / NetEase, the language model, the checks)."""
        if os.environ.get("SING_LYRICS", "1") == "0":
            return None
        from lyrics import hints_of, search

        return search(hints_of(src), duration, cache_dir=self.b.store.root / "_lyrics", audio=audio, fresh=fresh)

    def lyrics_hints(self, url: str) -> dict[str, Any]:
        return self.b.fetch_hints(url)


# ── jobs ─────────────────────────────────────────────────────────────────────


class JobRequest(BaseModel):
    query: str | None = Field(None, max_length=200)
    url: str | None = Field(None, max_length=500)
    path: str | None = Field(None, max_length=300)
    title: str | None = Field(None, max_length=120)
    artist: str | None = Field(None, max_length=120)
    pitch: int | None = Field(None, ge=-24, le=24)
    key: int = Field(0, ge=-12, le=12)
    # The song's own backing voices (harmonies, chorus): songs.BACKING_MODES.
    backing: Literal["keep", "drop", "convert", "acapella"] = "keep"
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
    yielding: SpeechYield | None = None  # gives way to her voice
    gpu: GpuJob | None = None  # where the job runs and why (gpu.py)

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
            "yielded": self.yielding.public() if self.yielding else None,
            "gpu": self.gpu.public() if self.gpu else None,
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
    machine: Machine
    offload_post = staticmethod(http_post)  # replaced in tests
    busy_get = staticmethod(http_get)  # replaced in tests


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


def _bounded(fn: Callable[[], Any], cancelled: Callable[[], bool], limit_s: float) -> Any:
    """Runs a step that waits on the network on its own thread, so a lookup that never returns
    fails this job (or is cancelled) instead of holding the queue: jobs run one at a time, and
    yt-dlp's socket timeout does not cover every way it can hang. The thread is left behind."""
    done = threading.Event()
    out: dict[str, Any] = {}

    def run() -> None:
        try:
            out["value"] = fn()
        except BaseException as e:  # noqa: BLE001
            out["error"] = e
        finally:
            done.set()

    threading.Thread(target=run, name="sing-bounded", daemon=True).start()
    deadline = time.monotonic() + limit_s
    while not done.wait(0.1):
        if cancelled():
            raise Cancelled()
        if time.monotonic() >= deadline:
            raise JobError(f"finding the song took longer than {limit_s:.0f} s")
    if "error" in out:
        raise out["error"]
    return out["value"]


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


def _auto_shift(vocals: Path, auto_key: bool) -> tuple[int, int, dict[str, Any]]:
    """(octave −12 / 0 / +12 for her voice, whole-song key, info): the octave whose median lands
    closest to her singing median without the song's top going over her ceiling, and with
    ``auto_key`` a transposition down (or a little up) when the top is still out of her range."""
    from pitch import choose_key, parse_note

    b = state.backend
    stats = b.f0_stats(vocals)
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


def _other_voice(meta: dict[str, Any], backend: Any) -> bool:
    """A cached song made with another voice chain (SING_VOICE) than the worker's now: it is made
    again (from the cached stems). Songs from before the chain was recorded were Seed-VC alone."""
    voice = getattr(backend, "voice", None)
    if voice is None:
        return False
    engine = meta.get("engine") or {}
    if engine.get("voice", "seedvc") != voice:
        return True
    # Its separator: the last part of the model name ("ying+rvc+melband", "seed-vc-f0-44k+htdemucs").
    sep = _separator_of(backend)
    made = str(engine.get("model") or "").rsplit("+", 1)[-1]
    if sep is not None and made and made != sep:
        return True
    # Its lead split: a song whose lead came from another karaoke model is made again too.
    tag = _lead_tag_of(backend)
    used = (meta.get("lead_split") or {}).get("used", False)
    return tag is not None and bool(used) and (engine.get("lead") or LEGACY_LEAD) != tag


def _needs_stems(req: JobRequest, backend: Any) -> bool:
    """Whether this request needs the separated vocals and instrumental (see ``_run_job``)."""
    if req.backing in ("drop", "convert") or os.environ.get("SING_LEAD_SPLIT", "1") == "0":
        return True
    if not backend.lead_available():
        return True
    return not _lead_reads_mix(backend)


def _lead_reads_mix(backend: Any) -> bool:
    reads_mix = getattr(backend, "lead_reads_mix", None)
    return bool(reads_mix()) if callable(reads_mix) else True


def _separator_of(backend: Any) -> str | None:
    return getattr(backend, "separator", None)


def _lead_tag_of(backend: Any) -> str | None:
    return getattr(backend, "lead_tag", None)


STEMS_INFO = "stems.json"
# What made lead stems recorded before the model was (leadsplit.LEGACY_TAG).
LEGACY_LEAD = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956@vocals"


def _stems_info(sdir: Path) -> dict[str, Any]:
    try:
        info = json.loads((sdir / STEMS_INFO).read_text(encoding="utf-8"))
        return info if isinstance(info, dict) else {}
    except (OSError, ValueError):
        return {}


def _stems_separator(sdir: Path) -> str:
    """The separator that made a source's cached vocals / instrumental. Stems from before this was
    recorded were all made by htdemucs."""
    return str(_stems_info(sdir).get("separator") or "htdemucs")


def _stems_lead(sdir: Path) -> str:
    """What made the cached lead.wav / backing.wav (leadsplit.tag)."""
    return str(_stems_info(sdir).get("lead") or LEGACY_LEAD)


def _write_stems_info(sdir: Path, **fields: str | None) -> None:
    info = _stems_info(sdir)
    info.update({k: v for k, v in fields.items() if v is not None})
    if info:
        (sdir / STEMS_INFO).write_text(json.dumps(info), encoding="utf-8")


def _write_stems_separator(sdir: Path, separator: str | None) -> None:
    if separator is not None:
        # New vocals: the lead split from the old ones goes with them.
        info = {k: v for k, v in _stems_info(sdir).items() if k != "lead"}
        info["separator"] = separator
        (sdir / STEMS_INFO).write_text(json.dumps(info), encoding="utf-8")


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


def _offload_urls() -> list[str]:
    return parse_urls(os.environ.get("SING_OFFLOAD_URLS"))


def _urgent(job: Job) -> bool:
    """Core needs this song now, or one queued behind it (jobs run one at a time)."""
    urgent = state.machine.audience.urgent
    if job.id in urgent:
        return True
    with state.lock:
        return any(j in urgent and state.jobs[j].state == "queued" for j in state.order)


def _wav_seconds(p: Path) -> float | None:
    try:
        with wave.open(str(p), "rb") as w:
            return w.getnframes() / w.getframerate()
    except (OSError, EOFError, wave.Error):
        return None


def _start_gpu(job: Job, audio_s: float | None) -> None:
    job.gpu = GpuJob(state.machine, job.id, _offload_urls(), core_expected=job.request.exclusive_ack,
                     urgent=lambda: _urgent(job), audio_s=audio_s)
    urls = parse_urls(os.environ.get("SING_YIELD_URLS") or os.environ.get("SING_OFFLOAD_URLS"))
    job.yielding = SpeechYield(urls, state.busy_get, poll_s=env_int("SING_YIELD_POLL_MS", 100) / 1000,
                               hold_s=env_int("SING_YIELD_HOLD_MS", 300) / 1000,
                               max_s=job.gpu.yield_allowance()).start()


def _stage_uses_gpu(stage: str) -> bool:
    if stage not in CPU_STAGES:
        return True
    return getattr(state.backend, "lead_device" if stage == "lead" else "separate_device", "cuda") != "cpu"


def _open_window(job: Job) -> None:
    """Her voice goes offline: Core gets to let her say so, then the workers drop their models."""
    g, stage = job.gpu, job.stage
    assert g is not None
    job.go.clear()  # every window waits for its own go
    job.exclusive = Exclusive(_offload_urls(), state.offload_post, ack_wait_s=env_float("SING_EXCLUSIVE_WAIT_S", 30.0),
                              reload_timeout_s=env_float("SING_RELOAD_TIMEOUT_S", 300.0), max_s=g.offload_max_s())
    g.window_opening()
    job.stage = "exclusive"
    try:
        job.exclusive.begin(job.cancel.is_set, job.go if job.request.exclusive_ack else None)
    finally:
        job.stage = stage
    g.window_opened()


def _close_window(job: Job) -> None:
    """Her voice comes back, and the job waits for that: only then the card shows what is free."""
    ex, g = job.exclusive, job.gpu
    if ex is None or g is None or not g.window:
        return
    ex.end()
    ex.join()
    g.window_closed(ex.timings.get("reload_s"))


def _place(job: Job, stage: str) -> str:
    """``gpu`` or ``cpu``, once the stage may start: holds the job while it has to wait for room. A
    waiting job holds no VRAM, so it costs her nothing."""
    g = job.gpu
    assert g is not None
    try:
        while True:
            if job.cancel.is_set():
                raise Cancelled()
            d = g.decide(stage, _stage_uses_gpu(stage))
            if d.mode == "wait":
                job.stage = "gpu_wait"
                job.cancel.wait(g.limits.check_s)
                continue
            job.stage = stage
            if d.mode == "give_up":
                raise JobError(d.reason)
            if d.mode == "offload":
                _open_window(job)
            elif d.mode == "share" and (job.exclusive is None or job.exclusive.state != "shared"):
                job.exclusive = Exclusive([], state.offload_post)
                job.exclusive.share(g.facts.free_mb if g.facts else None)
            return "cpu" if d.mode == "cpu" else "gpu"
    finally:
        job.stage = stage
        g.wait_over()


def _act(job: Job, act: Action, work: ConvertWork | None) -> None:
    if act.kind == "trim":
        state.backend.trim()
    elif act.kind == "reduce":
        if work is not None and job.gpu is not None:
            work.steps = job.gpu.reduced_to
    elif act.kind == "offload":
        _open_window(job)
    else:
        raise Suspended(act.code)


def _arm(job: Job, stage: str, work: ConvertWork | None) -> None:
    """What runs before every diffusion step and separation segment: the time of the last one, her
    voice, and whether the job should still be running like this."""
    g, y, b = job.gpu, job.yielding, state.backend
    assert g is not None and y is not None

    def gate() -> None:
        if job.cancel.is_set():
            raise Cancelled()
        if g.device == "gpu":
            sync = getattr(b, "sync", None)
            if sync is not None:
                sync()
        g.step()
        if y.busy():
            y.max_s = g.yield_allowance()
            y.wait(job.cancel.is_set)
        act = g.tick(stage)
        if act is not None:
            _act(job, act, work)
        g.resume()

    b.gate = gate


def _gpu_stage(job: Job, stage: str, wav: Path, duration_s: float | None, run: Callable[[str], Any],
               work: ConvertWork | None = None) -> Any:
    """Runs a stage where the machine has room for it, again from where it was when it had to let
    go: ``run`` gets the device. The first one to run starts the job's GPU bookkeeping."""
    if job.gpu is None:
        _start_gpu(job, duration_s or _wav_seconds(wav))
    g = job.gpu
    assert g is not None
    resumed = False
    while True:
        device = _place(job, stage)
        _arm(job, stage, work)
        g.started(stage, device, resumed)
        try:
            out = run(device)
        except Suspended as e:
            log.info("job %s lets go of the GPU in %s: %s", job.id, stage, e.code)
            g.stopped()
        except Exception as e:
            if device == "cpu" or not is_oom(e):
                raise
            log.warning("job %s ran out of VRAM in %s", job.id, stage)
            g.stopped(oom=True)
        else:
            g.finished(stage)
            return out
        finally:
            state.backend.gate = None
        state.backend.unload()
        _close_window(job)
        resumed = True


def _give_gpu_back(job: Job) -> None:
    """Starts bringing her voice back; ``run_job`` waits for it. The song mixes meanwhile."""
    if job.yielding is not None:
        job.yielding.stop()
    state.backend.gate = None
    if job.exclusive is not None:
        job.exclusive.end()


def run_job(job: Job) -> None:
    try:
        _run_job(job)
    finally:
        if job.video is not None:
            job.video.stop()
        # Also after a failure or a cancel; the job is only over once they are back.
        _give_gpu_back(job)
        if job.exclusive is not None:
            job.exclusive.join()
        if job.gpu is not None:
            job.gpu.window_closed(job.exclusive.timings.get("reload_s") if job.exclusive else None)


def _lead_stage(job: Job, sdir: Path, src: Source, timed: Callable[[str, Callable[[], Any]], Any]) -> dict[str, Any]:
    """Splits the vocal stem into lead + backing when it should and can. Returns the song's
    ``lead_split`` info; ``used`` says whether the next stages work on the lead.

    Stems cached before the split existed are split on demand from their cached vocals (and
    kept: lead.wav / backing.wav sit beside them). A split that fails for any other reason than
    a cancel, the GPU being taken back (both end the job as for any stage) or running out of VRAM
    (``_gpu_stage`` redoes that on the CPU) leaves the plain pipeline in place, with the reason."""
    b = state.backend
    if os.environ.get("SING_LEAD_SPLIT", "1") == "0":
        return {"used": False, "reason": "off"}
    if not b.lead_available():
        return {"used": False, "reason": "no_model"}
    lead_wav, backing_wav, rest_wav = sdir / "lead.wav", sdir / "backing.wav", sdir / "rest.wav"
    tag = _lead_tag_of(b)
    if lead_wav.exists() and (tag is None or _stems_lead(sdir) == tag):
        b.complete_stems(sdir)  # what this request needs that an earlier one did not
        return {"used": True, "cached": True}
    source = sdir / "source.wav"

    def split(device: str) -> None:
        b.split_lead(sdir / "vocals.wav", lead_wav, backing_wav, lambda f: _set(job, "lead", f),
                     device="cpu" if device == "cpu" else None,
                     source_wav=source if source.exists() else None, rest_out=rest_wav)

    sized = source if source.exists() else sdir / "vocals.wav"
    try:
        timed("lead", lambda: _gpu_stage(job, "lead", sized, src.duration_s, split))
    except (Cancelled, Suspended):
        raise
    except Exception as e:
        log.warning("job %s: the lead split failed, converting the whole vocal stem: %s", job.id, e)
        for f in (lead_wav, backing_wav, rest_wav):
            f.unlink(missing_ok=True)
        return {"used": False, "reason": "failed", "error": str(e)[:300]}
    _write_stems_info(sdir, lead=tag)
    return {"used": True, "cached": False}


def _lyrics_meta(found: dict[str, Any] | None, out: Path, heard: Path | None = None) -> dict[str, Any] | None:
    """The song meta's ``lyrics`` for a lookup result, and ``lyrics.lrc`` written into ``out``.

    Besides what the player reads (``synced``, ``lines``, ``plain``) it says where the lyrics came from
    (``provider``, ``how``: metadata | title | llm), the song they were matched to (``track``, ``artist``),
    how sure the match is (``confidence`` 0..1, ``checks``) and when (``fetched_at``). Synced lines that
    are off by a constant amount against the singer's track ``heard`` are moved back (``offset_s``).
    """
    if not found:
        return None
    from lyrics import parse_lrc
    from lyrics_align import align, shift_lines

    lines = parse_lrc(found["lrc"]) if found.get("lrc") else []
    offset = align(heard, lines) if lines else 0.0
    if offset:
        log.info("lyrics moved by %+.2f s to meet the singing", offset)
        lines = shift_lines(lines, offset)
    lrc = out / "lyrics.lrc"
    if found.get("lrc"):
        lrc.write_text(found["lrc"], "utf-8")
    else:
        lrc.unlink(missing_ok=True)
    return {"provider": found["provider"], "synced": bool(lines), "track": found.get("track"),
            "artist": found.get("artist"), "lines": lines,
            "plain": None if lines else (found.get("plain") or "")[:4000],
            "how": found.get("how"), "confidence": found.get("confidence"), "matched": found.get("matched"),
            "checks": found.get("checks"), "llm": found.get("llm"), "tried": found.get("tried"),
            "offset_s": offset, "fetched_at": now_iso()}


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

    limit = env_float("SING_RESOLVE_TIMEOUT_S", 60.0)
    src: Source = timed("resolve", lambda: _bounded(lambda: _source_from_request(job), check, limit))
    if req.title:
        src.title = req.title.strip()
    if req.artist:
        src.artist = req.artist.strip()
    job.source = src.public()
    sid = song_id(src.key, req.pitch, req.key, req.backing)
    job.song_id = sid
    sdir = store.source_dir(src.key)
    cached = None if req.force else store.meta(sid)
    if cached is not None and _other_voice(cached, state.backend):
        cached = None
    if cached is not None:
        job.cached = True
        if _needs_video(cached, src.kind):
            # Made before videos existed: fetch just the video.
            sdir.mkdir(parents=True, exist_ok=True)
            _start_video(job, src, sdir)
            cached.update(_attach_video(job, src, sdir, store.song_dir(sid), cached.setdefault("timings", {})))
            store.write_meta(sid, cached)
        return

    _peak_vram_reset()
    sdir.mkdir(parents=True, exist_ok=True)
    store.write_source_info(src)
    if req.force:
        for old in list(sdir.glob("video.*")):
            old.unlink(missing_ok=True)
    _start_video(job, src, sdir)
    given_stems = src.kind == "library" and src.split  # a library folder with its own stems
    if req.force:
        derived = ["lead.wav", "backing.wav", "rest.wav", STEMS_INFO]
        if not given_stems:
            derived += ["vocals.wav", "instrumental.wav"]
        for stale in derived:
            (sdir / stale).unlink(missing_ok=True)
    have_stems = (sdir / "vocals.wav").exists() and (sdir / "instrumental.wav").exists()
    sep = _separator_of(b)
    if have_stems and sep is not None and not given_stems and _stems_separator(sdir) != sep:
        have_stems = False  # made by another separator: separate again with this one
        (sdir / "backing.wav").unlink(missing_ok=True)  # vocals - lead, of the old vocals
    if src.kind == "library":
        if req.force or not ((sdir / "source.wav").exists() or (given_stems and have_stems)):
            timed("download", lambda: b.fetch_library(src, sdir))
            have_stems = have_stems or given_stems
    elif req.force or not (sdir / "source.wav").exists():
        timed("download", lambda: b.fetch(src, sdir / "source.wav", lambda f: _set(job, "download", f)))

    def separate_stage() -> None:
        # New vocals: what was taken from the old ones goes (a lead read from the vocals, too).
        (sdir / "backing.wav").unlink(missing_ok=True)
        if not _lead_reads_mix(b):
            (sdir / "lead.wav").unlink(missing_ok=True)

        def separate(device: str) -> None:
            b.separate(sdir / "source.wav", sdir / "vocals.wav", sdir / "instrumental.wav",
                       lambda f: _set(job, "separate", f), device="cpu" if device == "cpu" else None)

        timed("separate", lambda: _gpu_stage(job, "separate", sdir / "source.wav", src.duration_s, separate))
        _write_stems_separator(sdir, _separator_of(b))

    # The vocals and instrumental apart are needed only to drop or convert the backing voices, or
    # when the lead comes from the vocals. Otherwise the lead comes from the song itself and the
    # rest of the song is everything else, so the separation (the stage that needs the most
    # VRAM) is skipped: the mix is the same to the sample.
    if not have_stems and not given_stems and _needs_stems(req, b):
        separate_stage()
    lead = _lead_stage(job, sdir, src, timed)
    if not lead["used"] and not (sdir / "vocals.wav").exists():
        separate_stage()  # no lead after all: the plain pipeline converts the vocals
    vocal = sdir / ("lead.wav" if lead["used"] else "vocals.wav")

    out = store.song_dir(sid)
    out.mkdir(parents=True, exist_ok=True)
    converted = out / "_converted.wav"

    work = ConvertWork()
    pitch: dict[str, Any] = {}

    def converted_share(f: float) -> None:
        _set(job, "convert", f)
        if job.gpu is not None:
            job.gpu.converted = f

    def convert() -> dict[str, Any]:
        try:
            return _gpu_stage(job, "convert", vocal, src.duration_s, convert_on_gpu, work)
        finally:
            _give_gpu_back(job)

    def convert_on_gpu(_device: str) -> dict[str, Any]:
        if not pitch:  # a conversion that was suspended keeps its key
            if req.pitch is not None:
                shift, auto_key, info = req.pitch, 0, {"auto": False, "octave_shift": None}
            else:
                # An explicit key is the requester's choice: only the octave stays automatic.
                shift, auto_key, info = _auto_shift(vocal, auto_key=req.key == 0)
                info["auto"] = True
            song_key = req.key + auto_key
            shift += song_key
            info.update({"vocal_shift": shift, "key": req.key, "auto_key": auto_key, "song_key": song_key,
                         "f0_clean": os.environ.get("SING_F0_CLEAN", "1") != "0",
                         "transposer": getattr(b, "transposer", None) if song_key else None})
            pitch.update(info)
        b.convert(vocal, converted, pitch["vocal_shift"], converted_share, check, work)
        return pitch

    pitch_info = timed("convert", convert)
    backing_conv: Path | None = None
    if req.backing == "convert" and lead["used"]:
        backing_conv = out / "_converted_backing.wav"
        backing_wav = sdir / "backing.wav"

        def convert_backing_on_gpu(_device: str) -> None:
            b.convert(backing_wav, backing_conv, pitch_info["vocal_shift"], converted_share, check, ConvertWork())

        def convert_backing() -> None:
            try:
                _gpu_stage(job, "convert", backing_wav, src.duration_s, convert_backing_on_gpu)
            finally:
                _give_gpu_back(job)

        timed("convert_backing", convert_backing)
    mixed = timed("mix", lambda: b.mix(sdir, converted, pitch_info["song_key"], out, lead["used"],
                                          req.backing, backing_conv))
    converted.unlink(missing_ok=True)
    if backing_conv is not None:
        backing_conv.unlink(missing_ok=True)
    duration = mixed.get("duration_s") or src.duration_s
    from lyrics import hints_of

    lyrics_input = hints_of(src)
    # the lead vocal (the original singer, before conversion) is what the ASR spot check listens to
    heard = next((p for p in (sdir / "lead.wav", sdir / "vocals.wav") if p.exists()), None)
    found = timed("lyrics", lambda: b.lyrics(src, duration, heard))
    lyrics_meta = _lyrics_meta(found, out, heard)
    from beats import beat_meta

    # her sway and nods follow the beat of what is actually played
    beats = timed("beats", lambda: beat_meta(out / "play_mix.pcm", PLAY_RATE))
    video = _attach_video(job, src, sdir, out, timings)
    timings["total_s"] = round(time.perf_counter() - t_job, 2)
    g = job.gpu
    if g is not None and g.waited_total_s:
        timings["gpu_wait_s"] = round(g.waited_total_s, 2)
    meta = {
        "id": sid,
        "title": src.title,
        "artist": src.artist,
        "duration_s": duration,
        "source": src.public(),
        "pitch": pitch_info,
        "lead_split": lead,
        # Without a split the backing voices stay in the converted vocal: only a split can drop them.
        "backing": req.backing if lead["used"] or req.backing == "acapella" else "in_vocal",
        "lyrics": lyrics_meta,
        "lyrics_input": lyrics_input,
        "beats": beats,
        **video,
        "play": {"sample_rate": PLAY_RATE, "samples": mixed.get("samples"), "format": "s16le", "channels": 1},
        "mix": mixed,
        "engine": {"backend": b.name, "model": b.model_name, "device": b.device,
                   "lead": _lead_tag_of(b) if lead["used"] else None,
                   "voice": getattr(b, "voice", None), "rvc_error": getattr(b, "rvc_error", None),
                   "diffusion_steps": env_int("SING_DIFFUSION_STEPS", 30)},
        "timings": timings,
        "peak_vram_mb": (g.peak_allocated_mb if g is not None else None) or _peak_vram_mb(),
        "gpu": g.summary() if g is not None else None,
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
        finally:
            job.finished_at = now_iso()
            state.running = None
            try:
                state.backend.idle()  # here: a job that failed no longer holds the models through its traceback
            except Exception:  # noqa: BLE001
                log.exception("could not let go of the models")


def _prune() -> None:
    with state.lock:
        while len(state.order) > MAX_JOBS_KEPT:
            old = next((j for j in state.order if state.jobs[j].state not in ("queued", "running")), None)
            if old is None:
                break
            state.order.remove(old)
            state.jobs.pop(old, None)


def _recover_speech() -> None:
    """A worker that went away mid-window (restarted, crashed) leaves her voice offline until it
    reloads by itself: bring it back as soon as this one is up."""
    for url in _offload_urls():
        try:
            health = state.busy_get(f"{url}/health", 2.0)
            if health.get("offloaded") and health.get("reason") == "sing":
                log.info("%s is still offloaded for a song; asking it back", url)
                state.offload_post(f"{url}/reload", {}, env_float("SING_RELOAD_TIMEOUT_S", 300.0))
        except Exception as e:  # noqa: BLE001 - it comes back by itself anyway
            log.info("cannot ask %s whether it is back: %s", url, e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    root = Path(os.environ.get("SING_DATA_DIR", REPO / "data" / "songs"))
    os.environ.setdefault("SING_YTDLP_CACHE", str(root / "_ytdlp-cache"))
    lib = os.environ.get("SING_LIBRARY_DIR")
    state.store = Store(root, Path(lib) if lib else None)
    state.jobs, state.order = {}, []
    state.pending = queue.Queue()
    state.lock = threading.Lock()
    state.stopping = threading.Event()
    t0 = time.perf_counter()
    state.backend = make_backend(state.store)
    log.info("backend %s ready in %.1fs (%s on %s), songs in %s", state.backend.name, time.perf_counter() - t0,
             state.backend.model_name, state.backend.device, root)
    state.machine = Machine(lambda: state.backend, Profile(root), Audience(),
                            lambda url, timeout: state.busy_get(url, timeout))
    threading.Thread(target=_recover_speech, name="sing-recover", daemon=True).start()
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
        sid = song_id(key, req.pitch, req.key, req.backing) if key else None
        meta = state.store.meta(sid) if sid else None
        info = state.store.source_info(key or "") if meta is not None else None
        # (A song from before videos existed goes through the queue to get its video.)
        if meta is not None and not _needs_video(meta, (info or {}).get("kind")) and not _other_voice(meta, state.backend):
            job.state, job.stage, job.progress, job.cached = "done", "done", 1.0, True
            job.song_id, job.source, job.finished_at = sid, info, now_iso()
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


class LyricsRequest(BaseModel):
    title: str | None = Field(None, max_length=200)  # the owner's own reading of the song, tried first
    artist: str | None = Field(None, max_length=200)
    fresh: bool = False  # ask the language model again instead of using its cached answer


@app.post("/songs/{sid}/lyrics")
def refetch_lyrics(sid: str, req: LyricsRequest | None = None) -> JSONResponse:
    """Look the lyrics of a cached song up again, without touching its audio.

    Uses the lookup input kept in the song's meta (``lyrics_input``; for a song made before that, the
    link's metadata is read again), then ``title`` / ``artist`` of the request as extra hints. A new result
    replaces ``lyrics`` in the meta and ``lyrics.lrc``; no result leaves what the song has. Blocks up to
    SING_LYRICS_BUDGET_S (45) seconds; the job queue is not involved.
    """
    req = req or LyricsRequest()
    sid = safe_id(sid, 96)
    meta = state.store.meta(sid)
    if meta is None:
        return _error(404, f"no song {sid}")
    b = state.backend
    src_info = meta.get("source") or {}
    hints: dict[str, Any] = dict(meta.get("lyrics_input") or {})
    if not hints.get("raw_title") and src_info.get("url"):
        try:
            hints = {**b.lyrics_hints(src_info["url"]), **hints}
        except Exception as e:
            log.info("lyrics hints for %s: %s", sid, e)
    hints.setdefault("key", src_info.get("key") or sid)
    hints.setdefault("title", meta.get("title") or src_info.get("title"))
    hints.setdefault("artist", meta.get("artist") or src_info.get("artist"))
    hints.setdefault("uploader", src_info.get("uploader"))
    if req.title:
        hints["title"], hints["track"] = req.title, req.title
        hints["artist"], hints["meta_artist"] = req.artist, req.artist
    src = Source(key=hints["key"], kind=str(src_info.get("kind") or "url"), title=str(hints.get("title") or ""),
                 artist=hints.get("artist"), duration_s=meta.get("duration_s"), url=src_info.get("url"),
                 uploader=hints.get("uploader"),
                 extra={k: hints[k] for k in ("raw_title", "track", "meta_artist", "alt_title", "description", "tags")
                        if k in hints})
    sdir = state.store.song_dir(sid)
    heard = next((p for p in (sdir / "lead.wav", sdir / "vocals.wav", state.store.source_dir(hints["key"]) / "lead.wav")
                  if p.exists()), None)
    found = b.lyrics(src, meta.get("duration_s"), heard, req.fresh)
    old = meta.get("lyrics")
    if not found:
        return JSONResponse({"found": False, "kept": bool(old), "lyrics": old and {k: v for k, v in old.items() if k != "lines"}})
    meta["lyrics"] = _lyrics_meta(found, sdir, heard)
    meta["lyrics_input"] = {k: v for k, v in hints.items() if v}
    state.store.write_meta(sid, meta)
    return JSONResponse({"found": True, "previous": {"provider": (old or {}).get("provider"),
                                                     "track": (old or {}).get("track")},
                         "lyrics": {k: v for k, v in meta["lyrics"].items() if k != "lines"},
                         "lines": len(meta["lyrics"]["lines"])})


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


class GpuContext(BaseModel):
    in_voice: bool = False
    listeners: int = Field(0, ge=0)
    live: bool = False
    urgent: list[str] = Field(default_factory=list, max_length=200)


@app.post("/gpu/context")
async def gpu_context(req: GpuContext) -> dict[str, Any]:
    state.machine.audience.update(req.in_voice, req.listeners, req.live, req.urgent)
    return {"ok": True}


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
    info["gpu"] = state.machine.public(Limits.from_env())
    job = state.jobs.get(state.running or "")
    info["gpu"]["job"] = job.gpu.public() if job is not None and job.gpu is not None else None
    return info


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # asks /busy several times a second while a job runs
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8005")), log_level="info")


if __name__ == "__main__":
    main()
