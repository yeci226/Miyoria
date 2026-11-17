"""Lyrics service: finds synced lyrics for a song, for a song worker on another machine that has not joined.

A song worker on a machine that joined the cluster does its lyrics itself and asks Core through its hostd for
the language model and the ASR spot check; it does not need this service. This one stays for a setup that has
not moved (the song worker's ``SING_LYRICS_URL``). It does not read Core's config: the lookup
(``workers/sing/lyrics.py``: title readings, lrclib / NetEase, the language model, the checks) gets its model
and its ASR the same way the song worker does: through hostd when hostd runs this service, else from the
explicit ``SING_LYRICS_LLM_URL`` / ``_KEY`` / ``_MODEL`` and ``SING_LYRICS_ASR_URL`` (default the ASR worker
on this machine, ``http://127.0.0.1:8003``).

    POST /lyrics   multipart: ``hints`` (JSON), ``duration`` (s, optional), ``fresh`` (0/1, optional),
                   ``audio`` (the lead vocal as a wav, optional: needed for the ASR spot check)
                   -> 200 {"found": false} | {"found": true, "result": {...}}  (``lyrics.search``)
    GET  /health   -> {"ok": true}

Environment: HOST / PORT (default 127.0.0.1 / 8007), the same ``SING_LYRICS_*`` settings as the song
worker (``SING_LYRICS_LLM*``, ``SING_LYRICS_ASR`` / ``SING_LYRICS_ASR_URL``, ``SING_LYRICS_NETEASE``,
``SING_LYRICS_BUDGET_S``), ``LYRICS_CACHE_DIR`` (the language model's answers; default ``data/songs/_lyrics``).
Started by hand (no ``MIYORIA_SERVICE_TOKEN``) there is no authentication: bind it to a private address
(Tailscale) only.
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
sys.path.insert(1, str(HERE.parent))  # service_auth.py, shared by the workers

import lyrics  # noqa: E402

try:
    import service_auth
except ImportError:  # never run open: with a token set, no check means no service
    if os.environ.get("MIYORIA_SERVICE_TOKEN") or os.environ.get("MIYORIA_HOST_TOKEN"):
        raise SystemExit("MIYORIA_SERVICE_TOKEN or MIYORIA_HOST_TOKEN is set but service_auth.py cannot be "
                         "imported: refusing to start without the token check")
    service_auth = None

log = logging.getLogger("miyoria.lyrics")
MAX_AUDIO_BYTES = 64 * 1024 * 1024

app = FastAPI(title="miyoria-lyrics")
if service_auth is not None:
    service_auth.install(app)  # every route needs the bearer token when hostd set one


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
