# Generated, do not edit. Made from packages/contracts/schema/workers.json by
#     python workers/gen_contracts.py
# with datamodel-code-generator 0.96.0 (pinned in workers/requirements-contracts.txt).
# To change a model, change its zod schema in packages/contracts/workers/src, run
# `pnpm contracts:gen`, then the command above.

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, conint, constr


class WorkersAsrHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    model: str | None = None
    device: str | None = None
    backend: str | None = None
    offloaded: bool
    loading: bool
    released_mb: float | None
    since: float | None = None
    reason: str | None = None
    reload_at: float | None = None
    vram_allocated_mb: float | None = None
    device_total_mb: float | None = None
    device_used_mb: float | None = None
    device_free_mb: float | None = None


class WorkersAsrReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    text: str
    language: str | None = None
    emotion: str | None = None
    audio_events: list[str] = []
    duration_ms: float | None = None


class WorkersBusy(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    busy: conint(ge=0, le=9007199254740991)


class WorkersError(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    error: str


class WorkersHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str


class WorkersLyricsHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    ok: bool


class WorkersLyricsHints(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    key: str | None = None
    raw_title: str | None = None
    title: str | None = None
    artist: str | None = None
    uploader: str | None = None
    channel: str | None = None
    track: str | None = None
    meta_artist: str | None = None
    alt_title: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    duration: float | None = None
    url: str | None = None


class Matched(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    query: str
    duration_s: float | None


class WorkersLyricsResult(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    provider: str
    synced: bool
    lrc: str | None
    plain: str | None
    track: str | None
    artist: str | None
    how: str
    confidence: float
    matched: Matched
    checks: dict[str, Any]
    tried: conint(ge=-9007199254740991, le=9007199254740991)
    llm: dict[str, Any] | None


class WorkersOffloadReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    state: Literal["offloaded", "reloading"]
    offload_ms: float
    already: bool | None = None
    cancelled_reload: bool | None = None
    drained: bool | None = None
    vram_before_mb: float | None = None
    vram_after_mb: float | None = None
    device_used_before_mb: float | None = None
    device_used_after_mb: float | None = None
    released_mb: float | None = None
    since: float | None = None
    reason: str | None = None
    reload_at: float | None = None


class WorkersOffloadRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: str | None = None
    max_s: float | None = None


class WorkersReloadReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    state: Literal["ready", "offloaded"]
    reload_ms: float | None = None
    already: bool | None = None
    cancelled: bool | None = None
    vram_mb: float | None = None
    device_total_mb: float | None = None
    device_used_mb: float | None = None
    device_free_mb: float | None = None


class WorkersSingGpuContext(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    in_voice: bool = False
    listeners: conint(ge=0, le=9007199254740991) = 0
    live: bool = False
    urgent: list[str] = Field([], max_length=200)


class WorkersSingGpuStatus(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    policy: str
    stage: str
    mode: str | None
    code: str | None
    reason: str | None
    free_mb: float | None
    total_mb: float | None
    need_mb: float | None
    step_s: float | None
    baseline_s: float | None
    spilling: bool
    spills: float
    waited_s: float
    silenced_s: float
    silence_est_s: float | None
    silence_max_s: float | None


class Audience(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    in_voice: bool
    listeners: float
    live: bool
    age_s: float | None
    fresh: bool


class Gpu(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    policy: str
    policy_source: str | None = None
    cuda: bool
    total_mb: float | None
    free_mb: float | None
    headroom_mb: float | None = None
    audience: Audience
    learned: dict[str, Any]
    job: WorkersSingGpuStatus | None


class WorkersSingHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    model: str | None = None
    device: str | None = None
    backend: str | None = None
    busy: bool | None = None
    queued: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    vram_allocated_mb: float | None = None
    gpu: Gpu | None = None


class Source(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    title: str
    artist: str | None


class WorkersSingJobRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    query: constr(max_length=200) | None = None
    url: constr(max_length=500) | None = None
    path: constr(max_length=300) | None = None
    title: constr(max_length=120) | None = None
    artist: constr(max_length=120) | None = None
    pitch: conint(ge=-24, le=24) | None = None
    key: conint(ge=-12, le=12) = 0
    backing: Literal["keep", "drop", "convert", "acapella"] = "keep"
    force: bool = False
    exclusive_ack: bool = False


class WorkersSingLibraryEntry(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    path: str
    title: str
    artist: str | None
    split: bool


class WorkersSingLyricLine(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    t: float
    text: str


class Previous(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    provider: str | None
    track: str | None


class WorkersSingLyricsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    found: bool
    previous: Previous | None = None
    kept: bool | None = None
    lyrics: dict[str, Any] | None = None
    lines: conint(ge=-9007199254740991, le=9007199254740991) | None = None


class WorkersSingLyricsRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    title: constr(max_length=200) | None = None
    artist: constr(max_length=200) | None = None
    fresh: bool = False


class WorkersSingOk(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    ok: bool


class WorkersSingPruneRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    dry_run: bool = False


class Lyrics(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    synced: bool
    lines: list[WorkersSingLyricLine]


class Play(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    sample_rate: conint(le=9007199254740991, gt=0)
    samples: conint(ge=-9007199254740991, le=9007199254740991) | None


class Video(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    file: str


class Beats(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    bpm: float
    times: list[float]


class WorkersSingSongMeta(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    title: str
    artist: str | None
    duration_s: float | None
    lyrics: Lyrics | None
    play: Play
    pitch: dict[str, Any]
    timings: dict[str, float]
    peak_vram_mb: float | None
    has_video: bool
    video: Video | None
    backing: str | None = None
    beats: Beats | None = None


class WorkersSingSongReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    song: WorkersSingSongMeta


class WorkersSingSongsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    songs: list[WorkersSingSongMeta]


class WorkersTtsHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    offloaded: bool
    model: str | None = None
    device: str | None = None
    mode: str | None = None
    backend: str | None = None
    sample_rate: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    streaming: bool | None = None
    chunk_size: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    stream_probe: list[str] | None = None
    voices: list[str] | None = None
    instruct_supported: bool | None = None
    clone_mode: str | None = None
    voice_bank: bool | None = None
    released_mb: float | None = None
    engine_pid: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    loading: bool | None = None
    since: float | None = None
    reason: str | None = None
    reload_at: float | None = None
    vram_allocated_mb: float | None = None
    device_total_mb: float | None = None
    device_used_mb: float | None = None
    device_free_mb: float | None = None


class WorkersTtsOffloadRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: str | None = None
    max_s: float | None = None
    drain_s: float | None = None


class WorkersTtsRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    text: str
    language: str | None = None
    emotion: str | None = None
    instruct: str | None = None
    voice: str | None = None
    priority: str | None = None


class WorkersTtsVoice(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    name: str
    ref_text: str | None
    x_vector_only: bool
    references: list[str]


class WorkersTtsVoices(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    mode: str
    default: str | None
    clone_mode: str
    voice_bank: bool
    voices: list[WorkersTtsVoice]


class WorkersTurnHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    smart_turn: bool
    silero: bool
    threshold: float
    errors: dict[str, str]


class WorkersTurnReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    complete: bool
    probability: float
    inference_ms: float | None = None


class WorkersLyricsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    found: bool
    result: WorkersLyricsResult | None


class WorkersSingJob(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    state: Literal["queued", "running", "done", "failed", "cancelled"]
    stage: str
    progress: float
    error: str | None
    song_id: str | None
    cached: bool
    position: float | None
    source: Source | None
    song: WorkersSingSongMeta | None
    exclusive: (
        Literal["waiting", "offloading", "active", "reloading", "done", "shared"] | None
    )
    gpu: WorkersSingGpuStatus | None


class WorkersSingJobReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    job: WorkersSingJob


class WorkersSingJobsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    jobs: list[WorkersSingJob]


class WorkersSingLibrary(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    entries: list[WorkersSingLibraryEntry]
