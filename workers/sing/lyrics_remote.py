"""Lyrics from the lyrics service (workers/lyrics) instead of from this machine.

When the song worker runs on another machine than Core, it has neither Core's language model nor the
ASR worker. ``SING_LYRICS_URL`` points it at the lyrics service on Core's machine, which does the lookup
(lyrics.py) and the ASR spot check; the lead vocal goes along as a small mono 16 kHz wav. Aligning the
lyrics to the singing stays here (server.py), because it reads the audio.

Environment: ``SING_LYRICS_URL`` (empty = look up here), ``SING_LYRICS_REMOTE_TIMEOUT_S`` (default 90).
"""

from __future__ import annotations

import io
import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("miyoria.sing.lyrics")


def remote_url() -> str | None:
    return (os.environ.get("SING_LYRICS_URL") or "").strip().rstrip("/") or None


def clip_audio(path: Path, rate: int = 16000) -> bytes | None:
    """The whole lead vocal as a mono 16-bit wav at ``rate`` (what the ASR wants; about 1.9 MB a minute)."""
    try:
        from math import gcd

        import numpy as np
        import soundfile as sf
        from scipy.signal import resample_poly

        x, sr = sf.read(str(path), dtype="float32", always_2d=True)
        mono = np.asarray(x).mean(axis=1)
        if sr != rate:
            g = gcd(int(sr), rate)
            mono = resample_poly(mono, rate // g, int(sr) // g).astype("float32")
        buf = io.BytesIO()
        sf.write(buf, mono, rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    except Exception as e:
        log.info("lyrics audio not prepared: %s", e)
        return None


def search_remote(url: str, hints: dict[str, Any], duration: float | None, audio: Path | None = None,
                  fresh: bool = False, timeout: float | None = None) -> dict[str, Any] | None:
    """``lyrics.search`` done by the lyrics service at ``url``; None when it finds nothing or is unreachable."""
    import httpx

    wait = timeout if timeout is not None else float(os.environ.get("SING_LYRICS_REMOTE_TIMEOUT_S", "90"))
    files: dict[str, Any] = {}
    if audio is not None and audio.exists() and os.environ.get("SING_LYRICS_ASR", "auto") != "0":
        wav = clip_audio(audio)
        if wav:
            files["audio"] = ("lead.wav", wav, "audio/wav")
    data: dict[str, Any] = {"hints": json.dumps(hints, ensure_ascii=False), "fresh": "1" if fresh else "0"}
    if duration:
        data["duration"] = str(duration)
    try:
        r = httpx.post(url + "/lyrics", data=data, files=files or None, timeout=wait)
        if r.status_code != 200:
            log.warning("lyrics service answered HTTP %s", r.status_code)
            return None
        body = r.json()
    except Exception as e:  # best effort, like the local lookup
        log.warning("lyrics service unreachable at %s: %s", url, e)
        return None
    result = body.get("result") if isinstance(body, dict) else None
    return result if isinstance(result, dict) else None
