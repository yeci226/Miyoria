"""The lyrics of a karaoke song, checked and aligned (docs/design/karaoke.md 「做了什麼第二步」): what
the worker does with the lookup's synced lines and the two model steps of align/run.py.

    looked-up lines ─ step asr ─▶ per line: heard, similarity, status; the song's verdict
        kept / doubtful ─ step align (matched lines only) ─▶ pieces with times, checked per line
        wrong_song, or no lines ─ the asr step's transcription ─ step align ─▶ heard lines
    every aligned line ─▶ a note per unit (lyricsync.unit_notes); the other lines keep the notes
                          cut from the pitch alone

``run(step, payload)`` runs one step (alignenv.py: a subprocess placed on the GPU like any stage; the
mock backend: a fake) and raises ``StepFailed``; ``None`` when the worker's machine has no align
environment. Whatever fails, the song keeps what step 1 had: the looked-up lines, unchecked, with
the notes cut from the pitch. Never worse than that.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

import numpy as np

import lyricsync as L

log = logging.getLogger("miyoria.sing.lyrics")

ASR_NAME = "qwen3-asr-1.7b"


class StepFailed(Exception):
    pass


Runner = Callable[[str, dict[str, Any]], dict[str, Any]]


@dataclass
class Options:
    """``WorkersKaraokeLyricsOptions``: Core's settings for this job, or the defaults."""

    aligner: str = "mms"
    matched: float = L.MATCHED
    uncertain: float = L.UNCERTAIN
    keep_share: float = L.KEEP_SHARE
    wrong_share: float = L.WRONG_SHARE

    @staticmethod
    def of(value: Any) -> "Options":
        if value is None:
            return Options()
        get = value.get if isinstance(value, dict) else lambda k, d=None: getattr(value, k, d)
        aligner = str(get("aligner", "mms") or "mms")
        return Options(aligner=aligner if aligner in ("w2v", "mms") else "mms",
                       matched=float(get("matched", L.MATCHED)), uncertain=float(get("uncertain", L.UNCERTAIN)),
                       keep_share=float(get("keep_share", L.KEEP_SHARE)),
                       wrong_share=float(get("wrong_share", L.WRONG_SHARE)))

    def thresholds(self) -> dict[str, float]:
        return {"matched": self.matched, "uncertain": self.uncertain, "keep_share": self.keep_share,
                "wrong_share": self.wrong_share}


@dataclass
class Lyrics:
    """What the stage gives the reference: the ``lyrics`` block (``None``: none found and none
    heard), the notes of the aligned lines and their spans, how it was made, what to log."""

    block: dict[str, Any] | None
    notes: list[dict[str, Any]] = field(default_factory=list)
    spans: list[tuple[float, float]] = field(default_factory=list)
    made: dict[str, Any] = field(default_factory=lambda: {"lyrics": "none", "asr": None, "aligner": None})
    info: dict[str, Any] = field(default_factory=dict)


