"""Checked and aligned lyrics for karaoke (docs/design/karaoke.md 「做了什麼第二步」). Pure Python and
numpy: the rules here run in the worker and in the align environment (align/run.py) alike, and are
tested on synthetic data.

    verify    each looked-up line against what the recogniser heard in its window: the share of the
              line's (normalised) symbols found in order in what was heard (``coverage``) gives
              ``matched`` / ``uncertain`` / ``failed``; the share of matched lines keeps the lyrics,
              keeps them as doubtful, or calls them the wrong song (``song_verdict``)
    transcribe  without lyrics (or the wrong ones), the lead in 20–30 s chunks cut where it is
              quietest (``quiet_chunks``); aligned, the chunk is cut into lines at pauses
              (``split_heard``) and lines with no voice in them are dropped (invented text)
    align     CTC forced alignment of the units (``ctc_align``: Viterbi over the model's log
              probabilities), then the bars a singer sees (``bars``: each unit runs on through the
              voice after it) and the whole-line checks (``line_check``)
    notes     an aligned line has one note per unit (a character or mora), its pitch the median of
              the lead's curve inside it, split where the pitch clearly moves (``unit_notes``); every
              other line keeps the notes cut from the pitch alone (``merge_notes``)

The thresholds were set on the experiment of 2026-11-18 (.tmp-test/align-lab, ROUND2.txt).
"""

from __future__ import annotations

import difflib
import math
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

# ── verification (the owner's thresholds; Core's settings override them per job) ─

MATCHED = 0.75
UNCERTAIN = 0.5
KEEP_SHARE = 0.5
WRONG_SHARE = 0.2
# A line is looked for from a little before its time to a little after the next line's, at most
# this long (the lab's windows).
WINDOW_PRE_S = 0.5
WINDOW_POST_S = 0.3
WINDOW_MAX_S = 12.0
# What is shorter than this is not given to the recogniser.
MIN_CLIP_S = 0.3

# ── transcription ────────────────────────────────────────────────────────────

CHUNK_MIN_S = 20.0
CHUNK_MAX_S = 30.0
# A pause this long between two aligned units of a transcription starts a new line.
LINE_PAUSE_S = 0.4
# A heard line longer than this is cut again at its longest pause.
LINE_MAX_S = 10.0
# A heard line with fewer of its units voiced than this is text the recogniser made up (an
# intro read as 「はい」, an interlude as a sentence): dropped.
HEARD_MIN_VOICED = 0.5

# ── the whole-line checks (the lab's, at 50 Hz) ──────────────────────────────

BAR_MAX_S = 6.0
# A bar must have voice in this share of its frames, and at least MIN_VOICED_FRAMES of them.
BAR_VOICED_SHARE = 0.25
MIN_VOICED_FRAMES = 2
# A line whose first unit is further than this from the line's time did not align.
FIRST_UNIT_MAX_S = 1.0
# More than this share of bars under SHORT_BAR_S is a line the aligner squeezed (the lab's
# failing aligners had 30–47 % of such bars, MMS 0.3–10 %).
SHORT_BAR_S = 0.06
SHORT_SHARE_MAX = 0.25
# A bar runs on through voice after it, across gaps up to this long.
BAR_BRIDGE_S = 0.06

# ── notes ────────────────────────────────────────────────────────────────────

NOTES_METHOD = "lyric-units-1"
# Inside a unit, the pitch is cut again (melody's rules) when it gives runs at least this long:
# a melisma on one syllable is drawn as the notes it goes through.
MELISMA_MIN_S = 0.15


# ── verification ─────────────────────────────────────────────────────────────


def coverage(line: str, heard: str) -> float:
    """Share of ``line``'s symbols found in order in ``heard`` (both normalised)."""
    if not line or not heard:
        return 0.0
    m = difflib.SequenceMatcher(None, line, heard, autojunk=False)
    return sum(x.size for x in m.get_matching_blocks()) / len(line)


def line_status(similarity: float, matched: float = MATCHED, uncertain: float = UNCERTAIN) -> str:
    if similarity >= matched:
        return "matched"
    if similarity >= uncertain:
        return "uncertain"
    return "failed"


def song_verdict(statuses: Sequence[str], keep: float = KEEP_SHARE, wrong: float = WRONG_SHARE) -> str:
    """``kept`` (at least ``keep`` of the lines matched), ``wrong_song`` (fewer than ``wrong``),
    else ``doubtful``; ``unchecked`` without lines."""
    if not statuses:
        return "unchecked"
    share = sum(1 for s in statuses if s == "matched") / len(statuses)
    if share >= keep:
        return "kept"
    if share < wrong:
        return "wrong_song"
    return "doubtful"


