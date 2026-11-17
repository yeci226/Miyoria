"""Song cache layout, ids and the local library. Pure Python (no numpy), shared by both backends.

    <root>/<song_id>/            one converted song (a source + its pitch settings)
        meta.json  mix.wav  vocals.wav  instrumental.wav  lyrics.lrc?
        play_mix.pcm  play_vocals.pcm      s16le mono 48 kHz, what Core streams to voice
        video.mp4?                         the original video, muted on stream (a hard link of
                                           the source's when the volume allows; library: video.<ext>)
    <root>/_sources/<source_key>/  downloaded audio and its stems, reused when only the key changes
        source.wav  vocals.wav  instrumental.wav  lead.wav?  backing.wav?  info.json  video.mp4?  video.json?
                                           lead + backing = vocals (leadsplit.py); older stems get them on demand
    <root>/queries.json          normalised query → source key (so repeated requests skip the search)
    <root>/_usage.json           when each song and download was last used (cache.py, which removes
                                 the least recently used ones; ``_trash-*`` dirs are ones on their way out)
    <root>/library/              the owner's own files: full songs, or a folder with
                                 vocals.* + instrumental.* (+ lyrics.lrc, info.json {title, artist});
                                 a video next to the audio (``video.*`` in a folder, the same name
                                 with a video extension for a file) is shown while she sings it
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import unicodedata
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

PLAY_RATE = 48_000
AUDIO_EXTS = (".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".aac", ".webm")
# Videos OBS's media source plays; a song's video is ``video<ext>``.
VIDEO_EXTS = (".mp4", ".mkv", ".webm", ".mov", ".m4v")
# Files a client may fetch from a song directory.
SONG_FILES = {
    "mix.wav": "audio/wav",
    "vocals.wav": "audio/wav",
    "instrumental.wav": "audio/wav",
    "lyrics.lrc": "text/plain; charset=utf-8",
    "play_mix.pcm": "audio/L16",
    "play_vocals.pcm": "audio/L16",
    "meta.json": "application/json",
    "video.mp4": "video/mp4",
    "video.m4v": "video/mp4",
    "video.mkv": "video/x-matroska",
    "video.webm": "video/webm",
    "video.mov": "video/quicktime",
}
_SAFE = re.compile(r"[^A-Za-z0-9_-]+")


def safe_id(text: str, limit: int = 64) -> str:
    return _SAFE.sub("_", text).strip("_")[:limit] or "x"


def short_hash(text: str, n: int = 12) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]


def normalize_query(q: str) -> str:
    q = unicodedata.normalize("NFKC", q).casefold()
    return re.sub(r"\s+", " ", q).strip()


# What happens to the song's backing voices (harmonies, chorus): kept as recorded (default),
# dropped, converted to her voice like the lead, or dropped with the instrumental (a cappella).
BACKING_MODES = ("keep", "drop", "convert", "acapella")
BACKING_SUFFIX = {"keep": "", "drop": "-nobk", "convert": "-cvbk", "acapella": "-acap"}


def song_id(source_key: str, pitch: int | None, key: int, backing: str = "keep") -> str:
    """``<source_key>`` for auto pitch in the original key with the backing voices as recorded,
    else with ``-p<n>`` / ``-k<n>`` / the backing mode's suffix (BACKING_SUFFIX)."""
    sid = source_key
    if pitch is not None:
        sid += f"-p{pitch:+d}"
    if key:
        sid += f"-k{key:+d}"
    sid += BACKING_SUFFIX.get(backing, "")
    return safe_id(sid, 96)


@dataclass
class Source:
    """What a request resolved to."""

    key: str
    kind: str  # youtube | url | library | mock
    title: str
    artist: str | None = None
    duration_s: float | None = None
    url: str | None = None
    uploader: str | None = None
    # library: path relative to the library dir; `split` = vocals + instrumental given
    path: str | None = None
    split: bool = False
    extra: dict[str, Any] = field(default_factory=dict)
    # yt-dlp's full answer when this was looked up, and when (time.monotonic): the download and the
    # video reuse it instead of reading the page, the player and its challenges again (engine.py).
    info: dict[str, Any] | None = field(default=None, repr=False, compare=False)
    info_at: float | None = field(default=None, repr=False, compare=False)

    def public(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self) if f.name not in ("extra", "info", "info_at")}


