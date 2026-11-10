"""Miyoria ASR worker — implements the "推論 Worker HTTP 介面" (docs/protocols/voice-link.md).

    POST /asr     multipart: audio (WAV, any rate/channels), language?, prompt?   -> JSON
    GET  /health  -> {"status":"ok","model":...,"device":...,"offloaded":bool}
    GET  /busy    -> {"busy": n} clips being transcribed (the song worker yields to them)
    POST /offload JSON {reason?, max_s?} -> ends the model's process, which gives the card back for
                  real (see ../engine_process.py; ``released_mb`` is measured on the device) (the song
                  worker borrows the GPU); /asr answers 503 {"error": "offloaded"} until /reload,
                  which also happens by itself after ``max_s`` (ASR_OFFLOAD_MAX_S)
    POST /reload  -> loads the model again (and warms it up)

Backend (env ``ASR_BACKEND``):
    sensevoice  SenseVoice-Small via sherpa-onnx (CPU by default). Returns emotion + audio_events.
    qwen3       Qwen3-ASR (`qwen-asr`, transformers or vLLM). Returns language only.

Environment
    ASR_BACKEND            sensevoice | qwen3                     (default sensevoice)
    ASR_MODEL              sensevoice: dir with model(.int8).onnx + tokens.txt
                           qwen3: HF id or local dir (default Qwen/Qwen3-ASR-<ASR_QWEN_SIZE>)
    ASR_QWEN_SIZE          0.6B | 1.7B                            (default 0.6B)
    ASR_QWEN_BACKEND       transformers | vllm                    (default transformers)
    ASR_DEVICE             qwen3 transformers device_map          (default cuda:0)
    ASR_ATTN               flash_attention_2 | sdpa | eager | auto (default auto: FA2 if installed)
    ASR_VLLM_GPU_MEM       vLLM gpu_memory_utilization            (default 0.25)
    ASR_THREADS            sherpa-onnx CPU threads                (default 4)
    ASR_LANGUAGE           sensevoice language, fixed at startup  (default auto)
    ASR_SENSEVOICE_FP32    1 = model.onnx instead of model.int8.onnx
    ASR_SENSEVOICE_PROVIDER cpu | cuda                            (default cpu)
    ASR_POOL_SIZE          worker threads for decode+inference    (default 4)
    ASR_MAX_AUDIO_SECONDS  reject longer clips with 413           (default 60)
    ASR_OFFLOAD_MAX_S      lease of an offload that does not name one: asking again renews it, without
                           that it reloads by itself after this (default 900; 0 = never)
    ASR_ENGINE_PROCESS     0 = the model in this process (default 1)
    HOST / PORT            bind address                           (default 127.0.0.1 / 8001)

Concurrency: the model is loaded once at startup (FastAPI lifespan). Decoding / resampling runs
in a thread pool (so several uploads can be decoded in parallel and the event loop is never
blocked); the model call itself is serialised with a lock, so the GPU sees one job at a time.

Output text is raw model output (usually Simplified for Chinese). The Rust side runs OpenCC
(s2tw) on it, so this worker deliberately does not convert.
"""

from __future__ import annotations

import asyncio
import gc
import importlib.util
import inspect
import io
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from tags import parse_sensevoice, to_language_code, to_language_name

log = logging.getLogger("miyoria.asr")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    import device_memory
    from engine_process import EngineGone, EngineProcess, RemoteError
except ImportError:  # the Docker image holds this folder only: the model stays in this process
    device_memory = None
    EngineProcess = None

    class EngineGone(Exception):  # type: ignore[no-redef]
        pass

    class RemoteError(Exception):  # type: ignore[no-redef]
        pass

TARGET_SR = 16_000
MAX_UPLOAD_BYTES = int(os.environ.get("ASR_MAX_UPLOAD_MB", "32")) * 1024 * 1024
MAX_AUDIO_SECONDS = float(os.environ.get("ASR_MAX_AUDIO_SECONDS", "60"))


