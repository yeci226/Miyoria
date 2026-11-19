"""Karaoke songs of the song worker: what ``POST /jobs`` with ``purpose: "karaoke"`` makes
(docs/design/karaoke.md §3; the format is packages/contracts/workers/src/karaoke.ts).

    <root>/_karaoke/<karaoke id>/       one karaoke song, apart from her covers: ``GET /songs``
        karaoke.m4a                     never lists it (songs.Store skips ``_`` dirs)
        karaoke.k+3.m4a                 the backing in another key, made when a singer asks (``keys``)
        play_karaoke.pcm                the backing as s16le mono 48 kHz for her voice channel, decoded
        play_karaoke.k+3.pcm            from the matching m4a when Core first asks (``decode_play``)
        video.mp4                       the source's picture on the backing's timeline, no sound
                                        (``make_video``); only when the source has one
        reference.json                  WorkersKaraokeReference (version 2: WorkersKaraokeReferenceV2)
        meta.json                       what made it (source, lead split, lyrics, timings); written
                                        last, so a folder without it is a job that did not finish

The id is ``k-<source key>``: the same song (link, search, library file) is the same karaoke song,
whatever pitch / key / backing the request carried (karaoke reads none of them).
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from songs import safe_id

log = logging.getLogger("miyoria.sing.karaoke")

KARAOKE_DIR = "_karaoke"
REFERENCE_FORMAT = "miyoria.karaoke.reference"
REFERENCE_VERSION = 2
BACKING_FILE = "karaoke.m4a"
REFERENCE_FILE = "reference.json"
META_FILE = "meta.json"
# Files every finished karaoke song has, which a client may fetch (karaoke.ts KARAOKE_FILES).
KARAOKE_FILES = {
    BACKING_FILE: "audio/mp4",
    REFERENCE_FILE: "application/json",
}
# The background video (karaoke.ts KARAOKE_VIDEO_FILE): fetched like them, but a song may have none.
VIDEO_FILE = "video.mp4"
SERVED_FILES = {**KARAOKE_FILES, VIDEO_FILE: "video/mp4"}
# The backing track: AAC in MP4, stereo, 48 kHz (what the browser's AudioContext runs at).
BACKING_RATE = 48_000
BACKING_CHANNELS = 2
BACKING_BITRATE = "128k"
PEAK = 0.89  # -1 dBFS, as the cover mix
PITCH_METHOD = "rmvpe"


def karaoke_id(source_key: str) -> str:
    return safe_id(f"k-{source_key}", 96)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class KaraokeStore:
    """The karaoke songs under ``<root>/_karaoke``."""

    def __init__(self, root: Path) -> None:
        self.root = root / KARAOKE_DIR

    def dir(self, kid: str) -> Path:
        return self.root / safe_id(kid, 96)

    def meta(self, kid: str) -> dict[str, Any] | None:
        """The song's meta.json when it is complete (both files there), else ``None``."""
        d = self.dir(kid)
        try:
            meta = json.loads((d / META_FILE).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict) or not all((d / f).is_file() for f in KARAOKE_FILES):
            return None
        return meta

    def write_json(self, kid: str, name: str, value: dict[str, Any]) -> None:
        """``name`` in the song's folder, whole or not at all. reference.json is compact (a 4-minute
        song's curve is 12,000 values), meta.json is for people to read."""
        d = self.dir(kid)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"{name}.tmp"
        if name == REFERENCE_FILE:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        else:
            text = json.dumps(value, ensure_ascii=False, indent=2)
        tmp.write_text(text, "utf-8")
        os.replace(tmp, d / name)

    def songs(self) -> list[dict[str, Any]]:
        """``job.karaoke`` of every complete karaoke song, with ``created_at``, newest first."""
        out = []
        for d in sorted(self.root.iterdir()) if self.root.is_dir() else []:
            meta = self.meta(d.name) if d.is_dir() else None
            if meta is not None:
                out.append({**summary(meta, d), "created_at": meta.get("created_at")})
        out.sort(key=lambda m: m.get("created_at") or "", reverse=True)
        return out


def summary(meta: dict[str, Any], folder: Path | None = None) -> dict[str, Any]:
    """``job.karaoke`` (WorkersKaraokeSong) from a karaoke song's meta.json; ``video`` only when its
    ``folder`` has the file."""
    return {"id": meta["id"], "title": meta.get("title") or "", "artist": meta.get("artist"),
            "duration_s": meta.get("duration_s"), "quality": meta.get("quality"),
            "video": folder is not None and (folder / VIDEO_FILE).is_file()}


