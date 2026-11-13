"""Lyrics service: finds synced lyrics for a song, for a song worker that runs on another machine.

It runs where Core's language model and the ASR worker are (it reads ``miyoria.toml`` ``[llm]`` and
asks ``SING_LYRICS_ASR_URL`` to spot-check the lyrics against the lead vocal), so the machine that
makes the songs needs neither a model key nor a route to the ASR worker. The lookup itself is
``workers/sing/lyrics.py`` (title readings, lrclib / NetEase, the language model, the checks), unchanged.

    POST /lyrics   multipart: ``hints`` (JSON), ``duration`` (s, optional), ``fresh`` (0/1, optional),
                   ``audio`` (the lead vocal as a wav, optional: needed for the ASR spot check)
                   -> 200 {"found": false} | {"found": true, "result": {...}}  (``lyrics.search``)
    GET  /health   -> {"ok": true}

Environment: HOST / PORT (default 127.0.0.1 / 8007), the same ``SING_LYRICS_*`` settings as the song
worker (``SING_LYRICS_LLM*``, ``SING_LYRICS_ASR`` / ``SING_LYRICS_ASR_URL``, ``SING_LYRICS_NETEASE``,
``SING_LYRICS_BUDGET_S``), ``LYRICS_CACHE_DIR`` (the language model's answers; default ``data/songs/_lyrics``).
There is no authentication: bind it to a private address (Tailscale) only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "sing"))  # lyrics.py / lyricsllm.py live with the song worker

import lyrics  # noqa: E402

log = logging.getLogger("miyoria.lyrics")
MAX_AUDIO_BYTES = 64 * 1024 * 1024

app = FastAPI(title="miyoria-lyrics")


def cache_dir() -> Path:
    return Path(os.environ.get("LYRICS_CACHE_DIR") or HERE.parent.parent / "data" / "songs" / "_lyrics")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True}


@app.post("/lyrics")
def find(
    hints: str = Form(...),
    duration: float | None = Form(None),
    fresh: int = Form(0),
    audio: UploadFile | None = File(None),
) -> JSONResponse:
    try:
        parsed = json.loads(hints)
    except ValueError:
        return JSONResponse({"error": "hints is not JSON"}, status_code=400)
    if not isinstance(parsed, dict):
        return JSONResponse({"error": "hints must be an object"}, status_code=400)
    with tempfile.TemporaryDirectory(prefix="miyoria-lyrics-") as tmp:
        wav: Path | None = None
        if audio is not None:
            data = audio.file.read(MAX_AUDIO_BYTES + 1)
            if len(data) > MAX_AUDIO_BYTES:
                return JSONResponse({"error": "audio too large"}, status_code=413)
            if data:
                wav = Path(tmp) / "lead.wav"
                wav.write_bytes(data)
        cache = cache_dir()
        cache.mkdir(parents=True, exist_ok=True)
        result = lyrics.search(parsed, duration, cache_dir=cache, audio=wav, fresh=bool(fresh))
    return JSONResponse({"found": result is not None, "result": result})


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8007")))
