"""How much VRAM the whole card really has free, for every worker.

``torch.cuda.mem_get_info`` cannot say on Windows. Measured 2026-11-07 on a 12 GB card under WDDM,
at the same instant: it reported 1244 MB used, NVML 11284 MB. It follows what this process holds
plus a constant and does not see other applications at all, so a card that is nearly full looks
empty. ``torch.cuda.memory_allocated`` is further off still: it reported 88 MB for a process that
held 4.4 GB. NVML (what nvidia-smi reads) is the device's own number, and a read takes microseconds.

Standard library only: NVML comes with the driver, through ctypes, so nothing has to be installed.
``read`` answers ``None`` without NVML (no NVIDIA card or driver).
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
import time
from typing import NamedTuple

log = logging.getLogger("miyoria.device_memory")

MB = 2**20


class DeviceMemory(NamedTuple):
    total_mb: int
    used_mb: int
    free_mb: int
    name: str


class _Memory(ctypes.Structure):
    _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]


_lock = threading.Lock()
_nvml: ctypes.CDLL | None = None
_tried = False


def _library() -> ctypes.CDLL | None:
    names = ["libnvidia-ml.so.1"]
    if sys.platform == "win32":
        names = ["nvml.dll", os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"),
                                          "NVIDIA Corporation", "NVSMI", "nvml.dll")]
    for name in names:
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


def _load() -> ctypes.CDLL | None:
    global _nvml, _tried
    if not _tried:
        _tried = True
        lib = _library()
        if lib is not None and lib.nvmlInit_v2() == 0:
            _nvml = lib
        else:
            log.info("no NVML: the VRAM of the whole card cannot be read")
    return _nvml


def _index() -> int:
    """The card CUDA calls device 0 here: the first of CUDA_VISIBLE_DEVICES when that is a number."""
    first = os.environ.get("CUDA_VISIBLE_DEVICES", "").split(",")[0].strip()
    return int(first) if first.isdigit() else 0


def read(index: int | None = None) -> DeviceMemory | None:
    """The whole card now, every process on it included; ``None`` when that cannot be told."""
    with _lock:
        lib = _load()
        if lib is None:
            return None
        handle = ctypes.c_void_p()
        mem = _Memory()
        name = ctypes.create_string_buffer(96)
        if lib.nvmlDeviceGetHandleByIndex_v2(_index() if index is None else index, ctypes.byref(handle)) != 0:
            return None
        if lib.nvmlDeviceGetMemoryInfo(handle, ctypes.byref(mem)) != 0:
            return None
        lib.nvmlDeviceGetName(handle, name, ctypes.c_uint(len(name)))
    return DeviceMemory(mem.total // MB, mem.used // MB, mem.free // MB, name.value.decode("utf-8", "replace"))


def settled(limit_s: float = 3.0, every_s: float = 0.1, quiet_s: float = 0.5, noise_mb: int = 32) -> DeviceMemory | None:
    """The card once a process that just ended has given its memory back: the driver takes a moment,
    so this reads until the number stops falling for ``quiet_s``, at most ``limit_s``. Other
    applications move it a little all the time: less than ``noise_mb`` is not falling."""
    now = read()
    if now is None:
        return None
    t0 = last_drop = time.monotonic()
    while time.monotonic() - t0 < limit_s and time.monotonic() - last_drop < quiet_s:
        time.sleep(every_s)
        again = read()
        if again is None:
            break
        if again.used_mb < now.used_mb - noise_mb:
            last_drop = time.monotonic()
            now = again
        elif again.used_mb < now.used_mb:
            now = again
    return now


def report(before: DeviceMemory | None, after: DeviceMemory | None) -> dict[str, int | None]:
    """The fields ``/offload`` answers with: measured on the device, so other applications moving in
    the same moment show up here as well."""
    return {
        "device_used_before_mb": before.used_mb if before else None,
        "device_used_after_mb": after.used_mb if after else None,
        "released_mb": before.used_mb - after.used_mb if before and after else None,
    }


def fields() -> dict[str, int]:
    """The fields ``/health`` answers with."""
    now = read()
    if now is None:
        return {}
    return {"device_total_mb": now.total_mb, "device_used_mb": now.used_mb, "device_free_mb": now.free_mb}
