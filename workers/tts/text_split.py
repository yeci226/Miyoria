"""Sentence splitter for the TTS worker (pure Python, no dependencies).

Splits on 。！？!?… and newlines (and ``.`` when followed by whitespace / end of text), keeping
the punctuation, closing quotes and brackets attached to the sentence they end. Then:

* pieces with fewer than ``min_chars`` speakable characters are merged into the next piece
  (the last one into the previous), so we never synthesise a lone "哼!" as its own clip;
* pieces longer than ``max_chars`` are cut at the last comma-like mark before the limit, else at
  the last space (hard cut if there is neither), because very long single generations delay the
  first audio.

Concatenating the result (minus whitespace) always equals the input (minus whitespace).
"""

from __future__ import annotations

TERMINATORS = "。！？!?…\n"
CLOSERS = "」』”’\"')）】》〉"
SOFT_BREAKS = "，、,；;：:"


def _speakable(s: str) -> int:
    return sum(1 for ch in s if ch.isalnum())


def _is_terminator(text: str, i: int) -> bool:
    ch = text[i]
    if ch in TERMINATORS:
        return True
    if ch == ".":
        nxt = text[i + 1] if i + 1 < len(text) else ""
        prev = text[i - 1] if i > 0 else ""
        return (nxt == "" or nxt.isspace()) and not prev.isdigit()
    return False


def _raw_split(text: str) -> list[str]:
    pieces: list[str] = []
    buf: list[str] = []
    i, n = 0, len(text)
    while i < n:
        buf.append(text[i])
        if _is_terminator(text, i):
            i += 1
            # swallow runs like "?!", "……", "!!!" and closing quotes / brackets
            while i < n and (text[i] in TERMINATORS or text[i] in CLOSERS or _is_terminator(text, i)):
                buf.append(text[i])
                i += 1
            pieces.append("".join(buf))
            buf = []
            continue
        i += 1
    if buf:
        pieces.append("".join(buf))
    return [p.strip() for p in pieces if p.strip()]


def _cut_long(piece: str, max_chars: int) -> list[str]:
    out: list[str] = []
    while len(piece) > max_chars:
        window = piece[:max_chars]
        cut = max((window.rfind(c) for c in SOFT_BREAKS), default=-1)
        if cut <= max_chars // 3:
            # No comma to cut at: a space, so that a word or a number is never said in two halves.
            cut = max((i for i, ch in enumerate(window) if ch.isspace()), default=-1)
        cut = cut + 1 if cut > max_chars // 3 else max_chars
        out.append(piece[:cut].strip())
        piece = piece[cut:].strip()
    if piece:
        out.append(piece)
    return [p for p in out if p]


def split_sentences(text: str, min_chars: int = 4, max_chars: int = 80) -> list[str]:
    pieces = _raw_split(text.replace("\r\n", "\n").replace("\r", "\n"))
    merged: list[str] = []
    carry = ""
    for p in pieces:
        p = _join(carry, p) if carry else p
        carry = ""
        if _speakable(p) < min_chars:
            carry = p
        else:
            merged.append(p)
    if carry:
        if merged:
            merged[-1] = _join(merged[-1], carry)
        elif _speakable(carry) > 0:
            merged.append(carry)
    out: list[str] = []
    for p in merged:
        out.extend(_cut_long(p, max_chars))
    return out


def _join(a: str, b: str) -> str:
    """Glue two stripped pieces; a space only where both sides are ASCII (English words)."""
    return f"{a} {b}" if a[-1:].isascii() and b[:1].isascii() else a + b
