"""The two ONNX models of the end-of-turn worker. Neither needs PyTorch or a GPU."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np

from features import SAMPLE_RATE, log_mel

log = logging.getLogger("miyoria.turn")

# Silero VAD at 16 kHz: 512 new samples per call, after 64 samples of the previous call.
FRAME = 512
CONTEXT = 64


def _session(path: Path, threads: int) -> Any:
    import onnxruntime as ort  # type: ignore

    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = threads
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


class SmartTurn:
    """Smart Turn v3: is the speaker done? Input: the turn's audio up to now, output: a probability."""

    def __init__(self, path: Path, threads: int = 2) -> None:
        self.path = path
        self.session = _session(path, threads)

    def probability(self, audio: np.ndarray) -> float:
        out = self.session.run(None, {"input_features": log_mel(audio)})
        return float(np.asarray(out[0]).reshape(-1)[0])


class SileroVad:
    """The shared Silero session; each audio stream keeps its own `SileroStream`."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.session = _session(path, 1)

    def stream(self) -> "SileroStream":
        return SileroStream(self.session)


class SileroStream:
    """Recurrent state of one speaker's stream."""

    def __init__(self, session: Any) -> None:
        self.session = session
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, CONTEXT), dtype=np.float32)
        self.rate = np.array(SAMPLE_RATE, dtype=np.int64)

    def step(self, frame: np.ndarray) -> float:
        """Speech probability of one frame of FRAME float samples."""
        x = np.concatenate([self.context, frame.reshape(1, -1).astype(np.float32)], axis=1)
        out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": self.rate})
        self.context = x[:, -CONTEXT:]
        return float(np.asarray(out).reshape(-1)[0])


def load(kind: type, path: str, *args: Any) -> tuple[Any, str | None]:
    """(model, None), or (None, why) when it cannot be loaded: the worker runs on without it."""
    if not path:
        return None, "no model path configured"
    p = Path(path)
    if not p.is_file():
        return None, f"model file not found: {p}"
    try:
        return kind(p, *args), None
    except Exception as e:  # noqa: BLE001 - a broken model file must not stop the worker
        log.exception("could not load %s", p)
        return None, f"{type(e).__name__}: {e}"[:300]
