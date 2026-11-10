"""Lyrics for the song worker: title cleanup, synced LRC parsing, lookup in lrclib.net / NetEase and the checks.

The pipeline (``find_lyrics``):

1. direct queries from the video: yt-dlp's own ``track`` / ``artist`` / ``alt_title``, the cleaned title,
   its artist / title splits (both orders), text in 「」 / 【】, the channel as the artist;
2. each query goes to lrclib's search (synced LRC, open API) and NetEase's public lyric endpoint;
3. when nothing fits well enough, a language model (lyricsllm.py) names the real song (title, artist,
   language, other spellings) from the title, description and channel, and the same sources are searched
   with that;
4. every candidate is scored (title, artist, duration), the synced LRC must fit the audio's length, and a
   shaky match is spot-checked against the lead vocal by ASR when that is on. A mismatch is rejected: no
   lyrics beat wrong lyrics.

Pure Python (plus ``httpx``), so the tests run without the GPU stack; all network goes through
``http_json`` / ``lyricsllm.chat`` / ``asr_text``, which the tests replace.
"""

from __future__ import annotations

import difflib
import logging
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("miyoria.sing.lyrics")

LRCLIB_URL = "https://lrclib.net"
NETEASE_URL = "https://music.163.com"
USER_AGENT = "Miyoria song worker (https://github.com/miyoria)"

# ── title cleanup ────────────────────────────────────────────────────────────

_BRACKETED = re.compile(r"[\(\[【「『〔《（［〈][^\)\]】」』〕》）］〉]*[\)\]】」』〕》）］〉]")
_QUOTED = re.compile(r"[“\"]([^“”\"]{1,80})[”\"]")
_NOISE = re.compile(
    r"\b(official|music|lyric|lyrics|video|audio|mv|pv|hd|4k|hq|full|short|ver\.?|version|remaster(ed)?|"
    r"live|cover|covered|covers|subbed|romaji)\b"
    r"|歌ってみた|歌ってみました|弾いてみた|叩いてみた|踊ってみた|歌词|歌詞付き|歌詞|字幕付き|中字|中文字幕|"
    r"[中日英]?字幕|完整版|官方|高音質|高音质|翻唱|翻唄|フル|オリジナル曲?|原創|原创|公式|ミュージックビデオ|"
    r"動態歌詞|动态歌词",
    re.IGNORECASE,
)
_EPISODE = re.compile(r"(TV|ＴＶ)?(アニメ)?\S*?(オープニング|エンディング|主題歌|挿入歌)(テーマ)?|\b(OP|ED)\d*\b", re.IGNORECASE)
_FEAT = re.compile(r"[\s(（\[]*(feat\.?|ft\.?|featuring)\s.*$", re.IGNORECASE)
_BY = re.compile(r"\s*(\bcovered by\b|\bcover by\b|\bby\b|\bcover\b|cover\s*by)\s*\S.*$", re.IGNORECASE)
_SEPARATORS = (" - ", " – ", " — ", " / ", "／", " | ", "｜", " ー ", "－", " : ", " ： ")
_STRIP = " -–—/|｜:：\"'“”"


def clean_title(raw: str) -> str:
    """A video title without bracketed tags and trailing ``| channel`` parts."""
    t = _BRACKETED.sub(" ", raw)
    for sep in (" | ", "｜"):
        if sep in t:
            t = t.split(sep, 1)[0]
    return re.sub(r"\s+", " ", t).strip(" -–—/")


def strip_noise(text: str) -> str:
    """Release-type and platform words removed (``Official Video``, ``歌ってみた``, ``中字``...)."""
    t = _NOISE.sub(" ", text)
    return re.sub(r"\s+", " ", t).strip(_STRIP)


def bracket_parts(raw: str) -> tuple[str, list[str]]:
    """``(text outside the brackets, [text inside each bracket pair or pair of quotes])``."""
    inner = [m.group(0)[1:-1].strip() for m in _BRACKETED.finditer(raw)]
    outer = _BRACKETED.sub(" ", raw)
    for q in _QUOTED.finditer(outer):
        inner.append(q.group(1).strip())
    return re.sub(r"\s+", " ", outer).strip(), [i for i in inner if i]


