"""Miyoria end-of-turn worker: Silero VAD + Smart Turn v3 (docs/protocols/voice-link.md, "判斷講完").

    POST /turn    body: raw PCM s16le mono 16 kHz, the speaker's turn up to now (the end matters;
                  anything over 8 s is ignored) -> {"complete","probability","inference_ms"}
    WS   /vad     binary messages of 512 samples PCM s16le mono 16 kHz, one per Silero frame; every
                  message is answered with a text message holding the speech probability. One
                  connection per audio stream (the model is recurrent).
    GET  /health  -> {"status":"ok","smart_turn":bool,"silero":bool,...}

Both models run on the CPU through ONNX Runtime: no GPU, no PyTorch. A model that is missing or
broken leaves the worker running, its endpoint answers 503 (or closes the socket) and Core falls
back to what it did before: the silence timeout and the energy detector.

Model files are not downloaded here, see workers/README.md section 10.

Environment
    TURN_SMART_MODEL   path of smart-turn-v3.*-cpu.onnx      (default ../models/smart-turn/smart-turn-v3.2-cpu.onnx)
    TURN_SILERO_MODEL  path of silero_vad.onnx               (default ../models/silero-vad/silero_vad.onnx)
    TURN_THRESHOLD     probability from which a turn is complete (default 0.5)
    TURN_THREADS       ONNX Runtime threads of Smart Turn    (default 2)
    TURN_POOL_SIZE     threads for Smart Turn requests       (default 2)
    HOST / PORT        bind address                          (default 127.0.0.1 / 8006)
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import SAMPLE_RATE  # noqa: E402
from models import FRAME, SileroVad, SmartTurn, load  # noqa: E402

log = logging.getLogger("miyoria.turn")

HERE = Path(__file__).resolve().parent
MAX_BODY_BYTES = 2 * SAMPLE_RATE * 30


def _threshold() -> float:
    return float(os.environ.get("TURN_THRESHOLD", "0.5"))


class State:
    smart: SmartTurn | None = None
    silero: SileroVad | None = None
    errors: dict[str, str]
    turn_pool: ThreadPoolExecutor
    vad_pool: ThreadPoolExecutor


state = State()


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.errors = {}
    smart_path = os.environ.get("TURN_SMART_MODEL", str(HERE.parent / "models/smart-turn/smart-turn-v3.2-cpu.onnx"))
    silero_path = os.environ.get("TURN_SILERO_MODEL", str(HERE.parent / "models/silero-vad/silero_vad.onnx"))
    state.smart, why = load(SmartTurn, smart_path, int(os.environ.get("TURN_THREADS", "2")))
    if why:
        state.errors["smart_turn"] = why
        log.warning("Smart Turn is off: %s", why)
    state.silero, why = load(SileroVad, silero_path)
    if why:
        state.errors["silero"] = why
        log.warning("Silero VAD is off: %s", why)
    # Separate pools: a Smart Turn call (tens of ms) must not hold up the frames of the VAD.
    state.turn_pool = ThreadPoolExecutor(int(os.environ.get("TURN_POOL_SIZE", "2")), thread_name_prefix="turn")
    state.vad_pool = ThreadPoolExecutor(2, thread_name_prefix="vad")
    yield
    state.turn_pool.shutdown(wait=False, cancel_futures=True)
    state.vad_pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Miyoria end-of-turn worker", lifespan=lifespan)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def pcm_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


@app.post("/turn")
async def turn(request: Request) -> JSONResponse:
    smart = state.smart
    if smart is None:
        return _error(503, f"smart turn is not loaded: {state.errors.get('smart_turn', 'unknown')}")
    rate = request.headers.get("x-sample-rate", str(SAMPLE_RATE))
    if rate != str(SAMPLE_RATE):
        return _error(400, f"audio must be {SAMPLE_RATE} Hz, not {rate}")
    data = await request.body()
    if len(data) > MAX_BODY_BYTES:
        return _error(413, f"body larger than {MAX_BODY_BYTES} bytes")
    if len(data) < 2 or len(data) % 2:
        return _error(400, "body must be s16le PCM")
    audio = pcm_to_float(data)
    t0 = time.perf_counter()
    try:
        p = await asyncio.get_running_loop().run_in_executor(state.turn_pool, smart.probability, audio)
    except Exception as e:  # noqa: BLE001
        log.exception("smart turn failed")
        return _error(500, f"inference failed: {type(e).__name__}: {e}")
    ms = (time.perf_counter() - t0) * 1000
    return JSONResponse({"complete": p >= _threshold(), "probability": round(p, 4), "inference_ms": round(ms, 1)})


@app.websocket("/vad")
async def vad(ws: WebSocket) -> None:
    await ws.accept()
    silero = state.silero
    if silero is None:
        await ws.close(code=1011, reason="silero is not loaded")
        return
    stream = silero.stream()
    loop = asyncio.get_running_loop()
    try:
        while True:
            data = await ws.receive_bytes()
            if len(data) != FRAME * 2:
                await ws.close(code=1003, reason=f"frames are {FRAME} samples")
                return
            p = await loop.run_in_executor(state.vad_pool, stream.step, pcm_to_float(data))
            await ws.send_text(f"{p:.3f}")
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001 - Core falls back to the energy detector when the socket closes
        log.exception("silero failed")
        await ws.close(code=1011)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "smart_turn": state.smart is not None,
        "silero": state.silero is not None,
        "threshold": _threshold(),
        "errors": state.errors,
    }


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8006")), log_level="info")


if __name__ == "__main__":
    main()
