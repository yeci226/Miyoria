"""Fake Miyoria inference worker — the same HTTP contract as asr/ and tts/, no ML, no GPU.

    python fake_server.py            # http://127.0.0.1:8000, serves BOTH /asr and /tts

Point both [speech.asr.*] and [speech.tts.*] `url`s at it for end-to-end tests.

    POST /asr    multipart audio (WAV, any rate/channels) -> canned text ("FAKE_ASR_TEXT") + the
                 real duration of the upload. Reports emotion "neutral", audio_events [].
    POST /tts    JSON {text, language?, emotion?, instruct?, voice?} -> streamed PCM s16le mono 24 kHz:
                 a sine "voice" — one short tone per non-space character (pitch from the character,
                 shifted by emotion). Streamed per sentence like the real worker.
    POST /turn   raw PCM -> {"complete","probability"}: always FAKE_TURN_PROB (default 0.9).
    WS   /vad    512-sample frames -> speech probability from the frame's loudness.
    GET  /busy   -> {"busy": 0}
    GET  /health

Deterministic length contract (tests rely on it): the body has exactly
``non_whitespace_chars(text) * SAMPLES_PER_CHAR * 2`` bytes.

Env: FAKE_ASR_TEXT, FAKE_TURN_PROB, FAKE_VOICES (comma list, default "deepseek-chan,default"),
     FAKE_TTS_DELAY_MS (sleep per sentence, to emulate synthesis latency), HOST, PORT (8000).
Needs: fastapi, uvicorn, python-multipart (tests also httpx, pytest). Standard library otherwise.
"""

from __future__ import annotations

import asyncio
import io
import math
import os
import re
import sys
import wave
from array import array
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

# Reuse the real worker's sentence splitter so streaming behaves the same.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts"))
from text_split import split_sentences  # noqa: E402

SAMPLE_RATE = 24_000
MS_PER_CHAR = 60
SAMPLES_PER_CHAR = SAMPLE_RATE * MS_PER_CHAR // 1000  # 1440
AMPLITUDE = 0.3
FADE_SAMPLES = SAMPLE_RATE // 100  # 10 ms
_PENTATONIC = (0, 2, 4, 7, 9)
_EMOTION_PITCH = {"happy": 1.2, "smug": 1.1, "annoyed": 0.95, "angry": 1.15, "embarrassed": 1.3, "sad": 0.8}

app = FastAPI(title="Miyoria fake worker")


def _env_voices() -> list[str]:
    return [v.strip() for v in os.environ.get("FAKE_VOICES", "deepseek-chan,default").split(",") if v.strip()]


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


# ── ASR ──────────────────────────────────────────────────────────────────────


@app.post("/asr")
async def asr(
    audio: UploadFile = File(...),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
) -> JSONResponse:
    data = await audio.read()
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            rate, frames = w.getframerate(), w.getnframes()
    except (wave.Error, EOFError) as e:
        return _error(400, f"cannot decode audio as WAV: {e}")
    if rate <= 0 or frames <= 0:
        return _error(400, "audio is empty")
    return JSONResponse(
        {
            "text": os.environ.get("FAKE_ASR_TEXT", "早安,這是假的辨識結果。"),
            "language": (language or "zh").split("-")[0].lower(),
            "emotion": "neutral",
            "audio_events": [],
            "duration_ms": round(frames / rate * 1000),
        }
    )


# ── TTS ──────────────────────────────────────────────────────────────────────


class TtsRequest(BaseModel):
    text: str
    language: str | None = None
    emotion: str | None = None
    instruct: str | None = None
    voice: str | None = None
    priority: str | None = None


def _freq(ch: str, pitch: float) -> float:
    n = ord(ch)
    note = _PENTATONIC[n % 5] + 12 * (n // 5 % 2)
    return 220.0 * 2 ** (note / 12) * pitch


def synth_sentence(sentence: str, pitch: float = 1.0) -> bytes:
    """PCM s16le for one sentence: SAMPLES_PER_CHAR samples per non-whitespace char."""
    out = array("h")
    for ch in sentence:
        if ch.isspace():
            continue
        f = _freq(ch, pitch)
        for i in range(SAMPLES_PER_CHAR):
            env = min(1.0, i / FADE_SAMPLES, (SAMPLES_PER_CHAR - 1 - i) / FADE_SAMPLES)
            out.append(int(32767 * AMPLITUDE * env * math.sin(2 * math.pi * f * i / SAMPLE_RATE)))
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def expected_pcm_bytes(text: str) -> int:
    return len(re.sub(r"\s", "", text)) * SAMPLES_PER_CHAR * 2


@app.post("/tts")
async def tts(req: TtsRequest) -> Response:
    if not req.text.strip():
        return _error(400, "text is empty")
    voices = _env_voices()
    voice = req.voice or voices[0]
    if voice not in voices:
        return _error(404, f"unknown voice {voice!r} (available: {', '.join(voices)})")
    sentences = split_sentences(req.text, min_chars=1)
    if not sentences:
        return _error(400, "text has nothing to speak (punctuation only)")
    pitch = _EMOTION_PITCH.get((req.emotion or "").lower(), 1.0)
    delay = float(os.environ.get("FAKE_TTS_DELAY_MS", "0")) / 1000

    async def body() -> AsyncIterator[bytes]:
        for s in sentences:
            if delay:
                await asyncio.sleep(delay)
            yield synth_sentence(s, pitch)

    return StreamingResponse(
        body(),
        media_type=f"audio/L16; rate={SAMPLE_RATE}; channels=1",
        headers={"X-Sample-Rate": str(SAMPLE_RATE), "X-Tts-Streaming": "sentence", "Cache-Control": "no-store"},
    )


# ── end of turn ──────────────────────────────────────────────────────────────


@app.post("/turn")
async def turn(request: Request) -> JSONResponse:
    await request.body()
    p = float(os.environ.get("FAKE_TURN_PROB", "0.9"))
    return JSONResponse({"complete": p >= 0.5, "probability": p, "inference_ms": 0.0})


@app.websocket("/vad")
async def vad(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            frame = array("h")
            frame.frombytes(await ws.receive_bytes())
            loud = max((abs(s) for s in frame), default=0) > 1000
            await ws.send_text("0.950" if loud else "0.020")
    except WebSocketDisconnect:
        return


@app.get("/busy")
async def busy() -> dict[str, int]:
    return {"busy": 0}


@app.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "model": "fake", "device": "cpu", "voices": _env_voices(), "sample_rate": SAMPLE_RATE,
            "smart_turn": True, "silero": True}


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")), log_level="info")


if __name__ == "__main__":
    main()
