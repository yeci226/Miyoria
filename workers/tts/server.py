"""Miyoria TTS worker (Qwen3-TTS) — implements the "推論 Worker HTTP 介面" (docs/protocols/voice-link.md).

    POST /tts            JSON {text, language?, emotion?, instruct?, voice?, priority?}
                         -> 200 streamed raw PCM s16le mono, headers X-Sample-Rate, Content-Type
                            "audio/L16; rate=<sr>; channels=1", X-Tts-Queue-Ms (time spent waiting
                            for the GPU lock), X-Tts-First-Audio-Ms (queue + synthesis),
                            X-Tts-Reference (the reference clip used)
    GET  /health         -> {"status":"ok","model":...,"backend":...,"streaming":bool,"chunk_size":...}
    GET  /busy           -> {"busy": n} utterances being synthesized (the song worker yields to them)
    GET  /voices         -> registered voices
    POST /voices/reload  -> rescan VOICES_DIR (add a voice without restarting)
    POST /offload        JSON {reason?, max_s?, drain_s?} -> frees the GPU: new /tts and /voices calls
                         answer 503 {"error": "offloaded"} at once, utterances being synthesized get
                         up to ``drain_s`` (TTS_OFFLOAD_DRAIN_S) to finish, then the engine process
                         ends, which gives back everything it had on the card (see
                         ../engine_process.py). The answer says what the DEVICE gave back
                         (``released_mb``). ``max_s`` (TTS_OFFLOAD_MAX_S) is a lease: asking again
                         renews it, and it reloads by itself only when whoever asked stopped renewing
                         (that is, went away). Stops a reload that is under way instead of waiting
                         for it. Reloads by itself after the lease in case whoever asked never comes
                         back.
    POST /reload         -> loads the engine again (a full start: weights, CUDA graphs, voice priming)

OFFLOAD: the song worker borrows the whole GPU while it converts (12 GB cards: conversion next to TTS
    and ASR runs 10x slower). CUDA graphs are tied to the memory they were captured in, so the model
    cannot simply move to the CPU and back: offload deletes the engine and reload builds a new one.

BACKENDS (``TTS_BACKEND=faster|qwen-tts``; default: ``faster`` when `faster_qwen3_tts` is importable,
    otherwise ``qwen-tts``; the choice is logged and reported in /health):

    faster    community package `faster-qwen3-tts` (CUDA graphs): TRUE streaming. Every chunk the
              model yields (``TTS_CHUNK_SIZE`` codec steps, 12 steps = 1 s of audio) is sent as
              PCM immediately. Long input is still split into sentences (text_split.py) and the
              sentences are streamed one after another, each one chunk by chunk.
              Needs its own venv: it depends on `qwen-tts-hf`, which ships the same `qwen_tts`
              module as upstream `qwen-tts` — never install both (requirements-faster.txt).
    qwen-tts  official `qwen-tts` package, which documents no streaming API: SENTENCE-level
              streaming. Each sentence is synthesised whole and sent when ready; the next sentence
              is synthesised while the previous one is written to the socket. Time to first audio =
              latency of the FIRST sentence. At startup the model object is probed for stream-like
              methods; the result is logged and reported in /health ("stream_probe"), nothing found
              is ever called automatically.

    Generation runs in a worker thread and is bridged to the async response through an
    asyncio.Queue; it stops as soon as the client disconnects (checked between chunks). One GPU
    lock is held per sentence, so concurrent requests interleave at sentence boundaries. The lock
    is served in order: a request with ``priority: "now"`` (the line she is about to say) goes
    before ``"ahead"`` (lines synthesized in advance), first come first served within each.

VOICES: each voice is a directory ``$VOICES_DIR/<name>/`` with ``ref.wav`` + ``ref.txt`` (the
    transcript of ref.wav). At startup (Base model) every voice is registered: qwen-tts builds a
    reusable clone prompt (`create_voice_clone_prompt`); faster passes the same ref path + text on
    every call (the package caches the prompt per (path, text)) and primes that cache with one
    short synthesis. Directories ending in ``-candidates`` and names starting with ``.`` / ``_``
    are ignored. A voice without ref.txt falls back to speaker-embedding-only cloning (lower
    quality) and logs a warning.

    ``TTS_CLONE_MODE`` chooses how the reference is used:
    auto   ref.txt present -> ICL (the reference's codes continue into the line), otherwise x-vector.
    xvec   x-vector only, whatever files are there.
    icl    also reads ``ref.<lang>.txt``, which says which language ref.wav speaks: a line in that
           language uses ICL, any other language x-vector. ICL across languages is what made her
           voice jump between Japanese and Chinese, so a Chinese line never continues a Japanese clip.

EMOTION VOICE BANK (``TTS_VOICE_BANK=1``): ``$VOICES_DIR/<name>/bank/<lang>/<emotion>.wav`` + ``.txt``
    (design_voice.py bank). A request's language and emotion pick the clip: that emotion, else
    ``neutral`` of that language, else the plain reference above. A clip that fails to build or to
    synthesize is skipped until the next /voices/reload and the line is said with the plain
    reference, so a bad clip costs that emotion, not her voice.

INSTRUCT / EMOTION: only models with instruction control honour ``instruct``:
    mode ``clone`` (…-Base)        instruct and emotion are IGNORED (emotion = text semantics only)
    mode ``custom_voice``          ``voice`` = built-in speaker name, ``instruct`` is applied
    mode ``voice_design``          ``instruct`` is the voice description (a voice dir's optional
                                   ``instruct.txt`` is prepended as the base description)
    The mode is derived from the model id (Base / CustomVoice / VoiceDesign) or ``TTS_MODE``.
    ``emotion`` is informational: Miyoria sends the already-mapped ``instruct`` (from voice.toml).

Environment
    TTS_BACKEND            auto | faster | qwen-tts | mlx (default auto = faster if importable, else
                           qwen-tts; mlx = Apple silicon via mlx-audio, requirements-mlx.txt)
    TTS_MODEL              HF id or local dir            (default Qwen/Qwen3-TTS-12Hz-1.7B-Base;
                           mlx: mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16)
    TTS_MLX_INTERVAL       mlx only: seconds of audio per streamed chunk (default 0.32)
    TTS_MODE               auto | clone | custom_voice | voice_design   (default auto)
    TTS_CHUNK_SIZE         faster only: codec steps per streamed chunk (default 4 ≈ 333 ms of audio).
                           Smaller = earlier first audio but more decode calls per second of audio
                           and less margin against under-runs; 8 ≈ 667 ms, 12 = 1 s per chunk.
    TTS_WARMUP_PREFILL     faster only: prefill_len used to capture CUDA graphs (default 100)
    VOICES_DIR             voices directory              (default ./voices)
    TTS_DEFAULT_VOICE      used when the request has no `voice` (default: the only/first voice)
    TTS_DEVICE             device_map / device           (default cuda:0)
    TTS_ATTN               flash_attention_2 | sdpa | eager | default | auto (default auto)
    TTS_DEFAULT_LANGUAGE   when request has none         (default Auto)
    TTS_GEN_KWARGS         JSON merged into every generate_* call, e.g. {"temperature":0.8}
    TTS_MIN_SENTENCE_CHARS (default 4)   TTS_MAX_SENTENCE_CHARS (default 80)
    TTS_AHEAD_MAX_SENTENCE_CHARS  pieces of a ``priority: "ahead"`` line are at most this long
                           (default 40; 0 = TTS_MAX_SENTENCE_CHARS). The GPU lock is taken per piece,
                           so this bounds how long a line she needs now waits behind one for later
    TTS_CLONE_MODE         auto | xvec | icl             (default auto)
    TTS_VOICE_BANK         1 = pick a reference by language and emotion (default 0)
    TTS_MAX_TEXT_CHARS     reject longer requests (default 2000)
    TTS_MAX_SECONDS_PER_CHAR  audio cap per sentence: chars × this + 2 s (default 0.35). Sampling
                           sometimes misses the stop token and the model talks on for half a
                           minute in a drifting voice; the cap cuts that off. 0 = no cap
    TTS_POOL_SIZE          threads for synthesis calls (default 4; the GPU lock still serialises).
                           More than the prefetched lines, so a line she needs now never waits
                           for a thread behind lines that wait for the lock
    TTS_OFFLOAD_MAX_S      lease of an offload that does not name one: without a renewal it reloads
                           by itself after this long (default 900; 0 = never)
    TTS_ENGINE_PROCESS     0 = the model in this process: no child, and an offload that may not really
                           free the card (default 1)
    TTS_OFFLOAD_DRAIN_S    an offload lets running utterances finish for this long (default 15; 0 = stop
                           them at the next chunk). She finishes her sentence before the GPU goes
    HOST / PORT            bind address                  (default 127.0.0.1 / 8002)
"""

