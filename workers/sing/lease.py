"""The song worker as a lease client of hostd's GPU arbiter (``SING_GPU_ARBITER=hostd``).

hostd decides (packages/hostd/src/arbiter, docs/design/v5-gpu.md §12), from the same rules gpu.py
has, checked against the same recorded table. The worker only asks, at the places of the job loop
where it used to decide (server.py ``_gpu_stage``):

    gpu.state    once when the job's first GPU stage starts (the policy, for what the job shows)
    gpu.acquire  before every GPU stage, again every SING_GPU_CHECK_S while told to wait; after a
                 ``wait`` with ``announce`` it shows ``exclusive: waiting`` (with ``exclusive_ack``),
                 waits for Core's go or SING_EXCLUSIVE_WAIT_S, shows ``offloading`` and asks again
                 with ``announced``; hostd then takes speech offline and answers ``granted``
    gpu.busy     before every step, and while giving way to her
    gpu.renew    before every step (``step``: its last step times; hostd answers what to do), once
                 when a stage run ends (``end``), and on its own every 20 s without other calls
    gpu.release  ``close`` when a window ends: inside a stage, after the conversion's last pass
                 (speech comes back while the song is mixed; the window ends when it is back), and
                 at the job's end (``done``)

In this mode the worker makes no call to the speech workers, does not run ``_recover_speech`` (hostd
recovers at its own start) and ignores ``POST /gpu/context`` (Core tells hostd).

When hostd cannot be asked:
  - not configured at start (``hostd_client.available()`` false): the worker does not start
    (server.py ``_choose_arbitration``), so a wrong switch never quietly becomes self-arbitration.
  - unreachable or erroring while a stage is placed: the stage holds nothing and asks again after
    0.5, 1, 2, 4, then every 5 s, for up to SING_OFFLOAD_LEASE_S (60 s), then the job fails with a
    reason naming hostd. 60 s is the lease hostd keeps for a holder that stops talking: past it,
    hostd has forgotten the job and brought speech back, so nothing the job was waiting for is left.
    The steps stay below 5 s, the timeout the old lease renewal used, so a restarting hostd is
    noticed within seconds.
  - ``gpu.renew`` fails, or hostd no longer knows the lease, while a stage runs: the stage lets go
    of the card (suspend) and is placed again, which waits as above. With a window open the window
    counts as given back. Giving the card back is the safe direction: the worst it costs is the
    song's time, while running on would keep her voice offline with nobody keeping the silence
    limit. Her voice does not depend on this worker: hostd renews the speech workers' own lease
    only while it is alive, and without it they reload themselves when that lease runs out.
  - ``refused``: the job fails with hostd's reason.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Callable, Mapping

from engine import Cancelled, JobError, Suspended, env_float
from gpu import CPU_FALLBACK, CPU_STAGES, RATE_PRIORS, Profile, StepMeter

log = logging.getLogger("miyoria.sing.lease")

ARBITERS = ("self", "hostd")
KEEPALIVE_S = 20.0  # hostd's lease is 60 s: a third of it, as the speech workers' lease was renewed
BACKOFF_S = (0.5, 1.0, 2.0, 4.0, 5.0)  # the last one repeats
TIMEOUT_S = {"gpu.state": 2.0, "gpu.busy": 2.0, "gpu.renew": 10.0, "gpu.acquire": 10.0,
             "announced": 150.0, "gpu.release": 620.0}  # an announced acquire waits for two offloads
# (60 s each at most), a release for two reloads (300 s each at most)

Call = Callable[[str, dict[str, Any], float], Any]


def arbiter_from_env(env: Mapping[str, str] = os.environ) -> str:
    """``SING_GPU_ARBITER``: ``self`` (also when unset) or ``hostd``; anything else stops the start."""
    raw = env.get("SING_GPU_ARBITER", "").strip().lower()
    if raw in ("", "self"):
        return "self"
    if raw == "hostd":
        return "hostd"
    raise SystemExit(f"SING_GPU_ARBITER={raw!r} is neither self nor hostd")


def hostd_available() -> bool:
    try:
        import hostd_client  # workers/hostd_client.py
    except ImportError:
        return False
    return bool(hostd_client.available())


def hostd_call(method: str, params: dict[str, Any], timeout: float) -> Any:
    import hostd_client

    return hostd_client.call(method, params, timeout)


def _share_only(job: Any) -> bool:
    """A job that never takes speech offline and is never urgent: a karaoke job."""
    return getattr(getattr(job, "request", None), "purpose", "cover") == "karaoke"


def _rate_prior(stage: str) -> float:
    return RATE_PRIORS.get(stage, 0.3)


class LeaseWindow:
    """``job.exclusive`` in this mode: the same states and record as exclusive.py's ``Exclusive``
    (waiting · offloading · active · reloading · done, or shared), carried out by hostd."""

    def __init__(self) -> None:
        self.state: str | None = None
        self.offloaded: list[str] = []
        self.errors: list[str] = []
        self.timings: dict[str, float] = {}
        self._reload: threading.Thread | None = None

    def share(self, free_mb: int | float | None) -> None:
        self.state = "shared"
        self.timings["free_vram_mb"] = float(free_mb or 0)

    def end(self) -> None:
        """The arbitration gives speech back (``HostdArbitration.give_back``); nothing to do here."""

    def join(self, timeout: float | None = None) -> None:
        t = self._reload
        if t is not None:
            t.join(timeout)

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "offloaded": list(self.offloaded), "errors": list(self.errors), **self.timings}


class LeaseYield:
    """``job.yielding`` in this mode: yielding.py's ``wait``, asking hostd whether speech is busy."""

    def __init__(self, busy: Callable[[], bool]) -> None:
        self.busy = busy
        self.max_s = 0.0
        self.yielded_s = 0.0
        self.pauses = 0
        self._stopped = False

    def stop(self) -> None:
        self._stopped = True

    def wait(self, cancelled: Callable[[], bool] = lambda: False) -> None:
        if not self.busy() or self.yielded_s >= self.max_s:
            return
        t0 = time.monotonic()
        self.pauses += 1
        while self.busy() and not self._stopped and not cancelled():
            if self.yielded_s + time.monotonic() - t0 >= self.max_s:
                log.info("yielded %.0f s for this song; going on regardless", self.max_s)
                break
            time.sleep(0.02)
        self.yielded_s += time.monotonic() - t0

    def public(self) -> dict[str, Any]:
        return {"yielded_s": round(self.yielded_s, 2), "pauses": self.pauses}


