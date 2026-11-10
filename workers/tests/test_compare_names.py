"""The ASR comparison tool, on stand-in transcribers (the verdict on real clips is the owner's run)."""

from __future__ import annotations

import importlib.util
import sys

import pytest
from conftest import ROOT, make_wav

spec = importlib.util.spec_from_file_location("compare_names", ROOT / "asr" / "compare_names.py")
compare = importlib.util.module_from_spec(spec)
sys.modules["compare_names"] = compare
spec.loader.exec_module(compare)

NAMES = ["Miyo", "米優"]


@pytest.fixture
def clips(tmp_path):
    for name, text in (("a", "Miyo 你在嗎"), ("b", "米優來一下"), ("c", "今天好冷")):
        (tmp_path / f"{name}.wav").write_bytes(make_wav(0.1) + name.encode())
        (tmp_path / f"{name}.txt").write_text(text, encoding="utf-8")
    return tmp_path


def test_only_clips_that_say_a_name_count(clips):
    found = compare.clips_with_names(clips, NAMES)
    assert [p.name for p, _ in found] == ["a.wav", "b.wav"]


def test_aliases_can_win_back_a_name(clips):
    found = compare.clips_with_names(clips, NAMES)
    heard = {b"a": "meo 你在嗎", b"b": "咪優來一下"}
    run = lambda wav: heard[wav[-1:]]  # noqa: E731
    bare = compare.score(found, NAMES, {}, run)
    assert bare.raw == 0 and bare.fixed == 0 and len(bare.misses) == 2
    fixed = compare.score(found, NAMES, {"meo": "Miyo", "咪優": "米優"}, run)
    assert fixed.raw == 0 and fixed.fixed == 2


def test_the_verdict_compares_candidate_with_aliases_to_the_current_model_raw():
    a = compare.Score(clips=10, raw=9, fixed=9)
    assert compare.verdict(a, compare.Score(clips=10, raw=5, fixed=9)).startswith("B hears")
    assert compare.verdict(a, compare.Score(clips=10, raw=5, fixed=8)).startswith("B still misses")


def test_latin_aliases_are_whole_words_and_ignore_case():
    assert compare.apply_aliases("Meo 呢", {"meo": "Miyo"}) == "Miyo 呢"
    assert compare.apply_aliases("someone", {"meo": "Miyo"}) == "someone"
    assert compare.apply_aliases("叫meo啦", {"meo": "Miyo"}) == "叫Miyo啦"


def test_aliases_come_from_the_voice_section(tmp_path):
    p = tmp_path / "m.toml"
    p.write_text('[modules.voice.asr_aliases]\nmeo = "Miyo"\n', encoding="utf-8")
    assert compare.load_aliases(str(p)) == {"meo": "Miyo"}
    assert compare.load_aliases(None) == {}