def _line(start: float, end: float | None, text: str, status: str, source: str, similarity: float | None = None,
          heard: str | None = None, aligned: bool = False, pieces: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """A ``WorkersKaraokeLineV2``."""
    return {"start": round(start, 3), "end": None if end is None else round(end, 3), "text": text, "status": status,
            "source": source, "similarity": None if similarity is None else round(similarity, 3), "heard": heard,
            "aligned": aligned, "pieces": pieces, "edited": False}


def _block(provider: str | None, source: str, language: str | None, lines: list[dict[str, Any]],
           check: dict[str, Any] | None) -> dict[str, Any]:
    timing = "char" if any(x["aligned"] for x in lines) else "line"
    return {"provider": provider, "source": source, "language": language, "timing": timing, "check": check,
            "lines": lines}


def _check(statuses: Sequence[str], verdict: str) -> dict[str, Any]:
    return {"matched": sum(1 for s in statuses if s == "matched"),
            "uncertain": sum(1 for s in statuses if s == "uncertain"),
            "failed": sum(1 for s in statuses if s == "failed"), "verdict": verdict}


def unchecked(found: list[dict[str, Any]], provider: str | None, language: str | None,
              info: dict[str, Any] | None = None) -> Lyrics:
    """Step 1's lyrics in version 2's shape: the looked-up lines as they are."""
    if not found:
        return Lyrics(None, info=info or {})
    lines = [_line(x["start"], x["end"], x["text"], "unchecked", "found") for x in found]
    return Lyrics(_block(provider, "found", language, lines, None),
                  made={"lyrics": "line", "asr": None, "aligner": None}, info=info or {})


def _pieces_out(pieces: list[dict[str, Any]], times: list[tuple[float, float] | None] | None) -> list[dict[str, Any]]:
    """``WorkersKaraokePiece``s; ``times``: each sung piece's (start, end) or ``None`` (no times)."""
    out, k = [], 0
    for p in pieces:
        sung = bool(p.get("say"))
        t = times[k] if times is not None and sung else None
        if sung:
            k += 1
        out.append({"text": p["text"], "sung": sung, "start": None if t is None else t[0],
                    "end": None if t is None else t[1], "reading": p.get("reading"), "roman": p.get("roman")})
    return out


def _units_of(pieces: list[dict[str, Any]]) -> list[tuple[int, tuple[float, float] | None]]:
    """(piece index, aligner span) of every unit, in order."""
    out = []
    for i, p in enumerate(pieces):
        times = p.get("units")
        for k in range(len(p.get("say") or [])):
            t = times[k] if times is not None and k < len(times) else None
            out.append((i, None if t is None else (float(t[0]), float(t[1]))))
    return out


def _aligned_line(pieces: list[dict[str, Any]], curve: np.ndarray, voiced: Sequence[bool], hz: float, line_idx: int,
                  window_end: float, line_start: float | None) -> tuple[L.LineCheck, list[dict[str, Any]], list[dict[str, Any]], tuple[float, float] | None]:
    """(the check, the pieces with times when it passed, its notes, its span) of one line."""
    units = _units_of(pieces)
    spans = [u[1] for u in units]
    bars = L.bars(spans, voiced, hz, window_end)
    check = L.line_check(bars, voiced, hz, line_start)
    if not check.ok:
        return check, _pieces_out(pieces, None), [], None
    # A piece's time: its first unit's start to its last unit's end.
    per_piece: dict[int, list[tuple[float, float]]] = {}
    notes: list[dict[str, Any]] = []
    for (pi, _), bar in zip(units, bars):
        assert bar is not None
        per_piece.setdefault(pi, []).append(bar)
        notes += L.unit_notes(bar, curve, hz, line_idx, pi)
    times = [(min(b[0] for b in per_piece[i]), max(b[1] for b in per_piece[i]))
             for i, p in enumerate(pieces) if p.get("say")]
    timed = [b for b in bars if b is not None]
    return check, _pieces_out(pieces, times), notes, (timed[0][0], timed[-1][1])


def build(found: list[dict[str, Any]], provider: str | None, curve: np.ndarray, duration: float, opts: Options,
          run: Runner | None, hz: float = 50.0) -> Lyrics:
    """The lyrics of a song. ``found``: the looked-up lines (karaoke.lyric_lines: start, end, text),
    ``curve``: the reference curve (MIDI, NaN unvoiced) at ``hz``."""
    from readings import detect

    language = detect("".join(x["text"] for x in found)) if found else None
    info: dict[str, Any] = {}
    if run is None:
        info["skipped"] = "no align environment"
        return unchecked(found, provider, language, info)
    voiced = [not math.isnan(v) for v in np.asarray(curve, dtype=np.float64)]
    wins = L.windows(found, duration)
    try:
        asr = run("asr", {"language": language, "thresholds": opts.thresholds(),
                          "lines": [{"text": x["text"], "a": a, "b": b} for x, (a, b) in zip(found, wins)]})
    except StepFailed as e:
        log.warning("karaoke lyrics: the recogniser failed: %s", e)
        info["asr_error"] = str(e)[:300]
        return unchecked(found, provider, language, info)
    language = asr.get("language") or language
    heard_lines = asr.get("lines") or []
    statuses = [h.get("status") or L.line_status(float(h.get("similarity") or 0.0), opts.matched, opts.uncertain)
                for h in heard_lines]
    verdict = asr.get("verdict") or L.song_verdict(statuses, opts.keep_share, opts.wrong_share)
    check = _check(statuses, verdict) if found else None
    info["verdict"] = verdict
    made = {"lyrics": "", "asr": ASR_NAME, "aligner": None}

    if found and len(heard_lines) == len(found) and verdict != "wrong_song":
        segments = [{"a": a, "b": b, "text": x["text"], "align": s == "matched"}
                    for x, (a, b), s in zip(found, wins, statuses)]
        made["lyrics"] = "found-checked"
        try:
            al = run("align", {"language": language, "aligner": opts.aligner, "segments": segments})
            made["aligner"] = opts.aligner
        except StepFailed as e:
            log.warning("karaoke lyrics: the aligner failed: %s", e)
            info["align_error"] = str(e)[:300]
            al = None
        lines, notes, spans, failed = [], [], [], []
        for i, (x, h, s, (a, b)) in enumerate(zip(found, heard_lines, statuses, wins)):
            seg = (al or {}).get("segments", [])
            pieces = seg[i]["pieces"] if i < len(seg) else None
            aligned, out_pieces = False, None
            if pieces is not None:
                out_pieces = _pieces_out(pieces, None)
                if segments[i]["align"]:
                    # A bar runs on at most to where the next line starts.
                    until = min(b, x["end"]) if x["end"] is not None else b
                    c, timed_pieces, line_notes, span = _aligned_line(pieces, curve, voiced, hz, i, until, x["start"])
                    if c.ok and span is not None:
                        aligned, out_pieces = True, timed_pieces
                        notes += line_notes
                        spans.append(span)
                    else:
                        failed.append({"line": i, "why": c.reason})
            lines.append(_line(x["start"], x["end"], x["text"], s, "found", h.get("similarity"), h.get("heard"),
                               aligned, out_pieces))
        info["aligned"] = len(spans)
        if failed:
            info["alignment_failed"] = failed[:20]
        return Lyrics(_block(provider, "found", language, lines, check), notes, spans, made, info)

    # No lyrics, or the wrong ones: what was heard.
    chunks = [c for c in (asr.get("chunks") or []) if (c.get("heard") or "").strip()]
    if not chunks:
        info["heard"] = "nothing"
        return Lyrics(None, made={"lyrics": "none", "asr": ASR_NAME, "aligner": None}, info=info) if not found or \
            verdict == "wrong_song" else unchecked(found, provider, language, info)
    made["lyrics"] = "heard"
    segments = [{"a": c["a"], "b": c["b"], "text": c["heard"].strip(), "align": True} for c in chunks]
    try:
        al = run("align", {"language": language, "aligner": opts.aligner, "segments": segments})
        made["aligner"] = opts.aligner
        language = al.get("language") or language
    except StepFailed as e:
        log.warning("karaoke lyrics: the aligner failed on what was heard: %s", e)
        info["align_error"] = str(e)[:300]
        lines = [_line(c["a"], c["b"], c["heard"].strip(), "uncertain", "heard", heard=c["heard"].strip())
                 for c in chunks]
        return Lyrics(_block(provider, "heard", language, lines, check), made=made, info=info)
    lines, notes, spans, dropped = [], [], [], 0
    for seg, c in zip(al.get("segments") or [], chunks):
        pieces = seg["pieces"]
        units = _units_of(pieces)
        if not units or all(t is None for _, t in units):
            dropped += 1
            continue
        groups = L.split_heard([t for _, t in units])
        for g in groups:
            first_piece = units[g[0]][0]
            last_piece = units[g[-1]][0]
            # The unsung pieces after a line's last sung piece go with it (punctuation).
            nxt = units[g[-1] + 1][0] if g[-1] + 1 < len(units) else len(pieces)
            line_pieces = pieces[first_piece:max(last_piece + 1, nxt)]
            while line_pieces and not line_pieces[-1].get("say") and not line_pieces[-1]["text"].strip():
                line_pieces = line_pieces[:-1]
            spans_g = [units[k][1] for k in g]
            bars = L.bars(spans_g, voiced, hz, float(c["b"]))
            if L.voiced_share(bars, voiced, hz) < L.HEARD_MIN_VOICED:
                dropped += 1  # nothing sung there: text the recogniser made up
                continue
            idx = len(lines)
            ck, timed_pieces, line_notes, span = _aligned_line(line_pieces, curve, voiced, hz, idx, float(c["b"]), None)
            timed = [b for b in bars if b is not None]
            text = "".join(p["text"] for p in line_pieces).strip()
            if not text or not timed:
                continue
            if ck.ok and span is not None:
                notes += line_notes
                spans.append(span)
            lines.append(_line(timed[0][0], timed[-1][1], text, "uncertain", "heard", heard=text,
                               aligned=ck.ok, pieces=timed_pieces))
    info["heard_lines"], info["heard_dropped"] = len(lines), dropped
    if not lines:
        return Lyrics(None, made={"lyrics": "none", "asr": ASR_NAME, "aligner": opts.aligner}, info=info)
    return Lyrics(_block(provider, "heard", language, lines, check), notes, spans, made, info)
