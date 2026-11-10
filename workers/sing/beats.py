"""The beat of a finished song, so she can sway and nod with it while she sings.

``beat_meta(pcm, rate)`` reads the mix as it is streamed (``play_mix.pcm``, s16le mono) and
returns ``{"bpm": 128.0, "times": [0.42, 0.89, ...]}`` (seconds from the start of the playback)
or ``None`` when no steady beat is found (a ballad without drums, speech, silence). librosa's
beat tracker is used when it is installed; otherwise a small numpy tracker (onset strength,
tempo by autocorrelation, phase by the strongest grid) does the same, more roughly.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("sing.beats")

#: Tempos outside this range are not believed (half / double tempo errors aside).
MIN_BPM = 50.0
MAX_BPM = 220.0
#: Fewer beats than this is not a beat.
MIN_BEATS = 8
#: Rate the analysis runs at.
ANALYSIS_RATE = 11025
HOP = 256


def beat_meta(pcm: Path, rate: int) -> dict[str, Any] | None:
    """The song's beat grid, or ``None``. Never raises."""
    try:
        y = np.fromfile(pcm, dtype="<i2").astype(np.float32) / 32768.0
        return beat_grid(y, rate)
    except Exception as e:  # noqa: BLE001 - a missing beat must never fail a song
        log.warning("no beat for %s: %s", pcm, e)
        return None


def beat_grid(y: np.ndarray, rate: int) -> dict[str, Any] | None:
    """Beat grid of mono samples ``y`` at ``rate`` (see ``beat_meta``)."""
    if y.size < rate * 4:
        return None
    try:
        import librosa  # type: ignore[import-not-found]
    except ImportError:
        librosa = None
    if librosa is not None:
        z = librosa.resample(y, orig_sr=rate, target_sr=ANALYSIS_RATE)
        tempo, times = librosa.beat.beat_track(y=z, sr=ANALYSIS_RATE, hop_length=HOP, units="time")
        bpm = float(np.atleast_1d(tempo)[0])
        return _checked(bpm, [float(t) for t in times])
    return _checked(*_numpy_grid(y, rate))


def _checked(bpm: float, times: list[float]) -> dict[str, Any] | None:
    if not (MIN_BPM <= bpm <= MAX_BPM) or len(times) < MIN_BEATS:
        return None
    return {"bpm": round(bpm, 1), "times": [round(t, 3) for t in times]}


def _onset_strength(y: np.ndarray, rate: int) -> tuple[np.ndarray, float]:
    """Half-wave rectified spectral flux per frame, and frames per second."""
    step = max(int(rate // ANALYSIS_RATE), 1)
    z = y[::step]
    sr = rate / step
    n_fft = 1024
    if z.size < n_fft * 2:
        return np.zeros(0), sr / HOP
    frames = 1 + (z.size - n_fft) // HOP
    idx = np.arange(n_fft)[None, :] + HOP * np.arange(frames)[:, None]
    window = np.hanning(n_fft).astype(np.float32)
    mag = np.log1p(np.abs(np.fft.rfft(z[idx] * window, axis=1)))
    flux = np.maximum(np.diff(mag, axis=0), 0.0).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")  # take out the slow loudness
    return np.maximum(flux, 0.0), sr / HOP


def _numpy_grid(y: np.ndarray, rate: int) -> tuple[float, list[float]]:
    env, fps = _onset_strength(y, rate)
    if env.size < 64 or not np.any(env > 0):
        return 0.0, []
    env = env / (env.max() + 1e-9)
    lo = int(fps * 60 / MAX_BPM)
    hi = int(fps * 60 / MIN_BPM)
    ac = np.correlate(env, env, mode="full")[env.size - 1:]
    if hi >= ac.size:
        return 0.0, []
    lags = np.arange(lo, hi + 1)
    # Prefer tempos near 120 BPM a little (the usual half / double tempo ambiguity).
    bpms = fps * 60 / lags
    weight = np.exp(-0.5 * (np.log2(bpms / 120.0) / 1.0) ** 2)
    period = int(lags[np.argmax(ac[lo:hi + 1] * weight)])
    phase = int(np.argmax([env[p::period].sum() for p in range(period)]))
    frames = np.arange(phase, env.size, period)
    return float(fps * 60 / period), [float(f / fps) for f in frames]