# ── lyrics ───────────────────────────────────────────────────────────────────


def lyric_lines(lines: Sequence[dict[str, Any]], voiced: Sequence[bool], hz: float) -> list[dict[str, Any]]:
    """The looked-up lines (start, end, text; lyricstage.py checks them) from the song's synced lines (``{"t", "text"}``, already moved by the
    lookup's overall offset). Empty lines are breaks: they end the line before them and are not
    lines themselves. A line ends where the next one (or break) starts; the last one where the lead
    last sings after it starts (``voiced``: the reference curve's voiced flags), or ``None``."""
    ordered = sorted(lines, key=lambda x: float(x["t"]))
    out = []
    for i, line in enumerate(ordered):
        text = str(line.get("text") or "").strip()
        if not text:
            continue
        start = float(line["t"])
        end = next((float(x["t"]) for x in ordered[i + 1:] if float(x["t"]) > start), None)
        if end is None:
            first = int(math.ceil(start * hz))
            last = next((j for j in range(len(voiced) - 1, first - 1, -1) if voiced[j]), None)
            end = (last + 1) / hz if last is not None else None
        out.append({"start": round(start, 3), "end": None if end is None else round(end, 3), "text": text})
    return out


def found_lines(lyrics_meta: dict[str, Any] | None, voiced: Sequence[bool], hz: float) -> list[dict[str, Any]]:
    """The looked-up lines of the lookup's result (server._lyrics_meta); none when they are not
    synced (plain lyrics have no times to show them by)."""
    if not lyrics_meta or not lyrics_meta.get("synced"):
        return []
    return lyric_lines(lyrics_meta.get("lines") or [], voiced, hz)


# ── the backing track ────────────────────────────────────────────────────────


def read_wav(p: Path):
    """(frames, channels) float32 and the rate: soundfile when it is there, else the 16-bit WAV
    reader of the standard library (what the mock writes)."""
    import numpy as np

    try:
        import soundfile as sf
    except ImportError:
        sf = None
    if sf is not None:
        x, sr = sf.read(str(p), dtype="float32", always_2d=True)
        return x, int(sr)
    with wave.open(str(p), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{p.name}: only 16-bit WAV can be read without soundfile")
        ch, sr = w.getnchannels(), w.getframerate()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return (raw.reshape(-1, ch).astype(np.float32) / 32768.0), sr


def mono_of(p: Path):
    x, sr = read_wav(p)
    return x.mean(axis=1), sr


def wav_seconds(p: Path) -> float | None:
    try:
        with wave.open(str(p), "rb") as w:
            return w.getnframes() / w.getframerate()
    except (OSError, EOFError, wave.Error):
        return None


def mix_parts(parts: Sequence[Path]):
    """The parts summed, stereo, cut to the shortest; (frames, 2) float32 and the rate."""
    import numpy as np

    mixed, rate = None, None
    for p in parts:
        x, sr = read_wav(p)
        if x.shape[1] == 1:
            x = np.repeat(x, 2, axis=1)
        x = x[:, :2]
        if rate is None:
            mixed, rate = x.copy(), sr
        else:
            if sr != rate:
                raise ValueError(f"{p.name} is at {sr} Hz, the backing at {rate}")
            n = min(len(mixed), len(x))
            mixed = mixed[:n] + x[:n]
    if mixed is None or rate is None:
        raise ValueError("no backing parts")
    return mixed, rate


def encode_backing(parts: Sequence[Path], out: Path, target_lufs: float = -16.0) -> dict[str, Any]:
    """The backing track into ``out`` (AAC in MP4, BACKING_BITRATE, BACKING_RATE, stereo) from its
    parts (the rest of the song after the lead; or the instrumental and the backing voices; or the
    instrumental alone), loudness-normalised to ``target_lufs`` with the peak at -1 dBFS at most, as
    the cover mix. Returns what was done."""
    import numpy as np

    from engine import JobError, loudness

    if shutil.which("ffmpeg") is None:
        raise JobError("ffmpeg is not installed: the karaoke backing cannot be encoded")
    x, sr = mix_parts(parts)
    lufs = loudness(x, sr)
    gain = 10 ** ((target_lufs - lufs) / 20) if lufs is not None else \
        0.25 / max(float(np.sqrt((x ** 2).mean())) if x.size else 0.0, 1e-6)
    peak = float(np.abs(x).max()) * gain if x.size else 0.0
    if peak > PEAK:
        gain *= PEAK / peak
    x = (x * gain).astype("<f4")
    part = out.with_name(out.stem + ".part" + out.suffix)
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "pipe:0",
           "-c:a", "aac", "-b:a", BACKING_BITRATE, "-ar", str(BACKING_RATE), "-ac", str(BACKING_CHANNELS),
           "-movflags", "+faststart", "-f", "mp4", str(part)]
    try:
        r = subprocess.run(cmd, input=np.ascontiguousarray(x).tobytes(), capture_output=True)
        if r.returncode != 0:
            raise JobError(f"ffmpeg could not encode the karaoke backing: "
                           f"{r.stderr.decode('utf-8', 'replace').strip()[:300]}")
        os.replace(part, out)
    finally:
        part.unlink(missing_ok=True)
    return {"duration_s": round(len(x) / sr, 2), "gain_db": round(20 * math.log10(max(gain, 1e-9)), 1),
            "lufs_before": None if lufs is None else round(lufs, 1), "bytes": out.stat().st_size,
            "rate": BACKING_RATE, "channels": BACKING_CHANNELS, "bitrate": BACKING_BITRATE}


