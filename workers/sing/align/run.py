"""One model step of a karaoke song's lyrics, in the align environment (this folder's pyproject.toml):
the song worker runs it as a subprocess, one step per process, so a model's VRAM is gone when the
process ends and only one model is ever loaded (docs/design/karaoke.md 「做了什麼第二步」).

    python run.py <job.json> <out.json>

    step "asr"    Qwen3-ASR-1.7B (Apache-2.0). With looked-up lines: what it hears in each line's
                  window, the similarity and status of each line, and the song's verdict. Without
                  lines, or when the verdict is ``wrong_song``: the whole lead in 20–30 s chunks
                  cut where it is quietest, what it hears in each.
    step "align"  forced alignment of each segment's text in its window: ``w2v`` (a wav2vec2 CTC
                  model per language, Apache-2.0) or ``mms`` (MMS_FA, CC-BY-NC-4.0, non-commercial
                  use only). Every segment comes back as its pieces (readings.py) with the seconds
                  of each unit; a segment with ``align: false`` only gets its pieces.

The job (JSON): ``step``, ``audio`` (a .npy of the lead, float32 mono 16 kHz), ``device`` (cuda |
cpu), ``language`` (ja | zh | en | null), ``model`` (the model's folder); for ``asr`` also ``lines``
([{text, a, b}]) and ``thresholds`` ({matched, uncertain, keep_share, wrong_share}); for ``align``
``aligner`` (w2v | mms) and ``segments`` ([{a, b, text, align}]).

The rules (thresholds, windows, chunks, the Viterbi alignment) are lyricsync.py's and the text is
readings.py's, the same files the worker imports; this file only runs models.
"""

from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import numpy as np  # noqa: E402

import lyricsync as L  # noqa: E402
from readings import LANGUAGE_NAMES, Lang, detect  # noqa: E402

SR = 16_000
# Kana the Japanese wav2vec2 model has no letter for (its vocabulary lacks small vowels, ぢ, ぷ and
# a few old ones): the nearest it has.
KANA_STANDINS = {"ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お", "ぢ": "じ", "ぷ": "ぶ", "ゎ": "わ", "ゐ": "い",
                 "ゑ": "え", "ゔ": "ぶ", "ゕ": "か", "ゖ": "け"}
NAME_TO_CODE = {v: k for k, v in LANGUAGE_NAMES.items()}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ── the recogniser ───────────────────────────────────────────────────────────


class Recogniser:
    def __init__(self, model_dir: str, device: str) -> None:
        import torch
        from qwen_asr import Qwen3ASRModel

        gpu = device.startswith("cuda")
        self.model = Qwen3ASRModel.from_pretrained(model_dir, dtype=torch.float16 if gpu else torch.float32,
                                                   device_map="cuda:0" if gpu else "cpu", max_new_tokens=512)

    def hear(self, clip: np.ndarray, language: str | None) -> tuple[str, str | None]:
        """(text, language code it heard or was told)."""
        if len(clip) < SR * L.MIN_CLIP_S:
            return "", language
        r = self.model.transcribe(audio=(clip, SR), language=LANGUAGE_NAMES.get(language or "", None))[0]
        heard_lang = NAME_TO_CODE.get(str(getattr(r, "language", "") or ""), None)
        return str(r.text or ""), language or heard_lang


def asr_step(job: dict[str, Any], y: np.ndarray) -> dict[str, Any]:
    rec = Recogniser(job["model"], job["device"])
    th = {**{"matched": L.MATCHED, "uncertain": L.UNCERTAIN, "keep_share": L.KEEP_SHARE,
             "wrong_share": L.WRONG_SHARE}, **(job.get("thresholds") or {})}
    language = job.get("language")
    out: dict[str, Any] = {"language": language, "lines": [], "verdict": "unchecked", "chunks": None}
    lines = job.get("lines") or []
    if lines:
        lang = Lang(language) if language else None
        statuses = []
        for w in lines:
            heard, _ = rec.hear(y[int(w["a"] * SR):int(w["b"] * SR)], language)
            sim = L.coverage(lang.norm(w["text"]), lang.norm(heard)) if lang is not None else 0.0
            status = L.line_status(sim, th["matched"], th["uncertain"])
            statuses.append(status)
            out["lines"].append({"heard": heard, "similarity": round(sim, 3), "status": status})
        out["verdict"] = L.song_verdict(statuses, th["keep_share"], th["wrong_share"])
    if not lines or out["verdict"] == "wrong_song":
        chunks, heard_langs = [], Counter()
        for a, b in L.quiet_chunks(y, SR):
            text, got = rec.hear(y[int(a * SR):int(b * SR)], language)
            if got:
                heard_langs[got] += 1
            chunks.append({"a": a, "b": b, "heard": text})
        out["chunks"] = chunks
        if language is None:
            language = heard_langs.most_common(1)[0][0] if heard_langs else detect("".join(c["heard"] for c in chunks))
        out["language"] = language
    return out


