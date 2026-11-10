"""Where a song job runs, decided from the state of the machine (v3-architecture.md §13.6).

Nothing here knows the size of a card. Every GPU stage asks ``GpuJob.decide`` before it starts and
``GpuJob.tick`` before every diffusion step or Demucs segment, from what can be measured right now:

    the card     total and free VRAM of the whole device, other applications included: NVML
                 (../device_memory.py), never ``mem_get_info`` (blind to other processes on Windows)
                 or ``memory_allocated`` (4.4 GB can hide behind 88 MB)
    the stage    its learned peak (``Profile``), a conservative estimate until a run measured it
    her voice    the speech workers loaded or offloaded (``/health``) and busy (``/busy``)
    the people   she is in voice with someone or live (Core, ``POST /gpu/context``)
    the job      the step time against this machine's learned normal one

Her voice comes first, so the order of what a job tries is (policy ``auto``):

    1. It fits next to her voice: share the card and stop between steps while she speaks.
    2. It does not fit: separation moves to the CPU, conversion waits for room. Neither costs her
       anything, because a waiting job holds no VRAM.
    3. Her voice goes offline only when that helps, and either nobody is listening, the song is
       needed now (the job is ``urgent``), or the job waited SING_DEFER_S and is expected to take
       less than SING_SILENCE_MAX_S. Core lets her say so first.
    4. While people listen a window lasts SING_SILENCE_MAX_S at most, reload included: the job
       stops where it is, her voice comes back, and SING_SILENCE_GAP_S later it may go on from the
       chunk it reached. Windows repeat until the song is done.
    5. After SING_WAIT_MAX_S of waiting the job takes windows even when it is not urgent, or fails
       with the reason when even that cannot help, instead of holding the queue for ever.

A spill (steps far slower than normal: on Windows the driver quietly moves VRAM to system memory
instead of failing) is acted on, in this order: free the worker's own cache, then with her voice
still online take the card when that is allowed, else release everything and wait for room; with
her voice already offline, cut the remaining diffusion steps once, then give her voice back and wait
(offloading did not help, so this job does not try it again). Separation restarts on the CPU.

``SING_GPU_POLICY`` picks the policy. ``yield`` (the default since 2026-11-09, the owner's call: a
song should not wait for minutes, or run for a quarter of an hour on the CPU, to spare her a short
silence): a stage that fits shares the card as above; one that does not takes her voice offline for
it at once (bounded windows while people listen, a gap after each), and only Demucs' separation
(``CPU_FALLBACK``) goes to the CPU instead. ``auto`` is the order above (her voice first); ``share``
never touches her voice, ``wait`` never touches it and never runs without room, ``offload`` always
takes the card (the old behaviour).
"""

from __future__ import annotations

import json
import logging
import os
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from engine import env_float, env_int

log = logging.getLogger("miyoria.sing.gpu")

POLICIES = ("yield", "auto", "share", "offload", "wait")
PROFILE_FILE = "_gpu-profile.json"
PROFILE_VERSION = 1
PEAKS_KEPT = 5  # a peak grows with the length of the song: the highest of the last few runs
RECENT_SPILLS = 10
HISTORY_KEPT = 40
SPILL_MARGIN_MB = 256  # over the free VRAM at which a spill was seen
LOW_FREE_READS = 3  # readings in a row before low free VRAM counts
RELOAD_PRIOR_S = 30.0
RATE_PRIORS = {"separate": 0.05, "lead": 0.25, "convert": 0.3}  # seconds of work per second of audio
# Stages that can run on the CPU instead, so they never take her voice's card: one that does not fit
# is done there (a spill in one sends the rest of the job's such stages to the CPU as well).
CPU_STAGES = ("separate", "lead")
# Under ``yield``, the stages that go to the CPU when the card has no room instead of taking her
# voice's place: only where the CPU is not far slower (Demucs' separation; server.py adds it). The
# RoFormers are about 20 times slower there: on 2026-11-09 a 23 s lead split ran for over 15
# minutes on the CPU. ``SING_CPU_FALLBACK`` (comma list) sets it.
CPU_FALLBACK: set[str] = {s.strip() for s in os.environ.get("SING_CPU_FALLBACK", "").split(",") if s.strip()}


def policy_from_env(env: Mapping[str, str] = os.environ) -> tuple[str, str]:
    """(policy, where it came from). SING_GPU_SHARE is the older switch: 1 asked for what ``auto``
    does, 0 said so to always offloading; unset it follows the new default."""
    raw = env.get("SING_GPU_POLICY", "").strip().lower()
    if raw in POLICIES:
        return raw, "SING_GPU_POLICY"
    if raw:
        log.warning("SING_GPU_POLICY=%r is none of %s; using yield", raw, "|".join(POLICIES))
    legacy = env.get("SING_GPU_SHARE", "").strip()
    if legacy:
        return ("auto" if legacy == "1" else "offload"), "SING_GPU_SHARE"
    return "yield", "default"