# ── another key (docs/design/karaoke.md 「做了什麼第二步」) ─────────────────────────

# Semitones a singer may move the key by, either way (karaoke.ts KARAOKE_MAX_SHIFT).
KEY_MAX = 6
KEY_FILE = re.compile(r"^karaoke\.k([+-])([1-9]|1[0-2])\.m4a$")


def key_file(semitones: int) -> str:
    """The backing's file name in a key ``semitones`` away (karaoke.ts karaokeBackingName)."""
    if semitones == 0:
        return BACKING_FILE
    return f"karaoke.k{'+' if semitones > 0 else '-'}{abs(semitones)}.m4a"


def is_key_file(name: str) -> bool:
    m = KEY_FILE.match(name)
    return m is not None and int(m.group(2)) <= KEY_MAX


# The backing as raw PCM for her voice channel (karaoke.ts karaokePlayName): s16le mono 48 kHz, made
# from the matching m4a when Core first asks and kept next to it.
PLAY_RATE = 48_000
PLAY_FILE = re.compile(r"^play_karaoke(?:\.k([+-])([1-9]|1[0-2]))?\.pcm$")


def play_source(name: str) -> str | None:
    """The m4a a ``play_karaoke*.pcm`` name is made from, or ``None`` when ``name`` is not one of
    them (or its key is beyond KEY_MAX)."""
    m = PLAY_FILE.match(name)
    if m is None:
        return None
    if m.group(1) is None:
        return BACKING_FILE
    if int(m.group(2)) > KEY_MAX:
        return None
    return f"karaoke.k{m.group(1)}{m.group(2)}.m4a"


def decode_play(src: Path, out: Path) -> None:
    """``src`` (an m4a) decoded to s16le mono 48 kHz in ``out``: written beside it and renamed, so a
    request never sees half a file."""
    from engine import JobError

    if shutil.which("ffmpeg") is None:
        raise JobError("ffmpeg is not installed: the backing cannot be decoded")
    part = out.with_name(out.name + ".part")
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-vn", "-ac", "1", "-ar", str(PLAY_RATE), "-f", "s16le", str(part)]
    try:
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            raise JobError(f"ffmpeg could not decode the karaoke backing: "
                           f"{r.stderr.decode('utf-8', 'replace').strip()[:300]}")
        os.replace(part, out)
    finally:
        part.unlink(missing_ok=True)


def shift_backing(src: Path, out: Path, semitones: int) -> str:
    """The backing track ``src`` moved by ``semitones`` into ``out`` (the same AAC settings), the
    length kept so the reference still lines up. Rubber Band (ffmpeg's ``rubberband`` filter, as a
    cover's key change); ffmpeg without it: resampling and time-stretching back (``asetrate``,
    cruder: the timbre moves with the pitch). Returns the method."""
    from engine import JobError, ffmpeg_has_filter

    if shutil.which("ffmpeg") is None:
        raise JobError("ffmpeg is not installed: the backing cannot be moved to another key")
    ratio = 2 ** (semitones / 12)
    if ffmpeg_has_filter("rubberband"):
        method, af = "rubberband", f"rubberband=pitch={ratio:.8f}:pitchq=quality:channels=together"
    else:
        method = "asetrate"
        af = f"asetrate={BACKING_RATE * ratio:.3f},aresample={BACKING_RATE},atempo={1 / ratio:.8f}"
    part = out.with_name(out.stem + ".part" + out.suffix)
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-af", af,
           "-c:a", "aac", "-b:a", BACKING_BITRATE, "-ar", str(BACKING_RATE), "-ac", str(BACKING_CHANNELS),
           "-movflags", "+faststart", "-f", "mp4", str(part)]
    try:
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            raise JobError(f"ffmpeg could not move the backing's key: "
                           f"{r.stderr.decode('utf-8', 'replace').strip()[:300]}")
        os.replace(part, out)
    finally:
        part.unlink(missing_ok=True)
    return method


