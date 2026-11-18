"""Where the two separation models are, with no GPU stack imported.

``miyoria update`` downloads them into the host's model folder (``<state>/models``, given to the
worker as ``SING_MODELS_DIR``). A machine that got them by hand has them under ``workers/models``
(the old place). The worker looks in the new folder first and falls back to the old one, so
nothing breaks before the files were fetched and a file that is only in the old place keeps
working. The two ``.yaml`` configs are looked for the same way (the vocal one is not downloaded:
it stays a manual file, so it may sit in the other folder than its checkpoint).

``SING_VOCAL_MODEL`` / ``SING_LEAD_MODEL`` still name one exact file and win over all of this.
"""

from __future__ import annotations

import os
from pathlib import Path

LEGACY_DIR = Path(__file__).resolve().parent.parent / "models"


def models_dir(env: dict[str, str] | None = None) -> Path | None:
    """The host's model folder (``SING_MODELS_DIR``); ``None`` when the worker is run by hand."""
    value = (env if env is not None else os.environ).get("SING_MODELS_DIR")
    return Path(value) if value else None


def roots(env: dict[str, str] | None = None) -> list[Path]:
    """The folders models are looked for in, the host's first."""
    new = models_dir(env)
    return [new, LEGACY_DIR] if new is not None else [LEGACY_DIR]


def locate(rel: str | Path, env: dict[str, str] | None = None) -> Path:
    """The file ``rel`` (below a model folder): the first folder that has it, else where it belongs.

    Where it belongs is the host's folder when there is one (it is what ``miyoria update`` fills),
    else the old one: the path an error message names.
    """
    candidates = [root / rel for root in roots(env)]
    for c in candidates:
        if c.is_file():
            return c
    return candidates[0]


# The names a config goes by besides ``<checkpoint>.yaml``: the one the becruily-bs repository
# publishes its config under (what ``miyoria update`` downloads) and the generic one.
CONFIG_NAMES = ("config.yaml", "config_karaoke_frazer_becruily.yaml")


def _configs_of(ckpt: Path) -> list[Path]:
    return [ckpt.with_suffix(".yaml"), *(ckpt.parent / name for name in CONFIG_NAMES)]


def config_beside(ckpt: Path, env: dict[str, str] | None = None) -> Path | None:
    """The ``.yaml`` of a checkpoint: beside it, else at the same place in the other model folder."""
    here = _configs_of(ckpt)
    for root in roots(env):
        try:
            rel = ckpt.relative_to(root)
        except ValueError:
            continue
        for other in roots(env):
            if other != root:
                here += _configs_of(other / rel)
    for c in here:
        if c.exists():
            return c
    return None
