"""The live voice of a karaoke room's singers (``POST /karaoke/stream``, docs/design/karaoke.md
「做了什麼第四步」, packages/contracts karaoke.ts ``WorkersKaraokeStream*``). Pure numpy, no web
framework: server.py places the pitch tracker and wires the endpoint; everything else is here.

Core sends, about every half second, the new audio of each singer of a room (G.711 µ-law, 16 kHz
mono, base64; ``at`` = the stream's sample its first sample is). Per stream (room + stream id) the
worker keeps, in memory only, the samples (int16), RMVPE's raw F0 and the RMS per 10 ms frame:

    append    a gap past the end is silence; samples already there are not read again
    window    [first frame not committed - CONTEXT_S, end]: the pitch tracker reads only this
    commit    the 10 ms frames up to end - LOOKAHEAD_S (the tail is read again next time)
    answer    50 Hz MIDI frames from ``from`` (REVISE_S before what is new: the cleaning's
              look-around may change them) to the committed end, made as melody.curve makes the
              reference (loudness gate on the median of the voiced frames so far, pitch.clean_f0,
              50 Hz, MIDI) over the last TAIL_S or so: provisional
    end       everything committed (no lookahead), then the whole curve at once with
              karaoke.voice_pitch, exactly as ``POST /karaoke/voice`` treats a recording, and the
              stream is forgotten

Nothing is written to disk and nothing of the audio is logged (counts and lengths only).
"""

from __future__ import annotations

import base64
import binascii
import logging
import math
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Sequence

import numpy as np

import melody
from pitch import FRAME_MS, clean_f0

log = logging.getLogger("miyoria.sing")

# karaoke.ts KARAOKE_STREAM_RATE, KARAOKE_STREAM_MAX_STREAMS, KARAOKE_STREAM_MAX_CHUNK.
RATE = 16_000
MAX_STREAMS_PER_REQUEST = 8
MAX_CHUNK = 4 * RATE
# Largest request body (8 chunks of 4 s of µ-law are 683 KB in base64).
MAX_BODY = 1024 * 1024
# Samples per 10 ms frame (RMVPE's hop at 16 kHz).
HOP = int(round(RATE * FRAME_MS / 1000))
STEP = melody.CURVE_STEP  # 10 ms frames per 50 Hz frame
# Audio before the first frame not committed that the tracker reads again (its own look-back).
CONTEXT_S = 1.0
# Frames this close to the end are not committed until more audio comes (the tracker's look-ahead).
LOOKAHEAD_S = 0.15
# An answer starts this far before the first new frame: the cleaning looks around (octave fold
# over 0.5 s, spike filter, gap bridging) and may change frames already answered.
REVISE_S = 1.0
# The provisional curve is made from at most this much of the stream's end (plus what is new).
TAIL_S = 10.0
# The most a single window commits; a longer backlog (a stream that fell behind) takes several.
WINDOW_MAX_S = 10.0
# A stream may not have received more audio than the time since it opened plus this.
AHEAD_S = 5.0

CONTEXT = int(round(CONTEXT_S * RATE)) // HOP * HOP  # a whole number of hops: frames line up
LOOKAHEAD = int(round(LOOKAHEAD_S * RATE))
REVISE = int(round(REVISE_S * melody.CURVE_HZ))  # 50 Hz frames
TAIL = int(round(TAIL_S * 1000 / FRAME_MS))  # 10 ms frames
TAIL_MARGIN = int(round(2.0 * 1000 / FRAME_MS))  # 10 ms frames before ``from`` the tail keeps
WINDOW_MAX = int(round(WINDOW_MAX_S * 1000 / FRAME_MS))  # 10 ms frames


# ── G.711 µ-law ──────────────────────────────────────────────────────────────


def _mulaw_table() -> np.ndarray:
    """The 256 16-bit values of G.711 µ-law (as ``audioop.ulaw2lin(…, 2)``: ±32124 at most)."""
    u = ~np.arange(256, dtype=np.int32) & 0xFF
    t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4)
    return np.where(u & 0x80, 0x84 - t, t - 0x84).astype(np.int16)


MULAW = _mulaw_table()


def mulaw_decode(data: bytes) -> np.ndarray:
    """µ-law bytes to int16 samples."""
    return MULAW[np.frombuffer(data, dtype=np.uint8)]


