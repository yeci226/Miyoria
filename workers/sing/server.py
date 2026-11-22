"""Miyoria song worker: song requests → AI covers in her voice (docs/protocols/voice-link.md, 「歌曲 Worker」).

    POST   /jobs                {query | url | path, title?, artist?, pitch?, key?, backing?, force?, exclusive_ack?,
                                 purpose?: cover | karaoke, karaoke_lyrics?, karaoke_video?} -> {"job"}
    POST   /jobs/{id}/exclusive -> {"job"}                 go ahead and take the GPU (see exclusive.py)
    POST   /gpu/context         {in_voice, listeners, live, urgent: [job id]} who would notice her
                                going quiet and which songs are needed now (Core, every poll; see gpu.py)
    GET    /jobs                -> {"jobs": [...]}         newest first
    GET    /jobs/{id}           -> {"job"}                 state, stage, progress, song when done
    DELETE /jobs/{id}           -> {"job"}                 cancels a queued or running job
    GET    /songs               -> {"songs": [meta...]}    cached covers, newest first
    GET    /songs/{id}          -> {"song": meta}
    POST   /songs/{id}/lyrics   {title?, artist?, fresh?} -> look the lyrics up again (no new audio)
    GET    /songs/{id}/files/{name}   mix.wav · vocals.wav · instrumental.wav · lyrics.lrc ·
                                      play_mix.pcm · play_vocals.pcm (s16le mono 48 kHz) · meta.json ·
                                      video.mp4 (library: video.<ext>) when ``has_video``
    GET    /karaoke             -> {"karaoke": [...]}      karaoke songs (job.karaoke + created_at), newest first
    GET    /karaoke/{id}/files/{name}   karaoke.m4a · reference.json (karaoke.py, packages/contracts karaoke.ts)
                                        · video.mp4 when the song has one (``video: true``; range requests)
                                        · play_karaoke.pcm · play_karaoke.k±N.pcm (s16le mono 48 kHz, audio/L16;
                                          decoded from the matching m4a on the first request; 404 for a key
                                          that was not made; range requests)
                                        · karaoke.k±N.m4a once made by:
    POST   /karaoke/{id}/keys   {semitones: -6..6} -> {file, semitones, cached, method}   the backing in
                                another key (Rubber Band), made once and kept with the song
    POST   /karaoke/voice       body: one recording of a singer's microphone (audio/webm · ogg · mp4 · wav,
                                <= 8 MiB, <= SING_MAX_SECONDS + 30 s) -> WorkersKaraokeVoicePitch {hz: 50,
                                midi, seconds, level_db, floor_db, device, method}: RMVPE treated as the
                                reference is (loudness gate, pitch.py cleaning, 50 Hz MIDI). Stored under
                                <data dir>/_voice only until answered (leftovers: 10 minutes at most),
                                never logged. On the card (stage ``reference`` of a job no list shows,
                                share only) when no job is running and it is placed within
                                SING_KARAOKE_VOICE_WAIT_S; a job that is about to start waits for it.
                                While a job runs: on the CPU at once, the job is never paused.
    POST   /karaoke/stream      WorkersKaraokeStreamRequest {room, chunks: [{stream, at, audio, end?}] (<= 8),
                                drop?} -> WorkersKaraokeStreamAnswer {hz: 50, streams: [{stream, from, midi,
                                final, seconds, level_db, floor_db}], lost, device, method}: the live voices
                                of a room's singers, about every 0.5 s (µ-law 16 kHz mono, base64; a chunk
                                <= 4 s, the body <= 1 MiB). In memory only (karaoke_stream.py): RMVPE on a
                                window around what is new, provisional 50 Hz frames from ``from``; a chunk
                                with ``end``: the whole curve as /karaoke/voice makes it (``final``), and
                                the stream is forgotten. Unknown streams (``at`` > 0), over
                                SING_KARAOKE_STREAMS_MAX, longer than SING_MAX_SECONDS + 30 s or ahead of
                                the clock: ``lost``. One placement a request, as /karaoke/voice but waiting
                                SING_KARAOKE_STREAM_WAIT_S at most; the tracker stays loaded while streams
                                are open. Never written to disk, never logged.
    GET    /library            -> {"entries": [...]}      the owner's local song folder
    GET    /cache               -> {bytes, songs, sources, limits, last}   the song cache (cache.py)
    POST   /cache/prune         {dry_run?} -> what the cleanup removed (or would remove)
    GET    /health

Pipeline per job (one job at a time; models load per stage and are freed after it):
    resolve   library match / yt-dlp search (``ytsearch1:``) / link (allowed hosts only), ≤ SING_MAX_SECONDS
    download  bestaudio → 44.1 kHz stereo WAV (ffmpeg)
    separate  vocals + instrumental: Kim's Mel-Band RoFormer (SING_SEPARATOR_MODEL=melband, the default
              when its checkpoint is there; the instrumental is the song minus the vocals) or a Demucs
              model (htdemucs, the fallback); only when the request needs them apart (``backing``
              ``drop`` / ``convert``) or the lead cannot come from the song itself; skipped for library
              folders that already have both stems, and for sources separated before
    lead      a karaoke RoFormer (leadsplit.py; SING_LEAD_MODEL, default becruily & Frazer's
              BS-RoFormer reading the whole song) takes the lead voice out; the rest of the vocal stem
              is the backing voices (harmonies, doubles, ad-libs). Stored beside the stems (lead.wav,
              backing.wav; cached with them, per model: stems.json; a song separated before it existed
              is split from its cached stems). Off with SING_LEAD_SPLIT=0 or without the model file (the
              stage is skipped and the next two work on the whole vocal stem, as before); a split that
              fails (not out of VRAM: that goes to the CPU) falls back to that as well, ``lead_split`` in
              the song's meta says which.
    convert   SING_VOICE, of the lead only: ``rvc`` (default) her own RVC model sings it in Applio's
              environment (rvcpass.py), moved by the shift below; or YingMusic-SVC (Seed-VC's architecture
              fine-tuned for singing) / the Seed-VC singing model (F0-conditioned, 44.1 kHz) with her
              reference voice, then (``+rvc``) her RVC model re-sings that (a failed pass keeps the
              converted vocal). With a clean lead RVC alone reads the words as well (2026-11-09). On a
              cleaned F0 contour (octave errors, spikes, dropouts: pitch.py); the pitch shift is
              ``pitch`` when given, else auto: the octave from the song's median and its top (95th
              percentile) against her range, and when the top is still over her ceiling the whole
              song goes down a few semitones (``auto_key``, SING_KEY_MIN..SING_KEY_MAX); plus
              ``key`` (whole-song transpose, which turns the auto key off)
    mix       converted vocal at the original lead's level + instrumental, and the backing voices by
              the request's ``backing`` (songs.BACKING_MODES, each a song of its own): ``keep``
              (default) as recorded, in the instrumental; ``drop``; ``convert``: converted like the
              lead (one more conversion), at their own level; ``acapella``: her lead alone, no
              instrumental. Without a lead split the backing stays in the converted vocal and only
              ``acapella`` changes anything (moved by the key with Rubber Band when ffmpeg has it), loudness-normalised to SING_TARGET_LUFS, peak ≤ -1 dBFS
    lyrics    (in parallel, from the lead on) synced LRC from lrclib.net / NetEase: title readings, the video
              metadata, a language model when those fail; checked against the audio (lyrics.py), the ASR
              spot check once the conversion is done and the speech workers are back
    video     (in parallel, from the download on) the link's video, video only, H.264 <= 1080p
              preferred, into video.mp4 for the stream to show while she sings; library entries
              use a video next to the audio. The song is ready once both are done; a video that
              fails or is still not there SING_VIDEO_WAIT_S after the audio leaves the song
              ready without one (``has_video: false``, ``video_error``). Songs cached before
              videos existed get theirs on the next request.

Karaoke (``purpose: "karaoke"``, docs/design/karaoke.md §3): resolve, download, separate and lead as
above (the same cached stems), then no conversion and no mix:
    reference RMVPE on the lead (the whole vocal stem without a split), gated by the lead's loudness,
              cleaned (pitch.py), 50 Hz MIDI, notes cut from the pitch alone, quality (melody.py)
    encode    the backing track: everything but the lead (instrumental + backing voices; the
              instrumental alone without a split), loudness-normalised, AAC 128 kbps 48 kHz stereo
    lyrics    the same lookup as a cover's, line times only
    lyrics_asr    Qwen3-ASR-1.7B checks every looked-up line against the lead, or transcribes the lead
              when there are none (or they are the wrong song); lyrics_align: a CTC aligner (w2v, or
              mms by the request's ``karaoke_lyrics``) times each character / mora of the lines that
              hold; their notes are cut one per unit (lyricstage.py, lyricsync.py). Both run in the
              align environment as a subprocess, one model per step, placed on the GPU like any stage
              (alignenv.py; without that environment the lines stay unchecked, as in step 1)
    video     (fetched from the download on, as a cover's: the same shared video.mp4 of the source;
              with ``karaoke_video``, default true, and SING_VIDEO on) waited for up to SING_VIDEO_WAIT_S,
              then the song's own video.mp4 (karaoke.make_video): no sound, H.264 yuv420p,
              <= SING_KARAOKE_VIDEO_HEIGHT and SING_KARAOKE_VIDEO_KBPS, +faststart, cut to the
              backing, on the backing's timeline (copied when it fits, else libx264). meta.json
              ``video`` says what was done (method, size, kbps, offset_s); a video that is missing or
              fails leaves the song ready without one (``video_error``). Songs made before have none.
into SING_DATA_DIR/_karaoke/k-<source key>/ (karaoke.py), never one of her songs. The job ends
``done`` with ``karaoke`` = {id, title, artist, duration_s, quality, video} also when the quality is not ok
(Core does not offer such a song); ``song_id`` stays null. A karaoke job is never urgent and never
takes her voice offline: where a cover would, it waits for room (gpu.py ``share_only``; with hostd,
``mode: share``).

GPU: every GPU stage is placed from the state of the machine, and placed again while it runs (see
gpu.py, which has the rules; the job's ``gpu`` field and /health say what was decided and why). It
shares the card with her voice and gives way while she speaks (``exclusive: shared``, yielding.py),
waits for room (stage ``gpu_wait``), moves to the CPU, or, as the last resort and for a bounded time,
has the TTS / ASR workers of SING_OFFLOAD_URLS drop their models (exclusive.py: stage ``exclusive``
and the job's ``exclusive`` field, waiting · offloading · active · reloading · done, tell Core).

A finished song is cached under SING_DATA_DIR/<song id>; asking again (same query, link or file,
the same pitch settings and backing mode) answers at once with ``cached: true``. The cache cleans
up after itself (cache.py): least recently used songs first, then the downloads no song needs, at
start, after every job and every hour; a song it removed is made again when it is asked for.

Environment
    SING_BACKEND           seed-vc | mock                         (default seed-vc)
    SING_DATA_DIR          cache root                             (default <repo>/data/songs)
    SING_LIBRARY_DIR       local songs                            (default <data dir>/library)
    SING_LIBRARY_FIRST     1 = a query that matches a library entry uses it (default 1)
    SING_CACHE_MAX_GB      songs + downloads kept, least recently used go first (default 6; 0 = no cap)
    SING_CACHE_MAX_DAYS    a song not used for this long goes      (default 14; 0 = no limit; both 0 = no cleanup)
    SING_CACHE_PROTECT_HOURS  used this recently: never removed    (default 6; nor the songs of queued / running jobs)
    SING_CACHE_EVERY_S     how often the cleanup runs besides at start and after every job (default 3600)
    SING_REF               her reference voice                    (default ../voices/deepseek-chan/ref.wav)
    SING_SEEDVC_DIR        Seed-VC checkout                       (default ../models/seed-vc)
    SING_DEVICE            cuda | cpu                             (default cuda when available)
    SING_SEPARATE_DEVICE   device of the separator                (default SING_DEVICE; VRAM OOM → CPU)
    SING_SEPARATOR_MODEL   melband | a Demucs model               (default melband when SING_VOCAL_MODEL is there,
                           else htdemucs; htdemucs_ft = better Demucs, 4x slower)
    SING_MODELS_DIR        the host's model folder (hostd sets it to <state>/models; `miyoria update` fills
                           vocal-split/ and lead-split/ there). Looked in first, then ../models (modelpaths.py)
    SING_VOCAL_MODEL       the vocal RoFormer's checkpoint (.ckpt; its .yaml beside it)
                           (default vocal-split/MelBandRoformer.ckpt of the model folders, KimberleyJSN/melbandroformer)
    SING_VOCAL_OVERLAP     chunk overlap of the vocal RoFormer, 8 s chunks (default 2)
    SING_LEAD_SPLIT        0 = no lead / backing split: the whole vocal stem is converted (default 1: on
                           when the model file is there)
    SING_LEAD_MODEL        the split's checkpoint (.ckpt; its .yaml beside it) (default
                           lead-split/becruily-bs/bs_roformer_karaoke_frazer_becruily.ckpt, else
                           lead-split/mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt, of the model folders)
    SING_LEAD_INPUT        mix | vocals: what the split reads    (default mix, the whole song)
    SING_LEAD_FP16         0 = the split in fp32 on CUDA          (default 1: fp16)
    SING_LEAD_DEVICE       device of the split                    (default SING_SEPARATE_DEVICE; VRAM OOM → CPU)
    SING_LEAD_OVERLAP      chunk overlap of the split, model-sized chunks (default 2; 2 on the CPU at most)
    SING_VOICE             rvc | ying+rvc | ying | seedvc+rvc | seedvc (default rvc; a missing part is left
                           out; cached songs made with another chain or lead split are made again)
    SING_YING_DIR          YingMusic-SVC checkout + ckpt/YingMusic-SVC-full.pt (default ../models/yingmusic-svc)
    SING_APPLIO_DIR / SING_RVC_MODEL / SING_RVC_INDEX / SING_RVC_PROTECT   the RVC pass (rvcpass.py)
    SING_RVC_SERVER        0 = a fresh Applio process for every RVC conversion (default 1: one process, rvcpass.py)
    SING_INFO_REUSE_S      the download and the video reuse the lookup's yt-dlp answer this long (default 3600)
    SING_DIFFUSION_STEPS   Seed-VC / YingMusic steps              (default 30)
    SING_CFG_RATE          Seed-VC inference cfg rate             (default 0.7)
    SING_TARGET_OFFSET     her singing median vs her speaking median, semitones (default 2)
    SING_MAX_NOTE          her ceiling: a note (A5) or Hz          (default: speech median + SING_CEILING_OFFSET)
    SING_CEILING_OFFSET    her ceiling above her speaking median, semitones (default 16)
    SING_KEY_MIN / MAX     range of the automatic whole-song key   (default -5 / 3; 0 / 0 = octave only)
    SING_F0_CLEAN          0 = convert on the raw RMVPE contour    (default 1)
    SING_TARGET_LUFS       loudness of the mix                    (default -16)
    SING_MAX_SECONDS       longest song                           (default 480)
    SING_URL_HOSTS         hosts links may point to               (default youtube.com, youtu.be, music.youtube.com,
                                                                   soundcloud.com, bilibili.com, nicovideo.jp)
    SING_JS_RUNTIMES       yt-dlp JavaScript runtimes for YouTube (default deno,node)
    SING_LYRICS            0 = no lrclib lookup                   (default 1)
    SING_KARAOKE_MIN_VOICED   a karaoke song's lead is voiced in this share of it at least, or its
                           quality is not ok (default 0.15, melody.MIN_VOICED_RATIO)
    SING_KARAOKE_MIN_NOTES the same for its notes                 (default 30, melody.MIN_NOTES)
    SING_KARAOKE_VIDEO_HEIGHT  tallest karaoke video              (default 720)
    SING_KARAOKE_VIDEO_KBPS    most kbps of a karaoke video       (default 1500)
    SING_KARAOKE_VOICE_WAIT_S  a singer's pitch not placed on the card this soon goes to the CPU (default 5)
    SING_KARAOKE_STREAM_WAIT_S the same for a room's live voices, every request (default 0.3)
    SING_KARAOKE_STREAM_IDLE_S a live stream nobody sends to for this long is forgotten (default 30)
    SING_KARAOKE_STREAMS_MAX   live streams open at once; a new one over it is ``lost`` (default 16)
    SING_KEEP_MODELS       1 = keep models in VRAM between jobs   (default 0)
    SING_VIDEO             0 = no videos                          (default 1)
    SING_VIDEO_MAX_HEIGHT  tallest video                          (default 1080)
    SING_VIDEO_MAX_MB      largest video                          (default 300)
    SING_VIDEO_WAIT_S      wait for the video after the audio     (default 120)
    SING_GPU_POLICY        auto | share | offload | wait           (default auto, see gpu.py)
    SING_GPU_SHARE         the older switch, used when SING_GPU_POLICY is not set: 1 = auto, 0 = offload
    SING_GPU_ARBITER       self | hostd: who takes the GPU decisions (default self; hostd: lease.py, the
                           worker asks hostd and never calls the speech workers; it does not start
                           without MIYORIA_HOSTD_URL and MIYORIA_SERVICE_TOKEN)
    SING_OFFLOAD_URLS      who can be asked to give up the GPU, comma separated (default none),
                           e.g. http://127.0.0.1:8002,http://127.0.0.1:8003
    SING_EXCLUSIVE_WAIT_S  wait this long for Core's go (exclusive_ack) (default 30)
    SING_SHARE_MIN_FREE_MB what a stage is assumed to need until it was measured here (default 4096)
    SING_GPU_HEADROOM_PCT  share of the card to keep free           (default 12; a spill raises it)
    SING_SPEECH_BURST_MB   what her voice takes while she speaks, kept free next to a stage that cannot
                           stop between steps (her RVC model) to share the card    (default 1024)
    SING_SHARE_WAIT_S      wait this long for room before taking speech offline, also with nobody
                           listening                                (default 0)
    SING_DEFER_S           people listening: wait this long before a short silence (default 120)
    SING_WAIT_MAX_S        longest wait for room in all; then windows (auto), or the job fails (default 600)
    SING_SILENCE_MAX_S     longest she is offline at a time while people listen, reload included (default 90)
    SING_SILENCE_GAP_S     back this long before the next window    (default 60)
    SING_OFFLOAD_LEASE_S   a window renews its offload; a worker that died leaves her voice
                           offline this long at most               (default 60)
    SING_SPILL_FACTOR      slower than normal by this much is a spill (default 5)
    SING_SPILL_STEP_S      a spill when the normal step is not known yet (default 2; with little free VRAM)
    SING_DIFFUSION_STEPS_MIN  steps left when spilling with nothing else to free (default 20)
    SING_GPU_CHECK_S       how often a running job looks at the card (default 1)
    SING_CONTEXT_TTL_S     no word from Core for this long: nobody knows who listens (default 20)
    SING_YIELD_URLS        workers to give way to, comma separated  (default SING_OFFLOAD_URLS)
    SING_YIELD_POLL_MS     how often they are asked                 (default 100)
    SING_YIELD_HOLD_MS     stay out of the way this long after they are idle (default 300)
    SING_YIELD_MAX_S       give way at most this much per song that is needed now (default 120)
    SING_YIELD_PATIENT_S   the same for a song nobody is waiting for (default 900)
    SING_RESOLVE_TIMEOUT_S give up finding a song after this long (default 60)
    SING_PREFETCH          0 = the next queued song is not looked up and downloaded while one is made (default 1)
    SING_YTDLP_CACHE       yt-dlp's cache folder                  (default <data dir>/_ytdlp-cache)
    SING_YTDLP_COOKIES     yt-dlp cookies file (Netscape format)  (default workers/sing/cookies.txt when it exists)
    SING_YTDLP_COOKIES_FROM_BROWSER  read a browser's cookies, e.g. firefox (default none)
    SING_RELOAD_TIMEOUT_S  longest wait for a worker to reload    (default 300)
    SING_MOCK_SECONDS      mock: song length                      (default 3)
    SING_MOCK_STAGE_MS     mock: delay per stage                  (default 0)
    SING_LYRICS_URL        lyrics service (workers/lyrics) that finds the lyrics, for a worker on another
                           machine than Core                       (default empty: look them up here)
    HOST / PORT            bind address                           (default 127.0.0.1 / 8005)
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import secrets
import sys
import threading
import time
import wave
from array import array
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, str(Path(__file__).resolve().parent.parent))  # contracts.py, shared by the workers

from cache import Cache, Janitor, Protected  # noqa: E402
# The JSON bodies, generated from the JSON Schema of packages/contracts (gen_contracts.py).
from contracts import WorkersSingGpuContext as GpuContext  # noqa: E402
from contracts import WorkersSingJobRequest as JobRequest  # noqa: E402
from contracts import WorkersSingLyricsRequest as LyricsRequest  # noqa: E402
from contracts import WorkersSingPruneRequest as PruneRequest  # noqa: E402
from contracts import WorkersKaraokeKeyRequest as KaraokeKeyRequest  # noqa: E402
from engine import Cancelled, ConvertWork, JobError, Suspended, allowed_url, env_float, env_int, is_oom  # noqa: E402
from exclusive import Exclusive, http_post, parse_urls  # noqa: E402
from gpu import CPU_FALLBACK, CPU_STAGES, Action, Audience, GpuJob, Limits, Machine, Profile  # noqa: E402
from karaoke import SERVED_FILES as KARAOKE_SERVED_FILES  # noqa: E402
from karaoke import VOICE_DIR, KaraokeStore, karaoke_id  # noqa: E402
from karaoke import summary as karaoke_summary  # noqa: E402
from lease import HostdArbitration, arbiter_from_env, hostd_available  # noqa: E402
from yielding import SpeechYield, http_get  # noqa: E402
from songs import (  # noqa: E402
    PLAY_RATE,
    SONG_FILES,
    Source,
    Store,
    find_video,
    link_or_copy,
    safe_id,
    short_hash,
    song_id,
)

try:
    import service_auth
except ImportError:  # never run open: with a token set, no check means no service
    if os.environ.get("MIYORIA_SERVICE_TOKEN") or os.environ.get("MIYORIA_HOST_TOKEN"):
        raise SystemExit("MIYORIA_SERVICE_TOKEN or MIYORIA_HOST_TOKEN is set but service_auth.py cannot be "
                         "imported: refusing to start without the token check")
    service_auth = None

log = logging.getLogger("miyoria.sing")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MAX_JOBS_KEPT = 100
# Share of the job's progress per stage, in the order the stages run (a stage that does not run for a
# job, such as ``convert_backing`` without the backing voices converted, is skipped: the bar goes on
# from the next one). The shares add up to 1; the stages that wait or hand over (``queued``,
# ``exclusive``, ``gpu_wait``) and the ones too short to count (``beats``) have none. ``_set`` never
# lets the progress go back, so a stage that comes again (a separation after the lead split) waits.
WEIGHTS = {"resolve": 0.04, "download": 0.10, "separate": 0.22, "lead": 0.07, "convert": 0.33, "convert_backing": 0.08,
           "mix": 0.06, "beats": 0.02, "lyrics": 0.03, "video": 0.05}
# The same for a karaoke job (no conversion, no mix).
KARAOKE_WEIGHTS = {"resolve": 0.05, "download": 0.16, "separate": 0.32, "lead": 0.11, "reference": 0.08, "encode": 0.05,
                   "lyrics": 0.03, "lyrics_asr": 0.14, "lyrics_align": 0.06, "video": 0.0}
# Sources whose link has a video to fetch (a library entry brings its own file).
VIDEO_KINDS = ("youtube", "url", "mock")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ── mock backend (pure Python: CI and Core tests) ────────────────────────────


def _tone(seconds: float, rate: int, freq: float, amp: float = 0.25) -> array:
    n = int(seconds * rate)
    return array("h", (int(32767 * amp * math.sin(2 * math.pi * freq * i / rate)) for i in range(n)))


def _write_wav(p: Path, samples: array, rate: int) -> None:
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())


class MockBackend:
    """Sine waves instead of songs: same files, same metadata, no GPU, no network."""

    name = "mock"
    device = "cpu"
    model_name = "mock"

    def __init__(self, store: Store) -> None:
        self.store = store
        self.seconds = env_float("SING_MOCK_SECONDS", 3.0)
        self.delay = env_int("SING_MOCK_STAGE_MS", 0) / 1000
        self.gate: Callable[[], None] | None = None
        self.step_s: Callable[[], float] | None = None  # how long a step takes (tests: a simulated card)
        self.separate_devices: list[str | None] = []
        self.lead_devices: list[str | None] = []
        self.convert_inputs: list[str] = []  # which stem each conversion read
        self.f0_inputs: list[str] = []
        self.mix_inputs: list[tuple[bool, list[str]]] = []  # (split, the files in the stem folder)
        self.mix_backing: list[str] = []
        self.lead_sources: list[str | None] = []
        self.trims = 0
        self.lyrics_calls: list[float | None] = []  # the duration each lookup was given
        self.lyrics_gate: Callable[[], None] | None = None  # tests: holds the lookup
        self.lyrics_after_asr_wait: list[bool] = []  # whether the conversion was over by then
        self.idles: list[bool] = []  # each ``idle(more)``
        self.idle_hook: Callable[[bool], None] | None = None  # tests: runs in ``idle``
        self.karaoke_f0_inputs: list[tuple[str, str | None]] = []  # (file, device) of each karaoke pitch track
        self.karaoke_stream_inputs: list[tuple[int, str | None]] = []  # (samples, device) of each stream window
        self.stream_loaded = False  # the stream's pitch tracker is "loaded"
        self.stream_loads = 0
        self.stream_releases = 0
        self.karaoke_parts: list[list[str]] = []  # what each karaoke backing was made of
        self.lyrics_steps: list[tuple[str, str]] = []  # (step, device) of each karaoke lyrics step
        self.karaoke_shifts: list[int] = []
        self.karaoke_videos: list[str] = []  # the source video of each karaoke video made

    def _wait(self) -> None:
        if self.delay:
            time.sleep(self.delay)

    def resolve_search(self, query: str) -> Source:
        self._wait()
        if query.strip().lower() == "fail":
            raise JobError("no search result for 'fail'")
        return Source(key=f"mock-{short_hash(query, 10)}", kind="mock", title=query.strip(), artist="Mock Artist",
                      duration_s=self.seconds, url=f"https://www.youtube.com/watch?v=mock{short_hash(query, 6)}")

    def resolve_url(self, url: str) -> Source:
        if not allowed_url(url):
            raise JobError("that link is not on an allowed host (SING_URL_HOSTS)")
        return Source(key=f"mock-{short_hash(url, 10)}", kind="url", title="Mock Link", artist=None,
                      duration_s=self.seconds, url=url)

    def fetch(self, src: Source, dest: Path, progress: Callable[[float], None]) -> None:
        self._wait()
        _write_wav(dest, _tone(self.seconds, 16_000, 330), 16_000)

    def fetch_video(self, src: Source, dest: Path, progress: Callable[[float], None],
                    cancelled: Callable[[], bool]) -> dict[str, Any]:
        """A few bytes named video.mp4; titles with "novideo" have none (like a SoundCloud link)."""
        self._wait()
        if cancelled():
            raise Cancelled()
        if "novideo" in src.title.lower():
            raise JobError("no video: Requested format is not available")
        dest.write_bytes(b"\x00\x00\x00\x18ftypmp42mock video")
        progress(1.0)
        return {"width": 1920, "height": 1080, "vcodec": "avc1.mock", "fps": 30, "format_id": "mock"}

    def library_video(self, v: Path, sdir: Path) -> dict[str, Any]:
        link_or_copy(v, sdir / f"video{v.suffix.lower()}")
        return {"source": "library", "bytes": v.stat().st_size}

    def free_vram_mb(self) -> int | None:
        raw = os.environ.get("SING_MOCK_FREE_MB")
        return int(raw) if raw else None

    def uses_cuda(self) -> bool:
        return bool(os.environ.get("SING_MOCK_FREE_MB")) or os.environ.get("SING_MOCK_DEVICE") == "cuda"

    def gpu_name(self) -> str:
        return "Mock GPU"

    def vram(self, peek: bool = False) -> tuple[int, int] | None:
        free = self.free_vram_mb()
        return None if free is None else (free, env_int("SING_MOCK_TOTAL_MB", free))

    def own_vram_mb(self) -> int:
        return 0

    def trim(self) -> None:
        self.trims += 1

    def idle(self, more: bool = False) -> None:
        self.idles.append(more)
        if self.idle_hook is not None:
            self.idle_hook(more)

    def fetch_library(self, src: Source, sdir: Path) -> None:
        self.fetch(src, sdir / "source.wav", lambda _: None)

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Callable[[float], None],
                 device: str | None = None) -> None:
        self._wait()
        self.separate_devices.append(device)
        for _ in range(env_int("SING_MOCK_SEGMENTS", 0)):
            self._step()
        _write_wav(vocals_out, _tone(self.seconds, 16_000, 440), 16_000)
        _write_wav(inst_out, _tone(self.seconds, 16_000, 220, 0.1), 16_000)

    def lead_available(self) -> bool:
        return os.environ.get("SING_LEAD_SPLIT", "1") != "0" and os.environ.get("SING_MOCK_LEAD_MODEL", "1") != "0"

    def split_lead(self, vocals_wav: Path, lead_out: Path, backing_out: Path, progress: Callable[[float], None],
                   device: str | None = None, source_wav: Path | None = None,
                   rest_out: Path | None = None) -> None:
        self._wait()
        self.lead_devices.append(device)
        self.lead_sources.append(source_wav.name if source_wav is not None else None)
        if os.environ.get("SING_MOCK_LEAD_FAIL") == "1":
            raise RuntimeError("mock lead split failed")
        for _ in range(env_int("SING_MOCK_SEGMENTS", 0)):
            self._step()
        _write_wav(lead_out, _tone(self.seconds, 16_000, 440, 0.2), 16_000)
        self.complete_stems(lead_out.parent)
        progress(1.0)

    def complete_stems(self, sdir: Path) -> None:
        if (sdir / "vocals.wav").exists() and not (sdir / "backing.wav").exists():
            _write_wav(sdir / "backing.wav", _tone(self.seconds, 16_000, 330, 0.1), 16_000)
        if (sdir / "source.wav").exists() and not (sdir / "rest.wav").exists():
            _write_wav(sdir / "rest.wav", _tone(self.seconds, 16_000, 220, 0.1), 16_000)

    def lead_reads_mix(self) -> bool:
        return True

    def median_f0(self, path: Path) -> float | None:
        return env_float("SING_MOCK_F0_HZ", 440.0)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        self.f0_inputs.append(path.name)
        return env_float("SING_MOCK_F0_HZ", 440.0), env_float("SING_MOCK_F0_TOP_HZ", 440.0)

    def ref_f0(self) -> float | None:
        return 440.0

    def _step(self) -> None:
        if self.gate is not None:
            self.gate()
        if self.step_s is not None:
            time.sleep(self.step_s())

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Callable[[float], None],
                cancelled: Callable[[], bool], work: ConvertWork | None = None) -> None:
        self.convert_inputs.append(vocals_wav.name)
        if os.environ.get("SING_MOCK_CONVERT_FAIL") == "1":
            raise JobError("mock conversion failed")
        job = state.jobs.get(state.running or "")
        window = job is not None and job.exclusive is not None and job.exclusive.state == "active"
        if os.environ.get("SING_MOCK_CONVERT_OOM") == "1" and not window:
            raise RuntimeError("CUDA out of memory (mock)")
        work = work if work is not None else ConvertWork()
        steps = env_int("SING_MOCK_STEPS", 4)
        for i in range(work.done, steps):
            self._step()
            if cancelled():
                raise Cancelled()
            self._wait()
            work.done = i + 1
            work.chunks.append(work.steps or 30)
            progress((i + 1) / steps)
        _write_wav(out_wav, _tone(self.seconds, 16_000, 440 * 2 ** (shift / 12)), 16_000)

    def mix(self, sdir: Path, converted: Path, key: int, out: Path, split: bool = False,
            backing: str = "keep", backing_conv: Path | None = None) -> dict[str, Any]:
        self._wait()
        self.mix_inputs.append((split, sorted(p.name for p in sdir.glob("*.wav"))))
        self.mix_backing.append(backing if backing_conv is None or backing_conv.exists() else "convert:missing")
        mix = _tone(self.seconds, PLAY_RATE, 440)
        vocals = _tone(self.seconds, PLAY_RATE, 440, 0.2)
        _write_wav(out / "mix.wav", mix, PLAY_RATE)
        _write_wav(out / "vocals.wav", vocals, PLAY_RATE)
        _write_wav(out / "instrumental.wav", _tone(self.seconds, PLAY_RATE, 220, 0.1), PLAY_RATE)
        (out / "play_mix.pcm").write_bytes(mix.tobytes())
        (out / "play_vocals.pcm").write_bytes(vocals.tobytes())
        return {"vocal_gain": 1.0, "lufs": -16.0, "samples": len(mix), "duration_s": round(len(mix) / PLAY_RATE, 2)}

    def lyrics(self, src: Source, duration: float | None, audio: Path | None = None,
               fresh: bool = False, asr_wait: Callable[[], None] | None = None) -> dict[str, Any] | None:
        if os.environ.get("SING_LYRICS", "1") == "0":
            return None
        self.lyrics_calls.append(duration)
        if self.lyrics_gate is not None:
            self.lyrics_gate()
        if asr_wait is not None and os.environ.get("SING_MOCK_LYRICS_ASR") == "1":
            asr_wait()
            job = state.jobs.get(state.running or "")
            self.lyrics_after_asr_wait.append(bool(job is not None and job.converted.is_set()))
        lines = [f"[00:{i:02d}.00]mock line {i + 1}" for i in range(max(1, int(self.seconds)))]
        return {"provider": "mock", "synced": True, "lrc": "\n".join(lines), "plain": None,
                "track": src.title, "artist": src.artist, "how": "mock", "confidence": 1.0}

    def lyrics_hints(self, url: str) -> dict[str, Any]:
        return {}

    def karaoke_f0(self, wav: Path, device: str | None = None):
        """RMVPE's answer for a tune: a C major scale going up and down, 0.3 s a note with 60 ms
        between them (10 ms frames, Hz, 0 unvoiced), as long as ``wav``."""
        import numpy as np

        self._wait()
        self.karaoke_f0_inputs.append((wav.name, device))
        frames = int((_wav_seconds(wav) or self.seconds) * 100) + 1
        scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62]
        f0 = np.zeros(frames)
        for i in range(frames):
            k, at = divmod(i, 36)
            if at < 30:
                f0[i] = 440.0 * 2 ** ((scale[k % len(scale)] - 69) / 12)
        return f0

    def karaoke_f0_audio(self, x, sr: int, device: str | None = None):
        """A stream's pitch tracker (``POST /karaoke/stream``), local and exact in the samples: frame
        ``i`` (centred on sample ``i * hop``, ``len(x) // hop + 1`` of them, zeros past the edges)
        reads only the 40 ms around it, so a window of a signal answers what the whole signal does
        for every frame 20 ms or more inside it. The frequency comes from the zero crossings
        (interpolated) of those 40 ms; 0 when they are quieter than -60 dBFS."""
        import numpy as np

        x = np.asarray(x, dtype=np.float64).reshape(-1)
        self.karaoke_stream_inputs.append((int(x.size), device))
        if not self.stream_loaded:
            self.stream_loaded = True
            self.stream_loads += 1
        hop = sr // 100
        half = 2 * hop
        frames = x.size // hop + 1
        pad = np.concatenate((np.zeros(half), x, np.zeros(half + hop)))
        # Energy: squares of int16 / 32768 summed 640 at a time are exact in float64, in any order.
        sq = pad * pad
        energy = np.lib.stride_tricks.sliding_window_view(sq, 2 * half)[::hop][:frames].sum(axis=1)
        sign = pad >= 0
        cross = np.flatnonzero(sign[1:] != sign[:-1])  # between sample j and j + 1
        frac = pad[cross] / (pad[cross] - pad[cross + 1])
        starts = np.arange(frames) * hop  # frame i reads padded samples [starts, starts + 2 * half)
        lo = np.searchsorted(cross, starts, side="left")
        hi = np.searchsorted(cross, starts + 2 * half - 1, side="left")
        count = hi - lo
        f0 = np.zeros(frames)
        ok = (count >= 2) & (energy / (2 * half) > 1e-6)
        first, last = lo[ok], hi[ok] - 1
        # Integer distance plus the fractions: the same floats wherever the window starts.
        span = (cross[last] - cross[first]).astype(np.float64) + (frac[last] - frac[first])
        hz = (count[ok] - 1) * sr / (2.0 * np.maximum(span, 1e-9))
        f0[ok] = np.where((hz >= 50.0) & (hz <= 1100.0), hz, 0.0)
        return f0

    def karaoke_stream_release(self) -> None:
        self.stream_loaded = False
        self.stream_releases += 1

    def karaoke_encode(self, parts: list[Path], out: Path) -> dict[str, Any]:
        """The real encoder when ffmpeg is there (the parts are tiny), else a few bytes of MP4 header."""
        import shutil

        import karaoke

        self._wait()
        self.karaoke_parts.append([p.name for p in parts])
        if shutil.which("ffmpeg") is not None:
            return karaoke.encode_backing(parts, out, env_float("SING_TARGET_LUFS", -16.0))
        out.write_bytes(b"\x00\x00\x00\x18ftypM4A mock karaoke")
        return {"duration_s": round(_wav_seconds(parts[0]) or self.seconds, 2), "mock": True}

    def karaoke_lyrics_step(self, step: str, payload: dict[str, Any], device: str) -> dict[str, Any]:
        """align/run.py's answers without models: every looked-up line heard as written (one that
        contains ``wrong`` heard as nothing), the units of a line spread over the voiced frames of
        its window. ``SING_MOCK_ALIGN=0``: as if the align environment were missing."""
        import lyricsync
        from readings import Lang, detect

        self.lyrics_steps.append((step, device))
        if step == "asr":
            lines = payload.get("lines") or []
            heard = [{"heard": "" if "wrong" in x["text"] else x["text"],
                      "similarity": 0.0 if "wrong" in x["text"] else 1.0} for x in lines]
            for h in heard:
                h["status"] = lyricsync.line_status(h["similarity"])
            verdict = lyricsync.song_verdict([h["status"] for h in heard])
            chunks = None
            if not lines or verdict == "wrong_song":
                chunks = [{"a": 0.0, "b": self.seconds, "heard": "la la la"}]
            return {"language": payload.get("language") or "en", "lines": heard, "verdict": verdict, "chunks": chunks}
        lang = Lang(payload.get("language") or detect("".join(s["text"] for s in payload["segments"])) or "en")
        out = []
        for seg in payload["segments"]:
            pieces = lang.pieces(seg["text"])
            units = [u for p in pieces for u in p.say]
            a, b = float(seg["a"]) + 0.5, float(seg["b"]) - 0.3  # the line itself, not its window
            step_s = (b - a) / max(1, len(units))
            entry = []
            k = 0
            for p in pieces:
                times = None
                if seg.get("align"):
                    times = [[round(a + (k + j) * step_s, 3), round(a + (k + j + 1) * step_s, 3)] for j in range(len(p.say))]
                k += len(p.say)
                entry.append({"text": p.text, "reading": p.reading, "roman": p.roman, "say": p.say, "units": times})
            out.append({"pieces": entry, "error": None})
        return {"language": lang.language, "segments": out}

    def karaoke_shift(self, src: Path, out: Path, semitones: int) -> str:
        """The real key change when ffmpeg can read the backing, else a copy."""
        import shutil

        import karaoke

        self.karaoke_shifts.append(semitones)
        if shutil.which("ffmpeg") is not None and src.read_bytes()[4:8] == b"ftyp" and b"mock karaoke" not in src.read_bytes():
            return karaoke.shift_backing(src, out, semitones)
        shutil.copyfile(src, out)
        return "mock"

    def karaoke_video(self, src: Path, out: Path, duration_s: float,
                      cancelled: Callable[[], bool] | None = None) -> dict[str, Any]:
        """A few bytes for the mock's own video (``fetch_video``), else the real conversion (which
        fails on what ffmpeg cannot read). ``SING_MOCK_VIDEO_FAIL=1``: the conversion fails."""
        import karaoke

        self.karaoke_videos.append(src.name)
        if os.environ.get("SING_MOCK_VIDEO_FAIL") == "1":
            raise JobError("mock video conversion failed")
        if b"mock video" in src.read_bytes()[:64]:
            out.write_bytes(b"\x00\x00\x00\x18ftypisommock karaoke video")
            return {"file": karaoke.VIDEO_FILE, "method": "mock", "width": 1280, "height": 720, "kbps": 1,
                    "duration_s": round(duration_s, 2), "offset_s": 0.0, "start_s": 0.0,
                    "bytes": out.stat().st_size, "source": {"codec": "mock"}}
        return karaoke.make_video(src, out, duration_s,
                                  max_height=env_int("SING_KARAOKE_VIDEO_HEIGHT", karaoke.VIDEO_MAX_HEIGHT),
                                  max_kbps=env_int("SING_KARAOKE_VIDEO_KBPS", karaoke.VIDEO_MAX_KBPS),
                                  cancelled=cancelled)

    def unload(self) -> None:
        return None


def make_backend(store: Store) -> Any:
    name = os.environ.get("SING_BACKEND", "seed-vc").lower()
    if name == "mock":
        return MockBackend(store)
    if name in ("seed-vc", "seedvc", "real"):
        from engine import MELBAND, RealBackend

        real = RealBackend(store)
        # Demucs' separation is only a little slower on the CPU: it goes there when the card is full.
        if real.separator != MELBAND and "SING_CPU_FALLBACK" not in os.environ:
            CPU_FALLBACK.add("separate")
        return _RealAdapter(real)
    raise RuntimeError(f"unknown SING_BACKEND={name!r} (expected seed-vc | mock)")


class _RealAdapter:
    """Gives ``RealBackend`` the same method shapes as the mock (paths in, files out)."""

    def __init__(self, b: Any) -> None:
        self.b = b
        self.name = b.name
        self.device = b.device
        self.model_name = b.model_name

    @property
    def gate(self) -> Callable[[], None] | None:
        return self.b.gate

    @gate.setter
    def gate(self, value: Callable[[], None] | None) -> None:
        self.b.gate = value

    def __getattr__(self, item: str) -> Any:
        return getattr(self.b, item)

    def median_f0(self, path: Path) -> float | None:
        from engine import read_audio

        x, sr = read_audio(path)
        return self.b.median_f0(x.mean(axis=1), sr)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        from engine import read_audio

        x, sr = read_audio(path)
        return self.b.f0_stats(x.mean(axis=1), sr)

    @staticmethod
    def _under(sdir: Path, split: bool, backing: str) -> tuple[Path, Path | None, bool]:
        """(instrumental file, kept backing voices to add to it, whether there is an instrumental)."""
        # Kept backing (or none at all): everything but the lead in one, when the split left it.
        rest = sdir / "rest.wav"
        use_rest = split and backing in ("keep", "acapella") and rest.exists()
        return (rest if use_rest else sdir / "instrumental.wav",
                sdir / "backing.wav" if split and backing == "keep" and not use_rest else None,
                backing != "acapella")

    def prepare_mix(self, sdir: Path, key: int, split: bool, backing: str) -> None:
        """Starts what the mix puts under her voice (engine.instrumental_for_mix: with a key change,
        Rubber Band's seconds) on its own thread, while the lead is converted."""
        from concurrent.futures import ThreadPoolExecutor

        from engine import instrumental_for_mix

        inst, backing_wav, instrumental = self._under(sdir, split, backing)
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sing-mixprep")
        self._prepared = ((str(sdir), key, split, backing),
                          pool.submit(instrumental_for_mix, inst, key, self.b, backing_wav, instrumental))
        pool.shutdown(wait=False)

    def _take_prepared(self, sdir: Path, key: int, split: bool, backing: str) -> tuple[Any, int] | None:
        prepared, self._prepared = getattr(self, "_prepared", None), None
        if prepared is None or prepared[0] != (str(sdir), key, split, backing):
            return None
        try:
            return prepared[1].result()
        except Exception as e:  # noqa: BLE001 - the mix does it again and says what is wrong
            log.warning("preparing the instrumental failed: %s", e)
            return None

    def idle(self, more: bool = False) -> None:
        self._prepared = None
        self.b.idle(more)

    def mix(self, sdir: Path, converted: Path, key: int, out: Path, split: bool = False,
            backing: str = "keep", backing_conv: Path | None = None) -> dict[str, Any]:
        """``split``: the lead was converted, the backing voices are beside it; ``backing`` says
        what becomes of them (songs.BACKING_MODES; ``backing_conv`` is the converted backing)."""
        from engine import mix_song

        inst, backing_wav, instrumental = self._under(sdir, split, backing)
        return mix_song(sdir / ("lead.wav" if split else "vocals.wav"), converted, inst, key, out,
                        self.b, env_float("SING_TARGET_LUFS", -16.0),
                        backing_wav=backing_wav,
                        backing_conv=backing_conv if split and backing == "convert" else None,
                        backing_src=sdir / "backing.wav" if split and backing == "convert" else None,
                        instrumental=instrumental,
                        prepared=self._take_prepared(sdir, key, split, backing))

    def lyrics(self, src: Source, duration: float | None, audio: Path | None = None,
               fresh: bool = False, asr_wait: Callable[[], None] | None = None) -> dict[str, Any] | None:
        """Lyrics for the song (lyrics.py: title readings, lrclib / NetEase, the language model, the checks).
        ``asr_wait``: the lookup runs next to the conversion; the ASR spot check waits for it (a lyrics
        service on another machine has its own ASR and does not wait)."""
        if os.environ.get("SING_LYRICS", "1") == "0":
            return None
        from lyrics import hints_of, search
        from lyrics_remote import remote_url, search_remote

        url = remote_url()  # the lyrics service next to Core's language model and ASR (workers/lyrics)
        if url:
            return search_remote(url, hints_of(src), duration, audio, fresh)
        return search(hints_of(src), duration, cache_dir=self.b.store.root / "_lyrics", audio=audio, fresh=fresh,
                      asr_wait=asr_wait)

    def lyrics_hints(self, url: str) -> dict[str, Any]:
        return self.b.fetch_hints(url)

    def karaoke_encode(self, parts: list[Path], out: Path) -> dict[str, Any]:
        import karaoke

        return karaoke.encode_backing(parts, out, env_float("SING_TARGET_LUFS", -16.0))

    def karaoke_shift(self, src: Path, out: Path, semitones: int) -> str:
        import karaoke

        return karaoke.shift_backing(src, out, semitones)

    def karaoke_video(self, src: Path, out: Path, duration_s: float,
                      cancelled: Callable[[], bool] | None = None) -> dict[str, Any]:
        import karaoke

        return karaoke.make_video(src, out, duration_s,
                                  max_height=env_int("SING_KARAOKE_VIDEO_HEIGHT", karaoke.VIDEO_MAX_HEIGHT),
                                  max_kbps=env_int("SING_KARAOKE_VIDEO_KBPS", karaoke.VIDEO_MAX_KBPS),
                                  cancelled=cancelled)


# ── jobs ─────────────────────────────────────────────────────────────────────


@dataclass
class Job:
    id: str
    request: JobRequest
    state: str = "queued"  # queued | running | done | failed | cancelled
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    song_id: str | None = None
    source: dict[str, Any] | None = None
    cached: bool = False
    created_at: str = field(default_factory=now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    video: "VideoFetch | None" = None
    exclusive: Exclusive | None = None
    go: threading.Event = field(default_factory=threading.Event)
    yielding: SpeechYield | None = None  # gives way to her voice
    gpu: GpuJob | None = None  # where the job runs and why (gpu.py)
    converted: threading.Event = field(default_factory=threading.Event)  # no more GPU work: ASR may be asked
    # Looked up (and downloaded) while the job before it ran: None | running | done | failed (prefetch_loop).
    prefetch: str | None = None
    prefetched: Source | None = None
    prefetch_done: threading.Event = field(default_factory=threading.Event)
    aborted: bool = False  # failed or cancelled: its lyrics lookup asks the ASR worker nothing more
    karaoke_id: str | None = None  # a karaoke job's song among the karaoke songs, once resolved
    karaoke: dict[str, Any] | None = None  # ``job.karaoke`` once done (karaoke.summary)

    @property
    def is_karaoke(self) -> bool:
        return self.request.purpose == "karaoke"

    def public(self, store: Store, position: int | None) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "state": self.state,
            "stage": self.stage,
            "progress": round(self.progress, 3),
            "error": self.error,
            "song_id": self.song_id,
            "source": self.source,
            "cached": self.cached,
            "request": self.request.model_dump(exclude_none=True),
            "position": position,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "song": None,
            "video": self.video.public() if self.video else None,
            "exclusive": self.exclusive.state if self.exclusive else None,
            "exclusive_info": self.exclusive.public() if self.exclusive else None,
            "yielded": self.yielding.public() if self.yielding else None,
            "gpu": self.gpu.public() if self.gpu else None,
            "karaoke": self.karaoke if self.state == "done" else None,
        }
        if self.state == "done" and self.song_id:
            d["song"] = store.meta(self.song_id)
        return d


class State:
    store: Store
    karaoke: KaraokeStore
    backend: Any = None
    jobs: dict[str, Job]
    order: list[str]
    pending: "queue.Queue[str]"
    lock: threading.Lock
    running: str | None = None
    thread: threading.Thread | None = None
    stopping: threading.Event
    machine: Machine
    cache: Cache
    janitor: Janitor | None = None
    arbitration: Any = None  # SelfArbitration or lease.HostdArbitration (SING_GPU_ARBITER)
    # Held by the job loop around every job and by a singer's pitch on the card (POST /karaoke/voice).
    voice_lock: threading.Lock = threading.Lock()
    voice_dir: Path | None = None  # where a singer's recording waits for its pitch (karaoke.VOICE_DIR)
    streams: Any = None  # karaoke_stream.Streams: the live voices of the rooms (POST /karaoke/stream)
    offload_post = staticmethod(http_post)  # replaced in tests
    busy_get = staticmethod(http_get)  # replaced in tests


state = State()


def _position(job_id: str) -> int | None:
    with state.lock:
        waiting = [j for j in state.order if state.jobs[j].state == "queued"]
    return waiting.index(job_id) if job_id in waiting else None


def _public(job: Job) -> dict[str, Any]:
    return job.public(state.store, _position(job.id))


def _set(job: Job, stage: str, within: float = 0.0) -> None:
    """The job is in ``stage``, ``within`` (0..1) of the way through it. The progress only moves forward."""
    before = 0.0
    for name, w in (KARAOKE_WEIGHTS if job.is_karaoke else WEIGHTS).items():
        if name == stage:
            job.progress = max(job.progress, min(0.999, before + w * max(0.0, min(1.0, within))))
            break
        before += w
    job.stage = stage


def _bounded(fn: Callable[[], Any], cancelled: Callable[[], bool], limit_s: float) -> Any:
    """Runs a step that waits on the network on its own thread, so a lookup that never returns
    fails this job (or is cancelled) instead of holding the queue: jobs run one at a time, and
    yt-dlp's socket timeout does not cover every way it can hang. The thread is left behind."""
    done = threading.Event()
    out: dict[str, Any] = {}

    def run() -> None:
        try:
            out["value"] = fn()
        except BaseException as e:  # noqa: BLE001
            out["error"] = e
        finally:
            done.set()

    threading.Thread(target=run, name="sing-bounded", daemon=True).start()
    deadline = time.monotonic() + limit_s
    while not done.wait(0.1):
        if cancelled():
            raise Cancelled()
        if time.monotonic() >= deadline:
            raise JobError(f"finding the song took longer than {limit_s:.0f} s")
    if "error" in out:
        raise out["error"]
    return out["value"]


def _source_from_request(job: Job) -> Source:
    req, store, b = job.request, state.store, state.backend
    if req.path:
        rel = req.path.strip().replace("\\", "/")
        try:
            p = store.library_path(rel)
        except ValueError as e:
            raise JobError(str(e)) from e
        entry = next((e for e in store.library_entries() if e["path"] == rel), None)
        if entry is None:
            raise JobError(f"not a song in the library: {rel}")
        return Source(key=f"lib-{short_hash(str(p))}", kind="library", title=entry["title"],
                      artist=entry.get("artist"), path=rel, split=bool(entry["split"]))
    if req.url:
        return b.resolve_url(req.url.strip())
    q = (req.query or "").strip()
    known = store.query_source(q)
    if known and not req.force:
        info = store.source_info(known)
        if info:
            return Source(**info)
    if os.environ.get("SING_LIBRARY_FIRST", "1") != "0":
        entry = store.match_library(q)
        if entry:
            p = store.library_path(entry["path"])
            return Source(key=f"lib-{short_hash(str(p))}", kind="library", title=entry["title"],
                          artist=entry.get("artist"), path=entry["path"], split=bool(entry["split"]))
    src = b.resolve_search(q)
    store.remember_query(q, src.key)
    return src


def _auto_shift(vocals: Path, auto_key: bool) -> tuple[int, int, dict[str, Any]]:
    """(octave −12 / 0 / +12 for her voice, whole-song key, info): the octave whose median lands
    closest to her singing median without the song's top going over her ceiling, and with
    ``auto_key`` a transposition down (or a little up) when the top is still out of her range."""
    b = state.backend
    return _shift_from(b.f0_stats(vocals), b.ref_f0(), auto_key)


def _shift_from(stats: tuple[float, float] | None, ref_hz: float | None,
                auto_key: bool) -> tuple[int, int, dict[str, Any]]:
    """``_auto_shift`` from the vocal's (median, top) F0 and her reference's median."""
    from pitch import choose_key, parse_note

    info: dict[str, Any] = {"ref_median_hz": ref_hz}
    if stats is None or not ref_hz:
        return 0, 0, info
    med, top = stats
    info.update({"source_median_hz": round(med, 1), "source_top_hz": round(top, 1)})
    lo, hi = (env_int("SING_KEY_MIN", -5), env_int("SING_KEY_MAX", 3)) if auto_key else (0, 0)
    chosen = choose_key(med, top, ref_hz, target_offset=env_float("SING_TARGET_OFFSET", 2.0),
                        ceiling=parse_note(os.environ.get("SING_MAX_NOTE", "")),
                        ceiling_offset=env_float("SING_CEILING_OFFSET", 16.0), key_min=min(lo, 0), key_max=max(hi, 0))
    info.update(chosen)
    return chosen["octave_shift"], chosen["auto_key"], info


def _peak_vram_reset() -> None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()


def _peak_vram_mb() -> int | None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        return round(torch.cuda.max_memory_allocated() / 2**20)
    return None


def _video_on() -> bool:
    return os.environ.get("SING_VIDEO", "1") != "0"


def _other_voice(meta: dict[str, Any], backend: Any) -> bool:
    """A cached song made with another voice chain (SING_VOICE) than the worker's now: it is made
    again (from the cached stems). Songs from before the chain was recorded were Seed-VC alone."""
    voice = getattr(backend, "voice", None)
    if voice is None:
        return False
    engine = meta.get("engine") or {}
    if engine.get("voice", "seedvc") != voice:
        return True
    # Its separator: the last part of the model name ("ying+rvc+melband", "seed-vc-f0-44k+htdemucs").
    sep = _separator_of(backend)
    made = str(engine.get("model") or "").rsplit("+", 1)[-1]
    if sep is not None and made and made != sep:
        return True
    # Its lead split: a song whose lead came from another karaoke model is made again too.
    tag = _lead_tag_of(backend)
    used = (meta.get("lead_split") or {}).get("used", False)
    return tag is not None and bool(used) and (engine.get("lead") or LEGACY_LEAD) != tag


def _backing_of(req: JobRequest) -> str:
    """What becomes of the backing voices: the request's, but always kept for karaoke."""
    return "keep" if req.purpose == "karaoke" else req.backing


def _needs_stems(req: JobRequest, backend: Any) -> bool:
    """Whether this request needs the separated vocals and instrumental (see ``_run_job``)."""
    if _backing_of(req) in ("drop", "convert") or os.environ.get("SING_LEAD_SPLIT", "1") == "0":
        return True
    if not backend.lead_available():
        return True
    return not _lead_reads_mix(backend)


def _lead_reads_mix(backend: Any) -> bool:
    reads_mix = getattr(backend, "lead_reads_mix", None)
    return bool(reads_mix()) if callable(reads_mix) else True


def _separator_of(backend: Any) -> str | None:
    return getattr(backend, "separator", None)


def _lead_tag_of(backend: Any) -> str | None:
    return getattr(backend, "lead_tag", None)


STEMS_INFO = "stems.json"
# What made lead stems recorded before the model was (leadsplit.LEGACY_TAG).
LEGACY_LEAD = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956@vocals"


def _stems_info(sdir: Path) -> dict[str, Any]:
    try:
        info = json.loads((sdir / STEMS_INFO).read_text(encoding="utf-8"))
        return info if isinstance(info, dict) else {}
    except (OSError, ValueError):
        return {}


def _stems_separator(sdir: Path) -> str:
    """The separator that made a source's cached vocals / instrumental. Stems from before this was
    recorded were all made by htdemucs."""
    return str(_stems_info(sdir).get("separator") or "htdemucs")


def _stems_lead(sdir: Path) -> str:
    """What made the cached lead.wav / backing.wav (leadsplit.tag)."""
    return str(_stems_info(sdir).get("lead") or LEGACY_LEAD)


def _write_stems_info(sdir: Path, **fields: str | None) -> None:
    info = _stems_info(sdir)
    info.update({k: v for k, v in fields.items() if v is not None})
    if info:
        (sdir / STEMS_INFO).write_text(json.dumps(info), encoding="utf-8")


def _write_stems_separator(sdir: Path, separator: str | None) -> None:
    if separator is not None:
        # New vocals: the lead split from the old ones goes with them.
        info = {k: v for k, v in _stems_info(sdir).items() if k != "lead"}
        info["separator"] = separator
        (sdir / STEMS_INFO).write_text(json.dumps(info), encoding="utf-8")


def _needs_video(meta: dict[str, Any], kind: str | None) -> bool:
    """A cached song made before videos existed (no ``has_video`` at all) whose source has one."""
    return _video_on() and "has_video" not in meta and (kind in VIDEO_KINDS or kind == "library")


class VideoFetch:
    """A source's video, fetched on its own thread while the audio pipeline runs."""

    def __init__(self, src: Source, sdir: Path, job_cancel: threading.Event) -> None:
        self.src, self.sdir = src, sdir
        self.state = "running"  # running | done | failed | cancelled
        self.progress = 0.0
        self.error: str | None = None
        self.seconds: float | None = None
        self._stop = threading.Event()
        self._job_cancel = job_cancel
        self._thread = threading.Thread(target=self._run, name="sing-video", daemon=True)

    def start(self) -> "VideoFetch":
        self._thread.start()
        return self

    def cancelled(self) -> bool:
        return self._stop.is_set() or self._job_cancel.is_set()

    def stop(self) -> None:
        self._stop.set()

    def running(self) -> bool:
        return self._thread.is_alive()

    def _run(self) -> None:
        t0 = time.perf_counter()
        dest = self.sdir / "video.mp4"
        try:
            info = state.backend.fetch_video(self.src, dest, self._progressed, self.cancelled)
            info = {**info, "source": self.src.kind, "bytes": dest.stat().st_size}
            (self.sdir / "video.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), "utf-8")
            self.state, self.progress = "done", 1.0
        except Cancelled:
            self.state, self.error = "cancelled", "cancelled"
        except JobError as e:
            self.state, self.error = "failed", str(e)
            log.info("no video for %s: %s", self.src.key, e)
        except Exception as e:  # noqa: BLE001
            log.exception("video download of %s crashed", self.src.key)
            self.state, self.error = "failed", f"{type(e).__name__}: {e}"[:300]
        finally:
            self.seconds = round(time.perf_counter() - t0, 2)
            if self.state != "done":
                dest.unlink(missing_ok=True)

    def _progressed(self, f: float) -> None:
        self.progress = max(0.0, min(1.0, f))

    def wait(self, timeout_s: float, job_cancel: threading.Event,
             tick: Callable[[float], None] | None = None) -> None:
        """Until it ends, at most ``timeout_s`` (then it is stopped); raises Cancelled with the job.
        ``tick`` hears the download's progress (0..1) while it waits."""
        deadline = time.monotonic() + max(0.0, timeout_s)
        while self._thread.is_alive():
            if tick is not None:
                tick(self.progress)
            if job_cancel.is_set():
                self.stop()
                raise Cancelled()
            if time.monotonic() >= deadline:
                self.stop()
                self._thread.join(5)
                if self.state != "done":
                    self.state = "failed"
                    self.error = f"the video took longer than {timeout_s:.0f} s after the audio"
                return
            self._thread.join(0.1)

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "progress": round(self.progress, 3), "error": self.error}


class LyricsLookup:
    """The song's lyrics, looked up on their own thread while it is converted and mixed: the lookup
    needs only the source and the lead vocal (the original singer), and waits on the network or the
    language model for up to SING_LYRICS_BUDGET_S. Its ASR spot check waits until the conversion is
    done and the speech workers are back (``asr_wait``), so it never competes with it for the card."""

    def __init__(self, job: Job, src: Source, heard: Path | None, out: Path, duration: float | None) -> None:
        self.job, self.src, self.heard, self.out, self.duration = job, src, heard, out, duration
        self.meta: dict[str, Any] | None = None
        self.seconds: float | None = None
        self._thread = threading.Thread(target=self._run, name="sing-lyrics", daemon=True)

    def start(self) -> "LyricsLookup":
        self._thread.start()
        return self

    def asr_wait(self) -> None:
        """Raises ``Cancelled`` when the job ended without finishing: its lyrics are not kept, and the
        spot check would only run next to the next job's GPU work."""
        job = self.job
        while not job.converted.wait(0.2):
            if job.cancel.is_set():
                raise Cancelled()
        ex = job.exclusive
        if ex is not None:
            ex.join()  # her voice (and the ASR worker) loading back after a window
        if job.aborted or job.cancel.is_set():
            raise Cancelled()

    def _run(self) -> None:
        t0 = time.perf_counter()
        try:
            found = state.backend.lyrics(self.src, self.duration, self.heard, asr_wait=self.asr_wait)
            if not self.job.cancel.is_set():
                self.meta = _lyrics_meta(found, self.out, self.heard)
        except Cancelled:
            log.info("lyrics lookup for %s stopped: the job ended", self.src.key)
        except Exception:  # noqa: BLE001 - lyrics are best effort
            log.exception("lyrics lookup for %s crashed", self.src.key)
        finally:
            self.seconds = round(time.perf_counter() - t0, 2)

    def running(self) -> bool:
        return self._thread.is_alive()

    def wait(self, cancel: threading.Event) -> None:
        while self._thread.is_alive():
            if cancel.is_set():
                raise Cancelled()
            self._thread.join(0.1)


def _start_video(job: Job, src: Source, sdir: Path) -> None:
    """Gets the source's video under way: a library entry's own file at once, a link's on a thread
    (unless an earlier job already fetched it)."""
    if not _video_on() or find_video(sdir) is not None:
        return
    if src.kind == "library":
        v = state.store.library_video(src.path or "")
        if v is not None:
            try:
                info = state.backend.library_video(v, sdir)
            except JobError as e:
                log.info("no video for %s: %s", src.key, e)
                return
            (sdir / "video.json").write_text(json.dumps(info, indent=2), "utf-8")
    elif src.kind in VIDEO_KINDS:
        job.video = VideoFetch(src, sdir, job.cancel).start()


def _attach_video(job: Job, src: Source, sdir: Path, out: Path, timings: dict[str, float]) -> dict[str, Any]:
    """Waits for the video (stage ``video``), links it into the song and returns the meta fields."""
    if not _video_on():
        return {"has_video": False, "video": None, "video_error": "videos are off (SING_VIDEO=0)"}
    vf = job.video
    if vf is not None:
        if vf.running():
            _set(job, "video")
            t0 = time.perf_counter()
            vf.wait(env_float("SING_VIDEO_WAIT_S", 120.0), job.cancel, lambda f: _set(job, "video", f))
            timings["video_wait_s"] = round(time.perf_counter() - t0, 2)
        if vf.seconds is not None:
            timings["video_s"] = vf.seconds
    for old in out.glob("video.*"):
        old.unlink(missing_ok=True)
    v = find_video(sdir)
    if v is None:
        why = vf.error if vf is not None else (
            "no video next to the library entry" if src.kind == "library" else "the source has no video")
        return {"has_video": False, "video": None, "video_error": why}
    link_or_copy(v, out / v.name)
    try:
        info = json.loads((sdir / "video.json").read_text("utf-8"))
    except (OSError, ValueError):
        info = {}
    return {"has_video": True, "video": {**info, "file": v.name}, "video_error": None}


def _offload_urls() -> list[str]:
    return parse_urls(os.environ.get("SING_OFFLOAD_URLS"))


def _urgent(job: Job) -> bool:
    """Core needs this song now, or one queued behind it (jobs run one at a time). Never a karaoke
    job: preparing one never hurries her voice off the card."""
    if getattr(job, "is_karaoke", False):
        return False
    urgent = state.machine.audience.urgent
    if job.id in urgent:
        return True
    with state.lock:
        return any(j in urgent and state.jobs[j].state == "queued" for j in state.order)


def _wav_seconds(p: Path) -> float | None:
    try:
        with wave.open(str(p), "rb") as w:
            return w.getnframes() / w.getframerate()
    except (OSError, EOFError, wave.Error):
        return None


def _start_gpu(job: Job, audio_s: float | None) -> None:
    job.gpu = GpuJob(state.machine, job.id, _offload_urls(), core_expected=job.request.exclusive_ack,
                     urgent=lambda: _urgent(job), audio_s=audio_s, share_only=job.is_karaoke)
    urls = parse_urls(os.environ.get("SING_YIELD_URLS") or os.environ.get("SING_OFFLOAD_URLS"))
    job.yielding = SpeechYield(urls, state.busy_get, poll_s=env_int("SING_YIELD_POLL_MS", 100) / 1000,
                               hold_s=env_int("SING_YIELD_HOLD_MS", 300) / 1000,
                               max_s=job.gpu.yield_allowance()).start()


def _stage_pauses(stage: str) -> bool:
    """Whether the stage stops between steps while she speaks. Her RVC model (``SING_VOICE=rvc``, or
    the ``+rvc`` pass after the conversion) runs as one subprocess from start to end; RMVPE reads a
    karaoke song's lead in one go (``reference``); the karaoke lyrics' models run as subprocesses
    (``lyrics_asr``, ``lyrics_align``)."""
    if stage in ("reference", "lyrics_asr", "lyrics_align"):
        return False
    return not (stage == "convert" and getattr(state.backend, "rvc", False))


def _stage_uses_gpu(stage: str) -> bool:
    if stage not in CPU_STAGES:
        return True
    return getattr(state.backend, "lead_device" if stage == "lead" else "separate_device", "cuda") != "cpu"


def _open_window(job: Job) -> None:
    """Her voice goes offline: Core gets to let her say so, then the workers drop their models."""
    g, stage = job.gpu, job.stage
    assert g is not None
    job.go.clear()  # every window waits for its own go
    job.exclusive = Exclusive(_offload_urls(), state.offload_post, ack_wait_s=env_float("SING_EXCLUSIVE_WAIT_S", 30.0),
                              reload_timeout_s=env_float("SING_RELOAD_TIMEOUT_S", 300.0), max_s=g.offload_max_s())
    g.window_opening()
    job.stage = "exclusive"
    try:
        job.exclusive.begin(job.cancel.is_set, job.go if job.request.exclusive_ack else None)
    finally:
        job.stage = stage
    g.window_opened(job.exclusive.offline_at)


def _close_window(job: Job) -> None:
    """Her voice comes back, and the job waits for that: only then the card shows what is free."""
    ex, g = job.exclusive, job.gpu
    if ex is None or g is None or not g.window:
        return
    ex.end()
    ex.join()
    g.window_closed(ex.timings.get("reload_s"), ex.asked_back_at)


def _place(job: Job, stage: str) -> str:
    """``gpu`` or ``cpu``, once the stage may start: holds the job while it has to wait for room. A
    waiting job holds no VRAM, so it costs her nothing."""
    g = job.gpu
    assert g is not None
    try:
        while True:
            if job.cancel.is_set():
                raise Cancelled()
            d = g.decide(stage, _stage_uses_gpu(stage), _stage_pauses(stage))
            if d.mode == "wait":
                job.stage = "gpu_wait"
                job.cancel.wait(g.limits.check_s)
                continue
            job.stage = stage
            if d.mode == "give_up":
                raise JobError(d.reason)
            if d.mode == "offload":
                _open_window(job)
            elif d.mode == "share" and (job.exclusive is None or job.exclusive.state != "shared"):
                job.exclusive = Exclusive([], state.offload_post)
                job.exclusive.share(g.facts.free_mb if g.facts else None)
            return "cpu" if d.mode == "cpu" else "gpu"
    finally:
        job.stage = stage
        g.wait_over()


def _act(job: Job, act: Action, work: ConvertWork | None) -> None:
    if act.kind == "trim":
        state.backend.trim()
    elif act.kind == "reduce":
        if work is not None and job.gpu is not None:
            work.steps = job.gpu.reduced_to
    elif act.kind == "offload":
        _open_window(job)
    else:
        raise Suspended(act.code)


def _arm(job: Job, stage: str, work: ConvertWork | None) -> None:
    """What runs before every diffusion step and separation segment: the time of the last one, her
    voice, and whether the job should still be running like this."""
    g, y, b = job.gpu, job.yielding, state.backend
    assert g is not None and y is not None

    def gate() -> None:
        if job.cancel.is_set():
            raise Cancelled()
        if g.device == "gpu":
            sync = getattr(b, "sync", None)
            if sync is not None:
                sync()
        g.step()
        if y.busy():
            y.max_s = g.yield_allowance()
            y.wait(job.cancel.is_set)
        act = g.tick(stage)
        if act is not None:
            _act(job, act, work)
        g.resume()

    b.gate = gate


class SelfArbitration:
    """``SING_GPU_ARBITER=self`` (the default): the worker decides by itself, as it always has
    (gpu.py, exclusive.py, yielding.py and the functions above). Deleted, with ``_start_gpu``,
    ``_place``, ``_open_window``, ``_close_window``, ``_act``, ``_arm``, ``_urgent`` and
    ``_recover_speech``, once the song worker has run on hostd's arbiter live (lease.py)."""

    name = "self"

    def start(self, job: Job, audio_s: float | None) -> None:
        _start_gpu(job, audio_s)

    def place(self, job: Job, stage: str, resumed: bool) -> str:
        return _place(job, stage)

    def arm(self, job: Job, stage: str, work: ConvertWork | None) -> None:
        _arm(job, stage, work)

    def run_begins(self, job: Job, stage: str, device: str, resumed: bool) -> Callable[[], None] | None:
        g = job.gpu
        assert g is not None
        g.started(stage, device, resumed)
        # torch here cannot see a subprocess's VRAM, and it never calls the gate: read the card.
        return g.watch() if device == "gpu" and not _stage_pauses(stage) else None

    def run_ended(self, job: Job, stage: str, how: str) -> None:
        g = job.gpu
        assert g is not None
        if how == "finished":
            g.finished(stage)
        else:
            g.stopped(oom=how == "oom")

    def close_window(self, job: Job) -> None:
        _close_window(job)

    def give_back(self, job: Job) -> None:
        """Starts bringing her voice back; ``run_job`` waits for it. The song mixes meanwhile."""
        if job.yielding is not None:
            job.yielding.stop()
        state.backend.gate = None
        ex, g = job.exclusive, job.gpu
        if ex is not None:
            # The window ends when her voice is back, not when the job does: the gap before the next
            # window, and the silence counted, start then (until 2026-11-16: at the job's end).
            ex.end(after=None if g is None else lambda: g.window_closed(ex.timings.get("reload_s"),
                                                                        ex.asked_back_at))

    def finish(self, job: Job) -> dict[str, Any] | None:
        if job.exclusive is not None:
            job.exclusive.join()
        if job.gpu is not None:
            ex = job.exclusive
            job.gpu.window_closed(ex.timings.get("reload_s") if ex else None, ex.asked_back_at if ex else None)
        return None

    def startup(self) -> None:
        threading.Thread(target=_recover_speech, name="sing-recover", daemon=True).start()

    def context(self, req: GpuContext) -> dict[str, Any]:
        state.machine.audience.update(req.in_voice, req.listeners, req.live, req.urgent)
        return {"ok": True}

    def health(self, job: Job | None) -> dict[str, Any]:
        info = state.machine.public(Limits.from_env())
        info["arbiter"] = self.name
        info["job"] = job.gpu.public() if job is not None and job.gpu is not None else None
        return info


_SELF = SelfArbitration()


def _arbitration() -> Any:
    """Who takes the GPU decisions (``SING_GPU_ARBITER``, chosen at start): ``SelfArbitration`` or
    lease.py's ``HostdArbitration``, the same calls in the same places of the job loop."""
    return getattr(state, "arbitration", None) or _SELF


def _gpu_stage(job: Job, stage: str, wav: Path, duration_s: float | None, run: Callable[[str], Any],
               work: ConvertWork | None = None) -> Any:
    """Runs a stage where the machine has room for it, again from where it was when it had to let
    go: ``run`` gets the device. The first one to run starts the job's GPU bookkeeping."""
    arb = _arbitration()
    if job.gpu is None:
        arb.start(job, duration_s or _wav_seconds(wav))
    assert job.gpu is not None
    resumed = False
    while True:
        wait_warm = getattr(state.backend, "wait_warm", None)
        if wait_warm is not None and _stage_uses_gpu(stage):
            wait_warm()  # the RVC warm-up is not this stage's VRAM
        device = arb.place(job, stage, resumed)
        arb.arm(job, stage, work)
        unwatch = arb.run_begins(job, stage, device, resumed)
        try:
            try:
                out = run(device)
            finally:
                if unwatch is not None:
                    unwatch()  # before ``finished`` / ``stopped`` look at what it read
        except Suspended as e:
            log.info("job %s lets go of the GPU in %s: %s", job.id, stage, e.code)
            arb.run_ended(job, stage, "suspended")
        except Exception as e:
            if device == "cpu" or not is_oom(e):
                raise
            log.warning("job %s ran out of VRAM in %s", job.id, stage)
            arb.run_ended(job, stage, "oom")
        else:
            arb.run_ended(job, stage, "finished")
            return out
        finally:
            state.backend.gate = None
        state.backend.unload()
        arb.close_window(job)
        resumed = True


def _give_gpu_back(job: Job) -> None:
    """Starts bringing her voice back; ``run_job`` waits for it. The song mixes meanwhile."""
    _arbitration().give_back(job)


def _convert_passes(job: Job, passes: list[Callable[[], Any]]) -> list[Any]:
    """The conversion's passes on the card, one after the other: the lead (or the whole vocal stem)
    and, with ``backing: "convert"``, the backing voices. Each is a GPU stage of its own, placed when
    it starts; her voice is given back once, after the last. A window the first pass opened is still
    open for the second, with the same silence limit (its clock runs on from the window's start) and
    the same yielding, so she goes quiet once, not twice with a gap between. Until 2026-11-16 her
    voice was given back after the first pass and the second ran on the card while it reloaded."""
    out = []
    try:
        for run in passes:
            out.append(run())
    finally:
        _give_gpu_back(job)
    return out


def _gpu_summary_to_meta(job: Job, summary: dict[str, Any]) -> None:
    """hostd's summary of the job, known only once its lease ends, replaces what ``meta.json`` got."""
    sid = job.song_id
    meta = state.store.meta(sid) if sid else None
    if meta is None or not isinstance(meta.get("gpu"), dict):
        return
    meta["gpu"] = summary
    if summary.get("waited_s"):
        meta.setdefault("timings", {})["gpu_wait_s"] = summary["waited_s"]
    state.store.write_meta(sid, meta)


def run_job(job: Job) -> None:
    try:
        _run_job(job)
    except BaseException:
        job.aborted = True
        raise
    finally:
        job.prefetched = None  # the lookup's whole yt-dlp answer: not kept in the job records
        job.converted.set()  # a lyrics lookup still waiting for the ASR check goes on (or ends)
        if job.video is not None:
            job.video.stop()
        # Also after a failure or a cancel; the job is only over once they are back.
        arb = _arbitration()
        arb.give_back(job)
        summary = arb.finish(job)
        if summary is not None and job.state != "cancelled" and not job.aborted:
            _gpu_summary_to_meta(job, summary)


_fetch_locks: dict[str, threading.Lock] = {}
_fetch_locks_lock = threading.Lock()


def _fetch(src: Source, dest: Path, progress: Callable[[float], None], again: bool = False) -> None:
    """Downloads ``src`` into ``dest`` through a temporary file: a download cut short (a crash, a stop)
    never leaves a partial ``source.wav`` that a later job would take for the whole song. One download
    of a source at a time (a job and the prefetch of the next one may want the same song): the second
    one waits, and takes the first one's file unless ``again`` (a forced job)."""
    with _fetch_locks_lock:
        lock = _fetch_locks.setdefault(src.key, threading.Lock())
    with lock:
        if dest.exists() and not again:
            return
        part = dest.with_name(dest.stem + ".part" + dest.suffix)
        try:
            state.backend.fetch(src, part, progress)
            os.replace(part, dest)
        finally:
            part.unlink(missing_ok=True)


def _prefetch_on() -> bool:
    return os.environ.get("SING_PREFETCH", "1") != "0"


def _prefetch(job: Job, running: Job) -> None:
    """Finds the queued ``job``'s song and downloads it while ``running`` is made: the network and the
    CPU are idle while a job converts, and the next song then starts at its first GPU stage. Nothing
    here fails the job: what did not get done is done when it runs, as before."""
    store = state.store
    job.prefetch = "running"  # prefetch_loop marked it already, under the lock
    try:
        gone = lambda: job.state == "cancelled" or job.cancel.is_set()  # noqa: E731

        def progress(_f: float) -> None:
            if gone():
                raise Cancelled()  # the job was cancelled: its download stops too
        src = _bounded(lambda: _source_from_request(job), gone, env_float("SING_RESOLVE_TIMEOUT_S", 60.0))
        job.prefetched = src
        job.source = src.public()  # also keeps its download out of the cache cleanup
        req = job.request
        if job.is_karaoke:
            kid = karaoke_id(src.key)
            state.cache.touch(karaoke=kid, source=src.key)
            made = _karaoke_cached(kid) is not None
        else:
            sid = song_id(src.key, req.pitch, req.key, req.backing)
            state.cache.touch(song=sid, source=src.key)
            meta = store.meta(sid)
            made = meta is not None and not _other_voice(meta, state.backend)
        sdir = store.source_dir(src.key)
        busy = (running.source or {}).get("key") == src.key  # the running job has that download
        if (src.kind != "library" and not busy and not gone() and not (sdir / "source.wav").exists()
                and not made):
            sdir.mkdir(parents=True, exist_ok=True)
            store.write_source_info(src)
            t0 = time.perf_counter()
            _fetch(src, sdir / "source.wav", progress)
            log.info("prefetched %s for job %s in %.1f s", src.key, job.id, time.perf_counter() - t0)
        if gone():
            job.prefetched = None
        job.prefetch = "done"
    except Exception as e:  # noqa: BLE001 - Cancelled, JobError, anything: the job tries again itself
        log.info("prefetch for job %s: %s", job.id, e)
        job.prefetch = "failed"
    finally:
        job.prefetch_done.set()


def prefetch_loop() -> None:
    """While a job runs, the next queued one is looked up and downloaded (one at a time)."""
    while not state.stopping.wait(0.5):
        if not _prefetch_on():
            continue
        running = state.jobs.get(state.running or "")
        if running is None:
            continue
        with state.lock:
            nxt = next((state.jobs[j] for j in state.order if j in state.jobs and state.jobs[j].state == "queued"),
                       None)
            if nxt is None or nxt.prefetch is not None or nxt.request.force:
                continue
            # Marked while it is still queued (worker_loop starts jobs under the same lock): a job that
            # starts from here on waits for this prefetch instead of downloading next to it.
            nxt.prefetch = "running"
        try:
            _prefetch(nxt, running)
        except Exception:  # noqa: BLE001
            log.exception("prefetch crashed")


def _lead_stage(job: Job, sdir: Path, src: Source, timed: Callable[[str, Callable[[], Any]], Any]) -> dict[str, Any]:
    """Splits the vocal stem into lead + backing when it should and can. Returns the song's
    ``lead_split`` info; ``used`` says whether the next stages work on the lead.

    Stems cached before the split existed are split on demand from their cached vocals (and
    kept: lead.wav / backing.wav sit beside them). A split that fails for any other reason than
    a cancel, the GPU being taken back (both end the job as for any stage) or running out of VRAM
    (``_gpu_stage`` redoes that on the CPU) leaves the plain pipeline in place, with the reason."""
    b = state.backend
    if os.environ.get("SING_LEAD_SPLIT", "1") == "0":
        return {"used": False, "reason": "off"}
    if not b.lead_available():
        return {"used": False, "reason": "no_model"}
    lead_wav, backing_wav, rest_wav = sdir / "lead.wav", sdir / "backing.wav", sdir / "rest.wav"
    tag = _lead_tag_of(b)
    if lead_wav.exists() and (tag is None or _stems_lead(sdir) == tag):
        b.complete_stems(sdir)  # what this request needs that an earlier one did not
        return {"used": True, "cached": True}
    source = sdir / "source.wav"

    def split(device: str) -> None:
        b.split_lead(sdir / "vocals.wav", lead_wav, backing_wav, lambda f: _set(job, "lead", f),
                     device="cpu" if device == "cpu" else None,
                     source_wav=source if source.exists() else None, rest_out=rest_wav)

    sized = source if source.exists() else sdir / "vocals.wav"
    try:
        timed("lead", lambda: _gpu_stage(job, "lead", sized, src.duration_s, split))
    except (Cancelled, Suspended):
        raise
    except Exception as e:
        log.warning("job %s: the lead split failed, converting the whole vocal stem: %s", job.id, e)
        for f in (lead_wav, backing_wav, rest_wav):
            f.unlink(missing_ok=True)
        return {"used": False, "reason": "failed", "error": str(e)[:300]}
    _write_stems_info(sdir, lead=tag)
    return {"used": True, "cached": False}


def _lyrics_meta(found: dict[str, Any] | None, out: Path, heard: Path | None = None) -> dict[str, Any] | None:
    """The song meta's ``lyrics`` for a lookup result, and ``lyrics.lrc`` written into ``out``.

    Besides what the player reads (``synced``, ``lines``, ``plain``) it says where the lyrics came from
    (``provider``, ``how``: metadata | title | llm), the song they were matched to (``track``, ``artist``),
    how sure the match is (``confidence`` 0..1, ``checks``) and when (``fetched_at``). Synced lines that
    are off by a constant amount against the singer's track ``heard`` are moved back (``offset_s``).
    """
    if not found:
        return None
    from lyrics import parse_lrc
    from lyrics_align import align, shift_lines

    lines = parse_lrc(found["lrc"]) if found.get("lrc") else []
    offset = align(heard, lines) if lines else 0.0
    if offset:
        log.info("lyrics moved by %+.2f s to meet the singing", offset)
        lines = shift_lines(lines, offset)
    lrc = out / "lyrics.lrc"
    if found.get("lrc"):
        lrc.write_text(found["lrc"], "utf-8")
    else:
        lrc.unlink(missing_ok=True)
    return {"provider": found["provider"], "synced": bool(lines), "track": found.get("track"),
            "artist": found.get("artist"), "lines": lines,
            "plain": None if lines else (found.get("plain") or "")[:4000],
            "how": found.get("how"), "confidence": found.get("confidence"), "matched": found.get("matched"),
            "checks": found.get("checks"), "llm": found.get("llm"), "tried": found.get("tried"),
            "offset_s": offset, "fetched_at": now_iso()}


Timed = Callable[[str, Callable[[], Any]], Any]


def _timer(job: Job, timings: dict[str, float]) -> Timed:
    """``timed(name, fn)``: runs ``fn`` as the job's stage ``name`` and records its seconds."""
    def timed(name: str, fn: Callable[[], Any]) -> Any:
        if job.cancel.is_set():
            raise Cancelled()
        _set(job, name)
        t0 = time.perf_counter()
        out = fn()
        timings[f"{name}_s"] = round(time.perf_counter() - t0, 2)
        return out

    return timed


def _run_job(job: Job) -> None:
    if job.is_karaoke:
        _run_karaoke(job)
        return
    store, req = state.store, job.request
    timings: dict[str, float] = {}
    t_job = time.perf_counter()
    timed = _timer(job, timings)
    src = _resolve(job, timings, timed)
    sid = song_id(src.key, req.pitch, req.key, req.backing)
    job.song_id = sid
    # In use from here on (the cleanup leaves the job's song and download alone); a song or download
    # it removed just before is simply made again.
    state.cache.touch(song=sid, source=src.key)
    sdir = store.source_dir(src.key)
    cached = None if req.force else store.meta(sid)
    if cached is not None and _other_voice(cached, state.backend):
        cached = None
    if cached is not None:
        job.cached = True
        if _needs_video(cached, src.kind):
            # Made before videos existed: fetch just the video.
            sdir.mkdir(parents=True, exist_ok=True)
            _start_video(job, src, sdir)
            cached.update(_attach_video(job, src, sdir, store.song_dir(sid), cached.setdefault("timings", {})))
            store.write_meta(sid, cached)
        return

    _peak_vram_reset()
    sdir.mkdir(parents=True, exist_ok=True)
    store.write_source_info(src)
    if req.force:
        for old in list(sdir.glob("video.*")):
            old.unlink(missing_ok=True)
    _start_video(job, src, sdir)
    lead = _stems_and_lead(job, src, sdir, timed)
    vocal = sdir / ("lead.wav" if lead["used"] else "vocals.wav")
    _cover(job, src, sdir, lead, vocal, timings, timed, t_job)


def _resolve(job: Job, timings: dict[str, float], timed: Timed) -> Source:
    """The job's song: the prefetch's answer, or looked up now; the request's title and artist on it."""
    req, check = job.request, job.cancel.is_set
    limit = env_float("SING_RESOLVE_TIMEOUT_S", 60.0)
    if job.prefetch == "running":  # looked up and downloaded right now: wait for that, not twice
        _set(job, "resolve")
        t_pre = time.perf_counter()
        while not job.prefetch_done.wait(0.1):
            if check():
                raise Cancelled()
        timings["prefetch_wait_s"] = round(time.perf_counter() - t_pre, 2)
    if job.prefetched is not None and not req.force:
        src = job.prefetched
        timings["prefetched"] = 1
    else:
        src = timed("resolve", lambda: _bounded(lambda: _source_from_request(job), check, limit))
    if req.title:
        src.title = req.title.strip()
    if req.artist:
        src.artist = req.artist.strip()
    job.source = src.public()
    return src


def _stems_and_lead(job: Job, src: Source, sdir: Path, timed: Timed) -> dict[str, Any]:
    """Downloads the song when it is not there, separates it when the request needs that, splits the
    lead (``_lead_stage``, whose info this returns), and separates after all when there is no lead."""
    b, req = state.backend, job.request
    given_stems = src.kind == "library" and src.split  # a library folder with its own stems
    if req.force:
        derived = ["lead.wav", "backing.wav", "rest.wav", STEMS_INFO]
        if not given_stems:
            derived += ["vocals.wav", "instrumental.wav"]
        for stale in derived:
            (sdir / stale).unlink(missing_ok=True)
    have_stems = (sdir / "vocals.wav").exists() and (sdir / "instrumental.wav").exists()
    sep = _separator_of(b)
    if have_stems and sep is not None and not given_stems and _stems_separator(sdir) != sep:
        have_stems = False  # made by another separator: separate again with this one
        (sdir / "backing.wav").unlink(missing_ok=True)  # vocals - lead, of the old vocals
    if src.kind == "library":
        if req.force or not ((sdir / "source.wav").exists() or (given_stems and have_stems)):
            timed("download", lambda: b.fetch_library(src, sdir))
            have_stems = have_stems or given_stems
    elif req.force or not (sdir / "source.wav").exists():
        # Her RVC model and the lead model load while the song downloads (engine.prewarm); the lead
        # model only when the split is the next GPU stage and has something to do.
        prewarm = getattr(b, "prewarm", None)
        if prewarm is not None:
            tag = _lead_tag_of(b)
            lead_cached = (sdir / "lead.wav").exists() and (tag is None or _stems_lead(sdir) == tag)
            prewarm(lead=not _needs_stems(req, b) and not lead_cached and not given_stems)
        timed("download", lambda: _fetch(src, sdir / "source.wav", lambda f: _set(job, "download", f), again=req.force))

    def separate_stage() -> None:
        # New vocals: what was taken from the old ones goes (a lead read from the vocals, too).
        (sdir / "backing.wav").unlink(missing_ok=True)
        if not _lead_reads_mix(b):
            (sdir / "lead.wav").unlink(missing_ok=True)

        def separate(device: str) -> None:
            b.separate(sdir / "source.wav", sdir / "vocals.wav", sdir / "instrumental.wav",
                       lambda f: _set(job, "separate", f), device="cpu" if device == "cpu" else None)

        timed("separate", lambda: _gpu_stage(job, "separate", sdir / "source.wav", src.duration_s, separate))
        _write_stems_separator(sdir, _separator_of(b))

    # The vocals and instrumental apart are needed only to drop or convert the backing voices, or
    # when the lead comes from the vocals. Otherwise the lead comes from the song itself and the
    # rest of the song is everything else, so the separation (the stage that needs the most
    # VRAM) is skipped: the mix is the same to the sample.
    if not have_stems and not given_stems and _needs_stems(req, b):
        separate_stage()
    lead = _lead_stage(job, sdir, src, timed)
    if not lead["used"] and not (sdir / "vocals.wav").exists():
        separate_stage()  # no lead after all: the plain pipeline converts the vocals
    return lead


def _cover(job: Job, src: Source, sdir: Path, lead: dict[str, Any], vocal: Path, timings: dict[str, float],
           timed: Timed, t_job: float) -> None:
    """The rest of a cover: her voice sings ``vocal``, the mix, the beats, the lyrics, the video."""
    store, b, req = state.store, state.backend, job.request
    check = job.cancel.is_set
    sid = job.song_id
    assert sid is not None
    out = store.song_dir(sid)
    out.mkdir(parents=True, exist_ok=True)
    from lyrics import hints_of

    lyrics_input = hints_of(src)
    # the lead vocal (the original singer, before conversion) is what the ASR spot check listens to
    heard = next((p for p in (sdir / "lead.wav", sdir / "vocals.wav") if p.exists()), None)
    # The audio's own length (the mix's), as when the lookup ran after the mix; the source's when unread.
    lookup = LyricsLookup(job, src, heard, out, (_wav_seconds(heard) if heard else None) or src.duration_s).start()
    converted = out / "_converted.wav"

    work = ConvertWork()
    pitch: dict[str, Any] = {}

    def converted_share(f: float, stage: str = "convert") -> None:
        _set(job, stage, f)
        if job.gpu is not None:
            job.gpu.converted = f

    def convert() -> dict[str, Any]:
        return _gpu_stage(job, "convert", vocal, src.duration_s, convert_on_gpu, work)

    def settle_pitch(shift: int, auto_key: int, info: dict[str, Any]) -> int:
        """Records the pitch settings and starts the mix's instrumental; the vocal's shift."""
        song_key = req.key + auto_key
        shift += song_key
        info.update({"vocal_shift": shift, "key": req.key, "auto_key": auto_key, "song_key": song_key,
                     "f0_clean": os.environ.get("SING_F0_CLEAN", "1") != "0",
                     "transposer": getattr(b, "transposer", None) if song_key else None})
        pitch.clear()  # (asked again after a failed first try: the latest answer counts)
        pitch.update(info)
        # What goes under her voice needs nothing of the conversion: it is made meanwhile.
        prepare = getattr(b, "prepare_mix", None)
        if prepare is not None:
            prepare(sdir, song_key, lead["used"], req.backing)
        return int(pitch["vocal_shift"])

    def convert_on_gpu(_device: str) -> dict[str, Any]:
        convert_auto = getattr(b, "convert_auto", None)
        if not pitch and req.pitch is None and convert_auto is not None and getattr(b, "voice", None) == "rvc":
            # Her RVC model reads the pitch for the conversion anyway: the key is picked from that.
            def choose(stats: tuple[float, float] | None, ref_hz: float | None) -> int:
                octave, auto_key, info = _shift_from(stats, ref_hz, auto_key=req.key == 0)
                info["auto"] = True
                return settle_pitch(octave, auto_key, info)

            convert_auto(vocal, converted, choose, converted_share, check)
            return pitch
        if not pitch:  # a conversion that was suspended keeps its key
            if req.pitch is not None:
                settle_pitch(req.pitch, 0, {"auto": False, "octave_shift": None})
            else:
                # An explicit key is the requester's choice: only the octave stays automatic.
                octave, auto_key, info = _auto_shift(vocal, auto_key=req.key == 0)
                info["auto"] = True
                settle_pitch(octave, auto_key, info)
        b.convert(vocal, converted, pitch["vocal_shift"], converted_share, check, work)
        return pitch

    passes: list[Callable[[], Any]] = [lambda: timed("convert", convert)]
    backing_conv: Path | None = None
    if req.backing == "convert" and lead["used"]:
        backing_conv = out / "_converted_backing.wav"
        backing_wav = sdir / "backing.wav"
        backing_work = ConvertWork()  # its own: a suspended pass goes on from its last chunk

        def convert_backing_on_gpu(_device: str) -> None:
            b.convert(backing_wav, backing_conv, pitch["vocal_shift"],
                      lambda f: converted_share(f, "convert_backing"), check, backing_work)

        passes.append(lambda: timed("convert_backing", lambda: _gpu_stage(
            job, "convert", backing_wav, src.duration_s, convert_backing_on_gpu, backing_work)))
    pitch_info = _convert_passes(job, passes)[0]
    job.converted.set()  # the card is the speech workers' again: the lyrics' ASR check may go on
    mixed = timed("mix", lambda: b.mix(sdir, converted, pitch_info["song_key"], out, lead["used"],
                                          req.backing, backing_conv))
    converted.unlink(missing_ok=True)
    if backing_conv is not None:
        backing_conv.unlink(missing_ok=True)
    duration = mixed.get("duration_s") or src.duration_s
    from beats import beat_meta

    # her sway and nods follow the beat of what is actually played
    beats = timed("beats", lambda: beat_meta(out / "play_mix.pcm", PLAY_RATE))
    if lookup.running():
        _set(job, "lyrics")
        t_wait = time.perf_counter()
        lookup.wait(job.cancel)
        timings["lyrics_wait_s"] = round(time.perf_counter() - t_wait, 2)
    if lookup.seconds is not None:
        timings["lyrics_s"] = lookup.seconds
    lyrics_meta = lookup.meta
    video = _attach_video(job, src, sdir, out, timings)
    timings["total_s"] = round(time.perf_counter() - t_job, 2)
    g = job.gpu
    if g is not None and g.waited_total_s:
        timings["gpu_wait_s"] = round(g.waited_total_s, 2)
    meta = {
        "id": sid,
        "title": src.title,
        "artist": src.artist,
        "duration_s": duration,
        "source": src.public(),
        "pitch": pitch_info,
        "lead_split": lead,
        # Without a split the backing voices stay in the converted vocal: only a split can drop them.
        "backing": req.backing if lead["used"] or req.backing == "acapella" else "in_vocal",
        "lyrics": lyrics_meta,
        "lyrics_input": lyrics_input,
        "beats": beats,
        **video,
        "play": {"sample_rate": PLAY_RATE, "samples": mixed.get("samples"), "format": "s16le", "channels": 1},
        "mix": mixed,
        "engine": {"backend": b.name, "model": b.model_name, "device": b.device,
                   "lead": _lead_tag_of(b) if lead["used"] else None,
                   "voice": getattr(b, "voice", None), "rvc_error": getattr(b, "rvc_error", None),
                   "diffusion_steps": env_int("SING_DIFFUSION_STEPS", 30)},
        "timings": timings,
        "peak_vram_mb": (g.peak_allocated_mb if g is not None else None) or _peak_vram_mb(),
        "gpu": g.summary() if g is not None else None,
        "created_at": now_iso(),
    }
    store.write_meta(sid, meta)
    state.cache.touch(song=sid, source=src.key)
    log.info("song %s ready: %s (%s)", sid, src.title, timings)


# ── karaoke (docs/design/karaoke.md §3, karaoke.py, melody.py) ───────────────


def _karaoke_cached(kid: str) -> dict[str, Any] | None:
    """A karaoke song's meta.json when it is complete and its lead came from this worker's lead
    model (one made with another is made again, as a cover is)."""
    meta = state.karaoke.meta(kid)
    if meta is None:
        return None
    tag = _lead_tag_of(state.backend)
    used = bool((meta.get("lead_split") or {}).get("used", False))
    if tag is not None and used and (meta.get("engine") or {}).get("lead") != tag:
        return None
    return meta


def _karaoke_parts(sdir: Path, split: bool) -> list[Path]:
    """What the backing track is made of: the song without its lead (instrumental and backing voices,
    as a karaoke track keeps the harmonies), or the instrumental with the backing voices beside it
    (a lead split from the vocals), or the instrumental alone (no lead split)."""
    rest, inst, backing = sdir / "rest.wav", sdir / "instrumental.wav", sdir / "backing.wav"
    if split and rest.exists():
        return [rest]
    parts = [inst] + ([backing] if split and backing.exists() else [])
    if not inst.exists():
        raise JobError("the stems of the backing track are missing")
    return parts


def _karaoke_curve(f0: Any, vocal: Path, duration: float) -> tuple[Any, list[dict[str, Any]]]:
    """(the 50 Hz curve, the notes cut from the pitch alone) of the lead from RMVPE's F0 (melody.py)."""
    import melody
    from karaoke import mono_of

    mono, sr = mono_of(vocal)
    midi = melody.curve(f0, melody.frame_rms(mono, sr), frames=int(round(duration * melody.CURVE_HZ)),
                        clean=os.environ.get("SING_F0_CLEAN", "1") != "0")
    return midi, [n.json() for n in melody.cut_notes(midi)]


def _karaoke_quality(midi: Any, notes: int, lead_used: bool) -> dict[str, Any]:
    import melody

    return melody.quality(midi, notes, lead_used,
                          min_voiced=env_float("SING_KARAOKE_MIN_VOICED", melody.MIN_VOICED_RATIO),
                          min_notes=env_int("SING_KARAOKE_MIN_NOTES", melody.MIN_NOTES))


def _lyrics_runner(job: Job, vocal: Path, work: Path, duration: float) -> tuple[Callable[[str, dict[str, Any]], dict[str, Any]] | None, str | None]:
    """(how a karaoke lyrics step runs, why it cannot): each step a GPU stage of its own (``lyrics_asr``,
    ``lyrics_align``), placed and given way like the others; the mock backend answers itself."""
    import alignenv
    from lyricstage import StepFailed

    fake = getattr(state.backend, "karaoke_lyrics_step", None)
    if fake is not None:
        if os.environ.get("SING_MOCK_ALIGN", "1") == "0":
            return None, "SING_MOCK_ALIGN=0"
    else:
        why = alignenv.available()
        if why is not None:
            return None, why
    audio = work / "lead16k.npy"

    def run(step: str, payload: dict[str, Any]) -> dict[str, Any]:
        stage = f"lyrics_{step}"
        _set(job, stage)

        def go(device: str) -> dict[str, Any]:
            if fake is not None:
                return fake(step, payload, device)
            return alignenv.run_step(step, payload, device, alignenv.lead_16k(vocal, audio), work)

        try:
            return _gpu_stage(job, stage, vocal, duration, go)
        except (Cancelled, Suspended):
            raise
        except StepFailed:
            raise
        except Exception as e:  # noqa: BLE001 - the lyrics fall back, the song goes on
            raise StepFailed(f"{step}: {e}") from e

    return run, None


def _karaoke_video(job: Job, src: Source, sdir: Path, out: Path, duration: float,
                   timings: dict[str, float]) -> dict[str, Any]:
    """Stage ``video``: waits for the source's video as a cover does (SING_VIDEO_WAIT_S after the
    audio at most), then makes the karaoke song's own video.mp4 from it (karaoke.make_video).
    Returns meta.json's ``video`` (what was done) and ``video_error``; a video that is missing or
    cannot be made leaves the song without one, never fails it."""
    import karaoke as kara

    vf = job.video
    if vf is not None:
        if vf.running():
            _set(job, "video")
            t0 = time.perf_counter()
            vf.wait(env_float("SING_VIDEO_WAIT_S", 120.0), job.cancel)
            timings["video_wait_s"] = round(time.perf_counter() - t0, 2)
        if vf.seconds is not None:
            timings["video_s"] = vf.seconds
    v = find_video(sdir)
    if v is None:
        why = (vf.error if vf is not None else None) or (
            "no video next to the library entry" if src.kind == "library" else "the source has no video")
        log.info("karaoke %s has no video: %s", job.karaoke_id, why)
        return {"video": None, "video_error": why}
    _set(job, "video")
    t0 = time.perf_counter()
    target = out / kara.VIDEO_FILE
    try:
        info = state.backend.karaoke_video(v, target, duration, job.cancel.is_set)
    except Cancelled:
        target.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001 - the song is ready without it
        target.unlink(missing_ok=True)
        log.info("karaoke %s: the video could not be made: %s", job.karaoke_id, e)
        return {"video": None, "video_error": f"{type(e).__name__}: {e}"[:300] if not isinstance(e, JobError)
                else str(e)[:300]}
    timings["video_make_s"] = round(time.perf_counter() - t0, 2)
    return {"video": info, "video_error": None}


def _run_karaoke(job: Job) -> None:
    """A karaoke song: the front of a cover (resolve, download, separate, lead: the same cached stems),
    then the reference melody of the lead, the backing track, the lyrics checked and aligned; no
    conversion, no mix."""
    import karaoke as kara
    import lyricstage
    import melody
    from contracts import WorkersKaraokeReferenceV2

    store, b, req = state.store, state.backend, job.request
    timings: dict[str, float] = {}
    t_job = time.perf_counter()
    timed = _timer(job, timings)
    src = _resolve(job, timings, timed)
    kid = karaoke_id(src.key)
    job.karaoke_id = kid
    state.cache.touch(karaoke=kid, source=src.key)
    cached = None if req.force else _karaoke_cached(kid)
    if cached is not None:  # (one made before videos simply has none: it is not made again for that)
        job.cached, job.karaoke = True, kara.summary(cached, state.karaoke.dir(kid))
        return

    _peak_vram_reset()
    sdir = store.source_dir(src.key)
    sdir.mkdir(parents=True, exist_ok=True)
    store.write_source_info(src)
    want_video = bool(req.karaoke_video) and _video_on()
    if want_video:
        if req.force:
            for old in list(sdir.glob("video.*")):
                old.unlink(missing_ok=True)
        # The cover's machinery and its shared video.mp4: fetched next to the audio stages.
        _start_video(job, src, sdir)
    lead = _stems_and_lead(job, src, sdir, timed)
    vocal = sdir / ("lead.wav" if lead["used"] else "vocals.wav")
    out = state.karaoke.dir(kid)
    out.mkdir(parents=True, exist_ok=True)
    (out / kara.META_FILE).unlink(missing_ok=True)  # made again: not a finished song until it is written
    (out / kara.VIDEO_FILE).unlink(missing_ok=True)
    for old in (*out.glob("karaoke.k*.m4a"), *out.glob("play_karaoke*.pcm*")):  # keys (and the PCM of them) made before
        old.unlink(missing_ok=True)
    parts = _karaoke_parts(sdir, lead["used"])
    lengths = [s for s in (kara.wav_seconds(p) for p in parts) if s]
    duration = min(lengths) if lengths else (src.duration_s or _wav_seconds(vocal) or 0.0)
    lookup = LyricsLookup(job, src, vocal, out, _wav_seconds(vocal) or src.duration_s).start()

    try:
        def reference() -> tuple[Any, list[dict[str, Any]]]:
            f0 = _gpu_stage(job, "reference", vocal, src.duration_s,
                            lambda device: b.karaoke_f0(vocal, "cpu" if device == "cpu" else None))
            job.converted.set()  # the lyrics' ASR spot check may go on
            return _karaoke_curve(f0, vocal, duration)

        midi, pitch_notes = timed("reference", reference)
        encoded = timed("encode", lambda: b.karaoke_encode(parts, out / kara.BACKING_FILE))
        if lookup.running():
            _set(job, "lyrics")
            t_wait = time.perf_counter()
            lookup.wait(job.cancel)
            timings["lyrics_wait_s"] = round(time.perf_counter() - t_wait, 2)
        if lookup.seconds is not None:
            timings["lyrics_s"] = lookup.seconds
        (out / "lyrics.lrc").unlink(missing_ok=True)  # the lookup's own file; the lines are in reference.json
        lyrics_meta = lookup.meta
        voiced = [not math.isnan(v) for v in midi]
        found = kara.found_lines(lyrics_meta, voiced, melody.CURVE_HZ)
        run, why = _lyrics_runner(job, vocal, out, duration)
        t_lyr = time.perf_counter()
        lyr = lyricstage.build(found, (lyrics_meta or {}).get("provider"), midi, duration,
                               lyricstage.Options.of(req.karaoke_lyrics), run, melody.CURVE_HZ)
        if run is not None:
            timings["lyrics_check_s"] = round(time.perf_counter() - t_lyr, 2)
        else:
            lyr.info["skipped"] = why
    finally:
        _give_gpu_back(job)  # the last GPU stage of a karaoke job
        (out / "lead16k.npy").unlink(missing_ok=True)
    if want_video:
        video = _karaoke_video(job, src, sdir, out, duration, timings)
    else:
        why = "videos are off (SING_VIDEO=0)" if not _video_on() else "not asked for (karaoke_video: false)"
        video = {"video": None, "video_error": why}
    notes = lyricstage.L.merge_notes(pitch_notes, lyr.notes, lyr.spans)
    notes_method = melody.NOTES_METHOD if not lyr.notes else f"{lyricstage.L.NOTES_METHOD}+{melody.NOTES_METHOD}"
    quality = _karaoke_quality(midi, len(notes), lead["used"])
    artist = kara.song_artist(src.artist, lyrics_meta, lyr.block)
    ref = kara.reference(kid, src.title, artist, duration, melody.curve_json(midi), melody.CURVE_HZ,
                         notes, lyr.block, quality, notes_method, lyr.made)
    WorkersKaraokeReferenceV2.model_validate(ref)  # the format (karaoke.ts) before anyone reads it
    state.karaoke.write_json(kid, kara.REFERENCE_FILE, ref)
    timings["total_s"] = round(time.perf_counter() - t_job, 2)
    g = job.gpu
    if g is not None and g.waited_total_s:
        timings["gpu_wait_s"] = round(g.waited_total_s, 2)
    meta = {
        "id": kid,
        "title": src.title,
        "artist": artist,
        "duration_s": ref["duration_s"],
        "quality": quality,
        "source": src.public(),
        "lead_split": lead,
        "lyrics": None if lyrics_meta is None else {k: v for k, v in lyrics_meta.items() if k != "lines"},
        "lyrics_input": _lyrics_hints_of(src),
        "lyrics_check": {**lyr.made, **lyr.info},
        "backing": {"parts": [p.name for p in parts], **encoded},
        **video,
        "engine": {"backend": b.name, "model": b.model_name, "device": b.device,
                   "separator": _separator_of(b), "lead": _lead_tag_of(b) if lead["used"] else None},
        "timings": timings,
        "peak_vram_mb": (g.peak_allocated_mb if g is not None else None) or _peak_vram_mb(),
        "gpu": g.summary() if g is not None else None,
        "created_at": now_iso(),
    }
    state.karaoke.write_json(kid, kara.META_FILE, meta)  # last: the song is there from now on
    state.cache.touch(karaoke=kid, source=src.key)
    job.karaoke = kara.summary(meta, out)
    log.info("karaoke %s ready: %s, %d notes (%d from lyrics), lyrics %s, quality %s (%s)", kid, src.title,
             len(notes), len(lyr.notes), lyr.made.get("lyrics"), "ok" if quality["ok"] else quality["reason"], timings)


def _lyrics_hints_of(src: Source) -> dict[str, Any]:
    from lyrics import hints_of

    return hints_of(src)


def _queued() -> bool:
    with state.lock:
        return any(state.jobs[j].state == "queued" for j in state.order if j in state.jobs)


def worker_loop() -> None:
    kept = False  # the models were kept for a queued job
    while not state.stopping.is_set():
        try:
            job_id = state.pending.get(timeout=0.5)
        except queue.Empty:
            if kept and not _queued():  # the jobs they were kept for were cancelled
                kept = False
                try:
                    state.backend.idle(False)
                except Exception:  # noqa: BLE001
                    log.exception("could not let go of the models")
            continue
        job = state.jobs.get(job_id)
        if job is None:
            continue
        # A singer's pitch on the card (POST /karaoke/voice) is short: a job waits for the one that
        # is running to end; while a job runs, the next singer's goes to the CPU instead.
        with state.voice_lock:
            ran = _run_one(job)
        if ran is not None:
            kept = ran


def _run_one(job: Job) -> bool | None:
    """Runs a queued job to its end (``None``: it was not queued any more); whether more are queued."""
    with state.lock:  # prefetch_loop marks a queued job's prefetch under it
        if job.state != "queued":
            return None
        job.state, job.started_at = "running", now_iso()
        state.running = job.id
    more = False
    try:
        run_job(job)
        job.state, job.progress, job.stage = "done", 1.0, "done"
    except Cancelled:
        job.state, job.error = "cancelled", "cancelled"
    except JobError as e:
        job.state, job.error = "failed", str(e)
        log.info("job %s failed: %s", job.id, e)
    except Exception as e:  # noqa: BLE001
        log.exception("job %s crashed", job.id)
        job.state, job.error = "failed", f"{type(e).__name__}: {e}"[:500]
    finally:
        job.finished_at = now_iso()
        state.running = None
        more = _queued()
        try:
            state.backend.idle(more)  # here: a job that failed no longer holds the models through its traceback
        except Exception:  # noqa: BLE001
            log.exception("could not let go of the models")
        if state.janitor is not None:
            state.janitor.poke()
    return more


def _protected() -> Protected:
    """The songs and downloads of queued and running jobs (cache.py never removes them). A queued
    search the worker has seen before already names its download."""
    p = Protected()
    with state.lock:
        jobs = [state.jobs[j] for j in state.order if j in state.jobs]
    for job in jobs:
        if job.state not in ("queued", "running"):
            continue
        if job.song_id:
            p.songs.add(safe_id(job.song_id, 96))
        if job.karaoke_id:
            p.karaoke.add(safe_id(job.karaoke_id, 96))
        key = (job.source or {}).get("key")
        req = job.request
        if not key and req.query:
            key = state.store.query_source(req.query)
        if key:
            p.sources.add(safe_id(key, 96))
            if job.is_karaoke:
                p.karaoke.add(karaoke_id(key))
            else:
                p.songs.add(song_id(key, req.pitch, req.key, req.backing))
    return p


def _prune() -> None:
    with state.lock:
        while len(state.order) > MAX_JOBS_KEPT:
            old = next((j for j in state.order if state.jobs[j].state not in ("queued", "running")), None)
            if old is None:
                break
            state.order.remove(old)
            state.jobs.pop(old, None)


def _recover_speech() -> None:
    """A worker that went away mid-window (restarted, crashed) leaves her voice offline until it
    reloads by itself: bring it back as soon as this one is up."""
    for url in _offload_urls():
        try:
            health = state.busy_get(f"{url}/health", 2.0)
            if health.get("offloaded") and health.get("reason") == "sing":
                log.info("%s is still offloaded for a song; asking it back", url)
                state.offload_post(f"{url}/reload", {}, env_float("SING_RELOAD_TIMEOUT_S", 300.0))
        except Exception as e:  # noqa: BLE001 - it comes back by itself anyway
            log.info("cannot ask %s whether it is back: %s", url, e)


def _queued_behind(job: Job) -> list[str]:
    """The jobs queued behind ``job`` (hostd counts it urgent when one of them is)."""
    with state.lock:
        return [j for j in state.order if j != job.id and j in state.jobs and state.jobs[j].state == "queued"]


def _choose_arbitration(profile: Profile) -> Any:
    """``SING_GPU_ARBITER``: ``self`` (the default) or ``hostd``. Anything else, or ``hostd`` without
    a hostd to ask, stops the start: a wrong switch must not quietly become self-arbitration."""
    which = arbiter_from_env()
    if which == "self":
        return _SELF
    if not hostd_available():
        raise SystemExit("SING_GPU_ARBITER=hostd, but no hostd is configured for this worker "
                         "(MIYORIA_HOSTD_URL and MIYORIA_SERVICE_TOKEN): start it under hostd, or unset "
                         "SING_GPU_ARBITER to let the worker decide by itself")
    return HostdArbitration(lambda: state.backend, profile, stage_pauses=_stage_pauses,
                            stage_uses_gpu=_stage_uses_gpu, queued=_queued_behind)


@asynccontextmanager
async def lifespan(app: FastAPI):
    root = Path(os.environ.get("SING_DATA_DIR", REPO / "data" / "songs"))
    os.environ.setdefault("SING_YTDLP_CACHE", str(root / "_ytdlp-cache"))
    lib = os.environ.get("SING_LIBRARY_DIR")
    state.store = Store(root, Path(lib) if lib else None)
    state.karaoke = KaraokeStore(root)
    state.jobs, state.order = {}, []
    state.pending = queue.Queue()
    state.lock = threading.Lock()
    state.voice_lock = threading.Lock()
    state.voice_dir = root / VOICE_DIR
    _sweep_voice()  # what a crash left behind
    state.stopping = threading.Event()
    t0 = time.perf_counter()
    state.backend = make_backend(state.store)
    log.info("backend %s ready in %.1fs (%s on %s), songs in %s", state.backend.name, time.perf_counter() - t0,
             state.backend.model_name, state.backend.device, root)
    preimport = getattr(state.backend, "preimport", None)
    if preimport is not None:  # what the first song would otherwise load (engine.preimport)
        threading.Thread(target=preimport, name="sing-preimport", daemon=True).start()
    state.machine = Machine(lambda: state.backend, Profile(root), Audience(),
                            lambda url, timeout: state.busy_get(url, timeout))
    state.arbitration = _choose_arbitration(state.machine.profile)
    state.arbitration.startup()
    state.cache = Cache(root, state.store.library, _protected, state.store.forget_sources)
    # The cache cleans up after itself on its own thread: now, after every job and every hour.
    state.janitor = Janitor(state.cache, env_float("SING_CACHE_EVERY_S", 3600.0)).start()
    state.thread = threading.Thread(target=worker_loop, name="sing-worker", daemon=True)
    state.thread.start()
    threading.Thread(target=prefetch_loop, name="sing-prefetch", daemon=True).start()
    state.streams = _new_streams()
    threading.Thread(target=_stream_sweeper, args=(state.stopping, state.streams), name="sing-stream-sweep",
                     daemon=True).start()
    yield
    state.janitor.stop()
    state.stopping.set()
    for j in state.jobs.values():
        j.cancel.set()


app = FastAPI(title="Miyoria song worker", lifespan=lifespan)
if service_auth is not None:
    service_auth.install(app)  # every route needs the bearer token when hostd set one


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.exception_handler(StarletteHTTPException)
async def _http_exc(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    return _error(exc.status_code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def _validation_exc(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    return _error(400, f"invalid request: {where or 'body'}: {first.get('msg', 'bad value')}")


@app.post("/jobs")
async def submit(req: JobRequest) -> JSONResponse:
    given = [v for v in (req.query, req.url, req.path) if v and v.strip()]
    if len(given) != 1:
        return _error(400, "give exactly one of query, url or path")
    if req.url and not allowed_url(req.url.strip()):
        return _error(400, "that link is not on an allowed host (SING_URL_HOSTS)")
    job = Job(id=secrets.token_hex(6), request=req)
    # Cache hit without resolving: a known query / library path with the same pitch settings.
    if not req.force and job.is_karaoke:
        key = state.store.query_source(req.query) if req.query else None
        if key:
            kid = karaoke_id(key)
            state.cache.touch(karaoke=kid, source=key)
            meta = _karaoke_cached(kid)
            if meta is not None:
                job.state, job.stage, job.progress, job.cached = "done", "done", 1.0, True
                job.karaoke_id, job.karaoke = kid, karaoke_summary(meta, state.karaoke.dir(kid))
                job.source, job.finished_at = state.store.source_info(key), now_iso()
    elif not req.force:
        key = None
        if req.query:
            key = state.store.query_source(req.query)
        sid = song_id(key, req.pitch, req.key, req.backing) if key else None
        if sid:
            state.cache.touch(song=sid, source=key)  # first: the cleanup leaves it alone from here on
        meta = state.store.meta(sid) if sid else None
        info = state.store.source_info(key or "") if meta is not None else None
        # (A song from before videos existed goes through the queue to get its video.)
        if meta is not None and not _needs_video(meta, (info or {}).get("kind")) and not _other_voice(meta, state.backend):
            job.state, job.stage, job.progress, job.cached = "done", "done", 1.0, True
            job.song_id, job.source, job.finished_at = sid, info, now_iso()
    with state.lock:
        state.jobs[job.id] = job
        state.order.append(job.id)
    if job.state == "queued":
        state.pending.put(job.id)
    _prune()
    return JSONResponse({"job": _public(job)})


@app.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    with state.lock:
        ids = list(reversed(state.order))
    return {"jobs": [_public(state.jobs[i]) for i in ids if i in state.jobs]}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    job = state.jobs.get(job_id)
    if job is None:
        return _error(404, f"no job {job_id}")
    return JSONResponse({"job": _public(job)})


@app.post("/jobs/{job_id}/exclusive")
async def exclusive_go(job_id: str) -> JSONResponse:
    job = state.jobs.get(job_id)
    if job is None:
        return _error(404, f"no job {job_id}")
    job.go.set()
    return JSONResponse({"job": _public(job)})


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str) -> JSONResponse:
    job = state.jobs.get(job_id)
    if job is None:
        return _error(404, f"no job {job_id}")
    with state.lock:  # the worker takes a queued job under it: never cancel one it just started
        if job.state == "queued":
            job.state, job.error, job.finished_at = "cancelled", "cancelled", now_iso()
            job.prefetched = None
        elif job.state == "running":
            job.cancel.set()
    return JSONResponse({"job": _public(job)})


@app.get("/songs")
async def list_songs() -> dict[str, Any]:
    return {"songs": state.store.songs()}


@app.get("/songs/{sid}")
async def get_song(sid: str) -> JSONResponse:
    meta = state.store.meta(safe_id(sid, 96))
    if meta is None:
        return _error(404, f"no song {sid}")
    return JSONResponse({"song": meta})


@app.post("/songs/{sid}/lyrics")
def refetch_lyrics(sid: str, req: LyricsRequest | None = None) -> JSONResponse:
    """Look the lyrics of a cached song up again, without touching its audio.

    Uses the lookup input kept in the song's meta (``lyrics_input``; for a song made before that, the
    link's metadata is read again), then ``title`` / ``artist`` of the request as extra hints. A new result
    replaces ``lyrics`` in the meta and ``lyrics.lrc``; no result leaves what the song has. Blocks up to
    SING_LYRICS_BUDGET_S (45) seconds; the job queue is not involved.
    """
    req = req or LyricsRequest()
    sid = safe_id(sid, 96)
    meta = state.store.meta(sid)
    if meta is None:
        return _error(404, f"no song {sid}")
    b = state.backend
    src_info = meta.get("source") or {}
    hints: dict[str, Any] = dict(meta.get("lyrics_input") or {})
    if not hints.get("raw_title") and src_info.get("url"):
        try:
            hints = {**b.lyrics_hints(src_info["url"]), **hints}
        except Exception as e:
            log.info("lyrics hints for %s: %s", sid, e)
    hints.setdefault("key", src_info.get("key") or sid)
    hints.setdefault("title", meta.get("title") or src_info.get("title"))
    hints.setdefault("artist", meta.get("artist") or src_info.get("artist"))
    hints.setdefault("uploader", src_info.get("uploader"))
    if req.title:
        hints["title"], hints["track"] = req.title, req.title
        hints["artist"], hints["meta_artist"] = req.artist, req.artist
    src = Source(key=hints["key"], kind=str(src_info.get("kind") or "url"), title=str(hints.get("title") or ""),
                 artist=hints.get("artist"), duration_s=meta.get("duration_s"), url=src_info.get("url"),
                 uploader=hints.get("uploader"),
                 extra={k: hints[k] for k in ("raw_title", "track", "meta_artist", "alt_title", "description", "tags")
                        if k in hints})
    state.cache.touch(song=sid)
    sdir = state.store.song_dir(sid)
    # The original singer, as in a job: the song's own vocals.wav is her converted voice.
    src_dir = state.store.source_dir(hints["key"])
    heard = next((p for p in (src_dir / "lead.wav", src_dir / "vocals.wav") if p.exists()), None)
    found = b.lyrics(src, meta.get("duration_s"), heard, req.fresh)
    old = meta.get("lyrics")
    if not found:
        return JSONResponse({"found": False, "kept": bool(old), "lyrics": old and {k: v for k, v in old.items() if k != "lines"}})
    meta["lyrics"] = _lyrics_meta(found, sdir, heard)
    meta["lyrics_input"] = {k: v for k, v in hints.items() if v}
    state.store.write_meta(sid, meta)
    return JSONResponse({"found": True, "previous": {"provider": (old or {}).get("provider"),
                                                     "track": (old or {}).get("track")},
                         "lyrics": {k: v for k, v in meta["lyrics"].items() if k != "lines"},
                         "lines": len(meta["lyrics"]["lines"])})


@app.get("/songs/{sid}/files/{name}")
async def get_file(sid: str, name: str):
    if name not in SONG_FILES:
        return _error(404, f"no file {name}")
    p = state.store.song_dir(safe_id(sid, 96)) / name
    if p.exists():
        state.cache.touch(song=sid)  # she is about to sing it (or play a clip of it)
    if not p.exists():  # (also when the cleanup took it just now: asking for the song again makes it again)
        return _error(404, f"song {sid} has no {name}")
    headers = {"X-Sample-Rate": str(PLAY_RATE)} if name.endswith(".pcm") else {}
    media = SONG_FILES[name] + (f"; rate={PLAY_RATE}; channels=1" if name.endswith(".pcm") else "")
    return FileResponse(p, media_type=media, headers=headers)


@app.get("/karaoke")
async def list_karaoke() -> dict[str, Any]:
    """The karaoke songs (not her covers: ``GET /songs`` never lists them), newest first."""
    return {"karaoke": state.karaoke.songs()}


@app.get("/karaoke/{kid}/files/{name}")
async def get_karaoke_file(kid: str, name: str):
    import karaoke as kara
    from starlette.concurrency import run_in_threadpool

    play_from = kara.play_source(name)
    if name not in KARAOKE_SERVED_FILES and not kara.is_key_file(name) and play_from is None:
        return _error(404, f"no file {name}")
    kid = safe_id(kid, 96)
    if state.karaoke.meta(kid) is None:  # unfinished, or being made again
        return _error(404, f"no karaoke song {kid}")
    p = state.karaoke.dir(kid) / name
    state.cache.touch(karaoke=kid)  # Core is about to hand it to a singer
    if play_from is not None:
        src = state.karaoke.dir(kid) / play_from
        if not p.exists():
            if not src.is_file():  # a key that was never made: Core asks for it first
                return _error(404, f"karaoke song {kid} has no {play_from}")
            with state.lock:
                lock = _key_locks.setdefault(kid, threading.Lock())

            def make() -> None:
                with lock:
                    if not p.exists():  # a request before this one made it
                        kara.decode_play(src, p)

            try:
                await run_in_threadpool(make)
            except JobError as e:
                return _error(503, str(e))
            except FileNotFoundError:  # the song was cleaned up meanwhile
                return _error(404, f"karaoke song {kid} has no {play_from}")
        return FileResponse(p, media_type=f"audio/L16; rate={kara.PLAY_RATE}; channels=1",
                            headers={"X-Sample-Rate": str(kara.PLAY_RATE)})
    if not p.exists():  # (video.mp4: a song without one, or made before videos)
        return _error(404, f"karaoke song {kid} has no {name}")
    # FileResponse answers range requests: the browser streams the video and seeks in it.
    return FileResponse(p, media_type=KARAOKE_SERVED_FILES.get(name, "audio/mp4"))


_key_locks: dict[str, threading.Lock] = {}


@app.post("/karaoke/{kid}/keys")
def make_karaoke_key(kid: str, req: KaraokeKeyRequest):
    """The song's backing in another key (``semitones`` from it), made once: a singer's key change.
    The reference is not made again: Core and the browser move its curve and notes by the same."""
    import karaoke as kara

    kid = safe_id(kid, 96)
    if state.karaoke.meta(kid) is None:
        return _error(404, f"no karaoke song {kid}")
    name = kara.key_file(req.semitones)
    d = state.karaoke.dir(kid)
    with state.lock:
        lock = _key_locks.setdefault(kid, threading.Lock())
    with lock:
        state.cache.touch(karaoke=kid)
        if (d / name).is_file():
            return {"file": name, "semitones": req.semitones, "cached": True,
                    "method": "none" if req.semitones == 0 else "kept"}
        try:
            method = state.backend.karaoke_shift(d / kara.BACKING_FILE, d / name, req.semitones)
        except JobError as e:
            return _error(503, str(e))
        log.info("karaoke %s: backing moved by %+d semitones (%s)", kid, req.semitones, method)
        return {"file": name, "semitones": req.semitones, "cached": False, "method": method}


# ── a singer's pitch (POST /karaoke/voice) ───────────────────────────────────


def _sweep_voice() -> None:
    """Recordings older than karaoke.VOICE_KEEP_S (a crash between storing and deleting one)."""
    import karaoke as kara

    if state.voice_dir is not None:
        gone = kara.sweep_voice(state.voice_dir)
        if gone:
            log.info("deleted %d karaoke recording(s) left behind", gone)


def _device_label(placed: str) -> str:
    """``cuda`` or ``cpu``: where RMVPE ran when it was placed on ``placed`` (``gpu`` | ``cpu``)."""
    if placed == "cpu":
        return "cpu"
    b = state.backend
    try:
        if b.uses_cuda():
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return str(getattr(b, "device", "cpu"))


def _voice_on_gpu(wav: Path, seconds: float) -> tuple[Any, str] | None:
    """RMVPE on the recording as a GPU stage of a job of its own, which no list shows and the queue
    never counts: placed by the arbitration (self or hostd) as a karaoke job's stage ``reference``
    (RMVPE's VRAM profile; share only, never urgent, never her voice offline). Not placed within
    SING_KARAOKE_VOICE_WAIT_S (no room, hostd not answering): ``None``, and it goes to the CPU."""
    b, arb = state.backend, _arbitration()
    pseudo = Job(id=f"voice-{secrets.token_hex(4)}", request=JobRequest(query="karaoke voice", purpose="karaoke"))
    started = threading.Event()
    placed: dict[str, str] = {}

    def run(device: str) -> Any:
        started.set()
        placed["device"] = device
        return b.karaoke_f0(wav, "cpu" if device == "cpu" else None)

    def too_late() -> None:
        if not started.is_set():
            pseudo.cancel.set()  # the placement stops waiting (``_place``, lease.py ``place``)

    timer = threading.Timer(env_float("SING_KARAOKE_VOICE_WAIT_S", 5.0), too_late)
    timer.daemon = True
    timer.start()
    try:
        f0 = _gpu_stage(pseudo, "reference", wav, seconds, run)
    except Exception as e:
        if started.is_set():
            raise  # RMVPE itself failed
        log.info("karaoke voice: not placed on the card in time (%s); on the CPU", type(e).__name__)
        return None
    finally:
        timer.cancel()
        if pseudo.gpu is not None:
            try:
                _give_gpu_back(pseudo)
                arb.finish(pseudo)
            except Exception:  # noqa: BLE001
                log.exception("karaoke voice: giving the card back failed")
    return f0, _device_label(placed.get("device", "gpu"))


def _voice_f0(wav: Path, seconds: float) -> tuple[Any, str]:
    """(RMVPE's F0 of the recording, where it ran). The card only when no job is running (the job
    loop holds ``voice_lock`` around every job, and a job about to start waits for this one); while
    one runs, the CPU at once, asking nobody: the job is never paused for a singer."""
    if state.voice_lock.acquire(blocking=False):
        try:
            got = _voice_on_gpu(wav, seconds)
        finally:
            state.voice_lock.release()
        if got is not None:
            return got
    return state.backend.karaoke_f0(wav, "cpu"), "cpu"


def _voice_answer(raw: Path, wav: Path) -> JSONResponse:
    """Decodes the stored recording, reads its pitch and answers WorkersKaraokeVoicePitch."""
    import karaoke as kara
    import melody
    from contracts import WorkersKaraokeVoicePitch

    max_s = env_float("SING_MAX_SECONDS", 480.0) + 30.0
    try:
        used = kara.decode_voice(raw, wav, max_s + 1)
        seconds = _wav_seconds(used)
        if not seconds:
            return _error(400, "the recording is empty or cannot be decoded")
        if seconds > max_s:
            return _error(413, f"the recording is longer than {max_s:.0f} s")
        mono, sr = kara.mono_of(used)
    except JobError as e:
        return _error(503, str(e))
    except (ValueError, OSError, EOFError, wave.Error):
        return _error(400, "the recording cannot be decoded")
    t0 = time.perf_counter()
    try:
        f0, device = _voice_f0(used, seconds)
    except Exception as e:  # noqa: BLE001
        log.warning("karaoke voice: the pitch could not be read: %s", type(e).__name__)
        return _error(503, "the pitch of the recording could not be read")
    got = kara.voice_pitch(f0, mono, sr, seconds, clean=os.environ.get("SING_F0_CLEAN", "1") != "0")
    answer = {"hz": melody.CURVE_HZ, "midi": got["midi"], "seconds": round(seconds, 3),
              "level_db": got["level_db"], "floor_db": got["floor_db"], "device": device,
              "method": kara.PITCH_METHOD}
    WorkersKaraokeVoicePitch.model_validate(answer)  # the format (karaoke.ts) before Core reads it
    # (Its length and where it ran: nothing of what was sung.)
    log.info("karaoke voice: %.1f s on %s in %.2f s", seconds, device, time.perf_counter() - t0)
    return JSONResponse(answer)


@app.post("/karaoke/voice")
async def karaoke_voice(request: Request) -> JSONResponse:
    """The pitch of one recording of a singer's microphone (the body; WorkersKaraokeVoicePitch), for
    the official score. Kept only until it is answered, under the data dir's ``_voice`` (never a
    song, never in the cache), and never logged."""
    import karaoke as kara
    from starlette.concurrency import run_in_threadpool

    ext = kara.voice_type(request.headers.get("content-type"))
    if ext is None:
        return _error(415, "the recording must be audio/webm, audio/ogg, audio/mp4 or audio/wav")
    too_big = f"the recording is larger than {kara.VOICE_MAX_BYTES} bytes"
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        return _error(400, "invalid content-length")
    if declared > kara.VOICE_MAX_BYTES:
        return _error(413, too_big)
    _sweep_voice()
    folder = state.voice_dir or (state.store.root / kara.VOICE_DIR)
    folder.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(12)
    raw, wav = folder / f"{token}{ext}", folder / f"{token}.16k.wav"
    try:
        size = 0
        with raw.open("wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > kara.VOICE_MAX_BYTES:
                    return _error(413, too_big)
                f.write(chunk)
        if size == 0:
            return _error(400, "the recording is empty")
        return await run_in_threadpool(_voice_answer, raw, wav)
    finally:
        raw.unlink(missing_ok=True)
        wav.unlink(missing_ok=True)


# ── a room's live voices (POST /karaoke/stream) ──────────────────────────────


class _CardFailed(RuntimeError):
    """The stream's pitch tracker failed on the card (out of VRAM included): the request goes on
    on the CPU instead of waiting for the card again."""


def _stream_release() -> None:
    release = getattr(state.backend, "karaoke_stream_release", None)
    if release is not None:
        release()


def _new_streams() -> Any:
    import karaoke_stream

    return karaoke_stream.Streams(on_empty=_stream_release)


def _stream_book() -> Any:
    if state.streams is None:
        state.streams = _new_streams()
    return state.streams


def _stream_limits() -> Any:
    import karaoke_stream

    return karaoke_stream.Limits(max_streams=env_int("SING_KARAOKE_STREAMS_MAX", 16),
                                 max_seconds=env_float("SING_MAX_SECONDS", 480.0) + 30.0,
                                 idle_s=env_float("SING_KARAOKE_STREAM_IDLE_S", 30.0))


def _stream_sweeper(stop: threading.Event, book: Any) -> None:
    """Forgets the streams nobody sends to, also when no request comes (and so the tracker)."""
    while not stop.wait(5.0):
        try:
            if len(book):
                book.sweep(env_float("SING_KARAOKE_STREAM_IDLE_S", 30.0))
        except Exception:  # noqa: BLE001
            log.exception("karaoke stream: the sweep failed")


def _stream_on_gpu(windows: list[Any], seconds: float) -> tuple[list[Any], str] | None:
    """The windows of one request on the card, as one placement (the same invisible karaoke job as
    ``_voice_on_gpu``: stage ``reference``, share only, never urgent, never her voice offline). Not
    placed within SING_KARAOKE_STREAM_WAIT_S, or failed there: ``None``, and they go to the CPU."""
    import karaoke_stream

    b, arb = state.backend, _arbitration()
    pseudo = Job(id=f"stream-{secrets.token_hex(4)}", request=JobRequest(query="karaoke stream", purpose="karaoke"))
    started = threading.Event()
    placed: dict[str, str] = {}

    def run(device: str) -> list[Any]:
        started.set()
        placed["device"] = device
        dev = "cpu" if device == "cpu" else None
        try:
            return [b.karaoke_f0_audio(w.x, karaoke_stream.RATE, dev) for w in windows]
        except Exception as e:
            if dev == "cpu":
                raise
            raise _CardFailed(f"the stream's pitch failed on the card ({type(e).__name__})") from e

    def too_late() -> None:
        if not started.is_set():
            pseudo.cancel.set()  # the placement stops waiting (``_place``, lease.py ``place``)

    timer = threading.Timer(env_float("SING_KARAOKE_STREAM_WAIT_S", 0.3), too_late)
    timer.daemon = True
    timer.start()
    try:
        f0s = _gpu_stage(pseudo, "reference", Path("karaoke-stream"), max(seconds, 0.01), run)
    except _CardFailed as e:
        log.warning("karaoke stream: %s; on the CPU", e)
        try:
            b.karaoke_stream_release()  # what is left of it on the card
        except Exception:  # noqa: BLE001
            pass
        return None
    except Exception as e:
        if started.is_set():
            raise  # the tracker itself failed (placed on the CPU)
        log.debug("karaoke stream: not placed on the card in time (%s); on the CPU", type(e).__name__)
        return None
    finally:
        timer.cancel()
        if pseudo.gpu is not None:
            try:
                _give_gpu_back(pseudo)
                arb.finish(pseudo)
            except Exception:  # noqa: BLE001
                log.exception("karaoke stream: giving the card back failed")
    return f0s, _device_label(placed.get("device", "gpu"))


def _stream_f0(windows: list[Any], seconds: float) -> tuple[list[Any], str]:
    """(RMVPE's F0 of every window, where it ran), as ``_voice_f0`` places a recording: the card
    only when no job is running; while one runs, the CPU at once, the job is never paused."""
    import karaoke_stream

    if state.voice_lock.acquire(blocking=False):
        try:
            got = _stream_on_gpu(windows, seconds)
        finally:
            state.voice_lock.release()
        if got is not None:
            return got
    b = state.backend
    return [b.karaoke_f0_audio(w.x, karaoke_stream.RATE, "cpu") for w in windows], "cpu"


def _stream_answer(req: Any) -> JSONResponse:
    """Decodes every chunk, appends them, reads the pitch of the new windows (one placement for the
    whole request) and answers WorkersKaraokeStreamAnswer."""
    import karaoke as kara
    import karaoke_stream
    import melody
    from contracts import WorkersKaraokeStreamAnswer

    try:
        chunks = [karaoke_stream.Chunk(c.stream, c.at, karaoke_stream.decode_chunk(c.audio), c.end)
                  for c in req.chunks]
    except karaoke_stream.ChunkError as e:
        return _error(e.status, str(e))
    book, limits = _stream_book(), _stream_limits()
    book.sweep(limits.idle_s)
    clean = os.environ.get("SING_F0_CLEAN", "1") != "0"
    t0 = time.perf_counter()
    device = "cpu"
    with book.room(req.room):
        plan = book.plan(req.room, chunks, req.drop, limits)
        f0s: list[Any] = []
        if plan.windows:
            try:
                f0s, device = _stream_f0(plan.windows, plan.seconds)
            except Exception as e:  # noqa: BLE001
                log.warning("karaoke stream: the pitch could not be read: %s", type(e).__name__)
                return _error(503, "the pitch of the streams could not be read")
        frames = book.commit(plan, f0s, clean)
    answer = WorkersKaraokeStreamAnswer.model_validate(
        {"hz": melody.CURVE_HZ, "streams": frames, "lost": plan.lost, "device": device,
         "method": kara.PITCH_METHOD})  # the format (karaoke.ts) before Core reads it
    # (How much and where: nothing of what was sung.)
    log.debug("karaoke stream: %d stream(s), %d lost, %.2f s read on %s in %.3f s", len(frames), len(plan.lost),
              plan.seconds, device, time.perf_counter() - t0)
    return JSONResponse(answer.model_dump(by_alias=True, mode="json"))


@app.post("/karaoke/stream")
async def karaoke_stream_post(request: Request) -> JSONResponse:
    """New audio of a room's singers (WorkersKaraokeStreamRequest) -> their pitch so far
    (WorkersKaraokeStreamAnswer). In memory only: never written, never logged."""
    import karaoke_stream
    from contracts import WorkersKaraokeStreamRequest
    from pydantic import ValidationError
    from starlette.concurrency import run_in_threadpool

    too_big = f"the request is larger than {karaoke_stream.MAX_BODY} bytes"
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        return _error(400, "invalid content-length")
    if declared > karaoke_stream.MAX_BODY:
        return _error(413, too_big)
    body = bytearray()
    async for part in request.stream():
        body += part
        if len(body) > karaoke_stream.MAX_BODY:
            return _error(413, too_big)
    try:
        req = WorkersKaraokeStreamRequest.model_validate_json(bytes(body))
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        return _error(400, f"invalid request: {where or 'body'}: {first.get('msg', 'bad value')}")
    return await run_in_threadpool(_stream_answer, req)


@app.post("/gpu/context")
async def gpu_context(req: GpuContext) -> dict[str, Any]:
    return _arbitration().context(req)


@app.get("/cache")
def cache_status() -> dict[str, Any]:
    """The song cache: its size, songs and downloads, the limits, and what the last cleanup did."""
    return state.cache.status()


@app.post("/cache/prune")
def cache_prune(req: PruneRequest | None = None, dry_run: bool = False) -> dict[str, Any]:
    """Runs the cleanup now (``dry_run`` in the body or the query: nothing is removed)."""
    return state.cache.prune(dry_run=dry_run or bool(req and req.dry_run))


@app.get("/library")
async def library() -> dict[str, Any]:
    return {"entries": state.store.library_entries()}


@app.get("/health")
async def health() -> dict[str, Any]:
    b = state.backend
    queued = sum(1 for j in state.jobs.values() if j.state == "queued")
    info: dict[str, Any] = {"status": "ok", "model": b.model_name, "device": b.device, "backend": b.name,
                            "busy": state.running is not None, "queued": queued}
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        info["vram_allocated_mb"] = round(torch.cuda.memory_allocated() / 2**20)
    job = state.jobs.get(state.running or "")
    info["gpu"] = _arbitration().health(job)
    return info


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # asks /busy several times a second while a job runs
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8005")), log_level="info")


if __name__ == "__main__":
    main()
