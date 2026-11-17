"""The song worker with SING_GPU_ARBITER=hostd (workers/sing/lease.py), against a scripted hostd.

Each test runs the worker's real job loop on the simulated clock of test_gpu_table.py (through
test_gpu_lease_replay.run_lease_scenario) with a hostd whose answers the test scripts, and checks
what the worker asked, when, and what the job shows. No GPU, no network, no speech worker.
"""

from __future__ import annotations

import copy
from typing import Any, Callable

import pytest

from test_gpu_lease_replay import run_lease_scenario
from test_gpu_table import Sim, SimStop, clean_env, load_server, r3

import lease  # noqa: E402  (on the path through test_gpu_table)

CARD = "Sim GPU/12288"
CONVERT = {"stage": "convert", "steps": 6, "step_s": 1.0}


class Scripted:
    """A hostd that answers what ``answer`` says, recording every request with its time."""

    def __init__(self, sim: Sim, answer: Callable[["Scripted", str, dict[str, Any]], Any]) -> None:
        self.sim = sim
        self.answer = answer
        self.requests: list[tuple[float, str, dict[str, Any]]] = []
        self.state: dict[str, Any] = {}

    def __call__(self, method: str, params: dict[str, Any], timeout: float) -> Any:
        if self.sim.dead:
            raise SimStop()
        self.requests.append((r3(self.sim.now), method, copy.deepcopy(params)))
        return self.answer(self, method, params)

    def later(self, seconds: float) -> None:
        self.sim._block(self.sim.now + seconds)

    def methods(self, *skip: str) -> list[str]:
        return [m for _, m, _ in self.requests if m not in skip]

    def of(self, method: str) -> list[tuple[float, dict[str, Any]]]:
        return [(t, p) for t, m, p in self.requests if m == method]


SUMMARY = {"policy": "yield", "policy_source": "default", "decisions": [], "spills": 0, "steps": None,
           "waited_s": 0.0, "silenced_s": 0.0}


def ordinary(h: Scripted, method: str, params: dict[str, Any], acquire: Any = None, renew: Any = None) -> Any:
    """hostd answering plainly; ``acquire`` and ``renew`` override those two."""
    if method == "gpu.state":
        return {"policy": "yield", "policy_source": "default"}
    if method == "gpu.busy":
        return {"busy": False, "allowance_s": 900.0}
    if method == "gpu.acquire":
        if acquire is not None:
            return acquire(h, params)
        return granted("share")
    if method == "gpu.renew":
        if renew is not None:
            out = renew(h, params)
            if out is not None:
                return out
        end = params.get("end")
        learned = ({"card": CARD, "drop_mb": 0, "note_step": True, "note_rate": False}
                   if end and end["how"] == "finished" else None)
        return {"ok": True, "action": None, "clear_steps": False, "learned": learned, "evict": []}
    if method == "gpu.release":
        return {"reloaded": [], "errors": [], "reload_s": None, "closed": params["window"] == "close",
                "summary": SUMMARY if params["done"] else None}
    raise AssertionError(method)


def granted(mode: str, **kw: Any) -> dict[str, Any]:
    return {"type": "granted", "lease": "job1", "mode": mode, "code": "fits", "reason": "", "free_mb": 9000,
            "evicted": [], "errors": [], "released_mb": None, "offload_s": None, **kw}


def wait(code: str = "no_room", announce: bool = False) -> dict[str, Any]:
    return {"type": "wait", "code": code, "reason": f"({code})", "announce": announce,
            "evict": ["http://tts", "http://asr"] if announce else []}


def window_grant(h: Scripted) -> dict[str, Any]:
    h.later(4.0)  # hostd offloads both speech workers
    return granted("exclusive", code="no_room", evicted=["http://tts", "http://asr"], released_mb=6200,
                   offload_s=4.0)


def run(answer: Callable[[Scripted, str, dict[str, Any]], Any], **spec: Any) -> tuple[dict[str, Any], Scripted]:
    spec.setdefault("stages", [CONVERT])
    return run_lease_scenario(spec, lambda sim: Scripted(sim, answer))