class BadRequest(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# ── Audio ────────────────────────────────────────────────────────────────────


def decode_wav(data: bytes) -> tuple[Any, int]:
    """WAV bytes -> (mono float32 @ 16 kHz, original duration in ms)."""
    import numpy as np
    import soundfile as sf

    try:
        x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as e:  # soundfile raises LibsndfileError / RuntimeError
        raise BadRequest(f"cannot decode audio as WAV: {e}") from e
    if x.shape[0] == 0 or sr <= 0:
        raise BadRequest("audio is empty")
    seconds = x.shape[0] / sr
    if seconds > MAX_AUDIO_SECONDS:
        raise BadRequest(f"audio too long ({seconds:.1f}s > {MAX_AUDIO_SECONDS:.0f}s)", 413)
    mono = x.mean(axis=1)
    if sr != TARGET_SR:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(int(sr), TARGET_SR)
        mono = resample_poly(mono, TARGET_SR // g, int(sr) // g)
    return np.ascontiguousarray(mono, dtype=np.float32), round(seconds * 1000)


# ── Backends ─────────────────────────────────────────────────────────────────
# transcribe(samples_16k_f32, language, prompt) -> {"text", "language"?, "emotion"?, "audio_events"?}


class SenseVoiceBackend:
    name = "sensevoice"

    def __init__(self) -> None:
        import sherpa_onnx  # type: ignore

        d = Path(os.environ.get("ASR_MODEL", "models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"))
        fp32 = os.environ.get("ASR_SENSEVOICE_FP32", "0") == "1"
        model = d / ("model.onnx" if fp32 else "model.int8.onnx")
        tokens = d / "tokens.txt"
        for p in (model, tokens):
            if not p.exists():
                raise RuntimeError(f"missing {p} — set ASR_MODEL to the extracted sherpa-onnx SenseVoice dir")
        self.device = os.environ.get("ASR_SENSEVOICE_PROVIDER", "cpu")
        self.model_name = f"sensevoice-small:{model.name}"
        self.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model),
            tokens=str(tokens),
            num_threads=int(os.environ.get("ASR_THREADS", "4")),
            language=os.environ.get("ASR_LANGUAGE", "auto"),
            use_itn=True,
            provider=self.device,
            debug=False,
        )

    def transcribe(self, x: Any, language: str | None, prompt: str | None) -> dict[str, Any]:
        # `language` / `prompt` are not supported per request: sherpa-onnx fixes the language at
        # recognizer creation (ASR_LANGUAGE) and SenseVoice has no context prompt.
        s = self.rec.create_stream()
        s.accept_waveform(TARGET_SR, x)
        self.rec.decode_stream(s)
        r = s.result
        p = parse_sensevoice(
            r.text,
            lang=getattr(r, "lang", "") or "",
            emotion=getattr(r, "emotion", "") or "",
            event=getattr(r, "event", "") or "",
        )
        out: dict[str, Any] = {
            "text": p.text,
            "language": p.language,
            "emotion": p.emotion,  # None if SenseVoice said EMO_UNKNOWN / the field is missing
            "audio_events": p.audio_events,
        }
        return out