def windows(lines: Sequence[dict[str, Any]], duration: float, pre: float = WINDOW_PRE_S,
            post: float = WINDOW_POST_S, cap: float = WINDOW_MAX_S) -> list[tuple[float, float]]:
    """(a, b) of each line (``start``, ``end`` in seconds): from ``pre`` before it starts to ``post``
    after the next starts, at most ``cap`` long."""
    out = []
    for line in lines:
        t = float(line["start"])
        end = line.get("end")
        nxt = float(end) if end is not None else duration
        out.append((round(max(0.0, t - pre), 3), round(min(duration, nxt + post, t + cap), 3)))
    return out


# ── transcription ────────────────────────────────────────────────────────────


def quiet_chunks(y: np.ndarray, sr: int, lo: float = CHUNK_MIN_S, hi: float = CHUNK_MAX_S) -> list[tuple[float, float]]:
    """``lo``–``hi`` s pieces of ``y``, each cut at the quietest 100 ms between ``lo`` and ``hi``."""
    hop = sr // 100
    n = len(y) // hop
    if n == 0:
        return [(0.0, len(y) / sr)] if len(y) else []
    db = 10 * np.log10(np.mean(np.asarray(y[: n * hop], dtype=np.float64).reshape(n, hop) ** 2, axis=1) + 1e-10)
    db = np.convolve(db, np.ones(10) / 10, mode="same")
    out, a, dur = [], 0.0, len(y) / sr
    while dur - a > hi:
        i0, i1 = int((a + lo) * 100), min(n, int((a + hi) * 100))
        b = (i0 + int(np.argmin(db[i0:i1]))) / 100 if i1 > i0 else a + hi
        out.append((round(a, 2), round(b, 2)))
        a = b
    out.append((round(a, 2), round(dur, 2)))
    return out


# ── forced alignment ─────────────────────────────────────────────────────────


def ctc_align(log_probs: np.ndarray, tokens: Sequence[int], blank: int = 0) -> list[tuple[int, int]]:
    """The most likely CTC path of ``tokens`` through ``log_probs`` (frames × vocabulary): for each
    token its first and last frame, inclusive. Raises ``ValueError`` when the tokens cannot fit."""
    lp = np.asarray(log_probs, dtype=np.float64)
    t_max, n = lp.shape[0], len(tokens)
    if n == 0:
        return []
    repeats = sum(1 for i in range(1, n) if tokens[i] == tokens[i - 1])
    if t_max < n + repeats:
        raise ValueError(f"{n} tokens do not fit in {t_max} frames")
    states = [blank]
    for tok in tokens:
        states += [int(tok), blank]
    s_n = len(states)
    st = np.array(states)
    emit = lp[:, st]  # frames × states
    # A token state may be entered from two states back when it differs from that one (skip blank).
    skip = np.zeros(s_n, dtype=bool)
    for s in range(2, s_n):
        skip[s] = st[s] != blank and st[s] != st[s - 2]
    neg = -np.inf
    score = np.full(s_n, neg)
    score[0] = emit[0, 0]
    score[1] = emit[0, 1]
    back = np.zeros((t_max, s_n), dtype=np.int8)  # 0 stay, 1 from s-1, 2 from s-2
    for t in range(1, t_max):
        stay = score
        one = np.concatenate(([neg], score[:-1]))
        two = np.where(skip, np.concatenate(([neg, neg], score[:-2])), neg)
        best = np.maximum(stay, np.maximum(one, two))
        back[t] = np.where(best == stay, 0, np.where(best == one, 1, 2))
        score = best + emit[t]
    # End in the last token or the blank after it.
    s = s_n - 1 if score[s_n - 1] >= score[s_n - 2] else s_n - 2
    if not math.isfinite(score[s]):
        raise ValueError("no path through the frames")
    path = np.zeros(t_max, dtype=np.int64)
    for t in range(t_max - 1, -1, -1):
        path[t] = s
        s -= int(back[t, s])
    spans: list[list[int]] = [[-1, -1] for _ in range(n)]
    for t, s in enumerate(path):
        if s % 2 == 1:
            k = (s - 1) // 2
            if spans[k][0] < 0:
                spans[k][0] = t
            spans[k][1] = t
    return [(a, b) for a, b in spans]


