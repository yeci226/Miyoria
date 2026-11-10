"""Calibrates Smart Turn on your own clips: from which probability is a turn really over?

The published accuracy for Chinese (88.57 %) is the author's and its test set probably has no Taiwan
Mandarin, so the threshold comes from real clips.

    python calibrate.py <dir>            # WAV clips in <dir>/complete/ and <dir>/incomplete/

`complete` = the person had finished, `incomplete` = they went on. With `clip_dir` set in
[modules.voice], Core sorts clips by itself into <clip_dir>/turn/ended/ and <clip_dir>/turn/resumed/
(`--complete ended --incomplete resumed`); listen through them before trusting those labels.

Prints, per threshold, how many finished turns are caught and how many unfinished ones would have
been cut off. Set the result as TURN_THRESHOLD on the worker. Needs the model file, not a running
worker.
"""

from __future__ import annotations

import argparse
import os
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import SAMPLE_RATE  # noqa: E402

HERE = Path(__file__).resolve().parent


def read_wav(path: Path) -> np.ndarray:
    """PCM s16 WAV of any rate and channel count -> mono float at 16 kHz."""
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path}: only 16-bit WAV")
        channels, rate = w.getnchannels(), w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        n = int(len(x) * SAMPLE_RATE / rate)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


def table(complete: list[float], incomplete: list[float]) -> list[tuple[float, float, float]]:
    """(threshold, share of finished turns caught, share of unfinished turns cut off)."""
    rows = []
    for t in np.arange(0.3, 0.91, 0.05):
        caught = sum(p >= t for p in complete) / max(len(complete), 1)
        cut = sum(p >= t for p in incomplete) / max(len(incomplete), 1)
        rows.append((round(float(t), 2), caught, cut))
    return rows


def recommend(rows: list[tuple[float, float, float]], max_cut: float) -> float | None:
    """The lowest threshold that cuts off at most ``max_cut``: she answers as early as that allows."""
    fitting = [t for t, _, cut in rows if cut <= max_cut]
    return min(fitting) if fitting else None


def main() -> None:
    from models import SmartTurn

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", type=Path)
    ap.add_argument("--complete", default="complete", help="folder of finished turns")
    ap.add_argument("--incomplete", default="incomplete", help="folder of unfinished turns")
    ap.add_argument("--model", default=os.environ.get(
        "TURN_SMART_MODEL", str(HERE.parent / "models/smart-turn/smart-turn-v3.2-cpu.onnx")))
    ap.add_argument("--max-cut", type=float, default=0.1, help="share of unfinished turns you accept cutting off")
    args = ap.parse_args()
    model = SmartTurn(Path(args.model))
    scores: dict[str, list[float]] = {}
    for name in (args.complete, args.incomplete):
        files = sorted((args.dir / name).glob("*.wav"))
        if not files:
            sys.exit(f"no WAV clips in {args.dir / name}")
        scores[name] = [model.probability(read_wav(f)) for f in files]
        print(f"{name}: {len(files)} clips")
    rows = table(scores[args.complete], scores[args.incomplete])
    print("\nthreshold  finished caught  unfinished cut off")
    for t, caught, cut in rows:
        print(f"{t:9.2f}  {caught:15.1%}  {cut:18.1%}")
    best = recommend(rows, args.max_cut)
    print(f"\nTURN_THRESHOLD={best}" if best is not None else f"\nno threshold cuts off at most {args.max_cut:.0%}")


if __name__ == "__main__":
    main()
