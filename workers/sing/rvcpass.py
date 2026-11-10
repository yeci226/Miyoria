"""An RVC pass over the converted vocal: her own RVC model re-sings what YingMusic / Seed-VC made.

Why: RVC trained on her voice sounds steadier and more like her, but it cannot read the words of
someone else's singing (ContentVec loses Japanese singing, and her model only ever heard speech).
Given a vocal that is already her voice with the words in place, it keeps them (on her own speech
it loses almost nothing), so the chain "YingMusic, then RVC" gets YingMusic's words and RVC's voice
(2026-11-09 tests: docs/design/backlog.md, 唱歌轉換).

RVC runs in Applio's own environment (its venv, ``core.py infer``) as a subprocess: its torch and
dependencies differ from this worker's. After YingMusic / Seed-VC the pitch is not moved (the vocal
is already in key); alone (SING_VOICE=rvc) it moves the song's lead by the job's shift. Retrieval is off (``index_rate 0``: the index holds speech, which blurs the words).

Environment: ``SING_APPLIO_DIR`` (default ``../models/applio``), ``SING_RVC_MODEL`` (the ``.pth``),
``SING_RVC_INDEX`` (default the ``.index`` beside the model, optional), ``SING_RVC_PROTECT``
(default 0.33), ``SING_RVC_TIMEOUT_S`` (default 600).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_APPLIO = HERE.parent / "models" / "applio"
DEFAULT_MODEL = "logs/miyoria-deepseek-48k/miyoria-deepseek-48k_40e_11000s.pth"


def applio_dir(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_APPLIO_DIR") or DEFAULT_APPLIO)


def model_path(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_RVC_MODEL") or applio_dir(e) / DEFAULT_MODEL)


def index_path(env: dict[str, str] | None = None) -> Path | None:
    e = env if env is not None else os.environ
    if e.get("SING_RVC_INDEX"):
        return Path(e["SING_RVC_INDEX"])
    found = sorted(model_path(e).parent.glob("*.index"))
    return found[0] if found else None


def python_path(env: dict[str, str] | None = None) -> Path:
    root = applio_dir(env)
    for p in (root / "venv" / "Scripts" / "python.exe", root / "venv" / "bin" / "python"):
        if p.exists():
            return p
    return root / "venv" / "Scripts" / "python.exe"


def available(env: dict[str, str] | None = None) -> bool:
    """Applio's CLI, its Python and the model are all there."""
    root = applio_dir(env)
    return (root / "core.py").is_file() and python_path(env).is_file() and model_path(env).is_file()


def command(in_wav: Path, out_wav: Path, env: dict[str, str] | None = None, pitch: int = 0) -> list[str]:
    e = env if env is not None else os.environ
    # Absolute: Applio runs in its own folder.
    cmd = [
        str(python_path(e).resolve()), "core.py", "infer",
        "--input-path", str(Path(in_wav).resolve()), "--output-path", str(Path(out_wav).resolve()),
        "--pth-path", str(model_path(e).resolve()),
        "--pitch", str(int(pitch)), "--f0-method", "rmvpe", "--index-rate", "0",
        "--protect", e.get("SING_RVC_PROTECT", "0.33"),
        "--embedder-model", "contentvec", "--export-format", "WAV",
    ]
    idx = index_path(e)
    if idx is not None:
        cmd[cmd.index("--pitch"):cmd.index("--pitch")] = ["--index-path", str(idx.resolve())]
    return cmd


def run(in_wav: Path, out_wav: Path, env: dict[str, str] | None = None, pitch: int = 0) -> Path:
    """Converts ``in_wav`` into ``out_wav`` (Applio writes it at the model's rate). Raises
    ``RuntimeError`` when Applio fails or writes nothing."""
    e = dict(os.environ if env is None else env)
    root = applio_dir(e).resolve()
    child_env = {**os.environ, "APPLIO_CONFIG_FILE": str(root / "assets" / "config.json")}
    child_env.pop("APPLIO_F0_FILE", None)  # the local test hook: never from here
    out_wav.unlink(missing_ok=True)
    try:
        r = subprocess.run(command(in_wav, out_wav, e, pitch), cwd=str(root), env=child_env, capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=float(e.get("SING_RVC_TIMEOUT_S", "600")))
    except subprocess.TimeoutExpired as err:
        raise RuntimeError("RVC pass timed out") from err
    if r.returncode != 0 or not out_wav.is_file():
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        raise RuntimeError(f"RVC pass failed ({r.returncode}): {' | '.join(tail)[:300]}")
    return out_wav
