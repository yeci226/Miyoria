"""The real song pipeline: yt-dlp / library → Demucs → lead / backing split → Seed-VC (singing, F0) → mix.

Everything heavy is imported lazily so the server (and its mock mode) starts without torch. Models
are loaded per stage and freed right after (``SING_KEEP_MODELS=1`` keeps them): the GPU is shared
with TTS / ASR / OBS, so the worker only holds VRAM while a job runs.
"""

from __future__ import annotations

import copy
import gc
import logging
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from songs import PLAY_RATE, Source, Store, safe_id, short_hash

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import device_memory  # noqa: E402

log = logging.getLogger("miyoria.sing.engine")

SR = 44_100  # the separators (Mel-Band RoFormer, Demucs) and the Seed-VC singing model run at 44.1 kHz
Progress = Callable[[float], None]

# The vocal separator: Kim's Mel-Band RoFormer (KimberleyJSN/melbandroformer, MIT), the same
# architecture as the lead split (leadsplit.py runs it), cleaner vocals than Demucs htdemucs.
VOCAL_CKPT = "MelBandRoformer.ckpt"
MELBAND = "melband"


def vocal_model_path(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_VOCAL_MODEL") or Path(__file__).resolve().parent.parent / "models" / "vocal-split" / VOCAL_CKPT)


VOICE_CHAINS = ("rvc", "ying+rvc", "ying", "seedvc+rvc", "seedvc")
YING_CKPT = Path("ckpt") / "YingMusic-SVC-full.pt"
YING_CONFIG = Path("configs") / "YingMusic-SVC.yml"


def ying_dir(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_YING_DIR") or Path(__file__).resolve().parent.parent / "models" / "yingmusic-svc")


def ying_available(env: dict[str, str] | None = None) -> bool:
    root = ying_dir(env)
    return (root / "modules").is_dir() and (root / YING_CKPT).is_file() and (root / YING_CONFIG).is_file()


def voice_chain(env: dict[str, str] | None = None) -> str:
    """How her voice is made: SING_VOICE (``rvc`` default: her own RVC model sings the lead;
    ``ying+rvc``, ``ying``, ``seedvc+rvc``, ``seedvc``: YingMusic / Seed-VC first). A part whose files
    are missing is left out (no RVC model: YingMusic alone; no YingMusic: Seed-VC)."""
    import rvcpass

    e = env if env is not None else os.environ
    want = (e.get("SING_VOICE") or "rvc").strip().lower()
    if want not in VOICE_CHAINS:
        log.warning("SING_VOICE=%r is none of %s; using rvc", want, "|".join(VOICE_CHAINS))
        want = "rvc"
    if want == "rvc":
        if rvcpass.available(e):
            return "rvc"
        log.warning("RVC model or Applio not found (%s); converting with YingMusic", rvcpass.model_path(e))
        want = "ying"
    base, _, rvc = want.partition("+")
    if base == "ying" and not ying_available(e):
        log.warning("YingMusic-SVC not found at %s; converting with Seed-VC", ying_dir(e))
        base = "seedvc"
    if rvc and not rvcpass.available(e):
        log.warning("RVC model or Applio not found (%s); no RVC pass", rvcpass.model_path(e))
        rvc = ""
    return f"{base}+{rvc}" if rvc else base


def default_separator(env: dict[str, str] | None = None) -> str:
    """SING_SEPARATOR_MODEL, else the RoFormer when its checkpoint and config are there, else htdemucs."""
    import leadsplit

    e = env if env is not None else os.environ
    if e.get("SING_SEPARATOR_MODEL"):
        return e["SING_SEPARATOR_MODEL"]
    ckpt = vocal_model_path(e)
    return MELBAND if ckpt.is_file() and leadsplit.config_path(ckpt) is not None else "htdemucs"


class JobError(Exception):
    """A request that cannot be done (shown to the requester)."""


class Cancelled(Exception):
    pass


class Suspended(Exception):
    """Raised from the step gate: the stage lets go of the GPU now (gpu.py) and runs again later.
    ``code`` says why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class ConvertWork:
    """What a conversion got done, so a suspended one goes on from the last finished chunk. ``steps``
    replaces SING_DIFFUSION_STEPS from the next chunk on."""

    done: int = 0
    chunks: list[Any] = field(default_factory=list)
    prev: Any = None
    steps: int | None = None


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


DEFAULT_URL_HOSTS = (
    "youtube.com",
    "youtu.be",
    "music.youtube.com",
    "soundcloud.com",
    "bilibili.com",
    "b23.tv",
    "nicovideo.jp",
)


def allowed_url(url: str) -> bool:
    """Only http(s) links to the hosts in ``SING_URL_HOSTS`` (comma separated; subdomains count)."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    if u.scheme not in ("http", "https") or not u.hostname:
        return False
    raw = os.environ.get("SING_URL_HOSTS")
    hosts = [h.strip().lower() for h in raw.split(",")] if raw else list(DEFAULT_URL_HOSTS)
    host = u.hostname.lower()
    return any(h and (host == h or host.endswith("." + h)) for h in hosts)


# ── audio helpers (numpy) ────────────────────────────────────────────────────


def lyrics_extra(info: dict[str, Any], raw_title: str) -> dict[str, Any]:
    """What the lyrics lookup wants of a yt-dlp info dict: the title, the music metadata, the description."""
    ex: dict[str, Any] = {"raw_title": raw_title}
    for key, name in (("track", "track"), ("alt_title", "alt_title")):
        if info.get(key):
            ex[name] = str(info[key])
    meta_artist = info.get("artist") or info.get("creator")
    if meta_artist:
        ex["meta_artist"] = str(meta_artist).split(",")[0].strip()
    if info.get("description"):
        ex["description"] = str(info["description"])[:1500]
    if info.get("tags"):
        ex["tags"] = [str(t) for t in info["tags"]][:15]
    return ex


def ydl_options(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """yt-dlp options for resolving and downloading, ``extra`` on top."""
    # Its cache lives with the songs (SING_YTDLP_CACHE): when it cannot write to its default
    # ~/.cache/yt-dlp, Python's tempfile retries forever on Windows and the lookup never returns.
    cache = os.environ.get("SING_YTDLP_CACHE")
    return {
        **({"cachedir": cache} if cache else {}),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bestaudio/best",
        "socket_timeout": 20,
        # YouTube needs a JS runtime for its player challenges; Node is there for Miyoria anyway.
        "js_runtimes": {r.strip(): {} for r in os.environ.get("SING_JS_RUNTIMES", "deno,node").split(",") if r.strip()},
        # Every request asks for a byte range: bilibili's CDN answers a plain GET with HTTP 567.
        "http_chunk_size": 10 * 1024 * 1024,
        **(extra or {}),
    }


def fresh_info(src: Source) -> dict[str, Any] | None:
    """A copy of the yt-dlp answer the lookup got, while its stream links still work (they last hours;
    SING_INFO_REUSE_S, default 3600). Downloading from it skips yt-dlp's second reading of the page,
    the player and its JS challenges: on 2026-11-13 that was 7.8 of the download's 8.0 s (the audio
    itself, 2.7 MB, took 0.2 s), so more connections would not have helped."""
    info = src.info
    if not info or not info.get("formats") or src.info_at is None:
        return None
    if time.monotonic() - src.info_at > env_float("SING_INFO_REUSE_S", 3600.0):
        return None
    return copy.deepcopy(info)


def ffmpeg_to_wav(src: Path, dst: Path, rate: int = SR, channels: int = 2, max_s: float | None = None) -> None:
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]
    if max_s:
        cmd += ["-t", f"{max_s:.0f}"]
    cmd += ["-vn", "-ac", str(channels), "-ar", str(rate), "-c:a", "pcm_s16le", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise JobError(f"ffmpeg could not decode the audio: {r.stderr.strip()[:300]}")


# ── video ────────────────────────────────────────────────────────────────────

# Every song video is re-encoded to one frame size, letterboxed in the sing scene's background:
# OBS's media source (32.1, hardware decoding) crashes when the file it plays changes to a
# video of another size.
VIDEO_W, VIDEO_H = 1280, 720
VIDEO_PAD = "0x10141f"


def normalize_video(src: Path, dst: Path) -> None:
    """``src`` as a VIDEO_W x VIDEO_H H.264 mp4 without audio (NVENC, else libx264), at most 30 fps."""
    vf = (f"scale={VIDEO_W}:{VIDEO_H}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
          f"pad={VIDEO_W}:{VIDEO_H}:(ow-iw)/2:(oh-ih)/2:color={VIDEO_PAD},setsar=1,format=yuv420p")
    head = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-an", "-sn", "-dn", "-vf", vf, "-fpsmax", "30"]
    tail = ["-movflags", "+faststart", str(dst)]
    encoders = (
        ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-threads", "4"],
    )
    err = ""
    for enc in encoders:
        r = subprocess.run(head + enc + tail, capture_output=True, text=True)
        if r.returncode == 0:
            return
        err = r.stderr.strip()
    raise JobError(f"ffmpeg could not re-encode the video: {err[:300]}")


def read_audio(p: Path):
    """(frames, channels) float32 and the sample rate."""
    import soundfile as sf

    x, sr = sf.read(str(p), dtype="float32", always_2d=True)
    return x, sr


def write_wav(p: Path, x, sr: int) -> None:
    import numpy as np
    import soundfile as sf

    sf.write(str(p), np.clip(x, -1.0, 1.0), sr, subtype="PCM_16")


def write_pcm(p: Path, mono, sr: int) -> int:
    """s16le mono at ``PLAY_RATE``; returns the sample count."""
    import numpy as np
    from scipy.signal import resample_poly

    if sr != PLAY_RATE:
        g = math.gcd(sr, PLAY_RATE)
        mono = resample_poly(mono, PLAY_RATE // g, sr // g)
    pcm = (np.clip(mono, -1.0, 1.0) * 32767.0).astype("<i2")
    p.write_bytes(pcm.tobytes())
    return int(pcm.shape[0])


def rms_frames(mono, hop: int = 512):
    import numpy as np

    n = len(mono) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    f = mono[: n * hop].reshape(n, hop)
    return np.sqrt((f * f).mean(axis=1) + 1e-12)


def vocal_gate(source_mono, converted, hop: int = 512, floor_db: float = -40.0):
    """Mutes the converted vocal where the separated source vocal is silent (VC hiss, ghost
    breaths), with ~70 ms attack / ~200 ms release so phrase edges are not clipped."""
    import numpy as np
    from scipy.ndimage import maximum_filter1d, uniform_filter1d

    n = min(len(source_mono), len(converted))
    r = rms_frames(source_mono[:n], hop)
    if r.size == 0:
        return converted
    db = 20 * np.log10(r)
    mask = (db > db.max() + floor_db).astype(np.float32)
    mask = maximum_filter1d(mask, size=int(0.4 * SR / hop) | 1)
    mask = uniform_filter1d(mask, size=max(1, int(0.07 * SR / hop)))
    env = np.repeat(mask, hop)
    env = np.pad(env, (0, max(0, n - len(env))), mode="edge")[:n]
    out = converted.copy()
    out[:n] *= env
    out[n:] = 0
    return out


def loudness(x, sr: int) -> float | None:
    try:
        import pyloudnorm as pyln

        v = pyln.Meter(sr).integrated_loudness(x)
        return float(v) if math.isfinite(v) else None
    except Exception:
        return None


def free_cuda() -> None:
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


def is_oom(e: BaseException) -> bool:
    torch = sys.modules.get("torch")
    if torch is not None and isinstance(e, torch.cuda.OutOfMemoryError):
        return True
    return "out of memory" in str(e).lower()


@contextmanager
def leave_cores_free():
    """A separation that moved to the CPU to spare her voice uses half the cores: the speech workers
    need some too, and a CPU that is full would stutter her just the same."""
    import torch

    before = torch.get_num_threads()
    torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))
    try:
        yield
    finally:
        torch.set_num_threads(before)


# ── backend ──────────────────────────────────────────────────────────────────


class RealBackend:
    name = "seed-vc"

    def __init__(self, store: Store) -> None:
        import torch

        self.store = store
        self.device = os.environ.get("SING_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        self._cuda = str(self.device).startswith("cuda") and torch.cuda.is_available()
        self.separator = default_separator()
        self.vocal_model = vocal_model_path()
        self.vocal_overlap = env_int("SING_VOCAL_OVERLAP", 2)
        self.separate_device = os.environ.get("SING_SEPARATE_DEVICE", self.device)
        self.steps = env_int("SING_DIFFUSION_STEPS", 30)
        self.cfg_rate = env_float("SING_CFG_RATE", 0.7)
        self.keep = os.environ.get("SING_KEEP_MODELS", "0") == "1"
        self.max_s = env_float("SING_MAX_SECONDS", 480)
        here = Path(__file__).resolve().parent
        self.seedvc_dir = Path(os.environ.get("SING_SEEDVC_DIR", here.parent / "models" / "seed-vc"))
        self.ref_paths = ref_paths(os.environ.get("SING_REF") or str(here.parent / "voices" / "deepseek-chan" / "ref.wav"))
        self.f0_clean = os.environ.get("SING_F0_CLEAN", "1") != "0"
        self.lead_device = os.environ.get("SING_LEAD_DEVICE", self.separate_device)
        # 2 (each sample read twice): the karaoke model scores the same at 2 as at 8 on MVSep's
        # leaderboard (10.77 / 10.79 dB) and runs twice as fast as at 4.
        self.lead_overlap = env_int("SING_LEAD_OVERLAP", 2)
        if not (self.seedvc_dir / "modules").exists():
            raise RuntimeError(f"Seed-VC not found at {self.seedvc_dir} (set SING_SEEDVC_DIR)")
        if not self.ref_paths:
            raise RuntimeError("reference voice not found (set SING_REF to a file, a list or a folder)")
        self.voice = voice_chain()
        self.ying_dir = ying_dir()
        self.rvc = self.voice == "rvc" or self.voice.endswith("+rvc")
        self.rvc_error: str | None = None
        self.model_name = f"{self.voice}+{self.separator}"
        import leadsplit

        self.lead_tag = leadsplit.tag()  # which karaoke model makes the lead stems, and from what
        self._vc: Any = None
        self._demucs: Any = None  # the vocal separator, whichever it is
        self._lead: Any = None
        self.gate: Callable[[], None] | None = None  # sharing the GPU: runs before every step
        self._ref: Any = None
        self._ref_f0: float | None = None
        self._preload: threading.Thread | None = None  # the lead model loading during a download
        self.transposer = "rubberband" if ffmpeg_has_filter("rubberband") else "librosa"

    # ── resolve / fetch ──────────────────────────────────────────────────

    def _ydl(self, extra: dict[str, Any] | None = None):
        from yt_dlp import YoutubeDL

        return YoutubeDL(ydl_options(extra))

    def _source_of(self, info: dict[str, Any], kind: str) -> Source:
        from lyrics import guess_artist_title

        vid = str(info.get("id") or short_hash(str(info.get("webpage_url"))))
        extractor = str(info.get("extractor_key") or kind).lower()
        key = f"yt-{vid}" if extractor.startswith("youtube") else f"{safe_id(extractor, 16)}-{safe_id(vid, 40)}"
        raw_title = str(info.get("title") or vid)
        artist, title = guess_artist_title(raw_title, info.get("uploader") or info.get("channel"))
        if info.get("track"):
            title = str(info["track"])
        if info.get("artist") or info.get("creator"):
            artist = str(info.get("artist") or info.get("creator")).split(",")[0].strip()
        return Source(
            key=key,
            kind=kind,
            title=title,
            artist=artist,
            duration_s=float(info["duration"]) if info.get("duration") else None,
            url=info.get("webpage_url") or info.get("original_url"),
            uploader=info.get("uploader") or info.get("channel"),
            extra=lyrics_extra(info, raw_title),
            info=info,
            info_at=time.monotonic(),
        )

    def fetch_hints(self, url: str) -> dict[str, Any]:
        """The lyrics lookup's view of a link (yt-dlp metadata only, nothing downloaded), for old songs."""
        from lyrics import hints_of

        with self._ydl() as ydl:
            info = ydl.extract_info(url, download=False)
        if info and info.get("entries"):
            info = next((e for e in info["entries"] if e), None)
        return hints_of(self._source_of(info, "youtube")) if info else {}

    def resolve_search(self, query: str) -> Source:
        with self._ydl() as ydl:
            info = ydl.extract_info(f"ytsearch1:{query}", download=False)
        entries = [e for e in (info or {}).get("entries") or [] if e]
        if not entries:
            raise JobError(f"no search result for {query!r}")
        return self._source_of(entries[0], "youtube")

    def resolve_url(self, url: str) -> Source:
        if not allowed_url(url):
            raise JobError("that link is not on an allowed host (SING_URL_HOSTS)")
        with self._ydl() as ydl:
            info = ydl.extract_info(url, download=False)
        if info and info.get("entries"):
            info = next((e for e in info["entries"] if e), None)
        if not info:
            raise JobError("the link has no playable audio")
        kind = "youtube" if str(info.get("extractor_key", "")).lower().startswith("youtube") else "url"
        return self._source_of(info, kind)

    def fetch(self, src: Source, dest: Path, progress: Progress) -> None:
        """``source.wav`` (44.1 kHz stereo) for a YouTube / URL source."""
        if src.duration_s and src.duration_s > self.max_s:
            raise JobError(f"the song is too long ({src.duration_s / 60:.1f} min > {self.max_s / 60:.0f} min)")
        with tempfile.TemporaryDirectory(prefix="sing-dl-") as tmp:
            stopped: list[BaseException] = []  # ``progress`` raised (a cancel): no second try

            def hook(d: dict[str, Any]) -> None:
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if d.get("status") == "downloading" and total:
                    try:
                        progress(min(0.99, float(d.get("downloaded_bytes", 0)) / float(total)))
                    except BaseException as e:
                        stopped.append(e)
                        raise

            with self._ydl({
                "outtmpl": str(Path(tmp) / "dl.%(ext)s"),
                "progress_hooks": [hook],
                "max_filesize": 200 * 1024 * 1024,
            }) as ydl:
                info = fresh_info(src)
                if info is not None:
                    try:
                        ydl.process_ie_result(info, download=True)
                    except Exception as e:  # noqa: BLE001 - a link that expired: read the page again
                        if stopped:
                            raise stopped[0] from None
                        log.info("download from the lookup's answer failed (%s); reading the page again", e)
                        info = None
                        for p in Path(tmp).iterdir():
                            p.unlink(missing_ok=True)
                if info is None:
                    try:
                        ydl.download([src.url])
                    except Exception:
                        if stopped:
                            raise stopped[0] from None
                        raise
            if stopped:
                raise stopped[0]
            files = [p for p in Path(tmp).iterdir() if p.name.startswith("dl.") and not p.name.endswith(".part")]
            if not files:
                raise JobError("download produced no audio file")
            ffmpeg_to_wav(files[0], dest, max_s=self.max_s)

    def fetch_video(self, src: Source, dest: Path, progress: Progress, cancelled: Callable[[], bool]) -> dict[str, Any]:
        """The source's video, video only (the stream hears her cover), into ``dest`` (mp4).

        H.264 up to SING_VIDEO_MAX_HEIGHT first (every OBS build decodes it, cheaply), then any
        codec at that height (remuxed into mp4), then a combined format; nothing over
        SING_VIDEO_MAX_MB. Runs next to the audio pipeline, on its own YoutubeDL.
        """
        if not src.url:
            raise JobError("the song has no link to a video")
        h = env_int("SING_VIDEO_MAX_HEIGHT", 1080)
        mb = env_int("SING_VIDEO_MAX_MB", 300)
        size = f"[filesize<?{mb}M]"
        fmt = "/".join([
            f"bv[height<={h}][vcodec^=avc1]{size}",
            f"bv[height<={h}]{size}",
            f"b[height<={h}]{size}",
        ])
        with tempfile.TemporaryDirectory(prefix="sing-video-", dir=dest.parent) as tmp:

            def hook(d: dict[str, Any]) -> None:
                if cancelled():
                    raise Cancelled()
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if d.get("status") == "downloading" and total:
                    progress(min(0.99, float(d.get("downloaded_bytes", 0)) / float(total)))

            with self._ydl({
                "format": fmt,
                "outtmpl": str(Path(tmp) / "video.%(ext)s"),
                "progress_hooks": [hook],
                "noprogress": True,
                "max_filesize": mb * 1024 * 1024,
                "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
            }) as ydl:
                info = None
                known = fresh_info(src)  # this thread's own copy: the audio download reads it too
                if known is not None:
                    try:
                        info = ydl.process_ie_result(known, download=True) or {}
                    except Exception as e:  # noqa: BLE001
                        if cancelled():
                            raise Cancelled() from e
                        log.info("video from the lookup's answer failed (%s); reading the page again", e)
                        for p in Path(tmp).iterdir():
                            p.unlink(missing_ok=True)
                if info is None:
                    try:
                        info = ydl.extract_info(src.url, download=True) or {}
                    except Exception as e:
                        if cancelled():
                            raise Cancelled() from e
                        raise JobError(f"no video: {str(e).strip()[:200]}") from e
            out = Path(tmp) / "video.mp4"
            if not out.is_file():
                raise JobError("the video download produced no mp4 (over SING_VIDEO_MAX_MB?)")
            if cancelled():
                raise Cancelled()
            even = Path(tmp) / "video.even.mp4"
            normalize_video(out, even)
            os.replace(even, dest)
        progress(1.0)
        return {
            "width": VIDEO_W,
            "height": VIDEO_H,
            "source_width": info.get("width"),
            "source_height": info.get("height"),
            "vcodec": info.get("vcodec"),
            "fps": info.get("fps"),
            "format_id": info.get("format_id"),
        }

    def library_video(self, v: Path, sdir: Path) -> dict[str, Any]:
        """A library entry's own video, re-encoded into ``sdir/video.mp4``."""
        normalize_video(v, sdir / "video.mp4")
        return {"source": "library", "width": VIDEO_W, "height": VIDEO_H}

    def fetch_library(self, src: Source, sdir: Path) -> None:
        p = self.store.library_path(src.path or "")
        if src.split:
            from songs import _stem_file

            vocals = _stem_file(p, "vocals")
            inst = _stem_file(p, "instrumental") or _stem_file(p, "inst")
            assert vocals and inst
            ffmpeg_to_wav(vocals, sdir / "vocals.wav", max_s=self.max_s)
            ffmpeg_to_wav(inst, sdir / "instrumental.wav", max_s=self.max_s)
        else:
            ffmpeg_to_wav(p, sdir / "source.wav", max_s=self.max_s)

    # ── separation (Mel-Band RoFormer, or a Demucs model) ────────────────

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Progress,
                 device: str | None = None) -> None:
        """``device``: where gpu.py placed this run, instead of SING_SEPARATE_DEVICE."""
        on = device or self.separate_device
        try:
            if device == "cpu":
                with leave_cores_free():
                    self._separate_on("cpu", source_wav, vocals_out, inst_out, progress)
            else:
                self._separate_on(on, source_wav, vocals_out, inst_out, progress)
        except Exception as e:
            if not is_oom(e) or on == "cpu":
                raise
            log.warning("separation ran out of VRAM; retrying on the CPU")
            self._demucs = None
            free_cuda()
            self._separate_on("cpu", source_wav, vocals_out, inst_out, progress)
        finally:
            if not self.keep:
                self._demucs = None
            free_cuda()
        progress(1.0)

    def _separate_on(self, device: str, source_wav: Path, vocals_out: Path, inst_out: Path,
                     progress: Progress | None = None) -> None:
        if self.separator == MELBAND:
            self._separate_melband(device, source_wav, vocals_out, inst_out, progress)
            return
        import torch
        from demucs.apply import apply_model
        from demucs.pretrained import get_model

        if self._demucs is None:
            self._demucs = get_model(self.separator)
            self._demucs.eval()
        model = self._demucs
        self._gate_separator(model)
        x, sr = read_audio(source_wav)
        if sr != model.samplerate:
            raise JobError(f"source is {sr} Hz, the separator wants {model.samplerate}")
        if x.shape[1] == 1:
            x = x.repeat(2, axis=1)
        wav = torch.from_numpy(x.T.copy())
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        with torch.no_grad():
            out = apply_model(model, ((wav - mean) / std)[None], device=device, shifts=1, split=True,
                              overlap=0.25, progress=False)[0]
        out = out * std + mean
        vi = model.sources.index("vocals")
        vocals = out[vi]
        inst = out.sum(0) - vocals
        write_wav(vocals_out, vocals.T.numpy(), sr)
        write_wav(inst_out, inst.T.numpy(), sr)

    def _separate_melband(self, device: str, source_wav: Path, vocals_out: Path, inst_out: Path,
                          progress: Progress | None) -> None:
        """The vocals with Kim's Mel-Band RoFormer (the lead split's runner, another checkpoint); the
        instrumental is what is left (``source - vocals``), so the two add up to the song."""
        import leadsplit

        if self._demucs is not None and getattr(self._demucs, "device", None) != device:
            self._demucs = None
        if self._demucs is None:
            self._demucs = leadsplit.LeadSplitter(self.vocal_model, device)
        splitter = self._demucs
        splitter.gate = self.gate
        x, sr = read_audio(source_wav)
        if x.shape[1] == 1:
            x = x.repeat(2, axis=1)
        if sr != splitter.sr:
            raise JobError(f"source is {sr} Hz, the separator wants {splitter.sr}")
        vocals = splitter.lead(x, sr, progress, overlap=min(self.vocal_overlap, 2) if device == "cpu" else self.vocal_overlap)
        n = min(len(vocals), len(x))
        write_wav(vocals_out, vocals[:n], sr)
        write_wav(inst_out, x[:n] - vocals[:n], sr)

    # ── lead / backing split (karaoke RoFormer, leadsplit.py) ────────────

    def lead_available(self) -> bool:
        """Whether the split runs: SING_LEAD_SPLIT is not 0 and the checkpoint is where it is looked for."""
        import leadsplit

        return leadsplit.available()

    def split_lead(self, vocals_wav: Path, lead_out: Path, backing_out: Path, progress: Progress,
                   device: str | None = None, source_wav: Path | None = None,
                   rest_out: Path | None = None) -> None:
        """The lead voice into ``lead_out``; when the separated vocals are there, the rest of them
        into ``backing_out`` (``vocals - lead``); when the song is, everything but the lead into
        ``rest_out`` (``song - lead``: instrumental and backing voices in one). The model reads the
        whole song (``source_wav``) when leadsplit says so and it is there, else the vocals.
        ``device``: where gpu.py placed this run."""
        on = device or self.lead_device
        args = (vocals_wav, lead_out, backing_out, progress, source_wav, rest_out)
        try:
            if device == "cpu":
                with leave_cores_free():
                    self._split_on("cpu", *args)
            else:
                self._split_on(on, *args)
        except Exception as e:
            if not is_oom(e) or on == "cpu":
                raise
            log.warning("lead split ran out of VRAM; retrying on the CPU")
            self._lead = None
            free_cuda()
            self._split_on("cpu", *args)
        finally:
            if not self.keep:
                self._lead = None
            free_cuda()
        progress(1.0)

    def _split_on(self, device: str, vocals_wav: Path, lead_out: Path, backing_out: Path, progress: Progress,
                  source_wav: Path | None = None, rest_out: Path | None = None) -> None:
        import leadsplit

        if self._lead is not None and self._lead.device != device:
            self._lead = None
        if self._lead is None:
            self._lead = leadsplit.LeadSplitter(leadsplit.model_path(), device)
        splitter = self._lead
        splitter.gate = self.gate
        vocals = read_audio(vocals_wav) if Path(vocals_wav).exists() else None
        song = read_audio(source_wav) if source_wav is not None and Path(source_wav).exists() else None
        src = song if leadsplit.reads_mix() and song is not None else vocals
        if src is None:
            raise RuntimeError("nothing to split: neither the song nor its vocals are there")
        x, sr = src
        lead = splitter.lead(x, sr, progress, overlap=min(self.lead_overlap, 2) if device == "cpu" else self.lead_overlap)
        write_wav(lead_out, lead, sr)
        _write_differences(lead, sr, vocals, backing_out, song, rest_out)

    def complete_stems(self, sdir: Path) -> None:
        """A cached lead: the backing (vocals - lead) and the rest (song - lead) it is missing,
        by subtraction, from whichever of the vocals and the song are there."""
        backing, rest = sdir / "backing.wav", sdir / "rest.wav"
        vocals, song = sdir / "vocals.wav", sdir / "source.wav"
        want_backing = vocals.exists() and not backing.exists()
        want_rest = song.exists() and not rest.exists()
        if not (want_backing or want_rest):
            return
        lead, sr = read_audio(sdir / "lead.wav")
        _write_differences(lead, sr, read_audio(vocals) if want_backing else None, backing,
                           read_audio(song) if want_rest else None, rest)

    def lead_reads_mix(self) -> bool:
        import leadsplit

        return leadsplit.reads_mix()

    def _gate_separator(self, model: Any) -> None:
        """Before every segment the separator looks at `self.gate` (a bag of models has several)."""
        if getattr(model, "_miyoria_gated", False):
            return

        def before(_module: Any, _args: Any) -> None:
            if self.gate is not None:
                self.gate()

        for m in getattr(model, "models", [model]):
            m.register_forward_pre_hook(before)
        model._miyoria_gated = True

    # ── the card, as gpu.py sees it ──────────────────────────────────────

    def uses_cuda(self) -> bool:
        return self._cuda

    def gpu_name(self) -> str:
        now = device_memory.read()
        return now.name if now is not None else "cuda"

    def vram(self, peek: bool = False) -> tuple[int, int] | None:
        """(free, total) MB of the whole device, other applications included (device_memory.py).
        Without NVML, ``mem_get_info`` is right on Linux and blind on Windows, where not knowing is
        the better answer. ``peek``: `None` instead of starting CUDA in a worker not using it yet."""
        now = device_memory.read()
        if now is not None:
            return now.free_mb, now.total_mb
        import torch

        if sys.platform == "win32" or (peek and not torch.cuda.is_initialized()):
            return None
        free, total = torch.cuda.mem_get_info()
        return round(free / 2**20), round(total / 2**20)

    def own_vram_mb(self) -> int:
        """What this process holds, cache included: part of what is not free, but ours to use."""
        import torch

        return round(torch.cuda.memory_reserved() / 2**20) if torch.cuda.is_initialized() else 0

    def sync(self) -> None:
        """Before a step is timed: the work of the last one really ended."""
        import torch

        if torch.cuda.is_initialized():
            torch.cuda.synchronize()

    def trim(self) -> None:
        free_cuda()

    def peak_reset(self) -> None:
        import torch

        if torch.cuda.is_initialized():
            torch.cuda.reset_peak_memory_stats()

    def peak_read(self) -> tuple[int, int]:
        """(reserved, allocated) MB since ``peak_reset``. Reserved is what the card really gave up;
        allocated is the smaller number the song's ``peak_vram_mb`` has always shown."""
        import torch

        if not torch.cuda.is_initialized():
            return 0, 0
        return round(torch.cuda.max_memory_reserved() / 2**20), round(torch.cuda.max_memory_allocated() / 2**20)

    # ── conversion (Seed-VC singing model) ───────────────────────────────

    def _load_vc(self) -> Any:
        if self._vc is None:
            # Both repositories ship a top-level `modules` package: only the chosen one goes on the
            # path (the chain is fixed for the life of the process).
            ying = self.voice.startswith("ying")
            code = self.ying_dir if ying else self.seedvc_dir
            if str(code) not in sys.path:
                sys.path.insert(0, str(code))
            from seedvc_runtime import PitchExtractor, SeedVcSinger

            if self.voice == "rvc":
                # RVC converts by itself: only the pitch tracker is needed here.
                self._vc = PitchExtractor(self.seedvc_dir, self.device)
            elif ying:
                self._vc = SeedVcSinger(self.ying_dir, self.device, ckpt=self.ying_dir / YING_CKPT,
                                        config=self.ying_dir / YING_CONFIG, cache=self.seedvc_dir / "checkpoints")
            else:
                self._vc = SeedVcSinger(self.seedvc_dir, self.device)
        return self._vc

    def median_f0(self, mono, sr: int) -> float | None:
        vc = self._load_vc()
        return vc.median_f0(mono, sr)

    def f0_stats(self, mono, sr: int) -> tuple[float, float] | None:
        """(median, 95th percentile) of the (cleaned) voiced F0."""
        from pitch import f0_stats

        return f0_stats(self._load_vc().f0(mono, sr, clean=self.f0_clean))

    def reference(self):
        """Her reference voice, mono: one file, or several clips joined with short pauses (a
        longer reference gives the model more of her), at most REF_MAX_S."""
        if self._ref is None:
            self._ref = join_clips(self.ref_paths)
        return self._ref

    def ref_f0(self) -> float | None:
        if self._ref_f0 is None:
            mono, sr = self.reference()
            self._ref_f0 = self.median_f0(mono, sr)
        return self._ref_f0

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Progress,
                cancelled: Callable[[], bool], work: ConvertWork | None = None) -> None:
        self.rvc_error = None
        if getattr(self, "voice", "") == "rvc":
            self._convert_rvc(vocals_wav, out_wav, shift, progress, cancelled)
            return
        try:
            vc = self._load_vc()
            vc.step_gate = self.gate
            x, sr = read_audio(vocals_wav)
            ref, rsr = self.reference()
            y = vc.convert(x.mean(axis=1), sr, ref, rsr, shift, self.steps, self.cfg_rate,
                           progress, cancelled, clean=self.f0_clean, work=work)
            y = vocal_gate(x.mean(axis=1), y)
        finally:
            # The model is in a reference cycle (its step hook), so only the collector in `unload`
            # frees it, and only if nothing here still points at it: on 11-07 an idle worker held
            # 1.9 GB this way, because an idle process never runs the collector again.
            vc = None
            if not self.keep:
                self._unload_models()  # (not the RVC process: the RVC pass is next)
        if getattr(self, "rvc", False):
            if cancelled():
                raise Cancelled()
            try:
                y = self._rvc_pass(x.mean(axis=1), y, out_wav.parent)
            except Exception as e:  # the converted vocal stands on its own
                self.rvc_error = str(e)
                log.warning("RVC pass failed, keeping the converted vocal: %s", e)
        write_wav(out_wav, y, SR)

    def convert_auto(self, vocals_wav: Path, out_wav: Path,
                     choose: Callable[[tuple[float, float] | None, float | None], int], progress: Progress,
                     cancelled: Callable[[], bool]) -> None:
        """SING_VOICE=rvc with the automatic key: the shift is picked from the pitch Applio tracks for
        the conversion anyway (rvcpass.run_choosing; ``choose(stats, ref_hz)`` gets the vocal's
        (median, top) and her reference's median, and returns the shift), so the pitch is read once
        and RMVPE is not loaded in this process at all: about 2 s a song. Her reference's median is
        read the same way, once. When the RVC process cannot be asked, it is read here as before."""
        import librosa
        import numpy as np
        import rvcpass

        if cancelled():
            raise Cancelled()
        self.rvc_error = None
        x, sr = read_audio(vocals_wav)
        src = x.mean(axis=1)
        if sr != SR:
            src = librosa.resample(src, orig_sr=sr, target_sr=SR)
        work = out_wav.parent
        tmp_in, tmp_out, ref_wav = work / "rvc_in.wav", work / "rvc_out.wav", work / "rvc_ref.wav"
        picked: dict[str, int] = {}

        def answer(q: dict[str, Any]) -> int:
            if self._ref_f0 is None and q.get("ref_hz"):
                self._ref_f0 = float(q["ref_hz"])
            stats = (float(q["median"]), float(q["top"])) if q.get("median") else None
            picked["shift"] = int(choose(stats, self._ref_f0))
            return picked["shift"]

        try:
            write_wav(tmp_in, src, SR)
            ref = None
            if self._ref_f0 is None:
                mono, rsr = self.reference()
                write_wav(ref_wav, mono, rsr)
                ref = ref_wav
            try:
                rvcpass.run_choosing(tmp_in, tmp_out, answer, ref)
            except Exception as e:  # noqa: BLE001
                if "shift" not in picked:
                    log.info("the RVC process could not read the pitch (%s); reading it here", e)
                    picked["shift"] = int(choose(self.f0_stats(src, SR), self.ref_f0()))
                else:
                    log.info("RVC failed after picking the shift (%s); converting again", e)
                rvcpass.run(tmp_in, tmp_out, pitch=picked["shift"])
            y, rsr = read_audio(tmp_out)
            y = y.mean(axis=1)
            if rsr != SR:
                y = librosa.resample(y, orig_sr=rsr, target_sr=SR)
            y = np.pad(y, (0, max(0, len(src) - len(y))))[:len(src)].astype(np.float32)
            y = vocal_gate(src, y)
        except (Cancelled, JobError):
            raise
        except Exception as e:
            self.rvc_error = str(e)
            raise JobError(f"RVC conversion failed: {e}") from e
        finally:
            for f in (tmp_in, tmp_out, ref_wav):
                f.unlink(missing_ok=True)
        progress(1.0)
        write_wav(out_wav, y, SR)

    def _convert_rvc(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Progress,
                     cancelled: Callable[[], bool]) -> None:
        """SING_VOICE=rvc: her RVC model sings the lead itself, moved by ``shift`` (one subprocess,
        so no progress in between and no letting go of the GPU halfway; it takes well under a minute)."""
        import librosa

        if cancelled():
            raise Cancelled()
        x, sr = read_audio(vocals_wav)
        src = x.mean(axis=1)
        if sr != SR:
            src = librosa.resample(src, orig_sr=sr, target_sr=SR)
        try:
            y = self._rvc_pass(src, src, out_wav.parent, pitch=shift)
        except Exception as e:
            self.rvc_error = str(e)
            raise JobError(f"RVC conversion failed: {e}") from e
        progress(1.0)
        write_wav(out_wav, y, SR)

    def _rvc_pass(self, source_mono, converted, workdir: Path, pitch: int = 0):
        """Her RVC model re-sings ``converted`` (rvcpass.py), moved by ``pitch``; back at SR, the
        source's length, gated like the conversion."""
        import librosa
        import numpy as np
        import rvcpass

        tmp_in, tmp_out = workdir / "rvc_in.wav", workdir / "rvc_out.wav"
        try:
            write_wav(tmp_in, converted, SR)
            rvcpass.run(tmp_in, tmp_out, pitch=pitch)
            y, rsr = read_audio(tmp_out)
            y = y.mean(axis=1)
            if rsr != SR:
                y = librosa.resample(y, orig_sr=rsr, target_sr=SR)
            n = len(converted)
            y = np.pad(y, (0, max(0, n - len(y))))[:n].astype(np.float32)
            return vocal_gate(source_mono, y)
        finally:
            tmp_in.unlink(missing_ok=True)
            tmp_out.unlink(missing_ok=True)

    def prewarm(self, lead: bool = False) -> None:
        """A job is about to download its song (about 6 s, most of it a wait YouTube asks for): her RVC
        model starts loading in its own process now (rvcpass.warm), and with ``lead`` (the lead split is
        the job's next GPU stage) the split's model loads onto the card (about 1.2 s, with CUDA's own
        start), instead of when they are needed."""
        if getattr(self, "rvc", False):
            import rvcpass

            rvcpass.warm()
        if lead and self._cuda and str(self.lead_device) != "cpu" and self._lead is None and getattr(self, "_preload", None) is None:
            self._preload = threading.Thread(target=self._preload_lead, name="sing-preload", daemon=True)
            self._preload.start()

    def _preload_lead(self) -> None:
        t0 = time.perf_counter()
        try:
            import leadsplit

            if leadsplit.available():
                self._lead = leadsplit.LeadSplitter(leadsplit.model_path(), self.lead_device)
                log.info("lead model loaded during the download in %.1f s", time.perf_counter() - t0)
        except Exception as e:  # noqa: BLE001 - the stage loads it itself
            log.info("could not load the lead model ahead: %s", e)

    def _join_preload(self) -> None:
        t, self._preload = getattr(self, "_preload", None), None  # (tests build the backend without __init__)
        if t is not None:
            t.join()

    def preimport(self) -> None:
        """At start, on a thread of its own: the libraries a job reaches for after its GPU stages
        (librosa's resampler and beat tracker with their numba code, scipy, pyloudnorm, soundfile)
        load and compile now instead of in the first song (beats took 1.3 s there, 0.2 s after)."""
        t0 = time.perf_counter()
        try:
            import numpy as np
            import pyloudnorm  # noqa: F401
            import scipy.ndimage  # noqa: F401
            import scipy.signal  # noqa: F401
            import soundfile  # noqa: F401

            import lyrics  # noqa: F401
            import lyrics_align  # noqa: F401
            from beats import beat_grid

            noise = (np.random.default_rng(0).standard_normal(PLAY_RATE * 4) * 0.1).astype(np.float32)
            beat_grid(noise, PLAY_RATE)  # librosa: resample, onset strength, beat tracking (numba)
            loudness(np.stack([noise, noise], axis=1), SR)
        except Exception as e:  # noqa: BLE001 - only a head start
            log.info("preimport stopped: %s", e)
        log.info("libraries loaded in %.1f s", time.perf_counter() - t0)

    def wait_warm(self, timeout: float = 30.0) -> None:
        """Before a GPU stage: what loads ahead (the lead model, the RVC warm-up) is done first."""
        self._join_preload()
        if getattr(self, "rvc", False):
            import rvcpass

            rvcpass.wait_warm(timeout)

    def _unload_models(self) -> None:
        self._join_preload()
        self._vc = None
        self._demucs = None
        self._lead = None
        free_cuda()

    def unload(self) -> None:
        """Everything this worker holds on the card, the RVC process included."""
        self._unload_models()
        import rvcpass

        rvcpass.stop()

    def idle(self, more: bool = False) -> None:
        """Between jobs: after a failure the traceback kept the models alive through ``unload``.
        ``more``: another job is queued, and the RVC process stays up for it."""
        if self.keep:
            return
        self._unload_models()
        if not more:
            import rvcpass

            rvcpass.stop()

    # ── key change of the instrumental ───────────────────────────────────

    def transpose(self, x, sr: int, semitones: int):
        """The instrumental moved by ``semitones``: Rubber Band (ffmpeg's ``rubberband`` filter,
        far cleaner on drums and chords), else librosa's phase vocoder."""
        if semitones == 0:
            return x
        if self.transposer == "rubberband":
            try:
                return rubberband_shift(x, sr, semitones)
            except JobError as e:
                log.warning("rubberband failed, using librosa: %s", e)
        import librosa
        import numpy as np

        return np.stack([librosa.effects.pitch_shift(x[:, c], sr=sr, n_steps=semitones) for c in range(x.shape[1])],
                        axis=1)


REF_MAX_S = 25.0  # what the conversion uses of the reference at most
REF_PAUSE_S = 0.3


def ref_paths(spec: str) -> list[Path]:
    """``SING_REF``: a file, files separated by ``;``, or a folder (its audio files, sorted)."""
    from songs import AUDIO_EXTS

    out: list[Path] = []
    for part in (p.strip() for p in spec.split(";")):
        if not part:
            continue
        p = Path(part)
        if p.is_dir():
            out += sorted(q for q in p.iterdir() if q.suffix.lower() in AUDIO_EXTS and q.is_file())
        elif p.is_file():
            out.append(p)
    return out


def join_clips(paths: list[Path], max_s: float = REF_MAX_S, pause_s: float = REF_PAUSE_S):
    """(mono float32, sample rate of the first clip): the clips in order with ``pause_s`` of
    silence between them, cut at ``max_s``."""
    import numpy as np

    parts, rate = [], None
    for p in paths:
        x, sr = read_audio(p)
        mono = x.mean(axis=1)
        if rate is None:
            rate = sr
        elif sr != rate:
            import librosa

            mono = librosa.resample(mono, orig_sr=sr, target_sr=rate)
        if parts:
            parts.append(np.zeros(int(pause_s * rate), dtype=np.float32))
        parts.append(mono.astype(np.float32))
    if rate is None:
        raise JobError("no reference voice")
    return np.concatenate(parts)[: int(max_s * rate)], rate


def ffmpeg_has_filter(name: str) -> bool:
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return any(line.split()[1:2] == [name] for line in r.stdout.splitlines() if line.strip())


def rubberband_shift(x, sr: int, semitones: int):
    """(frames, channels) float32 moved by ``semitones`` with ffmpeg's Rubber Band filter, same
    length, 32-bit float through the pipe (no clipping)."""
    import numpy as np

    frames, channels = x.shape
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(sr),
           "-ac", str(channels), "-i", "pipe:0",
           "-af", f"rubberband=pitch={2 ** (semitones / 12):.8f}:pitchq=quality:channels=together",
           "-f", "f32le", "-ar", str(sr), "-ac", str(channels), "pipe:1"]
    r = subprocess.run(cmd, input=np.ascontiguousarray(x, dtype="<f4").tobytes(), capture_output=True)
    if r.returncode != 0:
        raise JobError(f"ffmpeg rubberband: {r.stderr.decode('utf-8', 'replace').strip()[:300]}")
    y = np.frombuffer(r.stdout, dtype="<f4").reshape(-1, channels)
    if y.shape[0] < frames:
        y = np.pad(y, ((0, frames - y.shape[0]), (0, 0)))
    return y[:frames].copy()