class ChunkError(ValueError):
    """A chunk the request cannot be answered with: ``status`` 400 (not base64) or 413 (too long)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def decode_chunk(audio: str, max_samples: int = MAX_CHUNK) -> np.ndarray:
    """A chunk's ``audio`` (base64 µ-law) as int16 samples."""
    if len(audio) > 4 * math.ceil(max_samples / 3) + 4:
        raise ChunkError(413, f"a chunk is longer than {max_samples} samples")
    try:
        raw = base64.b64decode(audio, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ChunkError(400, "a chunk's audio is not valid base64") from e
    if len(raw) > max_samples:
        raise ChunkError(413, f"a chunk is longer than {max_samples} samples")
    return mulaw_decode(raw)


# ── one stream ───────────────────────────────────────────────────────────────


class _Grow:
    """A numpy array that grows at its end (doubling), for samples and frames."""

    def __init__(self, dtype: Any, cap: int) -> None:
        self.a = np.zeros(max(1, cap), dtype=dtype)
        self.n = 0

    def _room(self, more: int) -> None:
        need = self.n + more
        if need > self.a.size:
            b = np.zeros(max(need, 2 * self.a.size), dtype=self.a.dtype)
            b[: self.n] = self.a[: self.n]
            self.a = b

    def extend(self, v: np.ndarray) -> None:
        self._room(v.size)
        self.a[self.n: self.n + v.size] = v
        self.n += v.size

    def pad(self, k: int) -> None:
        self._room(k)
        self.a[self.n: self.n + k] = 0
        self.n += k

    def view(self, a: int = 0, b: int | None = None) -> np.ndarray:
        return self.a[a: self.n if b is None else min(b, self.n)]


@dataclass
class Limits:
    """The caps of the worker (server.py reads them from the environment for every request)."""

    max_streams: int = 16  # open streams of the worker
    max_seconds: float = 510.0  # of one stream (SING_MAX_SECONDS + 30)
    idle_s: float = 30.0  # no chunk for this long: forgotten
    ahead_s: float = AHEAD_S


@dataclass
class Stream:
    room: str
    id: str
    opened: float
    touched: float
    audio: _Grow = field(default_factory=lambda: _Grow(np.int16, 30 * RATE))
    f0: _Grow = field(default_factory=lambda: _Grow(np.float64, 3000))
    rms: _Grow = field(default_factory=lambda: _Grow(np.float64, 3000))
    ending: bool = False  # a chunk with ``end`` came: the next answer is the final one

    @property
    def n(self) -> int:
        return self.audio.n

    @property
    def nf(self) -> int:
        """Committed 10 ms frames."""
        return self.f0.n

    @property
    def total_frames(self) -> int:
        """The frames of the whole stream as the tracker counts them (one every hop from sample 0)."""
        return self.n // HOP + 1

    def take(self, at: int, samples: np.ndarray, now: float, limits: Limits) -> str | None:
        """Appends a chunk; why the stream is lost when it cannot be (``None``: fine)."""
        end = at + samples.size
        if end <= self.n:
            return None  # all of it is here already (a retry, or an old chunk late)
        if end > limits.max_seconds * RATE:
            return "longer than the longest song"
        if end > (now - self.opened + limits.ahead_s) * RATE:
            return "ahead of the clock"
        if at > self.n:
            self.audio.pad(at - self.n)  # what never came is silence
        self.audio.extend(samples[self.n - at:])
        return None

    def window(self, nf: int, final: bool) -> tuple[int, int, int, int] | None:
        """(first sample, end sample, first frame, end frame) of the next window from committed
        frame ``nf``; ``None`` when nothing can be committed yet."""
        total = self.total_frames
        if self.n == 0:
            return None  # nothing to read (a stream closed before it said anything)
        if final:
            want = total
        else:
            want = min(total, (self.n - LOOKAHEAD) // HOP + 1) if self.n >= LOOKAHEAD else 0
        c_to = min(want, nf + WINDOW_MAX)
        if c_to <= nf:
            return None
        w0 = max(0, nf * HOP - CONTEXT)
        w1 = self.n if c_to == total else min(self.n, (c_to - 1) * HOP + LOOKAHEAD)
        return w0, w1, nf, c_to

    def samples(self, a: int, b: int) -> np.ndarray:
        """float32 in [-1, 1) (int16 / 32768: exact)."""
        return self.audio.view(a, b).astype(np.float32) / np.float32(32768.0)


@dataclass
class Chunk:
    stream: str
    at: int
    samples: np.ndarray  # int16
    end: bool = False


@dataclass
class Window:
    """Audio for the pitch tracker: ``x`` is samples [w0, w0 + len); frames [c_from, c_to) of the
    stream are committed from its answer (frame ``i`` of the answer is frame ``w0 / HOP + i``)."""

    stream: Stream
    w0: int
    c_from: int
    c_to: int
    x: np.ndarray


@dataclass
class Plan:
    room: str
    touched: list[Stream]
    before: dict[str, int]  # committed frames of each touched stream before this request
    windows: list[Window]
    lost: list[str]

    @property
    def seconds(self) -> float:
        """Audio the tracker reads for this request."""
        return sum(w.x.size for w in self.windows) / RATE


# ── the curve ────────────────────────────────────────────────────────────────


def _db(rms: np.ndarray) -> np.ndarray:
    return 20.0 * np.log10(np.maximum(np.asarray(rms, dtype=np.float64), 1e-9))


def provisional(s: Stream, before: int, clean: bool = True) -> tuple[int, list[float | None]]:
    """(``from``, ``midi``): the 50 Hz frames from REVISE_S before the first frame committed in this
    request (``before``) to the committed end, made as melody.curve makes the reference from the
    last TAIL_S or so of the stream, gated by the median loudness of all its voiced frames so far."""
    nf = s.nf
    end50 = nf // STEP
    if nf <= before:
        return end50, []
    start50 = max(0, before // STEP - REVISE)
    tail0 = max(0, min(nf - TAIL, start50 * STEP - TAIL_MARGIN)) // STEP * STEP
    f0_all, rms_all = s.f0.view(), s.rms.view()
    db_all = _db(rms_all)
    voiced = f0_all > 1.0
    f = f0_all[tail0:nf].copy()
    if voiced.any():
        typical = float(np.median(db_all[voiced]))
        f[db_all[tail0:nf] < typical - melody.RMS_GATE_DB] = 0.0
    if clean:
        f = np.asarray(clean_f0(f), dtype=np.float64)
    midi = melody.downsample(melody.to_midi(f))
    k0 = tail0 // STEP
    return start50, melody.curve_json(midi[start50 - k0: end50 - k0])


def final(s: Stream, clean: bool = True) -> dict[str, Any]:
    """The whole curve at once, as ``POST /karaoke/voice`` makes it from a recording."""
    import karaoke

    seconds = s.n / RATE
    if s.n == 0:
        return {"midi": [], "level_db": None, "floor_db": None, "seconds": 0.0}
    got = karaoke.voice_pitch(s.f0.view(), s.samples(0, s.n), RATE, seconds, clean=clean)
    return {**got, "seconds": seconds}


# ── all streams of the worker ────────────────────────────────────────────────


class Streams:
    """Every open stream of the worker, by (room, stream). ``room(...)`` serialises the requests of a
    room (a stream is only ever changed under its room's lock); the book itself has its own lock.
    ``on_empty``: called (outside the locks) when the last stream is forgotten, to let the pitch
    tracker go."""

    def __init__(self, on_empty: Callable[[], None] | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.on_empty = on_empty
        self.clock = clock
        self._lock = threading.Lock()
        self._streams: dict[tuple[str, str], Stream] = {}
        self._rooms: dict[str, list[Any]] = {}  # room -> [lock, requests using it]

    def __len__(self) -> int:
        with self._lock:
            return len(self._streams)

    def get(self, room: str, stream: str) -> Stream | None:
        with self._lock:
            return self._streams.get((room, stream))

    def _emptied(self, was: int) -> None:
        if was and not self._streams and self.on_empty is not None:
            try:
                self.on_empty()
            except Exception:  # noqa: BLE001
                log.exception("karaoke stream: letting the pitch tracker go failed")

    @contextmanager
    def room(self, room: str) -> Iterator[None]:
        with self._lock:
            entry = self._rooms.setdefault(room, [threading.Lock(), 0])
            entry[1] += 1
        entry[0].acquire()
        try:
            yield
        finally:
            entry[0].release()
            with self._lock:
                entry[1] -= 1
                if entry[1] == 0 and self._rooms.get(room) is entry:
                    del self._rooms[room]

    def forget(self, room: str, streams: Sequence[str]) -> int:
        with self._lock:
            was = len(self._streams)
            gone = sum(self._streams.pop((room, sid), None) is not None for sid in streams)
        self._emptied(was)
        return gone

    def sweep(self, idle_s: float) -> int:
        """Forgets the streams nobody sent to for ``idle_s``; how many."""
        now = self.clock()
        with self._lock:
            was = len(self._streams)
            old = [k for k, s in self._streams.items() if now - s.touched > idle_s]
            for k in old:
                del self._streams[k]
        if old:
            log.info("karaoke stream: forgot %d idle stream(s)", len(old))
        self._emptied(was)
        return len(old)

    def plan(self, room: str, chunks: Sequence[Chunk], drop: Sequence[str], limits: Limits) -> Plan:
        """Drops, appends every chunk and plans the windows the tracker reads. Called under
        ``room(room)``."""
        now = self.clock()
        lost: list[str] = []
        touched: dict[str, Stream] = {}
        with self._lock:
            was = len(self._streams)
            for sid in drop:
                self._streams.pop((room, sid), None)
            for c in chunks:
                key = (room, c.stream)
                s = self._streams.get(key)
                if s is None:
                    if c.at > 0 or len(self._streams) >= limits.max_streams:
                        why = "unknown" if c.at > 0 else "too many streams"
                        log.info("karaoke stream: a stream is lost (%s)", why)
                        if c.stream not in lost:
                            lost.append(c.stream)
                        touched.pop(c.stream, None)
                        continue
                    s = Stream(room=room, id=c.stream, opened=now, touched=now)
                    self._streams[key] = s
                s.touched = now
                why = s.take(c.at, c.samples, now, limits)
                if why is not None:
                    log.info("karaoke stream: a stream is lost (%s, %.1f s read)", why, s.n / RATE)
                    del self._streams[key]
                    touched.pop(c.stream, None)
                    if c.stream not in lost:
                        lost.append(c.stream)
                    continue
                s.ending = s.ending or c.end
                touched[c.stream] = s
        self._emptied(was)
        windows: list[Window] = []
        for s in touched.values():
            nf = s.nf
            while True:
                w = s.window(nf, s.ending)
                if w is None:
                    break
                w0, w1, c_from, c_to = w
                windows.append(Window(s, w0, c_from, c_to, s.samples(w0, w1)))
                nf = c_to
                if not s.ending:
                    break  # one window a request; a backlog is read over the next ones
        return Plan(room, list(touched.values()), {s.id: s.nf for s in touched.values()}, windows, lost)

    def commit(self, plan: Plan, f0s: Sequence[np.ndarray], clean: bool = True) -> list[dict[str, Any]]:
        """Commits the tracker's answers (one per window, in order) and answers every touched stream
        (``WorkersKaraokeStreamFrames`` as a dict with ``from``); a final one forgets its stream."""
        for w, f0 in zip(plan.windows, f0s):
            s = w.stream
            if s.nf != w.c_from:
                continue  # (cannot happen under the room's lock)
            j0, j1 = w.c_from - w.w0 // HOP, w.c_to - w.w0 // HOP
            got = np.asarray(f0, dtype=np.float64).reshape(-1)[j0:j1]
            vals = np.zeros(j1 - j0)
            vals[: got.size] = got  # a tracker answering fewer frames: unvoiced
            rms = melody.frame_rms(w.x, RATE)[j0:j1]
            r = np.zeros(j1 - j0)
            r[: rms.size] = rms
            s.f0.extend(vals)
            s.rms.extend(r)
        out: list[dict[str, Any]] = []
        finished: list[str] = []
        for s in plan.touched:
            seconds = round(s.n / RATE, 3)
            if s.ending and (s.n == 0 or s.nf == s.total_frames):
                got = final(s, clean)
                out.append({"stream": s.id, "from": 0, "midi": got["midi"], "final": True, "seconds": seconds,
                            "level_db": got["level_db"], "floor_db": got["floor_db"]})
                finished.append(s.id)
                log.info("karaoke stream: closed after %.1f s", s.n / RATE)
                continue
            start, midi = provisional(s, plan.before.get(s.id, 0), clean)
            out.append({"stream": s.id, "from": start, "midi": midi, "final": False, "seconds": seconds,
                        "level_db": None, "floor_db": None})
        if finished:
            self.forget(plan.room, finished)
        return out