class Qwen3Backend:
    name = "qwen3"

    def __init__(self) -> None:
        import torch  # type: ignore
        from qwen_asr import Qwen3ASRModel  # type: ignore

        size = os.environ.get("ASR_QWEN_SIZE", "0.6B")
        model_id = os.environ.get("ASR_MODEL") or f"Qwen/Qwen3-ASR-{size}"
        self.model_name = model_id
        mode = os.environ.get("ASR_QWEN_BACKEND", "transformers")
        if mode == "vllm":
            # Linux / WSL2 / Docker only. vLLM pre-allocates gpu_memory_utilization of the card.
            self.device = "cuda:0 (vllm)"
            self.model = Qwen3ASRModel.LLM(
                model=model_id,
                gpu_memory_utilization=float(os.environ.get("ASR_VLLM_GPU_MEM", "0.25")),
                max_inference_batch_size=1,
                max_new_tokens=256,
            )
        else:
            self.device = os.environ.get("ASR_DEVICE", "cuda:0")
            kw: dict[str, Any] = dict(
                dtype=torch.bfloat16,
                device_map=self.device,
                max_inference_batch_size=8,
                max_new_tokens=256,
            )
            attn = os.environ.get("ASR_ATTN", "auto")
            if attn == "auto":
                attn = "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"
            if attn != "default":
                kw["attn_implementation"] = attn
            log.info("qwen3-asr %s attn=%s", model_id, attn)
            self.model = Qwen3ASRModel.from_pretrained(model_id, **kw)
        # `context` (background text that biases decoding) is only passed if this qwen-asr
        # build's transcribe() accepts it.
        try:
            self._has_context = "context" in inspect.signature(self.model.transcribe).parameters
        except (TypeError, ValueError):
            self._has_context = False

    def transcribe(self, x: Any, language: str | None, prompt: str | None) -> dict[str, Any]:
        kw: dict[str, Any] = {"audio": (x, TARGET_SR), "language": to_language_name(language)}
        if prompt and self._has_context:
            kw["context"] = prompt
        r = self.model.transcribe(**kw)[0]
        return {"text": (r.text or "").strip(), "language": to_language_code(getattr(r, "language", None))}


def make_backend() -> Any:
    name = os.environ.get("ASR_BACKEND", "sensevoice").lower()
    if name == "sensevoice":
        return SenseVoiceBackend()
    if name in ("qwen3", "qwen3-asr", "qwen"):
        return Qwen3Backend()
    raise RuntimeError(f"unknown ASR_BACKEND={name!r} (expected sensevoice | qwen3)")


# ── App ──────────────────────────────────────────────────────────────────────


def describe_backend(b: Any) -> dict[str, Any]:
    return {"name": b.name, "model_name": b.model_name, "device": b.device}


class RemoteBackend:
    """The backend in its own process (../engine_process.py), as this worker sees it."""

    def __init__(self) -> None:
        self.process = EngineProcess(__file__, "make_backend", "describe_backend")
        self.name = self.model_name = self.device = ""

    def wait_ready(self) -> "RemoteBackend":
        try:
            d = self.process.wait_ready()
        except RemoteError as e:
            raise RuntimeError(f"the backend did not start: {e}") from e
        self.name, self.model_name, self.device = d["name"], d["model_name"], d["device"]
        return self

    def alive(self) -> bool:
        return self.process.alive()

    def close(self) -> None:
        self.process.kill()

    def transcribe(self, x: Any, language: str | None, prompt: str | None) -> dict[str, Any]:
        try:
            return self.process.call("transcribe", x, language, prompt)
        except EngineGone as e:
            raise Offloaded() from e


def start_backend() -> Any:
    """The backend of this worker, on a pool thread: a child process unless told otherwise.
    `state.loading` lets an offload stop it while it loads."""
    if EngineProcess is None or os.environ.get("ASR_ENGINE_PROCESS", "1") == "0":
        return make_backend()
    backend = RemoteBackend()
    state.loading = backend
    return backend.wait_ready()


class State:
    backend: Any = None
    pool: ThreadPoolExecutor
    lock = threading.Lock()  # serialises model calls (GPU / ORT session)
    swap: asyncio.Lock  # one offload at a time; a reload does not take it, so nothing waits behind one
    offloaded: dict[str, Any] | None = None  # {since, reason, reload_at}
    auto_reload: asyncio.Task | None = None
    load: asyncio.Future | None = None  # the reload under way
    loading: Any = None  # its backend, while that can still be stopped
    released_mb: int | None = None  # what the device gave back at the last offload
    info: dict[str, Any] = {}  # name / model / device of the backend, kept while offloaded
    busy = 0  # /asr requests under way (only touched on the event loop)


state = State()


class Offloaded(Exception):
    pass


