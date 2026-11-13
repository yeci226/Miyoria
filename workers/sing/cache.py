"""The song cache cleans up after itself: least recently used songs and their downloads go first.

What counts as the cache (songs.py has the layout): every song dir under the data dir and every
download under ``_sources``. Nothing else is ever removed: ``library/``, ``queries.json`` (only the
entries of a removed download), ``_ytdlp-cache``, ``_lyrics``, ``_gpu-profile.json`` and any dir
that does not look like a song stay as they are.

Last use
    A song is used when it is made, when a request hits it in the cache, when its files are fetched
    (Core fetches the PCM tracks as she starts singing it; the party game fetches clips) and when
    its lyrics are looked up again. A download is used when a job works from it. The times are kept
    in ``_usage.json`` (epoch seconds); a song or download it does not know (made before this
    existed) was last used when its dir was last changed.

Policy (SING_CACHE_MAX_GB, SING_CACHE_MAX_DAYS, SING_CACHE_PROTECT_HOURS; 0 turns a limit off,
both limits off turns the cleanup off)
    1. never: a song or download of a queued or running job, or one used in the protect window
    2. a song not used for SING_CACHE_MAX_DAYS goes
    3. while the cache is over SING_CACHE_MAX_GB, the least recently used song goes
    4. a download goes once no song is made from it any more (and it is out of the protect window)
    Songs that never finished (no meta.json or no play_mix.pcm: a failed or cancelled job) count as
    songs too, and go by the same rules.

Sizes count each file once: a song's video is a hard link of its download's (songs.link_or_copy),
so removing the song alone frees nothing of it. A file with links outside the cache (a library
video) is not the cache's and not counted.

A removed song or download is first renamed out of the way (``_trash-*``), which fails while a file
in it is open (OBS playing the video): it then stays for the next run. A request for a removed song
simply makes it again (the worker finds no cached song and no download).
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from songs import safe_id

log = logging.getLogger("miyoria.sing.cache")

GB = 1024**3
USAGE_FILE = "_usage.json"
TRASH_PREFIX = "_trash-"
# Files that make a dir under the data dir a song (songs.SONG_FILES, and what a job leaves while it runs).
SONG_MARKERS = ("meta.json", "play_mix.pcm", "mix.wav", "vocals.wav", "_converted.wav")
# A song's own use is written at most this often (Core fetches two tracks per song at once).
TOUCH_EVERY_S = 60.0


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return max(0.0, float(raw))
    except ValueError:
        log.warning("%s=%r is not a number; using %s", name, raw, default)
        return default


@dataclass(frozen=True)
class CacheLimits:
    max_bytes: int  # 0: no size cap
    max_days: float  # 0: no age limit
    protect_hours: float

    @classmethod
    def from_env(cls) -> "CacheLimits":
        return cls(max_bytes=int(_env_float("SING_CACHE_MAX_GB", 6.0) * GB),
                   max_days=_env_float("SING_CACHE_MAX_DAYS", 14.0),
                   protect_hours=_env_float("SING_CACHE_PROTECT_HOURS", 6.0))

    @property
    def on(self) -> bool:
        return self.max_bytes > 0 or self.max_days > 0

    def public(self) -> dict[str, Any]:
        return {"max_gb": round(self.max_bytes / GB, 3), "max_bytes": self.max_bytes, "max_days": self.max_days,
                "protect_hours": self.protect_hours}


@dataclass
class Unit:
    """One song dir or one download dir."""

    kind: str  # song | source
    id: str
    path: Path
    last_used: float
    files: list[tuple[Any, int]] = field(default_factory=list)  # (file identity, size)
    source: str | None = None  # song: the download it was made from
    title: str | None = None
    complete: bool = True  # song: has meta.json and play_mix.pcm


@dataclass
class Protected:
    """What must stay whatever its age: the jobs' songs and downloads."""

    songs: set[str] = field(default_factory=set)
    sources: set[str] = field(default_factory=set)


def _iso(t: float | None) -> str | None:
    if t is None:
        return None
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class Inventory:
    """Every unit of the cache and the files they hold, each file counted once."""

    def __init__(self, units: list[Unit]) -> None:
        self.units = units
        self.size: dict[Any, int] = {}
        self.owners: dict[Any, set[tuple[str, str]]] = {}
        for u in units:
            for ident, size in u.files:
                if ident is None:
                    continue  # links outside the cache: not ours
                self.size[ident] = size
                self.owners.setdefault(ident, set()).add((u.kind, u.id))

    def total(self) -> int:
        return sum(self.size.values())

    def frees(self, unit: Unit, gone: set[tuple[str, str]]) -> int:
        """What removing ``unit`` frees once the units in ``gone`` are already removed."""
        key = (unit.kind, unit.id)
        out = 0
        for ident, _size in unit.files:
            if ident is None:
                continue
            if self.owners.get(ident, set()) - gone - {key}:
                continue
            out += self.size[ident]
        return out


