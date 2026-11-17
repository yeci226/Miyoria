"""The song worker's GPU decisions, recorded for hostd's arbiter (docs/design/v5-gpu.md, step H7).

Two checked-in files hold what the Python code does today:

    sing/gpu_decisions.json   what each decision function answers, over grids of inputs placed
                              around its thresholds: one case per line
    sing/gpu_scenarios.json   what the whole mechanism (gpu.py, exclusive.py, yielding.py and the
                              job loop of server.py) does over time: timed events in, observed
                              HTTP calls, states and decisions out

The tests build both again from the code and compare. ``UPDATE_GPU_TABLE=1`` writes them instead:

    cd workers && UPDATE_GPU_TABLE=1 py -3.11 -m pytest tests/test_gpu_table.py

Nothing here touches a device, the network or torch. The card, the clock, the speech workers and
Core are fakes. The scenarios run the real threads of the worker one at a time on a simulated clock
(``Sim``): a thread runs until it waits or sleeps, then the one due first goes on, so a run is the
same every time and an hour of a job takes a second or two.
"""

from __future__ import annotations

import dataclasses
import heapq
import importlib.util
import itertools
import json
import math
import os
import sys
import threading
import types
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

WORKERS = Path(__file__).resolve().parent.parent
SING = WORKERS / "sing"
sys.path.insert(0, str(SING))
sys.path.insert(1, str(WORKERS))

TORCH_BEFORE = "torch" in sys.modules

import device_memory  # noqa: E402
import exclusive  # noqa: E402
import gpu  # noqa: E402
import yielding  # noqa: E402
from gpu import (  # noqa: E402
    CPU_STAGES,
    POLICIES,
    Audience,
    Decision,
    Facts,
    GpuJob,
    Limits,
    Machine,
    Profile,
    Speech,
    decide,
    policy_from_env,
    typical_peak,
)
from yielding import SpeechYield  # noqa: E402

TABLE = SING / "gpu_decisions.json"
SCENARIOS = SING / "gpu_scenarios.json"
UPDATE = os.environ.get("UPDATE_GPU_TABLE") == "1"
# A profile that is never written (``save`` is replaced) and never found on disk.
NOWHERE = WORKERS / ".tmp-test" / "gpu-table-no-profile"
STAGES = ("separate", "lead", "convert")
URLS = ["http://tts", "http://asr"]
GB = 1024


# ── shared helpers ───────────────────────────────────────────────────────────


@contextmanager
def clean_env(**values: Any) -> Iterator[None]:
    """No SING_* variable of the machine running the test, only ``values``; CPU_FALLBACK empty; no
    NVML (``device_memory.read`` answers None instead of loading the driver's library)."""
    saved = dict(os.environ)
    fallback = set(gpu.CPU_FALLBACK)
    nvml = (device_memory._tried, device_memory._nvml)
    try:
        for k in [k for k in os.environ if k.startswith("SING_")]:
            del os.environ[k]
        os.environ.update({k: str(v) for k, v in values.items()})
        gpu.CPU_FALLBACK.clear()
        device_memory._tried, device_memory._nvml = True, None
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)
        gpu.CPU_FALLBACK.clear()
        gpu.CPU_FALLBACK.update(fallback)
        device_memory._tried, device_memory._nvml = nvml


@contextmanager
def patched(*items: tuple[Any, str, Any]) -> Iterator[None]:
    old = [(obj, name, getattr(obj, name)) for obj, name, _ in items]
    try:
        for obj, name, value in items:
            setattr(obj, name, value)
        yield
    finally:
        for obj, name, value in reversed(old):
            setattr(obj, name, value)


def grid(**dims: list[Any]) -> Iterator[dict[str, Any]]:
    keys = list(dims)
    for values in itertools.product(*(dims[k] for k in keys)):
        yield dict(zip(keys, values))


def profile(total: int | None = 12288) -> Profile:
    p = Profile(NOWHERE)
    p.save = lambda: None  # type: ignore[method-assign]
    p.use("Sim GPU", total)
    return p


LIMITS_DEFAULT = dataclasses.asdict(Limits())


def limits_of(delta: dict[str, Any]) -> Limits:
    return dataclasses.replace(Limits(), **delta)


def limits_delta(limits: Limits) -> dict[str, Any]:
    return {k: v for k, v in dataclasses.asdict(limits).items() if LIMITS_DEFAULT[k] != v}


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def r3(x: float | None) -> float | None:
    return None if x is None else round(x, 3)


class Table:
    """Cases of one function: the input as a change from the function's base, deduplicated."""

    def __init__(self) -> None:
        self.cases: list[dict[str, Any]] = []
        self.bases: dict[str, dict[str, Any]] = {}
        self._seen: set[str] = set()

    def base(self, fn: str, base: dict[str, Any]) -> None:
        self.bases[fn] = base

    def add(self, fn: str, given: dict[str, Any], out: Any) -> None:
        base = self.bases.get(fn, {})
        delta = {k: v for k, v in given.items() if k not in base or base[k] != v}
        key = fn + dump({**base, **given})
        if key in self._seen:
            return
        self._seen.add(key)
        self.cases.append({"fn": fn, "in": delta, "out": out})


# ── the decision table ───────────────────────────────────────────────────────


def limits_env() -> dict[str, dict[str, Any]]:
    """Which variable feeds which limit, with its default: read off ``Limits.from_env`` itself."""
    calls: list[tuple[str, Any, str]] = []

    def recorder(kind: str) -> Callable[[str, Any], int]:
        def read(name: str, default: Any) -> int:
            calls.append((name, default, kind))
            return 10_000 + len(calls)

        return read

    with patched((gpu, "env_int", recorder("int")), (gpu, "env_float", recorder("float"))):
        got = Limits.from_env()
    out = {}
    for f in dataclasses.fields(Limits):
        name, default, kind = calls[getattr(got, f.name) - 10_001]
        out[f.name] = {"env": name, "default": default, "type": kind}
    return out


def t_policy(t: Table) -> None:
    for policy, share in itertools.product([None, "", "yield", "auto", "share", "offload", "wait", " Auto ", "bogus"],
                                           [None, "1", "0", " 1", "yes"]):
        env = {k: v for k, v in (("SING_GPU_POLICY", policy), ("SING_GPU_SHARE", share)) if v is not None}
        got = policy_from_env(env)
        t.add("policy_from_env", {"env": env}, {"policy": got[0], "source": got[1]})


def t_limits(t: Table, envmap: dict[str, dict[str, Any]]) -> None:
    for field, info in envmap.items():
        valid = "2048" if info["type"] == "int" else "45.5"
        odd = "1.5" if info["type"] == "int" else "1e3"
        for raw in (None, valid, " 7 ", odd, "x"):
            env = {} if raw is None else {info["env"]: raw}
            with clean_env(**env):
                got = getattr(Limits.from_env(), field)
            t.add("limits_from_env", {"field": field, "env": env}, {"value": got})


DECIDE_BASE: dict[str, Any] = dict(
    policy="auto", stage="convert", limits={}, cuda=True, on_gpu=True, pauses=True, total_mb=12288, free_mb=2500,
    own_mb=0, need_mb=4096, headroom_mb=1475, freed_mb=6200, speech_loaded=True, people=True, urgent=False,
    waited_s=0.0, waited_total_s=0.0, silence_est_s=84.0, gap_s=0.0, window=False, offload_useless=False,
    cpu_only=False, cpu_fallback=False, crowded_mb=None)


def run_decide(given: dict[str, Any]) -> dict[str, Any]:
    full = {**DECIDE_BASE, **given}
    limits = limits_of(full.pop("limits"))
    d = decide(Facts(limits=limits, **full))
    return {"mode": d.mode, "code": d.code, "reason": d.reason}