def guess_artist_title(raw_title: str, uploader: str | None = None) -> tuple[str | None, str]:
    """``(artist, title)`` from a video title like ``Artist - Song (Official Video)``.

    Falls back to the uploader (without `` - Topic`` / ``VEVO``) as the artist.
    """
    t = clean_title(raw_title)
    for sep in _SEPARATORS[:6]:
        if sep in t:
            left, right = t.split(sep, 1)
            left, right = left.strip(), _NOISE.sub("", right).strip()
            if left and right:
                return left, right
    artist = None
    if uploader:
        artist = re.sub(r"\s*-\s*Topic$|VEVO$", "", uploader).strip() or None
    return artist, _NOISE.sub("", t).strip() or t


def channel_artist(uploader: str | None) -> str | None:
    """The artist a channel name stands for: ``YOASOBI Official``, ``X - Topic``, ``A / B Official`` → first name."""
    if not uploader:
        return None
    u = re.sub(r"\s*-\s*Topic$|VEVO$", "", uploader, flags=re.IGNORECASE)
    u = u.split(" / ")[0].split("／")[0]
    u = re.sub(r"\b(official|channel|music|records?|vevo)\b|公式|オフィシャル|ちゃんねる|チャンネル|官方", " ", u,
               flags=re.IGNORECASE)
    u = re.sub(r"\s+", " ", u).strip(" -–—|")
    return u or None


# ── normalising and comparing names ──────────────────────────────────────────


def norm(s: str | None) -> str:
    """Comparable form: NFKC, case-folded, katakana → hiragana, letters and digits only."""
    if not s:
        return ""
    t = unicodedata.normalize("NFKC", s).casefold()
    t = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in t)
    return "".join(c for c in t if c.isalnum())


