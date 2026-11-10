"""Design a character voice with Qwen3-TTS VoiceDesign, then pick one candidate as the clone reference.

    # 1. generate N candidates from profiles/<id>/voice.toml [design]
    python design_voice.py generate deepseek-chan --n 8
    #    -> $VOICES_DIR/deepseek-chan-candidates/cand_00_seed1000.wav (+ .txt = sample_text)

    # 2. listen, then adopt one (copies wav -> $VOICES_DIR/deepseek-chan/ref.wav, txt -> ref.txt)
    python design_voice.py pick deepseek-chan 3
    #    (or copy the two files by hand)

    # 3. tell a running worker about it:  curl -X POST http://127.0.0.1:8002/voices/reload

    # emotion voice bank (TTS_VOICE_BANK=1): one clip per language and emotion
    python design_voice.py bank deepseek-chan --n 3
    #    -> $VOICES_DIR/deepseek-chan-candidates/bank/ja/happy/cand_00_seed1000.wav (+ .txt)
    python design_voice.py bank-pick deepseek-chan ja happy 1
    #    -> $VOICES_DIR/deepseek-chan/bank/ja/happy.wav + happy.txt

voice.toml keys used (see profiles/deepseek-chan/voice.toml):
    [design] language, instruct, sample_text
    [design.bank.<language>] emotion = line she says in that clip
    [emotion.instruct] emotion = style added to [design] instruct (bank only)

If all candidates sound the same, sampling is probably deterministic: add
    --gen-kwargs '{"do_sample": true, "temperature": 0.9, "top_p": 0.95}'

Needs the qwen-tts requirements (torch + qwen-tts) and a VoiceDesign checkpoint
(default Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign, ~4-5 GB). Stop the TTS worker first if VRAM is tight.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import random
import shutil
import sys
import time
import tomllib
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_PROFILES = Path(os.environ.get("PROFILES_DIR") or HERE.parents[1] / "profiles")
DEFAULT_VOICES = Path(os.environ.get("VOICES_DIR") or HERE.parent / "voices")
DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"


def utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except AttributeError:
            pass


def load_design(profiles: Path, profile_id: str, args: argparse.Namespace) -> tuple[str, str, str]:
    path = profiles / profile_id / "voice.toml"
    design: dict[str, Any] = {}
    if path.exists():
        with path.open("rb") as f:
            design = tomllib.load(f).get("design", {})
    elif not (args.instruct and args.text):
        sys.exit(f"{path} not found (set --profiles-dir / PROFILES_DIR, or pass --instruct and --text)")
    instruct = (args.instruct or design.get("instruct", "")).strip()
    text = (args.text or design.get("sample_text", "")).strip()
    language = args.language or design.get("language", "Chinese")
    if not instruct or not text:
        sys.exit(f"{path} needs [design] instruct and sample_text (or pass --instruct / --text)")
    return instruct, text, language


def seed_all(seed: int) -> None:
    import numpy as np
    import torch  # type: ignore

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_model(args: argparse.Namespace) -> Any:
    import torch  # type: ignore
    from qwen_tts import Qwen3TTSModel  # type: ignore

    attn = args.attn
    if attn == "auto":
        attn = "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"
    kw: dict[str, Any] = dict(device_map=args.device, dtype=torch.bfloat16)
    if attn != "default":
        kw["attn_implementation"] = attn
    print(f"loading {args.model} (attn={attn}) …")
    return Qwen3TTSModel.from_pretrained(args.model, **kw)


def language_code(language: str) -> str:
    """The folder of a language in the bank: what the TTS worker's language codes call it."""
    codes = {"chinese": "zh", "japanese": "ja", "english": "en", "korean": "ko"}
    return codes.get(language.strip().lower(), language.strip().lower())


