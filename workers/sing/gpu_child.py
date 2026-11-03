"""The song worker's GPU stages in a child process (``SING_GPU_CHILD=1``).

A CUDA context stays allocated (about 2 GB on an 8 GB card) until its process ends, even after
the models are gone. So separation, the pitch analysis and the conversion run in a child that
starts with the first of them and ends with the job: the idle worker holds no VRAM, and her TTS
and ASR get the card back whole.

Protocol over a ``Pipe``: parent → child ``("call", name, args, wants_progress, wants_cancel)`` or
``("close",)``; child → parent ``("ready", device)`` once, then per call any number of
``("progress", f)`` and one ``("done", result, peak_vram_mb)`` or ``("error", kind, message)``.
A cancel is a ``multiprocessing.Event`` the child's ``cancelled()`` reads.
"""

from __future__ import annotations

import importlib
import logging
import multiprocessing as mp
import sys
from pathlib import Path
from typing import Any, Callable

from engine import Cancelled, JobError

log = logging.getLogger("miyoria.sing.gpu")

#: How long a cancelled or closing child gets to finish before it is killed.
STOP_WAIT_S = 10.0
POLL_S = 0.1


def _peak_vram_mb() -> int | None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        return round(torch.cuda.max_memory_allocated() / 2**20)
    return None


def _child_main(conn: Any, cancel: Any, factory: str) -> None:
    """The child: builds the steps object with ``factory`` (``module:function``) and serves calls."""
    module, _, fn = factory.partition(":")
    try:
        steps = getattr(importlib.import_module(module), fn)()
        device = steps.device() if hasattr(steps, "device") else None
    except Exception as e:  # noqa: BLE001
        conn.send(("error", "start", f"{type(e).__name__}: {e}"[:500]))
        return
    conn.send(("ready", device))
    while True:
        try:
            msg = conn.recv()
        except EOFError:
            return
        if msg[0] != "call":
            return
        _, name, args, wants_progress, wants_cancel = msg
        extra: list[Any] = []
        if wants_progress:
            extra.append(lambda f: conn.send(("progress", float(f))))
        if wants_cancel:
            extra.append(cancel.is_set)
        try:
            result = getattr(steps, name)(*args, *extra)
        except Cancelled:
            conn.send(("error", "cancelled", "cancelled"))
        except JobError as e:
            conn.send(("error", "job", str(e)))
        except Exception as e:  # noqa: BLE001
            conn.send(("error", "crash", f"{type(e).__name__}: {e}"[:500]))
        else:
            peak = steps.peak_vram_mb() if hasattr(steps, "peak_vram_mb") else _peak_vram_mb()
            conn.send(("done", result, peak))


class GpuChild:
    """The GPU steps (``separate``, ``f0_stats``, ``ref_f0``, ``convert``) of one job, run in a child
    process. It starts on the first call; ``close()`` ends it (and must be called)."""

    def __init__(self, factory: str = "engine:make_gpu_steps") -> None:
        self.factory = factory
        self.device: str | None = None
        self._peak: int | None = None
        self._proc: Any = None
        self._conn: Any = None
        self._cancel: Any = None

    # ── the steps ──────────────────────────────────────────────────────

    def separate(self, source_wav: Path, vocals_out: Path, inst_out: Path, progress: Callable[[float], None]) -> None:
        self._call("separate", (source_wav, vocals_out, inst_out), progress=progress)

    def f0_stats(self, path: Path) -> tuple[float, float] | None:
        out = self._call("f0_stats", (path,))
        return None if out is None else (float(out[0]), float(out[1]))

    def ref_f0(self) -> float | None:
        return self._call("ref_f0", ())

    def convert(self, vocals_wav: Path, out_wav: Path, shift: int, progress: Callable[[float], None],
                check: Callable[[], bool]) -> None:
        self._call("convert", (vocals_wav, out_wav, shift), progress=progress, check=check, cancellable=True)

    def peak_vram_mb(self) -> int | None:
        """Most VRAM the child allocated so far (``None`` before it ran anything)."""
        return self._peak

    # ── process ────────────────────────────────────────────────────────

    def _start(self) -> None:
        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        self._cancel = ctx.Event()
        self._proc = ctx.Process(target=_child_main, args=(child, self._cancel, self.factory),
                                 name="sing-gpu", daemon=True)
        self._proc.start()
        child.close()
        self._conn = parent
        msg = self._recv(None)
        if msg[0] == "error":
            self.close()
            raise JobError(f"the GPU process did not start: {msg[2]}")
        self.device = msg[1]
        log.info("GPU process %s started (%s)", self._proc.pid, self.device)

    def _recv(self, check: Callable[[], bool] | None) -> tuple:
        """The child's next message; ``JobError`` when it died."""
        while True:
            try:
                if self._conn.poll(POLL_S):
                    return self._conn.recv()
            except (EOFError, OSError):
                break
            if not self._proc.is_alive():
                try:  # what it sent before it ended
                    if self._conn.poll(0):
                        return self._conn.recv()
                except (EOFError, OSError):
                    pass
                break
            if check is not None and check():
                return ("cancel",)
        self._proc.join(1.0)
        code = self._proc.exitcode
        self._kill()
        raise JobError(f"the GPU process stopped (exit code {code})")

    def _call(self, name: str, args: tuple, *, progress: Callable[[float], None] | None = None,
              check: Callable[[], bool] | None = None, cancellable: bool = False) -> Any:
        if self._proc is None:
            self._start()
        self._cancel.clear()
        self._conn.send(("call", name, args, progress is not None, cancellable))
        while True:
            msg = self._recv(check)
            kind = msg[0]
            if kind == "progress":
                if progress is not None:
                    progress(msg[1])
            elif kind == "done":
                if msg[2] is not None:
                    self._peak = max(self._peak or 0, int(msg[2]))
                return msg[1]
            elif kind == "cancel":
                self._stop_for_cancel(cancellable)
                raise Cancelled()
            elif msg[1] == "cancelled":
                raise Cancelled()
            elif msg[1] == "job":
                raise JobError(msg[2])
            else:
                raise JobError(f"the GPU step {name} failed: {msg[2]}")

    def _stop_for_cancel(self, cancellable: bool) -> None:
        """A step that reads the cancel gets STOP_WAIT_S to stop; any other is killed at once."""
        if cancellable:
            self._cancel.set()
            try:
                while self._conn.poll(STOP_WAIT_S):
                    msg = self._conn.recv()
                    if msg[0] in ("done", "error"):
                        return
            except (EOFError, OSError):
                pass
        self._kill()

    def _kill(self) -> None:
        if self._proc is not None and self._proc.is_alive():
            self._proc.terminate()
            self._proc.join(STOP_WAIT_S)
        self._reset()

    def _reset(self) -> None:
        if self._conn is not None:
            self._conn.close()
        self._proc = self._conn = self._cancel = None

    def close(self) -> None:
        """Ends the child, which frees its VRAM (idempotent)."""
        if self._proc is None:
            return
        try:
            self._conn.send(("close",))
        except (OSError, ValueError):
            pass
        self._proc.join(STOP_WAIT_S)
        if self._proc.is_alive():
            log.warning("GPU process %s did not stop; killing it", self._proc.pid)
        pid = self._proc.pid
        self._kill()
        log.info("GPU process %s ended", pid)