def _files(d: Path) -> list[tuple[Any, int, int]]:
    """(identity, size, links) of every file under ``d``: the identity is the file's inode, or its
    path when the file system has none."""
    out: list[tuple[Any, int, int]] = []
    for root, _dirs, names in os.walk(d):
        for n in names:
            p = Path(root) / n
            try:
                st = os.stat(p)
            except OSError:
                continue
            ident: Any = (st.st_dev, st.st_ino) if st.st_ino else str(p)
            out.append((ident, st.st_size, st.st_nlink or 1))
    return out


class Cache:
    """Last use of every song and download, and the cleanup."""

    def __init__(self, root: Path, library: Path | None = None,
                 protected: Callable[[], Protected] | None = None,
                 forget_sources: Callable[[set[str]], None] | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.root = root
        self.library = library
        self.protected = protected or Protected
        self.forget_sources = forget_sources
        self.clock = clock
        self._lock = threading.RLock()  # the usage times; held while a unit is removed
        self._run = threading.Lock()  # one cleanup at a time
        self._usage: dict[str, dict[str, float]] = self._read_usage()
        self.last: dict[str, Any] | None = None

    # ── last use ─────────────────────────────────────────────────────────────

    def _read_usage(self) -> dict[str, dict[str, float]]:
        try:
            raw = json.loads((self.root / USAGE_FILE).read_text("utf-8"))
        except (OSError, ValueError):
            raw = {}
        out: dict[str, dict[str, float]] = {"songs": {}, "sources": {}}
        for kind in out:
            for k, v in (raw.get(kind) or {}).items() if isinstance(raw, dict) else ():
                if isinstance(v, (int, float)):
                    out[kind][str(k)] = float(v)
        return out

    def _write_usage(self) -> None:
        tmp = self.root / f"{USAGE_FILE}.tmp"
        try:
            tmp.write_text(json.dumps(self._usage, indent=1, sort_keys=True), "utf-8")
            os.replace(tmp, self.root / USAGE_FILE)
        except OSError as e:
            log.warning("cannot write %s: %s", USAGE_FILE, e)

    def touch(self, song: str | None = None, source: str | None = None) -> None:
        """Records a use. Blocks while that song or download is being removed, so after it returns
        the song is either still there (and now protected) or already gone."""
        now = self.clock()
        with self._lock:
            changed = False
            for kind, raw in (("songs", song), ("sources", source)):
                key = safe_id(raw, 96) if raw else None
                if key and now - self._usage[kind].get(key, 0.0) >= TOUCH_EVERY_S:
                    self._usage[kind][key] = now
                    changed = True
            if changed:
                self._write_usage()

    def last_used(self, kind: str, key: str, path: Path) -> float:
        with self._lock:
            t = self._usage["songs" if kind == "song" else "sources"].get(key)
        if t is not None:
            return t
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    # ── what is there ────────────────────────────────────────────────────────

    def _song_dirs(self) -> list[Path]:
        if not self.root.exists():
            return []
        lib = self.library.resolve() if self.library else None
        out = []
        for d in sorted(self.root.iterdir()):
            if not d.is_dir() or d.name.startswith("_") or d.name == "library":
                continue
            if lib is not None and d.resolve() == lib:
                continue
            if any((d / m).exists() for m in SONG_MARKERS):
                out.append(d)
        return out

    def _source_dirs(self) -> list[Path]:
        src = self.root / "_sources"
        return sorted(d for d in src.iterdir() if d.is_dir()) if src.exists() else []

    def inventory(self) -> Inventory:
        sources = self._source_dirs()
        keys = sorted((d.name for d in sources), key=len, reverse=True)
        found: list[tuple[Unit, list[tuple[Any, int, int]]]] = []
        for d in self._song_dirs():
            meta: dict[str, Any] = {}
            try:
                raw = json.loads((d / "meta.json").read_text("utf-8"))
                meta = raw if isinstance(raw, dict) else {}
            except (OSError, ValueError):
                pass
            src_info = meta.get("source")
            src = safe_id(str(src_info["key"]), 96) if isinstance(src_info, dict) and src_info.get("key") else None
            if not src:  # no meta yet: the id starts with its download's key (songs.song_id)
                src = next((k for k in keys if d.name == k or d.name.startswith(k + "-")), None)
            u = Unit("song", d.name, d, self.last_used("song", d.name, d), source=src, title=meta.get("title"),
                     complete=bool(meta) and (d / "play_mix.pcm").exists())
            found.append((u, _files(d)))
        for d in sources:
            found.append((Unit("source", d.name, d, self.last_used("source", d.name, d)), _files(d)))
        self._counted(found)
        return Inventory([u for u, _ in found])

    @staticmethod
    def _counted(found: list[tuple[Unit, list[tuple[Any, int, int]]]]) -> None:
        """Gives every unit its files; one whose links are not all in the cache (a library video
        linked into a song) is not counted (``None``): removing the song frees none of it."""
        seen: dict[Any, int] = {}
        for _u, files in found:
            for ident, _size, _links in files:
                seen[ident] = seen.get(ident, 0) + 1
        for u, files in found:
            u.files = [(None if links > seen.get(ident, 1) else ident, size) for ident, size, links in files]

    def status(self, inv: Inventory | None = None) -> dict[str, Any]:
        inv = inv or self.inventory()
        songs = [u for u in inv.units if u.kind == "song"]
        sources = [u for u in inv.units if u.kind == "source"]
        oldest = min((u.last_used for u in songs), default=None)
        return {"bytes": inv.total(), "gb": round(inv.total() / GB, 2), "songs": len(songs),
                "incomplete_songs": sum(1 for u in songs if not u.complete), "sources": len(sources),
                "oldest_use": _iso(oldest), "limits": CacheLimits.from_env().public(),
                "running": self._run.locked(), "last": self.last}

    # ── the cleanup ──────────────────────────────────────────────────────────

    def _is_protected(self, u: Unit, now: float, limits: CacheLimits, p: Protected) -> bool:
        if (u.id in p.songs) if u.kind == "song" else (u.id in p.sources):
            return True
        last = self.last_used(u.kind, u.id, u.path)
        return now - last < limits.protect_hours * 3600

    def plan(self, inv: Inventory, limits: CacheLimits, now: float, p: Protected) -> list[tuple[Unit, str]]:
        """What goes, in order, and why (``age``, ``size``, ``unused``: a download no song needs)."""
        if not limits.on:
            return []
        songs = sorted((u for u in inv.units if u.kind == "song"), key=lambda u: u.last_used)
        sources = {u.id: u for u in inv.units if u.kind == "source"}
        gone: set[tuple[str, str]] = set()
        out: list[tuple[Unit, str]] = []
        total = inv.total()
        users: dict[str, set[str]] = {}
        for s in songs:
            if s.source:
                users.setdefault(s.source, set()).add(s.id)

        def remove(u: Unit, why: str) -> None:
            nonlocal total
            total -= inv.frees(u, gone)
            gone.add((u.kind, u.id))
            out.append((u, why))

        def release_source(key: str | None, why: str) -> None:
            src = sources.get(key or "")
            if src is None or ("source", src.id) in gone or users.get(src.id):
                return
            if not self._is_protected(src, now, limits, p):
                remove(src, why)

        def drop_song(s: Unit, why: str) -> None:
            remove(s, why)
            if s.source:
                users.get(s.source, set()).discard(s.id)
            release_source(s.source, why)

        # Downloads no song is made from (any more): nothing needs them.
        for key in sorted(sources, key=lambda k: sources[k].last_used):
            release_source(key, "unused")
        if limits.max_days > 0:
            for s in songs:
                if now - s.last_used >= limits.max_days * 86400 and not self._is_protected(s, now, limits, p):
                    drop_song(s, "age")
        if limits.max_bytes > 0:
            for s in songs:
                if total <= limits.max_bytes:
                    break
                if ("song", s.id) in gone or self._is_protected(s, now, limits, p):
                    continue
                drop_song(s, "size")
        return out

    def prune(self, dry_run: bool = False, limits: CacheLimits | None = None) -> dict[str, Any]:
        """One cleanup; returns (and keeps, as ``last``) what it removed or, dry, would remove."""
        limits = limits or CacheLimits.from_env()
        with self._run:
            t0 = time.perf_counter()
            now = self.clock()
            if not dry_run:
                self._sweep_trash()
            inv = self.inventory()
            before = inv.total()
            p = self.protected()
            planned = self.plan(inv, limits, now, p)
            removed: list[dict[str, Any]] = []
            errors: list[str] = []
            gone: set[tuple[str, str]] = set()
            freed = 0
            for u, why in planned:
                frees = inv.frees(u, gone)
                entry = {"kind": u.kind, "id": u.id, "title": u.title, "why": why,
                         "last_used": _iso(u.last_used), "bytes": frees}
                if dry_run:
                    gone.add((u.kind, u.id))
                    freed += frees
                    removed.append(entry)
                    continue
                err = self._remove(u, now, limits)
                if err:
                    errors.append(f"{u.kind} {u.id}: {err}")
                    continue
                gone.add((u.kind, u.id))
                freed += frees
                removed.append(entry)
                log.info("cache: removed %s %s (%s, %s, last used %s): %.0f MB", u.kind, u.id, u.title or "-",
                         why, entry["last_used"], frees / 2**20)
            if not dry_run:
                keys = {u.id for u, _ in planned if u.kind == "source" and ("source", u.id) in gone}
                if keys and self.forget_sources is not None:
                    try:
                        self.forget_sources(keys)
                    except OSError as e:
                        errors.append(f"queries.json: {e}")
                self._forget_usage(gone)
                self._forget_missing(inv, now - limits.protect_hours * 3600)
            after = before - freed
            protected = sum(1 for u in inv.units if ((u.kind, u.id) not in gone)
                            and self._is_protected(u, now, limits, p))
            summary = {
                "at": _iso(now), "dry_run": dry_run, "limits": limits.public(),
                "before_bytes": before, "after_bytes": after, "freed_bytes": freed,
                "removed_songs": sum(1 for r in removed if r["kind"] == "song"),
                "removed_sources": sum(1 for r in removed if r["kind"] == "source"),
                "removed": removed, "errors": errors, "protected": protected,
                "over_cap": limits.max_bytes > 0 and after > limits.max_bytes,
                "seconds": round(time.perf_counter() - t0, 2),
            }
            if not dry_run:
                self.last = summary
            if removed or errors:
                log.info("cache%s: %d songs and %d downloads, %.2f GB freed, %.2f GB left%s%s",
                         " (dry run)" if dry_run else "", summary["removed_songs"], summary["removed_sources"],
                         freed / GB, after / GB, "; still over the cap" if summary["over_cap"] else "",
                         f"; {len(errors)} could not go" if errors else "")
            return summary

    def _remove(self, u: Unit, now: float, limits: CacheLimits) -> str | None:
        """Renames the dir out of the way and deletes it; ``None`` when it went. Checks again under
        the lock that nothing used it or asked for it meanwhile."""
        with self._lock:
            if self._is_protected(u, now, limits, self.protected()):
                return "used meanwhile"
            trash = self.root / f"{TRASH_PREFIX}{u.kind}-{u.id}-{secrets.token_hex(3)}"
            try:
                os.replace(u.path, trash)
            except FileNotFoundError:
                return None
            except OSError as e:
                return f"in use ({e.__class__.__name__})"
        shutil.rmtree(trash, ignore_errors=True)
        return None

    def _sweep_trash(self) -> None:
        for d in self.root.glob(f"{TRASH_PREFIX}*") if self.root.exists() else ():
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)

    def _forget_usage(self, gone: Iterable[tuple[str, str]]) -> None:
        with self._lock:
            changed = False
            for kind, key in gone:
                if self._usage["songs" if kind == "song" else "sources"].pop(key, None) is not None:
                    changed = True
            if changed:
                self._write_usage()

    def _forget_missing(self, inv: Inventory, before: float) -> None:
        """Uses recorded for songs that were never made (a request that failed) and downloads that
        are not there, once they are older than ``before``."""
        there = {(u.kind, u.id) for u in inv.units}
        with self._lock:
            stale = [(kind, key) for kind, table in (("song", self._usage["songs"]), ("source", self._usage["sources"]))
                     for key, t in table.items() if t < before and (kind, key) not in there]
        self._forget_usage(stale)


class Janitor:
    """Runs the cleanup on its own thread: at start, after every job and every hour."""

    def __init__(self, cache: Cache, every_s: float = 3600.0) -> None:
        self.cache = cache
        self.every_s = every_s
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="sing-cache", daemon=True)

    def start(self) -> "Janitor":
        self._thread.start()
        return self

    def poke(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.cache.prune()
            except Exception:  # noqa: BLE001 - the next run tries again
                log.exception("cache cleanup failed")
            self._wake.wait(self.every_s)
            self._wake.clear()
