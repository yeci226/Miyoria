"""Lyrics for the song worker: title cleanup, synced LRC parsing and the lrclib.net lookup.

Pure Python (plus ``httpx`` for the lookup), so the tests run without the GPU stack.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable

log = logging.getLogger("miyoria.sing.lyrics")

LRCLIB_URL = "https://lrclib.net"

# Video-title noise: "(Official Video)", "[MV]", "【歌ってみた】", "| 4K", "feat. X" stays.
_BRACKETED = re.compile(r"[\(\[【「『《〔][^\)\]】」』》〕]*[\)\]】」』》〕]")
# A song named in quotes, sometimes followed by who sings it: 「Song」, 《Song》, “Song” by Artist.
_QUOTED = re.compile(r"[「『《“]([^」』》”]+)[」』》”]")
_BY = re.compile(r"\s*by\s+([^|｜]+)", re.IGNORECASE)
_NOISE = re.compile(
    r"\b(official|music|lyric|lyrics|video|audio|mv|pv|hd|4k|hq|full|ver\.?|version|remaster(ed)?)\b",
    re.IGNORECASE,
)
_SEPARATORS = (" - ", " – ", " — ", " / ", "／", " | ", "｜")


def clean_title(raw: str) -> str:
    """A video title without bracketed tags and trailing ``| channel`` parts."""
    t = _BRACKETED.sub(" ", raw)
    for sep in (" | ", "｜"):
        if sep in t:
            t = t.split(sep, 1)[0]
    return re.sub(r"\s+", " ", t).strip(" -–—/")


def _quoted_song(raw: str) -> tuple[str, str | None] | None:
    """``(song, artist or None)`` from the first quoted name that is not a version tag."""
    for m in _QUOTED.finditer(raw):
        song = _BRACKETED.sub(" ", m.group(1)).strip()
        if song and not _NOISE.search(song):
            by = _BY.match(raw, m.end())
            return song, by.group(1).strip() if by else None
    return None


def guess_artist_title(raw_title: str, uploader: str | None = None) -> tuple[str | None, str]:
    """``(artist, title)`` from a video title like ``Artist - Song (Official Video)``.

    Without that form, a quoted name is the song (``Show | “Song” by Artist | Music Video``).
    Falls back to the uploader (without `` - Topic`` / ``VEVO``) as the artist.
    """
    t = clean_title(raw_title)
    for sep in _SEPARATORS:
        if sep in t:
            left, right = t.split(sep, 1)
            left, right = left.strip(), _NOISE.sub("", right).strip()
            if left and right:
                return left, right
    artist = None
    if uploader:
        artist = re.sub(r"\s*-\s*Topic$|VEVO$", "", uploader).strip() or None
    quoted = _quoted_song(raw_title)
    if quoted:
        return quoted[1] or artist, quoted[0]
    return artist, _NOISE.sub("", t).strip() or t


_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


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


def _score(item: dict[str, Any], title: str, artist: str | None, duration: float | None) -> float:
    s = 0.0
    if not item.get("syncedLyrics"):
        s -= 100
    if duration and item.get("duration"):
        s -= abs(float(item["duration"]) - duration)
    name = str(item.get("trackName") or "").lower()
    if title.lower() in name or name in title.lower():
        s += 5
    if artist and artist.lower() in str(item.get("artistName") or "").lower():
        s += 5
    return s


def _search(c: Any, params: dict[str, str], attempts: int, backoff: tuple[float, ...],
            sleep: Callable[[float], None]) -> list[Any]:
    """One lrclib search; 5xx, 429 and network errors are tried again (``attempts`` in all)."""
    import httpx

    for attempt in range(attempts):
        last = attempt == attempts - 1
        try:
            r = c.get("/api/search", params=params)
        except httpx.TransportError:
            if last:
                raise
        else:
            if r.status_code == 200:
                items = r.json()
                return items if isinstance(items, list) else []
            if not (r.status_code >= 500 or r.status_code == 429) or last:
                log.info("lyrics search answered %s", r.status_code)
                return []
        sleep(backoff[min(attempt, len(backoff) - 1)])
    return []


def lookup(
    title: str,
    artist: str | None,
    duration: float | None,
    *,
    query: str | None = None,
    attempts: int = 3,
    backoff: tuple[float, ...] = (1.0, 3.0),
    sleep: Callable[[float], None] = time.sleep,
    base_url: str = LRCLIB_URL,
    timeout: float = 10.0,
    client: Any = None,
) -> dict[str, Any] | None:
    """Best lrclib.net match: ``{"provider", "synced", "lrc", "plain", "track", "artist"}`` or None.

    Searches by title (and artist), then ``artist title``, then the request as typed (``query``:
    a video title often is not the song's name). Busy answers are tried again. Prefers synced
    lyrics whose duration is within 15 s of the song. Network errors → None.
    """
    import httpx

    headers = {"User-Agent": "Miyoria song worker (https://github.com/miyoria)"}
    own = client is None
    c = client or httpx.Client(base_url=base_url, timeout=timeout, headers=headers)

    def search(params: dict[str, str]) -> list[Any]:
        return _search(c, params, attempts, backoff, sleep)

    try:
        params: dict[str, str] = {"track_name": title}
        if artist:
            params["artist_name"] = artist
        items = search(params)
        if not items and artist:
            items = search({"q": f"{artist} {title}"})
        q = (query or "").strip()
        if not items and q and q.lower() not in (title.lower(), f"{artist} {title}".lower()):
            items = search({"q": q})
        if not items:
            return None
        best = max(items, key=lambda it: _score(it, title, artist, duration))
        if duration and best.get("duration") and abs(float(best["duration"]) - duration) > 15:
            return None
        synced = best.get("syncedLyrics") or None
        plain = best.get("plainLyrics") or None
        if not synced and not plain:
            return None
        return {
            "provider": "lrclib",
            "synced": synced is not None,
            "lrc": synced,
            "plain": plain,
            "track": best.get("trackName"),
            "artist": best.get("artistName"),
        }
    except Exception as e:  # lyrics are best effort
        log.info("lyrics lookup failed: %s", e)
        return None
    finally:
        if own:
            c.close()