def sim(a: str | None, b: str | None) -> float:
    """0..1 similarity of two names (exact, one inside the other, or edit ratio)."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    short, long_ = sorted((na, nb), key=len)
    ratio = difflib.SequenceMatcher(None, na, nb).ratio()
    if len(short) >= 2 and short in long_:
        ratio = max(ratio, 0.6 + 0.35 * len(short) / len(long_))
    return ratio


# ── LRC ──────────────────────────────────────────────────────────────────────

_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
# "[00:00.00] 作词 : x" style header lines that NetEase / QQ put on top of the lyrics.
_CREDIT = re.compile(
    r"^\s*(作词|作詞|作曲|编曲|編曲|歌词|歌詞|词|詞|曲|演唱|歌手|制作|製作|混音|母带|录音|和声|吉他|贝斯|鼓|"
    r"lyrics?|music|composed?|composer|arranged?|arranger|words?|vocals?|written|producer|mix(ed)?|master(ed)?|"
    r"translation|translator|原唱|翻譯|翻译|歌名|专辑|專輯)\s*(by)?\s*[:：]",
    re.IGNORECASE,
)


def parse_lrc(text: str) -> list[dict[str, Any]]:
    """Synced LRC → ``[{"t": seconds, "text": line}]`` sorted by time (empty lines kept as breaks).

    Lines with several stamps (``[00:12.00][01:30.00]chorus``) appear once per stamp; ``[offset:+n]``
    (milliseconds, positive = earlier) is applied.
    """
    offset = 0.0
    m = re.search(r"\[offset:\s*([+-]?\d+)\]", text, re.IGNORECASE)
    if m:
        offset = int(m.group(1)) / 1000.0
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        stamps = list(_TIME.finditer(line))
        if not stamps:
            continue
        body = _TIME.sub("", line).strip()
        for s in stamps:
            frac = s.group(3) or "0"
            seconds = int(s.group(1)) * 60 + int(s.group(2)) + int(frac) / (10 ** len(frac))
            out.append({"t": round(max(0.0, seconds - offset), 3), "text": body})
    out.sort(key=lambda x: x["t"])
    return out


def clean_lrc(text: str) -> str:
    """The LRC without credit lines (``作词 : x``) and stray non-LRC lines (NetEase JSON lines)."""
    keep: list[str] = []
    for line in text.splitlines():
        if not line.lstrip().startswith("["):
            continue
        if _TIME.search(line) and _CREDIT.match(_TIME.sub("", line).strip()):
            continue
        keep.append(line.rstrip())
    return "\n".join(keep)


def lrc_fit(lines: list[dict[str, Any]], duration: float | None) -> dict[str, Any]:
    """Does synced ``lines`` belong to audio of ``duration`` seconds? Judged on the last sung line.

    Real lyrics end somewhere in the last stretch of the song: the last line at 55 %..103 % of its length
    (an instrumental outro is fine, ending long before the audio does is not).
    """
    sung = [ln for ln in lines if ln["text"]]
    if len(sung) < 4:
        return {"ok": False, "reason": "too few lines", "lines": len(sung)}
    last = sung[-1]["t"]
    if not duration:
        return {"ok": True, "last_t": last, "ratio": None}
    ratio = last / duration
    ok = 0.55 <= ratio <= 1.03
    out: dict[str, Any] = {"ok": ok, "last_t": last, "ratio": round(ratio, 3)}
    if not ok:
        out["reason"] = "lyrics end at %.0f %% of the song" % (ratio * 100)
    return out


# ── sources ──────────────────────────────────────────────────────────────────


def http_json(method: str, url: str, *, params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
              timeout: float = 8.0) -> Any:
    """JSON of one request, or None on any failure (lyrics are best effort). The tests replace this."""
    import httpx

    try:
        r = httpx.request(method, url, params=params, data=data, timeout=timeout,
                          headers={"User-Agent": USER_AGENT}, follow_redirects=True)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception as e:
        log.info("lyrics request %s failed: %s", url, e)
        return None


@dataclass
class Query:
    title: str
    artist: str | None
    how: str  # metadata | title | llm
    alts: tuple[str, ...] = ()  # other spellings of the title (llm)


@dataclass
class Candidate:
    provider: str
    track: str
    artist: str
    duration: float | None
    lrc: str | None = None
    plain: str | None = None
    ref: Any = None  # provider-specific id when the lyrics are fetched on demand
    how: str = "title"
    query: str = ""
    # filled by score()
    confidence: float = 0.0
    title_sim: float = 0.0
    artist_sim: float | None = None
    duration_diff: float | None = None
    fit: dict[str, Any] = field(default_factory=dict)
    checks: dict[str, Any] = field(default_factory=dict)


def _lrclib_items(items: Any, how: str, query: str) -> list[Candidate]:
    out: list[Candidate] = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict) or it.get("instrumental"):
            continue
        synced, plain = it.get("syncedLyrics") or None, it.get("plainLyrics") or None
        if not synced and not plain:
            continue
        out.append(Candidate("lrclib", str(it.get("trackName") or ""), str(it.get("artistName") or ""),
                             float(it["duration"]) if it.get("duration") else None, synced, plain,
                             how=how, query=query))
    return out


def search_lrclib(title: str, artist: str | None, how: str, timeout: float) -> list[Candidate]:
    """lrclib's search: by track + artist, then free text (its ``q`` also reads the artist)."""
    if artist:
        tries = [{"track_name": title, "artist_name": artist}, {"q": f"{artist} {title}"}]
    else:
        tries = [{"track_name": title}, {"q": title}]
    for params in tries:
        found = _lrclib_items(http_json("GET", LRCLIB_URL + "/api/search", params=params, timeout=timeout),
                              how, " ".join(params.values()))
        if found:
            return found
    return []


def search_netease(title: str, artist: str | None, how: str, timeout: float) -> list[Candidate]:
    """NetEase Cloud Music's public search (no account); the lyrics are fetched later for the best only."""
    q = f"{title} {artist}" if artist else title
    r = http_json("POST", NETEASE_URL + "/api/search/get/web",
                  data={"s": q, "type": 1, "limit": 8, "offset": 0}, timeout=timeout)
    songs = ((r or {}).get("result") or {}).get("songs") if isinstance(r, dict) else None
    out: list[Candidate] = []
    for s in songs or []:
        try:
            names = [a.get("name", "") for a in (s.get("artists") or s.get("ar") or [])]
            dur = s.get("duration") or s.get("dt")
            out.append(Candidate("netease", str(s.get("name") or ""), " / ".join(n for n in names if n),
                                 float(dur) / 1000.0 if dur else None, ref=s.get("id"), how=how, query=q))
        except Exception:
            continue
    return out