def states(got: dict[str, Any], key: str) -> list[Any]:
    out = []
    for e in got["events"]:
        if key in e and (not out or out[-1] != e[key]):
            out.append(e[key])
    return out


# ── the ordinary paths ───────────────────────────────────────────────────────


def test_a_shared_stage_asks_before_it_and_before_every_step():
    got, h = run(ordinary)
    assert got["result"]["job"] == {"state": "done"}
    assert h.methods("gpu.busy") == ["gpu.state", "gpu.acquire", *["gpu.renew"] * 6, "gpu.renew", "gpu.release"]
    acquire = h.of("gpu.acquire")[0][1]
    assert acquire == {"job": "job1", "stage": "convert", "mode": "exclusive", "max_s": 60.0, "reason": "",
                       "on_gpu": True, "pauses": True, "need_mb": {}, "own_mb": 0, "est_work_s": pytest.approx(54.0),
                       "est_work_by_card": {}, "cpu_fallback": False, "queued": [], "ack": False, "resumed": False,
                       "announced": False}
    steps = [p["step"] for _, p in h.of("gpu.renew") if p["step"]]
    assert [s["recent_s"] for s in steps] == [[], [1.0], [1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0]]
    assert all(p["own_mb"] == 3500 for _, p in h.of("gpu.renew") if p["step"])  # its own memory, counted as room
    end = [p["end"] for _, p in h.of("gpu.renew") if p["end"]]
    assert end == [{"how": "finished", "step_s": 1.0, "normal_s": {}}]
    assert h.of("gpu.release") == [(6.0, {"lease": "job1", "window": "close", "done": True})]
    assert len(h.of("gpu.busy")) == 6
    assert got["result"]["exclusive"] == {"state": "shared", "offloaded": [], "errors": [], "free_vram_mb": 9000.0}
    assert got["result"]["gpu"] == {k: v for k, v in SUMMARY.items() if k != "decisions"}


def test_what_finished_teaches_is_learned_on_the_card_hostd_names():
    got, h = run(ordinary, profile={"step_s": {}})
    # note_step: true for the 1.0 s median: the next acquire would carry it for that card.
    renew_ends = [p["end"] for _, p in h.of("gpu.renew") if p["end"]]
    assert renew_ends[0]["normal_s"] == {}
    lead = {"stage": "lead", "steps": 3, "step_s": 1.0}
    got2, h2 = run(ordinary, stages=[lead, lead])
    second = [p for _, p in h2.of("gpu.renew") if p["step"]][-1]
    assert second["step"]["normal_s"] == {CARD: 1.0}


def test_a_wait_becomes_granted_and_the_worker_asks_every_second_meanwhile():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        return wait() if len(h.of("gpu.acquire")) <= 3 else granted("share")

    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=acquire))
    assert [t for t, _ in h.of("gpu.acquire")] == [0.0, 1.0, 2.0, 3.0]
    assert states(got, "stage")[:3] == ["queued", "gpu_wait", "convert"]
    assert got["result"]["job"] == {"state": "done"}


def test_an_announced_window_without_ack_goes_ahead_at_once():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        return window_grant(h) if p["announced"] else wait(announce=True)

    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=acquire))
    acq = h.of("gpu.acquire")
    assert [(t, p["announced"]) for t, p in acq] == [(0.0, False), (0.0, True)]
    assert states(got, "exclusive") == [None, "offloading", "active", "reloading", "done"]
    assert states(got, "window") == [False, True, False]
    # After the conversion speech comes back and the window ends with it; the job's end then
    # only ends the lease.
    assert [(p["window"], p["done"]) for _, p in h.of("gpu.release")] == [("close", False), ("close", True)]
    ex = got["result"]["exclusive"]
    assert ex["offloaded"] == ["http://tts", "http://asr"] and ex["released_mb"] == 6200.0 and ex["offload_s"] == 4.0


