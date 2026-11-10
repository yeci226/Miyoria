"""Synced lyrics that are off by a constant amount (sing/lyrics_align.py)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sing"))

import lyrics_align as la  # noqa: E402

RATE = 16000


def _lines(starts: list[float]) -> list[dict]:
    return [{"t": t, "text": f"line {i}"} for i, t in enumerate(starts)]


def _singing(starts: list[float], seconds: float, delay: float, rate: int = RATE) -> np.ndarray:
    """A vocal track that sings 3 s from each start (plus ``delay``), quiet hiss elsewhere."""
    rng = np.random.default_rng(1)
    y = rng.normal(0, 0.001, int(seconds * rate)).astype(np.float32)
    t = np.arange(int(3 * rate)) / rate
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    for s in starts:
        i = int((s + delay) * rate)
        y[i:i + tone.size] += tone[: max(0, y.size - i)]
    return y


STARTS = [10.0, 15.0, 21.0, 26.0, 40.0, 46.0, 51.0, 57.0, 70.0, 75.0]


def test_finds_a_constant_delay():
    vocal = la.vocal_activity(_singing(STARTS, 120, delay=12.0), RATE)
    assert abs(la.best_offset(vocal, _lines(STARTS)) - 12.0) <= 0.2


def test_finds_an_early_start_too():
    vocal = la.vocal_activity(_singing(STARTS, 120, delay=-6.0), RATE)
    assert abs(la.best_offset(vocal, _lines(STARTS)) + 6.0) <= 0.2


def test_continuous_singing_with_a_long_intro():
    # Verses sung without pauses between lines, an interlude, and a video intro of 15 s.
    starts = [8.0, 11.5, 15.0, 18.5, 22.0, 25.5, 45.0, 48.5, 52.0, 55.5, 59.0]
    rng = np.random.default_rng(2)
    y = rng.normal(0, 0.001, 120 * RATE).astype(np.float32)
    for verse in ((8.0, 29.0), (45.0, 62.5)):
        a, b = (int((t + 15.0) * RATE) for t in verse)
        t = np.arange(b - a) / RATE
        y[a:b] += (0.3 * np.sin(2 * np.pi * 330 * t)).astype(np.float32)
    vocal = la.vocal_activity(y, RATE)
    assert abs(la.best_offset(vocal, _lines(starts)) - 15.0) <= 0.3


def test_leaves_lyrics_that_already_fit():
    vocal = la.vocal_activity(_singing(STARTS, 120, delay=0.0), RATE)
    assert la.best_offset(vocal, _lines(STARTS)) == 0.0


def test_too_few_lines_or_no_vocal_is_no_shift(tmp_path):
    assert la.best_offset(np.zeros(0, dtype=np.float32), _lines(STARTS)) == 0.0
    vocal = la.vocal_activity(_singing(STARTS, 120, delay=5.0), RATE)
    assert la.best_offset(vocal, _lines(STARTS[:3])) == 0.0
    assert la.align(None, _lines(STARTS)) == 0.0
    assert la.align(tmp_path / "missing.wav", _lines(STARTS)) == 0.0


def test_shift_lines_never_goes_before_zero():
    assert la.shift_lines(_lines([1.0, 5.0]), -2.0) == [
        {"t": 0.0, "text": "line 0"},
        {"t": 3.0, "text": "line 1"},
    ]
