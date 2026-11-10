"""The language model behind the lyrics search: names the real song from a video's title, description, channel.

It uses whatever Core is configured with, so there is nothing new to set up: ``miyoria.toml`` ``[llm]``
(the active profile's ``[llm.purposes]`` first, then the global one), purpose ``fast`` (a short judgement),
else ``chat``; the first ``provider:model`` entry, the provider's ``base_url`` / ``api_key`` (``${VAR}`` /
``${VAR:-default}`` read from the environment and the repo's ``.env``). Any OpenAI-compatible
``/chat/completions`` endpoint works (OpenCode's session header and DeepSeek's thinking switch are sent
the way Core does). The worker can have its own instead:

    SING_LYRICS_LLM_URL / SING_LYRICS_LLM_KEY / SING_LYRICS_LLM_MODEL   (all three: base url, key, model id)
    SING_LYRICS_LLM=0                                                    off
    SING_LYRICS_LLM_TIMEOUT_S (20) · SING_LYRICS_LLM_ATTEMPTS (2, see lyrics.find_lyrics)

The answer is cached per source key (``<cache>/<key>.json``), so asking again for the same song costs
nothing. The key is never logged.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tomllib
from pathlib import Path
from typing import Any, Callable

from lyrics import Query, norm

log = logging.getLogger("miyoria.sing.lyricsllm")

REPO = Path(__file__).resolve().parent.parent.parent

SYSTEM = (
    "You identify songs for a lyrics lookup. You get what a video site shows for a video: its title, "
    "channel, description, tags and length. Say which real song it is: for a cover, an instrumental "
    "arrangement or a lyric video, the ORIGINAL song (title and artist as they are in lyrics databases). "
    "Titles may be Japanese, Chinese, Korean or English; give the title in the song's original language and "
    "script, and other spellings (romaji, translation, simplified/traditional, English title) as alt_titles. "
    "Reply with JSON only: {\"is_song\": bool, \"songs\": [{\"title\": str, \"artist\": str, "
    "\"language\": str, \"alt_titles\": [str], \"confidence\": 0..1}]}, best guess first, at most 3. "
    "If you do not know the song, say so with an empty songs list: never invent a title."
)


def _env_file() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in (REPO / ".env").read_text("utf-8").splitlines():
            m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                out[m.group(1)] = m.group(2).strip("\"'")
    except OSError:
        pass
    return out


def _interpolate(value: Any, env: dict[str, str]) -> Any:
    if not isinstance(value, str):
        return value

    def sub(m: re.Match[str]) -> str:
        name, default = m.group(1), m.group(3)
        return os.environ.get(name) or env.get(name) or (default or "")

    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}", sub, value)


def _read(p: Path) -> dict[str, Any]:
    try:
        return tomllib.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def load_config(repo: Path | None = None) -> dict[str, Any] | None:
    """``{"base_url", "api_key", "model"}`` for the lyrics model, or None when there is none to use."""
    if os.environ.get("SING_LYRICS_LLM", "1") == "0":
        return None
    url, key, model = (os.environ.get(f"SING_LYRICS_LLM_{n}") for n in ("URL", "KEY", "MODEL"))
    if url and model:
        return {"base_url": url.rstrip("/"), "api_key": key or "", "model": model}
    repo = repo or REPO
    cfg = _read(Path(os.environ.get("MIYORIA_CONFIG") or repo / "miyoria.toml"))
    llm = cfg.get("llm") or {}
    profile = (cfg.get("core") or {}).get("profile")
    purposes: dict[str, Any] = {}
    if profile:
        purposes.update(((_read(repo / "profiles" / str(profile) / "profile.toml").get("llm") or {}).get("purposes")) or {})
    for k, v in ((llm.get("purposes")) or {}).items():
        purposes.setdefault(k, v)
    entry = next((purposes[p][0] for p in ("fast", "chat") if purposes.get(p)), None)
    if not entry or ":" not in str(entry):
        return None
    provider, model = str(entry).split(":", 1)
    prov = (llm.get("providers") or {}).get(provider)
    if not prov:
        return None
    env = _env_file()
    base = _interpolate(prov.get("base_url"), env)
    if not base:
        return None
    out: dict[str, Any] = {"base_url": str(base).rstrip("/"),
                           "api_key": str(_interpolate(prov.get("api_key"), env) or ""), "model": model}
    # What Core's openai provider does for these kinds (packages/llm/src/openai/provider.ts): OpenCode
    # Go wants a session header, DeepSeek-family models think unless told not to (slow for a lookup).
    kind = str(prov.get("kind") or "")
    header = prov.get("session_header")
    if header is None and kind == "opencode":
        header = "x-opencode-session"
    if header:
        out["headers"] = {str(header): "miyoria-sing-lyrics"}
    off = prov.get("thinking_off")
    if off is None and kind in ("deepseek", "opencode"):
        off = {"thinking": {"type": "disabled"}}
    if off:
        out["body"] = off
    return out


def chat(cfg: dict[str, Any], messages: list[dict[str, str]], timeout: float) -> str:
    """One chat completion, its text. Raises on any failure. The tests replace this."""
    import httpx

    headers = {"Content-Type": "application/json", **(cfg.get("headers") or {})}
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    r = httpx.post(cfg["base_url"] + "/chat/completions", headers=headers, timeout=timeout,
                   json={"model": cfg["model"], "messages": messages, "temperature": 0, "max_tokens": 1200,
                         "stream": False, **(cfg.get("body") or {})})
    r.raise_for_status()
    return str(r.json()["choices"][0]["message"]["content"] or "")


def parse_songs(text: str) -> list[dict[str, Any]]:
    """The song list out of a reply (which may wrap the JSON in fences or reasoning)."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return []
    if not isinstance(data, dict) or data.get("is_song") is False:
        return []
    out = []
    for s in data.get("songs") or []:
        if isinstance(s, dict) and norm(str(s.get("title") or "")):
            out.append(s)
    return out[:3]


