"""GPU allocation of the song worker (workers/sing/gpu.py): no GPU, no network.

The decision rules are tested as a table, then the worker runs jobs on a simulated machine: a card of
any size, other applications on it, speech workers that really give their VRAM back when offloaded,
and steps that take long when the card is full. It says nothing about how a real driver behaves.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))

from gpu import Audience, Facts, GpuJob, Limits, Machine, Profile, Speech, StepMeter, decide, policy_from_env  # noqa: E402
from test_sing import sing, wait  # noqa: E402,F401

GB = 1024


def facts(**kw) -> Facts:
    """A 12 GB card on stream: OBS, VTube Studio and both speech workers on it."""
    base = dict(policy="auto", stage="convert", limits=Limits(), cuda=True, total_mb=12 * GB, free_mb=2500, need_mb=4096,
                headroom_mb=1474, freed_mb=6000, speech_loaded=True, people=True, silence_est_s=70.0)
    return Facts(**{**base, **kw})


# ── the rules ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("people", [True, False, None])
@pytest.mark.parametrize("urgent", [True, False])
@pytest.mark.parametrize("stage", ["separate", "convert"])
def test_a_24_gb_card_shares_and_never_touches_her_voice(people, urgent, stage):
    d = decide(facts(total_mb=24 * GB, free_mb=15000, headroom_mb=2949, people=people, urgent=urgent, stage=stage))
    assert (d.mode, d.code) == ("share", "fits")


def test_a_12_gb_card_with_room_shares():
    assert decide(facts(free_mb=6000)).mode == "share"


def test_a_12_gb_card_on_stream_spares_her_voice_while_people_listen():
    assert decide(facts(stage="separate")).mode == "cpu"  # Demucs does not need the card
    d = decide(facts())
    assert d.mode == "wait" and "等空間" in d.reason


def test_a_12_gb_card_on_stream_takes_the_card_when_needed_now_or_nobody_listens():
    assert decide(facts(urgent=True)).code == "urgent"
    assert decide(facts(stage="separate", urgent=True)).code == "urgent"  # 5 s of GPU, not minutes of CPU
    assert decide(facts(people=False)).code == "nobody_listening"


def test_an_8_gb_card_is_sequential():
    card = dict(total_mb=8 * GB, free_mb=900, headroom_mb=983, freed_mb=6200)
    assert decide(facts(**card, people=False)).mode == "offload"
    assert decide(facts(**card, people=False, stage="separate")).mode == "offload"
    assert decide(facts(**card)).mode == "wait"  # people: not at once
    assert decide(facts(**card, stage="separate")).mode == "cpu"
    assert decide(facts(**card, waited_s=120.0)).code == "short_silence"


@pytest.mark.parametrize("policy", ["auto", "share", "offload", "wait"])
def test_without_cuda_there_is_nothing_to_share(policy):
    d = decide(Facts(policy=policy, stage="convert", limits=Limits(), cuda=False, speech_loaded=True))
    assert (d.mode, d.code) == ("cpu", "no_cuda")


def test_a_silence_that_would_be_long_is_not_taken_for_a_song_nobody_waits_for():
    assert decide(facts(waited_s=120.0, silence_est_s=300.0)).mode == "wait"
    assert decide(facts(waited_s=120.0, silence_est_s=None)).mode == "wait"
    assert decide(facts(waited_total_s=600.0, silence_est_s=300.0)).code == "waited_long"


def test_her_voice_does_not_go_for_nothing():
    # Offloading frees too little (11-07: it spilled with them offloaded).
    assert decide(facts(freed_mb=500, people=False)).mode == "wait"
    assert decide(facts(freed_mb=500, waited_s=120.0)).mode == "wait"
    # It was tried and did not help: not again, also for a song needed now.
    assert decide(facts(urgent=True, offload_useless=True)).mode == "wait"


def test_no_room_for_long_enough_fails_with_the_reason():
    d = decide(facts(offload_useless=True, waited_total_s=600.0))
    assert d.mode == "give_up" and "顯示卡" in d.reason


def test_she_gets_time_between_windows():
    assert decide(facts(urgent=True, gap_s=30.0)).code == "gap"
    assert decide(facts(stage="separate", urgent=True, gap_s=30.0)).mode == "cpu"


def test_a_card_too_small_for_the_estimate_tries_rather_than_waits_for_ever():
    assert decide(facts(total_mb=4 * GB, free_mb=3500, headroom_mb=491, speech_loaded=False)).code == "too_small"


def test_after_a_spill_the_estimate_alone_does_not_say_it_fits():
    assert decide(facts(free_mb=6000, crowded_mb=6000)).mode == "wait"
    assert decide(facts(free_mb=7000, crowded_mb=6000)).code == "fits"


def test_the_owners_policy_overrides():
    assert decide(facts(policy="share", free_mb=100)).code == "policy_share"
    assert decide(facts(policy="offload", free_mb=20000)).code == "policy_offload"
    assert decide(facts(policy="offload", speech_loaded=False)).mode == "share"
    assert decide(facts(policy="wait", urgent=True)).code == "policy_wait"
    assert decide(facts(policy="wait", waited_total_s=1e6)).mode == "wait"  # for as long as it takes
    assert decide(facts(policy="wait", stage="separate")).mode == "cpu"
    assert decide(facts(policy="wait", free_mb=9000)).mode == "share"


def test_policy_and_the_old_switch():
    assert policy_from_env({}) == ("yield", "default")
    assert policy_from_env({"SING_GPU_POLICY": "WAIT"}) == ("wait", "SING_GPU_POLICY")
    assert policy_from_env({"SING_GPU_POLICY": "nope"}) == ("yield", "default")
    assert policy_from_env({"SING_GPU_SHARE": "1"}) == ("auto", "SING_GPU_SHARE")
    assert policy_from_env({"SING_GPU_SHARE": "0"}) == ("offload", "SING_GPU_SHARE")
    assert policy_from_env({"SING_GPU_POLICY": "share", "SING_GPU_SHARE": "0"})[0] == "share"


# ── what is learned ──────────────────────────────────────────────────────────


def test_the_profile_is_kept_per_card_next_to_the_songs(tmp_path):
    p = Profile(tmp_path)
    p.use("RTX 4070 SUPER", 12282)
    assert p.need("convert", 4096) == (4096, False)
    p.note_peak("convert", 3300)
    p.note_peak("convert", 3500)
    p.note_step("convert", 0.1)
    p.note_offload(5800, 28.0)
    p.save()
    assert (tmp_path / "_gpu-profile.json").exists()

    again = Profile(tmp_path)
    again.use("RTX 4070 SUPER", 12282)
    assert again.need("convert", 4096) == (3500, True)
    assert again.step("convert") == 0.1 and again.freed_mb() == 5800 and again.reload_s() == 28.0
    other = Profile(tmp_path)
    other.use("RTX 3090", 24576)
    assert other.need("convert", 4096) == (4096, False) and other.step("convert") is None


def test_a_broken_profile_starts_over(tmp_path):
    (tmp_path / "_gpu-profile.json").write_text("{ nope", "utf-8")
    assert Profile(tmp_path).need("convert", 4096) == (4096, False)


def test_slow_is_not_learned_as_normal(tmp_path):
    p = Profile(tmp_path)
    p.note_step("convert", 0.1)
    p.note_step("convert", 1.0)
    assert p.step("convert") == pytest.approx(0.12)
    p.note_step("convert", 0.08)
    assert p.step("convert") == 0.08


def test_the_headroom_scales_with_the_card_and_grows_with_a_spill(tmp_path):
    p, limits = Profile(tmp_path), Limits()
    assert p.headroom(8 * GB, limits) == 983 and p.headroom(24 * GB, limits) == 2949
    p.note_spill("convert", 2000, 7.0, 0.1, 12 * GB)
    assert p.headroom(12 * GB, limits) == 2256
    p.note_spill("convert", 9000, 7.0, 0.1, 12 * GB)
    assert p.headroom(12 * GB, limits) == 3 * GB  # never more than a quarter of it
    p.note_healthy(1800)
    assert p.headroom(12 * GB, limits) == 1800
    assert p.public()["spills"] == 2


def test_the_time_she_was_given_way_to_is_not_step_time():
    m = StepMeter()
    m.resume(0.0)
    m.step(0.1)
    m.resume(5.0)  # waited 4.9 s for her
    m.step(5.1)
    assert m.times == pytest.approx([0.1, 0.1]) and m.active_s == pytest.approx(0.2)


def test_one_long_step_is_not_a_spill():
    m = StepMeter()
    for t in (0.1, 3.0, 0.1):
        m.resume(0.0)
        m.step(t)
    assert not m.slow(1.0)
    for t in (3.0, 3.0, 3.0):
        m.resume(0.0)
        m.step(t)
    assert m.slow(1.0)


def test_who_listens():
    now = [0.0]
    a = Audience(lambda: now[0])
    assert a.people(20, core_expected=False) is False
    assert a.people(20, core_expected=True) is None  # Core will say, it has not yet
    a.update(True, 3, False, [])
    assert a.people(20, False) is True
    a.update(True, 0, False, [])
    assert a.people(20, False) is False  # alone in voice
    a.update(False, 0, True, [])
    assert a.people(20, False) is True  # live
    now[0] = 30.0
    assert a.people(20, False) is None  # Core stopped talking: unknown, not nobody


def test_speech_workers_that_do_not_answer_still_count_as_loaded():
    def get(url, timeout):
        if "tts" in url:
            raise RuntimeError("connection refused")
        return {"offloaded": True}

    assert Speech(["http://tts", "http://asr"], get).read().loaded is True
    assert Speech(["http://asr"], get).read().loaded is False
    assert Speech([], get).read().loaded is False


# ── a job on a simulated machine ─────────────────────────────────────────────


class SimCard:
    def __init__(self, server, monkeypatch, tmp_path, *, total, others, tts=4700, asr=1500, job=3500, spill_under=1000):
        self.server, self.total, self.others, self.job, self.spill_under = server, total, others, job, spill_under
        self.speech = {"http://tts": tts, "http://asr": asr}
        self.gone: dict[str, int] = {}
        self.calls: list[tuple[str, float, dict]] = []
        self.busy = 0
        self.fast, self.slow = 0.02, 0.2
        self.always_spill = False
        self.steps = 0
        b = server.state.backend
        self.backend = b
        monkeypatch.setattr(b, "uses_cuda", lambda: True)
        monkeypatch.setattr(b, "vram", lambda peek=False: (self.free(), total))
        monkeypatch.setattr(b, "own_vram_mb", lambda: self.own())
        monkeypatch.setattr(b, "step_s", self.step)
        monkeypatch.setattr(b, "separate_devices", [])
        monkeypatch.setattr(server.state, "offload_post", self.post, raising=False)
        monkeypatch.setattr(server.state, "busy_get", self.get, raising=False)
        monkeypatch.setenv("SING_OFFLOAD_URLS", "http://tts,http://asr")
        # These scenarios are the voice-first policy's; ``yield`` has its own tests below.
        monkeypatch.setenv("SING_GPU_POLICY", os.environ.get("SING_GPU_POLICY", "auto"))
        monkeypatch.setenv("SING_GPU_CHECK_S", "0.01")
        monkeypatch.setenv("SING_MOCK_STEPS", os.environ.get("SING_MOCK_STEPS", "8"))
        monkeypatch.delenv("SING_GPU_POLICY", raising=False)
        monkeypatch.delenv("SING_GPU_SHARE", raising=False)
        m = server.state.machine
        m.profile, m.audience, m.gap_until, m.last = Profile(tmp_path), Audience(), 0.0, None
        m.profile.use("Mock GPU", total)
        self.profile = m.profile

    def own(self) -> int:
        return self.job if self.backend.gate is not None else 0

    def free(self) -> int:
        return max(0, self.total - self.others - sum(self.speech.values()) - self.own())

    def step(self) -> float:
        self.steps += 1
        return self.slow if self.always_spill or self.free() < self.spill_under else self.fast

    def post(self, url, body, timeout):
        base, what = url.rsplit("/", 1)
        self.calls.append((url, time.monotonic(), body))
        if what == "offload":
            self.gone[base] = self.speech[base]
            self.speech[base] = 0
            return {"offload_ms": 1}
        self.speech[base] = self.gone.pop(base, self.speech[base])
        return {"reload_ms": 1}

    def get(self, url, timeout):
        base, what = url.rsplit("/", 1)
        if what == "busy":
            return {"busy": self.busy}
        # `vram_allocated_mb` is what fooled everyone on 11-07: it must not be what anything uses.
        return {"offloaded": base in self.gone, "reason": "sing", "vram_allocated_mb": 1}

    def asked(self) -> list[str]:
        return [c[0] for c in self.calls]


@pytest.fixture
def machine(sing, monkeypatch, tmp_path):  # noqa: F811
    server = sys.modules["sing_server"]

    def make(**kw) -> SimCard:
        return SimCard(server, monkeypatch, tmp_path, **kw)

    return make


def people(client, n=2, urgent=(), live=False):
    client.post("/gpu/context", json={"in_voice": n > 0, "listeners": n, "live": live, "urgent": list(urgent)})


def nobody(client):
    people(client, 0)


def until(fn, seconds=8.0):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if fn():
            return
        time.sleep(0.005)
    raise AssertionError("it did not happen")


def submit(client, query, **kw) -> str:
    return client.post("/jobs", json={"query": query, **kw}).json()["job"]["id"]


def job_of(client, job_id) -> dict:
    return client.get(f"/jobs/{job_id}").json()["job"]


def test_on_a_24_gb_card_a_song_never_touches_her_voice(sing, machine):  # noqa: F811
    card = machine(total=24 * GB, others=5000)
    people(sing)
    done = wait(sing, submit(sing, "sim 24 gb"))
    assert done["state"] == "done", done
    assert card.calls == [] and done["exclusive"] == "shared"
    assert done["gpu"]["mode"] == "share" and done["gpu"]["code"] == "fits"
    assert done["song"]["gpu"]["policy"] == "auto" and done["song"]["gpu"]["silenced_s"] == 0


def test_on_a_full_12_gb_card_people_keep_her_voice_until_there_is_room(sing, machine, monkeypatch):  # noqa: F811
    card = machine(total=12 * GB, others=4500)
    people(sing)
    job = submit(sing, "sim 12 gb")
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait")
    held = job_of(sing, job)
    assert held["gpu"]["mode"] == "wait" and "等空間" in held["gpu"]["reason"]
    assert card.backend.separate_devices == ["cpu"]  # Demucs went on without the card
    assert card.calls == [] and card.steps == 0
    time.sleep(0.05)  # longer than a tick of the clock on Windows
    card.others = 500  # the stream ended
    done = wait(sing, job)
    assert done["state"] == "done", done
    assert card.calls == [] and done["exclusive"] == "shared"
    assert done["song"]["timings"]["gpu_wait_s"] > 0


def test_on_a_12_gb_card_a_song_needed_now_takes_a_bounded_window(sing, machine):  # noqa: F811
    card = machine(total=12 * GB, others=4500)
    people(sing)
    job = sing.post("/jobs", json={"query": "sim urgent", "exclusive_ack": True}).json()["job"]["id"]
    people(sing, urgent=[job])
    until(lambda: job_of(sing, job)["exclusive"] == "waiting")
    assert card.calls == []  # she says so first
    assert job_of(sing, job)["gpu"]["code"] == "urgent"
    sing.post(f"/jobs/{job}/exclusive")
    done = wait(sing, job)
    assert done["state"] == "done", done
    assert card.asked() == ["http://tts/offload", "http://asr/offload", "http://tts/reload", "http://asr/reload"]
    # If this worker died now, her workers would come back by themselves when the lease runs out.
    assert card.calls[0][2]["max_s"] == 60.0
    assert card.backend.separate_devices == [None]  # on the card, in the same window
    assert card.speech["http://tts"] == 4700


def test_a_song_queued_behind_a_waiting_one_makes_it_urgent(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_SILENCE_GAP_S", "0.05")
    card = machine(total=12 * GB, others=4500)
    people(sing)
    first = submit(sing, "sim waiting first")
    until(lambda: job_of(sing, first)["stage"] == "gpu_wait")
    second = submit(sing, "sim needed behind it")
    people(sing, urgent=[second])
    assert wait(sing, first)["state"] == "done"
    assert card.asked()[0] == "http://tts/offload"
    wait(sing, second)


def test_an_8_gb_card_with_nobody_listening_is_sequential_at_once(sing, machine):  # noqa: F811
    card = machine(total=8 * GB, others=1000)
    nobody(sing)
    done = wait(sing, submit(sing, "sim 8 gb"))
    assert done["state"] == "done", done
    assert card.asked()[:2] == ["http://tts/offload", "http://asr/offload"]
    assert done["gpu"]["silence_max_s"] == 90.0


def test_an_8_gb_card_with_people_defers_then_takes_a_short_silence(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_DEFER_S", "0.1")
    card = machine(total=8 * GB, others=1000)
    people(sing)
    job = submit(sing, "sim 8 gb people")
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait")
    assert card.calls == []
    done = wait(sing, job)
    assert done["state"] == "done", done
    assert card.asked()[0] == "http://tts/offload"
    assert any(d["code"] == "short_silence" for d in done["song"]["gpu"]["decisions"])


def test_without_cuda_nothing_is_asked_of_anyone(sing, machine, monkeypatch):  # noqa: F811
    card = machine(total=8 * GB, others=0)
    monkeypatch.setattr(card.backend, "uses_cuda", lambda: False)
    people(sing)
    done = wait(sing, submit(sing, "sim no cuda"))
    assert done["state"] == "done", done
    assert card.calls == [] and done["gpu"]["code"] == "no_cuda" and done["exclusive"] is None


def test_a_spill_releases_the_card_and_goes_on_from_where_it_was(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "12")
    card = machine(total=12 * GB, others=500, spill_under=99999)
    card.profile.note_step("convert", 0.02)
    trims = card.backend.trims
    people(sing)
    job = submit(sing, "sim spill")
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait" and job_of(sing, job)["gpu"]["spills"] > 0)
    held = job_of(sing, job)
    assert held["gpu"]["mode"] == "wait" and held["gpu"]["code"] in ("spill_wait", "no_room")
    assert card.calls == []  # people are listening: she keeps her voice
    assert card.backend.trims == trims + 1  # freed its own cache first
    assert card.own() == 0  # and holds nothing while it waits
    assert card.profile.public()["spills"] == 1
    assert card.profile.headroom(12 * GB, Limits()) > 1474  # what it learned from it
    card.others, card.spill_under, card.speech["http://asr"] = 0, 0, 0  # room again
    done = wait(sing, job)
    assert done["state"] == "done", done
    assert card.steps == 12  # no step ran twice
    codes = [d["code"] for d in done["song"]["gpu"]["decisions"]]
    assert "spill_free" in codes and "spill_wait" in codes
    assert card.profile.step("convert") <= 0.02  # the run that spilled taught nothing about normal


def test_a_spill_in_separation_restarts_it_on_the_cpu(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_SEGMENTS", "12")
    card = machine(total=12 * GB, others=500, spill_under=99999)
    card.profile.note_step("separate", 0.02)
    people(sing)
    job = submit(sing, "sim separation spill")
    until(lambda: len(card.backend.separate_devices) == 2)
    assert card.backend.separate_devices == [None, "cpu"]
    assert card.calls == []
    card.others, card.spill_under, card.speech["http://asr"] = 0, 0, 0
    assert wait(sing, job)["state"] == "done"


def test_a_spill_with_her_voice_already_offline_cuts_steps_then_gives_her_back(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "30")
    monkeypatch.setenv("SING_WAIT_MAX_S", "0.05")
    card = machine(total=12 * GB, others=4500)
    card.always_spill = True
    card.profile.note_step("convert", 0.02)
    job = submit(sing, "sim spill in a window")
    people(sing, urgent=[job])
    done = wait(sing, job)
    assert done["state"] == "failed" and "顯示卡" in done["error"], done
    assert done["gpu"]["steps"] == 20
    assert done["gpu"]["spilling"] is True
    # One try only: offloading did not help, so it is not asked again, and she is back.
    assert card.asked() == ["http://tts/offload", "http://asr/offload", "http://tts/reload", "http://asr/reload"]
    assert card.speech["http://tts"] == 4700


def test_a_slow_first_run_with_room_to_spare_is_a_slow_card(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_SPILL_STEP_S", "0.05")
    card = machine(total=24 * GB, others=2000)
    card.fast = 0.1  # over SING_SPILL_STEP_S; there is no baseline yet, and plenty of room
    nobody(sing)
    done = wait(sing, submit(sing, "sim slow card"))
    assert done["state"] == "done" and done["gpu"]["spills"] == 0, done
    assert card.profile.step("convert") == pytest.approx(0.1, abs=0.05)  # this card's normal
    card.fast = 0.02
    assert card.calls == []


def test_her_silence_is_bounded_and_the_song_still_finishes(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "40")
    monkeypatch.setenv("SING_SILENCE_MAX_S", "0.4")
    monkeypatch.setenv("SING_SILENCE_GAP_S", "0.2")
    card = machine(total=12 * GB, others=4500)
    card.fast = 0.03
    card.profile.note_offload(None, 0.05)
    job = submit(sing, "sim long song")
    people(sing, urgent=[job])
    done = wait(sing, job)
    assert done["state"] == "done", done
    tts = [c for c in card.calls if c[0].startswith("http://tts")]
    assert len(tts) >= 4 and len(tts) % 2 == 0  # more than one window, each one closed
    for i in range(0, len(tts), 2):
        assert tts[i + 1][1] - tts[i][1] <= 0.4 + 0.15  # the limit, plus one step
    for i in range(1, len(tts) - 1, 2):
        assert tts[i + 1][1] - tts[i][1] >= 0.2  # time to talk in between
    assert card.steps == 40
    assert any(d["code"] == "silence_limit" for d in done["song"]["gpu"]["decisions"])


def test_a_reload_slower_than_the_limit_still_leaves_a_window_time_to_work(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "20")
    monkeypatch.setenv("SING_SILENCE_MAX_S", "0.4")
    monkeypatch.setenv("SING_SILENCE_GAP_S", "0.05")
    card = machine(total=12 * GB, others=4500)
    card.fast = 0.03
    card.profile.note_offload(None, 60.0)  # far over the limit: 11-07 saw 87 s
    job = submit(sing, "sim slow reload")
    people(sing, urgent=[job])
    assert wait(sing, job)["state"] == "done"
    assert card.steps == 20  # it gets somewhere, instead of opening and closing windows for ever


def test_people_arriving_start_the_clock_on_a_window(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "60")
    monkeypatch.setenv("SING_SILENCE_MAX_S", "0.3")
    monkeypatch.setenv("SING_SILENCE_GAP_S", "0.05")
    card = machine(total=12 * GB, others=4500)
    card.profile.note_offload(None, 0.02)
    nobody(sing)
    job = submit(sing, "sim someone joins")
    until(lambda: card.steps > 20)  # far over the limit, and nobody minded
    assert sum(1 for c in card.asked() if c == "http://tts/reload") == 0
    people(sing, urgent=[job])
    until(lambda: "http://tts/reload" in card.asked(), 3.0)
    wait(sing, job)


def test_core_restarting_mid_job_never_opens_her_voice_up(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_CONTEXT_TTL_S", "0.05")
    card = machine(total=12 * GB, others=4500)
    people(sing)
    job = sing.post("/jobs", json={"query": "sim core restart", "exclusive_ack": True}).json()["job"]["id"]
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait")
    time.sleep(0.1)  # Core is gone
    held = job_of(sing, job)
    assert held["state"] == "running" and card.calls == []
    until(lambda: job_of(sing, job)["gpu"]["people"] is None)
    # Back: the first poll says who is there, the job picks it up.
    people(sing, 0)
    until(lambda: job_of(sing, job)["exclusive"] == "waiting")
    sing.post(f"/jobs/{job}/exclusive")
    assert wait(sing, job)["state"] == "done"


def test_core_gone_with_a_window_open_still_ends_it_on_time(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "60")
    monkeypatch.setenv("SING_CONTEXT_TTL_S", "0.05")
    monkeypatch.setenv("SING_SILENCE_MAX_S", "0.3")
    monkeypatch.setenv("SING_SILENCE_GAP_S", "0.05")
    card = machine(total=12 * GB, others=4500)
    card.profile.note_offload(None, 0.02)
    job = submit(sing, "sim core gone")
    people(sing, urgent=[job])
    until(lambda: "http://tts/offload" in card.asked())
    until(lambda: "http://tts/reload" in card.asked(), 3.0)  # no word from Core: unknown counts as people
    sing.delete(f"/jobs/{job}")
    assert wait(sing, job)["state"] == "cancelled"


def test_a_second_window_waits_for_its_own_go(sing, machine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SING_MOCK_STEPS", "40")
    monkeypatch.setenv("SING_SILENCE_MAX_S", "0.3")
    monkeypatch.setenv("SING_SILENCE_GAP_S", "0.05")
    monkeypatch.setenv("SING_EXCLUSIVE_WAIT_S", "20")
    card = machine(total=12 * GB, others=4500)
    card.fast = 0.03
    card.profile.note_offload(None, 0.02)
    job = sing.post("/jobs", json={"query": "sim two windows", "exclusive_ack": True}).json()["job"]["id"]
    people(sing, urgent=[job])
    for window in range(2):
        until(lambda: job_of(sing, job)["exclusive"] == "waiting")
        time.sleep(0.05)
        assert card.asked().count("http://tts/offload") == window  # nothing goes before Core says so
        sing.post(f"/jobs/{job}/exclusive")
        until(lambda: job_of(sing, job)["exclusive"] != "waiting")
    # Keep answering until it is done: how many windows it takes depends on the machine's timing.
    stop = threading.Event()

    def core():
        while not stop.is_set():
            if job_of(sing, job)["exclusive"] == "waiting":
                sing.post(f"/jobs/{job}/exclusive")
            time.sleep(0.01)

    t = threading.Thread(target=core, daemon=True)
    t.start()
    assert wait(sing, job)["state"] == "done"
    stop.set()
    t.join(1)


def test_a_cancel_reaches_a_job_waiting_for_room(sing, machine):  # noqa: F811
    machine(total=12 * GB, others=4500)
    people(sing)
    job = submit(sing, "sim cancelled while waiting")
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait")
    until(lambda: job_of(sing, job)["gpu"]["waited_s"] > 0)  # the wait under way counts
    sing.delete(f"/jobs/{job}")
    assert wait(sing, job)["state"] == "cancelled"


def test_the_policies_on_the_same_machine(sing, machine, monkeypatch):  # noqa: F811
    card = machine(total=12 * GB, others=4500)
    people(sing)
    monkeypatch.setenv("SING_GPU_POLICY", "offload")
    assert wait(sing, submit(sing, "sim policy offload"))["exclusive"] == "done" and len(card.calls) == 4

    card.calls.clear()
    monkeypatch.setenv("SING_GPU_POLICY", "share")
    done = wait(sing, submit(sing, "sim policy share"))
    assert done["exclusive"] == "shared" and card.calls == []

    monkeypatch.setenv("SING_GPU_POLICY", "wait")
    job = submit(sing, "sim policy wait")
    people(sing, urgent=[job])  # not even for this
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait")
    assert card.calls == []
    card.others = 500
    assert wait(sing, job)["state"] == "done" and card.calls == []


def test_what_it_measures_goes_into_the_profile(sing, machine, monkeypatch, tmp_path):  # noqa: F811
    card = machine(total=24 * GB, others=2000)
    monkeypatch.setattr(card.backend, "peak_read", lambda: (3600, 3200), raising=False)
    nobody(sing)
    done = wait(sing, submit(sing, "sim learning"))
    assert done["song"]["peak_vram_mb"] == 3200
    again = Profile(tmp_path)
    again.use("Mock GPU", 24 * GB)
    assert again.need("convert", 4096)[0] >= 3600
    assert again.step("convert") is not None
    assert again.rate("convert") != 0.3


def test_a_window_teaches_what_it_frees(sing, machine):  # noqa: F811
    card = machine(total=8 * GB, others=1000)
    nobody(sing)
    assert wait(sing, submit(sing, "sim freed"))["state"] == "done"
    assert card.profile.freed_mb() == 6200


def test_health_says_what_is_going_on(sing, machine):  # noqa: F811
    machine(total=12 * GB, others=4500)
    people(sing, 3, live=True)
    job = submit(sing, "sim health")
    until(lambda: job_of(sing, job)["stage"] == "gpu_wait")
    gpu = sing.get("/health").json()["gpu"]
    assert gpu["policy"] == "auto" and gpu["cuda"] is True and gpu["total_mb"] == 12 * GB
    assert gpu["audience"]["listeners"] == 3 and gpu["audience"]["live"] is True
    assert gpu["job"]["mode"] == "wait" and gpu["job"]["reason"]
    sing.delete(f"/jobs/{job}")
    wait(sing, job)


def test_a_worker_that_restarts_brings_her_voice_back(sing, machine):  # noqa: F811
    server = sys.modules["sing_server"]
    card = machine(total=8 * GB, others=1000)
    card.gone["http://tts"] = card.speech["http://tts"]
    card.speech["http://tts"] = 0
    server._recover_speech()
    assert card.asked() == ["http://tts/reload"] and card.speech["http://tts"] == 4700


def test_a_song_nobody_waits_for_gives_way_longer():
    m = Machine(lambda: None, Profile(Path("nowhere")), Audience(), lambda u, t: {})
    urgent = [False]
    g = GpuJob(m, "j", [], core_expected=True, urgent=lambda: urgent[0])
    m.audience.update(True, 2, False, [])
    assert g.yield_allowance() == 900.0
    urgent[0] = True
    assert g.yield_allowance() == 120.0


def test_a_window_renews_its_lease_until_it_ends():
    from exclusive import Exclusive

    calls = []
    ex = Exclusive(["http://tts"], lambda url, body, timeout: calls.append((url, body["max_s"])) or {}, max_s=0.15)
    ex.begin(lambda: False, None)
    time.sleep(0.4)
    ex.end()
    ex.join()
    renewals = [c for c in calls if c[0].endswith("/offload")]
    assert len(renewals) >= 3 and all(c[1] == 0.15 for c in renewals)
    count = len(calls)
    time.sleep(0.2)
    assert len(calls) == count  # over: a job that ended, or died, lets the lease run out


def test_a_device_measured_release_is_what_counts_not_what_torch_says():
    got = Speech(["http://tts", "http://asr"], lambda url, t: {"vram_allocated_mb": 4360, "released_mb": 2000}).read()
    assert got.released_mb == 4000
    assert Speech(["http://tts"], lambda url, t: {"vram_allocated_mb": 4360}).read().released_mb is None


def test_the_model_is_really_gone_after_a_conversion(monkeypatch):
    """11-07: an idle worker held 1.9 GB. The model sits in a reference cycle, and `unload` ran while
    `convert` still pointed at it, so nothing freed it until a collection that never came."""
    import gc
    import weakref

    import engine

    class Model:
        def __init__(self):
            self.loop = self  # like the step hook: refcounts alone never free it

        def convert(self, *a, **k):
            return []

    b = object.__new__(engine.RealBackend)
    b.keep, b.gate, b.steps, b.cfg_rate, b.f0_clean = False, None, 30, 0.7, True
    b._vc = b._demucs = None
    model = Model()
    gone = weakref.ref(model)
    b._vc = model
    del model

    class Audio:
        def mean(self, axis):
            return []

    monkeypatch.setattr(engine, "read_audio", lambda p: (Audio(), 44100))
    monkeypatch.setattr(engine, "vocal_gate", lambda a, y: y)
    monkeypatch.setattr(engine, "write_wav", lambda *a: None)
    monkeypatch.setattr(engine.RealBackend, "reference", lambda self: ([], 44100))
    gc.disable()  # what an idle process amounts to
    try:
        b.convert(Path("v.wav"), Path("o.wav"), 0, lambda f: None, lambda: False)
        assert gone() is None
    finally:
        gc.enable()


def test_the_lead_split_is_placed_like_the_separation_and_never_takes_her_voice_for_want_of_room():
    from gpu import CPU_STAGES

    assert "lead" in CPU_STAGES and "separate" in CPU_STAGES and "convert" not in CPU_STAGES
    assert decide(facts(stage="lead")).mode == "cpu"  # a crowded 12 GB card on stream: the CPU does it
    assert decide(facts(stage="lead", total_mb=24 * GB, free_mb=15000, headroom_mb=2949)).code == "fits"
    assert decide(facts(stage="lead", cpu_only=True)).code == "spill_cpu"


def test_yield_takes_her_voice_offline_when_a_stage_does_not_fit():
    # 2026-11-09: the owner would rather she goes quiet for a moment than a song waits for minutes.
    assert decide(facts(policy="yield", free_mb=9000)).code == "fits"
    full = decide(facts(policy="yield", free_mb=2500, urgent=False))
    assert full.mode == "offload" and full.code == "no_room"
    assert decide(facts(policy="yield", urgent=True)).code == "urgent"
    # The RoFormer stages do not go to the CPU (20 times slower there); Demucs' separation does.
    assert decide(facts(policy="yield", stage="lead")).mode == "offload"
    assert decide(facts(policy="yield", stage="separate", cpu_fallback=True, speech_loaded=False)).mode == "cpu"
    # Right after her voice came back she gets her gap; with nothing to offload it waits.
    assert decide(facts(policy="yield", gap_s=5.0)).code == "gap"
    assert decide(facts(policy="yield", speech_loaded=False)).mode == "wait"