def bank_plan(profiles: Path, profile_id: str) -> tuple[str, list[tuple[str, str, str, str]]]:
    """-> ([design] instruct, [(language, emotion, style, line), ...]) from voice.toml."""
    path = profiles / profile_id / "voice.toml"
    if not path.exists():
        sys.exit(f"{path} not found (set --profiles-dir / PROFILES_DIR)")
    with path.open("rb") as f:
        table = tomllib.load(f)
    design = table.get("design", {})
    styles = table.get("emotion", {}).get("instruct", {})
    plan = [(language, emotion, styles.get(emotion, ""), line.strip())
            for language, lines in design.get("bank", {}).items() for emotion, line in lines.items()]
    if not plan:
        sys.exit(f"{path} has no [design.bank.<language>] lines")
    return design.get("instruct", "").strip(), plan


def synth(model: Any, text: str, language: str, instruct: str, gen_kw: dict[str, Any]) -> tuple[Any, int]:
    import numpy as np

    wavs, sr = model.generate_voice_design(text=text, language=language, instruct=instruct, **gen_kw)
    wav = wavs[0]
    if hasattr(wav, "detach"):
        wav = wav.detach().float().cpu().numpy()
    return np.asarray(wav, dtype=np.float32).reshape(-1), int(sr)


def cmd_bank(args: argparse.Namespace) -> None:
    import soundfile as sf

    base, plan = bank_plan(Path(args.profiles_dir), args.profile)
    gen_kw = json.loads(args.gen_kwargs) if args.gen_kwargs else {}
    root = Path(args.voices_dir) / f"{args.profile}-candidates" / "bank"
    model = load_model(args)
    for language, emotion, style, line in plan:
        out = root / language_code(language) / emotion
        out.mkdir(parents=True, exist_ok=True)
        instruct = "\n".join(s for s in (base, style) if s)
        for i in range(args.n):
            # The same seeds for every emotion, so candidate i keeps one timbre across the bank.
            seed = args.seed + i
            seed_all(seed)
            wav, sr = synth(model, line, language, instruct, gen_kw)
            path = out / f"cand_{i:02d}_seed{seed}.wav"
            sf.write(str(path), wav, sr)
            path.with_suffix(".txt").write_text(line, encoding="utf-8")
            print(f"{language_code(language)}/{emotion} [{i + 1}/{args.n}] {len(wav) / sr:5.2f}s  {path.name}")
    print(f"\nCandidates in {root}\nListen, then:  python design_voice.py bank-pick {args.profile} <lang> <emotion> <index>")


def cmd_bank_pick(args: argparse.Namespace) -> None:
    cands = Path(args.voices_dir) / f"{args.profile}-candidates" / "bank" / args.language / args.emotion
    matches = sorted(cands.glob(f"cand_{args.index:02d}_*.wav"))
    if not matches:
        sys.exit(f"no candidate {args.index} in {cands}")
    dst = Path(args.voices_dir) / args.profile / "bank" / args.language
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(matches[0], dst / f"{args.emotion}.wav")
    shutil.copyfile(matches[0].with_suffix(".txt"), dst / f"{args.emotion}.txt")
    print(f"{matches[0].name} -> {dst / args.emotion}.wav (+ .txt)")
    print("Reload a running worker:  curl -X POST http://127.0.0.1:8002/voices/reload   (or restart it)")