def test_the_backing_pass_is_placed_in_the_open_window_and_speech_comes_back_once():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        if p["announced"]:
            return window_grant(h)
        if len(h.of("gpu.acquire")) == 1:
            return wait(announce=True)
        return granted("exclusive", code="window")  # the window is still open: hostd says so

    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=acquire),
                 stages=[CONVERT, {"stage": "convert", "backing": True, "steps": 4, "step_s": 1.0}])
    acq = h.of("gpu.acquire")
    assert [(t, p["announced"]) for t, p in acq] == [(0.0, False), (0.0, True), (10.0, False)]
    assert [(t, p["window"], p["done"]) for t, p in h.of("gpu.release")] == [(14.0, "close", False),
                                                                           (14.0, "close", True)]
    assert states(got, "window") == [False, True, False]
    assert got["result"]["steps"] == {"convert steps on gpu": 6, "backing steps on gpu": 4}


def test_an_announced_window_with_ack_waits_for_cores_go():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        return window_grant(h) if p["announced"] else wait(announce=True)

    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=acquire), ack=True, go_after=4.0)
    acq = h.of("gpu.acquire")
    assert acq[0][1]["ack"] is True
    assert [(t, p["announced"]) for t, p in acq] == [(0.0, False), (5.5, True)]  # Core saw it at 1.5, said go 4 s later
    assert states(got, "exclusive")[:3] == [None, "waiting", "offloading"]
    assert got["result"]["exclusive"]["exclusive_wait_s"] == 5.5


def test_cpu_runs_on_the_cpu_and_still_checks_in_before_every_step():
    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=lambda h, p: {"type": "cpu", "code": "no_room_cpu",
                                                                          "reason": ""}),
                 stages=[{"stage": "separate", "steps": 3, "step_s": 0.5, "cpu_step_s": 2.0}])
    assert got["result"]["steps"] == {"separate steps on cpu": 3}
    assert len([p for _, p in h.of("gpu.renew") if p["step"]]) == 3


def test_refused_fails_the_job_with_hostds_reason():
    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=lambda h, p: {"type": "refused", "code": "no_room",
                                                                          "reason": "等了 10 分鐘還是放不下"}))
    assert got["result"]["job"] == {"state": "failed", "error": "等了 10 分鐘還是放不下"}
    assert h.of("gpu.release")[-1][1] == {"lease": "job1", "window": "close", "done": True}


# ── what renew answers ───────────────────────────────────────────────────────


def action(kind: str, code: str, steps: int | None = None) -> dict[str, Any]:
    return {"ok": True, "action": {"type": kind, "code": code, "reason": code, "steps": steps}, "clear_steps": True,
            "learned": None, "evict": ["http://tts", "http://asr"] if kind == "offload" else []}


def on_step(n: int, answer: dict[str, Any]) -> Callable[[Scripted, dict[str, Any]], Any]:
    def renew(h: Scripted, p: dict[str, Any]) -> Any:
        if p["step"] is not None and len([1 for _, q in h.of("gpu.renew") if q["step"]]) == n:
            return answer
        return None

    return renew


def test_trim_and_reduce():
    def renew(h: Scripted, p: dict[str, Any]) -> Any:
        steps = len([1 for _, q in h.of("gpu.renew") if q["step"]])
        if p["step"] is not None and steps == 3:
            return action("trim", "spill_free")
        if p["step"] is not None and steps == 4:
            return action("reduce", "spill_reduce", 20)
        return None

    got, h = run(lambda h, m, p: ordinary(h, m, p, renew=renew))
    assert {"backend": "trim: frees its own cache", "t": 2.0} in got["events"]
    later = [p["step"]["recent_s"] for _, p in h.of("gpu.renew") if p["step"]]
    assert later[2] == [1.0, 1.0]  # the third check is answered with trim: the step window starts again
    assert later[3] == [1.0]  # the fourth with reduce: and again
    assert later[4] == [pytest.approx(20 / 30)]  # 20 diffusion steps instead of 30 from there on
    assert got["result"]["gpu"]["steps"] is None  # hostd's summary (scripted) is what stays


