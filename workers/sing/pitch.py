"""Pitch helpers of the song worker (numpy, imported lazily: the mock needs only ``choose_key``): the F0 cleanup before conversion, and the auto
key that keeps the melody inside her range.

Songs break and high notes crack for three reasons; this file handles two of them:

* **Tracking errors.** RMVPE sometimes jumps an octave for a few frames, spikes, or drops out
  for a frame or two at the top of the range; Seed-VC then renders exactly that (a squeak, a
  break). ``clean_f0`` folds short octave excursions back, median-filters spikes and bridges
  short unvoiced gaps inside a phrase.
* **The harmony hop** (not handled here). A separated vocal often still holds a second voice, and
  RMVPE, trained on one voice at a time, reads whichever is stronger from frame to frame: the
  contour hops between a third or a sixth for a few frames and Seed-VC sings the hops as wrong notes.
  No cleanup of the contour can fix it (the hops are real pitches, and the lead's salience is not
  there to decode: a Viterbi tracker over it was tried and gained nothing), so it is handled
  upstream: ``leadsplit.py`` takes the lead voice out of the vocal stem before anything here runs.
* **Notes she cannot reach.** The model only knows her from speech, so the higher above her
  speaking voice a note is, the worse it sounds. ``choose_key`` picks the octave from the song's
  median *and* its top (95th percentile of voiced F0) against a ceiling, and transposes the
  whole song down a few semitones when the top is still too high.
"""

from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import numpy as np

FRAME_MS = 10.0  # RMVPE at 16 kHz, hop 160


def to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def to_hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)


NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def note_name(midi: float) -> str:
    n = int(round(midi))
    return f"{NOTE_NAMES[n % 12]}{n // 12 - 1}"


def parse_note(text: str) -> float | None:
    """``A5`` / ``C#6`` / ``880`` (Hz) → MIDI number, ``None`` when it is neither."""
    t = text.strip()
    if not t:
        return None
    try:
        hz = float(t)
        return to_midi(hz) if hz > 0 else None
    except ValueError:
        pass
    m = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d)", t)
    if m is None:
        return None
    n = NOTE_NAMES.index(m.group(1).upper()) + {"#": 1, "b": -1, "": 0}[m.group(2)]
    return float(n + 12 * (int(m.group(3)) + 1))


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """``[start, end)`` of each run of True."""
    import numpy as np

    if mask.size == 0:
        return []
    m = np.concatenate(([False], mask, [False])).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def _running_median(x: np.ndarray, window: int) -> np.ndarray:
    import numpy as np

    window = max(1, window | 1)
    if x.size == 0 or window == 1:
        return x.copy()
    half = window // 2
    padded = np.pad(x, (half, half), mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(padded, window), axis=1)


def clean_f0(f0: np.ndarray, frame_ms: float = FRAME_MS, gap_ms: float = 40.0, octave_ms: float = 500.0,
             spike_frames: int = 5) -> np.ndarray:
    """A cleaned copy of an F0 contour (Hz, 0 = unvoiced).

    1. Unvoiced gaps of at most ``gap_ms`` between two voiced frames are bridged (log-linear).
    2. Octave errors: a voiced frame about ±12 (or ±24) semitones away from the running median
       of the voiced frames around it (``octave_ms``) is folded back by whole octaves. Excursions
       shorter than half the window are fixed; a real leap that holds longer becomes the median
       and is kept.
    3. Spikes: a ``spike_frames`` median filter inside each voiced run.
    """
    import numpy as np

    f = np.asarray(f0, dtype=np.float64)
    voiced = f > 1.0
    if int(voiced.sum()) < 3:
        return np.asarray(f0).copy()
    st = np.zeros_like(f)
    st[voiced] = 69.0 + 12.0 * np.log2(f[voiced] / 440.0)

    gap = int(round(gap_ms / frame_ms))
    runs = _runs(voiced)
    for (_, e1), (s2, _) in zip(runs, runs[1:]):
        if 0 < s2 - e1 <= gap:
            st[e1:s2] = np.linspace(st[e1 - 1], st[s2], s2 - e1 + 2)[1:-1]
            voiced[e1:s2] = True

    idx = np.flatnonzero(voiced)
    seq = st[idx]
    ref = _running_median(seq, int(round(octave_ms / frame_ms)))
    diff = seq - ref
    octaves = np.round(diff / 12.0)
    off = (octaves != 0) & (np.abs(diff - 12.0 * octaves) < 3.0)
    seq = np.where(off, seq - 12.0 * octaves, seq)
    st[idx] = seq

    if spike_frames > 1:
        for s, e in _runs(voiced):
            if e - s >= spike_frames:
                st[s:e] = _running_median(st[s:e], spike_frames)

    out = np.zeros_like(f)
    out[voiced] = 440.0 * 2.0 ** ((st[voiced] - 69.0) / 12.0)
    return out.astype(np.asarray(f0).dtype, copy=False)


def f0_stats(f0: np.ndarray) -> tuple[float, float] | None:
    """(median, 95th percentile) of the voiced frames in Hz (log domain), ``None`` when there are
    too few."""
    import numpy as np

    v = np.asarray(f0, dtype=np.float64)
    v = v[v > 1.0]
    if v.size < 20:
        return None
    lv = np.log(v)
    return float(np.exp(np.median(lv))), float(np.exp(np.percentile(lv, 95)))


def choose_key(song_median_hz: float, song_top_hz: float, ref_median_hz: float, *, target_offset: float = 2.0,
               ceiling: float | None = None, ceiling_offset: float = 16.0, key_min: int = -5,
               key_max: int = 3, raise_below: float = 4.0) -> dict[str, Any]:
    """The octave (−12 / 0 / +12) her voice moves by, and a whole-song transposition (``auto_key``,
    ``key_min``..``key_max``, the instrumental moves with it) that keeps the song's top under her
    ceiling.

    Her singing median is ``ref_median_hz`` (her speech) + ``target_offset`` semitones; her
    ceiling is ``ceiling`` (MIDI) or her speech + ``ceiling_offset``. For each octave the key is
    what it needs: over the ceiling → down by as many semitones as that takes (at most
    ``-key_min``); far under her median (more than ``raise_below``) with room left → up a little
    (at most ``key_max``). The octave picked is the cheapest: how far its median lands from hers,
    plus double what stays over the ceiling, plus half a point per semitone of key (moving the
    instrumental costs quality). Ties keep the song where it is.
    """
    target = to_midi(ref_median_hz) + target_offset
    top_limit = ceiling if ceiling is not None else to_midi(ref_median_hz) + ceiling_offset
    m, top = to_midi(song_median_hz), to_midi(song_top_hz)

    def key_for(o: int) -> int:
        over = top + o - top_limit
        if over > 0:
            return max(min(key_min, 0), -int(math.ceil(over - 1e-9)))
        if m + o < target - raise_below and key_max > 0:
            return max(0, min(key_max, int(math.floor(target - (m + o))), int(math.floor(-over))))
        return 0

    def cost(o: int) -> float:
        k = key_for(o)
        return abs(m + o + k - target) + 2.0 * max(0.0, top + o + k - top_limit) + 0.5 * abs(k)

    octave = min((0, -12, 12), key=cost)
    key = key_for(octave)
    return {
        "octave_shift": octave,
        "auto_key": key,
        "target_note": note_name(target),
        "ceiling_note": note_name(top_limit),
        "song_median_note": note_name(m),
        "song_top_note": note_name(top),
        "top_after_note": note_name(top + octave + key),
        "over_ceiling": round(max(0.0, top + octave + key - top_limit), 1),
    }
