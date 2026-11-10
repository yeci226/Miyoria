"""Seed-VC singing voice conversion, also running YingMusic-SVC (Seed-VC fine-tuned for singing, with a
style residual; GiantAILab/YingMusic-SVC, MIT) from its own checkout. Seed-VC: F0-conditioned 44.1 kHz model, Whisper content encoder,
BigVGAN v2 44 kHz vocoder, RMVPE pitch), adapted from Seed-VC's ``inference.py`` (GPL-3.0, not
vendored: the repo is downloaded next to the worker, see ``SING_SEEDVC_DIR``).

Differences from upstream: weights are cached under ``<seedvc>/checkpoints`` without changing
the working directory, the pitch shift is given in semitones by the caller (the worker's auto
key picks it), the source's F0 contour is cleaned before it conditions the model (``pitch.py``:
octave errors, spikes and dropouts at the top of the range are what cracks high notes), and
conversion reports progress, can be cancelled between chunks, and can go on from the last finished
chunk after the step gate suspended it (``ConvertWork``: the features are made again, the audio
already converted is kept).
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torchaudio
import yaml
from engine import Cancelled, ConvertWork
from pitch import clean_f0
from huggingface_hub import hf_hub_download

log = logging.getLogger("miyoria.sing.seedvc")

DIT_REPO = "Plachta/Seed-VC"
DIT_FILE = "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth"
DIT_CONFIG = "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml"


class SeedVcSinger:
    """Seed-VC's singing model, or a model built on it with the same code layout: YingMusic-SVC
    (``ckpt`` + ``config`` given; its ``modules`` package must be the one on ``sys.path``). A model
    whose length regulator uses a style residual (YingMusic) gets it passed to the decoder too.
    ``cache``: where the shared helpers (CAMPPlus, RMVPE) are cached, default ``<root>/checkpoints``."""

    def __init__(self, root: Path, device: str, ckpt: Path | None = None, config: Path | None = None,
                 cache: Path | None = None) -> None:
        from modules.audio import mel_spectrogram
        from modules.bigvgan import bigvgan
        from modules.campplus.DTDNN import CAMPPlus
        from modules.commons import build_model, load_checkpoint, recursive_munch
        from modules.rmvpe import RMVPE
        from transformers import AutoFeatureExtractor, WhisperModel

        self.device = torch.device(device)
        cache = str(cache or root / "checkpoints")
        ckpt = str(ckpt) if ckpt is not None else hf_hub_download(DIT_REPO, DIT_FILE, cache_dir=cache)
        cfg_path = str(config) if config is not None else hf_hub_download(DIT_REPO, DIT_CONFIG, cache_dir=cache)
        config = yaml.safe_load(open(cfg_path, "r", encoding="utf-8"))
        self.style_residual = bool(config["model_params"].get("length_regulator", {}).get("use_style_residual", False))
        params = recursive_munch(config["model_params"])
        params.dit_type = "DiT"
        model = build_model(params, stage="DiT")
        model, _, _, _ = load_checkpoint(model, None, ckpt, load_only_params=True, ignore_modules=[],
                                         is_distributed=False)
        for k in model:
            model[k].eval()
            model[k].to(self.device)
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)
        self.model = model
        # Runs before every diffusion step: the place to give way to her voice (see yielding.py).
        # A chunk is seconds of GPU time, a step a fraction of a second.
        self.step_gate: Callable[[], None] | None = None
        model.cfm.estimator.register_forward_pre_hook(self._before_step)
        spect = config["preprocess_params"]["spect_params"]
        self.sr = int(config["preprocess_params"]["sr"])  # 44100
        self.hop = int(spect["hop_length"])  # 512
        mel_args = {
            "n_fft": spect["n_fft"],
            "win_size": spect["win_length"],
            "hop_size": spect["hop_length"],
            "num_mels": spect["n_mels"],
            "sampling_rate": self.sr,
            "fmin": spect.get("fmin", 0),
            "fmax": None if spect.get("fmax", "None") == "None" else 8000,
            "center": False,
        }
        self.to_mel = lambda x: mel_spectrogram(x, **mel_args)

        camp = hf_hub_download("funasr/campplus", "campplus_cn_common.bin", cache_dir=cache)
        self.campplus = CAMPPlus(feat_dim=80, embedding_size=192)
        self.campplus.load_state_dict(torch.load(camp, map_location="cpu"))
        self.campplus.eval().to(self.device)

        voc = bigvgan.BigVGAN.from_pretrained(params.vocoder.name, use_cuda_kernel=False)
        voc.remove_weight_norm()
        self.vocoder = voc.eval().to(self.device)

        whisper_name = params.speech_tokenizer.name
        self.whisper = WhisperModel.from_pretrained(whisper_name, torch_dtype=torch.float16).to(self.device)
        del self.whisper.decoder
        self.whisper_fx = AutoFeatureExtractor.from_pretrained(whisper_name)

        rmvpe = hf_hub_download("lj1995/VoiceConversionWebUI", "rmvpe.pt", cache_dir=cache)
        self.rmvpe = RMVPE(rmvpe, is_half=False, device=self.device)

    def _before_step(self, _module: object, _args: object) -> None:
        if self.step_gate is not None:
            self.step_gate()

    # ── features ─────────────────────────────────────────────────────────

    def _semantic(self, waves_16k: torch.Tensor) -> torch.Tensor:
        inputs = self.whisper_fx([waves_16k.squeeze(0).cpu().numpy()], return_tensors="pt",
                                 return_attention_mask=True)
        feats = self.whisper._mask_input_features(inputs.input_features,
                                                  attention_mask=inputs.attention_mask).to(self.device)
        with torch.no_grad():
            out = self.whisper.encoder(feats.to(self.whisper.encoder.dtype), head_mask=None,
                                       output_attentions=False, output_hidden_states=False, return_dict=True)
        s = out.last_hidden_state.to(torch.float32)
        return s[:, : waves_16k.size(-1) // 320 + 1]

    def _semantic_long(self, w16: torch.Tensor) -> torch.Tensor:
        if w16.size(-1) <= 16000 * 30:
            return self._semantic(w16)
        overlap = 5
        parts, buffer, done = [], None, 0
        while done < w16.size(-1):
            if buffer is None:
                chunk = w16[:, done: done + 16000 * 30]
            else:
                chunk = torch.cat([buffer, w16[:, done: done + 16000 * (30 - overlap)]], dim=-1)
            s = self._semantic(chunk)
            parts.append(s if done == 0 else s[:, 50 * overlap:])
            buffer = chunk[:, -16000 * overlap:]
            done += 30 * 16000 if done == 0 else chunk.size(-1) - 16000 * overlap
        return torch.cat(parts, dim=1)

    def f0(self, mono: np.ndarray, sr: int, clean: bool = False) -> np.ndarray:
        x = torch.from_numpy(np.ascontiguousarray(mono, dtype=np.float32))
        w16 = torchaudio.functional.resample(x[None], sr, 16000)[0]
        f = self.rmvpe.infer_from_audio(w16, thred=0.03)
        return clean_f0(f) if clean else f

    def median_f0(self, mono: np.ndarray, sr: int) -> float | None:
        f = self.f0(mono, sr)
        voiced = f[f > 1]
        if voiced.size < 20:
            return None
        return float(np.exp(np.median(np.log(voiced))))

    # ── conversion ───────────────────────────────────────────────────────

    @torch.no_grad()
    def convert(self, source: np.ndarray, sr: int, ref: np.ndarray, ref_sr: int, shift: int, steps: int,
                cfg_rate: float, progress: Callable[[float], None], cancelled: Callable[[], bool],
                clean: bool = True, work: ConvertWork | None = None) -> np.ndarray:
        import librosa

        work = work if work is not None else ConvertWork()
        dev = self.device
        if sr != self.sr:
            source = librosa.resample(source, orig_sr=sr, target_sr=self.sr)
        if ref_sr != self.sr:
            ref = librosa.resample(ref, orig_sr=ref_sr, target_sr=self.sr)
        src = torch.tensor(source).unsqueeze(0).float().to(dev)
        ref_t = torch.tensor(ref[: self.sr * 25]).unsqueeze(0).float().to(dev)

        w16 = torchaudio.functional.resample(src, self.sr, 16000)
        s_alt = self._semantic_long(w16)
        r16 = torchaudio.functional.resample(ref_t, self.sr, 16000)
        s_ori = self._semantic(r16)
        mel = self.to_mel(src)
        mel2 = self.to_mel(ref_t)
        target_lengths = torch.LongTensor([mel.size(2)]).to(dev)
        target2_lengths = torch.LongTensor([mel2.size(2)]).to(dev)
        feat2 = torchaudio.compliance.kaldi.fbank(r16, num_mel_bins=80, dither=0, sample_frequency=16000)
        feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
        style2 = self.campplus(feat2.unsqueeze(0))

        f0_ori_np = self.rmvpe.infer_from_audio(r16[0], thred=0.03)
        f0_alt_np = self.rmvpe.infer_from_audio(w16[0], thred=0.03)
        if clean:
            f0_ori_np, f0_alt_np = clean_f0(f0_ori_np), clean_f0(f0_alt_np)
        f0_ori = torch.from_numpy(np.ascontiguousarray(f0_ori_np)).to(dev)[None]
        f0_alt = torch.from_numpy(np.ascontiguousarray(f0_alt_np)).to(dev)[None]
        shifted = f0_alt.clone()
        if shift:
            shifted[f0_alt > 1] = f0_alt[f0_alt > 1] * (2 ** (shift / 12))

        style_cond = style_prompt = None
        if self.style_residual:
            cond, *_, style_cond = self.model.length_regulator(s_alt, ylens=target_lengths, n_quantizers=3, f0=shifted,
                                                               style=style2, return_style_residual=True)
            prompt, *_, style_prompt = self.model.length_regulator(s_ori, ylens=target2_lengths, n_quantizers=3,
                                                                   f0=f0_ori, style=style2, return_style_residual=True)
        else:
            cond, *_ = self.model.length_regulator(s_alt, ylens=target_lengths, n_quantizers=3, f0=shifted)
            prompt, *_ = self.model.length_regulator(s_ori, ylens=target2_lengths, n_quantizers=3, f0=f0_ori)

        window = self.sr // self.hop * 30 - mel2.size(2)
        overlap_frames = 16
        overlap_wave = overlap_frames * self.hop
        chunks: list[np.ndarray] = work.chunks
        prev: np.ndarray | None = work.prev
        done = work.done
        total = cond.size(1)
        while done < total:
            if cancelled():
                raise Cancelled()
            chunk = cond[:, done: done + window]
            last = done + window >= total
            cat = torch.cat([prompt, chunk], dim=1)
            extra = {}
            if style_cond is not None and style_prompt is not None:
                extra["style_r"] = torch.cat([style_prompt, style_cond[:, done: done + window]], dim=1)
            with torch.autocast(device_type=dev.type, dtype=torch.float16, enabled=dev.type == "cuda"):
                vc = self.model.cfm.inference(cat, torch.LongTensor([cat.size(1)]).to(dev), mel2, style2, None,
                                              work.steps or steps, inference_cfg_rate=cfg_rate, **extra)
                vc = vc[:, :, mel2.size(-1):]
            wave = self.vocoder(vc.float()).squeeze().float().cpu().numpy()
            if prev is None:
                if last:
                    chunks.append(wave)
                    break
                chunks.append(wave[:-overlap_wave])
            else:
                head = wave if last else wave[:-overlap_wave]
                chunks.append(_crossfade(prev, head, overlap_wave))
                if last:
                    break
            prev = wave[-overlap_wave:]
            done += vc.size(2) - overlap_frames
            work.prev, work.done = prev, done
            progress(min(0.99, done / max(total, 1)))
        progress(1.0)
        return np.concatenate(chunks).astype(np.float32)


def _crossfade(a: np.ndarray, b: np.ndarray, overlap: int) -> np.ndarray:
    fade_out = np.cos(np.linspace(0, math.pi / 2, overlap)) ** 2
    fade_in = np.cos(np.linspace(math.pi / 2, 0, overlap)) ** 2
    b = b.copy()
    n = min(len(b), overlap)
    b[:n] = b[:n] * fade_in[:n] + (a[-overlap:] * fade_out)[:n]
    return b