def unit_spans(token_spans: Sequence[tuple[int, int]], tokens_per_unit: Sequence[int], seconds_per_frame: float,
               offset: float) -> list[tuple[float, float] | None]:
    """Seconds of each unit from the frames of its tokens; a unit without tokens (nothing the model
    can say) gets ``None``."""
    out: list[tuple[float, float] | None] = []
    k = 0
    for count in tokens_per_unit:
        if count <= 0:
            out.append(None)
            continue
        first, last = token_spans[k][0], token_spans[k + count - 1][1]
        k += count
        out.append((round(offset + first * seconds_per_frame, 3), round(offset + (last + 1) * seconds_per_frame, 3)))
    return out


def fill_untimed(spans: Sequence[tuple[float, float] | None]) -> list[tuple[float, float] | None]:
    """A unit the model could not say (no letter in its vocabulary) shares the time of the unit
    before it (or, first in the line, after it): the two split that span in half. All ``None``
    stays so."""
    out = list(spans)
    for i, sp in enumerate(out):
        if sp is not None:
            continue
        j = next((k for k in range(i - 1, -1, -1) if out[k] is not None), None)
        if j is None:
            j = next((k for k in range(i + 1, len(out)) if out[k] is not None), None)
        if j is None:
            return out
        a, b = out[j]  # type: ignore[misc]
        mid = round((a + b) / 2, 3)
        if j < i:
            out[j], out[i] = (a, mid), (mid, b)
        else:
            out[i], out[j] = (a, mid), (mid, b)
    return out


# ── bars and the whole-line checks ───────────────────────────────────────────


def bars(spans: Sequence[tuple[float, float] | None], voiced: Sequence[bool], hz: float,
         window_end: float) -> list[tuple[float, float] | None]:
    """What a singer sees from the aligner's spans: each unit runs on through the voice that follows
    it, up to the next unit's start (gaps up to BAR_BRIDGE_S bridged), never shorter than the
    aligner said."""
    out: list[tuple[float, float] | None] = []
    n = len(voiced)
    bridge = max(1, int(round(BAR_BRIDGE_S * hz)))
    for i, sp in enumerate(spans):
        if sp is None:
            out.append(None)
            continue
        s, e = sp
        nxt = next((x[0] for x in spans[i + 1:] if x is not None), window_end)
        f = int(e * hz)
        gap = 0
        voice_end = e  # the end of the last voiced frame reached
        while f < n and f / hz < nxt:
            if voiced[f]:
                gap = 0
                voice_end = (f + 1) / hz
            else:
                gap += 1
                if gap > bridge:
                    break
            f += 1
        end = max(e, min(nxt, voice_end))
        out.append((round(s, 3), round(end, 3)))
    return out


@dataclass
class LineCheck:
    ok: bool
    reason: str | None
    voiced_share: float
    short_share: float


def line_check(bar_spans: Sequence[tuple[float, float] | None], voiced: Sequence[bool], hz: float,
               line_start: float | None = None) -> LineCheck:
    """The whole-line pass: every unit has a time, its bar has voice in it, is at most BAR_MAX_S
    long and starts after the one before; not too many bars are absurdly short; and the first unit
    is near the line's own time (``line_start``, when it has one)."""
    n_voiced, short, why = 0, 0, []
    prev_s, prev_e = -1.0, -1.0
    timed = [b for b in bar_spans if b is not None]
    if not timed:
        return LineCheck(False, "nothing aligned", 0.0, 0.0)
    if len(timed) < len(bar_spans):
        why.append("units without a time")
    for s, e in timed:
        fa = int(s * hz)
        fb = max(fa + 1, int(e * hz))
        frames = voiced[fa:fb]
        act = sum(1 for v in frames if v)
        if act >= max(MIN_VOICED_FRAMES, BAR_VOICED_SHARE * (fb - fa)):
            n_voiced += 1
        if e - s > BAR_MAX_S:
            why.append("a bar longer than 6 s")
        if s < prev_s or s < prev_e - 0.02:
            why.append("out of order")
        if e - s < SHORT_BAR_S:
            short += 1
        prev_s, prev_e = s, e
    share = n_voiced / len(timed)
    short_share = short / len(timed)
    if n_voiced < len(timed):
        why.append("bars without voice")
    if short_share > SHORT_SHARE_MAX:
        why.append("too many bars under 60 ms")
    if line_start is not None and abs(timed[0][0] - line_start) > FIRST_UNIT_MAX_S:
        why.append("far from the line's time")
    return LineCheck(not why, "; ".join(dict.fromkeys(why)) or None, round(share, 3), round(short_share, 3))