async def _load() -> None:
    t0 = time.perf_counter()
    loop = asyncio.get_running_loop()
    backend = await loop.run_in_executor(state.pool, start_backend)
    state.info = {"model": backend.model_name, "device": backend.device, "backend": backend.name}
    log.info("backend %s ready in %.1fs (%s on %s)", backend.name, time.perf_counter() - t0,
             backend.model_name, backend.device)
    state.backend = backend
    # Warm-up: one second of silence so first-request latency doesn't include kernel/session init.
    try:
        import numpy as np

        await loop.run_in_executor(state.pool, lambda: _locked_transcribe(np.zeros(TARGET_SR, np.float32), None, None))
    except Exception:  # warm-up is best effort
        log.exception("warm-up failed (continuing)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.pool = ThreadPoolExecutor(max_workers=int(os.environ.get("ASR_POOL_SIZE", "4")), thread_name_prefix="asr")
    state.swap = asyncio.Lock()
    state.offloaded = None
    state.load = state.loading = None
    await _load()
    state.loading = None
    yield
    if state.auto_reload is not None:
        state.auto_reload.cancel()
    close = getattr(state.backend, "close", None)
    if close is not None:
        close()
    state.pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Miyoria ASR worker", lifespan=lifespan)


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


def _locked_transcribe(x: Any, language: str | None, prompt: str | None) -> tuple[dict[str, Any], float]:
    with state.lock:
        if state.backend is None:
            raise Offloaded()
        t0 = time.perf_counter()
        out = state.backend.transcribe(x, language, prompt)
        return out, (time.perf_counter() - t0) * 1000


@app.post("/asr")
async def asr(
    audio: UploadFile = File(...),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
) -> JSONResponse:
    if state.backend is None:
        return _error(503, "offloaded")
    data = await audio.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        return _error(413, f"upload larger than {MAX_UPLOAD_BYTES // 2**20} MiB")
    if not data:
        return _error(400, "audio is empty")

    def work() -> tuple[dict[str, Any], int, float]:
        x, duration_ms = decode_wav(data)  # outside the lock: decoding runs in parallel
        out, infer_ms = _locked_transcribe(x, language, prompt)
        return out, duration_ms, infer_ms

    state.busy += 1
    try:
        out, duration_ms, infer_ms = await asyncio.get_running_loop().run_in_executor(state.pool, work)
    except BadRequest as e:
        return _error(e.status, e.message)
    except Offloaded:
        return _error(503, "offloaded")
    except Exception as e:
        log.exception("inference failed")
        return _error(500, f"inference failed: {type(e).__name__}: {e}")
    finally:
        state.busy -= 1

    body: dict[str, Any] = {"text": out["text"], "duration_ms": duration_ms}
    if out.get("language"):
        body["language"] = out["language"]
    # Optional fields: present only when the backend knows them (SenseVoice: both; Qwen3: neither).
    if out.get("emotion"):
        body["emotion"] = out["emotion"]
    if out.get("audio_events"):
        body["audio_events"] = out["audio_events"]
    elif "audio_events" in out:
        body["audio_events"] = []
    log.info("asr %dms audio -> %.0fms: %r", duration_ms, infer_ms, out["text"][:60])
    return JSONResponse(body, headers={"X-Inference-Ms": f"{infer_ms:.0f}"})


@app.get("/busy")
async def busy() -> dict[str, int]:
    return {"busy": state.busy}


@app.get("/health")
async def health() -> dict[str, Any]:
    info: dict[str, Any] = {"status": "ok", **state.info, "offloaded": state.backend is None,
                            "loading": state.load is not None, "released_mb": state.released_mb,
                            **(device_memory.fields() if device_memory else {})}
    if state.offloaded:
        info.update(state.offloaded)
    vram = _vram_mb()
    if vram is not None:
        info["vram_allocated_mb"] = vram
    return info


def _vram_mb() -> int | None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        return round(torch.cuda.memory_allocated() / 2**20)
    return None


def _drop() -> None:
    with state.lock:  # waits for the running transcription; the waiting ones see no backend and give up
        pass
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()


class OffloadRequest(BaseModel):
    reason: str | None = None
    max_s: float | None = None


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
    """Until `max_s` from now nobody needs to come back; asking again starts it over, so a reload by
    itself only happens when whoever asked has gone away."""
    if state.auto_reload is not None:
        state.auto_reload.cancel()
    state.auto_reload = asyncio.create_task(_reload_after(max_s)) if max_s > 0 else None
    if state.offloaded is not None:
        state.offloaded["reload_at"] = time.time() + max_s if max_s > 0 else None


@app.post("/offload")
async def offload(req: OffloadRequest | None = None) -> dict[str, Any]:
    req = req or OffloadRequest()
    max_s = req.max_s if req.max_s is not None else float(os.environ.get("ASR_OFFLOAD_MAX_S", "900"))
    if state.load is not None:
        # A reload is under way: stopped, not waited for (see the TTS worker).
        loader = state.loading
        if loader is None:
            return {"state": "reloading", "offload_ms": 0}
        before = device_memory.read() if device_memory else None
        state.backend = None  # it may already be warming up
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, loader.close)
        _lease(max_s)
        released = await loop.run_in_executor(None, _released, before, False)
        return {"state": "offloaded", "offload_ms": 0, "cancelled_reload": True, **released}
    async with state.swap:
        if state.backend is None:
            _lease(max_s)
            return {"state": "offloaded", "offload_ms": 0, "already": True, **(state.offloaded or {})}
        loop = asyncio.get_running_loop()
        t0 = time.perf_counter()
        before, device = _vram_mb(), device_memory.read() if device_memory else None
        state.offloaded = {"since": time.time(), "reason": (req.reason or "")[:80], "reload_at": None}
        # Gone at once, so requests queued for the lock answer 503 instead of running first (the
        # lock is not fair: a busy voice channel would hold the offload off for minutes). Dropped
        # on its own thread: the pool's threads can all be waiting for the lock.
        backend, state.backend = state.backend, None
        close = getattr(backend, "close", None)
        if close is not None:
            await loop.run_in_executor(None, close)
        del backend
        await loop.run_in_executor(None, _drop)
        released = await loop.run_in_executor(None, _released, device)
        ms = (time.perf_counter() - t0) * 1000
        after = _vram_mb()
        log.info("offloaded for %r in %.0f ms: the card gave back %s MB", req.reason, ms, released.get("released_mb"))
        _lease(max_s)
        return {"state": "offloaded", "offload_ms": round(ms), "vram_before_mb": before, "vram_after_mb": after,
                **released}


