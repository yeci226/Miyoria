"""An RVC pass over the converted vocal: her own RVC model re-sings what YingMusic / Seed-VC made.

Why: RVC trained on her voice sounds steadier and more like her, but it cannot read the words of
someone else's singing (ContentVec loses Japanese singing, and her model only ever heard speech).
Given a vocal that is already her voice with the words in place, it keeps them (on her own speech
it loses almost nothing), so the chain "YingMusic, then RVC" gets YingMusic's words and RVC's voice
(2026-11-09 tests: docs/design/backlog.md, 唱歌轉換).

RVC runs in Applio's own environment (its venv, ``core.py infer``) as a subprocess: its torch and
dependencies differ from this worker's. After YingMusic / Seed-VC the pitch is not moved (the vocal
is already in key); alone (SING_VOICE=rvc) it moves the song's lead by the job's shift. Retrieval is off (``index_rate 0``: the index holds speech, which blurs the words).

Conversions go through one Applio process (rvcserve.py) instead of a fresh ``core.py infer`` each, which
costs about 8 s of start-up whatever the clip's length. A job that downloads its song starts that process
with the download (``warm``), and it warms up (a second of silence through every model) while the
network works; otherwise it starts when the conversion needs it, without the warm-up, which costs what a
fresh ``core.py infer`` did. It stays up while more songs are queued (a set list converts each with a
warm process) and ends after the last (``stop``), unless SING_KEEP_MODELS=1. Any trouble with it falls
back to a fresh ``core.py infer``.

Environment: ``SING_APPLIO_DIR`` (default ``../models/applio``), ``SING_RVC_MODEL`` (the ``.pth``),
``SING_RVC_INDEX`` (default the ``.index`` beside the model, optional), ``SING_RVC_PROTECT``
(default 0.33), ``SING_RVC_TIMEOUT_S`` (default 600), ``SING_RVC_SERVER`` (0 = a fresh ``core.py infer``
for every conversion, as before; default 1).
"""

from __future__ import annotations

import collections
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

log = logging.getLogger("miyoria.sing.rvc")

HERE = Path(__file__).resolve().parent
DEFAULT_APPLIO = HERE.parent / "models" / "applio"
DEFAULT_MODEL = "logs/miyoria-deepseek-48k/miyoria-deepseek-48k_40e_11000s.pth"


