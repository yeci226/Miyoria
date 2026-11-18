"""Karaoke lyrics, checked and aligned (workers/sing/lyricsync.py, readings.py, lyricstage.py,
alignenv.py, align/run.py): the rules on synthetic curves and emissions, the text tools with fake
language libraries, the stage with fake model steps. No model, no GPU, no network."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))
sys.path.insert(0, str(SING / "align"))

import alignenv  # noqa: E402
import contracts  # noqa: E402
import lyricstage  # noqa: E402
import lyricsync as L  # noqa: E402
import readings  # noqa: E402
from readings import Lang  # noqa: E402

HZ = 50.0
NAN = math.nan


# ── verification ─────────────────────────────────────────────────────────────


def test_a_line_is_matched_uncertain_or_failed_by_how_much_of_it_was_heard():
    assert L.coverage("abcd", "abcd") == 1.0
    assert L.coverage("abcd", "xxabyycd") == 1.0  # in order, with other things between
    assert L.coverage("abcd", "dcba") == 0.25
    assert L.coverage("abcd", "") == 0.0 and L.coverage("", "abc") == 0.0
    assert [L.line_status(x) for x in (1.0, 0.75, 0.74, 0.5, 0.49, 0.0)] == [
        "matched", "matched", "uncertain", "uncertain", "failed", "failed"]
    assert L.line_status(0.7, matched=0.6, uncertain=0.3) == "matched"


def test_half_the_lines_matched_keeps_the_lyrics_and_under_a_fifth_is_the_wrong_song():
    m, u, f = "matched", "uncertain", "failed"
    assert L.song_verdict([m, m, u, f]) == "kept"
    assert L.song_verdict([m, u, u, f, f]) == "doubtful"  # 20 %: kept, but doubtful
    assert L.song_verdict([m, f, f, f, f, f]) == "wrong_song"  # 17 %
    assert L.song_verdict([]) == "unchecked"
    assert L.song_verdict([m, f, f], keep=0.3) == "kept"


def test_a_lines_window_runs_from_before_it_to_after_the_next_and_is_capped():
    lines = [{"start": 0.2, "end": 3.0}, {"start": 3.0, "end": 30.0}, {"start": 30.0, "end": None}]
    assert L.windows(lines, 40.0) == [(0.0, 3.3), (2.5, 15.0), (29.5, 40.0)]


def test_the_lead_is_cut_into_chunks_at_its_quietest_moments():
    sr = 1000
    y = np.ones(sr * 70, dtype=np.float32)
    y[int(24.0 * sr):int(24.3 * sr)] = 0.0  # quiet at 24 s
    y[int(51.0 * sr):int(51.3 * sr)] = 0.0  # and at 51 s
    chunks = L.quiet_chunks(y, sr)
    assert len(chunks) == 3 and chunks[0][0] == 0.0 and chunks[-1][1] == 70.0
    assert 24.0 <= chunks[0][1] <= 24.3 and 51.0 <= chunks[1][1] <= 51.3
    assert all(20.0 <= b - a <= 30.0 for a, b in chunks[:-1])
    assert L.quiet_chunks(np.ones(sr * 10), sr) == [(0.0, 10.0)]


# ── forced alignment ─────────────────────────────────────────────────────────


def emissions(path: list[int], vocab: int = 5, sharp: float = 8.0) -> np.ndarray:
    """Log probabilities that say ``path`` (a token per frame, 0 blank) clearly."""
    lp = np.full((len(path), vocab), -sharp)
    for t, tok in enumerate(path):
        lp[t, tok] = 0.0
    return lp


def test_ctc_alignment_finds_each_tokens_frames():
    lp = emissions([0, 1, 1, 0, 2, 0, 2, 2, 3, 0])
    assert L.ctc_align(lp, [1, 2, 2, 3]) == [(1, 2), (4, 4), (6, 7), (8, 8)]
    # A repeated token needs a blank between: two 2s cannot share frames 4-5 without one.
    with pytest.raises(ValueError):
        L.ctc_align(emissions([0, 1, 2]), [1, 2, 2, 3])
    assert L.ctc_align(emissions([0, 1]), []) == []


def test_ctc_alignment_follows_the_evidence_when_it_is_blurred():
    rng = np.random.default_rng(3)
    path = [0] * 5 + [1] * 10 + [0] * 3 + [2] * 6 + [3] * 8 + [0] * 4
    lp = emissions(path, sharp=2.0) + rng.normal(0, 0.3, (len(path), 5))
    spans = L.ctc_align(lp, [1, 2, 3])
    assert abs(spans[0][0] - 5) <= 1 and abs(spans[1][0] - 18) <= 1 and abs(spans[2][0] - 24) <= 1


def test_units_get_seconds_from_their_tokens_frames():
    spans = [(0, 1), (2, 2), (5, 9)]
    got = L.unit_spans(spans, [2, 0, 1], 0.02, 10.0)
    assert got == [(10.0, 10.06), None, (10.1, 10.2)]


def test_a_unit_the_model_cannot_say_shares_its_neighbours_time():
    assert L.fill_untimed([(1.0, 2.0), None, (2.0, 2.5)]) == [(1.0, 1.5), (1.5, 2.0), (2.0, 2.5)]
    assert L.fill_untimed([None, (1.0, 2.0)]) == [(1.0, 1.5), (1.5, 2.0)]
    assert L.fill_untimed([None, None]) == [None, None]


def test_the_japanese_model_gets_the_nearest_kana_it_has():
    import run

    aligner = object.__new__(run.CtcAligner)
    aligner.mms, aligner.upper = False, False
    aligner.vocab = {"<pad>": 0, "ぶ": 1, "い": 2, "ら": 3}
    lang = Lang("ja", words=lambda t: [], romaji=romaji)
    assert aligner.tokens("ぷ", lang) == [1] and aligner.tokens("ぃ", lang) == [2] and aligner.tokens("ら", lang) == [3]
    assert aligner.tokens("ん", lang) == []


# ── bars and the whole-line checks ───────────────────────────────────────────


def voiced_between(*spans: tuple[float, float], seconds: float = 10.0) -> list[bool]:
    v = [False] * int(seconds * HZ)
    for a, b in spans:
        for i in range(int(a * HZ), int(b * HZ)):
            v[i] = True
    return v


def test_a_bar_runs_on_through_the_voice_after_it_up_to_the_next_unit():
    voiced = voiced_between((1.0, 2.0), (2.5, 3.0))
    bars = L.bars([(1.0, 1.2), (1.6, 1.7), None, (2.5, 2.6)], voiced, HZ, 4.0)
    assert bars[0] == (1.0, 1.6)  # to the next unit
    assert bars[1] == (1.6, 2.0)  # to where the voice stops
    assert bars[2] is None and bars[3] == (2.5, 3.0)


def test_a_line_passes_only_when_every_bar_is_voiced_ordered_and_sensible():
    voiced = voiced_between((1.0, 3.0))
    good = [(1.0, 1.5), (1.5, 2.2), (2.2, 3.0)]
    assert L.line_check(good, voiced, HZ, line_start=1.1).ok
    silent = L.line_check([(1.0, 1.5), (4.0, 4.5)], voiced, HZ)
    assert not silent.ok and "without voice" in silent.reason and silent.voiced_share == 0.5
    long = L.line_check([(1.0, 1.5), (1.5, 8.0)], voiced_between((1.0, 8.0)), HZ)
    assert not long.ok and "6 s" in long.reason
    order = L.line_check([(2.0, 2.5), (1.0, 1.5)], voiced, HZ)
    assert not order.ok and "order" in order.reason
    squeezed = L.line_check([(1.0, 1.02), (1.02, 1.04), (1.04, 1.06), (1.06, 3.0)], voiced, HZ)
    assert not squeezed.ok and "60 ms" in squeezed.reason and squeezed.short_share == 0.75
    far = L.line_check(good, voiced, HZ, line_start=4.0)
    assert not far.ok and "far" in far.reason
    assert not L.line_check([(1.0, 1.5), None], voiced, HZ).ok
    assert not L.line_check([None], voiced, HZ).ok


def test_a_transcription_is_cut_into_lines_at_pauses_and_long_lines_again():
    times = [(0.0, 0.3), (0.3, 0.6), (1.2, 1.5), None, (1.5, 1.8)]
    assert L.split_heard(times) == [[0, 1], [2, 3, 4]]
    # 12 s without a 0.4 s pause: cut at the longest gap.
    steady = [(i * 1.0, i * 1.0 + 0.8) for i in range(12)]
    steady[7] = (7.1, 7.9)  # 0.3 s before it, the longest
    lines = L.split_heard(steady)
    assert lines == [list(range(7)), list(range(7, 12))]


# ── notes ────────────────────────────────────────────────────────────────────


def curve_of(*parts: tuple[float, float]) -> np.ndarray:
    """(MIDI or NaN, seconds) pieces at 50 Hz."""
    return np.concatenate([np.full(int(round(s * HZ)), m, dtype=np.float64) for m, s in parts])


def test_a_unit_is_one_note_at_its_median_pitch_or_one_per_run_of_a_melisma():
    c = curve_of((NAN, 1.0), (60.0, 0.5), (NAN, 1.0))
    assert L.unit_notes((1.0, 1.5), c, HZ, 3, 2) == [
        {"start": 1.0, "end": 1.5, "midi": 60.0, "source": "lyric", "line": 3, "char": 2}]
    assert L.unit_notes((0.0, 0.9), c, HZ, 0, 0) == []  # nothing voiced
    melisma = curve_of((60.0, 0.3), (64.0, 0.3), (62.0, 0.3))
    notes = L.unit_notes((0.0, 0.9), melisma, HZ, 0, 1)
    assert [n["midi"] for n in notes] == [60.0, 64.0, 62.0]
    assert notes[0]["start"] == 0.0 and notes[-1]["end"] == 0.9
    assert all(a["end"] == b["start"] for a, b in zip(notes, notes[1:]))


def test_lyric_notes_replace_the_pitch_notes_of_aligned_lines_only():
    pitch = [{"start": 0.0, "end": 0.5}, {"start": 1.0, "end": 1.5}, {"start": 3.0, "end": 3.5}]
    lyric = [{"start": 1.1, "end": 1.4, "source": "lyric"}]
    merged = L.merge_notes(pitch, lyric, [(0.9, 2.0)])
    assert [(n["start"], n.get("source")) for n in merged] == [(0.0, None), (1.1, "lyric"), (3.0, None)]


# ── readings ─────────────────────────────────────────────────────────────────


KANA_ROMAJI = {"わ": "wa", "た": "ta", "し": "shi", "う": "u", "か": "ka", "ら": "ra", "っ": "tsu", "と": "to",
               "きょ": "kyo", "ー": "-", "あ": "a"}


def romaji(kana: str) -> str:
    return "".join(KANA_ROMAJI.get(m, "?") for m in readings.morae(kana))


def ja(words: list[tuple[str, str]]) -> Lang:
    return Lang("ja", words=lambda _text: words, romaji=romaji)


def test_the_language_of_a_text():
    assert readings.detect("私は歌う") == "ja" and readings.detect("カラオケ") == "ja"
    assert readings.detect("我愛你") == "zh" and readings.detect("hello") == "en"
    assert readings.detect("123 !") is None


def test_japanese_pieces_are_morae_of_kana_and_words_of_kanji_with_their_reading():
    lang = ja([("私", "わたし"), ("は", "わ"), ("歌う", "うたう"), ("、", "、"), ("カラ", "から")])
    pieces = lang.pieces("私は 歌う、カラ")
    assert "".join(p.text for p in pieces) == "私は 歌う、カラ"
    assert [(p.text, p.reading, p.say) for p in pieces] == [
        ("私", "わたし", ["わ", "た", "し"]),
        ("は", None, ["わ"]),  # the particle is sung わ
        (" ", None, []),
        ("歌う", "うたう", ["う", "た", "う"]),
        ("、", None, []),
        ("カ", None, ["か"]),
        ("ラ", None, ["ら"]),
    ]
    assert pieces[0].roman == "watashi" and pieces[1].roman == "wa" and not pieces[2].sung
    assert lang.norm("私は 歌う、カラ") == "わたしわうたうから"


def test_small_kana_join_the_mora_before_and_mms_reads_romaji():
    lang = ja([("きょう", "きょう")])
    assert [p.say for p in lang.pieces("きょう")] == [["きょ"], ["う"]]
    assert lang.roman("きょ") == "kyo" and lang.roman("っ") == "t" and lang.roman("ー") == "a"


def test_chinese_pieces_are_characters_with_pinyin_and_mms_reads_toneless_pinyin():
    pinyin = {"愛": ("ài", "ai"), "你": ("nǐ", "ni"), "綠": ("lǜ", "lü")}
    lang = Lang("zh", pinyin=lambda c, tone: pinyin[c][0 if tone else 1], t2s=lambda s: s.replace("愛", "爱"))
    pieces = lang.pieces("愛你 OK!")
    assert "".join(p.text for p in pieces) == "愛你 OK!"
    assert [(p.text, p.reading, p.say) for p in pieces] == [
        ("愛", "ài", ["爱"]), ("你", "nǐ", ["你"]), (" ", None, []), ("OK", None, ["ok"]), ("!", None, [])]
    assert lang.roman("綠") == "lv" and lang.roman("OK") == "ok"
    assert lang.norm("愛你,OK") == "爱你ok"


def test_english_pieces_are_words():
    lang = Lang("en")
    pieces = lang.pieces("Don't stop, me now")
    assert [p.say for p in pieces if p.sung] == [["don't"], ["stop"], ["me"], ["now"]]
    assert "".join(p.text for p in pieces) == "Don't stop, me now"
    assert lang.norm("Don't stop!") == "dontstop" and lang.roman("Don't") == "don't"
    with pytest.raises(ValueError):
        Lang("fr")


# ── the stage, with fake model steps ─────────────────────────────────────────


SONG_S = 12.0
# The lead sings 1-3 s, 4-6 s and 7-9 s at C4, E4 and G4.
CURVE = curve_of((NAN, 1.0), (60.0, 2.0), (NAN, 1.0), (64.0, 2.0), (NAN, 1.0), (67.0, 2.0), (NAN, 3.0))
FOUND = [{"start": 1.0, "end": 4.0, "text": "one two three"}, {"start": 4.0, "end": 7.0, "text": "four five six"},
         {"start": 7.0, "end": 9.5, "text": "seven eight nine"}]
PITCH_NOTES = [{"start": 1.0, "end": 3.0, "midi": 60.0, "source": "pitch", "line": None, "char": None},
               {"start": 4.0, "end": 6.0, "midi": 64.0, "source": "pitch", "line": None, "char": None},
               {"start": 7.0, "end": 9.0, "midi": 67.0, "source": "pitch", "line": None, "char": None}]


class FakeSteps:
    """align/run.py's answers: ``heard`` per line (default: as written), units spread over ``sung``
    (each segment's voiced time, default the line's own two seconds)."""

    def __init__(self, heard: list[str] | None = None, chunks: list[dict] | None = None,
                 sung: dict[int, tuple[float, float]] | None = None, fail: str | None = None) -> None:
        self.heard, self.chunks, self.sung, self.fail = heard, chunks, sung or {}, fail
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, step: str, payload: dict) -> dict:
        self.calls.append((step, payload))
        if step == self.fail:
            raise lyricstage.StepFailed(f"{step} broke")
        lang = Lang("en")
        if step == "asr":
            lines = payload["lines"]
            heard = self.heard if self.heard is not None else [x["text"] for x in lines]
            out = []
            for x, h in zip(lines, heard):
                sim = L.coverage(lang.norm(x["text"]), lang.norm(h))
                out.append({"heard": h, "similarity": sim, "status": L.line_status(sim)})
            verdict = L.song_verdict([o["status"] for o in out])
            chunks = self.chunks if (not lines or verdict == "wrong_song") else None
            return {"language": "en", "lines": out, "verdict": verdict, "chunks": chunks}
        segs = []
        for i, seg in enumerate(payload["segments"]):
            pieces = lang.pieces(seg["text"])
            units = [u for p in pieces for u in p.say]
            a, b = self.sung.get(i, (seg["a"] + 0.5, seg["a"] + 2.5))
            step_s = (b - a) / max(1, len(units))
            k, entry = 0, []
            for p in pieces:
                times = [[a + (k + j) * step_s, a + (k + j + 1) * step_s] for j in range(len(p.say))] \
                    if seg["align"] else None
                k += len(p.say)
                entry.append({"text": p.text, "reading": None, "roman": None, "say": p.say, "units": times})
            segs.append({"pieces": entry, "error": None})
        return {"language": "en", "segments": segs}


def build(steps, found=FOUND, opts=None):
    return lyricstage.build(found, "lrclib", CURVE, SONG_S, opts or lyricstage.Options(), steps, HZ)


def validate(block):
    contracts.WorkersKaraokeLyricsV2.model_validate(block, strict=True)


def test_without_the_align_environment_the_lyrics_are_step_ones():
    got = build(None)
    validate(got.block)
    assert got.block["source"] == "found" and got.block["check"] is None and got.block["timing"] == "line"
    assert [x["status"] for x in got.block["lines"]] == ["unchecked"] * 3
    assert all(not x["aligned"] and x["pieces"] is None for x in got.block["lines"])
    assert got.notes == [] and got.made == {"lyrics": "line", "asr": None, "aligner": None}
    assert lyricstage.build([], None, CURVE, SONG_S, lyricstage.Options(), None, HZ).block is None


def test_matched_lines_are_aligned_and_get_a_note_per_unit():
    steps = FakeSteps(heard=["one two three", "four five", "seven eight nine"])
    got = build(steps, opts=lyricstage.Options(aligner="mms"))
    validate(got.block)
    lines = got.block["lines"]
    assert [x["status"] for x in lines] == ["matched", "uncertain", "matched"]
    assert got.block["check"] == {"matched": 2, "uncertain": 1, "failed": 0, "verdict": "kept"}
    assert [x["aligned"] for x in lines] == [True, False, True] and got.block["timing"] == "char"
    assert lines[1]["similarity"] == pytest.approx(0.727, abs=0.001) and lines[1]["heard"] == "four five"
    # The uncertain line is only shown: its pieces, no times; the aligner was not asked for it.
    align = [p for s, p in steps.calls if s == "align"][0]
    assert [s["align"] for s in align["segments"]] == [True, False, True] and align["aligner"] == "mms"
    assert all(p["start"] is None for p in lines[1]["pieces"])
    sung = [p for p in lines[0]["pieces"] if p["sung"]]
    assert [p["text"] for p in sung] == ["one", "two", "three"] and sung[0]["start"] == 1.0
    assert "".join(p["text"] for p in lines[0]["pieces"]) == "one two three"
    # A note per word, at the lead's pitch in it; the uncertain line keeps the note cut from the pitch.
    assert [(n["line"], n["char"], n["midi"]) for n in got.notes] == [
        (0, 0, 60.0), (0, 2, 60.0), (0, 4, 60.0), (2, 0, 67.0), (2, 2, 67.0), (2, 4, 67.0)]
    merged = L.merge_notes(PITCH_NOTES, got.notes, got.spans)
    assert [n["source"] for n in merged] == ["lyric"] * 3 + ["pitch"] + ["lyric"] * 3
    assert got.made == {"lyrics": "found-checked", "asr": "qwen3-asr-1.7b", "aligner": "mms"}


def test_a_line_whose_alignment_lands_in_silence_falls_back_to_the_pitch():
    steps = FakeSteps(sung={1: (6.2, 6.9)})  # the second line's words put after the lead stopped
    got = build(steps)
    lines = got.block["lines"]
    assert [x["status"] for x in lines] == ["matched"] * 3
    assert [x["aligned"] for x in lines] == [True, False, True]
    assert got.info["alignment_failed"][0]["line"] == 1 and "voice" in got.info["alignment_failed"][0]["why"]
    assert {n["line"] for n in got.notes} == {0, 2}
    assert len(got.spans) == 2


def test_the_wrong_song_is_dropped_for_what_was_heard_and_invented_text_goes():
    chunks = [{"a": 0.0, "b": 5.5, "heard": "la la la"}, {"a": 5.5, "b": 12.0, "heard": "thank you for watching"}]
    steps = FakeSteps(heard=["", "", "nothing alike"], chunks=chunks,
                      sung={0: (1.0, 3.0), 1: (10.0, 11.5)})  # the second chunk's words in silence
    got = build(steps)
    validate(got.block)
    b = got.block
    assert b["source"] == "heard" and b["provider"] == "lrclib"
    assert b["check"]["verdict"] == "wrong_song" and b["check"]["failed"] == 3
    assert [x["text"] for x in b["lines"]] == ["la la la"]
    line = b["lines"][0]
    assert line["source"] == "heard" and line["status"] == "uncertain" and line["aligned"]
    assert line["start"] == 1.0 and line["end"] == pytest.approx(3.0)
    assert got.info["heard_dropped"] == 1 and got.made["lyrics"] == "heard"
    assert {n["line"] for n in got.notes} == {0}


def test_without_looked_up_lyrics_the_lead_is_transcribed():
    steps = FakeSteps(chunks=[{"a": 0.0, "b": 12.0, "heard": "one two three four five six"}],
                      sung={0: (1.0, 3.0)})
    got = lyricstage.build([], None, CURVE, SONG_S, lyricstage.Options(), steps, HZ)
    validate(got.block)
    assert got.block["source"] == "heard" and got.block["check"] is None and got.block["provider"] is None
    assert steps.calls[0] == ("asr", {"language": None, "thresholds": lyricstage.Options().thresholds(), "lines": []})
    assert [x["text"] for x in got.block["lines"]] == ["one two three four five six"]


def test_a_failing_step_never_leaves_the_song_worse_than_step_one():
    asr_broke = build(FakeSteps(fail="asr"))
    assert [x["status"] for x in asr_broke.block["lines"]] == ["unchecked"] * 3
    assert "asr broke" in asr_broke.info["asr_error"] and asr_broke.notes == []
    align_broke = build(FakeSteps(fail="align"))
    validate(align_broke.block)
    assert [x["status"] for x in align_broke.block["lines"]] == ["matched"] * 3
    assert not any(x["aligned"] for x in align_broke.block["lines"]) and align_broke.notes == []
    nothing_heard = lyricstage.build([], None, CURVE, SONG_S, lyricstage.Options(), FakeSteps(chunks=[]), HZ)
    assert nothing_heard.block is None


def test_core_settings_reach_the_steps():
    o = lyricstage.Options.of({"aligner": "mms", "matched": 0.8, "uncertain": 0.4, "keep_share": 0.6,
                               "wrong_share": 0.1})
    assert o.thresholds() == {"matched": 0.8, "uncertain": 0.4, "keep_share": 0.6, "wrong_share": 0.1}
    assert lyricstage.Options.of({"aligner": "other"}).aligner == "mms"
    assert lyricstage.Options.of(None) == lyricstage.Options()
    req = contracts.WorkersSingJobRequest.model_validate({"query": "x", "purpose": "karaoke",
                                                          "karaoke_lyrics": {"aligner": "mms"}})
    assert lyricstage.Options.of(req.karaoke_lyrics).aligner == "mms"
    assert lyricstage.Options.of(req.karaoke_lyrics).matched == 0.75


# ── the align environment ────────────────────────────────────────────────────


def test_without_its_python_or_its_recogniser_the_align_environment_is_not_there(tmp_path):
    env = {"SING_ALIGN_PYTHON": str(tmp_path / "nope" / "python.exe"), "SING_MODELS_DIR": str(tmp_path)}
    assert "no align environment" in alignenv.available(env)
    py = tmp_path / "python.exe"
    py.write_bytes(b"")
    env["SING_ALIGN_PYTHON"] = str(py)
    assert "no recogniser" in alignenv.available(env)
    (tmp_path / alignenv.ASR_DIR).mkdir(parents=True)
    (tmp_path / alignenv.ASR_DIR / "config.json").write_text("{}")
    assert alignenv.available(env) is None
    assert alignenv.available({**env, "SING_ALIGN": "0"}) == "SING_ALIGN=0"
    assert alignenv.aligner_dir("mms", "ja", env) is None
    (tmp_path / "karaoke/w2v-ja").mkdir(parents=True)
    (tmp_path / "karaoke/w2v-ja/config.json").write_text("{}")
    assert alignenv.aligner_dir("w2v", "ja", env) == tmp_path / "karaoke/w2v-ja"
    assert alignenv.aligner_dir("w2v", "zh", env) is None


def test_a_step_that_cannot_run_fails_as_a_step(tmp_path):
    env = {"SING_ALIGN_PYTHON": str(tmp_path / "missing.exe"), "SING_MODELS_DIR": str(tmp_path)}
    with pytest.raises(lyricstage.StepFailed, match="could not start"):
        alignenv.run_step("asr", {"lines": []}, "cpu", tmp_path / "a.npy", tmp_path / "work", env)
    with pytest.raises(lyricstage.StepFailed, match="no w2v model"):
        alignenv.run_step("align", {"aligner": "w2v", "language": "ja", "segments": [{"align": True}]}, "cpu",
                          tmp_path / "a.npy", tmp_path / "work", env)
    assert not list((tmp_path / "work").glob("*.json"))


def test_the_step_runner_checks_and_aligns_with_any_model(monkeypatch):
    import run

    class Rec:
        def __init__(self, *a):
            pass

        def hear(self, clip, language):
            return ("one two three" if len(clip) > 16000 * 3 else "nothing", language)

    monkeypatch.setattr(run, "Recogniser", Rec)
    y = np.zeros(16000 * 10, dtype=np.float32)
    job = {"model": "m", "device": "cpu", "language": "en",
           "lines": [{"text": "one two three", "a": 0.0, "b": 4.0}, {"text": "four", "a": 4.0, "b": 5.0}]}
    out = run.asr_step(job, y)
    assert [x["status"] for x in out["lines"]] == ["matched", "failed"] and out["verdict"] == "kept"
    assert out["chunks"] is None
    out = run.asr_step({**job, "lines": []}, y)
    assert out["chunks"] == [{"a": 0.0, "b": 10.0, "heard": "one two three"}] and out["verdict"] == "unchecked"

    class Aligner:
        def __init__(self, model_dir, device, mms):
            self.mms = mms

        def align(self, clip, units, lang, offset):
            return [(offset + i, offset + i + 0.5) for i in range(len(units))]

    monkeypatch.setattr(run, "CtcAligner", Aligner)
    out = run.align_step({"model": "m", "device": "cpu", "language": None, "aligner": "mms",
                          "segments": [{"a": 2.0, "b": 6.0, "text": "one two", "align": True},
                                       {"a": 6.0, "b": 8.0, "text": "three", "align": False}]}, y)
    assert out["language"] == "en"
    first = out["segments"][0]["pieces"]
    assert [(p["text"], p["units"]) for p in first] == [("one", [[2.0, 2.5]]), (" ", []), ("two", [[3.0, 3.5]])]
    assert out["segments"][1]["pieces"][0]["units"] is None
