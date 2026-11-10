"""The GPU to the song worker alone for a while, as the last resort (gpu.py decides when).

This is the mechanism only: a window in which the speech workers have dropped their models. A job
can open more than one (each gets its own ``Exclusive``); one that shares the card has an empty one
whose ``exclusive`` says ``shared``, so Core knows speech goes on.

The job asks the workers of ``SING_OFFLOAD_URLS`` to drop their models (``POST /offload``) and to load
them again (``POST /reload``) when the window ends, also when the job fails or is cancelled. After a
conversion the reload runs while the song is mixed; the job only counts as done once they are back,
so her opening line has a voice.

``max_s`` is a lease, renewed by a thread as long as the window is open: on 11-07 a fixed 15 minutes
ran out during a slow job, both workers loaded themselves back on top of it, and conversion fell to
34 s per step. Now they only come back by themselves when this worker went away, and soon after.

A job submitted with ``exclusive_ack`` first waits (``exclusive: "waiting"``) until Core says go
(``POST /jobs/{id}/exclusive``, after she told everyone she is off to prepare the song) or
SING_EXCLUSIVE_WAIT_S passed.

    state:  None → waiting → offloading → active → reloading → done
            None → shared                       (nothing was offloaded)
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

log = logging.getLogger("miyoria.sing.exclusive")

Poster = Callable[[str, dict[str, Any], float], dict[str, Any]]


def http_post(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    import httpx

    r = httpx.post(url, json=body, timeout=timeout)
    r.raise_for_status()
    out = r.json()
    return out if isinstance(out, dict) else {}


def parse_urls(raw: str | None) -> list[str]:
    return [u.strip().rstrip("/") for u in (raw or "").split(",") if u.strip()]


class Exclusive:
    def __init__(self, urls: list[str], post: Poster = http_post, *, ack_wait_s: float = 20.0,
                 offload_timeout_s: float = 60.0, reload_timeout_s: float = 300.0, max_s: float = 60.0) -> None:
        self.urls = urls
        self.post = post
        self.ack_wait_s = ack_wait_s
        self.offload_timeout_s = offload_timeout_s
        self.reload_timeout_s = reload_timeout_s
        self.max_s = max_s
        self.state: str | None = None
        self.offloaded: list[str] = []
        self.asked: list[str] = []  # offload requested, whether or not it answered in time
        self.timings: dict[str, float] = {}
        self.errors: list[str] = []
        self._lock = threading.Lock()
        self._reload: threading.Thread | None = None
        self._ended = threading.Event()

    def share(self, free_mb: int | None) -> None:
        """The job runs next to the workers: nothing to offload, nothing to wait for."""
        self.state = "shared"
        self.timings["free_vram_mb"] = float(free_mb or 0)

    def begin(self, cancelled: Callable[[], bool], ack: threading.Event | None) -> None:
        """Waits for Core's go (when ``ack`` is given), then offloads every worker. Raises
        nothing but what ``cancelled`` makes it: a worker that cannot offload is skipped."""
        from engine import Cancelled

        if self.state is not None:
            return
        if ack is not None:
            self.state = "waiting"
            t0 = time.monotonic()
            while not ack.is_set() and time.monotonic() - t0 < self.ack_wait_s:
                if cancelled():
                    raise Cancelled()
                ack.wait(0.1)
            self.timings["exclusive_wait_s"] = round(time.monotonic() - t0, 2)
        if cancelled():
            raise Cancelled()
        self.state = "offloading"
        t0 = time.monotonic()
        for url in self.urls:
            self.asked.append(url)
            try:
                r = self.post(f"{url}/offload", {"reason": "sing", "max_s": self.max_s}, self.offload_timeout_s)
                self.offloaded.append(url)
                released = r.get("released_mb")
                if isinstance(released, (int, float)):
                    self.timings["released_mb"] = self.timings.get("released_mb", 0.0) + released
                log.info("offloaded %s in %s ms: the card gave back %s MB", url, r.get("offload_ms"), released)
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"offload {url}: {e}"[:200])
                log.warning("could not offload %s: %s", url, e)
        self.timings["offload_s"] = round(time.monotonic() - t0, 2)
        self.state = "active"
        if self.asked and self.max_s > 0:
            threading.Thread(target=self._renew, name="sing-lease", daemon=True).start()

    def _renew(self) -> None:
        """A worker that cannot be reached now may answer the next time: two more tries in a lease."""
        while not self._ended.wait(self.max_s / 3):
            for url in self.asked:
                try:
                    self.post(f"{url}/offload", {"reason": "sing", "max_s": self.max_s}, min(5.0, self.max_s / 3))
                except Exception as e:  # noqa: BLE001
                    log.info("could not renew the offload of %s: %s", url, e)

    def end(self) -> None:
        """Starts loading the offloaded workers again (idempotent)."""
        with self._lock:
            self._ended.set()
            if self._reload is not None or self.state in (None, "done", "shared"):
                return
            self.state = "reloading"
            self._reload = threading.Thread(target=self._reload_all, name="sing-reload", daemon=True)
            self._reload.start()

    def _reload_all(self) -> None:
        t0 = time.monotonic()
        # Every worker asked, also those whose offload timed out: it may have finished after we
        # stopped waiting (a reload of a loaded worker answers "already" at once).
        for url in self.asked:
            try:
                r = self.post(f"{url}/reload", {}, self.reload_timeout_s)
                log.info("reloaded %s (%s ms)", url, r.get("reload_ms"))
            except Exception as e:  # noqa: BLE001
                # The lease is no longer renewed, so it reloads by itself; nothing better from here.
                self.errors.append(f"reload {url}: {e}"[:200])
                log.warning("could not reload %s: %s", url, e)
        self.timings["reload_s"] = round(time.monotonic() - t0, 2)
        self.state = "done"

    def join(self, timeout: float | None = None) -> None:
        t = self._reload
        if t is not None:
            t.join(self.reload_timeout_s if timeout is None else timeout)

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "offloaded": list(self.offloaded), "errors": list(self.errors),
                **self.timings}
