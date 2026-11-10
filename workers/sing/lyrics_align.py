"""Moves synced lyrics that are off by a constant amount back onto the singing.

Synced LRC found online is timed against *some* release of the song; a video with a long intro, a
talking part or a cut start shifts every line by the same amount, and the length check alone does
not notice (the song is as long, it just starts later). ``best_offset`` compares when the singer
is singing (energy of the separated lead / vocal track) with when the lyrics say a line is being
sung, for shifts within ``max_shift_s``, and returns the shift that fits best when it fits clearly
better than none. ``shift_lines`` applies it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("sing.lyrics_align")

#: Frames per second of the comparison.
FPS = 10
#: Shifts tried, both ways (seconds).
MAX_SHIFT_S = 45.0
#: A line is taken to be sung for at most this long (or until the next line).
MAX_LINE_S = 8.0
#: The best shift must fit this much better than no shift (relative), and be at least this long.
MIN_GAIN = 0.15
MIN_SHIFT_S = 0.5


def vocal_activity(samples: np.ndarray, rate: int, fps: int = FPS) -> np.ndarray:
    """1 where the vocal track is clearly singing, 0 elsewhere, at ``fps`` frames per second."""
    hop = max(int(rate // fps), 1)
    frames = samples.size // hop
    if frames == 0:
        return np.zeros(0, dtype=np.float32)
    x = samples[: frames * hop].astype(np.float32).reshape(frames, hop)
    rms = np.sqrt(np.mean(x * x, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    loud = np.percentile(db, 95)
    # Singing: within 25 dB of the loud parts (separation leaves a quiet bed behind).
    return (db > loud - 25).astype(np.float32)


def lyric_activity(lines: list[dict[str, Any]], frames: int, fps: int = FPS) -> np.ndarray:
    """1 where a (non-empty) line is being sung according to the lyrics: until the next line, but
    no longer than a typical line of this song (so the last line before an interlude does not
    seem to go on into it)."""
    out = np.zeros(frames, dtype=np.float32)
    gaps = np.diff([float(l["t"]) for l in lines])
    gaps = gaps[gaps > 0]
    typical = float(np.median(gaps)) * 1.25 if gaps.size else MAX_LINE_S
    longest = min(max(typical, 2.0), MAX_LINE_S)
    for i, line in enumerate(lines):
        if not str(line.get("text", "")).strip():
            continue
        start = float(line["t"])
        nxt = float(lines[i + 1]["t"]) if i + 1 < len(lines) else start + longest
        end = min(nxt, start + longest)
        a, b = int(start * fps), int(end * fps)
        if b > 0 and a < frames:
            out[max(a, 0):min(b, frames)] = 1.0
    return out


def _blur(x: np.ndarray, width: int = 2) -> np.ndarray:
    kernel = np.concatenate([np.arange(1, width + 2), np.arange(width, 0, -1)]).astype(np.float32)
    return np.convolve(x, kernel / kernel.sum(), mode="same")


def _onsets(activity: np.ndarray) -> np.ndarray:
    """Where singing starts (rising edges), blurred a little."""
    rise = np.maximum(np.diff(activity, prepend=0.0), 0.0)
    return _blur(rise)


def _line_onsets(lines: list[dict[str, Any]], frames: int, fps: int) -> np.ndarray:
    out = np.zeros(frames, dtype=np.float32)
    for line in lines:
        if not str(line.get("text", "")).strip():
            continue
        i = int(round(float(line["t"]) * fps))
        if 0 <= i < frames:
            out[i] = 1.0
    return _blur(out)


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    return 0.0 if na == 0 or nb == 0 else float(np.dot(a, b) / (na * nb))


def best_offset(vocal: np.ndarray, lines: list[dict[str, Any]], fps: int = FPS,
                max_shift_s: float = MAX_SHIFT_S) -> float:
    """The shift (seconds, positive = the singing comes later than the lyrics say) that lines the
    lyrics up with ``vocal``, or 0.0 when none fits clearly better.

    Two things are compared for every shift: when singing starts against when lines start (precise,
    but a song's lines come at similar gaps) and when there is singing at all against when the
    lyrics have a line going (catches the long intro / interlude that tells the gaps apart).
    """
    if vocal.size == 0 or sum(1 for l in lines if str(l.get("text", "")).strip()) < 4:
        return 0.0
    v = vocal - vocal.mean()
    v_on = _onsets(vocal)
    span = int(max_shift_s * fps)
    scores: list[tuple[float, int]] = []
    for k in range(-span, span + 1):
        shifted = [{**l, "t": float(l["t"]) + k / fps} for l in lines]
        lyr = lyric_activity(shifted, vocal.size, fps)
        if not lyr.any():
            continue
        score = _cos(v, lyr - lyr.mean()) + _cos(v_on, _line_onsets(shifted, vocal.size, fps))
        scores.append((score, k))
    if not scores:
        return 0.0
    zero = next((s for s, k in scores if k == 0), 0.0)
    best, k = max(scores)
    if abs(k) / fps < MIN_SHIFT_S or best <= 0:
        return 0.0
    if zero > 0 and best < zero * (1 + MIN_GAIN):
        return 0.0
    return round(k / fps, 2)

def shift_lines(lines: list[dict[str, Any]], offset: float) -> list[dict[str, Any]]:
    """``lines`` with every time moved by ``offset`` seconds (never before 0)."""
    return [{**l, "t": round(max(0.0, float(l["t"]) + offset), 3)} for l in lines]


def align(heard: Path | None, lines: list[dict[str, Any]]) -> float:
    """The offset of ``lines`` against the vocal file ``heard`` (0.0 when it cannot tell). Never raises."""
    if heard is None or not lines:
        return 0.0
    try:
        import soundfile as sf

        samples, rate = sf.read(str(heard), dtype="float32", always_2d=True)
        return best_offset(vocal_activity(samples.mean(axis=1), int(rate)), lines)
    except Exception as e:  # noqa: BLE001 - alignment is a nicety, never a failure
        log.info("cannot align lyrics with %s: %s", heard, e)
        return 0.0
