"""The song worker gives way to her voice.

Windows has no GPU priority between processes (MPS is Linux only), so the one thing that works is
not submitting work: while the TTS or ASR worker is busy, the conversion stops between diffusion
steps and separation segments, and goes on when they are done. Stopping costs the song a few
seconds; not stopping costs her first audio seconds, and with her talking that is what people hear.

A background thread polls ``GET /busy`` on the workers, so the conversion's check is a plain read.
A worker that does not answer counts as idle: yielding must never be what stops a song, and neither
must a voice channel that keeps talking, so a job gives up a limited time: ``max_s``, which gpu.py
sets from how much the song is needed (SING_YIELD_MAX_S, SING_YIELD_PATIENT_S).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

log = logging.getLogger("miyoria.sing.yield")

Getter = Callable[[str, float], dict[str, Any]]


def http_get(url: str, timeout: float) -> dict[str, Any]:
    import httpx

    r = httpx.get(url, timeout=timeout)
    r.raise_for_status()
    out = r.json()
    return out if isinstance(out, dict) else {}


class SpeechYield:
    def __init__(self, urls: list[str], get: Getter = http_get, *, poll_s: float = 0.1, hold_s: float = 0.3,
                 max_s: float = 120.0, timeout_s: float = 0.5) -> None:
        self.urls = urls
        self.get = get
        self.poll_s = poll_s
        self.hold_s = max(hold_s, 2 * poll_s)  # stays out of the way this long after the last busy answer
        self.max_s = max_s
        self.timeout_s = timeout_s
        self.yielded_s = 0.0
        self.pauses = 0
        self._busy_until = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._failed: set[str] = set()

    def start(self) -> "SpeechYield":
        if self.urls and self._thread is None:
            self._ask()  # so the first GPU work already knows
            self._thread = threading.Thread(target=self._poll, name="sing-yield", daemon=True)
            self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _poll(self) -> None:
        while not self._stop.wait(self.poll_s):
            self._ask()

    def _ask(self) -> None:
        for url in self.urls:
            try:
                if int(self.get(f"{url}/busy", self.timeout_s).get("busy", 0)) > 0:
                    self._busy_until = time.monotonic() + self.hold_s
                self._failed.discard(url)
            except Exception as e:  # noqa: BLE001
                if url not in self._failed:
                    self._failed.add(url)
                    log.info("cannot ask %s whether it is busy (%s): not yielding to it", url, e)

    def busy(self) -> bool:
        return time.monotonic() < self._busy_until

    def wait(self, cancelled: Callable[[], bool] = lambda: False) -> None:
        """Returns once the workers are idle, the job's allowance is used up or the job is cancelled."""
        if not self.busy() or self.yielded_s >= self.max_s:
            return
        t0 = time.monotonic()
        self.pauses += 1
        while self.busy() and not self._stop.is_set() and not cancelled():
            if self.yielded_s + time.monotonic() - t0 >= self.max_s:
                log.info("yielded %.0f s for this song; going on regardless", self.max_s)
                break
            time.sleep(0.02)
        self.yielded_s += time.monotonic() - t0

    def public(self) -> dict[str, Any]:
        return {"yielded_s": round(self.yielded_s, 2), "pauses": self.pauses}