class Store:
    def __init__(self, root: Path, library: Path | None = None) -> None:
        self.root = root
        self.library = library or (root / "library")
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def song_dir(self, sid: str) -> Path:
        return self.root / safe_id(sid, 96)

    def source_dir(self, key: str) -> Path:
        return self.root / "_sources" / safe_id(key, 96)

    def meta(self, sid: str) -> dict[str, Any] | None:
        p = self.song_dir(sid) / "meta.json"
        try:
            meta = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        d = self.song_dir(sid)
        if not (d / "play_mix.pcm").exists():
            return None
        return meta

    def write_meta(self, sid: str, meta: dict[str, Any]) -> None:
        d = self.song_dir(sid)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, d / "meta.json")

    def songs(self) -> list[dict[str, Any]]:
        out = []
        for d in sorted(self.root.iterdir()) if self.root.exists() else []:
            if d.is_dir() and not d.name.startswith("_") and d.name != "library":
                m = self.meta(d.name)
                if m is not None:
                    out.append(m)
        out.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        return out

    # ── queries ────────────────────────────────────────────────────────────

    def _queries(self) -> dict[str, str]:
        try:
            return json.loads((self.root / "queries.json").read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def query_source(self, query: str) -> str | None:
        with self._lock:
            return self._queries().get(normalize_query(query))

    def remember_query(self, query: str, source_key: str) -> None:
        with self._lock:
            q = self._queries()
            q[normalize_query(query)] = source_key
            tmp = self.root / "queries.json.tmp"
            tmp.write_text(json.dumps(q, ensure_ascii=False, indent=1), "utf-8")
            os.replace(tmp, self.root / "queries.json")

    def forget_sources(self, keys: set[str]) -> None:
        """Drops the queries that led to these downloads (cache.py removed them): asking again
        searches again instead of finding a download that is gone."""
        with self._lock:
            q = self._queries()
            kept = {k: v for k, v in q.items() if safe_id(v, 96) not in keys}
            if len(kept) == len(q):
                return
            tmp = self.root / "queries.json.tmp"
            tmp.write_text(json.dumps(kept, ensure_ascii=False, indent=1), "utf-8")
            os.replace(tmp, self.root / "queries.json")

    def source_info(self, key: str) -> dict[str, Any] | None:
        try:
            return json.loads((self.source_dir(key) / "info.json").read_text("utf-8"))
        except (OSError, ValueError):
            return None

    def write_source_info(self, src: Source) -> None:
        d = self.source_dir(src.key)
        d.mkdir(parents=True, exist_ok=True)
        (d / "info.json").write_text(json.dumps(src.public(), ensure_ascii=False, indent=2), "utf-8")

    # ── library ────────────────────────────────────────────────────────────

    def library_entries(self) -> list[dict[str, Any]]:
        """Full songs (audio files) and split folders (``vocals.*`` + ``instrumental.*``)."""
        lib = self.library
        if not lib.exists():
            return []
        out: list[dict[str, Any]] = []
        for p in sorted(lib.rglob("*")):
            rel = p.relative_to(lib).as_posix()
            if p.is_dir():
                vocals = _stem_file(p, "vocals")
                inst = _stem_file(p, "instrumental") or _stem_file(p, "inst")
                if vocals and inst:
                    info = _read_info(p / "info.json")
                    out.append({
                        "path": rel,
                        "title": info.get("title") or p.name,
                        "artist": info.get("artist"),
                        "split": True,
                    })
            elif p.suffix.lower() in AUDIO_EXTS and not _inside_split(p, lib):
                artist, title = _split_name(p.stem)
                out.append({"path": rel, "title": title, "artist": artist, "split": False})
        return out

    def library_path(self, rel: str) -> Path:
        """``rel`` inside the library, or ValueError (no traversal)."""
        lib = self.library.resolve()
        p = (lib / rel).resolve()
        if p != lib and lib not in p.parents:
            raise ValueError("path is outside the song library")
        if not p.exists():
            raise ValueError(f"no such library entry: {rel}")
        return p

    def library_video(self, rel: str) -> Path | None:
        """The video of a library entry: ``video.*`` in its folder, or a file with the same name
        and a video extension next to it."""
        try:
            p = self.library_path(rel)
        except ValueError:
            return None
        if p.is_dir():
            return find_video(p)
        for ext in VIDEO_EXTS:
            v = p.with_suffix(ext)
            if ext != p.suffix.lower() and v.is_file():
                return v
        return None

    def match_library(self, query: str) -> dict[str, Any] | None:
        """A library entry whose ``artist title`` contains every word of the query."""
        words = [w for w in normalize_query(query).split(" ") if w]
        if not words:
            return None
        for e in self.library_entries():
            hay = normalize_query(f"{e.get('artist') or ''} {e['title']} {e['path']}")
            if all(w in hay for w in words):
                return e
        return None


def find_video(d: Path) -> Path | None:
    """``video<ext>`` in ``d`` (the first video extension that exists)."""
    for ext in VIDEO_EXTS:
        p = d / f"video{ext}"
        if p.is_file():
            return p
    return None


def link_or_copy(src: Path, dst: Path) -> None:
    """``dst`` becomes ``src``'s content: a hard link (no copy of a 100 MB video) when the volume
    allows, else a copy."""
    dst.unlink(missing_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def _stem_file(d: Path, stem: str) -> Path | None:
    for ext in AUDIO_EXTS:
        p = d / f"{stem}{ext}"
        if p.exists():
            return p
    return None


def _inside_split(p: Path, lib: Path) -> bool:
    parent = p.parent
    return parent != lib and _stem_file(parent, "vocals") is not None


def _read_info(p: Path) -> dict[str, Any]:
    try:
        v = json.loads(p.read_text("utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _split_name(stem: str) -> tuple[str | None, str]:
    if " - " in stem:
        a, t = stem.split(" - ", 1)
        return a.strip() or None, t.strip() or stem
    return None, stem
