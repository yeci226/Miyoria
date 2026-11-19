"""The song worker's stages and its progress: the stage list the overlay says in words, and a progress
that only moves forward. Source scans and a stand-in job; no GPU, no network."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
SING = ROOT / "sing"
sys.path.insert(0, str(SING))

import server  # noqa: E402

CONTRACT = ROOT.parent / "packages" / "contracts" / "events" / "src" / "sing.ts"
# Stages the worker does not report as such: the finished job, and the ones the `sing` module makes up.
NOT_PREPARING = {"done"}
MODULE_ONLY = {"fetch", "unreachable"}


def _contract_stages() -> set[str]:
    text = CONTRACT.read_text(encoding="utf-8")
    body = re.search(r"SONG_PREPARE_STAGES = \[(.*?)\] as const", text, re.S)
    assert body, "SONG_PREPARE_STAGES is gone from the contract"
    return set(re.findall(r'"(\w+)"', body.group(1)))


def _worker_stages() -> set[str]:
    """Every stage name the worker's code sets, found in its source."""
    found: set[str] = set()
    for name in ("server.py", "lease.py"):
        src = (SING / name).read_text(encoding="utf-8")
        for pattern in (r'_set\(job, "(\w+)"', r'job\.stage = "(\w+)"', r'timed\("(\w+)"',
                        r'_gpu_stage\(\s*job, "(\w+)"', r'_place\(job, "(\w+)"'):
            found |= set(re.findall(pattern, src))
    # A job starts in `queued`; the karaoke lyrics steps are `stage = f"lyrics_{step}"`.
    found.add("queued")
    if 'f"lyrics_{step}"' in (SING / "server.py").read_text(encoding="utf-8"):
        found |= {"lyrics_asr", "lyrics_align"}
    found |= set(server.WEIGHTS) | set(server.KARAOKE_WEIGHTS)
    return found - NOT_PREPARING


@pytest.mark.skipif(not CONTRACT.exists(), reason="the TypeScript contract is not next to the worker")
def test_every_stage_the_worker_reports_is_in_the_contract_list():
    # The overlay has a plain label for each stage of that list (packages/stage test), so a stage
    # added here without a word for it stops one of the two tests.
    missing = _worker_stages() - _contract_stages()
    assert not missing, f"stages the worker reports that SONG_PREPARE_STAGES does not list: {sorted(missing)}"


@pytest.mark.skipif(not CONTRACT.exists(), reason="the TypeScript contract is not next to the worker")
def test_the_contract_lists_no_stage_the_worker_never_reports():
    stale = _contract_stages() - _worker_stages() - MODULE_ONLY
    assert not stale, f"SONG_PREPARE_STAGES lists stages the worker never sets: {sorted(stale)}"


def test_the_shares_add_up_and_name_real_stages():
    for weights in (server.WEIGHTS, server.KARAOKE_WEIGHTS):
        assert sum(weights.values()) == pytest.approx(1.0)
    # The video wait is a stage with a share of its own, not a bar stuck at the end.
    assert server.WEIGHTS["video"] > 0
    assert "convert_backing" in server.WEIGHTS and "beats" in server.WEIGHTS


def _job(karaoke: bool = False) -> SimpleNamespace:
    return SimpleNamespace(is_karaoke=karaoke, progress=0.0, stage="queued")


def test_progress_only_moves_forward_across_stages_and_repeats():
    job = _job()
    seen: list[float] = []
    # The real order of a cover with the lead split, a separation after it, and a backing pass.
    run = [("resolve", 0.0), ("download", 0.5), ("download", 1.0), ("separate", 0.5), ("lead", 0.5),
           ("separate", 0.1), ("separate", 0.9), ("convert", 0.0), ("convert", 1.0),
           ("convert_backing", 0.0), ("convert_backing", 0.5), ("convert", 0.2), ("mix", 0.5), ("beats", 0.0),
           ("lyrics", 0.0), ("video", 0.0), ("video", 0.5)]
    for stage, within in run:
        server._set(job, stage, within)
        assert job.stage == stage
        seen.append(job.progress)
    assert seen == sorted(seen)
    assert 0.0 < seen[-1] < 1.0  # the job's own `done` makes it 1


def test_a_stage_with_no_share_keeps_the_progress_and_changes_the_label():
    job = _job()
    server._set(job, "download", 1.0)
    before = job.progress
    server._set(job, "gpu_wait")
    assert (job.stage, job.progress) == ("gpu_wait", before)


def test_the_karaoke_job_moves_forward_too():
    job = _job(karaoke=True)
    seen = []
    for stage, within in [("resolve", 1), ("download", 1), ("separate", 1), ("lead", 1), ("reference", 1),
                          ("encode", 1), ("lyrics", 1), ("lyrics_asr", 0.5), ("lyrics_asr", 0.1),
                          ("lyrics_align", 1)]:
        server._set(job, stage, within)
        seen.append(job.progress)
    assert seen == sorted(seen) and seen[-1] < 1.0