def instrumental_for_mix(inst_wav: Path, key: int, backend: Any, backing_wav: Path | None = None,
                         instrumental: bool = True):
    """(frames, channels) float32 and its rate: what ``mix_song`` puts under her voice, the kept backing
    voices in it, moved by ``key``. Needs nothing of the conversion, so the worker starts it (the slow
    part is Rubber Band's key change) while the lead is converted."""
    import numpy as np

    inst, sr = read_audio(inst_wav)
    if not instrumental:
        inst = np.zeros_like(inst)
    if backing_wav is not None:
        b, bsr = read_audio(backing_wav)
        if bsr != sr:
            raise JobError("stems have different sample rates")
        k = min(len(inst), len(b))
        inst = inst[:k] + b[:k]
    return backend.transpose(inst, sr, key), sr


def mix_song(vocals_src: Path, vocals_conv: Path, inst_wav: Path, key: int, out_dir: Path, backend: RealBackend,
             target_lufs: float, backing_wav: Path | None = None, backing_conv: Path | None = None,
             backing_src: Path | None = None, instrumental: bool = True,
             prepared: tuple[Any, int] | None = None) -> dict[str, Any]:
    """Writes mix.wav / vocals.wav / instrumental.wav / play_*.pcm; returns loudness info.

    The converted vocal gets the separated vocal's loudness back (the converters' output level
    varies), the sum is normalised to ``target_lufs`` and kept under -1 dBFS peak. After a lead /
    backing split ``vocals_src`` is the lead, and the backing voices are either
    ``backing_wav`` as recorded: they join the instrumental (at their own level, moved by the key
    with it), which is then what instrumental.wav holds; or ``backing_conv``, converted like the
    lead: it joins her vocal at ``backing_src``'s level. ``instrumental`` False: her voice alone.
    ``prepared``: ``instrumental_for_mix`` of the same arguments, already done.
    """
    import numpy as np

    v_src, sr = read_audio(vocals_src)
    v, _ = read_audio(vocals_conv)
    inst, isr = prepared if prepared is not None else instrumental_for_mix(inst_wav, key, backend, backing_wav,
                                                                           instrumental)
    if isr != sr:
        raise JobError("stems have different sample rates")
    v = v.mean(axis=1)
    n = min(len(v), len(inst))
    v, inst, v_src = v[:n], inst[:n], v_src[:n].mean(axis=1)

    def voiced_rms(m):
        r = rms_frames(m)
        if r.size == 0:
            return 1e-6
        loud = r[r > r.max() * 0.1]
        return float(np.sqrt((loud ** 2).mean())) if loud.size else 1e-6

    g = min(4.0, max(0.25, voiced_rms(v_src) / max(voiced_rms(v), 1e-6)))
    v = v * g
    if backing_conv is not None and backing_src is not None:
        bc, _ = read_audio(backing_conv)
        bs, _ = read_audio(backing_src)
        bc, bs = bc.mean(axis=1)[:n], bs.mean(axis=1)[:n]
        gb = min(4.0, max(0.25, voiced_rms(bs) / max(voiced_rms(bc), 1e-6)))
        v[:len(bc)] += bc * gb
    mix = inst + v[:, None]
    lufs = loudness(mix, sr)
    gain = 10 ** ((target_lufs - lufs) / 20) if lufs is not None else 0.25 / max(float(np.sqrt((mix ** 2).mean())), 1e-6)
    peak = float(np.abs(mix).max()) * gain
    if peak > 0.89:  # -1 dBFS
        gain *= 0.89 / peak
    mix, v, inst = mix * gain, v * gain, inst * gain
    write_wav(out_dir / "mix.wav", mix, sr)
    write_wav(out_dir / "vocals.wav", v, sr)
    write_wav(out_dir / "instrumental.wav", inst, sr)
    samples = write_pcm(out_dir / "play_mix.pcm", mix.mean(axis=1), sr)
    write_pcm(out_dir / "play_vocals.pcm", v, sr)
    return {
        "vocal_gain": round(g, 3),
        "lufs": round(loudness(mix, sr) or float("nan"), 1),
        "samples": samples,
        "duration_s": round(samples / PLAY_RATE, 2),
    }


def _write_differences(lead, sr: int, vocals: tuple[Any, int] | None, backing_out: Path,
                       song: tuple[Any, int] | None, rest_out: Path | None) -> None:
    """``vocals - lead`` into ``backing_out`` and ``song - lead`` into ``rest_out``, for whichever
    is given (stereo, cut to the shorter)."""
    for pair, out in ((vocals, backing_out), (song, rest_out)):
        if pair is None or out is None:
            continue
        x, xsr = pair
        if xsr != sr:
            raise RuntimeError(f"{out.name}: the stems are at {xsr} Hz, the lead at {sr}")
        if x.shape[1] == 1:
            x = x.repeat(2, axis=1)
        n = min(len(lead), len(x))
        write_wav(out, x[:n] - lead[:n], sr)


def copy_if_missing(src: Path, dst: Path) -> None:
    if not dst.exists():
        shutil.copyfile(src, dst)


def now_ms() -> float:
    return time.perf_counter() * 1000
