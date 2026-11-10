"""Whisper log-mel features for Smart Turn, in plain NumPy.

Smart Turn's reference code gets these from `transformers.WhisperFeatureExtractor(chunk_length=8)`
with ``do_normalize=True``. That package is a lot to install for one spectrogram, so this is the
same computation: the audio is cut or left-padded to 8 seconds, normalised to zero mean and unit
variance, and turned into an 80 x 800 log-mel matrix. tests/test_turn_worker.py compares it with
transformers when transformers is installed.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16_000
SECONDS = 8
N_SAMPLES = SAMPLE_RATE * SECONDS
N_FFT = 400
HOP = 160
N_MELS = 80


def _hz_to_mel(hz: float) -> float:
    """The Slaney scale: linear below 1 kHz, logarithmic above."""
    if hz < 1000.0:
        return 3.0 * hz / 200.0
    return 15.0 + float(np.log(hz / 1000.0)) * 27.0 / float(np.log(6.4))


def _mel_to_hz(mel: np.ndarray) -> np.ndarray:
    mel = np.asarray(mel, dtype=np.float64)
    logstep = np.log(6.4) / 27.0
    return np.where(mel >= 15.0, 1000.0 * np.exp(logstep * (mel - 15.0)), 200.0 * mel / 3.0)


def mel_filters() -> np.ndarray:
    """Slaney-normalised triangular filters, shape (N_FFT // 2 + 1, N_MELS)."""
    bins = N_FFT // 2 + 1
    fft_freqs = np.linspace(0, SAMPLE_RATE // 2, bins)
    edges = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(8000.0), N_MELS + 2))
    delta = np.diff(edges)
    slopes = edges[None, :] - fft_freqs[:, None]
    down = -slopes[:, :-2] / delta[:-1]
    up = slopes[:, 2:] / delta[1:]
    filters = np.maximum(0.0, np.minimum(down, up))
    return filters * (2.0 / (edges[2:] - edges[:-2]))[None, :]


_WINDOW = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)
_FILTERS = mel_filters()


def fit_to_window(audio: np.ndarray) -> np.ndarray:
    """The last 8 seconds; shorter audio is padded at the front, so it ends where the window ends."""
    if audio.size >= N_SAMPLES:
        return audio[-N_SAMPLES:]
    return np.concatenate([np.zeros(N_SAMPLES - audio.size, dtype=audio.dtype), audio])


def log_mel(audio: np.ndarray) -> np.ndarray:
    """float audio at 16 kHz -> (1, 80, 800) float32, ready for the model's ``input_features``."""
    x = fit_to_window(np.asarray(audio, dtype=np.float32)).astype(np.float64)
    x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    padded = np.pad(x, N_FFT // 2, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
    power = np.abs(np.fft.rfft(frames * _WINDOW, axis=1)) ** 2
    mel = np.maximum(power @ _FILTERS, 1e-10)
    spec = np.log10(mel).T[:, :-1]
    spec = np.maximum(spec, spec.max() - 8.0)
    return ((spec + 4.0) / 4.0).astype(np.float32)[None]
