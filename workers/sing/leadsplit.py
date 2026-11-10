"""Lead / backing vocal split: the stage after the vocal separation, so the converter hears one voice.

Demucs gives "the vocals", which in most songs is the lead with its harmonies, doubles and ad-libs
all in one stem. Seed-VC's pitch detector (RMVPE) is trained on one voice at a time: where a second
voice is as loud as the lead it reads that one, and the lead's own contour jumps by a third or an
octave for as long as the harmony is the stronger (the "breaks" in a converted song). No decoder over
RMVPE's output can undo that, since the lead's salience is simply not there. So the stem is split
first: a karaoke RoFormer gives ``lead``, and ``backing = vocals - lead`` is whatever else sings.

The model: becruily & Frazer's BS-RoFormer karaoke (2026-11-09: MVSep's lead/back leaderboard
10.06-10.10 dB lead SDR) run on the whole song, as it was trained; the older aufr33 & viperx
Mel-Band RoFormer run on the separated vocals scores 8.90 there and lost words in songs with loud
harmonies (櫻ノ詩). Only the lead is converted (pitch statistics and the auto key come from it
too); what happens to the backing is the request's ``backing`` (server.py).

Model: ``SING_LEAD_MODEL`` is the checkpoint (``.ckpt``, a state dict), default
``workers/models/lead-split/becruily-bs/bs_roformer_karaoke_frazer_becruily.ckpt`` when it is there,
else the aufr33 & viperx one; its config is the ``.yaml`` of the same name beside it (or
``config.yaml``), which also says the architecture (``freqs_per_bands``: BS-RoFormer, else
Mel-Band). ``SING_LEAD_INPUT`` = ``mix`` (default) or ``vocals``: what the model reads. CUDA runs in
fp16 unless ``SING_LEAD_FP16=0``. Nothing downloads the files: with none the split is off and the
pipeline is the plain one. ``SING_LEAD_SPLIT=0`` turns it off with the files there.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

CKPT_NAME = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
BS_CKPT = Path("becruily-bs") / "bs_roformer_karaoke_frazer_becruily.ckpt"
HERE = Path(__file__).resolve().parent
DEFAULT_DIR = HERE.parent / "models" / "lead-split"
# What made lead stems recorded before the model was: the aufr33 & viperx model on the vocals.
LEGACY_TAG = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956@vocals"


def enabled(env: dict[str, str] | None = None) -> bool:
    return (env if env is not None else os.environ).get("SING_LEAD_SPLIT", "1") != "0"


def model_path(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    if e.get("SING_LEAD_MODEL"):
        return Path(e["SING_LEAD_MODEL"])
    return DEFAULT_DIR / BS_CKPT if (DEFAULT_DIR / BS_CKPT).is_file() else DEFAULT_DIR / CKPT_NAME


def reads_mix(env: dict[str, str] | None = None) -> bool:
    """The model reads the whole song (default) rather than the separated vocals."""
    return (env if env is not None else os.environ).get("SING_LEAD_INPUT", "mix") != "vocals"


def tag(env: dict[str, str] | None = None) -> str:
    """What makes a lead stem: the checkpoint and what it read (cached stems are kept per tag)."""
    return f"{model_path(env).stem}@{'mix' if reads_mix(env) else 'vocals'}"


def config_path(ckpt: Path) -> Path | None:
    for c in (ckpt.with_suffix(".yaml"), ckpt.parent / "config.yaml"):
        if c.exists():
            return c
    return None


def available(env: dict[str, str] | None = None) -> bool:
    """Whether a split would run: switched on, and the checkpoint and its config are there."""
    if not enabled(env):
        return False
    ckpt = model_path(env)
    return ckpt.is_file() and config_path(ckpt) is not None


class LeadSplitter:
    """The model and the chunked inference around it (torch is imported here, not at import)."""

    def __init__(self, ckpt: Path, device: str) -> None:
        import torch
        import yaml

        cfg_file = config_path(ckpt)
        if cfg_file is None:
            raise RuntimeError(f"no config (.yaml) beside {ckpt}")
        cfg = yaml.load(cfg_file.read_text("utf-8"), Loader=yaml.UnsafeLoader)
        self.chunk = int(cfg["audio"]["chunk_size"])
        self.sr = int(cfg["audio"]["sample_rate"])
        self.overlap = int((cfg.get("inference") or {}).get("num_overlap", 4))
        kwargs = dict(cfg["model"])
        if "freqs_per_bands" in kwargs:
            from bsroformer import BSRoformer

            kwargs["freqs_per_bands"] = tuple(kwargs["freqs_per_bands"])
            model = BSRoformer(**kwargs)
        else:
            from melband import MelBandRoformer

            model = MelBandRoformer(**kwargs)
        state = torch.load(str(ckpt), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        model.load_state_dict(state)
        self.model = model.to(device).eval()
        self.device = device
        self.fp16 = str(device).startswith("cuda") and os.environ.get("SING_LEAD_FP16", "1") != "0"
        self.gate: Callable[[], None] | None = None
        self._hooked = False

    def _hook(self) -> None:
        if self._hooked:
            return

        def before(_module: Any, _args: Any) -> None:
            if self.gate is not None:
                self.gate()

        self.model.register_forward_pre_hook(before)
        self._hooked = True

    def lead(self, x, sr: int, progress: Callable[[float], None] | None = None, overlap: int | None = None):
        """The lead voice of ``x`` ((frames, 2) float32 at the model's rate) as the same shape.

        Overlapping chunks cross-faded with a Hann window; the ends are padded by reflection so the
        first and last seconds get the same context as the middle."""
        import numpy as np
        import torch

        if sr != self.sr:
            raise ValueError(f"the model works at {self.sr} Hz, got {sr}")
        if x.shape[1] == 1:
            x = np.repeat(x, 2, axis=1)
        n = x.shape[0]
        chunk = self.chunk
        hop = max(1, chunk // max(1, overlap or self.overlap))
        pad = chunk - hop
        total = n + 2 * pad
        total = chunk if total < chunk else total + (-(total - chunk)) % hop
        right = total - n - pad
        padded = np.pad(x, ((pad, right), (0, 0)), mode="reflect" if n > max(pad, right) else "constant")
        wav = torch.from_numpy(np.ascontiguousarray(padded.T))
        window = torch.hann_window(chunk, periodic=True).clamp(min=1e-3)
        out = torch.zeros_like(wav)
        weight = torch.zeros(total)
        starts = list(range(0, total - chunk + 1, hop))
        self._hook()
        amp = torch.autocast("cuda", dtype=torch.float16) if getattr(self, "fp16", False) else _nothing()
        with torch.no_grad(), amp:
            for i, s in enumerate(starts):
                part = wav[:, s:s + chunk].to(self.device)[None]
                y = self.model(part)[0].float().cpu()
                out[:, s:s + chunk] += y * window
                weight[s:s + chunk] += window
                if progress is not None:
                    progress((i + 1) / len(starts))
        res = (out / weight.clamp(min=1e-6))[:, pad:pad + n]
        return res.numpy().T.copy()


class _nothing:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_: Any) -> None:
        return None