class LeaseJob:
    """``job.gpu`` in this mode: what the job shows of its GPU state (``public``, ``summary``, the
    same shapes as gpu.py's ``GpuJob``), kept from hostd's answers. hostd's own summary replaces
    ``summary()`` once the job's lease ends."""

    def __init__(self, job_id: str, audio_s: float | None) -> None:
        self.job_id = job_id
        self.audio_s = audio_s
        self.converted = 0.0  # share of the conversion done (server.py sets it)
        self.policy = "unknown"
        self.policy_source = "hostd"
        self.stage = ""
        self.device = "gpu"
        self.resumed = False
        self.mode: str | None = None
        self.code: str | None = None
        self.reason: str | None = None
        self.free_mb: float | None = None
        self.need_mb: float | None = None
        self.meter = StepMeter()
        self.baseline_s: float | None = None
        self.spilling = False
        self.spills = 0
        self.reduced_to: int | None = None
        self.window = False
        self.window_at = 0.0
        self.silenced_s = 0.0
        self.waited_total_s = 0.0
        self.wait_from: float | None = None
        self.peak_allocated_mb: int | None = None
        self.decisions: list[dict[str, Any]] = []
        self.windows: list[dict[str, Any]] = []  # hostd's record of each window it closed
        self.hostd_summary: dict[str, Any] | None = None
        self.last_call = time.monotonic()
        self.stop = threading.Event()

    def note(self, stage: str, mode: str, code: str, reason: str) -> None:
        self.stage = stage
        if (mode, code) != (self.mode, self.code):
            self.decisions = (self.decisions + [{"stage": stage, "mode": mode, "code": code, "reason": reason,
                                                 "t": round(time.time(), 1)}])[-40:]
        self.mode, self.code, self.reason = mode, code, reason

    def waiting_s(self) -> float:
        return 0.0 if self.wait_from is None else time.monotonic() - self.wait_from

    def wait_over(self) -> None:
        if self.wait_from is not None:
            self.waited_total_s += time.monotonic() - self.wait_from
            self.wait_from = None

    def window_opened(self) -> None:
        self.window = True
        self.window_at = time.monotonic()

    def window_closed(self, record: dict[str, Any] | None = None) -> None:
        if self.window:
            self.window = False
            self.silenced_s += time.monotonic() - self.window_at
        if record is not None:
            self.windows.append(record)

    def public(self) -> dict[str, Any]:
        return {
            "policy": self.policy,
            "stage": self.stage,
            "mode": self.mode,
            "code": self.code,
            "reason": self.reason,
            "free_mb": self.free_mb,
            "total_mb": None,
            "need_mb": self.need_mb,
            "headroom_mb": None,
            "speech_loaded": None,
            "people": None,
            "urgent": None,
            "step_s": self.meter.last(),
            "baseline_s": self.baseline_s,
            "spilling": self.spilling,
            "spills": self.spills,
            "steps": self.reduced_to,
            "waited_s": round(self.waited_total_s + self.waiting_s(), 1),
            "silenced_s": round(self.silenced_s, 1),
            "silence_est_s": None,
            "silence_max_s": None,
        }

    def summary(self) -> dict[str, Any]:
        if self.hostd_summary is not None:
            return self.hostd_summary
        return {"policy": self.policy, "policy_source": self.policy_source, "decisions": self.decisions,
                "spills": self.spills, "steps": self.reduced_to, "waited_s": round(self.waited_total_s, 1),
                "silenced_s": round(self.silenced_s, 1), "windows": list(self.windows)}


