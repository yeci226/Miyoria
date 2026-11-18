"""The karaoke reference melody from the lead vocal's pitch (docs/design/karaoke.md §3.2). Pure numpy:
no torch, no audio files, so every rule here is tested on synthetic curves.

    RMVPE F0 (10 ms, Hz, 0 = unvoiced)  ->  gate by the lead's loudness  ->  pitch.clean_f0
        ->  ``curve``: 50 Hz MIDI with a fraction, ``None`` unvoiced   (reference.json ``pitch``)
        ->  ``cut_notes``: stable-pitch runs                            (reference.json ``notes``)
        ->  ``quality``: can the song be sung at all                    (reference.json ``quality``)

The notes are only a guide on screen: the score compares the singer's curve with this curve, never
with the notes (owner 2026-11-17), so a note cut wrong costs nobody anything. This milestone has no
note model: every note is cut from the pitch alone (``source: "pitch"``, ``made.notes`` =
``NOTES_METHOD``). Notes cut by the lyrics' characters come later and replace these line by line.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from pitch import FRAME_MS, _running_median, _runs, clean_f0

# ── the curve ────────────────────────────────────────────────────────────────

# Frames per second of the reference curve and of a singer's submitted track (karaoke.ts KARAOKE_FRAME_HZ).
CURVE_HZ = 50
# RMVPE frames (10 ms) per curve frame.
CURVE_STEP = int(round(1000 / CURVE_HZ / FRAME_MS))
# A frame this far (dB) below the lead's typical loudness (the median of its voiced frames) is not
# voiced, whatever RMVPE says: the separation leaves the lead's track with bleed of the band and
# the backing voices at a low level, and RMVPE gives that a pitch too.
RMS_GATE_DB = 30.0
# Decimals of the MIDI values written out (1/100 of a semitone is a cent).
MIDI_DECIMALS = 2

# ── the notes (``cut_notes``) ────────────────────────────────────────────────

# The name of these rules in reference.json ``made.notes``; change it when the rules change.
NOTES_METHOD = "pitch-runs-1"
# The semitone curve is median-filtered over this long before it is cut (inside each voiced run):
# vibrato and tracking jitter must not start new notes.
SMOOTH_S = 0.10
# A new note starts where the smoothed pitch leaves the current note's centre (the median of the
# note so far) by more than this many semitones...
SPLIT_SEMITONES = 0.65
# ...and stays away at least this long; a shorter excursion (a scoop, a slide into the next
# syllable) belongs to the note it left.
SPLIT_HOLD_S = 0.06
# An unvoiced gap up to this long inside a note (a consonant) is bridged when the pitch on the far
# side is still the note's; a longer gap, or another pitch after it, ends the note.
GAP_BRIDGE_S = 0.12
# Notes shorter than this are dropped (blips, a breath read as a pitch).
MIN_NOTE_S = 0.08
# A run longer than this is split into equal parts: a guide bar on screen should move, and a held
# note in a karaoke video is drawn in pieces too.
MAX_NOTE_S = 4.0

# ── quality ──────────────────────────────────────────────────────────────────

# The lead must be voiced in at least this share of the song...
MIN_VOICED_RATIO = 0.15
# ...and give at least this many notes, or the song is not offered (§3.2: no melody found).
MIN_NOTES = 30


def to_midi(hz: np.ndarray) -> np.ndarray:
    """Hz to MIDI note numbers with a fraction (A4 = 440 Hz = 69); NaN where ``hz`` is not positive."""
    f = np.asarray(hz, dtype=np.float64)
    out = np.full(f.shape, np.nan)
    ok = f > 1.0
    out[ok] = 69.0 + 12.0 * np.log2(f[ok] / 440.0)
    return out


def frame_rms(mono: np.ndarray, sr: int, frame_ms: float = FRAME_MS) -> np.ndarray:
    """RMS of ``mono`` per ``frame_ms`` hop, frame ``i`` centred on sample ``i * hop`` (as RMVPE's
    frames are), window two hops wide."""
    x = np.asarray(mono, dtype=np.float64)
    hop = max(1, int(round(sr * frame_ms / 1000)))
    n = x.size // hop + 1
    padded = np.pad(x, (hop, hop + n * hop - x.size))
    sq = np.concatenate(([0.0], np.cumsum(padded * padded)))
    starts = np.arange(n) * hop  # (i * hop - hop) in the original, shifted by the pad
    total = sq[starts + 2 * hop] - sq[starts]
    return np.sqrt(np.maximum(total, 0.0) / (2 * hop))


def gate_by_loudness(f0: np.ndarray, rms: np.ndarray | None, gate_db: float = RMS_GATE_DB) -> np.ndarray:
    """A copy of ``f0`` with the frames far below the lead's typical loudness set unvoiced (0).
    ``rms`` per F0 frame (``frame_rms``); a shorter one leaves the frames after it alone."""
    f = np.asarray(f0, dtype=np.float64).copy()
    if rms is None:
        return f
    r = np.asarray(rms, dtype=np.float64)[: f.size]
    db = 20.0 * np.log10(np.maximum(r, 1e-9))
    voiced = f[: r.size] > 1.0
    if not voiced.any():
        return f
    typical = float(np.median(db[voiced]))
    quiet = np.zeros(f.size, dtype=bool)
    quiet[: r.size] = db < typical - gate_db
    f[quiet] = 0.0
    return f


def downsample(midi_10ms: np.ndarray, step: int = CURVE_STEP) -> np.ndarray:
    """``step`` frames into one: the mean of the voiced ones (in semitones), NaN when none is."""
    m = np.asarray(midi_10ms, dtype=np.float64)
    n = int(math.ceil(m.size / step)) if m.size else 0
    padded = np.full(n * step, np.nan)
    padded[: m.size] = m
    blocks = padded.reshape(n, step) if n else padded.reshape(0, step)
    voiced = ~np.isnan(blocks)
    count = voiced.sum(axis=1)
    total = np.where(voiced, blocks, 0.0).sum(axis=1)
    out = np.full(n, np.nan)
    out[count > 0] = total[count > 0] / count[count > 0]
    return out


def curve(f0_10ms: np.ndarray, rms_10ms: np.ndarray | None = None, frames: int | None = None,
          gate_db: float = RMS_GATE_DB, clean: bool = True) -> np.ndarray:
    """The reference curve: RMVPE F0 at 10 ms (Hz, 0 unvoiced) → gated by the lead's loudness →
    ``pitch.clean_f0`` (octave errors, spikes, dropouts) → 50 Hz MIDI, NaN unvoiced. ``frames``:
    the length to cut or pad it to (the backing track's), unvoiced past the end of the F0."""
    f = gate_by_loudness(f0_10ms, rms_10ms, gate_db)
    if clean:
        f = np.asarray(clean_f0(f), dtype=np.float64)
    out = downsample(to_midi(f))
    if frames is not None:
        if out.size >= frames:
            out = out[:frames]
        else:
            out = np.concatenate((out, np.full(frames - out.size, np.nan)))
    return out


def curve_json(midi: np.ndarray, decimals: int = MIDI_DECIMALS) -> list[float | None]:
    """The curve as reference.json writes it: rounded floats, ``None`` unvoiced."""
    return [None if math.isnan(v) else round(float(v), decimals) for v in np.asarray(midi, dtype=np.float64)]


# ── the notes ────────────────────────────────────────────────────────────────


@dataclass
class Note:
    start: float  # seconds
    end: float
    midi: float

    def json(self) -> dict[str, Any]:
        """A ``WorkersKaraokeNote`` cut from the pitch alone."""
        return {"start": round(self.start, 3), "end": round(self.end, 3), "midi": round(self.midi, MIDI_DECIMALS),
                "source": "pitch", "line": None, "char": None}


def _frames(seconds: float, hz: float) -> int:
    return max(1, int(round(seconds * hz)))


def _smooth(midi: np.ndarray, window: int) -> np.ndarray:
    """``midi`` median-filtered inside each voiced run (unvoiced frames stay NaN)."""
    out = midi.copy()
    for s, e in _runs(~np.isnan(midi)):
        out[s:e] = _running_median(midi[s:e], window)
    return out


def _runs_of(midi: np.ndarray, hz: float) -> list[tuple[int, int]]:
    """``[start, end)`` frames of each stable-pitch run, before the length rules."""
    voiced = ~np.isnan(midi)
    smooth = _smooth(midi, _frames(SMOOTH_S, hz))
    hold = _frames(SPLIT_HOLD_S, hz)
    gap_max = int(math.floor(GAP_BRIDGE_S * hz + 1e-9))
    runs: list[tuple[int, int]] = []
    start: int | None = None  # the note under way
    last = -1  # its last voiced frame (pending excursion frames included)
    accepted: list[float] = []  # its smoothed values, the centre's input
    away: list[int] = []  # frames in a row away from the centre, not yet a note of their own

    def close(end: int) -> None:
        nonlocal start
        if start is not None and end > start:
            runs.append((start, end))
        start = None

    for i in range(midi.size):
        if not voiced[i]:
            if start is not None and i - last > gap_max:
                accepted.extend(smooth[j] for j in away)
                away.clear()
                close(last + 1)
            continue
        v = float(smooth[i])
        if start is None:
            start, last, accepted, away = i, i, [v], []
            continue
        centre = float(np.median(accepted))
        if i - last > 1:  # back from a short gap: the same note only at the same pitch
            accepted.extend(smooth[j] for j in away)
            away.clear()
            if abs(v - float(np.median(accepted))) <= SPLIT_SEMITONES:
                accepted.append(v)
                last = i
            else:
                close(last + 1)
                start, last, accepted = i, i, [v]
            continue
        last = i
        if abs(v - centre) > SPLIT_SEMITONES:
            away.append(i)
            if len(away) >= hold:
                close(away[0])
                start, accepted = away[0], [float(smooth[j]) for j in away]
                away = []
        else:
            accepted.extend(smooth[j] for j in away)
            away.clear()
            accepted.append(v)
    if start is not None:
        close(last + 1)
    return runs


def cut_notes(midi: Sequence[float | None] | np.ndarray, hz: float = CURVE_HZ, start_s: float = 0.0) -> list[Note]:
    """Notes cut from the pitch alone (the fallback rule; constants at the top of this file).

    On the curve (``hz`` frames per second, NaN / ``None`` unvoiced): the semitones median-filtered
    over SMOOTH_S, cut into stable-pitch runs with hysteresis (a new note where the pitch leaves the
    note's centre by more than SPLIT_SEMITONES for SPLIT_HOLD_S), unvoiced gaps up to GAP_BRIDGE_S
    bridged at the same pitch, runs shorter than MIN_NOTE_S dropped, runs longer than MAX_NOTE_S
    split into equal parts. A note's pitch is the median of its voiced frames of the curve itself
    (not the smoothed one)."""
    m = np.array([np.nan if v is None else float(v) for v in midi], dtype=np.float64) \
        if not isinstance(midi, np.ndarray) else np.asarray(midi, dtype=np.float64)
    min_frames = _frames(MIN_NOTE_S, hz)
    max_frames = _frames(MAX_NOTE_S, hz)
    notes: list[Note] = []
    for s, e in _runs_of(m, hz):
        if e - s < min_frames:
            continue
        parts = int(math.ceil((e - s) / max_frames))
        edges = [s + round(k * (e - s) / parts) for k in range(parts + 1)]
        for a, b in zip(edges, edges[1:]):
            values = m[a:b][~np.isnan(m[a:b])]
            if b - a < 1 or values.size == 0:
                continue
            notes.append(Note(start_s + a / hz, start_s + b / hz, float(np.median(values))))
    return notes


# ── quality ──────────────────────────────────────────────────────────────────


def quality(midi: np.ndarray, notes: int, lead_split: bool, min_voiced: float = MIN_VOICED_RATIO,
            min_notes: int = MIN_NOTES) -> dict[str, Any]:
    """``WorkersKaraokeQuality``: ``ok`` false with a short reason when the lead is voiced in less
    than ``min_voiced`` of the song or there are fewer than ``min_notes`` notes."""
    m = np.asarray(midi, dtype=np.float64)
    ratio = float((~np.isnan(m)).sum() / m.size) if m.size else 0.0
    why = []
    if ratio < min_voiced:
        why.append(f"the lead is voiced in {ratio:.0%} of the song (needs {min_voiced:.0%})")
    if notes < min_notes:
        why.append(f"only {notes} notes (needs {min_notes})")
    return {"ok": not why, "reason": "; ".join(why) or None, "voiced_ratio": round(ratio, 3), "notes": int(notes),
            "lead_split": bool(lead_split)}