@dataclass(frozen=True)
class Limits:
    """How long things may take, and what counts as slow. No sizes: those are learned."""

    prior_need_mb: int = 4096
    headroom_pct: float = 12.0
    room_wait_s: float = 0.0
    defer_s: float = 120.0
    wait_max_s: float = 600.0
    silence_max_s: float = 90.0
    silence_gap_s: float = 60.0
    lease_s: float = 60.0
    spill_factor: float = 5.0
    spill_step_s: float = 2.0
    steps: int = 30
    steps_min: int = 20
    yield_max_s: float = 120.0
    yield_patient_s: float = 900.0
    context_ttl_s: float = 20.0
    check_s: float = 1.0

    @staticmethod
    def from_env() -> "Limits":
        return Limits(
            prior_need_mb=env_int("SING_SHARE_MIN_FREE_MB", 4096),
            headroom_pct=env_float("SING_GPU_HEADROOM_PCT", 12.0),
            room_wait_s=env_float("SING_SHARE_WAIT_S", 0.0),
            defer_s=env_float("SING_DEFER_S", 120.0),
            wait_max_s=env_float("SING_WAIT_MAX_S", 600.0),
            silence_max_s=env_float("SING_SILENCE_MAX_S", 90.0),
            silence_gap_s=env_float("SING_SILENCE_GAP_S", 60.0),
            lease_s=env_float("SING_OFFLOAD_LEASE_S", 60.0),
            spill_factor=env_float("SING_SPILL_FACTOR", 5.0),
            spill_step_s=env_float("SING_SPILL_STEP_S", 2.0),
            steps=env_int("SING_DIFFUSION_STEPS", 30),
            steps_min=env_int("SING_DIFFUSION_STEPS_MIN", 20),
            yield_max_s=env_float("SING_YIELD_MAX_S", 120.0),
            yield_patient_s=env_float("SING_YIELD_PATIENT_S", 900.0),
            context_ttl_s=env_float("SING_CONTEXT_TTL_S", 20.0),
            check_s=env_float("SING_GPU_CHECK_S", 1.0),
        )


def _gb(mb: float | None) -> str:
    return "未知" if mb is None else f"{mb / 1024:.1f} GB"


# ── what was learned on this machine ─────────────────────────────────────────