async def _reload_after(seconds: float) -> None:
    await asyncio.sleep(seconds)
    log.warning("nobody renewed the offload for %.0f s; reloading by itself", seconds)
    state.auto_reload = None
    await reload()


async def _load_again() -> dict[str, Any]:
    t0 = time.perf_counter()
    try:
        await _load()
    except EngineGone:
        log.info("the reload was stopped by an offload")
        return {"state": "offloaded", "cancelled": True}
    finally:
        state.load = state.loading = None
    if state.backend is None:  # stopped during the warm-up
        return {"state": "offloaded", "cancelled": True}
    state.offloaded = None
    ms = (time.perf_counter() - t0) * 1000
    log.info("reloaded in %.0f ms", ms)
    return {"state": "ready", "reload_ms": round(ms), "vram_mb": _vram_mb(), **(device_memory.fields() if device_memory else {})}


@app.post("/reload")
async def reload() -> dict[str, Any]:
    if state.backend is not None:
        return {"state": "ready", "reload_ms": 0, "already": True}
    task, state.auto_reload = state.auto_reload, None
    if task is not None and task is not asyncio.current_task():
        task.cancel()
    if state.load is None:
        state.load = asyncio.ensure_future(_load_again())
    return await asyncio.shield(state.load)


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8001")),
        log_level="info",
    )


if __name__ == "__main__":  # guard needed by vLLM's multiprocessing spawn
    main()