def test_suspend_lets_go_and_places_the_stage_again():
    got, h = run(lambda h, m, p: ordinary(h, m, p, renew=on_step(3, action("suspend", "spill_wait"))))
    assert {"backend": "unload: drops its models", "t": 2.0} in got["events"]
    assert [p["how"] for _, q in h.of("gpu.renew") if (p := q["end"])] == ["suspended", "finished"]
    acq = h.of("gpu.acquire")
    assert len(acq) == 2 and acq[1][1]["resumed"] is True
    assert got["result"]["steps"] == {"convert steps on gpu": 6}  # no step ran twice


def test_offload_mid_stage_opens_a_window_between_two_steps():
    got, h = run(lambda h, m, p: ordinary(h, m, p, acquire=lambda h, p: window_grant(h) if p["announced"]
                                         else granted("share"), renew=on_step(3, action("offload", "spill_offload"))))
    acq = h.of("gpu.acquire")
    assert [(t, p["announced"], p["resumed"]) for t, p in acq] == [(0.0, False, False), (2.0, True, False)]
    assert states(got, "exclusive") == [None, "shared", "offloading", "active", "reloading", "done"]
    assert got["result"]["steps"] == {"convert steps on gpu": 6}


def test_the_silence_limit_ends_a_window_through_renew_then_release():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        return window_grant(h) if p["announced"] else wait(announce=True)

    def release(h: Scripted, p: dict[str, Any]) -> Any:
        h.later(28.0)  # hostd reloads both
        return {"reloaded": ["http://tts", "http://asr"], "errors": [], "reload_s": 28.0, "closed": True,
                "summary": SUMMARY if p["done"] else None}

    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        if m == "gpu.release" and p["window"] == "close" and not p["done"]:
            return release(h, p)
        return ordinary(h, m, p, acquire=acquire, renew=on_step(3, action("suspend", "silence_limit")))

    got, h = run(answer)
    rel = h.of("gpu.release")
    assert [(t, p["window"], p["done"]) for t, p in rel][0] == (6.0, "close", False)  # at the 4th step's check
    assert states(got, "window")[:3] == [False, True, False]
    assert [t for t, p in h.of("gpu.acquire")][2] == 34.0  # placed again once speech is back


def test_the_keep_alive_renews_while_the_song_is_mixed():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        return window_grant(h) if p["announced"] else wait(announce=True)

    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        if m == "gpu.release" and not p["done"]:
            h.later(50.0)
            return {"reloaded": [], "errors": [], "reload_s": 50.0, "closed": True, "summary": None, "window": None}
        return ordinary(h, m, p, acquire=acquire)

    got, h = run(answer)
    keep_at = h.of("gpu.release")[0][0]
    bare = [t for t, p in h.of("gpu.renew") if p["step"] is None and p["end"] is None]
    assert bare == [keep_at + 20.0, keep_at + 40.0]


# ── when hostd cannot answer ─────────────────────────────────────────────────


class Down(Exception):
    pass


def test_hostd_unreachable_at_placement_waits_with_backoff_then_fails_naming_hostd():
    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        if m == "gpu.acquire":
            raise Down("connection refused")
        return ordinary(h, m, p)

    got, h = run(answer)
    times = [t for t, _ in h.of("gpu.acquire")]
    assert times[:6] == [0.0, 0.5, 1.5, 3.5, 7.5, 12.5]
    assert times[-1] >= 60.0
    assert got["result"]["job"]["state"] == "failed"
    assert "hostd did not answer gpu.acquire for 60 s" in got["result"]["job"]["error"]
    assert got["result"]["steps"] == {}  # nothing ran without a lease


def test_hostd_back_within_the_limit_lets_the_job_go_on():
    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        if m == "gpu.acquire" and h.sim.now < 3.0:
            raise Down("connection refused")
        return ordinary(h, m, p)

    got, _ = run(answer)
    assert got["result"]["job"] == {"state": "done"}