class HostdArbitration:
    """The job loop's GPU calls (server.py ``SelfArbitration`` has the same methods), answered by hostd."""

    name = "hostd"

    def __init__(self, backend: Callable[[], Any], profile: Profile, *, stage_pauses: Callable[[str], bool],
                 stage_uses_gpu: Callable[[str], bool], queued: Callable[[Any], list[str]],
                 call: Call | None = None) -> None:
        self._backend = backend
        self.profile = profile
        self._stage_pauses = stage_pauses
        self._stage_uses_gpu = stage_uses_gpu
        self._queued = queued
        self._call = call or hostd_call
        self._ignored_context = False
        self._health_at = float("-inf")
        self._health: dict[str, Any] | None = None
        self.check_s = env_float("SING_GPU_CHECK_S", 1.0)
        self.lease_s = env_float("SING_OFFLOAD_LEASE_S", 60.0)
        self.give_up_s = self.lease_s

    # ── talking to hostd ─────────────────────────────────────────────────

    def _rpc(self, g: LeaseJob | None, method: str, params: dict[str, Any], timeout: float) -> Any:
        if g is not None:
            g.last_call = time.monotonic()
        return self._call(method, params, timeout)

    def _ask(self, job: Any, method: str, params: dict[str, Any], timeout: float) -> Any:
        """A placement question: asked again with a short backoff while hostd cannot answer, holding
        nothing, for up to ``give_up_s``; then the job fails naming hostd."""
        first: float | None = None
        tries = 0
        while True:
            try:
                return self._rpc(job.gpu, method, params, timeout)
            except Exception as e:  # noqa: BLE001 - whatever went wrong, hostd did not answer
                now = time.monotonic()
                first = now if first is None else first
                if now - first >= self.give_up_s:
                    raise JobError(f"hostd did not answer {method} for {self.give_up_s:.0f} s: {e}") from e
                delay = BACKOFF_S[min(tries, len(BACKOFF_S) - 1)]
                tries += 1
                log.warning("job %s: hostd did not answer %s (%s); asking again in %.1f s", job.id, method, e, delay)
                job.stage = "gpu_wait"
                if job.cancel.wait(delay):
                    raise Cancelled() from e

    def _behind(self, job: Any) -> list[str]:
        """The jobs queued behind ``job``, which make it urgent; none for a karaoke job (never urgent)."""
        return [] if _share_only(job) else self._queued(job)

    def _own(self) -> int:
        try:
            return int(self._backend().own_vram_mb())
        except Exception:  # noqa: BLE001 - a reading that fails is just none
            return 0

    def _renew(self, job: Any, step: dict[str, Any] | None = None, end: dict[str, Any] | None = None) -> Any:
        """``None`` when hostd did not answer or no longer knows the lease."""
        params = {"lease": job.id, "own_mb": self._own(), "queued": self._behind(job), "step": step, "end": end}
        try:
            r = self._rpc(job.gpu, "gpu.renew", params, TIMEOUT_S["gpu.renew"])
        except Exception as e:  # noqa: BLE001
            log.warning("job %s: gpu.renew failed: %s", job.id, e)
            return None
        if not isinstance(r, dict) or not r.get("ok"):
            log.warning("job %s: hostd no longer knows its lease", job.id)
            return None
        return r

    def _release(self, job: Any, window: str, done: bool) -> Any:
        try:
            return self._rpc(job.gpu, "gpu.release", {"lease": job.id, "window": window, "done": done},
                             TIMEOUT_S["gpu.release"])
        except Exception as e:  # noqa: BLE001
            log.warning("job %s: gpu.release (%s) failed: %s", job.id, window, e)
            return None

    def _busy(self, job: Any) -> Any:
        try:
            return self._rpc(job.gpu, "gpu.busy", {"lease": job.id}, TIMEOUT_S["gpu.busy"])
        except Exception as e:  # noqa: BLE001 - not knowing counts as idle, as with the speech workers
            log.debug("job %s: gpu.busy failed: %s", job.id, e)
            return None

    # ── what the worker knows and hostd does not ─────────────────────────

    def _work(self, g: LeaseJob, stage: str, rate: Callable[[str], float]) -> float | None:
        if not g.audio_s:
            return None
        work = g.audio_s * (1 - g.converted) * rate("convert")
        if stage in CPU_STAGES:
            work += g.audio_s * rate(stage)
        return work

    def _normal(self, stage: str) -> dict[str, Any]:
        return self.profile.by_card(lambda: self.profile.step(stage))

    def _need(self, stage: str) -> dict[str, Any]:
        def learned() -> int | None:
            mb, measured = self.profile.need(stage, 0)
            return mb if measured else None

        return self.profile.by_card(learned)

    def _params(self, job: Any, stage: str, resumed: bool, announced: bool) -> dict[str, Any]:
        g: LeaseJob = job.gpu
        prior = self._work(g, stage, _rate_prior)
        by_card = {} if prior is None else self.profile.by_card(lambda: self._work(g, stage, self.profile.rate))
        return {
            "job": job.id,
            "stage": stage,
            # A karaoke job never takes speech offline (hostd answers ``wait`` where it would).
            "mode": "share" if _share_only(job) else "exclusive",
            "max_s": self.lease_s,
            "reason": "",
            "on_gpu": self._stage_uses_gpu(stage),
            "pauses": self._stage_pauses(stage),
            "need_mb": self._need(stage),
            "own_mb": self._own(),
            "est_work_s": prior,
            "est_work_by_card": by_card,
            "cpu_fallback": stage in CPU_FALLBACK,
            "queued": self._behind(job),
            "ack": bool(job.request.exclusive_ack),
            "resumed": resumed,
            "announced": announced,
        }

    # ── the job loop ─────────────────────────────────────────────────────

    def start(self, job: Any, audio_s: float | None) -> None:
        g = LeaseJob(job.id, audio_s)
        job.gpu = g
        job.yielding = LeaseYield(lambda: bool((self._busy(job) or {}).get("busy")))
        try:
            st = self._rpc(g, "gpu.state", {}, TIMEOUT_S["gpu.state"])
            g.policy = str(st.get("policy") or g.policy)
            g.policy_source = str(st.get("policy_source") or g.policy_source)
        except Exception as e:  # noqa: BLE001 - only for what the job shows
            log.info("job %s: could not read hostd's GPU state: %s", job.id, e)
        threading.Thread(target=self._keepalive, args=(job,), name="sing-lease-keepalive", daemon=True).start()

    def _keepalive(self, job: Any) -> None:
        """A bare ``gpu.renew`` when 20 s passed without any call (the ack wait, a reload, the mix)."""
        g: LeaseJob = job.gpu
        while True:
            due = g.last_call + KEEPALIVE_S
            now = time.monotonic()
            if now >= due:
                self._renew(job)
                continue
            if g.stop.wait(due - now):
                return

    def place(self, job: Any, stage: str, resumed: bool) -> str:
        g: LeaseJob = job.gpu
        g.need_mb = self.profile.need(stage, 0)[0] or None
        try:
            while True:
                if job.cancel.is_set():
                    raise Cancelled()
                r = self._ask(job, "gpu.acquire", self._params(job, stage, resumed, False), TIMEOUT_S["gpu.acquire"])
                kind = r.get("type")
                if kind == "wait":
                    if r.get("announce"):
                        g.note(stage, "offload", r["code"], r["reason"])
                        job.stage = stage
                        if self._open_window(job, stage, resumed) is None:
                            return "gpu"
                        continue  # hostd did not open it after all: ask again
                    g.note(stage, "wait", r["code"], r["reason"])
                    if g.wait_from is None:
                        g.wait_from = time.monotonic()
                    job.stage = "gpu_wait"
                    job.cancel.wait(self.check_s)
                    continue
                job.stage = stage
                if kind == "refused":
                    g.note(stage, "give_up", r["code"], r["reason"])
                    raise JobError(r["reason"])
                if kind == "granted":
                    g.note(stage, r["mode"], r["code"], r["reason"])
                    g.free_mb = r.get("free_mb")
                    if r["mode"] == "share" and (job.exclusive is None or job.exclusive.state != "shared"):
                        job.exclusive = LeaseWindow()
                        job.exclusive.share(r.get("free_mb"))
                    return "gpu"
                g.note(stage, "cpu", r["code"], r["reason"])
                return "cpu"
        finally:
            job.stage = stage
            g.wait_over()

    def _open_window(self, job: Any, stage: str, resumed: bool) -> Any:
        """Core's go, then hostd takes speech offline. ``None`` once the window is open, else
        hostd's answer when it did not open one."""
        g: LeaseJob = job.gpu
        job.go.clear()  # every window waits for its own go
        ex = LeaseWindow()
        job.exclusive = ex
        saved = job.stage
        job.stage = "exclusive"
        try:
            if job.request.exclusive_ack:
                ex.state = "waiting"
                t0 = time.monotonic()
                wait_s = env_float("SING_EXCLUSIVE_WAIT_S", 30.0)
                while not job.go.is_set() and time.monotonic() - t0 < wait_s:
                    if job.cancel.is_set():
                        raise Cancelled()
                    job.go.wait(0.1)
                ex.timings["exclusive_wait_s"] = round(time.monotonic() - t0, 2)
            if job.cancel.is_set():
                raise Cancelled()
            ex.state = "offloading"
            r = self._ask(job, "gpu.acquire", self._params(job, stage, resumed, True), TIMEOUT_S["announced"])
            if r.get("type") != "granted":
                ex.errors.append(f"hostd did not open the window: {r.get('code')}")
                ex.state = "done"
                return r
            ex.offloaded = list(r.get("evicted") or [])
            ex.errors.extend(r.get("errors") or [])
            if r.get("released_mb") is not None:
                ex.timings["released_mb"] = float(r["released_mb"])
            if r.get("offload_s") is not None:
                ex.timings["offload_s"] = float(r["offload_s"])
            ex.state = "active"
        finally:
            job.stage = saved
        g.window_opened()
        return None

    def arm(self, job: Any, stage: str, work: Any) -> None:
        g: LeaseJob = job.gpu
        y: LeaseYield = job.yielding
        b = self._backend()

        def gate() -> None:
            if job.cancel.is_set():
                raise Cancelled()
            if g.device == "gpu":
                sync = getattr(b, "sync", None)
                if sync is not None:
                    sync()
            g.meter.step(time.monotonic())
            busy = self._busy(job)
            if busy is not None and busy.get("busy"):
                y.max_s = float(busy.get("allowance_s") or 0.0)
                y.wait(job.cancel.is_set)
            r = self._renew(job, step={"recent_s": list(g.meter.recent), "normal_s": self._normal(stage)})
            if r is None:
                raise Suspended("hostd_unreachable")
            if r.get("clear_steps"):
                g.meter.restart()
            if r.get("action"):
                self._act(job, stage, r["action"], work)
            g.meter.resume(time.monotonic())

        b.gate = gate

    def _act(self, job: Any, stage: str, a: dict[str, Any], work: Any) -> None:
        g: LeaseJob = job.gpu
        kind, code = a.get("type"), str(a.get("code"))
        mode = {"suspend": "wait", "offload": "offload"}.get(str(kind), g.mode or "share")
        g.note(stage, mode, code, str(a.get("reason")))
        g.spilling = code.startswith("spill_")
        if code == "spill_free":
            g.spills += 1
        if kind == "trim":
            self._backend().trim()
        elif kind == "reduce":
            g.reduced_to = a.get("steps")
            if work is not None:
                work.steps = g.reduced_to
        elif kind == "offload":
            if self._open_window(job, stage, False) is not None:
                raise Suspended("hostd_no_window")
        else:
            raise Suspended(code)

    def run_begins(self, job: Any, stage: str, device: str, resumed: bool) -> None:
        g: LeaseJob = job.gpu
        g.stage, g.device, g.resumed = stage, device, resumed
        g.meter = StepMeter()
        g.spilling = False
        g.baseline_s = self.profile.step(stage)
        b = self._backend()
        reset = getattr(b, "peak_reset", None) if device == "gpu" else None
        if reset is not None:
            reset()
        return None  # a stage that never steps is watched by hostd

    def _peak(self) -> int:
        read = getattr(self._backend(), "peak_read", None)
        reserved, allocated = (read() if read is not None else None) or (0, 0)
        return int(reserved)

    def run_ended(self, job: Any, stage: str, how: str) -> None:
        g: LeaseJob = job.gpu
        p = self.profile
        if how == "finished":
            median = g.meter.median()
            r = self._renew(job, end={"how": "finished", "step_s": median, "normal_s": self._normal(stage)})
            learned = (r or {}).get("learned")
            if learned is None:
                return
            p.use_key(str(learned["card"]))
            if g.device == "gpu":
                read = getattr(self._backend(), "peak_read", None)
                reserved, allocated = (read() if read is not None else None) or (0, 0)
                g.peak_allocated_mb = max(g.peak_allocated_mb or 0, allocated) or None
                top = max(int(reserved), int(learned["drop_mb"]))
                if top > 0:
                    p.note_peak(stage, top)
            if learned["note_step"] and median is not None:
                p.note_step(stage, median)
            if learned["note_rate"] and g.audio_s:
                p.note_rate(stage, g.meter.active_s / g.audio_s)
            p.save()
            return
        self._renew(job, end={"how": how, "step_s": None, "normal_s": {}})
        if how == "oom":
            g.spills += 1
            g.note(stage, "wait", "oom", "顯存不夠用,放掉重新決定")
        peak = self._peak() if g.device == "gpu" else 0
        if peak > 0:
            p.note_peak(stage, peak)
            p.save()

    def close_window(self, job: Any) -> None:
        """A window inside a stage ends: speech back, waited for, then the stage is placed again."""
        g: LeaseJob = job.gpu
        ex = job.exclusive
        if g is None or not g.window or ex is None:
            return
        if ex._reload is None and ex.state not in (None, "done", "shared"):
            ex.state = "reloading"
            r = self._release(job, "close", False)
            self._apply_release(ex, r)
            ex.state = "done"
            g.window_closed(r.get("window") if isinstance(r, dict) else None)
        else:
            ex.join()
            g.window_closed()

    @staticmethod
    def _apply_release(ex: LeaseWindow, r: Any) -> None:
        if r is None:
            ex.errors.append("release: hostd did not answer; speech comes back with its own lease")
            return
        ex.errors.extend(r.get("errors") or [])
        if r.get("reload_s") is not None:
            ex.timings["reload_s"] = float(r["reload_s"])

    def give_back(self, job: Any) -> None:
        """After the conversion: speech starts coming back while the song is mixed, and the window
        ends when it is back (a ``close`` release: no GPU work is done under it any more)."""
        if job.yielding is not None:
            job.yielding.stop()
        self._backend().gate = None
        ex = job.exclusive
        if ex is None or ex._reload is not None or ex.state in (None, "done", "shared"):
            return
        ex.state = "reloading"

        def reload() -> None:
            r = self._release(job, "close", False)
            self._apply_release(ex, r)
            ex.state = "done"
            job.gpu.window_closed(r.get("window") if isinstance(r, dict) else None)

        ex._reload = threading.Thread(target=reload, name="sing-release", daemon=True)
        ex._reload.start()

    def finish(self, job: Any) -> dict[str, Any] | None:
        """The job's end (done, failed or cancelled): its lease ends; hostd's summary of it."""
        g: LeaseJob | None = job.gpu
        if g is None:
            return None
        if job.exclusive is not None:
            job.exclusive.join()
        r = self._release(job, "close", True)
        g.stop.set()
        g.window_closed(r.get("window") if isinstance(r, dict) else None)
        summary = r.get("summary") if isinstance(r, dict) else None
        if isinstance(summary, dict):
            g.hostd_summary = summary
        return g.hostd_summary

    def startup(self) -> None:
        log.info("GPU decisions come from hostd (SING_GPU_ARBITER=hostd)")

    def context(self, req: Any) -> dict[str, Any]:
        if not self._ignored_context:
            self._ignored_context = True
            log.info("POST /gpu/context ignored: hostd decides, and Core tells it (cluster.context)")
        return {"ok": True, "ignored": "SING_GPU_ARBITER=hostd: Core's context goes to hostd"}

    def health(self, job: Any) -> dict[str, Any]:
        now = time.monotonic()
        if now - self._health_at >= 2.0:
            self._health_at = now
            try:
                self._health = self._call("gpu.state", {}, 1.0)
            except Exception as e:  # noqa: BLE001
                log.debug("gpu.state for /health failed: %s", e)
                self._health = None
        st = self._health or {}
        try:
            cuda = bool(self._backend().uses_cuda())
        except Exception:  # noqa: BLE001
            cuda = False
        audience = st.get("audience") or {"in_voice": False, "listeners": 0, "live": False, "age_s": None,
                                          "fresh": False}
        learned = dict(st.get("learned") or {})
        learned["stages"] = self.profile.public().get("stages", {})
        return {
            "policy": str(st.get("policy") or "unknown"),
            "policy_source": "hostd" if st else "hostd unreachable",
            "arbiter": self.name,
            "cuda": st["cuda"] if isinstance(st.get("cuda"), bool) else cuda,
            "total_mb": st.get("total_mb"),
            "free_mb": st.get("free_mb"),
            "headroom_mb": st.get("headroom_mb"),
            "audience": audience,
            "learned": learned,
            "job": job.gpu.public() if job is not None and job.gpu is not None else None,
        }
