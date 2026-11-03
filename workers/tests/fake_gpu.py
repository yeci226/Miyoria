"""A stand-in for ``engine:make_gpu_steps`` in the GPU child tests: same methods, no GPU, no models.

``FAKE_GPU_CRASH=1`` kills the process in the middle of ``convert`` (like a driver crash);
``FAKE_GPU_STEP_S`` is how long each of the five ``convert`` steps takes.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

from engine import Cancelled


class FakeSteps:
    def __init__(self) -> None:
        self.crash = os.environ.get("FAKE_GPU_CRASH") == "1"
        self.step_s = float(os.environ.get("FAKE_GPU_STEP_S", "0"))

    def device(self) -> str:
        return "fake"

    def peak_vram_mb(self) -> int | None:
        return 123

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Callable[[float], None]) -> None:
        Path(vocals_out).write_bytes(b"vocals")
        Path(inst_out).write_bytes(b"instrumental")
        progress(1.0)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        return 440.0, 440.0

    def ref_f0(self) -> float | None:
        return 440.0

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Callable[[float], None],
                cancelled: Callable[[], bool]) -> None:
        for i in range(5):
            if cancelled():
                raise Cancelled()
            if self.crash and i == 2:
                os._exit(1)
            time.sleep(self.step_s)
            progress((i + 1) / 5)
        Path(out_wav).write_bytes(b"converted")


def make() -> FakeSteps:
    return FakeSteps()