def fetch_netease_lyrics(c: Candidate, timeout: float) -> None:
    if c.lrc or c.plain or c.ref is None:
        return
    r = http_json("GET", NETEASE_URL + "/api/song/lyric", params={"id": c.ref, "lv": -1, "kv": -1, "tv": -1},
                  timeout=timeout)
    if not isinstance(r, dict) or r.get("nolyric") or r.get("uncollected"):
        return
    text = str(((r.get("lrc") or {}).get("lyric")) or "")
    cleaned = clean_lrc(text)
    if _TIME.search(cleaned):
        c.lrc = cleaned
    elif text.strip():
        c.plain = text.strip()


# ── queries ──────────────────────────────────────────────────────────────────


def _add(out: list[Query], seen: set[tuple[str, str]], title: str | None, artist: str | None, how: str) -> None:
    title = re.sub(r"\s+", " ", title or "").strip(_STRIP)
    artist = re.sub(r"\s+", " ", artist or "").strip(_STRIP) or None
    if not norm(title):
        return
    k = (norm(title), norm(artist))
    if k in seen:
        return
    seen.add(k)
    out.append(Query(title, artist, how))


def direct_queries(hints: dict[str, Any], limit: int = 12) -> list[Query]:
    """What to look up from the video itself, best guesses first (metadata, then title readings)."""
    out: list[Query] = []
    seen: set[tuple[str, str]] = set()
    raw = str(hints.get("raw_title") or hints.get("title") or "")
    ch_artist = channel_artist(hints.get("uploader") or hints.get("channel"))

    # 1. the video's own music metadata (YouTube Music / "Provided to YouTube" uploads)
    track, art = hints.get("track"), hints.get("meta_artist")
    if track:
        _add(out, seen, track, art, "metadata")
        _add(out, seen, strip_noise(_FEAT.sub("", str(track))), art, "metadata")
    if hints.get("alt_title"):
        _add(out, seen, hints["alt_title"], art, "metadata")

    # 2. the title the resolver read, and the same swapped (the artist ends up in the title often)
    t0, a0 = hints.get("title"), hints.get("artist")
    if t0:
        _add(out, seen, t0, a0, "title")
        if a0:
            _add(out, seen, a0, t0, "title")

    # 3. the raw title: cleaned, split on separators in both orders, with the channel as artist
    outer, inner = bracket_parts(raw)
    cleaned = strip_noise(clean_title(raw))
    for sep in _SEPARATORS:
        if sep in cleaned:
            left, right = (x.strip() for x in cleaned.split(sep, 1))
            if left and right:
                _add(out, seen, strip_noise(right), left, "title")
                _add(out, seen, strip_noise(left), right, "title")
                _add(out, seen, strip_noise(_FEAT.sub("", right)), left, "title")
            break
    _add(out, seen, cleaned, ch_artist, "title")
    _add(out, seen, cleaned, None, "title")
    _add(out, seen, _FEAT.sub("", cleaned), ch_artist, "title")
    _add(out, seen, _BY.sub("", cleaned), None, "title")
    _add(out, seen, _EPISODE.sub(" ", cleaned), ch_artist, "title")
    if ch_artist:
        _add(out, seen, re.sub(re.escape(ch_artist), " ", cleaned, flags=re.IGNORECASE), ch_artist, "title")

    # 4. text in brackets: 「Song」 after an artist, 【Artist】 before a song, "Song" in quotes
    for i in inner:
        i2 = strip_noise(i)
        if len(norm(i2)) < 2:
            continue
        _add(out, seen, i2, strip_noise(outer) or ch_artist, "title")
        _add(out, seen, strip_noise(outer), i2, "title")
    # 5. the raw text with only the noise words removed, as a last free-text try
    _add(out, seen, strip_noise(raw), None, "title")
    return out[:limit]


