"""The real song pipeline: yt-dlp / library → Demucs → Seed-VC (singing, F0) → mix.

Everything heavy is imported lazily so the server (and its mock mode) starts without torch. Models
are loaded per stage and freed right after (``SING_KEEP_MODELS=1`` keeps them): the GPU is shared
with TTS / ASR / OBS, so the worker only holds VRAM while a job runs.
"""

from __future__ import annotations

import gc
import logging
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from songs import PLAY_RATE, Source, Store, safe_id, short_hash

log = logging.getLogger("miyoria.sing.engine")

SR = 44_100  # Demucs htdemucs and the Seed-VC singing model both run at 44.1 kHz
Progress = Callable[[float], None]


class JobError(Exception):
    """A request that cannot be done (shown to the requester)."""


class Cancelled(Exception):
    pass


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


def ydl_options(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """yt-dlp options for resolving and downloading, ``extra`` on top."""
    return {
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


# ── backend ──────────────────────────────────────────────────────────────────


class RealBackend:
    name = "seed-vc"

    def __init__(self, store: Store) -> None:
        # No torch here: with SING_GPU_CHILD the main process builds this one too, for downloads
        # and the mix, and must not touch CUDA. The device is found when a GPU step first runs.
        self.store = store
        self._device: str | None = os.environ.get("SING_DEVICE") or None
        self.separator = os.environ.get("SING_SEPARATOR_MODEL", "htdemucs")
        self._separate_device: str | None = os.environ.get("SING_SEPARATE_DEVICE") or None
        self.steps = env_int("SING_DIFFUSION_STEPS", 30)
        self.cfg_rate = env_float("SING_CFG_RATE", 0.7)
        self.keep = os.environ.get("SING_KEEP_MODELS", "0") == "1"
        self.max_s = env_float("SING_MAX_SECONDS", 480)
        here = Path(__file__).resolve().parent
        self.seedvc_dir = Path(os.environ.get("SING_SEEDVC_DIR", here.parent / "models" / "seed-vc"))
        self.ref_paths = ref_paths(os.environ.get("SING_REF") or str(here.parent / "voices" / "deepseek-chan" / "ref.wav"))
        self.f0_clean = os.environ.get("SING_F0_CLEAN", "1") != "0"
        if not (self.seedvc_dir / "modules").exists():
            raise RuntimeError(f"Seed-VC not found at {self.seedvc_dir} (set SING_SEEDVC_DIR)")
        if not self.ref_paths:
            raise RuntimeError("reference voice not found (set SING_REF to a file, a list or a folder)")
        self.model_name = f"seed-vc-f0-44k+{self.separator}"
        self._vc: Any = None
        self._demucs: Any = None
        self._ref: Any = None
        self._ref_f0: float | None = None
        self.transposer = "rubberband" if ffmpeg_has_filter("rubberband") else "librosa"

    @property
    def device(self) -> str:
        if self._device is None:
            import torch

            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        return self._device

    @property
    def separate_device(self) -> str:
        return self._separate_device or self.device

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
            extra={"raw_title": raw_title},
        )

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

            def hook(d: dict[str, Any]) -> None:
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if d.get("status") == "downloading" and total:
                    progress(min(0.99, float(d.get("downloaded_bytes", 0)) / float(total)))

            with self._ydl({
                "outtmpl": str(Path(tmp) / "dl.%(ext)s"),
                "progress_hooks": [hook],
                "max_filesize": 200 * 1024 * 1024,
            }) as ydl:
                ydl.download([src.url])
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

    # ── separation (Demucs) ──────────────────────────────────────────────

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Progress) -> None:
        try:
            self._separate_on(self.separate_device, source_wav, vocals_out, inst_out)
        except Exception as e:
            if not is_oom(e) or self.separate_device == "cpu":
                raise
            log.warning("separation ran out of VRAM; retrying on the CPU")
            self._demucs = None
            free_cuda()
            self._separate_on("cpu", source_wav, vocals_out, inst_out)
        finally:
            if not self.keep:
                self._demucs = None
            free_cuda()
        progress(1.0)

    def _separate_on(self, device: str, source_wav: Path, vocals_out: Path, inst_out: Path) -> None:
        import torch
        from demucs.apply import apply_model
        from demucs.pretrained import get_model

        if self._demucs is None:
            self._demucs = get_model(self.separator)
            self._demucs.eval()
        model = self._demucs
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

    # ── conversion (Seed-VC singing model) ───────────────────────────────

    def _load_vc(self) -> Any:
        if self._vc is None:
            if str(self.seedvc_dir) not in sys.path:
                sys.path.insert(0, str(self.seedvc_dir))
            from seedvc_runtime import SeedVcSinger

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
                cancelled: Callable[[], bool]) -> None:
        try:
            vc = self._load_vc()
            x, sr = read_audio(vocals_wav)
            ref, rsr = self.reference()
            y = vc.convert(x.mean(axis=1), sr, ref, rsr, shift, self.steps, self.cfg_rate,
                           progress, cancelled, clean=self.f0_clean)
            y = vocal_gate(x.mean(axis=1), y)
            write_wav(out_wav, y, SR)
        finally:
            if not self.keep:
                self.unload()

    def unload(self) -> None:
        self._vc = None
        self._demucs = None
        free_cuda()

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


class GpuSteps:
    """``RealBackend``'s GPU stages with paths in: what the GPU child (gpu_child.py) runs."""

    def __init__(self, b: RealBackend) -> None:
        self.b = b

    def device(self) -> str:
        return self.b.device

    def peak_vram_mb(self) -> int | None:
        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_available():
            return round(torch.cuda.max_memory_allocated() / 2**20)
        return None

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Progress) -> None:
        self.b.separate(source_wav, vocals_out, inst_out, progress)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        x, sr = read_audio(path)
        return self.b.f0_stats(x.mean(axis=1), sr)

    def ref_f0(self) -> float | None:
        return self.b.ref_f0()

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Progress,
                cancelled: Callable[[], bool]) -> None:
        self.b.convert(vocals_wav, out_wav, shift, progress, cancelled)


def make_real_backend() -> RealBackend:
    """A ``RealBackend`` on the worker's song store (``SING_DATA_DIR`` / ``SING_LIBRARY_DIR``)."""
    root = Path(os.environ.get("SING_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data" / "songs"))
    lib = os.environ.get("SING_LIBRARY_DIR")
    return RealBackend(Store(root, Path(lib) if lib else None))


def make_gpu_steps() -> GpuSteps:
    """The GPU child's factory (``engine:make_gpu_steps``)."""
    return GpuSteps(make_real_backend())


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


def mix_song(vocals_src: Path, vocals_conv: Path, inst_wav: Path, key: int, out_dir: Path, backend: RealBackend,
             target_lufs: float) -> dict[str, Any]:
    """Writes mix.wav / vocals.wav / instrumental.wav / play_*.pcm; returns loudness info.

    The converted vocal gets the separated vocal's loudness back (Seed-VC output level varies),
    the sum is normalised to ``target_lufs`` and kept under -1 dBFS peak.
    """
    import numpy as np

    v_src, sr = read_audio(vocals_src)
    v, _ = read_audio(vocals_conv)
    inst, isr = read_audio(inst_wav)
    if isr != sr:
        raise JobError("stems have different sample rates")
    inst = backend.transpose(inst, sr, key)
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


def copy_if_missing(src: Path, dst: Path) -> None:
    if not dst.exists():
        shutil.copyfile(src, dst)


def now_ms() -> float:
    return time.perf_counter() * 1000