# ── the aligners ─────────────────────────────────────────────────────────────


class CtcAligner:
    """A wav2vec2 CTC model (transformers) and its vocabulary; ``mms`` adds MMS_FA's star token, a
    column of log probability 0 that absorbs what is not in the text (torchaudio's ``with_star``)."""

    def __init__(self, model_dir: str, device: str, mms: bool) -> None:
        import torch
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

        self.torch = torch
        self.device = device
        self.mms = mms
        self.gpu = device.startswith("cuda")
        self.model = Wav2Vec2ForCTC.from_pretrained(model_dir).eval()
        if self.gpu:
            self.model = self.model.to(device).half()
        self.features = Wav2Vec2FeatureExtractor.from_pretrained(model_dir)
        vocab = json.loads((Path(model_dir) / "vocab.json").read_text("utf-8"))
        self.vocab: dict[str, int] = {k: int(v) for k, v in vocab.items()}
        self.blank = self.vocab.get("<pad>", 0) if not mms else self.vocab.get("<blank>", 0)
        self.upper = all(k.upper() == k for k in self.vocab if len(k) == 1 and k.isalpha())

    def emissions(self, clip: np.ndarray) -> np.ndarray:
        torch = self.torch
        x = self.features(clip, sampling_rate=SR, return_tensors="pt").input_values
        with torch.inference_mode():
            x = x.to(self.device)
            logits = self.model(x.half() if self.gpu else x).logits.float()
            lp = torch.log_softmax(logits, dim=-1)[0].cpu().numpy()
        if self.mms:
            lp = np.concatenate([lp, np.zeros((lp.shape[0], 1))], axis=1)  # the star token
        return lp

    def tokens(self, unit: str, lang: Lang) -> list[int]:
        text = lang.roman(unit) if self.mms else unit
        if self.upper:
            text = text.upper()
        out = [self.vocab[c] for c in (c if c in self.vocab else KANA_STANDINS.get(c, c) for c in text)
               if c in self.vocab]
        if out and not self.mms and lang.language == "en" and "|" in self.vocab:
            out.append(self.vocab["|"])  # the English model's word boundary
        return out

    def align(self, clip: np.ndarray, units: list[str], lang: Lang, offset: float) -> list[tuple[float, float] | None]:
        per_unit = [self.tokens(u, lang) for u in units]
        flat = [t for ts in per_unit for t in ts]
        if not flat:
            return [None] * len(units)
        lp = self.emissions(clip)
        star = lp.shape[1] - 1
        seq = [star, *flat, star] if self.mms else flat
        spans = L.ctc_align(lp, seq, blank=self.blank)
        if self.mms:
            spans = spans[1:-1]
        return L.fill_untimed(L.unit_spans(spans, [len(ts) for ts in per_unit], len(clip) / SR / lp.shape[0], offset))


def align_step(job: dict[str, Any], y: np.ndarray) -> dict[str, Any]:
    language = job.get("language")
    segments = job.get("segments") or []
    if language is None:
        language = detect("".join(s["text"] for s in segments)) or "en"
    lang = Lang(language)
    aligner = None
    if any(s.get("align") for s in segments):
        aligner = CtcAligner(job["model"], job["device"], mms=job.get("aligner") == "mms")
    out = []
    for seg in segments:
        pieces = lang.pieces(seg["text"])
        entry: dict[str, Any] = {"pieces": [{"text": p.text, "reading": p.reading, "roman": p.roman, "say": p.say,
                                             "units": None} for p in pieces], "error": None}
        units = [u for p in pieces for u in p.say]
        if seg.get("align") and aligner is not None and units:
            a, b = float(seg["a"]), float(seg["b"])
            try:
                times = aligner.align(y[int(a * SR):int(b * SR)], units, lang, a)
            except Exception as e:  # noqa: BLE001 - this segment stays unaligned, the rest go on
                entry["error"] = repr(e)[:200]
            else:
                k = 0
                for p in entry["pieces"]:
                    p["units"] = [list(t) if t is not None else None for t in times[k:k + len(p["say"])]]
                    k += len(p["say"])
        out.append(entry)
    return {"language": language, "segments": out}


def main(argv: list[str]) -> int:
    job = json.loads(Path(argv[1]).read_text("utf-8"))
    t0 = time.time()
    y = np.load(job["audio"]).astype(np.float32)
    if job["step"] == "asr":
        out = asr_step(job, y)
    elif job["step"] == "align":
        out = align_step(job, y)
    else:
        raise SystemExit(f"unknown step {job['step']!r}")
    out["seconds"] = round(time.time() - t0, 1)
    try:
        import torch

        if torch.cuda.is_available():
            out["cuda_peak_mb"] = round(torch.cuda.max_memory_allocated() / 2**20)
    except ImportError:
        pass
    Path(argv[2]).write_text(json.dumps(out, ensure_ascii=False), "utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