# ── scoring ──────────────────────────────────────────────────────────────────


def duration_score(diff: float | None) -> float:
    """1 within 3 s, falling to 0 at 20 s; 0.5 when one side is unknown."""
    if diff is None:
        return 0.5
    if diff <= 3:
        return 1.0
    if diff >= 20:
        return 0.0
    return (20 - diff) / 17


def score(c: Candidate, q: Query, duration: float | None) -> Candidate:
    """Fills ``confidence`` and its parts: 0.4 title, 0.2 artist (when the query has one), 0.4 duration."""
    ts = max(sim(c.track, n) for n in (q.title, *q.alts))
    asim = sim(c.artist, q.artist) if q.artist else None
    c.title_sim = round(ts, 3)
    c.artist_sim = None if asim is None else round(asim, 3)
    c.duration_diff = None if not (duration and c.duration) else round(abs(c.duration - duration), 2)
    d = duration_score(c.duration_diff)
    c.confidence = round(0.55 * ts + 0.45 * d if asim is None else 0.4 * ts + 0.2 * asim + 0.4 * d, 3)
    return c


def acceptable(c: Candidate) -> bool:
    if c.title_sim < 0.5 or c.confidence < 0.6:
        return False
    return c.duration_diff is None or c.duration_diff <= 15


# ── ASR spot check ───────────────────────────────────────────────────────────


def asr_text(wav: bytes, url: str, timeout: float) -> str | None:
    """What the ASR worker hears in a wav clip (None if it is away or offloaded). The tests replace this."""
    import httpx

    try:
        r = httpx.post(url.rstrip("/") + "/asr", files={"audio": ("clip.wav", wav, "audio/wav")}, timeout=timeout)
        if r.status_code != 200:
            return None
        return str(r.json().get("text") or "")
    except Exception as e:
        log.info("asr spot check failed: %s", e)
        return None


