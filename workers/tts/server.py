"""Miyoria TTS worker (Qwen3-TTS) — implements the "推論 Worker HTTP 介面" (docs/protocols/voice-link.md).

    POST /tts            JSON {text, language?, emotion?, instruct?, voice?}
                         -> 200 streamed raw PCM s16le mono, headers X-Sample-Rate, Content-Type
                            "audio/L16; rate=<sr>; channels=1"
    GET  /health         -> {"status":"ok","model":...,"backend":...,"streaming":bool,"chunk_size":...}
    GET  /voices         -> registered voices
    POST /voices/reload  -> rescan VOICES_DIR (add a voice without restarting)
    POST /offload        JSON {reason?, max_s?} -> frees the GPU: the engine (model, CUDA graphs, voice
                         prompts) is dropped and the CUDA cache emptied; until /reload every /tts and
                         /voices call answers 503 {"error": "offloaded"}. Reloads by itself after
                         ``max_s`` (TTS_OFFLOAD_MAX_S) in case whoever asked never comes back.
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
    lock is held per sentence, so concurrent requests interleave at sentence boundaries.

VOICES: each voice is a directory ``$VOICES_DIR/<name>/`` with ``ref.wav`` + ``ref.txt`` (the
    transcript of ref.wav). At startup (Base model) every voice is registered: qwen-tts builds a
    reusable clone prompt (`create_voice_clone_prompt`); faster passes the same ref path + text on
    every call (the package caches the prompt per (path, text)) and primes that cache with one
    short synthesis. Directories ending in ``-candidates`` and names starting with ``.`` / ``_``
    are ignored. A voice without ref.txt falls back to speaker-embedding-only cloning (lower
    quality) and logs a warning.

INSTRUCT / EMOTION: only models with instruction control honour ``instruct``:
    mode ``clone`` (…-Base)        instruct and emotion are IGNORED (emotion = text semantics only)
    mode ``custom_voice``          ``voice`` = built-in speaker name, ``instruct`` is applied
    mode ``voice_design``          ``instruct`` is the voice description (a voice dir's optional
                                   ``instruct.txt`` is prepended as the base description)
    The mode is derived from the model id (Base / CustomVoice / VoiceDesign) or ``TTS_MODE``.
    ``emotion`` is informational: Miyoria sends the already-mapped ``instruct`` (from voice.toml).

Environment
    TTS_BACKEND            auto | faster | qwen-tts       (default auto = faster if importable)
    TTS_MODEL              HF id or local dir            (default Qwen/Qwen3-TTS-12Hz-1.7B-Base)
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
    TTS_MAX_TEXT_CHARS     reject longer requests (default 2000)
    TTS_MAX_SECONDS_PER_CHAR  audio cap per sentence: chars × this + 2 s (default 0.35). Sampling
                           sometimes misses the stop token and the model talks on for half a
                           minute in a drifting voice; the cap cuts that off. 0 = no cap
    TTS_POOL_SIZE          threads for synthesis calls (default 2; the GPU lock still serialises)
    TTS_OFFLOAD_MAX_S      an offload reloads by itself after this long (default 900; 0 = never)
    HOST / PORT            bind address                  (default 127.0.0.1 / 8002)
"""

from __future__ import annotations

import asyncio
import gc
import importlib.util
import inspect
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from text_split import split_sentences

log = logging.getLogger("miyoria.tts")

MAX_TEXT_CHARS = int(os.environ.get("TTS_MAX_TEXT_CHARS", "2000"))
MIN_CHARS = int(os.environ.get("TTS_MIN_SENTENCE_CHARS", "4"))
MAX_CHARS = int(os.environ.get("TTS_MAX_SENTENCE_CHARS", "80"))
MAX_SECONDS_PER_CHAR = float(os.environ.get("TTS_MAX_SECONDS_PER_CHAR", "0.35"))
# Silence between sentences of one request (0 = none, the upstream behaviour).
SENTENCE_PAUSE_MS = int(os.environ.get("TTS_SENTENCE_PAUSE_MS", "0"))


