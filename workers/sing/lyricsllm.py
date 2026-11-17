"""The language model behind the lyrics search: names the real song from a video's title, description, channel.

Where the completions come from, first match wins:

1. hostd runs this service (``MIYORIA_HOSTD_URL`` and ``MIYORIA_SERVICE_TOKEN`` set, hostd_client.py): the
   completion goes to Core through hostd (``cluster.llm``, purpose ``fast``). Core uses its own model and key,
   counts the call in its budget and writes it to its call log; nothing about the model is set up here.
2. the worker's own model, all of it given explicitly:

    SING_LYRICS_LLM_URL / SING_LYRICS_LLM_KEY / SING_LYRICS_LLM_MODEL   (base url, key, model id; the key
                                                                         may be empty)

   Any OpenAI-compatible ``/chat/completions`` endpoint. It is also used when hostd has no link to Core.
3. none: the lookup works without a language model (lyrics.find_lyrics).

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
from pathlib import Path
from typing import Any, Callable

from lyrics import Query, norm

try:  # workers/hostd_client.py; a worker run by hand has no hostd
    import hostd_client
except ImportError:
    hostd_client = None  # type: ignore[assignment]

log = logging.getLogger("miyoria.sing.lyricsllm")

# What the lyrics lookup asks Core's language model for: a short judgement.
HOSTD_PURPOSE = "fast"

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


def _own_model() -> dict[str, Any] | None:
    """The worker's own model from ``SING_LYRICS_LLM_URL`` / ``_KEY`` / ``_MODEL``, or None."""
    url, key, model = (os.environ.get(f"SING_LYRICS_LLM_{n}") for n in ("URL", "KEY", "MODEL"))
    if url and model:
        return {"base_url": url.rstrip("/"), "api_key": key or "", "model": model}
    return None


def load_config() -> dict[str, Any] | None:
    """How to reach the lookup's model, or None when there is none to use.

    ``{"via": "hostd", "model": "core:fast", "fallback": <own model or None>}`` when hostd runs this
    service, else the worker's own ``{"base_url", "api_key", "model"}``.
    """
    if os.environ.get("SING_LYRICS_LLM", "1") == "0":
        return None
    own = _own_model()
    if hostd_client is not None and hostd_client.available():
        return {"via": "hostd", "model": f"core:{HOSTD_PURPOSE}", "fallback": own}
    return own


def _chat_hostd(messages: list[dict[str, str]], timeout: float) -> str:
    assert hostd_client is not None
    result = hostd_client.call("cluster.llm", {
        "purpose": HOSTD_PURPOSE, "messages": messages, "max_tokens": 1200, "temperature": 0, "json": True,
    }, timeout)
    return str((result or {}).get("text") or "")


def _chat_own(cfg: dict[str, Any], messages: list[dict[str, str]], timeout: float) -> str:
    import httpx

    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    r = httpx.post(cfg["base_url"] + "/chat/completions", headers=headers, timeout=timeout,
                   json={"model": cfg["model"], "messages": messages, "temperature": 0, "max_tokens": 1200,
                         "stream": False})
    r.raise_for_status()
    return str(r.json()["choices"][0]["message"]["content"] or "")


def chat(cfg: dict[str, Any], messages: list[dict[str, str]], timeout: float) -> str:
    """One chat completion, its text. Raises on any failure. The tests replace this.

    Through hostd when ``cfg`` says so; when hostd has no link to Core, the worker's own model if it has one.
    """
    if cfg.get("via") == "hostd":
        try:
            return _chat_hostd(messages, timeout)
        except Exception as e:
            fallback = cfg.get("fallback")
            if fallback and getattr(e, "code", None) == getattr(hostd_client, "NOT_LINKED", None):
                log.info("hostd is not linked to Core; asking the worker's own model")
                return _chat_own(fallback, messages, timeout)
            raise
    return _chat_own(cfg, messages, timeout)


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