def decide_inputs() -> Iterator[dict[str, Any]]:
    # 1. what is settled before the card is looked at, under every policy (no room on the card)
    yield from grid(policy=list(POLICIES), stage=["lead"], cuda=[True, False], on_gpu=[True, False],
                    window=[False, True], cpu_only=[False, True])
    # 2. fits or not, just below / at / above what is wanted, with and without her voice's burst
    # and a spill's ``crowded`` room, under every policy
    for policy, pauses, speech in itertools.product(POLICIES, [True, False], [True, False]):
        want = 4096 + 1475 + (0 if pauses or not speech else Limits().burst_mb)
        for (free, own), crowded in itertools.product(
                [(want - 1, 0), (want, 0), (want + 1, 0), (want - 700, 700), (None, 0)],
                [None, want - 410, want - 409]):
            yield dict(policy=policy, pauses=pauses, speech_loaded=speech, free_mb=free, own_mb=own, crowded_mb=crowded)
    # 3. ``auto`` without room: who may take her voice offline at once
    yield from grid(stage=list(STAGES), people=[True, False, None], urgent=[False, True], speech_loaded=[True, False],
                    offload_useless=[False, True], gap_s=[0.0, 30.0], freed_mb=[None, 2000, 6200])
    # 4. ``auto`` without room: waiting long enough, a short silence, a card too small
    for g in grid(people=[True, None], can=["yes", "useless", "nothing"], freed_mb=[6200, 2000],
                  silence_est_s=[None, 90.0, 90.5], waited_s=[119.5, 120.0], waited_total_s=[599.5, 600.0],
                  total_mb=[12288, 5000]):
        can = g.pop("can")
        yield {**g, "speech_loaded": can != "nothing", "offload_useless": can == "useless"}
    # 5. ``auto`` with nobody listening: SING_SHARE_WAIT_S
    yield from grid(people=[False], limits=[{}, {"room_wait_s": 30.0}], waited_s=[0.0, 29.9, 30.0],
                    freed_mb=[2000, 6200], stage=["separate", "convert"])
    # 6. ``yield`` without room
    yield from grid(policy=["yield"], stage=list(STAGES), cpu_fallback=[False, True], speech_loaded=[True, False],
                    offload_useless=[False, True], gap_s=[0.0, 30.0], urgent=[False, True], people=[True, False])
    # 7. ``share``, ``offload`` and ``wait`` past the early exits
    yield from grid(policy=["share", "offload", "wait"], stage=list(STAGES), speech_loaded=[True, False],
                    offload_useless=[False, True], crowded_mb=[None, 6000], waited_s=[0.0, 120.0],
                    free_mb=[2500, None, 9000])
    # 8. ``yield`` with nothing to offload, or offloading that did not help: bounded by SING_WAIT_MAX_S
    for g in grid(policy=["yield"], stage=["separate", "convert"], can=["nothing", "useless"],
                  waited_total_s=[0.0, 599.5, 600.0], total_mb=[12288, 5000], cpu_fallback=[False, True]):
        can = g.pop("can")
        yield {**g, "speech_loaded": can != "nothing", "offload_useless": can == "useless"}


def t_decide(t: Table) -> None:
    t.base("decide", DECIDE_BASE)
    for given in decide_inputs():
        t.add("decide", given, run_decide(given))


class TableBackend:
    def __init__(self, card: str, free: int | None = 2500, total: int = 12288, own: int = 0) -> None:
        self.kind, self.free, self.total, self.own = card, free, total, own

    def uses_cuda(self) -> bool:
        return self.kind != "none"

    def vram(self, peek: bool = False) -> tuple[int, int] | None:
        if self.kind == "raises":
            raise RuntimeError("NVML went away")
        if self.kind == "unreadable" or self.free is None:
            return None
        return self.free, self.total

    def own_vram_mb(self) -> int:
        return self.own

    def gpu_name(self) -> str:
        return "Sim GPU"


def health_getter(replies: dict[str, Any]) -> Callable[[str, float], dict[str, Any]]:
    def get(url: str, timeout: float) -> dict[str, Any]:
        base = url.rsplit("/", 1)[0]
        reply = replies.get(base, {"offloaded": False})
        if reply == "error":
            raise ConnectionError("connection refused")
        return dict(reply)

    return get


GATHER_BASE: dict[str, Any] = dict(
    card="12gb", own_mb=0, profile="fresh", stage="convert", speech="loaded", cpu_only=False, cpu_fallback=[],
    wait_age=None, waited_before_s=0.0, gap_s=0.0, window=False, offload_useless=False)

SPEECH_STATES = {
    "loaded": {"http://tts": {"offloaded": False}, "http://asr": {"offloaded": False}},
    "offloaded": {"http://tts": {"offloaded": True, "released_mb": 4700},
                  "http://asr": {"offloaded": True, "released_mb": 1500}},
    "one_down": {"http://tts": "error", "http://asr": {"offloaded": True, "released_mb": 1500}},
}


def run_gather(given: dict[str, Any]) -> dict[str, Any]:
    g = {**GATHER_BASE, **given}
    now = [1000.0]
    p = profile()
    if g["profile"] == "learned":
        for mb in (3300, 3500):
            p.note_peak("convert", mb)
        p.note_peak("separate", 2100)
        p._device()["headroom_mb"] = 2256
        p.note_offload(5800, None)
    backend = TableBackend(g["card"], own=g["own_mb"])
    audience = Audience(lambda: now[0])
    audience.update(True, 2, False, [])
    m = Machine(lambda: backend, p, audience, health_getter(SPEECH_STATES[g["speech"]]), clock=lambda: now[0])
    m.gap_until = now[0] + g["gap_s"]
    with clean_env():
        gpu.CPU_FALLBACK.update(g["cpu_fallback"])
        job = GpuJob(m, "job", URLS, core_expected=False, urgent=lambda: False, audio_s=180.0)
        job._wait_from = None if g["wait_age"] is None else now[0] - g["wait_age"]
        job.waited_total_s = g["waited_before_s"]
        job.window, job.offload_useless, job.cpu_only = g["window"], g["offload_useless"], g["cpu_only"]
        f = job.gather(g["stage"])
    out = dataclasses.asdict(f)
    out.pop("limits")
    out["silence_est_s"] = r3(out["silence_est_s"])
    return out


def t_gather(t: Table) -> None:
    t.base("gather", GATHER_BASE)
    for g in grid(card=["none", "unreadable", "raises", "12gb"], profile=["fresh", "learned"],
                  stage=["separate", "convert"]):
        t.add("gather", g, run_gather(g))
    for g in grid(card=["12gb"], own_mb=[3000], profile=["fresh", "learned"], stage=["separate", "convert"]):
        t.add("gather", g, run_gather(g))
    for g in grid(speech=list(SPEECH_STATES), stage=["separate", "convert"], cpu_only=[False, True],
                  cpu_fallback=[[], ["separate"]]):
        t.add("gather", g, run_gather(g))
    for g in grid(wait=[(None, 0.0), (30.0, 100.0)], gap_s=[-5.0, 0.0, 12.5], state=[(False, False), (True, True)]):
        (age, before), (window, useless) = g.pop("wait"), g.pop("state")
        g.update(wait_age=age, waited_before_s=before, window=window, offload_useless=useless)
        t.add("gather", g, run_gather(g))


def t_headroom(t: Table) -> None:
    for total, pct, learned in itertools.product([None, 0, 4096, 8192, 12282, 12284, 12288, 12292, 24576],
                                                 [12.0, 12.5, 0.0], [None, 0, 1000, 3000]):
        p = profile(total)
        if learned is not None:
            p._device()["headroom_mb"] = learned
        got = p.headroom(total, limits_of({"headroom_pct": pct}))
        t.add("headroom", {"total_mb": total, "headroom_pct": pct, "learned_mb": learned}, {"headroom_mb": got})


def t_peaks(t: Table) -> None:
    for n in range(1, 6):
        for peaks in itertools.combinations_with_replacement([1000, 2000, 4000, 4001], n):
            t.add("typical_peak", {"peaks_mb": list(peaks)}, {"peak_mb": typical_peak(list(peaks))})


def t_learning(t: Table) -> None:
    for old, new in itertools.product([None, 0.1, 1.0], [0.05, 0.1, 0.11999, 0.12, 0.12001, 0.123456, 2.0]):
        p = profile()
        if old is not None:
            p.note_step("convert", old)
        p.note_step("convert", new)
        t.add("profile.note_step", {"step_s_before": old, "step_s": new},
              {"step_s": p.step("convert"), "samples": p._seen("convert")["samples"]})
    for before, free, total in itertools.product([None, 1000, 3500], [None, 500, 2000, 2900, 9000], [None, 12288]):
        p = profile(total)
        if before is not None:
            p._device()["headroom_mb"] = before
        p.note_spill("convert", free, 7.0, 0.1, total)
        d = p._known()
        t.add("profile.note_spill", {"headroom_mb_before": before, "free_mb": free, "total_mb": total},
              {"headroom_mb": d.get("headroom_mb"), "spills": len(d.get("spills") or [])})
    for before, lowest in itertools.product([None, 0, 2000], [None, 1500, 2000, 2500]):
        p = profile()
        if before is not None:
            p._device()["headroom_mb"] = before
        p.note_healthy(lowest)
        t.add("profile.note_healthy", {"headroom_mb_before": before, "free_min_mb": lowest},
              {"headroom_mb": p._known().get("headroom_mb")})


def t_people(t: Table) -> None:
    for age, in_voice, listeners, live, expected in itertools.product(
            [None, 0.0, 19.9, 20.0, 20.1], [False, True], [0, 1, 3], [False, True], [False, True]):
        now = [500.0]
        a = Audience(lambda: now[0])
        if age is not None:
            a.update(in_voice, listeners, live, [])
            now[0] += age
        elif (in_voice, listeners, live) != (False, 0, False):
            continue  # never told: what it would have said does not exist
        t.add("audience.people", {"age_s": age, "in_voice": in_voice, "listeners": listeners, "live": live,
                                  "ttl_s": 20.0, "core_expected": expected},
              {"people": a.people(20.0, expected), "fresh": a.public(20.0)["fresh"]})