def applio_dir(env: Mapping[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_APPLIO_DIR") or DEFAULT_APPLIO)


def model_path(env: Mapping[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_RVC_MODEL") or applio_dir(e) / DEFAULT_MODEL)


def index_path(env: Mapping[str, str] | None = None) -> Path | None:
    e = env if env is not None else os.environ
    if e.get("SING_RVC_INDEX"):
        return Path(e["SING_RVC_INDEX"])
    found = sorted(model_path(e).parent.glob("*.index"))
    return found[0] if found else None


def python_path(env: Mapping[str, str] | None = None) -> Path:
    root = applio_dir(env)
    for p in (root / "venv" / "Scripts" / "python.exe", root / "venv" / "bin" / "python"):
        if p.exists():
            return p
    return root / "venv" / "Scripts" / "python.exe"


def available(env: Mapping[str, str] | None = None) -> bool:
    """Applio's CLI, its Python and the model are all there."""
    root = applio_dir(env)
    return (root / "core.py").is_file() and python_path(env).is_file() and model_path(env).is_file()


def command(in_wav: Path, out_wav: Path, env: Mapping[str, str] | None = None, pitch: int = 0) -> list[str]:
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


def _child_env(root: Path) -> dict[str, str]:
    child_env = {**os.environ, "APPLIO_CONFIG_FILE": str(root / "assets" / "config.json")}
    child_env.pop("APPLIO_F0_FILE", None)  # the local test hook: never from here
    return child_env


def _timeout(e: Mapping[str, str]) -> float:
    return float(e.get("SING_RVC_TIMEOUT_S", "600"))


def server_on(env: Mapping[str, str] | None = None) -> bool:
    e = env if env is not None else os.environ
    return e.get("SING_RVC_SERVER", "1") != "0"


class Asked(RuntimeError):
    """The conversion failed after the shift was picked: the caller converts again with that shift."""


class CannotAsk(RuntimeError):
    """This Applio has no pitch hook (rvcserve.hook_pitch): its process is fine for conversions with a
    given shift, so it stays up, and the worker picks the shift itself from then on."""


class Server:
    """One rvcserve.py process: started early, used for every conversion until ``stop``."""

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.env = dict(os.environ if env is None else env)
        self.root = applio_dir(self.env).resolve()
        self._proc: subprocess.Popen[str] | None = None
        self._out: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._err: collections.deque[str] = collections.deque(maxlen=40)
        self._ready = threading.Event()  # warmed up, or ended (then ``alive`` is false)
        self._lock = threading.Lock()  # one conversion at a time
        self._next = 0
        self.ready_ms: int | None = None
        self.can_ask = False  # its Applio has the pitch hook (rvcserve.hook_pitch)

    def _args(self, in_wav: str, out_wav: str, pitch: int) -> list[str]:
        """``core.py infer``'s arguments (``command`` without the interpreter and script)."""
        cmd = command(Path("in.wav"), Path("out.wav"), self.env, pitch)
        args = cmd[cmd.index("infer") + 1:]
        args[args.index("--input-path") + 1] = in_wav
        args[args.index("--output-path") + 1] = out_wav
        return args

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, warm_up: bool = True) -> None:
        """Starts the process (``warm_up``: it converts a second of silence first, which loads every model
        once, so the next conversion is quick); returns at once."""
        if self.alive():
            return
        self._out = queue.Queue()
        self._ready = threading.Event()
        extra = [json.dumps(self._args("{in}", "{out}", 0))] if warm_up else []
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        proc = subprocess.Popen(
            [str(python_path(self.env).resolve()), str(HERE / "rvcserve.py"), *extra], cwd=str(self.root),
            env=_child_env(self.root), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags)
        self._proc = proc
        threading.Thread(target=self._read_out, args=(proc, self._out, self._ready), name="rvc-out",
                         daemon=True).start()
        threading.Thread(target=self._read_err, args=(proc,), name="rvc-err", daemon=True).start()

    def _read_out(self, proc: subprocess.Popen[str], out: queue.Queue[dict[str, Any] | None],
                  ready: threading.Event) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("ready"):
                self.ready_ms = msg.get("ms")
                self.can_ask = bool(msg.get("ask"))
                log.info("RVC process ready in %s ms", self.ready_ms)
                ready.set()
            else:
                out.put(msg)
        out.put(None)  # the process ended
        ready.set()

    def warming(self) -> bool:
        return self.alive() and not self._ready.is_set()

    def wait_ready(self, timeout: float) -> bool:
        """Until the warm-up is over (or the process ended); whether it is up and ready."""
        self._ready.wait(max(0.0, timeout))
        return self._ready.is_set() and self.alive()

    def _read_err(self, proc: subprocess.Popen[str]) -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip():
                self._err.append(line.rstrip())

    def _tail(self) -> str:
        return " | ".join(list(self._err)[-3:])[:300]

    def _get(self, deadline: float) -> dict[str, Any]:
        try:
            msg = self._out.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError("RVC process timed out") from None
        if msg is None:
            raise RuntimeError(f"RVC process ended: {self._tail()}")
        return msg

    def run(self, in_wav: Path, out_wav: Path, pitch: int = 0,
            choose: Callable[[dict[str, Any]], int] | None = None, ref: Path | None = None) -> Path:
        """``choose``: the shift is picked from the vocal's pitch as Applio tracks it (``choose`` gets
        ``{median, top, ref_hz?}`` and returns the shift; ``ref``: her reference, for ``ref_hz``);
        ``pitch`` is then not used. Raises ``RuntimeError`` (``Asked`` once ``choose`` was answered)."""
        with self._lock:
            self.start(warm_up=False)
            deadline = time.monotonic() + _timeout(self.env)
            if not self.wait_ready(deadline - time.monotonic()):
                raise RuntimeError(f"RVC process not ready: {self._tail() or 'timed out'}")
            if choose is not None and not self.can_ask:
                raise CannotAsk("this Applio cannot be asked for the pitch")
            self._next += 1
            req: dict[str, Any] = {"id": self._next,
                                   "args": self._args(str(Path(in_wav).resolve()), str(Path(out_wav).resolve()), pitch)}
            if choose is not None:
                req["ask"] = True
                if ref is not None:
                    req["ref"] = str(Path(ref).resolve())
            proc = self._proc
            assert proc is not None and proc.stdin is not None
            proc.stdin.write(json.dumps(req) + "\n")
            proc.stdin.flush()
            answered = False
            while True:
                try:
                    msg = self._get(deadline)
                except RuntimeError as e:
                    raise (Asked(str(e)) if answered else e) from None
                if msg.get("id") != req["id"]:
                    continue
                if "ask" in msg and choose is not None:
                    try:
                        reply: dict[str, Any] = {"id": req["id"], "shift": int(choose(msg["ask"]))}
                    except Exception:
                        proc.stdin.write(json.dumps({"id": req["id"], "cancel": True}) + "\n")
                        proc.stdin.flush()
                        raise
                    proc.stdin.write(json.dumps(reply) + "\n")
                    proc.stdin.flush()
                    answered = True
                    continue
                break
        if not msg.get("ok") or not Path(out_wav).is_file():
            err = f"RVC pass failed: {msg.get('error') or self._tail()}"
            raise Asked(err) if answered else RuntimeError(err)
        log.info("RVC conversion in %s ms (warm process)", msg.get("ms"))
        return out_wav

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
            proc.wait(5)
        except Exception:  # noqa: BLE001
            proc.kill()


_server: Server | None = None
_server_lock = threading.Lock()
_cannot_ask = False  # a process said it has no pitch hook: run_choosing is not tried again


def warm(env: Mapping[str, str] | None = None, warm_up: bool = True) -> None:
    """Gets the RVC process going for the conversion to come (nothing when it is up, off, or not installed)."""
    global _server
    if not server_on(env) or not available(env):
        return
    with _server_lock:
        if _server is None:
            _server = Server(env)
        try:
            _server.start(warm_up)
        except Exception as e:  # noqa: BLE001 - the conversion falls back to a fresh process
            log.warning("could not start the RVC process: %s", e)
            _server = None


def wait_warm(timeout: float) -> None:
    """Lets a warm-up under way end first (at most ``timeout``), so the next GPU stage does not run next to
    it: what that stage takes of the card is measured, and would count the warm-up too."""
    srv = _server
    if srv is not None and srv.warming():
        t0 = time.monotonic()
        srv.wait_ready(timeout)
        log.info("waited %.1f s for the RVC warm-up", time.monotonic() - t0)


def stop() -> None:
    """Ends the RVC process (its CUDA context goes with it)."""
    global _server
    with _server_lock:
        srv, _server = _server, None
    if srv is not None:
        srv.stop()


def run(in_wav: Path, out_wav: Path, env: Mapping[str, str] | None = None, pitch: int = 0) -> Path:
    """Converts ``in_wav`` into ``out_wav`` (Applio writes it at the model's rate): through the warm
    process when it can, else with a fresh ``core.py infer``. Raises ``RuntimeError`` when Applio
    fails or writes nothing."""
    if env is None and server_on():
        warm(warm_up=False)  # already up (warmed with the download), or started now
        srv = _server
        if srv is not None:
            try:
                return srv.run(in_wav, out_wav, pitch)
            except Exception as e:  # noqa: BLE001
                log.warning("RVC process failed (%s); converting with a fresh one", e)
                stop()
    return run_once(in_wav, out_wav, env, pitch)


def run_choosing(in_wav: Path, out_wav: Path, choose: Callable[[dict[str, Any]], int],
                 ref: Path | None = None) -> Path:
    """``in_wav`` into ``out_wav`` with the shift ``choose`` picks from the vocal's pitch as Applio tracks
    it (``Server.run``), through the warm process. Raises when that cannot be done: before ``choose``
    was asked, ``RuntimeError`` (the caller picks the shift itself; ``CannotAsk`` when this Applio has
    no pitch hook, and the warm process stays up for that conversion); after, ``Asked``."""
    global _cannot_ask
    if not server_on():
        raise RuntimeError("SING_RVC_SERVER=0")
    if _cannot_ask:
        raise CannotAsk("this Applio cannot be asked for the pitch")
    warm(warm_up=False)
    srv = _server
    if srv is None:
        raise RuntimeError("no RVC process")
    try:
        return srv.run(in_wav, out_wav, choose=choose, ref=ref)
    except CannotAsk:
        _cannot_ask = True
        raise
    except Exception:
        stop()
        raise


def run_once(in_wav: Path, out_wav: Path, env: Mapping[str, str] | None = None, pitch: int = 0) -> Path:
    """A fresh ``core.py infer`` for this one conversion."""
    e = dict(os.environ if env is None else env)
    root = applio_dir(e).resolve()
    out_wav.unlink(missing_ok=True)
    try:
        r = subprocess.run(command(in_wav, out_wav, e, pitch), cwd=str(root), env=_child_env(root), capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=_timeout(e))
    except subprocess.TimeoutExpired as err:
        raise RuntimeError("RVC pass timed out") from err
    if r.returncode != 0 or not out_wav.is_file():
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        raise RuntimeError(f"RVC pass failed ({r.returncode}): {' | '.join(tail)[:300]}")
    return out_wav
