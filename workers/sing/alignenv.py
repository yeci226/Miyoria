"""The align environment from the worker's side: where its Python and its models are, and one step of
align/run.py as a subprocess (docs/design/karaoke.md 「做了什麼第二步」).

    SING_ALIGN_PYTHON     the align environment's Python (default workers/sing/align/.venv, made by
                          ``uv sync --frozen`` in workers/sing/align); without it karaoke lyrics stay
                          unchecked, as in step 1
    SING_ALIGN_TIMEOUT_S  longest a step may run (default 900)
    SING_ALIGN            0 = never check or align lyrics (default 1)

The models are files of service.toml (``[[install.files]]``, under ``karaoke/`` of the model
folder, modelpaths.py): Qwen3-ASR-1.7B for both checking and transcribing; per language a wav2vec2
CTC model (``w2v``, Apache-2.0, the default) and MMS_FA (``mms``, CC-BY-NC-4.0, Core's setting).
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from lyricstage import StepFailed
from modelpaths import locate

HERE = Path(__file__).resolve().parent
ALIGN_DIR = HERE / "align"
# Folders below the model folder (service.toml's install.files paths).
ASR_DIR = "karaoke/qwen3-asr-1.7b"
ALIGNER_DIRS = {
    ("mms", None): "karaoke/mms-fa",
    ("w2v", "ja"): "karaoke/w2v-ja",
    ("w2v", "zh"): "karaoke/w2v-zh",
    ("w2v", "en"): "karaoke/w2v-en",
}


def python_path(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    if e.get("SING_ALIGN_PYTHON"):
        return Path(e["SING_ALIGN_PYTHON"])
    for p in (ALIGN_DIR / ".venv" / "Scripts" / "python.exe", ALIGN_DIR / ".venv" / "bin" / "python"):
        if p.is_file():
            return p
    return ALIGN_DIR / ".venv" / "Scripts" / "python.exe"


def model_dir(rel: str, env: dict[str, str] | None = None) -> Path | None:
    """The model's folder when its config is there."""
    cfg = locate(f"{rel}/config.json", env)
    return cfg.parent if cfg.is_file() else None


def aligner_dir(aligner: str, language: str | None, env: dict[str, str] | None = None) -> Path | None:
    rel = ALIGNER_DIRS.get((aligner, None)) or ALIGNER_DIRS.get((aligner, language or ""))
    return model_dir(rel, env) if rel else None


def available(env: dict[str, str] | None = None) -> str | None:
    """Why lyrics cannot be checked here, or ``None`` when they can."""
    e = env if env is not None else os.environ
    if e.get("SING_ALIGN", "1") == "0":
        return "SING_ALIGN=0"
    if not python_path(e).is_file():
        return f"no align environment ({python_path(e)})"
    if model_dir(ASR_DIR, e) is None:
        return f"no recogniser ({ASR_DIR})"
    return None


def lead_16k(vocal: Path, out: Path) -> Path:
    """The lead as run.py reads it: float32 mono 16 kHz in a .npy, made once."""
    import numpy as np
    from scipy.signal import resample_poly

    from karaoke import mono_of

    if not out.is_file():
        mono, sr = mono_of(vocal)
        y = resample_poly(mono, 16_000, sr) if sr != 16_000 else mono
        np.save(out, np.asarray(y, dtype=np.float32))
    return out


def run_step(step: str, payload: dict[str, Any], device: str, audio: Path, work: Path,
             env: dict[str, str] | None = None) -> dict[str, Any]:
    """One step of align/run.py on ``device`` (cuda | cpu); raises ``StepFailed``."""
    e = env if env is not None else os.environ
    if step == "asr":
        model = model_dir(ASR_DIR, e)
    else:
        model = aligner_dir(str(payload.get("aligner") or "mms"), payload.get("language"), e)
        if model is None and any(s.get("align") for s in payload.get("segments") or []):
            raise StepFailed(f"no {payload.get('aligner')} model for language {payload.get('language')}")
    job = {**payload, "step": step, "audio": str(audio), "device": "cuda" if device != "cpu" else "cpu",
           "model": None if model is None else str(model)}
    work.mkdir(parents=True, exist_ok=True)
    job_file, out_file = work / f"align-{step}.json", work / f"align-{step}.out.json"
    out_file.unlink(missing_ok=True)
    job_file.write_text(json.dumps(job, ensure_ascii=False), "utf-8")
    timeout = float(e.get("SING_ALIGN_TIMEOUT_S", "900"))
    try:
        r = subprocess.run([str(python_path(e)), str(ALIGN_DIR / "run.py"), str(job_file), str(out_file)],
                           capture_output=True, text=True, timeout=timeout, cwd=str(ALIGN_DIR),
                           env={**os.environ, "PYTHONIOENCODING": "utf-8", "HF_HUB_OFFLINE": "1"})
    except subprocess.TimeoutExpired as ex:
        raise StepFailed(f"{step} ran longer than {timeout:.0f} s") from ex
    except OSError as ex:
        raise StepFailed(f"{step} could not start: {ex}") from ex
    finally:
        job_file.unlink(missing_ok=True)
    try:
        if r.returncode != 0:
            tail = (r.stderr or "").strip().splitlines()[-3:]
            if any("out of memory" in line.lower() for line in tail):
                raise MemoryError(f"CUDA out of memory in {step}")  # gpu.py sees an OOM: retried elsewhere
            raise StepFailed(f"{step} exited with {r.returncode}: {' | '.join(tail)[:300]}")
        return json.loads(out_file.read_text("utf-8"))
    except (OSError, ValueError) as ex:
        raise StepFailed(f"{step} wrote no answer: {ex}") from ex
    finally:
        out_file.unlink(missing_ok=True)