# ── the background video (docs/design/karaoke.md 「做了什麼第三步」) ─────────────────

# The tallest and the most kbps a karaoke song's video gets (SING_KARAOKE_VIDEO_HEIGHT / _KBPS):
# a singer's browser streams it next to the backing, often over a home connection.
VIDEO_MAX_HEIGHT = 720
VIDEO_MAX_KBPS = 1500
VIDEO_CRF = 23
VIDEO_GOP = 60  # a key frame every 2 s at 30 fps: a seek in the browser lands close
# A first frame this close to the file's zero is the encoder's delay (B-frames), not a picture that
# starts late: the video is simply started at zero.
VIDEO_START_TOLERANCE_S = 0.1
VIDEO_TIMEOUT_S = 900.0


def _number(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def probe_video(p: Path) -> dict[str, Any]:
    """ffprobe's view of ``p``'s first video stream: ``codec``, ``pix_fmt``, ``width``, ``height``,
    ``start_s`` (where its first frame is on the file's timeline), ``duration_s``, ``kbps`` (the
    stream's bit rate, else the file's size over its length), ``audio`` (whether it has sound)."""
    from engine import JobError

    cmd = ["ffprobe", "-v", "error", "-show_entries",
           "stream=codec_type,codec_name,pix_fmt,width,height,start_time,duration,bit_rate"
           ":format=start_time,duration,size", "-of", "json", str(p)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as e:
        raise JobError("ffprobe took too long to read the video") from e
    if r.returncode != 0:
        raise JobError(f"ffprobe cannot read the video: {r.stderr.strip()[:300]}")
    try:
        data = json.loads(r.stdout or "{}")
    except ValueError as e:
        raise JobError("ffprobe's answer about the video is not JSON") from e
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise JobError("the file has no video stream")
    fmt = data.get("format") or {}
    duration = _number(video.get("duration")) or _number(fmt.get("duration"))
    kbps = _number(video.get("bit_rate"))
    kbps = kbps / 1000 if kbps else None
    size = _number(fmt.get("size"))
    if kbps is None and size and duration:
        kbps = size * 8 / duration / 1000
    start = _number(video.get("start_time"))
    if start is None:
        start = _number(fmt.get("start_time")) or 0.0
    return {"codec": video.get("codec_name"), "pix_fmt": video.get("pix_fmt"),
            "width": int(video.get("width") or 0), "height": int(video.get("height") or 0),
            "start_s": start, "duration_s": duration, "kbps": None if kbps is None else round(kbps),
            "audio": any(s.get("codec_type") == "audio" for s in streams)}


def _run_ffmpeg(cmd: list[str], cancelled: Callable[[], bool] | None, timeout_s: float) -> None:
    """``cmd`` to its end; stopped when ``cancelled`` (raises ``Cancelled``) or after ``timeout_s``."""
    import time

    from engine import Cancelled, JobError

    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            try:
                _, err = proc.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                if cancelled is not None and cancelled():
                    raise Cancelled() from None
                if time.monotonic() >= deadline:
                    raise JobError(f"ffmpeg took longer than {timeout_s:.0f} s on the video") from None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
    if proc.returncode != 0:
        raise JobError(f"ffmpeg could not make the karaoke video: "
                       f"{(err or b'').decode('utf-8', 'replace').strip()[:300]}")


def make_video(src: Path, out: Path, duration_s: float, max_height: int = VIDEO_MAX_HEIGHT,
               max_kbps: int = VIDEO_MAX_KBPS, cancelled: Callable[[], bool] | None = None) -> dict[str, Any]:
    """The karaoke song's background video ``out`` from the source's video ``src`` (the source dir's
    shared video.mp4 a cover uses too, or a library entry's): no sound, H.264 yuv420p, at most
    ``max_height`` tall and ``max_kbps``, ``+faststart`` (the browser streams it with range
    requests), cut to the backing's ``duration_s``. Copied as it is when it already fits, else
    re-encoded with libx264.

    The timeline: the backing and the reference start at the downloaded audio's first sample
    (engine.ffmpeg_to_wav drops the audio stream's own start time; nothing after it trims the head),
    and the shared video starts at its first frame the same way (engine.normalize_video). What is
    left is the video file's own start: ffmpeg moves the first frame to zero, so a first frame later
    than the file's zero by more than VIDEO_START_TOLERANCE_S gets that long of its first picture
    in front of it (``tpad``), one before zero has that much cut (``trim``): frame time t of the
    source file is backing time t. Returns what was done (meta.json ``video``)."""
    from engine import JobError

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise JobError("ffmpeg is not installed: the karaoke video cannot be made")
    if not duration_s or duration_s <= 0:
        raise JobError("the backing has no length to cut the video to")
    info = probe_video(src)
    start = float(info["start_s"] or 0.0)
    offset = start if abs(start) > VIDEO_START_TOLERANCE_S else 0.0
    fits = (info["codec"] == "h264" and info["pix_fmt"] == "yuv420p" and 0 < info["height"] <= max_height
            and info["kbps"] is not None and info["kbps"] <= max_kbps and offset == 0.0)
    part = out.with_name(out.stem + ".part" + out.suffix)
    head = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-map", "0:v:0", "-an", "-sn", "-dn"]
    # (No ``-avoid_negative_ts make_zero``: with B-frames it starts the picture a frame or two late,
    # where the mp4 muxer's own edit list keeps the first frame at zero.)
    tail = ["-t", f"{duration_s:.3f}", "-movflags", "+faststart", "-f", "mp4", str(part)]
    if fits:
        method, enc = "copy", ["-c:v", "copy"]
    else:
        method = "x264"
        vf = []
        if offset > 0:
            vf.append(f"tpad=start_duration={offset:.3f}:start_mode=clone")
        elif offset < 0:
            vf.append(f"trim=start={-offset:.3f},setpts=PTS-STARTPTS")
        if info["height"] > max_height:
            vf.append(f"scale=-2:{int(max_height)}")
        vf.append("format=yuv420p")
        enc = ["-vf", ",".join(vf), "-c:v", "libx264", "-preset", "veryfast", "-crf", str(VIDEO_CRF),
               "-maxrate", f"{int(max_kbps)}k", "-bufsize", f"{int(max_kbps) * 2}k", "-g", str(VIDEO_GOP),
               "-threads", "4"]
    try:
        _run_ffmpeg(head + enc + tail, cancelled, VIDEO_TIMEOUT_S)
        made = probe_video(part)
        if made["audio"] or made["codec"] != "h264":
            raise JobError("the karaoke video did not come out as H.264 without sound")
        os.replace(part, out)
    finally:
        part.unlink(missing_ok=True)
    return {"file": VIDEO_FILE, "method": method, "width": made["width"], "height": made["height"],
            "kbps": made["kbps"], "duration_s": None if made["duration_s"] is None else round(made["duration_s"], 2),
            "offset_s": round(offset, 3), "start_s": round(start, 3), "bytes": out.stat().st_size,
            "source": {k: info[k] for k in ("codec", "width", "height", "kbps")}}


# ── a singer's recording (POST /karaoke/voice) ───────────────────────────────

VOICE_RATE = 16_000
# karaoke.ts KARAOKE_VOICE_MAX_BYTES.
VOICE_MAX_BYTES = 8 * 1024 * 1024
# What a singer's browser sends (MediaRecorder), and WAV for tests; the extension the file is kept under.
VOICE_TYPES = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/wav": ".wav",
               "audio/x-wav": ".wav", "audio/wave": ".wav"}
VOICE_DIR = "_voice"  # under the data dir: never a song, never counted by the cache (cache.py)
VOICE_KEEP_S = 600.0  # a recording left behind (a crash) is deleted after this long at most


def voice_type(content_type: str | None) -> str | None:
    """The file extension for a request's ``content-type`` (parameters such as ``codecs`` aside),
    ``None`` when it is not one the endpoint takes."""
    base = (content_type or "").split(";", 1)[0].strip().lower()
    return VOICE_TYPES.get(base)


def sweep_voice(folder: Path, older_than_s: float = VOICE_KEEP_S, now: float | None = None) -> int:
    """Deletes the recordings in ``folder`` older than ``older_than_s``; how many."""
    import time

    if not folder.is_dir():
        return 0
    now = time.time() if now is None else now
    gone = 0
    for p in folder.iterdir():
        try:
            if p.is_file() and now - p.stat().st_mtime > older_than_s:
                p.unlink()
                gone += 1
        except OSError:
            pass
    return gone


def decode_voice(src: Path, dst: Path, max_s: float) -> Path:
    """``src`` as 16 kHz mono 16-bit WAV in ``dst`` (at most ``max_s`` of it), the file to read.
    Without ffmpeg a WAV is read as it is; anything else cannot be."""
    from engine import JobError

    if shutil.which("ffmpeg") is None:
        if src.suffix == ".wav":
            return src
        raise JobError("ffmpeg is not installed: the recording cannot be decoded")
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-t", f"{max_s:.0f}", "-vn", "-ac", "1", "-ar", str(VOICE_RATE), "-c:a", "pcm_s16le",
           "-f", "wav", str(dst)]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as e:
        raise ValueError("decoding the recording took too long") from e
    if r.returncode != 0:
        raise ValueError("the recording cannot be decoded")
    return dst