def apply_readings(text: str) -> str:
    """Swap words for how they should be said, from $VOICES_DIR/readings.json ({"大肥魚": "デブざかな"}).
    Only the audio changes; subtitles come from Core. Read per request so edits apply at once."""
    path = os.path.join(os.environ.get("VOICES_DIR", "voices"), "readings.json")
    try:
        with open(path, encoding="utf-8") as f:
            readings = json.load(f)
    except FileNotFoundError:
        return text
    except (OSError, ValueError) as e:
        log.warning("cannot read %s: %s", path, e)
        return text
    for word in sorted(readings, key=len, reverse=True):  # longest first
        text = text.replace(word, readings[word])
    return text
# Qwen3-TTS-12Hz: 12 codec frames (= generated tokens) per second of audio.
TOKENS_PER_SECOND = 12


def max_new_tokens(text: str) -> int | None:
    """Token cap for one sentence (None = no cap): its characters × MAX_SECONDS_PER_CHAR + 2 s."""
    if MAX_SECONDS_PER_CHAR <= 0:
        return None
    chars = sum(1 for c in text if not c.isspace())
    return int((chars * MAX_SECONDS_PER_CHAR + 2.0) * TOKENS_PER_SECOND)

_LANG = {
    "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German",
    "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian",
}


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


# ── Engine ───────────────────────────────────────────────────────────────────


@dataclass
class Voice:
    name: str
    ref_wav: Path | None = None
    ref_text: str | None = None
    prompt: Any = None  # reusable clone prompt (qwen-tts, clone mode)
    base_instruct: str = ""  # voice_design mode: description prepended to the request's instruct
    x_vector_only: bool = False


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
        self.lock = threading.Lock()  # one generation on the GPU at a time (per sentence)
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

    # -- backend hooks -------------------------------------------------------

    def _load_model(self) -> None:
        raise NotImplementedError

    def _load_voice(self, d: Path) -> Voice | None:
        raise NotImplementedError

    def stream(self, text: str, language: str, voice: str | None, instruct: str) -> Iterator[tuple[Any, int]]:
        raise NotImplementedError

    # -- setup ---------------------------------------------------------------

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

    @staticmethod
    def _read_voice_files(d: Path) -> tuple[Path, str, str]:
        """-> (ref.wav path, ref.txt text or "", instruct.txt text or "")."""
        ref_wav, ref_txt, inst = d / "ref.wav", d / "ref.txt", d / "instruct.txt"
        base_instruct = inst.read_text(encoding="utf-8").strip() if inst.exists() else ""
        text = ref_txt.read_text(encoding="utf-8").strip() if ref_txt.exists() else ""
        if not text and ref_wav.exists():
            log.warning("voice %r has no ref.txt — using speaker embedding only (x_vector_only_mode); "
                        "add the transcript for better quality", d.name)
        return ref_wav, text, base_instruct

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
        with self.lock:
            prompt = self.model.create_voice_clone_prompt(
                ref_audio=str(ref_wav), ref_text=text or None, x_vector_only_mode=x_only
            )
        log.info("voice %r: clone prompt built in %.0f ms", d.name, (time.perf_counter() - t0) * 1000)
        return Voice(d.name, ref_wav, text or None, prompt, base_instruct, x_only)

    def stream(self, text: str, language: str, voice: str | None, instruct: str) -> Iterator[tuple[Any, int]]:
        v = self.resolve_voice(voice)
        kw = dict(self.gen_kwargs)
        if self.mode == "clone":
            assert v is not None
            wavs, sr = self.model.generate_voice_clone(text=text, language=language, voice_clone_prompt=v.prompt, **kw)
        elif self.mode == "custom_voice":
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
        # Prime the package's prompt cache (otherwise built on first use) so the first request is fast.
        t0 = time.perf_counter()
        try:
            with self.lock:
                for _, sr in self.stream("你好。", "Chinese", None, "", _voice=v):
                    self.sample_rate = int(sr)
        except Exception:
            log.exception("voice %r: priming synthesis failed (the voice stays registered)", d.name)
        else:
            log.info("voice %r: prompt cached + primed in %.0f ms", d.name, (time.perf_counter() - t0) * 1000)
        return v

    def _warmup(self) -> None:
        if self.mode == "clone":  # voices were primed in _load_voice (which also fixed the sample rate)
            self.sample_rate = self.sample_rate or int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
            log.info("warm-up done, sample rate %d Hz", self.sample_rate)
            return
        super()._warmup()

    def stream(self, text: str, language: str, voice: str | None, instruct: str,
               _voice: Voice | None = None) -> Iterator[tuple[Any, int]]:
        v = _voice or self.resolve_voice(voice)
        kw = dict(self.gen_kwargs)
        kw.pop("chunk_size", None)
        cap = max_new_tokens(text)
        if cap is not None:
            kw.setdefault("max_new_tokens", cap)
        if self.mode == "clone":
            assert v is not None and v.ref_wav is not None
            args: dict[str, Any] = dict(text=text, language=language, ref_audio=str(v.ref_wav),
                                        ref_text=v.ref_text or "", xvec_only=v.x_vector_only)
        elif self.mode == "custom_voice":
            assert v is not None
            args = dict(text=text, language=language, speaker=v.name)
            if instruct:
                args["instruct"] = instruct
        else:  # voice_design
            args = dict(text=text, language=language, instruct=self._design_instruct(v, instruct))
        streaming_name, plain_name = self._METHODS[self.mode]
        if self.streaming:
            for chunk, sr, _timing in getattr(self.model, streaming_name)(**args, chunk_size=self.chunk_size, **kw):
                yield chunk, int(sr)
        else:
            wavs, sr = getattr(self.model, plain_name)(**args, **kw)
            yield wavs[0], int(sr)