def cmd_generate(args: argparse.Namespace) -> None:
    import soundfile as sf

    instruct, text, language = load_design(Path(args.profiles_dir), args.profile, args)
    gen_kw = json.loads(args.gen_kwargs) if args.gen_kwargs else {}
    out = Path(args.voices_dir) / f"{args.profile}-candidates"
    out.mkdir(parents=True, exist_ok=True)
    model = load_model(args)

    print(f"language: {language}\ninstruct: {instruct}\ntext:     {text}\n")
    manifest = []
    for i in range(args.n):
        seed = args.seed + i
        seed_all(seed)
        t0 = time.perf_counter()
        wav, sr = synth(model, text, language, instruct, gen_kw)
        ms = (time.perf_counter() - t0) * 1000
        path = out / f"cand_{i:02d}_seed{seed}.wav"
        sf.write(str(path), wav, sr)
        path.with_suffix(".txt").write_text(text, encoding="utf-8")  # transcript = what the voice says
        manifest.append({"index": i, "seed": seed, "file": path.name, "seconds": round(len(wav) / sr, 2)})
        print(f"[{i + 1}/{args.n}] {ms:6.0f} ms  {len(wav) / sr:5.2f}s  {path.name}")

    (out / "manifest.json").write_text(
        json.dumps({"model": args.model, "language": language, "instruct": instruct, "text": text,
                    "gen_kwargs": gen_kw, "candidates": manifest}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nCandidates in {out}\nListen, then:  python design_voice.py pick {args.profile} <index>")
    print("If they all sound identical, retry with:"
          ' --gen-kwargs \'{"do_sample": true, "temperature": 0.9, "top_p": 0.95}\'')


def cmd_pick(args: argparse.Namespace) -> None:
    cands = Path(args.voices_dir) / f"{args.profile}-candidates"
    matches = sorted(cands.glob(f"cand_{args.index:02d}_*.wav"))
    if not matches:
        sys.exit(f"no candidate {args.index} in {cands}")
    src = matches[0]
    dst = Path(args.voices_dir) / args.profile
    if (dst / "ref.wav").exists() and not args.force:
        sys.exit(f"{dst / 'ref.wav'} exists — pass --force to overwrite")
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst / "ref.wav")
    shutil.copyfile(src.with_suffix(".txt"), dst / "ref.txt")
    print(f"{src.name} -> {dst / 'ref.wav'} (+ ref.txt)")
    print("Reload a running worker:  curl -X POST http://127.0.0.1:8002/voices/reload   (or restart it)")


def main() -> None:
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profiles-dir", default=str(DEFAULT_PROFILES), help="dir containing <id>/voice.toml (env PROFILES_DIR)")
    ap.add_argument("--voices-dir", default=str(DEFAULT_VOICES), help="VOICES_DIR (env VOICES_DIR)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="generate N candidate reference clips")
    g.add_argument("profile", help="profile id, e.g. deepseek-chan")
    g.add_argument("--n", type=int, default=8)
    g.add_argument("--seed", type=int, default=1000, help="first seed; candidate i uses seed+i")
    g.add_argument("--model", default=DEFAULT_MODEL, help="VoiceDesign checkpoint (HF id or local dir)")
    g.add_argument("--device", default="cuda:0")
    g.add_argument("--attn", default="auto", choices=["auto", "flash_attention_2", "sdpa", "eager", "default"])
    g.add_argument("--language", default=None, help="override [design] language")
    g.add_argument("--instruct", default=None, help="override [design] instruct")
    g.add_argument("--text", default=None, help="override [design] sample_text")
    g.add_argument("--gen-kwargs", default=None, help='JSON passed to generate_voice_design, e.g. {"do_sample": true}')
    g.set_defaults(func=cmd_generate)

    p = sub.add_parser("pick", help="adopt candidate N as <voices>/<id>/ref.wav + ref.txt")
    p.add_argument("profile")
    p.add_argument("index", type=int)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_pick)

    b = sub.add_parser("bank", help="generate candidates for every [design.bank.<language>] line")
    b.add_argument("profile", help="profile id, e.g. deepseek-chan")
    b.add_argument("--n", type=int, default=3)
    b.add_argument("--seed", type=int, default=1000, help="first seed; candidate i uses seed+i")
    b.add_argument("--model", default=DEFAULT_MODEL, help="VoiceDesign checkpoint (HF id or local dir)")
    b.add_argument("--device", default="cuda:0")
    b.add_argument("--attn", default="auto", choices=["auto", "flash_attention_2", "sdpa", "eager", "default"])
    b.add_argument("--gen-kwargs", default=None, help='JSON passed to generate_voice_design, e.g. {"do_sample": true}')
    b.set_defaults(func=cmd_bank)

    k = sub.add_parser("bank-pick", help="adopt a candidate as <voices>/<id>/bank/<lang>/<emotion>.wav + .txt")
    k.add_argument("profile")
    k.add_argument("language", help="language folder, e.g. ja")
    k.add_argument("emotion", help="emotion, e.g. happy")
    k.add_argument("index", type=int)
    k.set_defaults(func=cmd_bank_pick)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