def voice_pitch(f0, mono, sr: int, seconds: float, clean: bool = True) -> dict[str, Any]:
    """The answer's ``midi``, ``level_db`` and ``floor_db`` from RMVPE's F0 (10 ms, Hz) of the
    recording and its samples: the reference's own treatment (melody.curve: gated by the voice's
    loudness, cleaned, 50 Hz MIDI), ``seconds * 50`` frames from its first sample. ``level_db``: the
    median dBFS of the 10 ms frames under a voiced curve frame (``None`` when nothing was sung);
    ``floor_db``: the 10th percentile of all of them."""
    import numpy as np

    import melody

    rms = melody.frame_rms(mono, sr)
    frames = int(round(seconds * melody.CURVE_HZ))
    midi = melody.curve(f0, rms, frames=frames, clean=clean)
    db = 20.0 * np.log10(np.maximum(np.asarray(rms, dtype=np.float64), 1e-9))
    voiced_curve = ~np.isnan(midi)
    under = np.repeat(voiced_curve, melody.CURVE_STEP)[: db.size]
    voiced_db = db[: under.size][under]
    return {"midi": melody.curve_json(midi),
            "level_db": round(float(np.median(voiced_db)), 1) if voiced_db.size else None,
            "floor_db": round(float(np.percentile(db, 10)), 1) if db.size else None}