from __future__ import annotations

import asyncio
import gc
import heapq
import importlib.util
import inspect
import itertools
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from text_split import split_sentences

log = logging.getLogger("miyoria.tts")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    import device_memory
    from engine_process import EngineGone, EngineProcess, RemoteError
except ImportError:  # the Docker image holds this folder and contracts.py only: the model stays in this process
    device_memory = None
    EngineProcess = None

    class EngineGone(Exception):  # type: ignore[no-redef]
        pass

    class RemoteError(Exception):  # type: ignore[no-redef]
        pass

try:
    import service_auth
except ImportError:  # never run open: with a token set, no check means no service
    if os.environ.get("MIYORIA_SERVICE_TOKEN") or os.environ.get("MIYORIA_HOST_TOKEN"):
        raise SystemExit("MIYORIA_SERVICE_TOKEN or MIYORIA_HOST_TOKEN is set but service_auth.py cannot be "
                         "imported: refusing to start without the token check")
    service_auth = None

# The JSON bodies, generated from the JSON Schema of packages/contracts (gen_contracts.py).
from contracts import WorkersTtsOffloadRequest as OffloadRequest  # noqa: E402
from contracts import WorkersTtsRequest as TtsRequest  # noqa: E402

MAX_TEXT_CHARS = int(os.environ.get("TTS_MAX_TEXT_CHARS", "2000"))
MIN_CHARS = int(os.environ.get("TTS_MIN_SENTENCE_CHARS", "4"))
MAX_CHARS = int(os.environ.get("TTS_MAX_SENTENCE_CHARS", "80"))
# Lines synthesized ahead give the GPU lock back at every piece: a shorter piece is a shorter wait
# for the line she is about to say. 0 = the same pieces as any other line.
AHEAD_MAX_CHARS = int(os.environ.get("TTS_AHEAD_MAX_SENTENCE_CHARS", "40"))
MAX_SECONDS_PER_CHAR = float(os.environ.get("TTS_MAX_SECONDS_PER_CHAR", "0.35"))
# Qwen3-TTS-12Hz: 12 codec frames (= generated tokens) per second of audio.
TOKENS_PER_SECOND = 12


def max_new_tokens(text: str) -> int | None:
    """Token cap for one sentence (None = no cap): its characters × MAX_SECONDS_PER_CHAR + 2 s."""
    if MAX_SECONDS_PER_CHAR <= 0:
        return None
    chars = sum(1 for c in text if not c.isspace())
    return int((chars * MAX_SECONDS_PER_CHAR + 2.0) * TOKENS_PER_SECOND)

def ahead_max_chars() -> int:
    """The longest piece of a line synthesized ahead (never longer than any other line's)."""
    return min(AHEAD_MAX_CHARS, MAX_CHARS) if AHEAD_MAX_CHARS > 0 else MAX_CHARS


_LANG = {
    "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German",
    "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian",
}


_LANG_KEY = {name.lower(): code for code, name in _LANG.items()}


def language_key(language: str | None) -> str | None:
    """A language name or code ("Japanese", "ja-JP") -> the short code of the voice files, or None."""
    if not language:
        return None
    v = language.strip().lower().replace("_", "-").split("-")[0]
    if v in _LANG:
        return v
    return _LANG_KEY.get(v)


def to_tts_language(value: str | None) -> str:
    """Request language ("zh-TW", "Chinese", "ja", None) -> a Qwen3-TTS language name."""
    default = os.environ.get("TTS_DEFAULT_LANGUAGE", "Auto")
    if not value or not value.strip():
        return default
    v = value.strip()
    base = v.lower().replace("_", "-").split("-")[0]
    if base in _LANG:
        return _LANG[base]
    return v.title() if v.lower() != "auto" else "Auto"


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


# ── GPU lock ─────────────────────────────────────────────────────────────────

RANK_NOW = 0  # the line she is about to say
RANK_AHEAD = 1  # lines synthesized in advance


class GpuLock:
    """One generation on the GPU at a time, served by rank, then first come first served.

    `threading.Lock` picks a waiter at random: with lines being prefetched, the line she needs next
    could sit behind one she needs later. Used like a lock (rank RANK_NOW), or `with lock.hold(rank)`.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._held = False
        self._waiting: list[tuple[int, int]] = []
        self._tickets = itertools.count()

    def acquire(self, rank: int = RANK_NOW, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            ticket = (rank, next(self._tickets))
            heapq.heappush(self._waiting, ticket)
            try:
                while self._held or self._waiting[0] != ticket:
                    left = None if deadline is None else deadline - time.monotonic()
                    if left is not None and left <= 0:
                        return False
                    self._cond.wait(left)
                self._held = True
                return True
            finally:
                self._waiting.remove(ticket)
                heapq.heapify(self._waiting)
                self._cond.notify_all()

    def release(self) -> None:
        with self._cond:
            self._held = False
            self._cond.notify_all()

    def __enter__(self) -> "GpuLock":
        self.acquire()
        return self

    def __exit__(self, *_: object) -> None:
        self.release()

    @contextmanager
    def hold(self, rank: int) -> Iterator[None]:
        self.acquire(rank)
        try:
            yield
        finally:
            self.release()


class Activity:
    """Utterances being synthesized, whatever engine they run on (read by /busy and /offload)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.count = 0

    def begin(self) -> None:
        with self._lock:
            self.count += 1

    def end(self) -> None:
        with self._lock:
            self.count = max(0, self.count - 1)


activity = Activity()


# ── Engine ───────────────────────────────────────────────────────────────────


@dataclass(eq=False)
class Reference:
    """One clip to clone from. Without `text` only its speaker embedding is used (x-vector)."""

    key: str  # what it is called in logs and in X-Tts-Reference: ref, ref.ja, bank/ja/happy
    wav: Path
    text: str | None = None
    prompt: Any = None  # reusable clone prompt (qwen-tts)
    broken: bool = False  # failed once: skipped until the voices are reloaded


@dataclass
class Voice:
    name: str
    ref_wav: Path | None = None
    ref_text: str | None = None
    prompt: Any = None  # reusable clone prompt (qwen-tts, clone mode)
    base_instruct: str = ""  # voice_design mode: description prepended to the request's instruct
    x_vector_only: bool = False
    plain: Reference | None = None  # ref.wav as ever: the last resort of every line
    by_language: dict[str, Reference] = field(default_factory=dict)  # ref.<lang>.txt, TTS_CLONE_MODE=icl
    bank: dict[tuple[str, str], Reference] = field(default_factory=dict)  # (language code, emotion)

    def references(self) -> list[Reference]:
        extra = [*self.by_language.values(), *self.bank.values()]
        return ([self.plain] if self.plain else []) + extra


def _as_array(w: Any):
    """float / ndarray / torch tensor (any shape) -> flat ndarray; integer dtypes are kept."""
    import numpy as np

    if hasattr(w, "detach"):  # torch tensor (bfloat16 has no .numpy(), so go through float32)
        w = w.detach().float().cpu().numpy()
    return np.asarray(w).reshape(-1)


