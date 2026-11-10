"""A model in a process of its own, so that dropping it really gives the GPU back.

Dropping a model inside a running process does not return its VRAM reliably. On 2026-11-07 a TTS
worker that had "offloaded" (``memory_allocated`` 4360 -> 88 MB) still held 4.4 GB of the card, and
only killing the process returned it: conversion next to it spilled at 6 s per step. What a process
that ends gives back is not up to Python, PyTorch or any library: it is everything, CUDA context
included.

So the HTTP worker never touches CUDA. It starts the model in a child, talks to it over a pipe, and
stays up on its port the whole time, which keeps ``/health``, ``/busy``, the 503 ``offloaded`` and
``/reload`` working with no supervisor around it. To offload is to kill the child. That takes no
time and cannot hang, also while the child is still loading.

    parent                                       child
    EngineProcess(server.py, "make_engine") -->  loads server.py, calls the factory
    wait_ready()                            <--  ("ready", describe(target))
    call(name, ...)                         -->  target.name(...)      ("value", result)
    stream(name, ...)                       -->  target.name(...)      ("item", x)* ("end", None)
    closing the generator early             -->  ("cancel",)
    kill()                                       ends; a waiting ``recv`` in the parent raises ``EngineGone``

One request at a time. Whatever travels over the pipe has to pickle, and to mean something in the
other process: numbers, strings, numpy arrays, not CUDA tensors. A child whose parent went away
notices at its next read or write and exits, so it does not stay behind holding the card.
"""

from __future__ import annotations

import importlib.util
import logging
import multiprocessing
import os
import sys
import threading
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger("miyoria.engine_process")

HOST_MODULE = "engine_host"


class EngineGone(Exception):
    """The child ended: it was killed for an offload, or it crashed."""


class RemoteError(Exception):
    """The child raised something. ``status`` is the HTTP status when it was an API error."""

    def __init__(self, kind: str, message: str, status: int | None = None) -> None:
        super().__init__(f"{kind}: {message}")
        self.kind, self.message, self.status = kind, message, status


def _failure(e: BaseException) -> tuple[str, str, str, int | None]:
    status = getattr(e, "status", None)
    return "error", type(e).__name__, str(e)[:500], status if isinstance(status, int) else None


def _serve(conn: Any, server_path: str, factory: str, describe: str | None) -> None:
    """The child: builds the target, then answers until the parent goes away."""
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        spec = importlib.util.spec_from_file_location(HOST_MODULE, server_path)
        assert spec and spec.loader
        host = importlib.util.module_from_spec(spec)
        sys.modules[HOST_MODULE] = host
        spec.loader.exec_module(host)
        target = getattr(host, factory)()
        conn.send(("ready", getattr(host, describe)(target) if describe else None))
    except BaseException as e:  # noqa: BLE001 - the parent has to hear why, and then the child is done
        log.exception("the engine did not start")
        conn.send(_failure(e))
        return
    try:
        while True:
            op, name, args, kwargs = conn.recv()
            try:
                if op == "call":
                    conn.send(("value", getattr(target, name)(*args, **kwargs)))
                    continue
                gen = getattr(target, name)(*args, **kwargs)
                for item in gen:
                    conn.send(("item", item))
                    if conn.poll():  # ("cancel",): nothing else arrives while a stream runs
                        conn.recv()
                        gen.close()
                        break
                conn.send(("end", None))
            except (BrokenPipeError, EOFError, ConnectionError):
                raise
            except Exception as e:  # noqa: BLE001 - one failed request, not a dead engine
                conn.send(_failure(e))
    except (BrokenPipeError, EOFError, ConnectionError, OSError):
        os._exit(0)  # the parent is gone: this process must not keep the card


class EngineProcess:
    def __init__(self, server_file: str | Path, factory: str, describe: str | None = None) -> None:
        ctx = multiprocessing.get_context("spawn")  # never fork: CUDA, and Windows has nothing else
        self._conn, child = ctx.Pipe()
        self._proc = ctx.Process(target=_serve, args=(child, str(server_file), factory, describe),
                                 name=f"engine-{factory}", daemon=True)
        self._lock = threading.Lock()
        self._proc.start()
        child.close()

    @property
    def pid(self) -> int | None:
        return self._proc.pid

    def alive(self) -> bool:
        return self._proc.is_alive()

    def _recv(self) -> tuple[Any, ...]:
        """Watches the process as well as the pipe. On Windows a child picks up its end of the pipe
        from a handle this process holds for it, so one killed before it got that far (an offload
        during a reload) leaves the pipe open to nobody, and no end-of-file ever comes."""
        try:
            while not self._conn.poll(0.2):
                if not self._proc.is_alive() and not self._conn.poll(0):
                    raise EOFError
            return self._conn.recv()
        except (EOFError, OSError) as e:
            self._proc.join(1)  # the pipe breaks a moment before the process counts as ended
            raise EngineGone(f"the engine process ended ({self._proc.exitcode})") from e

    def _send(self, message: tuple[Any, ...]) -> None:
        try:
            self._conn.send(message)
        except (OSError, ValueError) as e:
            raise EngineGone("the engine process ended") from e

    @staticmethod
    def _raise(message: tuple[Any, ...]) -> None:
        raise RemoteError(message[1], message[2], message[3])

    def wait_ready(self) -> Any:
        """What ``describe`` said once the model is up. Blocks for as long as loading takes."""
        message = self._recv()
        if message[0] != "ready":
            self._raise(message)
        return message[1]

    def call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            self._send(("call", name, args, kwargs))
            message = self._recv()
        if message[0] != "value":
            self._raise(message)
        return message[1]

    def stream(self, name: str, *args: Any, **kwargs: Any) -> Iterator[Any]:
        """Holds the pipe until it ends or is closed: the caller serialises streams anyway."""
        with self._lock:
            self._send(("stream", name, args, kwargs))
            done = False
            try:
                while True:
                    message = self._recv()
                    if message[0] == "item":
                        yield message[1]
                        continue
                    done = True
                    if message[0] == "end":
                        return
                    self._raise(message)
            except EngineGone:
                done = True
                raise
            finally:
                if not done:  # closed early: the child stops at its next item
                    self._cancel()

    def _cancel(self) -> None:
        try:
            self._send(("cancel",))
            while self._recv()[0] == "item":
                pass
        except EngineGone:
            pass

    def kill(self) -> None:
        """At once: nothing in the child gets a say. A ``recv`` waiting in another thread raises
        ``EngineGone``."""
        self._proc.kill()
        self._proc.join(5)