def t_speech(t: Table) -> None:
    variants: list[Any] = ["error", {"offloaded": False}, {"offloaded": False, "released_mb": 1500},
                           {"offloaded": True, "released_mb": 4700}, {"offloaded": True},
                           {"offloaded": True, "released_mb": 4700.6}]
    for n in range(3):
        for replies in itertools.product(variants, repeat=n):
            urls = URLS[:n]
            got = Speech(urls, health_getter(dict(zip(urls, replies)))).read()
            t.add("speech.read", {"health": list(replies)}, {"loaded": got.loaded, "released_mb": got.released_mb})
    for age, forget in itertools.product([0.0, 1.999, 2.0, 5.0], [False, True]):
        now = [100.0]
        replies = {"http://tts": {"offloaded": False}}
        s = Speech(["http://tts"], health_getter(replies), clock=lambda: now[0])
        first = s.read().loaded
        replies["http://tts"] = {"offloaded": True}
        now[0] += age
        if forget:
            s.forget()
        t.add("speech.read_cache", {"age_s": age, "forget": forget, "every_s": s.every_s},
              {"first": first, "again": s.read().loaded})


def t_silence(t: Table) -> None:
    learned_sets: dict[str, dict[str, Any]] = {
        "none": {},
        "learned": {"rates": {"convert": 0.2, "separate": 0.04, "lead": 0.3}, "reload_s": 87.0},
        "zero_rate": {"rates": {"convert": 0.0}, "reload_s": 12.0},
    }
    for audio, converted, stage, learned in itertools.product([None, 0.0, 60.0, 200.0], [0.0, 0.5], STAGES,
                                                              list(learned_sets)):
        p = profile()
        for s, rate in learned_sets[learned].get("rates", {}).items():
            p.note_rate(s, rate)
        if "reload_s" in learned_sets[learned]:
            p.note_offload(None, learned_sets[learned]["reload_s"])
        m = Machine(lambda: None, p, Audience(), lambda u, s: {})
        with clean_env():
            job = GpuJob(m, "job", [], core_expected=False, urgent=lambda: False, audio_s=audio)
        job.converted = converted
        t.add("silence_estimate", {"audio_s": audio, "converted": converted, "stage": stage,
                                   "learned": learned_sets[learned]},
              {"silence_est_s": r3(job.silence_estimate(stage))})


def t_allowance(t: Table) -> None:
    for urgent, people, limits in itertools.product([False, True], [True, False, None],
                                                    [{}, {"yield_max_s": 30.0, "yield_patient_s": 300.0}]):
        a = Audience(lambda: 0.0)
        if people is not None:
            a.update(True, 2 if people else 0, False, [])
        m = Machine(lambda: None, profile(), a, lambda u, s: {}, clock=lambda: 0.0)
        with clean_env():
            job = GpuJob(m, "job", [], core_expected=people is None, urgent=lambda: urgent)
        job.limits = limits_of(limits)
        t.add("yield_allowance", {"urgent": urgent, "people": people, "limits": limits},
              {"max_s": job.yield_allowance()})


def t_hold(t: Table) -> None:
    for poll, hold in [(0.1, 0.3), (0.1, 0.15), (0.2, 0.3), (0.1, 0.0), (0.05, 0.1)]:
        y = SpeechYield([], poll_s=poll, hold_s=hold)
        t.add("yield.hold", {"poll_s": poll, "hold_s": hold}, {"hold_s": y.hold_s})


TICK_BASE: dict[str, Any] = dict(
    policy="auto", stage="convert", window=False, people=True, urgent=False, recent=[], baseline=None,
    free_mb=6000, own_mb=0, total_mb=12288, low_reads=0, trimmed=False, reduced_to=None, speech_loaded=True,
    offload_useless=False, gap_s=0.0, quiet_age=None, reload_s=None, headroom_learned=None, limits={})


def run_tick(given: dict[str, Any]) -> dict[str, Any]:
    g = {**TICK_BASE, **given}
    now = [1000.0]
    p = profile(g["total_mb"])
    if g["baseline"] is not None:
        p.note_step(g["stage"], g["baseline"])
    if g["reload_s"] is not None:
        p.note_offload(None, g["reload_s"])
    if g["headroom_learned"] is not None:
        p._device()["headroom_mb"] = g["headroom_learned"]
    backend = TableBackend("12gb", free=g["free_mb"], total=g["total_mb"], own=g["own_mb"])
    a = Audience(lambda: now[0])
    if g["people"] is not None:
        a.update(True, 2 if g["people"] else 0, False, [])
    speech = {u: {"offloaded": not g["speech_loaded"]} for u in URLS}
    m = Machine(lambda: backend, p, a, health_getter(speech), clock=lambda: now[0])
    m.gap_until = now[0] + g["gap_s"]
    with clean_env():
        job = GpuJob(m, "job", URLS, core_expected=g["people"] is None, urgent=lambda: g["urgent"], audio_s=180.0)
    job.policy, job.limits = g["policy"], limits_of(g["limits"])
    job.facts = job.gather(g["stage"])
    job.started(g["stage"], "gpu")
    job.decision = Decision("exclusive", "window", "") if g["window"] else Decision("share", "fits", "")
    job.window, job.offload_useless, job.reduced_to = g["window"], g["offload_useless"], g["reduced_to"]
    job._trimmed, job._low_reads = g["trimmed"], g["low_reads"]
    job._quiet_from = None if g["quiet_age"] is None else now[0] - g["quiet_age"]
    job._checked = now[0] - 10.0  # this tick reads the card
    job.meter.recent.extend(g["recent"])
    act = job.tick(g["stage"])
    return {
        "action": None if act is None else {"kind": act.kind, "code": act.code, "reason": act.reason},
        "decision": f"{job.decision.mode}/{job.decision.code}",
        "spilling": job.spilling, "spills": job.spills, "trimmed": job._trimmed, "cpu_only": job.cpu_only,
        "reduced_to": job.reduced_to, "offload_useless": job.offload_useless, "crowded_mb": job.crowded_mb,
        "low_reads": job._low_reads, "recent": list(job.meter.recent),
        "quiet_age": None if job._quiet_from is None else r3(now[0] - job._quiet_from),
        "headroom_learned": p._known().get("headroom_mb"),
    }


def tick_inputs() -> Iterator[dict[str, Any]]:
    # 1. telling a spill: the last three steps against the normal one, the free VRAM, three low reads
    for baseline in (None, 0.1):
        limit = 0.5 if baseline else 2.0
        recents = [[], [limit, limit], [limit, limit * 0.5, limit], [limit * 0.99] * 3, [limit] * 3]
        yield from grid(baseline=[baseline], recent=recents, free_mb=[None, 6000, 1475, 737], low_reads=[0, 2],
                        window=[False, True])
    yield from grid(free_mb=[737, 738], low_reads=[2], people=[True, False, None], window=[False, True])
    # 2. what is done about it once the cache was freed (``trimmed``)
    spill = dict(trimmed=[True], baseline=[0.1], recent=[[0.6] * 3])
    yield from grid(stage=["separate", "convert"], policy=list(POLICIES), reduced_to=[None, 20], window=[True], **spill)
    yield from grid(stage=["separate", "lead"], policy=list(POLICIES), **spill)
    for g in grid(policy=list(POLICIES), reduced_to=[None, 20], speech_loaded=[True, False],
                  offload_useless=[False, True], gap_s=[0.0, 30.0],
                  who=[(True, True), (False, True), (False, False), (False, None)], **spill):
        urgent, people = g.pop("who")
        yield {**g, "urgent": urgent, "people": people}
    yield from grid(policy=["share", "auto"], window=[False, True], limits=[{"steps": 20, "steps_min": 20}], **spill)
    # 3. a window's silence limit while people listen
    yield from grid(policy=list(POLICIES), window=[True], people=[True, False, None],
                    quiet_age=[None, 44.9, 45.0, 59.9, 60.0], reload_s=[None, 80.0])


def t_tick(t: Table) -> None:
    t.base("tick", TICK_BASE)
    for given in tick_inputs():
        t.add("tick", given, run_tick(given))


def load_server() -> Any:
    """server.py as a module of its own (no lifespan: nothing starts, no backend is made)."""
    name = "sing_server_gpu_table"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, SING / "server.py")
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        with clean_env():
            spec.loader.exec_module(mod)
    return sys.modules[name]


