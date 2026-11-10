"""Which ASR hears her name? The comparison §13.5 of docs/design/v3-architecture.md asks for.

ASR leaves the GPU only if the CPU model still hears "Miyo": on 11-02 SenseVoice did not, and being
called by name is the first rule of who gets her attention. This runs the same real clips through
two running ASR workers and counts, per worker, how many of the clips where somebody says a name
came back with it, raw and after the `asr_aliases` table.

    python compare_names.py <clips> --a http://127.0.0.1:8003 --b http://127.0.0.1:8001 \\
        --names Miyo,Miyoria,米優 --aliases ../../miyoria.toml

<clips> holds WAV files, each with a <name>.txt next to it (`clip_dir` in [modules.voice] writes
them; correct the transcripts by hand, they are the reference). A clip counts when its .txt has one
of the names. The verdict follows the design: switch to B when its recall after aliases is at least
A's raw recall. Only the standard library is needed; run it from any venv.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import tomllib
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

Transcribe = Callable[[bytes], str]


def transcriber(url: str, language: str | None) -> Transcribe:
    """POST /asr of a worker (multipart, the same request Core sends)."""

    def run(wav: bytes) -> str:
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n'
                 "Content-Type: audio/wav\r\n\r\n".encode() + wav + b"\r\n"]
        if language:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n{language}\r\n'.encode())
        body = b"".join(parts) + f"--{boundary}--\r\n".encode()
        request = urllib.request.Request(f"{url.rstrip('/')}/asr", data=body,
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())["text"]

    return run


def load_aliases(path: str | None) -> dict[str, str]:
    """`asr_aliases` of a miyoria.toml's [modules.voice]."""
    if path is None:
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f).get("modules", {}).get("voice", {}).get("asr_aliases", {})


def core(text: str) -> str:
    return re.sub(r"[^\w]", "", text, flags=re.UNICODE).lower()


def apply_aliases(text: str, aliases: dict[str, str]) -> str:
    """What Core's `applyAliases` does, in the same order: longest first, Latin as whole words."""
    out = text
    for heard, said in sorted(aliases.items(), key=lambda kv: -len(kv[0])):
        if re.search(r"[A-Za-z0-9]", heard[0] + heard[-1]):
            out = re.sub(rf"(?<![A-Za-z0-9]){re.escape(heard)}(?![A-Za-z0-9])", lambda _m: said, out, flags=re.IGNORECASE)
        else:
            out = out.replace(heard, said)
    return out


def has_name(text: str, names: list[str]) -> bool:
    heard = core(text)
    return any(core(n) in heard for n in names if core(n))


@dataclass
class Score:
    clips: int = 0
    raw: int = 0
    fixed: int = 0
    seconds: float = 0.0
    misses: list[str] = field(default_factory=list)

    def recall(self, hits: int) -> float:
        return hits / self.clips if self.clips else 0.0


def score(clips: list[tuple[Path, str]], names: list[str], aliases: dict[str, str], run: Transcribe) -> Score:
    s = Score()
    for path, _reference in clips:
        t0 = time.perf_counter()
        text = run(path.read_bytes())
        s.seconds += time.perf_counter() - t0
        s.clips += 1
        s.raw += has_name(text, names)
        if has_name(apply_aliases(text, aliases), names):
            s.fixed += 1
        else:
            s.misses.append(f"{path.name}: {text}")
    return s


def clips_with_names(root: Path, names: list[str]) -> list[tuple[Path, str]]:
    out = []
    for wav in sorted(root.rglob("*.wav")):
        txt = wav.with_suffix(".txt")
        if txt.exists():
            reference = txt.read_text(encoding="utf-8")
            if has_name(reference, names):
                out.append((wav, reference))
    return out


def verdict(a: Score, b: Score) -> str:
    if b.recall(b.fixed) >= a.recall(a.raw):
        return "B hears her name as well as A: it can take over (asr_chain, SING_OFFLOAD_URLS without it)."
    return "B still misses her name more often than A: keep A, or add the misses below to asr_aliases and run again."


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", type=Path)
    ap.add_argument("--a", required=True, help="the worker in use, e.g. http://127.0.0.1:8003")
    ap.add_argument("--b", required=True, help="the candidate, e.g. http://127.0.0.1:8001")
    ap.add_argument("--names", required=True, help="comma separated, as they are written in the .txt files")
    ap.add_argument("--aliases", default=None, help="miyoria.toml with [modules.voice] asr_aliases")
    ap.add_argument("--language", default=None)
    args = ap.parse_args()
    names = [n.strip() for n in args.names.split(",") if n.strip()]
    clips = clips_with_names(args.clips, names)
    if not clips:
        sys.exit(f"no clip in {args.clips} has one of {names} in its .txt")
    aliases = load_aliases(args.aliases)
    a = score(clips, names, aliases, transcriber(args.a, args.language))
    b = score(clips, names, aliases, transcriber(args.b, args.language))
    print(f"{len(clips)} clips with a name, {len(aliases)} aliases\n")
    print("        recall  with aliases  s per clip")
    for label, s in (("A", a), ("B", b)):
        print(f"{label:>6}  {s.recall(s.raw):6.1%}  {s.recall(s.fixed):12.1%}  {s.seconds / s.clips:10.2f}")
    print(f"\n{verdict(a, b)}")
    for label, s in (("A", a), ("B", b)):
        if s.misses:
            print(f"\nmissed by {label}:")
            print("\n".join(f"  {m}" for m in s.misses))


if __name__ == "__main__":
    main()