def test_a_failed_renew_in_a_window_counts_as_released():
    def acquire(h: Scripted, p: dict[str, Any]) -> Any:
        return window_grant(h) if p["announced"] else wait(announce=True)

    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        steps = len([1 for _, q in h.of("gpu.renew") if q["step"]])
        if m == "gpu.renew" and p["step"] is not None and steps == 3:
            raise Down("hostd restarting")
        if m == "gpu.release" and not p["done"] and p["window"] == "close" and steps == 3:
            raise Down("hostd restarting")
        return ordinary(h, m, p, acquire=acquire)

    got, h = run(answer)
    # The stage let go at once (no step without a lease), the window ended on the worker's side,
    # and the stage was placed again.
    assert {"backend": "unload: drops its models", "t": 6.0} in got["events"]
    assert (6.0, {"lease": "job1", "window": "close", "done": False}) in h.of("gpu.release")  # tried, failed
    assert states(got, "window")[:3] == [False, True, False]  # given back all the same
    assert [p["announced"] for _, p in h.of("gpu.acquire")] == [False, True, False, True]
    assert got["result"]["job"] == {"state": "done"}


def test_hostd_forgetting_the_lease_is_the_same_as_not_answering():
    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        if m == "gpu.renew" and p["step"] is not None and len(h.of("gpu.renew")) == 3:
            return {"ok": False, "action": None, "clear_steps": False, "learned": None, "evict": []}
        return ordinary(h, m, p)

    got, h = run(answer)
    assert len(h.of("gpu.acquire")) == 2
    assert got["result"]["job"] == {"state": "done"}


def test_busy_not_answering_counts_as_idle():
    def answer(h: Scripted, m: str, p: dict[str, Any]) -> Any:
        if m == "gpu.busy":
            raise Down("timeout")
        return ordinary(h, m, p)

    got, _ = run(answer)
    assert got["result"]["job"] == {"state": "done"} and got["result"]["yielded"]["pauses"] == 0


# ── the switch, Core's context and /health ───────────────────────────────────


def test_the_switch():
    assert lease.arbiter_from_env({}) == "self"
    assert lease.arbiter_from_env({"SING_GPU_ARBITER": " HostD "}) == "hostd"
    with pytest.raises(SystemExit, match="neither self nor hostd"):
        lease.arbiter_from_env({"SING_GPU_ARBITER": "auto"})


def test_hostd_mode_without_a_hostd_refuses_to_start(monkeypatch):
    mod = load_server()
    monkeypatch.setattr(mod, "hostd_available", lambda: False)
    with clean_env(SING_GPU_ARBITER="hostd"), pytest.raises(SystemExit, match="no hostd is configured"):
        mod._choose_arbitration(object())
    with clean_env():
        assert mod._choose_arbitration(object()) is mod._SELF


def test_hostd_mode_ignores_cores_context_and_shows_where_decisions_come_from():
    calls: list[str] = []

    def call(method: str, params: dict[str, Any], timeout: float) -> Any:
        calls.append(method)
        return {"policy": "auto", "policy_source": "host", "cuda": True, "total_mb": 12288, "free_mb": 4000,
                "headroom_mb": 1475, "audience": {"in_voice": True, "listeners": 2, "live": False, "age_s": 1.0,
                                                  "fresh": True},
                "learned": {"device": CARD, "headroom_mb": None, "freed_mb": 6200, "reload_s": 28.0, "spills": 0}}

    backend = type("B", (), {"uses_cuda": lambda self: True, "own_vram_mb": lambda self: 0})()
    from gpu import Profile
    from test_gpu_table import NOWHERE

    arb = lease.HostdArbitration(lambda: backend, Profile(NOWHERE), stage_pauses=lambda s: True,
                                 stage_uses_gpu=lambda s: True, queued=lambda j: [], call=call)
    assert arb.context(object())["ok"] is True and "ignored" in arb.context(object())
    gpu = arb.health(None)
    assert gpu["arbiter"] == "hostd" and gpu["policy"] == "auto" and gpu["cuda"] is True and gpu["job"] is None
    assert gpu["learned"]["freed_mb"] == 6200 and "stages" in gpu["learned"]
    arb.health(None)
    assert calls == ["gpu.state"]  # read at most every 2 s


def test_self_mode_health_has_the_arbiter(sing):  # noqa: F811
    assert sing.get("/health").json()["gpu"]["arbiter"] == "self"


from test_sing import sing  # noqa: E402,F401  (fixture)