def make_engine() -> BaseEngine:
    """Pick the backend from TTS_BACKEND (default: faster when importable, else qwen-tts)."""
    choice = os.environ.get("TTS_BACKEND", "auto").strip().lower().replace("_", "-")
    if choice in ("", "auto"):
        try:
            import faster_qwen3_tts  # type: ignore  # noqa: F401

            choice = "faster"
        except ImportError as e:
            log.info("faster_qwen3_tts not importable (%s) — using the qwen-tts backend", e)
            choice = "qwen-tts"
        log.info("TTS backend: %s (auto-selected)", choice)
    elif choice in ("faster", "qwen-tts"):
        log.info("TTS backend: %s (TTS_BACKEND)", choice)
    else:
        raise RuntimeError(f"bad TTS_BACKEND={choice!r} (expected auto | faster | qwen-tts)")
    return FasterEngine() if choice == "faster" else QwenTtsEngine()


class ChunkPump:
    """Runs the sentences of one request in a pool thread and hands PCM chunks to the event loop
    through an asyncio.Queue. Messages: ("chunk", pcm_bytes) | ("done", None) | ("error", exc).
    `cancel()` is checked between chunks and before each sentence; the generator is then closed."""

    def __init__(self, eng: BaseEngine, sentences: list[str], language: str, voice: str | None, instruct: str,
                 pool: ThreadPoolExecutor, loop: asyncio.AbstractEventLoop) -> None:
        self.eng, self.sentences = eng, sentences
        self.language, self.voice, self.instruct = language, voice, instruct
        self.pool, self.loop = pool, loop
        self.queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self.cancelled = threading.Event()
        self.rate = 0  # sample rate of the first chunk; later chunks are resampled to it if they differ
        self.future: asyncio.Future | None = None

    def start(self) -> None:
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

    def _run(self) -> None:
        try:
            for i, sentence in enumerate(self.sentences):
                if self.cancelled.is_set():
                    return
                if self._offloading():
                    raise ApiError(503, "offloaded")
                if i > 0 and SENTENCE_PAUSE_MS > 0 and self.rate:
                    self._put(("chunk", b"\x00\x00" * (self.rate * SENTENCE_PAUSE_MS // 1000)))
                with self.eng.lock:
                    if self.cancelled.is_set():
                        return
                    if self._offloading():
                        raise ApiError(503, "offloaded")
                    gen = self.eng.stream(sentence, self.language, self.voice, self.instruct)
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


class State:
    engine: BaseEngine | None
    pool: ThreadPoolExecutor
    swap: asyncio.Lock  # offload / reload, one at a time
    offloaded: dict[str, Any] | None = None  # {since, reason, reload_at}
    auto_reload: asyncio.Task | None = None


state = State()


def _engine() -> BaseEngine:
    if state.engine is None:
        raise ApiError(503, "offloaded")
    return state.engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.pool = ThreadPoolExecutor(max_workers=int(os.environ.get("TTS_POOL_SIZE", "2")), thread_name_prefix="tts")
    state.swap = asyncio.Lock()
    state.offloaded = None
    loop = asyncio.get_running_loop()
    state.engine = await loop.run_in_executor(state.pool, make_engine)
    yield
    if state.auto_reload is not None:
        state.auto_reload.cancel()
    state.pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Miyoria TTS worker", lifespan=lifespan)


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


class TtsRequest(BaseModel):
    text: str
    language: str | None = None
    emotion: str | None = None
    instruct: str | None = None
    voice: str | None = None


@app.post("/tts")
async def tts(req: TtsRequest) -> StreamingResponse:
    text = req.text.strip()
    if not text:
        raise ApiError(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise ApiError(413, f"text too long ({len(text)} > {MAX_TEXT_CHARS} chars)")
    sentences = split_sentences(apply_readings(text), MIN_CHARS, MAX_CHARS)
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
    pump = ChunkPump(eng, sentences, language, req.voice, instruct, state.pool, loop)
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
    log.info("tts %d sentence(s), first audio after %.0f ms (backend=%s voice=%s)",
             len(sentences), ttfa_ms, eng.backend, req.voice)

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
        "voices": [{"name": v.name, "ref_text": v.ref_text, "x_vector_only": v.x_vector_only} for v in e.voices.values()],
    }


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


class OffloadRequest(BaseModel):
    reason: str | None = None
    max_s: float | None = None


@app.post("/offload")
async def offload(req: OffloadRequest | None = None) -> dict[str, Any]:
    req = req or OffloadRequest()
    async with state.swap:
        if state.engine is None:
            return {"state": "offloaded", "offload_ms": 0, "already": True, **(state.offloaded or {})}
        loop = asyncio.get_running_loop()
        t0 = time.perf_counter()
        before = _vram_mb()
        eng, state.engine = state.engine, None
        max_s = req.max_s if req.max_s is not None else float(os.environ.get("TTS_OFFLOAD_MAX_S", "900"))
        state.offloaded = {"since": time.time(), "reason": (req.reason or "")[:80],
                           "reload_at": time.time() + max_s if max_s > 0 else None}
        # Running requests stop at their next chunk and waiting ones never start, so the close
        # below waits for one chunk at most. It runs on its own thread: the pool's threads can all
        # be held by requests waiting for the GPU lock.
        eng.stopping = True
        await loop.run_in_executor(None, eng.close)
        del eng
        await loop.run_in_executor(None, _free_cuda)
        ms = (time.perf_counter() - t0) * 1000
        after = _vram_mb()
        log.info("offloaded for %r in %.0f ms (VRAM %s -> %s MB)", req.reason, ms, before, after)
        if state.auto_reload is not None:
            state.auto_reload.cancel()
        state.auto_reload = asyncio.create_task(_reload_after(max_s)) if max_s > 0 else None
        return {"state": "offloaded", "offload_ms": round(ms), "vram_before_mb": before, "vram_after_mb": after}


async def _reload_after(seconds: float) -> None:
    await asyncio.sleep(seconds)
    log.warning("still offloaded after %.0f s; reloading by itself", seconds)
    state.auto_reload = None
    await reload()


@app.post("/reload")
async def reload() -> dict[str, Any]:
    async with state.swap:
        if state.engine is not None:
            return {"state": "ready", "reload_ms": 0, "already": True}
        task, state.auto_reload = state.auto_reload, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
        t0 = time.perf_counter()
        state.engine = await asyncio.get_running_loop().run_in_executor(state.pool, make_engine)
        state.offloaded = None
        ms = (time.perf_counter() - t0) * 1000
        log.info("reloaded in %.0f ms", ms)
        return {"state": "ready", "reload_ms": round(ms), "vram_mb": _vram_mb()}


@app.get("/health")
async def health() -> dict[str, Any]:
    e = state.engine
    if e is None:
        # Healthy, just not holding a model (POST /reload brings it back).
        return {"status": "ok", "offloaded": True, "model": os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"),
                **(state.offloaded or {}), "vram_allocated_mb": _vram_mb()}
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
