"""Lyric text for karaoke (docs/design/karaoke.md 「做了什麼第二步」): which language a text is in, the
pieces a line is shown in, the units the aligner gets for each piece, the readings shown above
them, and the form two texts are compared on.

    Japanese  a piece is one kana (a mora: small kana join the one before) or one word written with
              kanji, whose reading (hiragana, fugashi + unidic-lite) is its furigana; the aligner
              gets the morae of the reading. The particles は / へ / を are read as sung (わ / え / お).
    Chinese   a piece is one Han character, its reading the pinyin with tone marks (pypinyin); the
              aligner gets the character (simplified, opencc) or its pinyin (MMS).
    English   a piece is a word.

Spaces and punctuation are pieces too, not sung, so the pieces of a line always join to its text.

The language libraries are imported only when a ``Lang`` needs them: they are in the align
environment (workers/sing/align/pyproject.toml), not in the worker's, and the worker itself never
calls this module. Tests hand ``Lang`` fakes (``words``, ``pinyin``, ``t2s``, ``romaji``).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable

LANGUAGES = ("ja", "zh", "en")
# The names the recogniser takes (qwen_asr ``language=``).
LANGUAGE_NAMES = {"ja": "Japanese", "zh": "Chinese", "en": "English"}
SMALL_KANA = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")


def is_kana(c: str) -> bool:
    return "ぁ" <= c <= "ゟ" or "゠" <= c <= "ヿ"


def is_han(c: str) -> bool:
    return "㐀" <= c <= "鿿" or "豈" <= c <= "﫿"


def has_letters(s: str) -> bool:
    return any(unicodedata.category(c)[0] in "LN" for c in s)


def detect(text: str) -> str | None:
    """``ja`` when there is kana, ``zh`` when there are Han characters and no kana, ``en`` for
    Latin letters only; ``None`` for no letters at all."""
    if any(is_kana(c) for c in text):
        return "ja"
    if any(is_han(c) for c in text):
        return "zh"
    if any(c.isalpha() and c.isascii() for c in text):
        return "en"
    return None


def kata2hira(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def strip_punct(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    return "".join(c for c in s if unicodedata.category(c)[0] in "LN")


def morae(kana: str) -> list[str]:
    out: list[str] = []
    for c in kana:
        if c in SMALL_KANA and out:
            out[-1] += c
        else:
            out.append(c)
    return out


@dataclass
class Piece:
    """``WorkersKaraokePiece`` before it has a time, with ``say``: the units the aligner gets (one
    note each), empty for a piece that is not sung."""

    text: str
    reading: str | None = None
    roman: str | None = None
    say: list[str] = field(default_factory=list)

    @property
    def sung(self) -> bool:
        return bool(self.say)


# ── the language libraries (imported when first used) ────────────────────────


def _fugashi_words() -> Callable[[str], list[tuple[str, str]]]:
    import fugashi

    tagger = fugashi.Tagger()

    def words(text: str) -> list[tuple[str, str]]:
        out = []
        for w in tagger(text):
            surf = w.surface
            f = w.feature
            kana = getattr(f, "kana", None)
            if getattr(f, "pos1", None) == "助詞" and surf in ("は", "へ", "を"):
                kana = {"は": "ワ", "へ": "エ", "を": "オ"}[surf]
            reading = kata2hira(kana) if kana and kana != "*" else surf.lower()
            out.append((surf, reading))
        return out

    return words


def _pykakasi_romaji() -> Callable[[str], str]:
    import pykakasi

    k = pykakasi.kakasi()
    return lambda kana: "".join(x["hepburn"] for x in k.convert(kana))


def _pypinyin() -> Callable[[str, bool], str]:
    from pypinyin import Style, lazy_pinyin

    def pinyin(char: str, tone: bool) -> str:
        return "".join(lazy_pinyin(char, style=Style.TONE if tone else Style.NORMAL, v_to_u=tone))

    return pinyin


def _opencc_t2s() -> Callable[[str], str]:
    import opencc

    return opencc.OpenCC("t2s").convert


class Lang:
    """The text tools of one language. Each tool is the library's unless given."""

    def __init__(self, language: str, words: Callable[[str], list[tuple[str, str]]] | None = None,
                 romaji: Callable[[str], str] | None = None, pinyin: Callable[[str, bool], str] | None = None,
                 t2s: Callable[[str], str] | None = None) -> None:
        if language not in LANGUAGES:
            raise ValueError(f"no text tools for language {language!r}")
        self.language = language
        self._words, self._romaji, self._pinyin, self._t2s = words, romaji, pinyin, t2s

    def words(self, text: str) -> list[tuple[str, str]]:
        """(written word, hiragana reading) of Japanese text."""
        if self._words is None:
            self._words = _fugashi_words()
        return self._words(text)

    def romaji(self, kana: str) -> str:
        if self._romaji is None:
            self._romaji = _pykakasi_romaji()
        return self._romaji(kana)

    def pinyin(self, char: str, tone: bool) -> str:
        if self._pinyin is None:
            self._pinyin = _pypinyin()
        return self._pinyin(char, tone)

    def t2s(self, text: str) -> str:
        if self._t2s is None:
            try:
                self._t2s = _opencc_t2s()
            except ImportError:  # compare as written: traditional against traditional still matches
                self._t2s = lambda s: s
        return self._t2s(text)

    # ── comparing ─────────────────────────────────────────────────────────

    def norm(self, text: str) -> str:
        """What two texts are compared on: Chinese simplified characters, Japanese the hiragana
        reading, English letters; punctuation and spaces dropped, lower case."""
        if self.language == "zh":
            return strip_punct(self.t2s(text)).lower()
        if self.language == "ja":
            return strip_punct("".join(r for s, r in self.words(text) if has_letters(s))).lower()
        return strip_punct(text).lower()

    # ── pieces ────────────────────────────────────────────────────────────

    def pieces(self, text: str) -> list[Piece]:
        """The pieces of a line, joined they are ``text``."""
        if self.language == "ja":
            return self._ja_pieces(text)
        if self.language == "zh":
            return _gaps_between(text, [(m.start(), m.end(), self._zh_piece(m.group()))
                                        for m in re.finditer(r"[㐀-鿿豈-﫿]|[A-Za-z0-9']+", text)])
        return _gaps_between(text, [(m.start(), m.end(), Piece(m.group(), say=[m.group().lower()]))
                                    for m in re.finditer(r"[A-Za-z0-9']+", text)])

    def _zh_piece(self, tok: str) -> Piece:
        if is_han(tok):
            return Piece(tok, reading=self.pinyin(tok, True) or None, say=[self.t2s(tok)])
        return Piece(tok, say=[tok.lower()])

    def _ja_pieces(self, text: str) -> list[Piece]:
        found: list[tuple[int, int, Piece]] = []
        at = 0
        for surf, reading in self.words(text):
            i = text.find(surf, at)
            if i < 0 or not has_letters(surf):
                continue
            at = i + len(surf)
            if reading.isascii():  # Latin, digits: a word of its own, its letters as they are
                found.append((i, at, Piece(surf, say=[reading.lower()])))
                continue
            sung = morae(reading)
            written = morae(kata2hira(surf)) if all(is_kana(c) or c == "ー" for c in surf) else None
            if written is not None and len(written) == len(sung):
                # Kana: a piece per mora, as written (katakana stays katakana), sung as read.
                k = i
                for w, s in zip(morae(surf), sung):
                    found.append((k, k + len(w), Piece(w, roman=self._roman_of(s), say=[s])))
                    k += len(w)
            else:
                found.append((i, at, Piece(surf, reading=reading if reading != surf else None,
                                           roman=self._roman_of(reading), say=sung)))
        return _gaps_between(text, found)

    def _roman_of(self, kana: str) -> str | None:
        try:
            r = self.romaji(kana)
        except ImportError:
            return None
        return r or None

    # ── what MMS_FA reads ─────────────────────────────────────────────────

    def roman(self, unit: str) -> str:
        """A unit as MMS_FA's alphabet (a–z and the apostrophe): pinyin without tones for Chinese,
        Hepburn for Japanese (a lone っ as ``t``, a lone ー as ``a``), English as it is."""
        if unit.isascii():
            r = unit.lower()
        elif self.language == "zh":
            r = self.pinyin(unit, False).lower().replace("ü", "v")
        elif self.language == "ja":
            r = {"っ": "t", "ッ": "t", "ー": "a"}.get(unit) or self.romaji(unit).lower()
        else:
            r = unit.lower()
        r = "".join(c for c in r if c in "abcdefghijklmnopqrstuvwxyz'")
        return r or "a"


def _gaps_between(text: str, spans: list[tuple[int, int, Piece]]) -> list[Piece]:
    """``spans`` (start, end, piece) in order, with the text between them as unsung pieces."""
    out: list[Piece] = []
    at = 0
    for a, b, piece in spans:
        if a > at:
            out.append(Piece(text[at:a]))
        out.append(piece)
        at = b
    if at < len(text):
        out.append(Piece(text[at:]))
    return out