class Profile:
    """Per card: each stage's peak VRAM, normal step time and speed, the headroom it needs and what
    a window costs. Lives next to the song cache, so it survives restarts; a different card starts
    over. Losing it only means starting from the conservative estimates again."""

    def __init__(self, root: Path) -> None:
        self.path = root / PROFILE_FILE
        self._lock = threading.Lock()
        self._key = "unknown"
        self._data: dict[str, Any] = {"version": PROFILE_VERSION, "devices": {}}
        try:
            raw = json.loads(self.path.read_text("utf-8"))
            if isinstance(raw, dict) and raw.get("version") == PROFILE_VERSION and isinstance(raw.get("devices"), dict):
                self._data = raw
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            log.warning("cannot read %s (%s); learning again", self.path, e)

    def use(self, name: str, total_mb: int | None) -> None:
        self._key = f"{name}/{total_mb}" if total_mb else name

    def _device(self) -> dict[str, Any]:
        return self._data["devices"].setdefault(self._key, {"stages": {}})

    def _stage(self, stage: str) -> dict[str, Any]:
        return self._device()["stages"].setdefault(stage, {})

    # Reads come from the HTTP threads as well, so they do not add keys: the job's thread may be saving.

    def _known(self) -> dict[str, Any]:
        return self._data["devices"].get(self._key, {})

    def _seen(self, stage: str) -> dict[str, Any]:
        return self._known().get("stages", {}).get(stage, {})

    def save(self) -> None:
        with self._lock:
            tmp = self.path.with_suffix(".tmp")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), "utf-8")
                os.replace(tmp, self.path)
            except OSError as e:
                log.warning("cannot write %s: %s", self.path, e)

    def need(self, stage: str, prior_mb: int) -> tuple[int, bool]:
        """(peak VRAM of the stage, whether it was measured here)."""
        peaks = self._seen(stage).get("peaks_mb") or []
        return (typical_peak(peaks), True) if peaks else (prior_mb, False)

    def step(self, stage: str) -> float | None:
        return self._seen(stage).get("step_s")

    def rate(self, stage: str) -> float:
        return self._seen(stage).get("rate") or RATE_PRIORS.get(stage, 0.3)

    def headroom(self, total_mb: int | None, limits: Limits) -> int:
        """Free VRAM the card must keep: the driver starts moving memory out before it is full
        (on 11-07 it spilled with 0.7 to 1.5 GB of 12.3 GB free), so a share of the card, or more
        once a spill was seen with more free than that."""
        base = round((total_mb or 0) * limits.headroom_pct / 100)
        return max(base, int(self._known().get("headroom_mb") or 0))

    def freed_mb(self) -> int | None:
        return self._known().get("freed_mb")

    def reload_s(self) -> float:
        known = self._known().get("reload_s")
        return RELOAD_PRIOR_S if known is None else known

    # Writes.

    def note_peak(self, stage: str, mb: int) -> None:
        s = self._stage(stage)
        s["peaks_mb"] = (s.get("peaks_mb") or [])[-(PEAKS_KEPT - 1):] + [int(mb)]

    def note_step(self, stage: str, seconds: float) -> None:
        """A clean run's median. It sinks at once and rises slowly, so a run on a busy card does not
        teach that slow is normal."""
        s = self._stage(stage)
        old = s.get("step_s")
        s["step_s"] = round(seconds if old is None else min(seconds, old * 1.2), 4)
        s["samples"] = int(s.get("samples") or 0) + 1

    def note_rate(self, stage: str, rate: float) -> None:
        self._stage(stage)["rate"] = round(rate, 4)

    def note_offload(self, freed_mb: int | None, reload_s: float | None) -> None:
        d = self._device()
        if freed_mb is not None:
            d["freed_mb"] = int(freed_mb)
        if reload_s is not None:
            d["reload_s"] = round(reload_s, 1)

    def note_spill(self, stage: str, free_mb: int | None, step_s: float | None, baseline_s: float | None,
                   total_mb: int | None) -> None:
        d = self._device()
        if free_mb is not None:
            # At most a quarter of the card: a reading taken in the middle of a spill can be odd.
            top = (total_mb // 4) if total_mb else free_mb + SPILL_MARGIN_MB
            d["headroom_mb"] = max(int(d.get("headroom_mb") or 0), min(free_mb + SPILL_MARGIN_MB, top))
        at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        d["spills"] = (d.get("spills") or [])[-(RECENT_SPILLS - 1):] + [
            {"at": at, "stage": stage, "free_mb": free_mb, "step_s": step_s, "baseline_s": baseline_s}]

    def note_healthy(self, free_min_mb: int | None) -> None:
        """A clean run with less free than the learned headroom: the headroom was too careful."""
        d = self._device()
        if free_min_mb is not None and d.get("headroom_mb") and free_min_mb < d["headroom_mb"]:
            d["headroom_mb"] = int(free_min_mb)

    def public(self) -> dict[str, Any]:
        d = self._known()
        stages = {name: {"peak_mb": typical_peak(s["peaks_mb"]) if s.get("peaks_mb") else None, "step_s": s.get("step_s"),
                         "rate": s.get("rate"), "samples": s.get("samples", 0)}
                  for name, s in d.get("stages", {}).items()}
        return {"device": self._key, "stages": stages, "headroom_mb": d.get("headroom_mb"),
                "freed_mb": d.get("freed_mb"), "reload_s": d.get("reload_s"), "spills": len(d.get("spills") or [])}


def typical_peak(peaks: list[int]) -> int:
    """The highest of the recent peaks that is no more than twice their median: a run that once
    took far more (on 11-09 an fp32 separation's 9.1 GB among fp16 runs of 2.1 to 2.3 GB) does not
    send every later one to the CPU. A real rise shows in more than one run and is kept."""
    ordered = sorted(peaks)
    median = ordered[len(ordered) // 2]
    return max(p for p in ordered if p <= 2 * median)


# ── what can be measured ─────────────────────────────────────────────────────


@dataclass
class Card:
    """The device now. ``cuda`` false: no GPU at all. ``free_mb`` ``None``: there is one, but it
    cannot be read."""

    cuda: bool
    total_mb: int | None = None
    free_mb: int | None = None
    own_mb: int = 0
    name: str = "cpu"


class Audience:
    """Who would notice her going quiet, as Core last said (``POST /gpu/context``, every poll while
    a song is prepared). No word for SING_CONTEXT_TTL_S (Core restarted mid-job) means *unknown*,
    and unknown counts as people: it never lets a job silence her, and an open window keeps its
    limit. ``people`` is only false when Core said so, or for a job nobody will be told about."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.in_voice = False
        self.listeners = 0
        self.live = False
        self.urgent: set[str] = set()
        self.at: float | None = None
        self._lock = threading.Lock()

    def update(self, in_voice: bool, listeners: int, live: bool, urgent: list[str]) -> None:
        with self._lock:
            self.in_voice, self.listeners, self.live = in_voice, listeners, live
            self.urgent = set(urgent)
            self.at = self.clock()

    def people(self, ttl_s: float, core_expected: bool) -> bool | None:
        with self._lock:
            if self.at is None:
                return None if core_expected else False
            if self.clock() - self.at > ttl_s:
                return None
            return self.live or (self.in_voice and self.listeners > 0)

    def public(self, ttl_s: float) -> dict[str, Any]:
        age = None if self.at is None else round(self.clock() - self.at, 1)
        return {"in_voice": self.in_voice, "listeners": self.listeners, "live": self.live, "age_s": age,
                "fresh": age is not None and age <= ttl_s}


@dataclass
class SpeechState:
    loaded: bool = False
    released_mb: int | None = None  # what their last offload gave back, as the device measured it


class Speech:
    """The speech workers that can be asked to offload. One that does not answer counts as loaded:
    ``Exclusive`` skips it if it really is gone."""

    def __init__(self, urls: list[str], get: Callable[[str, float], dict[str, Any]], *, every_s: float = 2.0,
                 timeout_s: float = 0.5, clock: Callable[[], float] = time.monotonic) -> None:
        self.urls, self.get, self.every_s, self.timeout_s, self.clock = urls, get, every_s, timeout_s, clock
        self._read: SpeechState | None = None
        self._at = 0.0

    def forget(self) -> None:
        self._read = None

    def read(self) -> SpeechState:
        now = self.clock()
        if self._read is not None and now - self._at < self.every_s:
            return self._read
        loaded, released, known = False, 0, False
        for url in self.urls:
            try:
                h = self.get(f"{url}/health", self.timeout_s)
            except Exception:  # noqa: BLE001 - asking must never be what stops a song
                loaded = True
                continue
            if not h.get("offloaded"):
                loaded = True
            if isinstance(h.get("released_mb"), (int, float)):
                released += int(h["released_mb"])
                known = True
        self._read, self._at = SpeechState(loaded, released if known else None), now
        return self._read


class StepMeter:
    """Time per step, without the time spent giving way to her voice."""

    def __init__(self, window: int = 3) -> None:
        self.times: list[float] = []
        self.recent: deque[float] = deque(maxlen=window)
        self.active_s = 0.0
        self._from: float | None = None

    def step(self, now: float) -> None:
        if self._from is not None:
            dt = now - self._from
            self.times.append(dt)
            self.recent.append(dt)
            self.active_s += dt
            self._from = None

    def resume(self, now: float) -> None:
        self._from = now

    def restart(self) -> None:
        self.recent.clear()
        self._from = None

    def slow(self, limit_s: float) -> bool:
        """The whole window over the limit: one long step is just the vocoder between chunks."""
        return len(self.recent) == self.recent.maxlen and min(self.recent) >= limit_s

    def last(self) -> float | None:
        return round(statistics.median(self.recent), 3) if self.recent else None

    def median(self) -> float | None:
        return statistics.median(self.times) if self.times else None


# ── the decision ─────────────────────────────────────────────────────────────


@dataclass
class Facts:
    """Everything one decision looks at."""

    policy: str
    stage: str
    limits: Limits
    cuda: bool
    on_gpu: bool = True  # the stage is set to use the card
    total_mb: int | None = None
    free_mb: int | None = None
    own_mb: int = 0
    need_mb: int = 0
    headroom_mb: int = 0
    freed_mb: int | None = None  # what offloading her voice gives
    speech_loaded: bool = False
    people: bool | None = False
    urgent: bool = False
    waited_s: float = 0.0  # this wait
    waited_total_s: float = 0.0  # this job
    silence_est_s: float | None = None
    gap_s: float = 0.0  # until a window may open again
    window: bool = False  # her voice is offline for this job
    offload_useless: bool = False  # a window was tried and it still spilled
    cpu_only: bool = False  # separation spilled
    cpu_fallback: bool = False  # under ``yield``, this stage goes to the CPU when there is no room
    crowded_mb: int | None = None  # the room at the last spill or OOM


@dataclass
class Decision:
    mode: str  # share | offload | exclusive | wait | cpu | give_up
    code: str
    reason: str


def decide(f: Facts) -> Decision:
    """What the stage does now. Pure: everything it knows is in ``f``."""
    limits = f.limits
    if not f.cuda:
        return Decision("cpu", "no_cuda", "這台機器沒有 CUDA,用 CPU 做,語音不受影響")
    if not f.on_gpu:
        return Decision("cpu", "configured_cpu", "這個階段設定在 CPU 上跑")
    if f.window:
        return Decision("exclusive", "window", "語音暫時離線,顯示卡給這首歌用")
    if f.cpu_only:
        return Decision("cpu", "spill_cpu", "分離在顯示卡上溢出了,改用 CPU,語音不受影響")

    room = None if f.free_mb is None else f.free_mb + f.own_mb
    want = f.need_mb + f.headroom_mb
    have = f"有 {_gb(room)},要 {_gb(want)}"
    # After a spill or an OOM the estimate was wrong: only more room than then counts.
    fits = room is not None and room >= want and (f.crowded_mb is None or room >= f.crowded_mb + f.need_mb * 0.1)
    separate = f.stage in CPU_STAGES

    if f.policy == "share":
        if f.crowded_mb is not None and f.waited_s < limits.defer_s:
            return Decision("wait", "share_spill", f"剛剛溢出,放掉顯存等一下再繼續({have})")
        return Decision("share", "policy_share", f"設定是一律共用,不動語音({have})")
    if f.policy == "offload":
        if not f.speech_loaded:
            return Decision("share", "nothing_to_offload", "設定是獨佔,但沒有語音 worker 可以讓")
        if f.offload_useless and not fits and f.waited_s < limits.defer_s:
            return Decision("wait", "offload_useless", f"語音讓出來還是溢出,先等空間({have})")
        return Decision("offload", "policy_offload", "設定是一律獨佔,語音暫時離線")
    if fits:
        return Decision("share", "fits", f"顯示卡放得下({have}),跟語音一起跑,她說話時讓路")
    if f.policy == "wait":
        if separate:
            return Decision("cpu", "policy_wait_cpu", f"設定是等空間,分離先用 CPU 做({have})")
        return Decision("wait", "policy_wait", f"設定是等空間,不動語音({have})")
    if room is None and not f.speech_loaded:
        return Decision("share", "unknown_card", "讀不到顯示卡,也沒有語音可以讓,直接跑")

    can = f.speech_loaded and not f.offload_useless
    if f.policy == "yield":
        if f.cpu_fallback and (not can or f.gap_s > 0):
            return Decision("cpu", "no_room_cpu", f"顯示卡放不下({have}),分離改用 CPU,語音不受影響")
        if f.gap_s > 0 and can:
            return Decision("wait", "gap", f"她剛回來,先讓她說話,{f.gap_s:.0f} 秒後才能再用整張卡")
        if can:
            code, why = ("urgent", "這首現在就要,") if f.urgent else ("no_room", "")
            return Decision("offload", code,
                            f"{why}顯示卡放不下({have}),語音暫時離線,最多 {limits.silence_max_s:.0f} 秒")
        return Decision("wait", "no_room", f"顯示卡放不下({have}),語音讓出來也沒用,等空間")
    helps = can and (f.freed_mb is None or room is None or room + f.freed_mb >= want)
    small = f.total_mb is not None and f.total_mb < want

    if f.people is False and helps and f.waited_s >= limits.room_wait_s:
        return Decision("offload", "nobody_listening", f"顯示卡放不下({have}),沒有人在聽,請語音先讓出來")
    if separate and (not f.urgent or not can or f.gap_s > 0):
        return Decision("cpu", "no_room_cpu", f"顯示卡放不下({have}),分離改用 CPU,語音不受影響")
    if f.gap_s > 0 and can:
        return Decision("wait", "gap", f"她剛回來,先讓她說話,{f.gap_s:.0f} 秒後才能再用整張卡")
    if f.urgent and can:
        return Decision("offload", "urgent",
                        f"這首現在就要,顯示卡放不下({have}),語音暫時離線,最多 {limits.silence_max_s:.0f} 秒")
    short = f.silence_est_s is not None and f.silence_est_s <= limits.silence_max_s
    if helps and short and f.waited_s >= limits.defer_s:
        return Decision("offload", "short_silence",
                        f"等了 {f.waited_s:.0f} 秒還是放不下,預估 {f.silence_est_s:.0f} 秒就好,語音暫時離線")
    if f.waited_total_s >= limits.wait_max_s:
        if can:
            return Decision("offload", "waited_long",
                            f"等了 {f.waited_total_s:.0f} 秒,分段做,語音每次最多離線 {limits.silence_max_s:.0f} 秒")
        if not small:
            return Decision("give_up", "no_room", f"等了 {f.waited_total_s / 60:.0f} 分鐘顯示卡還是放不下這首({have})")
    if small and not can:
        return Decision("share", "too_small", f"整張卡都放不下估計值({have}),只能試試看")
    who = "有人在聽" if f.people else "不確定有沒有人在聽" if f.people is None else "語音幫不上忙"
    if f.offload_useless:
        who = "語音讓出來也沒用"
    return Decision("wait", "no_room", f"顯示卡放不下({have}),{who},等空間")


@dataclass
class Action:
    """What ``tick`` wants done before the next step."""

    kind: str  # trim | reduce | offload | suspend
    code: str
    reason: str


class Machine:
    """What all jobs share: the card, what was learned, the audience, when her voice last came back."""

    def __init__(self, backend: Callable[[], Any], profile: Profile, audience: Audience,
                 get: Callable[[str, float], dict[str, Any]], clock: Callable[[], float] = time.monotonic) -> None:
        self.backend, self.profile, self.audience, self.get, self.clock = backend, profile, audience, get, clock
        self.gap_until = 0.0
        self.last: Card | None = None

    def card(self, peek: bool = False) -> Card:
        """``peek``: without starting CUDA in a worker that has not needed it yet."""
        b = self.backend()
        try:
            if not b.uses_cuda():
                card = Card(False)
            else:
                read = b.vram(peek)
                if read is None and peek:
                    return self.last or Card(True)
                free, total = read if read is not None else (None, None)
                card = Card(True, total, free, b.own_vram_mb(), b.gpu_name())
        except Exception as e:  # noqa: BLE001 - a card that cannot be read is treated as unknown
            log.warning("cannot read the card: %s", e)
            return Card(True)
        self.profile.use(card.name, card.total_mb)
        self.last = card
        return card

    def public(self, limits: Limits) -> dict[str, Any]:
        policy, source = policy_from_env()
        card = self.card(peek=True)
        return {"policy": policy, "policy_source": source, "cuda": card.cuda, "total_mb": card.total_mb,
                "free_mb": card.free_mb, "headroom_mb": self.profile.headroom(card.total_mb, limits),
                "audience": self.audience.public(limits.context_ttl_s), "learned": self.profile.public()}


class GpuJob:
    """One job's decisions, made before every GPU stage and again while it runs."""

    def __init__(self, machine: Machine, job_id: str, urls: list[str], *, core_expected: bool,
                 urgent: Callable[[], bool], audio_s: float | None = None) -> None:
        self.machine = machine
        self.job_id = job_id
        self.limits = Limits.from_env()
        self.policy, self.policy_source = policy_from_env()
        self.speech = Speech(urls, machine.get, clock=machine.clock)
        self.core_expected = core_expected
        self.urgent = urgent
        self.audio_s = audio_s
        self.converted = 0.0  # share of the conversion done
        self.clock = machine.clock
        self.stage = ""
        self.device = "gpu"
        self.decision: Decision | None = None
        self.history: list[dict[str, Any]] = []
        self.meter = StepMeter()
        self.facts: Facts | None = None
        self.spilling = False
        self.spills = 0
        self.reduced_to: int | None = None
        self.window = False
        self.offload_useless = False
        self.cpu_only = False
        self.crowded_mb: int | None = None
        self.silenced_s = 0.0
        self.waited_total_s = 0.0
        self.peak_allocated_mb: int | None = None
        self._wait_from: float | None = None
        self._window_at = 0.0
        self._quiet_from: float | None = None  # people could hear her being gone since then
        self._free_before: int | None = None
        self._checked = 0.0
        self._free0: int | None = None
        self._free_min: int | None = None
        self._low_reads = 0
        self._trimmed = False
        self._clean = True
        self._resumed = False

    # ── reading the machine ──────────────────────────────────────────────

    def people(self) -> bool | None:
        return self.machine.audience.people(self.limits.context_ttl_s, self.core_expected)

    def silence_estimate(self, stage: str) -> float | None:
        """How long her voice would be gone if a window opened now, reload included."""
        if not self.audio_s:
            return None
        p = self.machine.profile
        work = self.audio_s * (1 - self.converted) * p.rate("convert")
        if stage in CPU_STAGES:
            work += self.audio_s * p.rate(stage)
        return work + p.reload_s()

    def gather(self, stage: str, on_gpu: bool = True) -> Facts:
        m, limits = self.machine, self.limits
        card = m.card()
        now = self.clock()
        waited = self.waiting_s()
        speech = self.speech.read()
        freed = m.profile.freed_mb()
        need, _ = m.profile.need(stage, limits.prior_need_mb)
        return Facts(
            policy=self.policy, stage=stage, limits=limits, cuda=card.cuda, on_gpu=on_gpu, total_mb=card.total_mb,
            free_mb=card.free_mb, own_mb=card.own_mb, need_mb=need, headroom_mb=m.profile.headroom(card.total_mb, limits),
            freed_mb=freed if freed is not None else speech.released_mb, speech_loaded=speech.loaded,
            people=self.people(),
            urgent=self.urgent(), waited_s=waited, waited_total_s=self.waited_total_s + waited,
            silence_est_s=self.silence_estimate(stage), gap_s=max(0.0, m.gap_until - now), window=self.window,
            offload_useless=self.offload_useless, cpu_only=self.cpu_only and stage in CPU_STAGES,
            cpu_fallback=stage in CPU_FALLBACK,
            crowded_mb=self.crowded_mb,
        )

    def decide(self, stage: str, on_gpu: bool = True) -> Decision:
        self.facts = self.gather(stage, on_gpu)
        d = decide(self.facts)
        self._note(stage, d)
        if d.mode == "wait":
            if self._wait_from is None:
                self._wait_from = self.clock()
        return d

    def waiting_s(self) -> float:
        """How long the wait under way has lasted."""
        return 0.0 if self._wait_from is None else self.clock() - self._wait_from

    def wait_over(self) -> None:
        if self._wait_from is not None:
            self.waited_total_s += self.clock() - self._wait_from
            self._wait_from = None

    def _note(self, stage: str, d: Decision) -> None:
        last = self.decision
        self.stage, self.decision = stage, d
        if last is not None and (last.mode, last.code) == (d.mode, d.code):
            return
        f = self.facts
        entry = {"stage": stage, "mode": d.mode, "code": d.code, "reason": d.reason,
                 "free_mb": f.free_mb if f else None, "need_mb": f.need_mb if f else None,
                 "people": f.people if f else None, "urgent": f.urgent if f else None,
                 "step_s": self.meter.last(), "t": round(time.time(), 1)}
        self.history = (self.history + [entry])[-HISTORY_KEPT:]
        log.info("job %s %s: %s (%s) %s", self.job_id, stage, d.mode, d.code, d.reason)

    # ── a stage running ──────────────────────────────────────────────────

    def started(self, stage: str, device: str, resumed: bool = False) -> None:
        self.stage, self.device = stage, device
        self.meter = StepMeter()
        self._trimmed = False
        self._clean = True
        self._resumed = resumed
        self._low_reads = 0
        self.spilling = False
        self._checked = self.clock()
        self._free0 = self._free_min = self.facts.free_mb if self.facts else None
        if device == "gpu":
            self._backend("peak_reset")

    def _backend(self, name: str) -> Any:
        fn = getattr(self.machine.backend(), name, None)
        return fn() if fn is not None else None

    def finished(self, stage: str) -> None:
        """A stage ended normally: what it measured goes into the profile."""
        if self.device != "gpu":
            return
        p = self.machine.profile
        peak = self._peak()
        drop = 0 if self._free0 is None or self._free_min is None else self._free0 - self._free_min
        if max(peak, drop) > 0:
            p.note_peak(stage, max(peak, drop))
        step = self.meter.median()
        if self._clean and not self.spilling and step is not None:
            # Nothing to compare with yet: a slow first run only teaches "normal" with room to spare.
            f = self.facts
            tight = self._free_min is not None and f is not None and self._free_min <= f.headroom_mb
            if p.step(stage) is not None or step <= self.limits.spill_step_s or not tight:
                p.note_step(stage, step)
                p.note_healthy(self._free_min)
            if self.audio_s and not self._resumed:
                p.note_rate(stage, self.meter.active_s / self.audio_s)
        p.save()

    def _peak(self) -> int:
        read = self._backend("peak_read") or (0, 0)
        reserved, allocated = read
        self.peak_allocated_mb = max(self.peak_allocated_mb or 0, allocated) or None
        return reserved

    def stopped(self, oom: bool = False) -> None:
        """A stage was cut short: suspended, or out of VRAM."""
        self._clean = False
        p = self.machine.profile
        peak = self._peak()
        if self.device == "gpu" and peak > 0:
            p.note_peak(self.stage, peak)
        if oom:
            self.spills += 1
            self.crowded_mb = self._room()
            if self.window:
                self.offload_useless = True
            self._note(self.stage, Decision("wait", "oom", "顯存不夠用,放掉重新決定"))
        p.save()

    def _room(self) -> int | None:
        card = self.machine.card()
        return None if card.free_mb is None else card.free_mb + card.own_mb

    # ── every step ───────────────────────────────────────────────────────

    def step(self) -> None:
        self.meter.step(self.clock())

    def resume(self) -> None:
        self.meter.resume(self.clock())

    def yield_allowance(self) -> float:
        """Song work gives way to her for this long in total: the song that is waited for runs out
        first, because a voice channel that keeps talking must not stop it for ever."""
        if self.urgent() or self.people() is False:
            return self.limits.yield_max_s
        return self.limits.yield_patient_s

    def tick(self, stage: str) -> Action | None:
        """Before every step on the GPU: is this still right?"""
        if self.device != "gpu":
            return None
        now = self.clock()
        limits, p = self.limits, self.machine.profile
        free = self._look(now)
        if self.window and self.policy != "offload":
            if self.people() is False:
                self._quiet_from = None
            elif self._quiet_from is None:
                self._quiet_from = now
            # The reload counts as silence too, but a window always gets half for work: one that
            # ended the moment it opened would silence her again and again and get nowhere.
            work_s = max(limits.silence_max_s - p.reload_s(), limits.silence_max_s / 2)
            if self._quiet_from is not None and now - self._quiet_from >= work_s:
                return self._do(Action("suspend", "silence_limit",
                                       f"語音已經離線快 {limits.silence_max_s:.0f} 秒,先讓她回來,之後接著做"))
        baseline = p.step(stage)
        headroom = p.headroom(self.facts.total_mb if self.facts else None, limits)
        slow = self.meter.slow(baseline * limits.spill_factor if baseline else limits.spill_step_s)
        if slow and baseline is None and (free is None or free > headroom):
            slow = False  # a slow card with room to spare, not a spill
        low = self._low_reads >= LOW_FREE_READS and not self.window and self.people() is not False
        if not (slow or low):
            self.spilling = False
            return None
        return self._on_spill(stage, free, baseline, slow)

    def _look(self, now: float) -> int | None:
        """The free VRAM, read every SING_GPU_CHECK_S."""
        if now - self._checked < self.limits.check_s:
            return self.machine.last.free_mb if self.machine.last else None
        self._checked = now
        free = self.machine.card().free_mb
        if free is not None:
            self._free_min = free if self._free_min is None else min(self._free_min, free)
            headroom = self.machine.profile.headroom(self.machine.last.total_mb if self.machine.last else None,
                                                     self.limits)
            self._low_reads = self._low_reads + 1 if free < headroom / 2 else 0
        return free

    def _on_spill(self, stage: str, free: int | None, baseline: float | None, slow: bool) -> Action:
        limits, p = self.limits, self.machine.profile
        step = self.meter.last()
        self.spilling = True
        self._clean = False
        if not self._trimmed:
            self.spills += 1
            if slow:
                total = self.machine.last.total_mb if self.machine.last else None
                p.note_spill(stage, free, step, baseline, total)
                p.save()
            self._trimmed = True
            self.meter.restart()
            self._low_reads = 0
            what = f"每步 {step} 秒,平常 {baseline} 秒" if slow else f"顯存只剩 {_gb(free)}"
            return self._do(Action("trim", "spill_free", f"溢出了({what}),先清掉這邊的快取"))
        self.meter.restart()
        self._low_reads = 0
        room = None if free is None else free + self.machine.backend().own_vram_mb()
        reduce = stage == "convert" and self.reduced_to is None and limits.steps_min < limits.steps
        if stage in CPU_STAGES:
            self.cpu_only = True
            return self._do(Action("suspend", "spill_cpu", "分離溢出了,放掉顯示卡,改用 CPU 重做"))
        if self.window:
            if reduce:
                self.reduced_to = limits.steps_min
                return self._do(Action("reduce", "spill_reduce",
                                       f"語音已經讓出來還是溢出,剩下的改成 {limits.steps_min} 步(音質稍差,換時間)"))
            self.offload_useless = True
            self.crowded_mb = room
            return self._do(Action("suspend", "spill_wait", "語音讓出來還是溢出,讓她回來,放掉顯存等空間"))
        if self.policy == "share" and reduce:
            self.reduced_to = limits.steps_min
            return self._do(Action("reduce", "spill_reduce", f"設定不動語音,溢出時剩下的改成 {limits.steps_min} 步(音質稍差)"))
        gap = self.machine.gap_until - self.clock()
        loaded = self.speech.read().loaded
        if self.policy in ("auto", "yield") and loaded and not self.offload_useless and gap <= 0 and (
                self.urgent() or self.people() is False):
            return self._do(Action("offload", "spill_offload", "溢出了,這時候可以請語音讓出來"))
        self.crowded_mb = room
        return self._do(Action("suspend", "spill_wait", "溢出了,放掉顯存,等空間再從這裡接著做"))

    def _do(self, a: Action) -> Action:
        mode = {"suspend": "wait", "offload": "offload"}.get(a.kind, self.decision.mode if self.decision else "share")
        self._note(self.stage, Decision(mode, a.code, a.reason))
        return a

    # ── windows: her voice offline for this job ──────────────────────────

    def offload_max_s(self) -> float:
        """The lease the speech workers get: the window renews it, so it only runs out when this
        worker died, and a crash cannot silence her for longer than this."""
        return self.limits.lease_s

    def window_opening(self) -> None:
        self._free_before = self.machine.card().free_mb

    def window_opened(self) -> None:
        now = self.clock()
        self.window = True
        self._window_at = now
        self._quiet_from = None if self.people() is False else now
        self.speech.forget()
        free = self.machine.card().free_mb
        if free is not None:
            self._free0 = self._free_min = free
        # A difference on the whole card: whatever else moved meanwhile is in it, and when that was
        # more than her voice gave back it says nothing. Not a reason to think offloading frees nothing.
        if free is not None and self._free_before is not None and free > self._free_before:
            self.machine.profile.note_offload(free - self._free_before, None)
        self.machine.profile.save()

    def window_closed(self, reload_s: float | None) -> None:
        """Her voice is back (or was asked back and could not be reached)."""
        if not self.window:
            return
        self.window = False
        now = self.clock()
        self.silenced_s += now - self._window_at
        if self._quiet_from is not None:
            self.machine.gap_until = now + self.limits.silence_gap_s
        self._quiet_from = None
        self.speech.forget()
        self.machine.profile.note_offload(None, reload_s)
        self.machine.profile.save()

    # ── what is shown ────────────────────────────────────────────────────

    def public(self) -> dict[str, Any]:
        d, f = self.decision, self.facts
        p = self.machine.profile
        return {
            "policy": self.policy,
            "stage": self.stage,
            "mode": d.mode if d else None,
            "code": d.code if d else None,
            "reason": d.reason if d else None,
            "free_mb": f.free_mb if f else None,
            "total_mb": f.total_mb if f else None,
            "need_mb": f.need_mb if f else None,
            "headroom_mb": f.headroom_mb if f else None,
            "speech_loaded": f.speech_loaded if f else None,
            "people": f.people if f else None,
            "urgent": f.urgent if f else None,
            "step_s": self.meter.last(),
            "baseline_s": p.step(self.stage) if self.stage else None,
            "spilling": self.spilling,
            "spills": self.spills,
            "steps": self.reduced_to,
            "waited_s": round(self.waited_total_s + self.waiting_s(), 1),
            "silenced_s": round(self.silenced_s, 1),
            "silence_est_s": round(f.silence_est_s, 1) if f and f.silence_est_s is not None else None,
            "silence_max_s": self.limits.silence_max_s,
        }

    def summary(self) -> dict[str, Any]:
        """What stays with the song in meta.json."""
        return {"policy": self.policy, "policy_source": self.policy_source, "decisions": self.history,
                "spills": self.spills, "steps": self.reduced_to, "waited_s": round(self.waited_total_s, 1),
                "silenced_s": round(self.silenced_s, 1)}