def t_urgent(t: Table) -> None:
    mod = load_server()
    for urgent, others in itertools.product([[], ["me"], ["q1"], ["r0"], ["me", "q1"]],
                                            [[], [("q1", "queued")], [("r0", "done"), ("q1", "queued")]]):
        jobs = {"me": types.SimpleNamespace(id="me", state="running")}
        jobs.update({i: types.SimpleNamespace(id=i, state=s) for i, s in others})
        a = Audience()
        a.update(True, 2, False, urgent)
        state = types.SimpleNamespace(machine=types.SimpleNamespace(audience=a), lock=threading.Lock(),
                                      order=list(jobs), jobs=jobs)
        with patched((mod, "state", state)):
            got = mod._urgent(jobs["me"])
        t.add("server.urgent", {"urgent": urgent, "jobs": [[i, s] for i, s in others]}, {"urgent": got})


def t_recover(t: Table) -> None:
    mod = load_server()
    replies: list[Any] = ["error", {"offloaded": False}, {"offloaded": True, "reason": "sing"},
                          {"offloaded": True, "reason": "engine crashed"}, {"offloaded": True}]
    for tts, asr, reload_fails in itertools.product(replies, replies, [False, True]):
        if reload_fails and not any(isinstance(r, dict) and r.get("reason") == "sing" for r in (tts, asr)):
            continue
        calls: list[str] = []
        health = {"http://tts": tts, "http://asr": asr}

        def get(url: str, timeout: float) -> dict[str, Any]:
            calls.append(f"GET {url} {timeout}")
            return health_getter(health)(url, timeout)

        def post(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
            calls.append(f"POST {url} {dump(body)} {timeout}")
            if reload_fails:
                raise ConnectionError("connection refused")
            return {"state": "ready"}

        state = types.SimpleNamespace(busy_get=get, offload_post=post)
        with clean_env(SING_OFFLOAD_URLS=",".join(URLS)), patched((mod, "state", state)):
            mod._recover_speech()
        t.add("server.recover_speech", {"health": [tts, asr], "reload_fails": reload_fails}, {"calls": calls})


FUNCTIONS = {
    "policy_from_env": "gpu.policy_from_env(env): which policy, and where it came from",
    "limits_from_env": "gpu.Limits.from_env(): one field, its variable set to a raw string or unset",
    "decide": "gpu.decide(Facts): the placement of a stage. `in` is a change of bases.decide; `limits` a change of limits_default",
    "gather": "gpu.GpuJob.gather(stage): the Facts a decision sees, from the card, the learned profile, the speech workers' /health, Core's context and the job",
    "headroom": "gpu.Profile.headroom(total, limits): free VRAM the card must keep (Python round: half to even)",
    "typical_peak": "gpu.typical_peak(peaks): the peak a stage is assumed to need from its recent peaks",
    "profile.note_step": "gpu.Profile.note_step: the normal step time after one clean run (sinks at once, rises 20 % at most)",
    "profile.note_spill": "gpu.Profile.note_spill: the learned headroom after a spill at free_mb",
    "profile.note_healthy": "gpu.Profile.note_healthy: the learned headroom after a clean run whose lowest free was free_min_mb",
    "audience.people": "gpu.Audience.people(ttl, core_expected): would anyone notice her voice going (None: unknown)",
    "speech.read": "gpu.Speech.read(): the speech workers loaded or not, and what their last offload released, from /health",
    "speech.read_cache": "gpu.Speech.read(): a reading is reused for every_s unless forget() was called",
    "silence_estimate": "gpu.GpuJob.silence_estimate(stage): how long her voice would be gone if a window opened now",
    "yield_allowance": "gpu.GpuJob.yield_allowance(): how long in total the job gives way while she speaks",
    "yield.hold": "yielding.SpeechYield: how long it stays out of the way after the last busy answer",
    "tick": "gpu.GpuJob.tick(stage) once, before a step: spill detection, the window's silence limit and the response",
    "server.urgent": "server._urgent(job): the job, or a queued one, is in Core's urgent list",
    "server.recover_speech": "server._recover_speech(): what a starting worker asks of speech workers left offloaded",
}


def build_table() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    t = Table()
    envmap = limits_env()
    t_policy(t)
    t_limits(t, envmap)
    t_decide(t)
    t_gather(t)
    t_headroom(t)
    t_peaks(t)
    t_learning(t)
    t_people(t)
    t_speech(t)
    t_silence(t)
    t_allowance(t)
    t_hold(t)
    t_tick(t)
    t_urgent(t)
    t_recover(t)
    counts = Counter(c["fn"] for c in t.cases)
    header = {
        "about": "Decisions of the song worker's GPU code (workers/sing/gpu.py, server.py), recorded by "
                 "workers/tests/test_gpu_table.py; see docs/design/v5-gpu.md. A case's input is `bases[fn]` "
                 "with `in` laid over it (a missing base: `in` is the whole input). A `limits` object is a "
                 "change of `limits_default`.",
        "functions": {fn: {"about": about, "cases": counts[fn]} for fn, about in FUNCTIONS.items()},
        "limits_default": LIMITS_DEFAULT,
        "limits_env": envmap,
        "bases": t.bases,
        "constants": {
            "policies": list(POLICIES), "default_policy": policy_from_env({})[0], "cpu_stages": list(CPU_STAGES),
            "cpu_fallback": "empty unless SING_CPU_FALLBACK is set; a real backend whose separator is a Demucs "
                            "model (not melband) adds `separate` when SING_CPU_FALLBACK is unset",
            "watch_s": gpu.WATCH_S, "low_free_reads": gpu.LOW_FREE_READS, "reload_prior_s": gpu.RELOAD_PRIOR_S,
            "rate_priors": gpu.RATE_PRIORS, "peaks_kept": gpu.PEAKS_KEPT, "spill_margin_mb": gpu.SPILL_MARGIN_MB,
            "speech_read_every_s": 2.0, "speech_read_timeout_s": 0.5,
        },
        "other_env": {
            "SING_OFFLOAD_URLS": "speech workers asked to offload, comma separated (default none)",
            "SING_YIELD_URLS": "speech workers yielded to (default SING_OFFLOAD_URLS)",
            "SING_EXCLUSIVE_WAIT_S": 30.0, "SING_RELOAD_TIMEOUT_S": 300.0,
            "SING_YIELD_POLL_MS": 100, "SING_YIELD_HOLD_MS": 300,
            "offload_timeout_s": 60.0, "renew_every": "max_s / 3", "renew_timeout_s": "min(5, max_s / 3)",
        },
    }
    return header, t.cases


def table_text(header: dict[str, Any], cases: list[dict[str, Any]]) -> str:
    lines = ['{"header": ' + json.dumps(header, ensure_ascii=False, sort_keys=True, indent=1) + ",", '"cases": [']
    lines += [dump(c) + ("," if i < len(cases) - 1 else "") for i, c in enumerate(cases)]
    return "\n".join(lines + ["]}", ""])


# ── the scenarios: a deterministic simulation ────────────────────────────────


class SimStop(BaseException):
    """Unwinds a simulated thread: its worker died, or the scenario is over."""


class SimError(Exception):
    pass


class _Part:
    """One thread of the simulation (the driver, or a thread the worker started)."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.go = threading.Event()
        self.wake_at: float | None = None
        self.seq = 0
        self.event: FakeEvent | None = None
        self.done = self.killed = self.frozen = False
        self.thread: threading.Thread | None = None


class Sim:
    """A clock and a scheduler. Exactly one simulated thread runs at a time; one that waits hands on
    to the one due first (then the one that has waited longest). Timers run in between."""

    def __init__(self) -> None:
        self.now = 0.0
        self._seq = itertools.count()
        self.timers: list[tuple[float, int, Callable[[], None]]] = []
        self.parts: list[_Part] = []
        self.main = _Part("main")
        self.current = self.main
        self.dead = False
        self.failed: str | None = None
        self.errors: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.probes: list[tuple[str, Callable[[], Any]]] = []
        self._seen: dict[str, Any] = {}
        self.counts: Counter[str] = Counter()

    def clock(self) -> float:
        return self.now

    def at(self, t: float, fn: Callable[[], None]) -> None:
        heapq.heappush(self.timers, (t, next(self._seq), fn))

    def note(self, **kw: Any) -> dict[str, Any]:
        self.probe()
        event = {"t": r3(self.now), **kw}
        self.events.append(event)
        return event

    def probe(self) -> None:
        for name, fn in self.probes:
            value = fn()
            if self._seen.get(name, ()) != value:
                self._seen[name] = value
                self.events.append({"t": r3(self.now), name: value})

    def sleep(self, seconds: float) -> None:
        self._block(self.now + seconds)

    def _block(self, wake_at: float, event: "FakeEvent | None" = None) -> None:
        if self.dead:
            raise SimStop()
        self.probe()
        me = self.current
        me.wake_at, me.seq, me.event = wake_at, next(self._seq), event
        if event is not None:
            event.waiters.append(me)
        nxt = self._pick()
        if nxt is not me:
            self.current = nxt
            nxt.go.set()
            me.go.wait()
            me.go.clear()
        if me.killed or self.dead:
            raise SimStop()
        if self.failed and me is self.main:
            raise SimError(self.failed)

    def _pick(self) -> _Part:
        while True:
            self.probe()  # what changed is seen at the time it changed, before the clock moves on
            ready =[p for p in [self.main, *self.parts] if p.wake_at is not None and not p.frozen and not p.done]
            best = min(ready, key=lambda p: (p.wake_at, p.seq), default=None)
            if self.timers and (best is None or self.timers[0][:2] < (best.wake_at, best.seq)):
                t, _, fn = heapq.heappop(self.timers)
                self.now = max(self.now, t)
                fn()
                self.probe()
                continue
            if best is None or best.wake_at == math.inf:
                self.failed = "deadlock: every thread waits for ever"
                best = self.main
            else:
                self.now = max(self.now, best.wake_at)
            if best.event is not None and best in best.event.waiters:
                best.event.waiters.remove(best)
            best.wake_at, best.event = None, None
            self.probe()
            return best

    def _exit(self, part: _Part, finished: "FakeEvent") -> None:
        if part in self.parts:
            self.parts.remove(part)
        if self.dead:
            return
        finished.set()
        nxt = self._pick()
        self.current = nxt
        nxt.go.set()

    def freeze(self) -> None:
        """The worker's process is gone: none of its threads runs again."""
        for p in self.parts:
            p.frozen = True

    def close(self) -> None:
        """Ends the threads still there, one at a time: every wait raises ``SimStop`` from here on."""
        self.dead = True
        for p in list(self.parts):
            if p.done:
                continue
            p.killed = True
            p.go.set()
            assert p.thread is not None
            p.thread.join(10)
            if p.thread.is_alive():
                raise SimError(f"thread {p.name} did not stop")
        self.parts.clear()


class FakeEvent:
    def __init__(self, sim: Sim) -> None:
        self.sim = sim
        self.flag = False
        self.waiters: list[_Part] = []

    def is_set(self) -> bool:
        return self.flag

    def set(self) -> None:
        self.flag = True
        for p in self.waiters:
            p.wake_at, p.seq, p.event = self.sim.now, next(self.sim._seq), None
        self.waiters = []

    def clear(self) -> None:
        self.flag = False

    def wait(self, timeout: float | None = None) -> bool:
        if self.flag:
            return True
        self.sim._block(self.sim.now + timeout if timeout is not None else math.inf, self)
        return self.flag


class SimThread:
    def __init__(self, sim: Sim, target: Callable[[], Any], name: str | None = None, daemon: bool | None = None) -> None:
        self.sim, self.target, self.name = sim, target, name or "thread"
        self.part: _Part | None = None
        self.finished = FakeEvent(sim)

    def start(self) -> None:
        if self.sim.dead:
            return
        p = self.part = _Part(self.name)
        p.wake_at, p.seq = self.sim.now, next(self.sim._seq)
        self.sim.parts.append(p)
        p.thread = threading.Thread(target=self._run, name=f"sim-{self.name}", daemon=True)
        p.thread.start()

    def _run(self) -> None:
        p = self.part
        assert p is not None
        p.go.wait()
        p.go.clear()
        try:
            if not (p.killed or self.sim.dead):
                self.target()
        except SimStop:
            pass
        except BaseException as e:  # noqa: BLE001 - reported by the scenario
            self.sim.errors.append(f"{self.name}: {type(e).__name__}: {e}")
        finally:
            p.done = True
            self.sim._exit(p, self.finished)

    def join(self, timeout: float | None = None) -> None:
        if self.part is None or self.part.done:
            if self.sim.dead:
                raise SimStop()
            return
        self.finished.wait(timeout)

    def is_alive(self) -> bool:
        return self.part is not None and not self.part.done


class Peer:
    """A speech worker as the song worker sees it: /health, /busy, /offload with its lease, /reload.
    A model of asr/server.py and tts/server.py (not their code), with their timings made up."""

    def __init__(self, sim: Sim, name: str, mb: int, offload_s: float, reload_s: float) -> None:
        self.sim, self.name, self.mb, self.offload_s, self.reload_s = sim, name, mb, offload_s, reload_s
        self.state = "loaded"  # loaded | offloading | offloaded | reloading
        self.reason: str | None = None
        self.released: int | None = None
        self.reachable = True
        self.busy: list[tuple[float, float]] = []
        self._lease = 0

    def memory(self) -> int:
        return 0 if self.state == "offloaded" else self.mb

    def health(self) -> dict[str, Any]:
        # The workers drop their model reference first, so /health says offloaded from the start of
        # an offload until a reload has finished.
        gone = self.state != "loaded"
        out: dict[str, Any] = {"status": "ok", "offloaded": gone, "loading": self.state == "reloading",
                               "released_mb": self.released}
        if gone:
            out["reason"] = self.reason
        return out

    def busy_now(self) -> int:
        return sum(1 for a, b in self.busy if a <= self.sim.now < b)

    def lease(self, max_s: float | None) -> None:
        self._lease += 1
        token = self._lease
        max_s = 900.0 if max_s is None else max_s
        if max_s > 0:
            self.sim.at(self.sim.now + max_s, lambda: self._expired(token))

    def _expired(self, token: int) -> None:
        if token != self._lease or self.state != "offloaded":
            return
        self.sim.note(peer=self.name, does="nobody renewed the offload: reloads by itself")
        self.state = "reloading"
        self.sim.at(self.sim.now + self.reload_s, lambda: self._reloaded(token))

    def _reloaded(self, token: int) -> None:
        if token == self._lease and self.state == "reloading":
            self.state, self.reason = "loaded", None

    def offload(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.state == "loaded":
            self.state = "offloading"
            self.sim.sleep(self.offload_s)
            self.state, self.reason, self.released = "offloaded", (body.get("reason") or "")[:80], self.mb
            self.lease(body.get("max_s"))
            return {"state": "offloaded", "offload_ms": round(self.offload_s * 1000), "released_mb": self.mb}
        if self.state == "reloading":
            self.state = "offloaded"
            self.lease(body.get("max_s"))
            return {"state": "offloaded", "offload_ms": 0, "cancelled_reload": True}
        self.lease(body.get("max_s"))
        return {"state": "offloaded", "offload_ms": 0, "already": True}

    def reload(self) -> dict[str, Any]:
        if self.state == "loaded":
            return {"state": "ready", "reload_ms": 0, "already": True}
        self._lease += 1  # a pending lease no longer counts
        if self.state != "reloading":
            self.state = "reloading"
            self.sim.sleep(self.reload_s)
            self.state, self.reason = "loaded", None
        else:
            while self.state != "loaded":
                self.sim.sleep(0.5)
        return {"state": "ready", "reload_ms": round(self.reload_s * 1000)}


class SimCard:
    def __init__(self, total: int, others: int, peers: dict[str, Peer], job_mb: int) -> None:
        self.total, self.others, self.peers, self.job_mb = total, others, peers, job_mb
        self.cuda = True
        self.running: str | None = None  # the device of the stage running now
        self.extra = 0  # a subprocess's VRAM (her RVC model), not this process's
        self.spill_under = 0
        self.slow_factor = 10.0
        self.gate_set: Callable[[], bool] = lambda: False

    def own(self) -> int:
        return self.job_mb if self.running == "gpu" and self.gate_set() else 0

    def free(self) -> int:
        return max(0, self.total - self.others - self.extra - sum(p.memory() for p in self.peers.values()) - self.own())


class SimBackend:
    name = "sim"

    def __init__(self, sim: Sim, card: SimCard) -> None:
        self.sim, self.card = sim, card
        self.gate: Callable[[], None] | None = None
        self.rvc = False

    def uses_cuda(self) -> bool:
        return self.card.cuda

    def vram(self, peek: bool = False) -> tuple[int, int]:
        return self.card.free(), self.card.total

    def own_vram_mb(self) -> int:
        return self.card.own()

    def gpu_name(self) -> str:
        return "Sim GPU"

    def trim(self) -> None:
        self.sim.note(backend="trim: frees its own cache")

    def unload(self) -> None:
        self.sim.note(backend="unload: drops its models")


SCENARIO_DEFAULTS: dict[str, Any] = dict(
    env={}, total=12288, others=4500, peers={"tts": [4700, 3.0, 20.0], "asr": [1500, 1.0, 8.0]}, unreachable=[],
    job_mb=3500, cuda=True, spill_under=0, profile={}, ack=False, go_after=4.0, people=[[0.0, True, 2, False]],
    urgent=False, core_gone=None, core_back=None, busy={}, card_changes=[], audio_s=180.0, rvc=False,
    cpu_fallback=[], die_at=None, restart_at=None, horizon=2400.0, tail=5.0, offline_from_start=[],
    stages=[{"stage": "convert", "steps": 40, "step_s": 1.0}],
)

# speech workers: [MB, offload s, reload s]; people: [t, in_voice, listeners, live]; busy: peer -> [[from, to]]
SCENARIO_LIST: list[dict[str, Any]] = [
    dict(name="share_24gb_people_she_speaks_mid_song",
         about="24 GB card, people listening: every stage shares; TTS busy for 6 s mid-conversion, the job "
               "pauses between steps, no speech worker is asked anything",
         total=24576, busy={"tts": [[25.0, 31.0]]},
         stages=[{"stage": "lead", "steps": 20, "step_s": 0.5}, {"stage": "convert", "steps": 60, "step_s": 1.0}]),
    dict(name="yield_window_after_core_says_go",
         about="Default policy (yield), 12 GB on stream, people listening: no room, so her voice goes offline; "
               "Core lets her say so first and answers go 4 s later; the lease is renewed every 20 s",
         ack=True, stages=[{"stage": "convert", "steps": 50, "step_s": 1.0}]),
    dict(name="yield_window_core_never_says_go",
         about="As above, but Core never answers: the worker waits SING_EXCLUSIVE_WAIT_S (30 s) and goes ahead",
         ack=True, go_after=None, stages=[{"stage": "convert", "steps": 20, "step_s": 1.0}]),
    dict(name="yield_long_song_bounded_windows_and_gap",
         about="yield, people listening, 150 s of conversion: each window ends at its silence limit, her voice "
               "comes back, the job waits the gap (SING_SILENCE_GAP_S) and opens the next window",
         stages=[{"stage": "convert", "steps": 150, "step_s": 1.0}]),
    dict(name="yield_nobody_listening_then_someone_joins",
         about="yield, alone in voice: the window has no limit until someone joins at 60 s; from then the "
               "silence clock runs and the window ends at its limit",
         people=[[0.0, True, 0, False], [60.0, True, 1, False]],
         stages=[{"stage": "convert", "steps": 200, "step_s": 1.0}]),
    dict(name="yield_demucs_separation_takes_a_window_too",
         about="yield with SING_CPU_FALLBACK=separate (a Demucs separator): while her voice can be offloaded the "
               "separation takes a window like any stage (the CPU only during a gap or with nothing to offload, "
               "unlike what gpu.py's docstring says); the conversion goes on in the same window",
         cpu_fallback=["separate"],
         stages=[{"stage": "separate", "steps": 10, "step_s": 0.5, "cpu_step_s": 3.0},
                 {"stage": "convert", "steps": 30, "step_s": 1.0}]),
    dict(name="auto_people_waits_then_short_silence",
         about="auto, people listening, not urgent: separation on the CPU, conversion waits for room; after "
               "SING_DEFER_S (120 s) with an estimated silence of 84 s it takes a short window",
         env={"SING_GPU_POLICY": "auto"},
         stages=[{"stage": "separate", "steps": 10, "step_s": 0.5, "cpu_step_s": 3.0},
                 {"stage": "convert", "steps": 54, "step_s": 1.0}]),
    dict(name="auto_people_long_song_waits_the_maximum",
         about="auto, people listening, a 400 s song (estimated silence 150 s > 90 s): it waits SING_WAIT_MAX_S "
               "(600 s), then works in bounded windows",
         env={"SING_GPU_POLICY": "auto"}, audio_s=400.0,
         stages=[{"stage": "convert", "steps": 100, "step_s": 1.0}]),
    dict(name="auto_urgent_takes_a_window_now",
         about="auto, people listening, Core marks the song urgent (asked by command): a window at once, after go",
         env={"SING_GPU_POLICY": "auto"}, ack=True, urgent=True,
         stages=[{"stage": "convert", "steps": 40, "step_s": 1.0}]),
    dict(name="auto_core_goes_quiet_mid_wait_then_says_nobody",
         about="auto, exclusive_ack: Core stops pushing context at 30 s; after SING_CONTEXT_TTL_S (20 s) "
               "nobody is known to be listening or not, which counts as people; Core is back at 100 s saying "
               "nobody listens, and the job takes a window",
         env={"SING_GPU_POLICY": "auto"}, ack=True, core_gone=30.0, core_back=100.0,
         people=[[0.0, True, 2, False], [90.0, True, 0, False]],
         stages=[{"stage": "convert", "steps": 30, "step_s": 1.0}]),
    dict(name="auto_core_gone_with_a_window_open",
         about="auto, nobody listening, window open; Core goes away at 20 s: unknown counts as people, the "
               "silence clock starts and the window ends at its limit",
         env={"SING_GPU_POLICY": "auto"}, core_gone=20.0, people=[[0.0, True, 0, False]],
         stages=[{"stage": "convert", "steps": 150, "step_s": 1.0}]),
    dict(name="peer_offload_fails",
         about="yield: the TTS worker cannot be reached; the window opens with what could be offloaded, the "
               "renewals and the reload still ask both",
         unreachable=["tts"], stages=[{"stage": "convert", "steps": 45, "step_s": 1.0}]),
    dict(name="holder_dies_mid_window_restart_after_lease",
         about="yield: the song worker dies 30 s into a window; nobody renews, each speech worker reloads by "
               "itself 60 s after the last renewal; the worker starts again at 200 s and finds them loaded",
         die_at=30.0, restart_at=200.0, horizon=260.0,
         stages=[{"stage": "convert", "steps": 100, "step_s": 1.0}]),
    dict(name="holder_dies_mid_window_restart_before_lease",
         about="As above, but the worker is back 10 s later: _recover_speech finds them offloaded for a song "
               "and asks them back",
         die_at=30.0, restart_at=40.0, horizon=120.0,
         stages=[{"stage": "convert", "steps": 100, "step_s": 1.0}]),
    dict(name="auto_spill_while_sharing_people",
         about="auto, 16 GB, room by the estimate, but the steps run 10x slower (a spill): free its own cache, "
               "then let go of the card and wait (people listening); room again at 90 s, more than at the "
               "spill, so it shares again and goes on from its step",
         env={"SING_GPU_POLICY": "auto"}, total=16384, others=500, spill_under=100000,
         profile={"step_s": {"convert": 1.0}}, card_changes=[[90.0, {"spill_under": 0, "others": 0}]],
         stages=[{"stage": "convert", "steps": 30, "step_s": 1.0}]),
    dict(name="auto_spill_in_separation_goes_to_cpu",
         about="auto: separation spills on the card and is done again on the CPU",
         env={"SING_GPU_POLICY": "auto"}, others=500, spill_under=100000,
         profile={"step_s": {"separate": 0.5}}, card_changes=[[30.0, {"spill_under": 0}]],
         stages=[{"stage": "separate", "steps": 10, "step_s": 0.5, "cpu_step_s": 3.0},
                 {"stage": "convert", "steps": 20, "step_s": 1.0}]),
    dict(name="auto_spill_inside_a_window_reduce_then_give_up",
         about="auto, urgent: it spills even with her voice offline: fewer diffusion steps, then her voice back, "
               "and with nothing that helps the job fails after SING_WAIT_MAX_S (here 200 s)",
         env={"SING_GPU_POLICY": "auto", "SING_WAIT_MAX_S": "200"}, urgent=True, spill_under=100000,
         profile={"step_s": {"convert": 1.0}}, stages=[{"stage": "convert", "steps": 60, "step_s": 1.0}]),
    dict(name="yield_spill_inside_a_window_gives_up",
         about="The same under the default policy yield: offloading did not help, so the job waits for room, "
               "and after SING_WAIT_MAX_S (600 s of waiting in all) it fails saying how much it needed and "
               "how much was free (until 2026-11-16 it waited for ever)",
         urgent=True, spill_under=100000, horizon=900.0,
         profile={"step_s": {"convert": 1.0}}, stages=[{"stage": "convert", "steps": 60, "step_s": 1.0}]),
    dict(name="yield_never_enough_room",
         about="yield, 12 GB with 9 GB taken by other programs and her voice already offline for another "
               "holder: nothing to offload, no room; the job waits SING_WAIT_MAX_S and fails with the reason",
         others=9000, offline_from_start=["tts", "asr"],
         stages=[{"stage": "convert", "steps": 20, "step_s": 1.0}]),
    dict(name="backing_yield_one_window",
         about="yield, people listening, backing: convert: the backing voices' pass runs in the window the "
               "lead's conversion opened, under the same silence limit, and her voice is given back once, "
               "after it (until 2026-11-16 it was given back after the lead and the backing pass ran on the "
               "card while TTS and ASR reloaded)",
         ack=True, stages=[{"stage": "convert", "steps": 30, "step_s": 1.0},
                           {"stage": "convert", "backing": True, "steps": 20, "step_s": 1.0}]),
    dict(name="backing_yield_silence_limit_in_the_backing_pass",
         about="yield, people listening: the window's silence limit falls in the backing pass; it stops, her "
               "voice comes back, and after the gap a new window lets it go on from its step",
         stages=[{"stage": "convert", "steps": 40, "step_s": 1.0},
                 {"stage": "convert", "backing": True, "steps": 40, "step_s": 1.0}]),
    dict(name="backing_auto_people_short_silence",
         about="auto, people listening: the conversion waits SING_DEFER_S, then one short window holds both "
               "passes",
         env={"SING_GPU_POLICY": "auto"},
         stages=[{"stage": "convert", "steps": 30, "step_s": 1.0},
                 {"stage": "convert", "backing": True, "steps": 15, "step_s": 1.0}]),
    dict(name="backing_share_yields_to_her_in_the_backing_pass",
         about="24 GB, both passes share the card; she speaks during the backing pass and it gives way, as "
               "the first pass would",
         total=24576, busy={"tts": [[25.0, 31.0]]},
         stages=[{"stage": "convert", "steps": 20, "step_s": 1.0},
                 {"stage": "convert", "backing": True, "steps": 20, "step_s": 1.0}]),
    dict(name="auto_oom_then_window_nobody_listening",
         about="auto, nobody listening, room by the estimate, but the first step runs out of VRAM: the room "
               "then is remembered (crowded), and the job takes a window",
         env={"SING_GPU_POLICY": "auto"}, others=0, people=[[0.0, True, 0, False]],
         stages=[{"stage": "convert", "steps": 20, "step_s": 1.0, "oom_once": True}]),
    dict(name="yield_patience_urgent_song",
         about="24 GB, sharing; TTS busy from 5 s for 400 s; the song is urgent: it gives way SING_YIELD_MAX_S "
               "(120 s) in all, then goes on regardless",
         total=24576, urgent=True, busy={"tts": [[5.0, 405.0]]},
         stages=[{"stage": "convert", "steps": 30, "step_s": 1.0}]),
    dict(name="yield_patience_song_nobody_waits_for",
         about="The same for a song nobody is waiting for: up to SING_YIELD_PATIENT_S (900 s), so it waits out "
               "the 400 s",
         total=24576, busy={"tts": [[5.0, 405.0]]},
         stages=[{"stage": "convert", "steps": 30, "step_s": 1.0}]),
    dict(name="share_policy_spill_reduces_then_waits",
         about="SING_GPU_POLICY=share: never touches her voice; a spill frees the cache, then cuts the steps to "
               "SING_DIFFUSION_STEPS_MIN, then lets go and waits SING_DEFER_S before sharing again",
         env={"SING_GPU_POLICY": "share"}, spill_under=100000, card_changes=[[200.0, {"spill_under": 0}]],
         profile={"step_s": {"convert": 1.0}}, stages=[{"stage": "convert", "steps": 20, "step_s": 1.0}]),
    dict(name="wait_policy_until_room",
         about="SING_GPU_POLICY=wait: separation on the CPU, conversion waits for room for as long as it takes "
               "(the stream ends at 300 s)",
         env={"SING_GPU_POLICY": "wait"}, urgent=True, card_changes=[[300.0, {"others": 0}]],
         stages=[{"stage": "separate", "steps": 10, "step_s": 0.5, "cpu_step_s": 3.0},
                 {"stage": "convert", "steps": 20, "step_s": 1.0}]),
    dict(name="offload_policy_on_a_big_card",
         about="SING_GPU_POLICY=offload: her voice goes offline for the job even on a 24 GB card",
         env={"SING_GPU_POLICY": "offload"}, total=24576,
         stages=[{"stage": "convert", "steps": 30, "step_s": 1.0}]),
    dict(name="no_cuda",
         about="No CUDA: every stage on the CPU, nothing asked of anyone",
         cuda=False, stages=[{"stage": "separate", "steps": 5, "step_s": 0.5, "cpu_step_s": 2.0},
                             {"stage": "convert", "steps": 10, "step_s": 1.0, "cpu_step_s": 4.0}]),
    dict(name="rvc_stage_needs_room_for_her_voice",
         about="16 GB: the RVC conversion (a subprocess that never stops between steps) fits by itself but not "
               "with the 1 GB her voice takes while speaking, so under yield it takes a window; the card is read "
               "every 0.25 s while it runs",
         total=16384, others=3500, rvc=True, job_mb=0,
         stages=[{"stage": "convert", "steps": 1, "step_s": 30.0, "rvc_mb": 2600}]),
]


def make_pipeline(s: dict[str, Any], mod: Any, sim: "Sim", card: "SimCard", backend: "SimBackend") -> Callable[[Any], None]:
    """The scenario's stages through the worker's real job loop: each GPU stage through
    ``_gpu_stage``, and consecutive ``convert`` stages (the lead, then with ``"backing": true`` the
    backing voices' pass) through ``_convert_passes``, as ``_run_job`` runs them. A stage takes
    ``steps`` of ``step_s`` on the card (ten times longer under ``card.spill_under`` free), or of
    ``cpu_step_s`` on the CPU; a conversion pass goes on from its last finished step."""
    progress: dict[str, int] = {}
    oom_left = {st["stage"]: bool(st.get("oom_once")) for st in s["stages"]}

    def make_run(st: dict[str, Any], work: Any, job: Any) -> Callable[[str], None]:
        name = st["stage"]
        key = "backing" if st.get("backing") else name  # what is counted, and where a pass goes on from

        def run(device: str) -> None:
            card.running = device
            try:
                if device == "gpu" and name == "convert" and backend.rvc:
                    card.extra += st.get("rvc_mb", 0)
                    try:
                        sim.sleep(st["steps"] * st["step_s"])
                    finally:
                        card.extra -= st.get("rvc_mb", 0)
                    sim.counts[f"{key} steps on gpu"] += st["steps"]
                    return
                for i in range(progress.get(key, 0) if name == "convert" else 0, st["steps"]):
                    if backend.gate is not None:
                        backend.gate()
                    if device == "gpu" and oom_left[name] and not (job.gpu and job.gpu.window):
                        oom_left[name] = False
                        raise RuntimeError("CUDA out of memory (simulated)")
                    if device == "gpu":
                        fewer = (work.steps or 30) / 30 if work is not None and name == "convert" else 1.0
                        slow = card.slow_factor if card.free() < card.spill_under else 1.0
                        sim.sleep(st["step_s"] * slow * fewer)
                    else:
                        sim.sleep(st.get("cpu_step_s", st["step_s"] * 20))
                    if name == "convert":
                        progress[key] = i + 1
                    sim.counts[f"{key} steps on {device}"] += 1
            finally:
                card.running = None

        return run

    def pipeline(job: Any) -> None:
        stages = s["stages"]
        i = 0
        while i < len(stages):
            st = stages[i]
            if st["stage"] != "convert":
                mod._gpu_stage(job, st["stage"], Path("sim.wav"), s["audio_s"], make_run(st, None, job))
                i += 1
                continue
            passes = []
            while i < len(stages) and stages[i]["stage"] == "convert":
                work = mod.ConvertWork()
                passes.append(lambda st=stages[i], work=work: mod._gpu_stage(
                    job, "convert", Path("sim.wav"), s["audio_s"], make_run(st, work, job), work))
                i += 1
            mod._convert_passes(job, passes)

    return pipeline


def run_scenario(spec: dict[str, Any]) -> dict[str, Any]:
    s = {**SCENARIO_DEFAULTS, **spec}
    mod = load_server()
    sim = Sim()
    peers = {name: Peer(sim, name, *vals) for name, vals in s["peers"].items()}
    for name in s["unreachable"]:
        peers[name].reachable = False
    for name in s["offline_from_start"]:  # offloaded by another holder: no lease of ours, never back
        peers[name].state, peers[name].reason, peers[name].released = "offloaded", "other", None
    for name, spans in s["busy"].items():
        peers[name].busy = [tuple(x) for x in spans]
    card = SimCard(s["total"], s["others"], peers, s["job_mb"])
    card.cuda, card.spill_under = s["cuda"], s["spill_under"]
    backend = SimBackend(sim, card)
    backend.rvc = s["rvc"]
    card.gate_set = lambda: backend.gate is not None
    p = profile(s["total"])
    for stage, step in s["profile"].get("step_s", {}).items():
        p.note_step(stage, step)
    audience = Audience(sim.clock)

    def peer_of(url: str) -> tuple[Peer, str]:
        base, what = url.rsplit("/", 1)
        return peers[base.split("//", 1)[1]], what

    def get(url: str, timeout: float) -> dict[str, Any]:
        if sim.dead:
            raise SimStop()
        peer, what = peer_of(url)
        sim.counts[f"GET /{what}"] += 1
        if not peer.reachable:
            raise ConnectionError("connection refused")
        return {"busy": peer.busy_now()} if what == "busy" else peer.health()

    def post(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
        if sim.dead:
            raise SimStop()
        peer, what = peer_of(url)
        call = sim.note(call=f"POST {peer.name}/{what}", **({"body": body} if body else {}))
        if not peer.reachable:
            call["reply"] = "connection refused"
            raise ConnectionError("connection refused")
        out = peer.offload(body) if what == "offload" else peer.reload()
        call["reply"] = out
        return out

    job = mod.Job(id="job1", request=mod.JobRequest(query="sim", exclusive_ack=s["ack"]),
                  cancel=FakeEvent(sim), go=FakeEvent(sim))
    machine = Machine(lambda: backend, p, audience, get, clock=sim.clock)
    state = types.SimpleNamespace(machine=machine, backend=backend, offload_post=post, busy_get=get,
                                  jobs={job.id: job}, order=[job.id], lock=threading.Lock(), running=job.id)
    pipeline = make_pipeline(s, mod, sim, card, backend)

    outcome: dict[str, Any] = {"state": "running at the horizon"}

    def job_main() -> None:
        try:
            mod.run_job(job)
            outcome["state"] = "done"
        except mod.Cancelled:
            outcome["state"] = "cancelled"
        except mod.JobError as e:
            outcome.update(state="failed", error=str(e))
        sim.note(job=outcome["state"])

    # Core: pushes who listens every 1.5 s while the song is prepared, and says go once she told everyone.
    core = {"go_due": False}

    def people_now() -> list[Any]:
        return [x for x in s["people"] if x[0] <= sim.now][-1]

    def core_poll() -> None:
        if worker["dead"]:
            return
        gone = s["core_gone"] is not None and s["core_gone"] <= sim.now and (
            s["core_back"] is None or sim.now < s["core_back"])
        if not gone:
            _, in_voice, listeners, live = people_now()
            audience.update(in_voice, listeners, live, [job.id] if s["urgent"] else [])
            ex = job.exclusive
            if ex is not None and ex.state == "waiting" and not core["go_due"] and s["go_after"] is not None:
                core["go_due"] = True

                def go() -> None:
                    core["go_due"] = False
                    sim.note(core="POST /jobs/{id}/exclusive (go)")
                    job.go.set()

                sim.at(sim.now + s["go_after"], go)
        if outcome["state"] == "running at the horizon":
            sim.at(sim.now + 1.5, core_poll)

    worker = {"dead": False}

    def die() -> None:
        sim.note(worker="the song worker's process dies")
        worker["dead"] = True
        sim.freeze()
        card.running, card.extra = None, 0
        backend.gate = None

    def restart() -> None:
        sim.note(worker="the song worker starts again: _recover_speech")
        SimThread(sim, mod._recover_speech, "recover").start()

    def change(values: dict[str, Any]) -> Callable[[], None]:
        def apply() -> None:
            for k, v in values.items():
                setattr(card, k, v)
            sim.note(card=values)

        return apply

    sim.probes = [
        ("stage", lambda: job.stage),
        ("exclusive", lambda: job.exclusive.state if job.exclusive is not None else None),
        ("window", lambda: bool(job.gpu and job.gpu.window)),
        ("running", lambda: card.running),
        ("yield_pauses", lambda: job.yielding.pauses if job.yielding is not None else 0),
        *[(f"{name}", (lambda pr: lambda: pr.state)(pr)) for name, pr in peers.items()],
    ]

    original_note = GpuJob._note

    def note(self: GpuJob, stage: str, d: Decision) -> None:
        last = self.history[-1] if self.history else None
        original_note(self, stage, d)
        if self.history and self.history[-1] is not last:
            sim.note(decision=f"{d.mode}/{d.code}", at_stage=stage, reason=d.reason)

    fake_threading = types.SimpleNamespace(
        Lock=threading.Lock, Event=lambda: FakeEvent(sim),
        Thread=lambda target, name=None, daemon=None: SimThread(sim, target, name, daemon))
    fake_time = types.SimpleNamespace(monotonic=sim.clock, sleep=sim.sleep, time=sim.clock, perf_counter=sim.clock)
    env = {"SING_OFFLOAD_URLS": "http://tts,http://asr", **s["env"]}
    with clean_env(**env), patched(
            (mod, "state", state), (mod, "_run_job", pipeline),
            (gpu, "threading", fake_threading), (gpu, "time", fake_time), (GpuJob, "_note", note),
            (exclusive, "threading", fake_threading), (exclusive, "time", fake_time),
            (yielding, "threading", fake_threading), (yielding, "time", fake_time)):
        gpu.CPU_FALLBACK.update(s["cpu_fallback"])
        sim.at(0.0, core_poll)
        for t, values in s["card_changes"]:
            sim.at(t, change(values))
        if s["die_at"] is not None:
            sim.at(s["die_at"], die)
        if s["restart_at"] is not None:
            sim.at(s["restart_at"], restart)
        runner = SimThread(sim, job_main, "job")
        runner.start()
        try:
            runner.join(s["horizon"])
            if outcome["state"] != "running at the horizon":
                sim.sleep(s["tail"])
            elif s["die_at"] is None:
                sim.note(horizon="still running: the scenario stops here")
            # Taken before ``close``: what is left unwinds there, and a dead worker does nothing more.
            result = snapshot(s, sim, job, peers, p, outcome)
        finally:
            sim.close()
    assert not sim.errors, sim.errors
    assert sim.failed is None, sim.failed
    return {"name": s["name"], "about": s["about"],
            "setup": {k: s[k] for k in SCENARIO_DEFAULTS if k != "tail"} | {"env": env}, **result}


def snapshot(s: dict[str, Any], sim: Sim, job: Any, peers: dict[str, Peer], p: Profile,
             outcome: dict[str, Any]) -> dict[str, Any]:
    g = job.gpu
    learned = p.public()
    return {
        "result": {
            "job": dict(outcome),
            "gpu": None if g is None else {k: v for k, v in g.summary().items() if k != "decisions"},
            "exclusive": job.exclusive.public() if job.exclusive is not None else None,
            "yielded": job.yielding.public() if job.yielding is not None else None,
            "peers": {name: pr.state for name, pr in peers.items()},
            "learned": {"headroom_mb": learned["headroom_mb"], "freed_mb": learned["freed_mb"],
                        "reload_s": learned["reload_s"]},
            "counts": dict(sorted(sim.counts.items())),
            "ended_at": r3(sim.now),
        },
        "events": [dict(e) for e in sim.events],
    }


def build_scenarios() -> list[dict[str, Any]]:
    return [run_scenario(spec) for spec in SCENARIO_LIST]


def scenarios_text(scenarios: list[dict[str, Any]]) -> str:
    about = ("Scenarios of the song worker's GPU mechanism over time, recorded by workers/tests/test_gpu_table.py "
             "(see docs/design/v5-gpu.md). Times are simulated seconds from the job's start. `setup` is what the "
             "simulation was given (speech workers: [MB, offload s, reload s]; people: [t, in_voice, listeners, "
             "live]; the speech workers and Core are models, not their code). `events` are, in order: a "
             "change of what is observed (stage, exclusive, window, running, yield_pauses, each speech worker's "
             "state), an HTTP call the song worker makes with its reply, a decision the job records "
             "(mode/code, deduplicated as the job does), and the script's own events (core, card, worker).")
    out = ['{"about": ' + json.dumps(about, ensure_ascii=False) + ",", '"scenarios": [']
    for i, sc in enumerate(scenarios):
        head = {k: v for k, v in sc.items() if k != "events"}
        out.append(dump(head)[:-1] + ',"events":[')
        out += [dump(e) + ("," if j < len(sc["events"]) - 1 else "") for j, e in enumerate(sc["events"])]
        out.append("]}" + ("," if i < len(scenarios) - 1 else ""))
    return "\n".join(out + ["]}", ""])


# ── the tests ────────────────────────────────────────────────────────────────


def compare(path: Path, text: str) -> None:
    if UPDATE:
        path.write_bytes(text.encode("utf-8"))
        return
    assert path.exists(), f"{path.name} is missing: run with UPDATE_GPU_TABLE=1"
    old = path.read_bytes().decode("utf-8").replace("\r\n", "\n")
    if old == text:
        return
    a, b = old.split("\n"), text.split("\n")
    i = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    raise AssertionError(
        f"{path.name} no longer matches the code at line {i + 1}:\n"
        f"  recorded: {a[i] if i < len(a) else '<end>'}\n  now:      {b[i] if i < len(b) else '<end>'}\n"
        "A change of behaviour must be agreed for hostd too (docs/design/v5-gpu.md); then UPDATE_GPU_TABLE=1.")


def test_the_decision_table_is_what_the_code_decides():
    header, cases = build_table()
    assert set(header["functions"]) == {c["fn"] for c in cases}
    assert all(c["out"] is not None for c in cases)
    compare(TABLE, table_text(header, cases))


def test_the_decision_table_is_the_same_every_time():
    assert table_text(*build_table()) == table_text(*build_table())


def test_the_scenarios_are_what_the_mechanism_does():
    scenarios = build_scenarios()
    assert len({s["name"] for s in scenarios}) == len(scenarios)
    compare(SCENARIOS, scenarios_text(scenarios))


def test_nothing_here_imported_torch():
    if not TORCH_BEFORE:
        assert "torch" not in sys.modules
