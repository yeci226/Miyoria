"""Her RVC model in a process that stays up for a job: started by ``rvcpass.Server`` with Applio's Python,
in Applio's folder (rvcpass.py says why RVC lives in Applio's environment).

A fresh ``core.py infer`` costs about 8 s whatever the length of the clip: Python and torch start, CUDA
starts, every model loads for the first time. Here that happens once. Started with a warm-up (while the
job downloads its song), a conversion of a second of silence loads every model once, so the job's own
conversion takes about a second plus its length (2026-11-13, RTX 5070 Ti: 3 s clip 8.4 s → 1.8 s,
40 s clip 8.8 s → 1.9 s); later conversions in the same process are as quick.

Every request is the argument list of ``core.py infer`` (``rvcpass.command`` without the interpreter and
script), parsed by Applio's own ``infer`` command: the conversion is exactly the subprocess's. Applio
frees its models after every conversion, so between conversions the process holds only its CUDA context.

    argv[1]       JSON: the warm-up's argument list, with "{in}" / "{out}" for its paths (optional)
    stdin         one JSON object per line: {"id": n, "args": [...], "ask"?: true, "ref"?: wav}
    stdout        one JSON object per line: {"ready": true, "ms": n} once, then {"id": n, "ok": bool,
                  "ms": n, "error"?: str} per request; everything Applio prints goes to stderr
    stdin closed  the process ends

``ask``: the worker picks the pitch shift from the song's own pitch (the auto key), and the pipeline's
pitch tracking is the one to read it from: it runs anyway, and running it once more in the worker cost
about 2 s a song (RMVPE loaded there too). Once Applio has the vocal's F0, this sends
``{"id": n, "ask": {"median", "top", "ref_hz"?}}`` (pitch.py's cleaned statistics, without the
pipeline's padding; ``ref_hz`` her reference's median when ``ref`` was given), reads
``{"id": n, "shift": k}`` back and converts with that shift, from the same F0 (``{"cancel": true}``
ends the request instead).
"""

from __future__ import annotations

import gc
import importlib.util
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_ask = None  # the request's question to the worker, while one with ``ask`` runs

# The protocol gets the real stdout; Applio's prints go to stderr.
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(obj: dict) -> None:
    _proto.write(json.dumps(obj) + "\n")
    _proto.flush()


def _pitch_module():
    """The worker's pitch.py, by path (Applio has packages of its own)."""
    spec = importlib.util.spec_from_file_location("miyoria_pitch", os.path.join(HERE, "pitch.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hook_pitch() -> None:
    """Applio's ``Pipeline.get_f0`` asks the worker for the shift (see ``ask``) when a request wants it."""
    import numpy as np
    from rvc.infer.pipeline import Pipeline
    from rvc.lib.utils import load_audio_infer

    pitch = _pitch_module()
    original = Pipeline.get_f0

    def get_f0(self, x, p_len, f0_method="rmvpe", up_key=0, *args, **kwargs):
        ask = _ask
        if ask is None or f0_method != "rmvpe":
            return original(self, x, p_len, f0_method, up_key, *args, **kwargs)
        _, f0 = original(self, x, p_len, f0_method, 0, *args, **kwargs)  # the F0 as tracked, unshifted
        cut = self.t_pad // self.window
        voiced = np.asarray(f0[cut:len(f0) - cut], dtype=np.float64)
        stats = pitch.f0_stats(pitch.clean_f0(voiced))

        def ref_median(path):
            ref = load_audio_infer(path, 16000)
            r = np.asarray(self.f0_models["rmvpe"].get_f0(ref.astype(np.float32), filter_radius=0.03))
            r = r[r > 1]
            return None if r.size < 20 else float(np.exp(np.median(np.log(r))))

        shift = ask(stats, ref_median)
        tracker = self.f0_models["rmvpe"]

        class Known:  # the same F0 again: Applio shifts and quantises it as it always does
            def get_f0(self, *_a, **_k):
                return f0.copy()

        self.f0_models["rmvpe"] = Known()
        try:
            return original(self, x, p_len, f0_method, shift, *args, **kwargs)
        finally:
            self.f0_models["rmvpe"] = tracker

    Pipeline.get_f0 = get_f0


def make_ask(req_id, ref: str | None):
    def ask(stats, ref_median) -> int:
        q = {} if stats is None else {"median": stats[0], "top": stats[1]}
        if ref:
            q["ref_hz"] = ref_median(ref)
        send({"id": req_id, "ask": q})
        while True:
            line = sys.stdin.readline()
            if not line:
                raise RuntimeError("the worker went away")
            msg = json.loads(line)
            if msg.get("id") == req_id:
                break
        if msg.get("cancel"):
            raise RuntimeError("the worker cancelled the conversion")
        return int(msg["shift"])

    return ask


def convert(core, args: list[str]) -> None:
    ctx = core.infer.make_context("infer", list(args))
    out = ctx.params["output_path"]
    if os.path.exists(out):
        os.remove(out)
    core.run_infer_script(**ctx.params)
    if not os.path.isfile(out):
        raise RuntimeError("Applio wrote nothing")


def free() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def warm_up(core, template: list[str]) -> None:
    import numpy as np
    import soundfile as sf

    with tempfile.TemporaryDirectory(prefix="rvc-warm-") as tmp:
        src, dst = os.path.join(tmp, "in.wav"), os.path.join(tmp, "out.wav")
        sf.write(src, np.zeros(16000, dtype="float32"), 16000)
        convert(core, [src if a == "{in}" else dst if a == "{out}" else a for a in template])


def main() -> None:
    t0 = time.perf_counter()
    global _ask
    sys.path.insert(0, os.getcwd())
    import core  # Applio's CLI module (cwd is Applio's folder)

    try:
        hook_pitch()
        hooked = True
    except Exception as e:  # noqa: BLE001 - requests that ask then fail, and the worker asks no more
        print(f"rvcserve: no pitch hook: {type(e).__name__}: {e}", file=sys.stderr)
        hooked = False

    if len(sys.argv) > 1:
        try:
            warm_up(core, json.loads(sys.argv[1]))
        except Exception as e:  # noqa: BLE001 - the real conversion says what is wrong
            print(f"rvcserve: warm-up failed: {type(e).__name__}: {e}", file=sys.stderr)
        free()
    send({"ready": True, "ms": round((time.perf_counter() - t0) * 1000), "ask": hooked})
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t = time.perf_counter()
        try:
            if req.get("ask"):
                if not hooked:
                    raise RuntimeError("no pitch hook in this Applio")
                _ask = make_ask(req.get("id"), req.get("ref"))
            convert(core, req["args"])
            send({"id": req.get("id"), "ok": True, "ms": round((time.perf_counter() - t) * 1000)})
        except BaseException as e:  # noqa: BLE001 - click's SystemExit on bad arguments too
            send({"id": req.get("id"), "ok": False, "ms": round((time.perf_counter() - t) * 1000),
                  "error": f"{type(e).__name__}: {e}"[:300]})
        finally:
            _ask = None
            free()


if __name__ == "__main__":
    main()