def _to_numpy(w: Any):
    import numpy as np

    return _as_array(w).astype(np.float32, copy=False)


def _to_pcm16(w: Any) -> bytes:
    """float [-1, 1] (clipped) or int16 samples -> little-endian s16 bytes."""
    import numpy as np

    arr = _as_array(w)
    if arr.dtype == np.int16:
        return arr.astype("<i2").tobytes()
    f = np.nan_to_num(arr.astype(np.float32, copy=False), nan=0.0, posinf=1.0, neginf=-1.0)
    return (np.clip(f, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _resolve_attn() -> str:
    attn = os.environ.get("TTS_ATTN", "auto")
    if attn == "auto":
        attn = "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"
    return attn


class BaseEngine:
    """Voices, mode and request resolution shared by both backends.

    Subclasses implement `_load_model`, `_load_voice` and `stream`. `stream()` is a BLOCKING
    generator of (waveform, sample_rate) pieces; the caller holds `self.lock` while it runs.
    """

    backend = ""
    streaming = False  # True when audio is delivered chunk by chunk inside one sentence
    chunk_size: int | None = None

    def __init__(self) -> None:
        self.model_id = os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        self.device = os.environ.get("TTS_DEVICE", "cuda:0")
        self.mode = self._detect_mode(self.model_id)
        self.clone_mode = self._detect_clone_mode()
        self.voice_bank = os.environ.get("TTS_VOICE_BANK", "0") == "1"
        self.lock = GpuLock()  # one generation on the GPU at a time (per sentence)
        self.voices: dict[str, Voice] = {}
        self.sample_rate = 0
        self.stream_probe: list[str] = []
        self.gen_kwargs: dict[str, Any] = json.loads(os.environ.get("TTS_GEN_KWARGS", "{}") or "{}")
        self.closed = False  # offloaded: the model is gone, nothing may run on it any more
        # An offload is under way: running requests stop at the next chunk, waiting ones never start.
        self.stopping = False
        self._load_model()
        self.reload_voices()
        self._warmup()

    def close(self) -> None:
        """Drops the model and everything on the GPU (offload). Waits for the running sentence."""
        with self.lock:
            self.closed = True
            self.model = None
            self.voices = {}

    def stream_audio(self, text: str, language: str, voice: str | None, instruct: str,
                     emotion: str | None) -> Iterator[tuple[Any, int]]:
        """`stream` for the other end of a pipe: arrays, not CUDA tensors."""
        extra = {"emotion": emotion} if emotion else {}
        for wav, sr in self.stream(text, language, voice, instruct, **extra):
            yield _as_array(wav), int(sr)

    def reload_and_describe(self) -> dict[str, Any]:
        self.reload_voices()
        return describe_engine(self)

    # -- backend hooks -------------------------------------------------------

    def _load_model(self) -> None:
        raise NotImplementedError

    def _load_voice(self, d: Path) -> Voice | None:
        raise NotImplementedError

    def stream(self, text: str, language: str, voice: str | None, instruct: str) -> Iterator[tuple[Any, int]]:
        raise NotImplementedError

    # -- setup ---------------------------------------------------------------

    @staticmethod
    def _detect_clone_mode() -> str:
        mode = os.environ.get("TTS_CLONE_MODE", "auto").strip().lower()
        if mode not in ("auto", "xvec", "icl"):
            raise RuntimeError(f"bad TTS_CLONE_MODE={mode!r} (expected auto | xvec | icl)")
        return mode

    @staticmethod
    def _detect_mode(model_id: str) -> str:
        mode = os.environ.get("TTS_MODE", "auto").lower()
        if mode != "auto":
            if mode not in ("clone", "custom_voice", "voice_design"):
                raise RuntimeError(f"bad TTS_MODE={mode!r}")
            return mode
        m = model_id.lower().replace("-", "").replace("_", "")
        if "customvoice" in m:
            return "custom_voice"
        if "voicedesign" in m:
            return "voice_design"
        return "clone"

    def reload_voices(self) -> None:
        voices_dir = Path(os.environ.get("VOICES_DIR", "voices"))
        found: dict[str, Voice] = {}
        self._before_reload()
        if voices_dir.is_dir():
            for d in sorted(p for p in voices_dir.iterdir() if p.is_dir()):
                if d.name.startswith((".", "_")) or d.name.endswith("-candidates"):
                    continue
                try:
                    v = self._load_voice(d)
                except Exception:
                    log.exception("voice %r skipped", d.name)
                    continue
                if v:
                    found[v.name] = v
        elif self.mode == "clone":
            log.warning("VOICES_DIR %s does not exist — no voices registered", voices_dir)
        with self.lock:
            self.voices = found
        log.info("voices: %s", ", ".join(found) or "(none)")

    def _before_reload(self) -> None:
        pass

    def _read_voice_files(self, d: Path) -> tuple[Path, str, str]:
        """-> (ref.wav path, ref.txt text or "", instruct.txt text or "")."""
        ref_wav, ref_txt, inst = d / "ref.wav", d / "ref.txt", d / "instruct.txt"
        base_instruct = inst.read_text(encoding="utf-8").strip() if inst.exists() else ""
        text = ref_txt.read_text(encoding="utf-8").strip() if ref_txt.exists() else ""
        if self.clone_mode == "xvec":
            text = ""
        elif not text and ref_wav.exists():
            log.warning("voice %r has no ref.txt — using speaker embedding only (x_vector_only_mode); "
                        "add the transcript for better quality", d.name)
        return ref_wav, text, base_instruct

    def _extra_references(self, v: Voice, d: Path) -> None:
        """ref.<lang>.txt (TTS_CLONE_MODE=icl) and the emotion bank (TTS_VOICE_BANK=1) of voice dir `d`."""
        if self.clone_mode == "icl" and v.ref_wav is not None:
            for path in sorted(d.glob("ref.*.txt")):
                code = language_key(path.name.split(".")[1])
                text = path.read_text(encoding="utf-8").strip()
                if code and text:
                    v.by_language[code] = Reference(f"ref.{code}", v.ref_wav, text)
        if self.voice_bank and self.clone_mode != "xvec":
            for wav in sorted((d / "bank").glob("*/*.wav")):
                code = language_key(wav.parent.name)
                txt = wav.with_suffix(".txt")
                if not code or not txt.exists():
                    log.warning("voice %r: bank clip %s skipped (needs <lang>/<emotion>.wav + .txt)", d.name, wav)
                    continue
                text = txt.read_text(encoding="utf-8").strip()
                if text:
                    v.bank[(code, wav.stem.lower())] = Reference(f"bank/{code}/{wav.stem.lower()}", wav, text)
        if v.by_language or v.bank:
            log.info("voice %r: extra references %s", d.name,
                     ", ".join(r.key for r in [*v.by_language.values(), *v.bank.values()]))

    @staticmethod
    def reference_chain(v: Voice, language: str, emotion: str | None) -> list[Reference]:
        """The references to try for a line, best first; the last one is the plain reference."""
        code = language_key(language)
        chain: list[Reference] = []
        if code is not None:
            mood = (emotion or "").strip().lower()
            for r in (v.bank.get((code, mood)), v.bank.get((code, "neutral")), v.by_language.get(code)):
                if r is not None and not r.broken and r not in chain:
                    chain.append(r)
        return chain + ([v.plain] if v.plain is not None else [])

    def _clone_attempts(self, v: Voice, language: str, emotion: str | None,
                        make: Any) -> Iterator[tuple[Any, int]]:
        """Runs `make(reference)` (a generator of audio) along the chain: a reference that fails
        before its first audio is marked broken and the next one takes over."""
        chain = self.reference_chain(v, language, emotion)
        for i, ref in enumerate(chain):
            started = False
            try:
                for piece in make(ref):
                    started = True
                    yield piece
                return
            except Exception:
                if started or i == len(chain) - 1:
                    raise
                ref.broken = True
                log.exception("voice %r: reference %s failed, going on with %s", v.name, ref.key, chain[i + 1].key)

    def reference_key(self, voice: str | None, language: str, emotion: str | None) -> str:
        """The reference a line would use now (the X-Tts-Reference header), "" outside clone mode."""
        if self.mode != "clone":
            return ""
        v = self.resolve_voice(voice)
        chain = self.reference_chain(v, language, emotion) if v is not None else []
        return chain[0].key if chain else ""

    def _warmup(self) -> None:
        """One short synthesis: warms CUDA kernels and tells us the output sample rate."""
        try:
            default = self.resolve_voice(None)
        except ApiError:
            default = None
        if self.mode == "clone" and default is None:
            log.warning("no voice available — skipping warm-up; sample rate unknown until the first request")
            self.sample_rate = self.sample_rate or int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
            return
        t0 = time.perf_counter()
        fallback_instruct = "" if self.mode != "voice_design" else "清晰自然的年輕女聲"
        try:
            _, self.sample_rate = self.synth("你好。", "Chinese", default.name if default else None, fallback_instruct)
        except Exception:
            log.exception("warm-up failed — assuming TTS_SAMPLE_RATE (default 24000)")
            self.sample_rate = self.sample_rate or int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
            return
        log.info("warm-up %.0f ms, sample rate %d Hz", (time.perf_counter() - t0) * 1000, self.sample_rate)

    # -- request-time --------------------------------------------------------

    def resolve_voice(self, name: str | None) -> Voice | None:
        if self.mode == "custom_voice":  # `voice` is a built-in speaker name; pass it through
            n = name or os.environ.get("TTS_DEFAULT_VOICE") or next(iter(self.voices), None)
            if not n:
                raise ApiError(400, "custom_voice mode needs `voice` (a built-in speaker name)")
            return self.voices.get(n) or Voice(n)
        if self.mode == "voice_design":
            n = name or os.environ.get("TTS_DEFAULT_VOICE")
            return self.voices.get(n) if n and n in self.voices else (Voice(n) if n else None)
        # clone
        n = name or os.environ.get("TTS_DEFAULT_VOICE") or (next(iter(self.voices)) if len(self.voices) == 1 else None)
        if n is None:
            if not self.voices:
                raise ApiError(503, "no voices registered — put <name>/ref.wav + ref.txt in VOICES_DIR")
            raise ApiError(400, f"`voice` required (available: {', '.join(self.voices)})")
        v = self.voices.get(n)
        if v is None:
            raise ApiError(404, f"unknown voice {n!r} (available: {', '.join(self.voices) or 'none'})")
        return v

    @staticmethod
    def _design_instruct(v: Voice | None, instruct: str) -> str:
        desc = "\n".join(s for s in ((v.base_instruct if v else ""), instruct) if s)
        if not desc:
            raise ApiError(400, "voice_design mode needs `instruct` (voice description) or a voice's instruct.txt")
        return desc

    def synth(self, text: str, language: str, voice: str | None, instruct: str) -> tuple[Any, int]:
        """Blocking, GPU-serialised, whole utterance (used by warm-up). -> (float32 mono, sample_rate)."""
        import numpy as np

        parts: list[Any] = []
        sr = 0
        with self.lock:
            for wav, sr in self.stream(text, language, voice, instruct):
                parts.append(_to_numpy(wav))
        if not parts:
            raise RuntimeError("model produced no audio")
        return (parts[0] if len(parts) == 1 else np.concatenate(parts)), int(sr)


class QwenTtsEngine(BaseEngine):
    """Official `qwen-tts` package — whole-sentence synthesis (no streaming API)."""

    backend = "qwen-tts"

    def _load_model(self) -> None:
        import torch  # type: ignore
        from qwen_tts import Qwen3TTSModel  # type: ignore

        attn = _resolve_attn()
        kw: dict[str, Any] = dict(device_map=self.device, dtype=torch.bfloat16)
        if attn != "default":
            kw["attn_implementation"] = attn
        log.info("loading %s with qwen-tts (mode=%s attn=%s) …", self.model_id, self.mode, attn)
        self.model = Qwen3TTSModel.from_pretrained(self.model_id, **kw)
        self.stream_probe = self._probe_streaming()

    def _probe_streaming(self) -> list[str]:
        """List stream-like members of the installed qwen-tts. Informational only — never called."""
        found = [n for n in dir(self.model) if "stream" in n.lower() and not n.startswith("_")]
        for fn in ("generate_voice_clone", "generate_custom_voice", "generate_voice_design"):
            f = getattr(self.model, fn, None)
            if f is None:
                continue
            try:
                found += [f"{fn}({p}=…)" for p in inspect.signature(f).parameters if "stream" in p.lower()]
            except (TypeError, ValueError):
                pass
        if found:
            log.warning("qwen-tts exposes stream-like API %s — NOT used (unverified); staying sentence-level", found)
        else:
            log.info("qwen-tts has no streaming API; using sentence-level streaming")
        return found

    def _load_voice(self, d: Path) -> Voice | None:
        ref_wav, text, base_instruct = self._read_voice_files(d)
        if self.mode != "clone":
            return Voice(d.name, base_instruct=base_instruct)
        if not ref_wav.exists():
            log.warning("voice %r has no ref.wav — skipped", d.name)
            return None
        x_only = not text
        t0 = time.perf_counter()
        v = Voice(d.name, ref_wav, text or None, None, base_instruct, x_only)
        v.plain = Reference("ref", ref_wav, text or None)
        self._extra_references(v, d)
        for ref in v.references():
            try:
                self._build_prompt(ref)
            except Exception:
                if ref is v.plain:
                    raise
                ref.broken = True
                log.exception("voice %r: reference %s skipped", d.name, ref.key)
        v.prompt = v.plain.prompt
        log.info("voice %r: clone prompt built in %.0f ms", d.name, (time.perf_counter() - t0) * 1000)
        return v

    def _build_prompt(self, ref: Reference) -> None:
        with self.lock:
            ref.prompt = self.model.create_voice_clone_prompt(
                ref_audio=str(ref.wav), ref_text=ref.text, x_vector_only_mode=ref.text is None
            )

    def _clone(self, ref: Reference, text: str, language: str, kw: dict[str, Any]) -> Iterator[tuple[Any, int]]:
        wavs, sr = self.model.generate_voice_clone(text=text, language=language, voice_clone_prompt=ref.prompt, **kw)
        yield _to_numpy(wavs[0]), int(sr)

    def stream(self, text: str, language: str, voice: str | None, instruct: str,
               emotion: str | None = None) -> Iterator[tuple[Any, int]]:
        v = self.resolve_voice(voice)
        kw = dict(self.gen_kwargs)
        if self.mode == "clone":
            assert v is not None
            yield from self._clone_attempts(v, language, emotion, lambda ref: self._clone(ref, text, language, kw))
            return
        if self.mode == "custom_voice":
            assert v is not None
            extra = {"instruct": instruct} if instruct else {}
            wavs, sr = self.model.generate_custom_voice(text=text, language=language, speaker=v.name, **extra, **kw)
        else:  # voice_design
            wavs, sr = self.model.generate_voice_design(
                text=text, language=language, instruct=self._design_instruct(v, instruct), **kw
            )
        yield _to_numpy(wavs[0]), int(sr)


class FasterEngine(BaseEngine):
    """Community `faster-qwen3-tts` — CUDA graphs + real chunk streaming.

    API used (confirmed against the faster-qwen3-tts 0.5.4 source, not yet run on a GPU):
    ``FasterQwen3TTS.from_pretrained(name, device=, attn_implementation=)``, ``.warmup(prefill_len=)``,
    ``.sample_rate``, ``generate_voice_clone_streaming / generate_custom_voice_streaming /
    generate_voice_design_streaming(..., chunk_size=)`` yielding ``(audio_chunk, sr, timing)``, and the
    non-streaming ``generate_*`` returning ``(list_of_waveforms, sr)``.
    """

    backend = "faster"

    # mode -> (streaming method, whole-utterance fallback)
    _METHODS = {
        "clone": ("generate_voice_clone_streaming", "generate_voice_clone"),
        "custom_voice": ("generate_custom_voice_streaming", "generate_custom_voice"),
        "voice_design": ("generate_voice_design_streaming", "generate_voice_design"),
    }

    def _load_model(self) -> None:
        from faster_qwen3_tts import FasterQwen3TTS  # type: ignore

        self.chunk_size = int(os.environ.get("TTS_CHUNK_SIZE", "4"))
        if self.chunk_size < 1:
            raise RuntimeError(f"bad TTS_CHUNK_SIZE={self.chunk_size} (must be >= 1)")
        self._warn_if_upstream_installed()
        attn = _resolve_attn()
        kw: dict[str, Any] = dict(device=self.device)
        if attn != "default":
            kw["attn_implementation"] = attn
        log.info("loading %s with faster-qwen3-tts (mode=%s attn=%s chunk_size=%d ≈ %.0f ms of audio/chunk) …",
                 self.model_id, self.mode, attn, self.chunk_size, self.chunk_size / 12 * 1000)
        self.model = FasterQwen3TTS.from_pretrained(self.model_id, **kw)
        t0 = time.perf_counter()
        self.model.warmup(prefill_len=int(os.environ.get("TTS_WARMUP_PREFILL", "100")))
        log.info("CUDA graphs captured in %.1f s", time.perf_counter() - t0)
        streaming_name, plain_name = self._METHODS[self.mode]
        self.streaming = callable(getattr(self.model, streaming_name, None))
        if not self.streaming:
            log.warning("model has no %s — falling back to whole-sentence %s", streaming_name, plain_name)
        self.stream_probe = [n for n in dir(self.model) if "stream" in n.lower() and not n.startswith("_")]
        rate = getattr(self.model, "sample_rate", 0)
        if isinstance(rate, int) and rate > 0:
            self.sample_rate = rate

    @staticmethod
    def _warn_if_upstream_installed() -> None:
        try:
            from importlib import metadata

            metadata.version("qwen-tts")
        except Exception:
            return
        log.warning("both `qwen-tts` and faster-qwen3-tts's `qwen-tts-hf` are installed; they provide the same "
                    "`qwen_tts` module and conflict — use a separate venv (requirements-faster.txt)")

    def _before_reload(self) -> None:
        # The package caches clone prompts per (ref path, ref text, ...); a re-picked ref.wav at the same
        # path would otherwise be served stale. `_voice_prompt_cache` is private: cleared only if present.
        cache = getattr(self.model, "_voice_prompt_cache", None)
        if isinstance(cache, dict):
            cache.clear()

    def _load_voice(self, d: Path) -> Voice | None:
        ref_wav, text, base_instruct = self._read_voice_files(d)
        if self.mode != "clone":
            return Voice(d.name, base_instruct=base_instruct)
        if not ref_wav.exists():
            log.warning("voice %r has no ref.wav — skipped", d.name)
            return None
        v = Voice(d.name, ref_wav, text or None, None, base_instruct, not text)
        v.plain = Reference("ref", ref_wav, text or None)
        self._extra_references(v, d)
        # Prime the package's prompt cache (otherwise built on first use) so the first request is fast.
        t0 = time.perf_counter()
        for ref in v.references():
            try:
                with self.lock:
                    for _, sr in self._clone(ref, "你好。", "Chinese", self._kwargs("你好。")):
                        self.sample_rate = int(sr)
            except Exception:
                ref.broken = ref is not v.plain
                log.exception("voice %r: priming %s failed (%s)", d.name, ref.key,
                              "skipped" if ref.broken else "the voice stays registered")
        log.info("voice %r: %d reference(s) cached + primed in %.0f ms", d.name, len(v.references()),
                 (time.perf_counter() - t0) * 1000)
        return v

    def _kwargs(self, text: str) -> dict[str, Any]:
        kw = dict(self.gen_kwargs)
        kw.pop("chunk_size", None)
        cap = max_new_tokens(text)
        if cap is not None:
            kw.setdefault("max_new_tokens", cap)
        return kw

    def _clone(self, ref: Reference, text: str, language: str, kw: dict[str, Any]) -> Iterator[tuple[Any, int]]:
        args: dict[str, Any] = dict(text=text, language=language, ref_audio=str(ref.wav),
                                    ref_text=ref.text or "", xvec_only=ref.text is None)
        return self._generate(args, kw)

    def _generate(self, args: dict[str, Any], kw: dict[str, Any]) -> Iterator[tuple[Any, int]]:
        streaming_name, plain_name = self._METHODS[self.mode]
        if self.streaming:
            for chunk, sr, _timing in getattr(self.model, streaming_name)(**args, chunk_size=self.chunk_size, **kw):
                yield chunk, int(sr)
        else:
            wavs, sr = getattr(self.model, plain_name)(**args, **kw)
            yield wavs[0], int(sr)

    def _warmup(self) -> None:
        if self.mode == "clone":  # voices were primed in _load_voice (which also fixed the sample rate)
            self.sample_rate = self.sample_rate or int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
            log.info("warm-up done, sample rate %d Hz", self.sample_rate)
            return
        super()._warmup()

    def stream(self, text: str, language: str, voice: str | None, instruct: str,
               emotion: str | None = None) -> Iterator[tuple[Any, int]]:
        v = self.resolve_voice(voice)
        kw = self._kwargs(text)
        if self.mode == "clone":
            assert v is not None and v.ref_wav is not None
            yield from self._clone_attempts(v, language, emotion, lambda ref: self._clone(ref, text, language, kw))
            return
        if self.mode == "custom_voice":
            assert v is not None
            args: dict[str, Any] = dict(text=text, language=language, speaker=v.name)
            if instruct:
                args["instruct"] = instruct
        else:  # voice_design
            args = dict(text=text, language=language, instruct=self._design_instruct(v, instruct))
        yield from self._generate(args, kw)


class MlxEngine(BaseEngine):
    """`mlx-audio` on Apple silicon: the same Qwen3-TTS converted to MLX (Metal), chunk streaming.

    For a Mac, where faster-qwen3-tts (CUDA graphs) cannot run and qwen-tts on MPS is slower than
    real time. ``TTS_MODEL`` names an MLX repo (default below). MLX keeps its GPU stream per thread,
    so every model call runs on one thread of its own and the chunks come back through a queue.
    """

    backend = "mlx"
    streaming = True
    DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"

    def _load_model(self) -> None:
        import queue

        self._jobs: Any = queue.Queue()
        threading.Thread(target=self._loop, name="mlx", daemon=True).start()
        self.model_id = os.environ.get("TTS_MODEL") or self.DEFAULT_MODEL
        self.mode = self._detect_mode(self.model_id)
        self.device = "metal (mlx)"
        self.interval = float(os.environ.get("TTS_MLX_INTERVAL", "0.32"))
        log.info("loading %s with mlx-audio (mode=%s, a chunk every %.2f s of audio) …",
                 self.model_id, self.mode, self.interval)

        def load() -> Any:
            from mlx_audio.tts.utils import load_model  # type: ignore

            return load_model(self.model_id)

        self.model = self._call(load)
        rate = getattr(self.model, "sample_rate", 0)
        if isinstance(rate, int) and rate > 0:
            self.sample_rate = rate

    def _loop(self) -> None:
        while True:
            self._jobs.get()()

    def _call(self, fn: Any) -> Any:
        """Runs `fn()` on the MLX thread and returns what it returned (or raises what it raised)."""
        import queue

        done: Any = queue.Queue(maxsize=1)

        def job() -> None:
            try:
                done.put((True, fn()))
            except BaseException as e:  # noqa: BLE001 - handed back to the caller
                done.put((False, e))

        self._jobs.put(job)
        ok, value = done.get()
        if not ok:
            raise value
        return value

    def _iterate(self, make: Any) -> Iterator[tuple[Any, int]]:
        """Iterates `make()` on the MLX thread; stops it at the next chunk once nobody reads on."""
        import queue

        out: Any = queue.Queue()
        stop = threading.Event()
        end = object()

        def job() -> None:
            try:
                for item in make():
                    if stop.is_set():
                        break
                    out.put(item)
                out.put(end)
            except BaseException as e:  # noqa: BLE001 - raised again on the reading side
                out.put(e)

        self._jobs.put(job)
        try:
            while True:
                item = out.get()
                if item is end:
                    return
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            stop.set()

    def _load_voice(self, d: Path) -> Voice | None:
        ref_wav, text, base_instruct = self._read_voice_files(d)
        if self.mode != "clone":
            return Voice(d.name, base_instruct=base_instruct)
        if not ref_wav.exists():
            log.warning("voice %r has no ref.wav — skipped", d.name)
            return None
        v = Voice(d.name, ref_wav, text or None, None, base_instruct, not text)
        v.plain = Reference("ref", ref_wav, text or None)
        self._extra_references(v, d)
        return v

    def _generate(self, text: str, language: str, extra: dict[str, Any]) -> Iterator[tuple[Any, int]]:
        import numpy as np

        kw = dict(self.gen_kwargs)
        cap = max_new_tokens(text)
        if cap is not None:
            kw.setdefault("max_tokens", cap)
        model, sr = self.model, self.sample_rate

        def make() -> Iterator[tuple[Any, int]]:
            for r in model.generate(text=text, lang_code=(language or "auto").lower(), stream=True,
                                    streaming_interval=self.interval, **extra, **kw):
                yield np.array(r.audio, dtype=np.float32).reshape(-1), int(getattr(r, "sample_rate", 0) or sr)

        return self._iterate(make)

    def stream(self, text: str, language: str, voice: str | None, instruct: str,
               emotion: str | None = None) -> Iterator[tuple[Any, int]]:
        v = self.resolve_voice(voice)
        if self.mode == "clone":
            assert v is not None
            yield from self._clone_attempts(
                v, language, emotion,
                lambda ref: self._generate(text, language, {"ref_audio": str(ref.wav), "ref_text": ref.text}),
            )
            return
        if self.mode == "custom_voice":
            assert v is not None
            extra: dict[str, Any] = {"voice": v.name}
            if instruct:
                extra["instruct"] = instruct
        else:  # voice_design
            extra = {"instruct": self._design_instruct(v, instruct)}
        yield from self._generate(text, language, extra)


def make_engine() -> BaseEngine:
    """Pick the backend from TTS_BACKEND (default: faster when importable, else qwen-tts; mlx only by name)."""
    choice = os.environ.get("TTS_BACKEND", "auto").strip().lower().replace("_", "-")
    if choice in ("", "auto"):
        try:
            import faster_qwen3_tts  # type: ignore  # noqa: F401

            choice = "faster"
        except ImportError as e:
            log.info("faster_qwen3_tts not importable (%s) — using the qwen-tts backend", e)
            choice = "qwen-tts"
        log.info("TTS backend: %s (auto-selected)", choice)
    elif choice in ("faster", "qwen-tts", "mlx"):
        log.info("TTS backend: %s (TTS_BACKEND)", choice)
    else:
        raise RuntimeError(f"bad TTS_BACKEND={choice!r} (expected auto | faster | qwen-tts | mlx)")
    if choice == "mlx":
        return MlxEngine()
    return FasterEngine() if choice == "faster" else QwenTtsEngine()


def _reference_fields(r: Reference) -> dict[str, Any]:
    return {"key": r.key, "wav": r.wav, "text": r.text, "broken": r.broken}


def describe_engine(e: BaseEngine) -> dict[str, Any]:
    """What the worker needs to know of an engine in another process. Plain data: the classes of this
    module are not the same classes over there."""
    attrs = ("model_id", "device", "mode", "clone_mode", "voice_bank", "backend", "sample_rate", "streaming",
             "chunk_size", "stream_probe")
    voices = {n: {"ref_wav": v.ref_wav, "ref_text": v.ref_text, "base_instruct": v.base_instruct,
                  "x_vector_only": v.x_vector_only, "plain": _reference_fields(v.plain) if v.plain else None,
                  "by_language": {k: _reference_fields(r) for k, r in v.by_language.items()},
                  "bank": {k: _reference_fields(r) for k, r in v.bank.items()}} for n, v in e.voices.items()}
    return {**{a: getattr(e, a) for a in attrs}, "voices": voices}


class RemoteEngine(BaseEngine):
    """The engine in its own process (../engine_process.py), as this worker sees it. Everything that
    only reads voices runs here on a copy, without a trip through the pipe; GPU work goes over."""

    def __init__(self) -> None:  # no super().__init__(): the model lives in the child
        self.lock = GpuLock()
        self.closed = False
        self.stopping = False
        self.voices = {}
        self.process = EngineProcess(__file__, "make_engine", "describe_engine")

    def wait_ready(self) -> "RemoteEngine":
        try:
            self._take(self.process.wait_ready())
        except RemoteError as e:
            raise RuntimeError(f"the engine did not start: {e}") from e
        return self

    def _take(self, d: dict[str, Any]) -> None:
        voices = d.pop("voices")
        for name, value in d.items():
            setattr(self, name, value)

        def ref(r: dict[str, Any] | None) -> Reference | None:
            return Reference(**r) if r else None

        self.voices = {n: Voice(n, v["ref_wav"], v["ref_text"], None, v["base_instruct"], v["x_vector_only"],
                                ref(v["plain"]), {k: Reference(**r) for k, r in v["by_language"].items()},
                                {k: Reference(**r) for k, r in v["bank"].items()}) for n, v in voices.items()}

    def alive(self) -> bool:
        return self.process.alive()

    def close(self) -> None:
        """Ends the process at once, the running sentence included: the caller already let it drain."""
        self.closed = True
        self.voices = {}
        self.process.kill()

    def reload_voices(self) -> None:
        with self.lock:
            self._take(self.process.call("reload_and_describe"))

    def stream(self, text: str, language: str, voice: str | None, instruct: str,
               emotion: str | None = None) -> Iterator[tuple[Any, int]]:
        try:
            yield from self.process.stream("stream_audio", text, language, voice, instruct, emotion)
        except RemoteError as e:
            if e.status is not None:
                raise ApiError(e.status, e.message) from e
            raise RuntimeError(str(e)) from e
        except EngineGone as e:
            raise ApiError(503, "offloaded" if self.closed else "the engine process ended; reloading") from e


def start_engine() -> BaseEngine:
    """The engine this worker runs, on a pool thread: a child process unless told otherwise (see
    engine_process.py for why). `state.loading` lets an offload stop it while it loads."""
    if EngineProcess is None or os.environ.get("TTS_ENGINE_PROCESS", "1") == "0":
        return make_engine()
    eng = RemoteEngine()
    state.loading = eng
    return eng.wait_ready()


class ChunkPump:
    """Runs the sentences of one request in a pool thread and hands PCM chunks to the event loop
    through an asyncio.Queue. Messages: ("chunk", pcm_bytes) | ("done", None) | ("error", exc).
    `cancel()` is checked between chunks and before each sentence; the generator is then closed."""

    def __init__(self, eng: BaseEngine, sentences: list[str], language: str, voice: str | None, instruct: str,
                 pool: ThreadPoolExecutor, loop: asyncio.AbstractEventLoop, *, emotion: str | None = None,
                 rank: int = RANK_NOW) -> None:
        self.eng, self.sentences = eng, sentences
        self.language, self.voice, self.instruct = language, voice, instruct
        self.emotion, self.rank = emotion, rank
        self.pool, self.loop = pool, loop
        self.started = 0.0
        self.queue_ms = 0.0  # waited for a thread and the GPU lock before the first sentence
        self.queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self.cancelled = threading.Event()
        self.rate = 0  # sample rate of the first chunk; later chunks are resampled to it if they differ
        self.future: asyncio.Future | None = None

    def start(self) -> None:
        activity.begin()
        self.started = time.perf_counter()
        self.future = self.loop.run_in_executor(self.pool, self._run)

    def cancel(self) -> None:
        self.cancelled.set()

    def _put(self, item: tuple[str, Any]) -> None:
        try:
            self.loop.call_soon_threadsafe(self.queue.put_nowait, item)
        except RuntimeError:  # event loop already closed
            self.cancelled.set()

    def _pcm(self, wav: Any, sr: int) -> bytes:
        if not self.rate:
            self.rate = sr
        elif sr != self.rate:  # model changed rate mid-flight (should not happen) — keep the header truthful
            from math import gcd

            from scipy.signal import resample_poly

            g = gcd(sr, self.rate)
            wav = resample_poly(_to_numpy(wav), self.rate // g, sr // g)
        return _to_pcm16(wav)

    def _offloading(self) -> bool:
        return getattr(self.eng, "stopping", False) or getattr(self.eng, "closed", False)

    def _gpu(self) -> Any:
        hold = getattr(self.eng.lock, "hold", None)
        return hold(self.rank) if hold is not None else self.eng.lock

    def _run(self) -> None:
        extra = {"emotion": self.emotion} if self.emotion else {}
        try:
            for i, sentence in enumerate(self.sentences):
                if self.cancelled.is_set():
                    return
                if self._offloading():
                    raise ApiError(503, "offloaded")
                with self._gpu():
                    if i == 0:
                        self.queue_ms = (time.perf_counter() - self.started) * 1000
                    if self.cancelled.is_set():
                        return
                    if self._offloading():
                        raise ApiError(503, "offloaded")
                    gen = self.eng.stream(sentence, self.language, self.voice, self.instruct, **extra)
                    try:
                        for wav, sr in gen:
                            if self.cancelled.is_set():
                                return
                            # The song worker is taking the GPU: this utterance ends here.
                            if self._offloading():
                                raise ApiError(503, "offloaded")
                            self._put(("chunk", self._pcm(wav, sr)))
                    finally:
                        close = getattr(gen, "close", None)
                        if close:
                            close()
            self._put(("done", None))
        except BaseException as e:  # noqa: BLE001 — forwarded to the response
            self._put(("error", e))
        finally:
            activity.end()


class State:
    engine: BaseEngine | None
    pool: ThreadPoolExecutor
    swap: asyncio.Lock  # one offload at a time; a reload does not take it, so nothing waits behind one
    offloaded: dict[str, Any] | None = None  # {since, reason, reload_at}
    auto_reload: asyncio.Task | None = None
    load: asyncio.Future | None = None  # the reload under way
    loading: "RemoteEngine | None" = None  # its engine, while that can still be stopped
    released_mb: int | None = None  # what the device gave back at the last offload


state = State()


def _engine() -> BaseEngine:
    if state.engine is None:
        raise ApiError(503, "offloaded")
    alive = getattr(state.engine, "alive", None)
    if alive is not None and not alive():
        log.error("the engine process ended by itself; starting it again")
        state.engine = None
        state.offloaded = {"since": time.time(), "reason": "engine crashed", "reload_at": None}
        asyncio.ensure_future(_bring_back())
        raise ApiError(503, "offloaded")
    return state.engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.pool = ThreadPoolExecutor(max_workers=int(os.environ.get("TTS_POOL_SIZE", "4")), thread_name_prefix="tts")
    state.swap = asyncio.Lock()
    state.offloaded = None
    state.load = state.loading = None
    loop = asyncio.get_running_loop()
    state.engine = await loop.run_in_executor(state.pool, start_engine)
    state.loading = None
    yield
    if state.auto_reload is not None:
        state.auto_reload.cancel()
    if state.engine is not None and isinstance(state.engine, RemoteEngine):
        state.engine.close()
    state.pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Miyoria TTS worker", lifespan=lifespan)
if service_auth is not None:
    service_auth.install(app)  # every route needs the bearer token when hostd set one


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.exception_handler(ApiError)
async def _api_exc(_: Request, exc: ApiError) -> JSONResponse:
    return _error(exc.status, exc.message)


@app.exception_handler(StarletteHTTPException)
async def _http_exc(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    return _error(exc.status_code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def _validation_exc(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    return _error(400, f"invalid request: {where or 'body'}: {first.get('msg', 'bad value')}")


@app.post("/tts")
async def tts(req: TtsRequest) -> StreamingResponse:
    text = req.text.strip()
    if not text:
        raise ApiError(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise ApiError(413, f"text too long ({len(text)} > {MAX_TEXT_CHARS} chars)")
    ahead = req.priority == "ahead"
    sentences = split_sentences(text, MIN_CHARS, ahead_max_chars() if ahead else MAX_CHARS)
    if not sentences:
        raise ApiError(400, "text has nothing to speak (punctuation only)")

    eng = _engine()
    language = to_tts_language(req.language)
    instruct = (req.instruct or "").strip()
    eng.resolve_voice(req.voice)  # fail fast with 404 / 400 before any GPU work
    loop = asyncio.get_running_loop()

    # Start generating and wait for the FIRST chunk BEFORE creating the response: a failure up to
    # here becomes a proper 4xx/5xx JSON error instead of a truncated 200, and the sample rate for
    # the headers comes from what the model really produced.
    emotion = (req.emotion or "").strip().lower() or None
    reference = eng.reference_key(req.voice, language, emotion)
    pump = ChunkPump(eng, sentences, language, req.voice, instruct, state.pool, loop, emotion=emotion,
                     rank=RANK_AHEAD if ahead else RANK_NOW)
    t0 = time.perf_counter()
    pump.start()
    try:
        kind, payload = await pump.queue.get()
    except BaseException:  # client went away while we were waiting
        pump.cancel()
        raise
    if kind != "chunk":
        pump.cancel()
        if kind == "error":
            if isinstance(payload, ApiError):
                raise payload
            log.error("synthesis failed", exc_info=payload)
            raise ApiError(500, f"synthesis failed: {type(payload).__name__}: {payload}") from payload
        raise ApiError(500, "synthesis failed: model produced no audio")
    first: bytes = payload
    rate = pump.rate
    ttfa_ms = (time.perf_counter() - t0) * 1000
    log.info("tts %d sentence(s), first audio after %.0f ms, %.0f ms of it queued (backend=%s voice=%s reference=%s)",
             len(sentences), ttfa_ms, pump.queue_ms, eng.backend, req.voice, reference)

    async def body() -> AsyncIterator[bytes]:
        n_chunks, n_bytes = 1, len(first)
        try:
            yield first
            while True:
                kind, payload = await pump.queue.get()
                if kind == "chunk":
                    n_chunks += 1
                    n_bytes += len(payload)
                    yield payload
                elif kind == "done":
                    break
                else:  # a failure here aborts the chunked stream (client sees an error)
                    log.error("synthesis failed mid-stream; aborting response", exc_info=payload)
                    raise payload
            log.info("tts done: %d chunk(s), %.2f s of audio, %.0f ms total",
                     n_chunks, n_bytes / 2 / rate, (time.perf_counter() - t0) * 1000)
        finally:
            # client disconnect (CancelledError / GeneratorExit), error or normal end: stop generating.
            # A chunk already on the GPU finishes; its output is dropped.
            pump.cancel()

    return StreamingResponse(
        body(),
        media_type=f"audio/L16; rate={rate}; channels=1",
        headers={
            "X-Sample-Rate": str(rate),
            "X-Tts-Streaming": "chunk" if eng.streaming else "sentence",
            "X-Tts-First-Audio-Ms": f"{ttfa_ms:.0f}",
            "X-Tts-Queue-Ms": f"{pump.queue_ms:.0f}",
            "X-Tts-Reference": reference,
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/voices")
async def voices() -> dict[str, Any]:
    e = _engine()
    return {
        "mode": e.mode,
        "default": os.environ.get("TTS_DEFAULT_VOICE") or None,
        "clone_mode": e.clone_mode,
        "voice_bank": e.voice_bank,
        "voices": [{"name": v.name, "ref_text": v.ref_text, "x_vector_only": v.x_vector_only,
                    "references": [r.key for r in v.references() if not r.broken]} for v in e.voices.values()],
    }


@app.get("/busy")
async def busy() -> dict[str, int]:
    return {"busy": activity.count}


@app.post("/voices/reload")
async def voices_reload() -> dict[str, Any]:
    await asyncio.get_running_loop().run_in_executor(state.pool, _engine().reload_voices)
    return await voices()


def _vram_mb() -> int | None:
    cuda = getattr(sys.modules.get("torch"), "cuda", None)
    if cuda is not None and cuda.is_available():
        return round(cuda.memory_allocated() / 2**20)
    return None


def _free_cuda() -> None:
    gc.collect()
    cuda = getattr(sys.modules.get("torch"), "cuda", None)
    if cuda is not None and cuda.is_available():
        cuda.synchronize()
        cuda.empty_cache()


async def _drain(limit_s: float) -> bool:
    """Waits for the running utterances to finish, at most ``limit_s``. Whether they did."""
    deadline = time.monotonic() + limit_s
    while activity.count > 0:
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.02)
    return True


def _device_before() -> Any:
    return device_memory.read() if device_memory else None


def _released(before: Any, remember: bool = True) -> dict[str, Any]:
    """What the device gave back since `before`, once the process is really gone. A reload stopped
    halfway held only part of the model: that says nothing about what an offload frees."""
    if not device_memory:
        return {}
    out = device_memory.report(before, device_memory.settled())
    if remember:
        state.released_mb = out["released_mb"]
    return out


def _lease(max_s: float) -> None:
    """Until `max_s` from now nobody needs to come back; asking again starts it over. A job that is
    alive renews it, so a reload by itself only happens when whoever asked has gone away (on 11-07 a
    fixed 15 minutes reloaded both workers into a job that was still running)."""
    if state.auto_reload is not None:
        state.auto_reload.cancel()
    state.auto_reload = asyncio.create_task(_reload_after(max_s)) if max_s > 0 else None
    if state.offloaded is not None:
        state.offloaded["reload_at"] = time.time() + max_s if max_s > 0 else None


@app.post("/offload")
async def offload(req: OffloadRequest | None = None) -> dict[str, Any]:
    req = req or OffloadRequest()
    max_s = req.max_s if req.max_s is not None else float(os.environ.get("TTS_OFFLOAD_MAX_S", "900"))
    if state.load is not None:
        # A reload is under way: stopped, not waited for. Stopping one takes no time; one that runs
        # in this process cannot be stopped at all, so the caller hears that instead of hanging.
        loader = state.loading
        if loader is None:
            return {"state": "reloading", "offload_ms": 0}
        before = _device_before()
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, loader.close)
        _lease(max_s)
        released = await loop.run_in_executor(None, _released, before, False)
        return {"state": "offloaded", "offload_ms": 0, "cancelled_reload": True, **released}
    async with state.swap:
        if state.engine is None:
            _lease(max_s)
            return {"state": "offloaded", "offload_ms": 0, "already": True, **(state.offloaded or {})}
        loop = asyncio.get_running_loop()
        t0 = time.perf_counter()
        before, device = _vram_mb(), _device_before()
        eng, state.engine = state.engine, None
        state.offloaded = {"since": time.time(), "reason": (req.reason or "")[:80], "reload_at": None}
        # New requests already answer 503. The ones under way may finish: an offload in the middle
        # of a line cut her off on 11-07 (Core stops sending lines, it cannot take one back).
        drain_s = req.drain_s if req.drain_s is not None else float(os.environ.get("TTS_OFFLOAD_DRAIN_S", "15"))
        drained = await _drain(drain_s)
        if not drained:
            log.warning("utterances still running after %.0f s; stopping them for the offload", drain_s)
        # What is left stops at its next chunk and what waits never starts, so the close below
        # waits for one chunk at most. It runs on its own thread: the pool's threads can all be
        # held by requests waiting for the GPU lock.
        eng.stopping = True
        await loop.run_in_executor(None, eng.close)
        del eng
        await loop.run_in_executor(None, _free_cuda)
        released = await loop.run_in_executor(None, _released, device)
        ms = (time.perf_counter() - t0) * 1000
        after = _vram_mb()
        log.info("offloaded for %r in %.0f ms: the card gave back %s MB", req.reason, ms, released.get("released_mb"))
        _lease(max_s)
        return {"state": "offloaded", "offload_ms": round(ms), "drained": drained,
                "vram_before_mb": before, "vram_after_mb": after, **released}


async def _reload_after(seconds: float) -> None:
    await asyncio.sleep(seconds)
    log.warning("nobody renewed the offload for %.0f s; reloading by itself", seconds)
    state.auto_reload = None
    await reload()


async def _load_engine() -> dict[str, Any]:
    t0 = time.perf_counter()
    try:
        eng = await asyncio.get_running_loop().run_in_executor(state.pool, start_engine)
    except EngineGone:
        log.info("the reload was stopped by an offload")
        return {"state": "offloaded", "cancelled": True}
    finally:
        state.load = state.loading = None
    state.engine = eng
    state.offloaded = None
    ms = (time.perf_counter() - t0) * 1000
    log.info("reloaded in %.0f ms", ms)
    return {"state": "ready", "reload_ms": round(ms), "vram_mb": _vram_mb(), **(device_memory.fields() if device_memory else {})}


async def _bring_back() -> dict[str, Any]:
    if state.load is None:
        state.load = asyncio.ensure_future(_load_engine())
    return await asyncio.shield(state.load)


@app.post("/reload")
async def reload() -> dict[str, Any]:
    if state.engine is not None:
        return {"state": "ready", "reload_ms": 0, "already": True}
    task, state.auto_reload = state.auto_reload, None
    if task is not None and task is not asyncio.current_task():
        task.cancel()
    return await _bring_back()


@app.get("/health")
async def health() -> dict[str, Any]:
    e = state.engine
    if e is None:
        # Healthy, just not holding a model (POST /reload brings it back).
        return {"status": "ok", "offloaded": True, "model": os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"),
                **(state.offloaded or {}), "loading": state.load is not None, "released_mb": state.released_mb,
                "vram_allocated_mb": _vram_mb(), **(device_memory.fields() if device_memory else {})}
    info: dict[str, Any] = {
        "offloaded": False,
        "status": "ok",
        "model": e.model_id,
        "device": e.device,
        "mode": e.mode,
        "backend": e.backend,
        "sample_rate": e.sample_rate,
        "streaming": e.streaming,  # true = chunk-by-chunk inside a sentence, false = whole sentences
        "chunk_size": e.chunk_size,  # codec steps per chunk (faster backend), else null
        "stream_probe": e.stream_probe,
        "voices": list(e.voices),
        "instruct_supported": e.mode != "clone",
        "clone_mode": e.clone_mode,
        "voice_bank": e.voice_bank,
        "released_mb": state.released_mb,  # at the last offload, measured on the device
        "engine_pid": e.process.pid if isinstance(e, RemoteEngine) else None,
        **(device_memory.fields() if device_memory else {}),
    }
    cuda = getattr(sys.modules.get("torch"), "cuda", None)
    if cuda is not None and cuda.is_available():
        info["vram_allocated_mb"] = round(cuda.memory_allocated() / 2**20)
    return info


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8002")), log_level="info")


if __name__ == "__main__":
    main()
