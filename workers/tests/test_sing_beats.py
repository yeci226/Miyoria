"""The beat grid of a song (sing/beats.py): numpy tracker on a click track, and the guards."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sing"))

import beats  # noqa: E402

RATE = 48000


def _clicks(bpm: float, seconds: float, rate: int = RATE) -> np.ndarray:
    y = np.zeros(int(seconds * rate), dtype=np.float32)
    period = 60.0 / bpm
    t = np.arange(int(0.02 * rate)) / rate
    click = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t * 200)).astype(np.float32)
    at = 0.5
    while at < seconds - 0.05:
        i = int(at * rate)
        y[i:i + click.size] += click[: y.size - i]
        at += period
    return y


def test_numpy_tracker_finds_the_tempo_of_a_click_track():
    bpm, times = beats._numpy_grid(_clicks(120, 20), RATE)
    assert abs(bpm - 120) < 4
    assert len(times) > 30
    gaps = np.diff(times)
    assert abs(float(np.median(gaps)) - 0.5) < 0.03
    # on the clicks, not between them
    assert min(abs((times[5] - 0.5) / 0.5 - round((times[5] - 0.5) / 0.5)), 1) < 0.15


def test_checked_drops_implausible_grids():
    assert beats._checked(30.0, [float(i) for i in range(20)]) is None
    assert beats._checked(120.0, [0.5, 1.0]) is None
    assert beats._checked(120.04, [0.12345] * 8) == {"bpm": 120.0, "times": [0.123] * 8}


def test_silence_and_short_audio_have_no_beat(tmp_path):
    assert beats.beat_grid(np.zeros(RATE * 10, dtype=np.float32), RATE) is None
    assert beats.beat_grid(np.zeros(RATE, dtype=np.float32), RATE) is None
    assert beats.beat_meta(tmp_path / "missing.pcm", RATE) is None


def test_beat_meta_reads_the_played_pcm(tmp_path):
    pcm = tmp_path / "play_mix.pcm"
    (_clicks(100, 20) * 20000).astype("<i2").tofile(pcm)
    meta = beats.beat_meta(pcm, RATE)
    assert meta is not None
    assert 90 <= meta["bpm"] <= 110 or 190 <= meta["bpm"] <= 210 or 45 <= meta["bpm"] <= 55
    assert len(meta["times"]) >= beats.MIN_BEATS