# ── reference.json ───────────────────────────────────────────────────────────


def song_artist(source_artist: str | None, lyrics_meta: dict[str, Any] | None,
                lyrics: dict[str, Any] | None) -> str | None:
    """The song's artist: the found lyrics' (lrclib's ``artistName``, in the lookup's meta) when those
    lyrics are the ones used, else what the source says (yt-dlp's ``artist`` / ``creator``, an artist
    split from the title, an artist's own channel: ``engine._source_of``), else ``None``."""
    if lyrics is not None and lyrics.get("source") == "found" and lyrics_meta is not None:
        found = str(lyrics_meta.get("artist") or "").strip()
        if found:
            return found[:200]
    return (source_artist.strip()[:200] or None) if source_artist else None


def reference(kid: str, title: str, artist: str | None, duration_s: float, midi: list[float | None], hz: int,
              notes: list[dict[str, Any]], lyrics: dict[str, Any] | None, quality: dict[str, Any],
              notes_method: str, made: dict[str, Any] | None = None) -> dict[str, Any]:
    """``WorkersKaraokeReferenceV2``. ``made``: the lyrics stage's (``lyrics``, ``asr``, ``aligner``)."""
    m = {"lyrics": "line" if lyrics else "none", "asr": None, "aligner": None, **(made or {})}
    return {
        "format": REFERENCE_FORMAT,
        "version": REFERENCE_VERSION,
        "id": kid,
        "title": title,
        "artist": artist,
        "duration_s": round(float(duration_s), 3),
        "backing": BACKING_FILE,
        "pitch": {"hz": int(hz), "start": 0, "midi": midi},
        "notes": notes,
        "lyrics": lyrics,
        "quality": quality,
        "made": {"pitch": PITCH_METHOD, "notes": notes_method, "lyrics": m["lyrics"], "asr": m["asr"],
                 "aligner": m["aligner"]},
    }