def _clip(audio: Path, t0: float, t1: float) -> bytes | None:
    try:
        import io

        import numpy as np
        import soundfile as sf

        info = sf.info(str(audio))
        x, rate = sf.read(str(audio), start=int(max(0, t0) * info.samplerate), stop=int(t1 * info.samplerate),
                          dtype="float32", always_2d=True)
        if not len(x):
            return None
        buf = io.BytesIO()
        sf.write(buf, np.asarray(x).mean(axis=1), rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    except Exception as e:
        log.info("asr clip failed: %s", e)
        return None


def coverage(line: str, heard: str) -> float:
    """Share of the line's characters found in order in what ASR heard (0..1)."""
    a, b = norm(line), norm(heard)
    if not a or not b:
        return 0.0
    m = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return sum(x.size for x in m.get_matching_blocks()) / len(a)


def asr_spot_check(lines: list[dict[str, Any]], audio: Path, url: str, *, count: int = 3, timeout: float = 30.0,
                   clip: Callable[[Path, float, float], bytes | None] | None = None) -> dict[str, Any] | None:
    """Cut a few sung lines out of the lead vocal and compare what ASR hears with the lyrics.

    ``{"score": mean coverage, "lines": n, "ok": bool | None}``: ``ok`` False below 0.35 (not these
    words), True from 0.6, None in between (Japanese kanji vs ASR kana, humming...). None = no verdict.
    """
    cand = [i for i, ln in enumerate(lines[:-1]) if len(norm(ln["text"])) >= 5 and lines[i + 1]["t"] - ln["t"] >= 2.0]
    if not cand:
        return None
    picks = sorted({cand[int(len(cand) * f)] for f in (0.25, 0.5, 0.75)})[:count]
    scores: list[float] = []
    for i in picks:
        t0, t1 = lines[i]["t"], min(lines[i + 1]["t"], lines[i]["t"] + 10.0)
        wav = (clip or _clip)(audio, t0 - 0.2, t1 + 0.2)
        if not wav:
            continue
        heard = asr_text(wav, url, timeout)
        if heard is None:
            return None
        scores.append(coverage(lines[i]["text"], heard))
    if not scores:
        return None
    mean = sum(scores) / len(scores)
    return {"score": round(mean, 3), "lines": len(scores),
            "ok": False if mean < 0.35 else True if mean >= 0.6 else None}


# ── the search ───────────────────────────────────────────────────────────────

WAVE = 4  # queries searched at once
MAX_QUERIES = 12  # per stage (the direct ones, then the language model's)


def result_of(c: Candidate, tried: int, llm_info: dict[str, Any] | None) -> dict[str, Any]:
    lines = parse_lrc(c.lrc) if c.lrc else []
    return {
        "provider": c.provider, "synced": bool(lines), "lrc": c.lrc if lines else None,
        "plain": None if lines else c.plain, "track": c.track, "artist": c.artist,
        "how": c.how, "confidence": c.confidence, "matched": {"query": c.query, "duration_s": c.duration},
        "checks": {"title": c.title_sim, "artist": c.artist_sim, "duration_diff_s": c.duration_diff,
                   "fit": c.fit or None, **c.checks},
        "tried": tried, "llm": llm_info,
    }


def find_lyrics(
    hints: dict[str, Any],
    duration: float | None,
    *,
    llm: Callable[[dict[str, Any], list[Query]], list[Query]] | None = None,
    audio: Path | None = None,
    asr_url: str | None = None,
    asr_mode: str = "auto",
    netease: bool = True,
    budget_s: float = 45.0,
    timeout: float = 8.0,
    min_confident: float = 0.72,
) -> dict[str, Any] | None:
    """The best lyrics for the video described by ``hints``, or None.

    ``hints`` (``hints_of``): raw_title, title, artist (as the worker read them), uploader, track / meta_artist /
    alt_title (the video's own music metadata), description, tags, duration, key.
    ``llm(hints, tried)`` returns the song(s) it believes the video is (called, at most twice, when the
    direct queries found nothing sure enough; ``tried`` is what already found nothing; see lyricsllm.py).
    ``asr_mode``: ``auto`` checks only matches that are not confident yet, ``1`` always, ``0`` never; it
    needs ``audio`` (the lead vocal) and ``asr_url``.
    """
    deadline = time.monotonic() + budget_s
    cands: list[Candidate] = []
    done: list[Query] = []
    seen: set[tuple[str, str]] = set()
    llm_info: dict[str, Any] | None = None

    def search_one(q: Query) -> list[Candidate]:
        new = search_lrclib(q.title, q.artist, q.how, timeout)
        if netease and time.monotonic() < deadline:
            new += search_netease(q.title, q.artist, q.how, timeout)
        for c in new:
            score(c, q, duration)
        return new

    def sure(found: list[Candidate]) -> bool:
        """An exact title on a duration-fitting synced lrclib result: nothing more to look for."""
        return any(c.provider == "lrclib" and c.lrc and c.confidence >= 0.9 and c.title_sim >= 0.9 for c in found)

    def run(queries: list[Query], cap: int = MAX_QUERIES) -> None:
        """Search ``queries`` (best guesses first) in waves of WAVE, in parallel; stop at a sure hit."""
        fresh: list[Query] = []
        for q in queries:
            k = (norm(q.title), norm(q.artist))
            if k not in seen and len(fresh) < cap:
                seen.add(k)
                fresh.append(q)
        for i in range(0, len(fresh), WAVE):
            if time.monotonic() > deadline:
                return
            wave = fresh[i:i + WAVE]
            done.extend(wave)
            with ThreadPoolExecutor(max_workers=len(wave)) as pool:
                got = list(pool.map(search_one, wave))
            for found in got:
                cands.extend(found)
            if any(sure(found) for found in got):
                return

    def settle() -> Candidate | None:
        """First acceptable candidate that has lyrics, fits the audio and survives the ASR check."""
        ok = sorted((c for c in cands if acceptable(c)), key=lambda c: (bool(c.lrc), c.confidence), reverse=True)
        # a NetEase hit has its lyrics fetched only now, so look at the best few
        for c in sorted(ok, key=lambda c: c.confidence, reverse=True)[:4]:
            if c.provider == "netease" and time.monotonic() < deadline:
                fetch_netease_lyrics(c, timeout)
        ok = sorted((c for c in ok if c.lrc or c.plain), key=lambda c: (bool(c.lrc), c.confidence), reverse=True)
        for c in ok[:6]:
            lines = parse_lrc(c.lrc) if c.lrc else []
            if lines:
                c.fit = lrc_fit(lines, duration)
                if not c.fit["ok"]:
                    c.checks["rejected"] = c.fit.get("reason")
                    continue
            else:
                c.confidence = round(min(c.confidence, 0.7), 3)  # plain: no timing to check
            want = asr_mode == "1" or (asr_mode == "auto" and c.confidence < 0.85)
            if want and lines and audio is not None and asr_url and audio.exists():
                a = asr_spot_check(lines, audio, asr_url)
                if a is not None:
                    c.checks["asr"] = a
                    if a["ok"] is False:
                        c.checks["rejected"] = "the lead vocal does not say these words"
                        continue
                    if a["ok"]:
                        c.confidence = round(min(1.0, c.confidence + 0.1), 3)
            return c
        return None

    run(direct_queries(hints))
    chosen = settle()

    if llm is not None and (chosen is None or chosen.confidence < min_confident) and time.monotonic() < deadline:
        for attempt in range(2):
            try:
                proposals = llm(hints, list(done))
            except Exception as e:
                log.warning("lyrics llm failed: %s", e)
                proposals = []
            llm_info = {"songs": [{"title": q.title, "artist": q.artist} for q in proposals], "attempts": attempt + 1}
            if not proposals:
                break
            asked = [Query(q.title, q.artist, "llm", q.alts) for q in proposals]
            run(asked)
            # bare titles and other spellings, in case the artist is spelled differently over there
            run([Query(a, None, "llm") for q in asked for a in (q.title, *q.alts[:2])], 6)
            better = settle()
            if better is not None and (chosen is None or better.confidence > chosen.confidence):
                chosen = better
            if (chosen is not None and chosen.confidence >= min_confident) or time.monotonic() > deadline:
                break
    if chosen is None:
        return None
    return result_of(chosen, len(done), llm_info)


# ── the worker's entry points ────────────────────────────────────────────────


def hints_of(src: Any) -> dict[str, Any]:
    """What the lookup knows about a resolved ``songs.Source`` (the video's own fields are in ``extra``)."""
    ex = getattr(src, "extra", None) or {}
    h = {
        "key": src.key, "raw_title": ex.get("raw_title"), "title": src.title, "artist": src.artist,
        "uploader": getattr(src, "uploader", None), "track": ex.get("track"), "meta_artist": ex.get("meta_artist"),
        "alt_title": ex.get("alt_title"), "description": ex.get("description"), "tags": ex.get("tags"),
        "duration": src.duration_s, "url": src.url,
    }
    return {k: v for k, v in h.items() if v}


def search(hints: dict[str, Any], duration: float | None, *, cache_dir: Path | None = None, audio: Path | None = None,
           asr_url: str | None = None, fresh: bool = False) -> dict[str, Any] | None:
    """``find_lyrics`` with the worker's settings (SING_LYRICS_* env, Core's LLM); never raises."""
    import os

    try:
        proposer = None
        if os.environ.get("SING_LYRICS_LLM", "1") != "0":
            import lyricsllm

            cfg = lyricsllm.load_config()
            if cfg:
                proposer = lyricsllm.make_proposer(
                    cfg, cache_dir, timeout=float(os.environ.get("SING_LYRICS_LLM_TIMEOUT_S", "20")), fresh=fresh)
        asr = asr_url if asr_url is not None else os.environ.get("SING_LYRICS_ASR_URL", "http://127.0.0.1:8003")
        return find_lyrics(
            hints, duration, llm=proposer, audio=audio, asr_url=asr or None,
            asr_mode=os.environ.get("SING_LYRICS_ASR", "auto"),
            netease=os.environ.get("SING_LYRICS_NETEASE", "1") != "0",
            budget_s=float(os.environ.get("SING_LYRICS_BUDGET_S", "45")),
        )
    except Exception as e:  # lyrics are best effort
        log.warning("lyrics search failed: %s", e)
        return None
