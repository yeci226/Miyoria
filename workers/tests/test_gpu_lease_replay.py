"""The song worker as hostd's lease client, cross-checked against hostd's real arbiter.

packages/hostd/test/arbiter/lease_exchanges.jsonl holds, for each recorded scenario, every
``gpu.*`` call the TypeScript scenario harness made to the real TypeScript ``Arbiter`` and what it
answered, in simulated seconds (that harness also reproduces each scenario as the Python worker
recorded it, workers/sing/gpu_scenarios.json). Here the song worker's real job loop
(server.py ``run_job`` / ``_gpu_stage`` with ``SING_GPU_ARBITER=hostd``, lease.py) runs each
scenario again on the recorder's simulated clock (test_gpu_table.py's ``Sim``) against a hostd that
answers from that file, and:

1. every call it makes must be the next recorded one, with the same params, at the same simulated
   time to the last bit (a run of equal calls answered at once is recorded as one entry: same params
   each time, first and last at the recorded times, count equal, the ones between within them);
   ``gpu.busy`` calls must fall in a recorded run of equal answers, with the same count per run. A
   call answered later in the recording (offloads, reloads) is answered at the recorded time.
2. every recorded call must have been made;
3. what the job shows, against the Python worker's own recording of the same scenario
   (gpu_scenarios.json), by the rule of the TypeScript scenario test: the observed states the worker
   has (``stage``, ``exclusive``, ``window``, ``running``, ``yield_pauses``) as end-of-instant
   timelines, and in order the worker's own events (trim, unload), Core's go, the script's events
   and the job's end; and the result (outcome, the job's GPU summary, the last window's record,
   yielding, steps per device, end time).

What it proves: the Python client asks hostd exactly what the TypeScript harness's worker asked,
when it asked it, and, given the arbiter's answers, ends where the self-arbitrating worker ended.
With the TypeScript test (the arbiter's answers reproduce the self-arbitrating worker's speech calls
and decisions), the two halves are proven against each other, not each against its own fake. What
it does not prove: the transport (hostd_client.py, the daemon's routing and its schemas), real
time, threads interleaving differently than on the simulated clock, and the speech services
themselves; hostd's answers are replayed, so a request it would answer differently from the
recording is caught only as a different request.
"""

from __future__ import annotations

import copy
import json
import threading
import types
from pathlib import Path
from typing import Any, Callable

import pytest

from test_gpu_table import (
    SCENARIO_DEFAULTS,
    SCENARIO_LIST,
    FakeEvent,
    Sim,
    SimBackend,
    SimCard,
    SimStop,
    SimThread,
    clean_env,
    load_server,
    make_pipeline,
    patched,
    profile,
    r3,
)

WORKERS = Path(__file__).resolve().parent.parent
EXCHANGES = WORKERS.parent / "packages" / "hostd" / "test" / "arbiter" / "lease_exchanges.jsonl"
RECORDED = WORKERS / "sing" / "gpu_scenarios.json"
WORKER_STATES = ("stage", "exclusive", "window", "running", "yield_pauses")
WORKER_EVENTS = ("backend", "core", "card", "worker", "job", "horizon")

import gpu  # noqa: E402  (test_gpu_table put workers/sing on the path)
import lease  # noqa: E402