def _prompt(hints: dict[str, Any], tried: list[Query]) -> str:
    info = {
        "title": hints.get("raw_title") or hints.get("title"),
        "channel": hints.get("uploader") or hints.get("channel"),
        "music_metadata": {k: hints[k] for k in ("track", "meta_artist", "alt_title") if hints.get(k)} or None,
        "description": str(hints.get("description") or "")[:900] or None,
        "tags": (hints.get("tags") or [])[:12] or None,
        "duration_s": hints.get("duration"),
    }
    text = json.dumps({k: v for k, v in info.items() if v}, ensure_ascii=False)
    if tried:
        names = "; ".join(f"{q.title} / {q.artist or '?'}" for q in tried[:10])
        text += f"\nThese (title / artist) were looked up and not found, so the real song is probably spelled " \
                f"or credited differently: {names}"
    return text


def make_proposer(cfg: dict[str, Any], cache_dir: Path | None = None, *, timeout: float = 20.0, fresh: bool = False,
                  chat_fn: Callable[..., str] | None = None) -> Callable[[dict[str, Any], list[Query]], list[Query]]:
    """``propose(hints, tried) -> [Query]`` for lyrics.find_lyrics. Call 1 asks cold, call 2 says what failed.

    The first answer is cached per ``hints["key"]`` under ``cache_dir``; a second answer (given what
    failed) is not, since it depends on the sources' state.
    """
    ask = chat_fn or chat

    def propose(hints: dict[str, Any], tried: list[Query]) -> list[Query]:
        ckey = re.sub(r"[^A-Za-z0-9_-]", "_", str(hints.get("key") or ""))[:96]
        path = cache_dir / f"{ckey}.json" if cache_dir and ckey else None
        songs: list[dict[str, Any]] | None = None
        if path is not None and not tried and not fresh:
            try:
                songs = json.loads(path.read_text("utf-8")).get("songs")
            except (OSError, ValueError):
                songs = None
        if songs is None:
            text = ask(cfg, [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(hints, tried)}],
                       timeout)
            songs = parse_songs(text)
            log.info("lyrics llm (%s): %d song(s)", cfg["model"], len(songs))
            if path is not None and not tried:
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({"model": cfg["model"], "songs": songs}, ensure_ascii=False), "utf-8")
                except OSError:
                    pass
        out: list[Query] = []
        for s in songs:
            alts = tuple(str(a) for a in (s.get("alt_titles") or []) if isinstance(a, str) and norm(a))[:4]
            out.append(Query(str(s["title"]).strip(), str(s.get("artist") or "").strip() or None, "llm", alts))
        return out

    return propose
