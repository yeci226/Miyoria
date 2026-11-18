"""Where the sing worker finds its two separation models: the host's model folder (SING_MODELS_DIR,
filled by `miyoria update`) first, the old workers/models second. No GPU stack, no network."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))

import engine  # noqa: E402
import leadsplit  # noqa: E402
import modelpaths  # noqa: E402

VOCAL = Path("vocal-split") / "MelBandRoformer.ckpt"
LEAD = Path("lead-split") / leadsplit.BS_CKPT
OLDER = Path("lead-split") / leadsplit.CKPT_NAME


@pytest.fixture()
def folders(tmp_path, monkeypatch):
    legacy = tmp_path / "workers-models"
    new = tmp_path / "state" / "models"
    monkeypatch.setattr(modelpaths, "LEGACY_DIR", legacy)
    return legacy, new, {"SING_MODELS_DIR": str(new)}


def put(root: Path, rel: Path | str, data: bytes = b"x") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_without_the_host_folder_only_the_old_place_counts(folders):
    legacy, _, _ = folders
    assert engine.vocal_model_path({}) == legacy / VOCAL
    assert leadsplit.model_path({}) == legacy / LEAD
    put(legacy, VOCAL)
    assert engine.vocal_model_path({}) == legacy / VOCAL


def test_before_the_download_the_old_files_are_used(folders):
    legacy, new, env = folders
    old_vocal, old_lead = put(legacy, VOCAL), put(legacy, LEAD)
    assert engine.vocal_model_path(env) == old_vocal
    assert leadsplit.model_path(env) == old_lead


def test_the_host_folder_wins_once_the_files_are_there(folders):
    legacy, new, env = folders
    put(legacy, VOCAL), put(legacy, LEAD)
    new_vocal, new_lead = put(new, VOCAL), put(new, LEAD)
    assert engine.vocal_model_path(env) == new_vocal
    assert leadsplit.model_path(env) == new_lead


def test_nothing_anywhere_names_the_place_the_download_will_fill(folders):
    _, new, env = folders
    assert engine.vocal_model_path(env) == new / VOCAL
    assert leadsplit.model_path(env) == new / LEAD
    assert not leadsplit.available(env)


def test_the_older_lead_model_is_the_fallback_in_either_folder(folders):
    legacy, new, env = folders
    older = put(legacy, OLDER)
    assert leadsplit.model_path(env) == older
    bs = put(new, LEAD)
    assert leadsplit.model_path(env) == bs


def test_an_exact_path_in_the_environment_wins(folders, tmp_path):
    legacy, new, env = folders
    put(new, VOCAL), put(new, LEAD)
    mine = tmp_path / "mine.ckpt"
    assert engine.vocal_model_path({**env, "SING_VOCAL_MODEL": str(mine)}) == mine
    assert leadsplit.model_path({**env, "SING_LEAD_MODEL": str(mine)}) == mine


def test_a_config_may_be_in_the_other_folder(folders):
    legacy, new, env = folders
    ckpt = put(new, VOCAL)
    assert leadsplit.config_path(ckpt, env) is None
    assert engine.default_separator(env) == "htdemucs"
    # The vocal .yaml is a manual file: it stays in the old place, its checkpoint was downloaded.
    cfg = put(legacy, "vocal-split/MelBandRoformer.yaml", b"audio: {}")
    assert leadsplit.config_path(ckpt, env) == cfg
    assert engine.default_separator(env) == engine.MELBAND


def test_the_split_runs_from_either_folder(folders):
    legacy, new, env = folders
    put(legacy, LEAD)
    put(legacy, LEAD.with_suffix(".yaml"), b"audio: {}")
    assert leadsplit.available(env)
    put(new, LEAD)
    assert leadsplit.model_path(env) == new / LEAD
    assert leadsplit.available(env)  # the config is found in the old folder


def test_the_downloaded_lead_config_is_found_by_its_published_name(folders):
    _, new, env = folders
    put(new, LEAD)
    assert leadsplit.available(env) is False
    cfg = put(new, "lead-split/becruily-bs/config_karaoke_frazer_becruily.yaml", b"audio: {}")
    assert leadsplit.config_path(new / LEAD, env) == cfg
    assert leadsplit.available(env) is True