def same(a: Any, b: Any) -> bool:
    """Equal as JSON: numbers by value (``54`` is ``54.0``), keys in any order."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


class ReplayHostd:
    """hostd answering from the recorded exchanges, checking each request against them."""

    def __init__(self, sim: Sim, recorded: dict[str, Any]) -> None:
        self.sim = sim
        self.calls = [dict(c, seen=0) for c in recorded["calls"]]
        self.busy = [[*run, 0] for run in recorded["busy"]]
        self.problems: list[str] = []

    def __call__(self, method: str, params: dict[str, Any], timeout: float) -> Any:
        if self.sim.dead:
            raise SimStop()  # the scenario is over: what unwinds asks nothing more
        now = self.sim.now
        if method == "gpu.busy":
            run = next((r for r in self.busy if r[0] <= now <= r[1]), None)
            if run is None:
                self.problems.append(f"gpu.busy at {now!r}: no recorded busy answer then")
                raise RuntimeError("replay: no answer")
            run[5] += 1
            return {"busy": run[3], "allowance_s": run[4]}
        if not self.calls:
            self.problems.append(f"{method} at {now!r} after every recorded call: {params}")
            raise RuntimeError("replay: no more recorded calls")
        c = self.calls[0]
        if c["method"] != method or not same(c["params"], params):
            self.problems.append(f"at {now!r} asked {method} {json.dumps(params, sort_keys=True)}\n"
                                 f"     recorded {c['method']} {json.dumps(c['params'], sort_keys=True)} at {c['t0']!r}")
        first, last = c["seen"] == 0, c["seen"] + 1 == c["n"]
        if (first and now != c["t0"]) or (last and now != c["t1"]) or not (c["t0"] <= now <= c["t1"]):
            self.problems.append(f"{method} asked at {now!r}; recorded {c['t0']!r}..{c['t1']!r} (call {c['seen'] + 1} "
                                 f"of {c['n']})")
        c["seen"] += 1
        if c["seen"] == c["n"]:
            self.calls.pop(0)
        if c["t_end"] > now:
            self.sim._block(c["t_end"])  # what hostd did meanwhile (offloads, reloads) took this long
        return copy.deepcopy(c["result"])

    def unanswered(self) -> list[str]:
        out = [f"never asked: {c['method']} at {c['t0']!r} ({c['n'] - c['seen']} of {c['n']})" for c in self.calls]
        out += [f"gpu.busy {r[0]!r}..{r[1]!r}: asked {r[5]} times, recorded {r[2]}" for r in self.busy if r[5] != r[2]]
        return out


def run_lease_scenario(spec: dict[str, Any], make_hostd: Callable[[Sim], Any]) -> tuple[dict[str, Any], Any]:
    """One scenario with the real job loop in hostd mode on the simulated clock, against ``make_hostd(sim)``."""
    s = {**SCENARIO_DEFAULTS, **spec}
    mod = load_server()
    sim = Sim()
    card = SimCard(s["total"], s["others"], {}, s["job_mb"])  # the worker never reads the card itself
    card.cuda, card.spill_under = s["cuda"], s["spill_under"]
    backend = SimBackend(sim, card)
    backend.rvc = s["rvc"]
    card.gate_set = lambda: backend.gate is not None  # type: ignore[method-assign]
    p = profile(s["total"])
    for stage, step in s["profile"].get("step_s", {}).items():
        p.note_step(stage, step)
    hostd = make_hostd(sim)
    job = mod.Job(id="job1", request=mod.JobRequest(query="sim", exclusive_ack=s["ack"]),
                  cancel=FakeEvent(sim), go=FakeEvent(sim))
    state = types.SimpleNamespace(backend=backend, jobs={job.id: job}, order=[job.id], lock=threading.Lock(),
                                  running=job.id, arbitration=None)
    pipeline = make_pipeline(s, mod, sim, card, backend)  # as test_gpu_table.run_scenario has it

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

    # Core: only its go reaches the worker in this mode (its context goes to hostd).
    core = {"go_due": False}
    worker = {"dead": False}

    def core_poll() -> None:
        if worker["dead"]:
            return
        gone = s["core_gone"] is not None and s["core_gone"] <= sim.now and (
            s["core_back"] is None or sim.now < s["core_back"])
        ex = job.exclusive
        if not gone and ex is not None and ex.state == "waiting" and not core["go_due"] and s["go_after"] is not None:
            core["go_due"] = True

            def go() -> None:
                core["go_due"] = False
                sim.note(core="POST /jobs/{id}/exclusive (go)")
                job.go.set()

            sim.at(sim.now + s["go_after"], go)
        if outcome["state"] == "running at the horizon":
            sim.at(sim.now + 1.5, core_poll)

    def die() -> None:
        sim.note(worker="the song worker's process dies")
        worker["dead"] = True
        sim.freeze()
        card.running, card.extra = None, 0
        backend.gate = None

    def restart() -> None:
        # The same script event as the recording; in this mode the new process asks nobody anything.
        sim.note(worker="the song worker starts again: _recover_speech")
        SimThread(sim, lambda: mod._arbitration().startup(), "recover").start()

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
    ]
    fake_threading = types.SimpleNamespace(
        Lock=threading.Lock, Event=lambda: FakeEvent(sim),
        Thread=lambda target, name=None, daemon=None, args=(): SimThread(sim, lambda: target(*args), name, daemon))
    fake_time = types.SimpleNamespace(monotonic=sim.clock, sleep=sim.sleep, time=sim.clock, perf_counter=sim.clock)
    env = {"SING_GPU_ARBITER": "hostd", **s["env"]}
    with clean_env(**env), patched((mod, "state", state), (mod, "_run_job", pipeline),
                                   (lease, "threading", fake_threading), (lease, "time", fake_time)):
        state.arbitration = lease.HostdArbitration(lambda: backend, p, stage_pauses=mod._stage_pauses,
                                                   stage_uses_gpu=mod._stage_uses_gpu, queued=mod._queued_behind,
                                                   call=hostd)
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
            g = job.gpu
            result = {
                "job": dict(outcome),
                "gpu": None if g is None else {k: v for k, v in g.summary().items() if k != "decisions"},
                "exclusive": job.exclusive.public() if job.exclusive is not None else None,
                "yielded": job.yielding.public() if job.yielding is not None else None,
                "steps": dict(sorted((k, v) for k, v in sim.counts.items() if " steps on " in k)),
                "ended_at": r3(sim.now),
            }
            events = [dict(e) for e in sim.events]
        finally:
            sim.close()
    assert not sim.errors, sim.errors
    return {"result": result, "events": events}, hostd


def timelines(events: list[dict[str, Any]]) -> dict[str, list[list[Any]]]:
    out: dict[str, list[list[Any]]] = {}
    for e in events:
        keys = [k for k in e if k != "t"]
        if len(keys) != 1 or keys[0] not in WORKER_STATES:
            continue
        line = out.setdefault(keys[0], [])
        if line and line[-1][0] == e["t"]:
            line[-1][1] = e[keys[0]]
        else:
            line.append([e["t"], e[keys[0]]])
    return {k: [x for i, x in enumerate(v) if i == 0 or x[1] != v[i - 1][1]] for k, v in out.items()}


def view(events: list[dict[str, Any]]) -> dict[str, Any]:
    others = [e for e in events if any(k in e for k in WORKER_EVENTS)]
    return {"states": timelines(events), "events": others}


def read_exchanges() -> dict[str, dict[str, Any]]:
    """lease_exchanges.jsonl: an ``about`` line, then per scenario its ``busy`` runs and its calls."""
    out: dict[str, dict[str, Any]] = {}
    for line in EXCHANGES.read_text("utf-8").splitlines():
        row = json.loads(line)
        if "busy" in row:
            out[row["scenario"]] = {"busy": row["busy"], "calls": []}
        elif "call" in row:
            out[row["scenario"]]["calls"].append(row["call"])
    return out


EXCHANGE_DATA = read_exchanges()
RECORDED_DATA = {s["name"]: s for s in json.loads(RECORDED.read_text("utf-8"))["scenarios"]}


@pytest.mark.parametrize("spec", SCENARIO_LIST, ids=[s["name"] for s in SCENARIO_LIST])
def test_the_lease_client_asks_what_the_harness_asked_and_ends_where_the_worker_ended(spec):
    name = spec["name"]
    got, hostd = run_lease_scenario(spec, lambda sim: ReplayHostd(sim, EXCHANGE_DATA[name]))
    assert hostd.problems == [], "\n".join(hostd.problems[:5])
    assert hostd.unanswered() == [], "\n".join(hostd.unanswered()[:5])
    rec = RECORDED_DATA[name]
    assert view(got["events"]) == view(rec["events"])
    r = rec["result"]
    want = {"job": r["job"], "gpu": r["gpu"], "exclusive": r["exclusive"], "yielded": r["yielded"],
            "steps": {k: v for k, v in sorted(r["counts"].items()) if " steps on " in k}, "ended_at": r["ended_at"]}
    assert same(got["result"], want), (got["result"], want)


def test_every_scenario_has_its_exchanges():
    assert set(EXCHANGE_DATA) == {s["name"] for s in SCENARIO_LIST} == set(RECORDED_DATA)