def voiced_share(bar_spans: Sequence[tuple[float, float] | None], voiced: Sequence[bool], hz: float) -> float:
    """Share of the timed bars with voice in them (the same rule as ``line_check``)."""
    timed = [b for b in bar_spans if b is not None]
    if not timed:
        return 0.0
    good = 0
    for s, e in timed:
        fa = int(s * hz)
        fb = max(fa + 1, int(e * hz))
        act = sum(1 for v in voiced[fa:fb] if v)
        good += act >= max(MIN_VOICED_FRAMES, BAR_VOICED_SHARE * (fb - fa))
    return good / len(timed)


# ── heard lines ──────────────────────────────────────────────────────────────


def split_heard(unit_times: Sequence[tuple[float, float] | None], pause: float = LINE_PAUSE_S,
                max_s: float = LINE_MAX_S) -> list[list[int]]:
    """Indexes of the units of each line of a transcription: a new line after a pause of at least
    ``pause``; a line longer than ``max_s`` cut again at its longest pause. Units without a time
    stay with the line before them."""
    lines: list[list[int]] = []
    cur: list[int] = []
    last_end: float | None = None
    for i, t in enumerate(unit_times):
        if t is not None and last_end is not None and cur and t[0] - last_end >= pause:
            lines.append(cur)
            cur = []
        cur.append(i)
        if t is not None:
            last_end = t[1]
    if cur:
        lines.append(cur)
    out: list[list[int]] = []
    for line in lines:
        out += _cut_long(line, unit_times, max_s)
    return out


def _cut_long(line: list[int], times: Sequence[tuple[float, float] | None], max_s: float) -> list[list[int]]:
    timed = [i for i in line if times[i] is not None]
    if len(timed) < 2:
        return [line]
    first, last = times[timed[0]], times[timed[-1]]
    assert first is not None and last is not None
    if last[1] - first[0] <= max_s:
        return [line]
    gaps = []
    for a, b in zip(timed, timed[1:]):
        ta, tb = times[a], times[b]
        assert ta is not None and tb is not None
        gaps.append((tb[0] - ta[1], b))
    _, at = max(gaps)
    k = line.index(at)
    return _cut_long(line[:k], times, max_s) + _cut_long(line[k:], times, max_s)


# ── notes ────────────────────────────────────────────────────────────────────


def unit_notes(bar: tuple[float, float], curve: np.ndarray, hz: float, line: int, piece: int) -> list[dict[str, Any]]:
    """The notes of one unit: one over its bar at the median of the voiced curve inside it, or,
    where melody's rules find runs of at least MELISMA_MIN_S inside it, one per run. None when the
    lead is not voiced in it."""
    from melody import MIDI_DECIMALS, _runs_of

    s, e = bar
    fa = max(0, int(round(s * hz)))
    fb = min(curve.size, max(fa + 1, int(round(e * hz))))
    seg = curve[fa:fb]
    values = seg[~np.isnan(seg)]
    if values.size == 0:
        return []

    def note(a: float, b: float, midi: float) -> dict[str, Any]:
        return {"start": round(a, 3), "end": round(b, 3), "midi": round(float(midi), MIDI_DECIMALS),
                "source": "lyric", "line": line, "char": piece}

    runs = [(a, b) for a, b in _runs_of(seg, hz) if (b - a) / hz >= MELISMA_MIN_S]
    if len(runs) >= 2:
        out = []
        for k, (a, b) in enumerate(runs):
            # The runs share the bar: each from where it starts to where the next starts.
            start = s if k == 0 else (fa + a) / hz
            end = e if k == len(runs) - 1 else (fa + runs[k + 1][0]) / hz
            vals = seg[a:b][~np.isnan(seg[a:b])]
            out.append(note(start, end, float(np.median(vals))))
        return out
    return [note(s, e, float(np.median(values)))]


def merge_notes(pitch_notes: Sequence[dict[str, Any]], lyric_notes: Sequence[dict[str, Any]],
                spans: Sequence[tuple[float, float]]) -> list[dict[str, Any]]:
    """The notes of the song: the lyric notes, and the pitch-only notes that do not overlap any of
    ``spans`` (the aligned lines, first bar's start to last bar's end), in time order."""
    def inside(n: dict[str, Any]) -> bool:
        return any(n["start"] < b and n["end"] > a for a, b in spans)

    kept = [n for n in pitch_notes if not inside(n)]
    return sorted([*kept, *lyric_notes], key=lambda n: (n["start"], n["end"]))
