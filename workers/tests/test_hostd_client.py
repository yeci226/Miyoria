"""What a service asks Core for through its hostd (hostd_client.py), and the lyrics lookup's use of it.

A fake hostd (a tiny local HTTP server answering ``POST /rpc``) stands in for the daemon: the language model
(``cluster.llm``) and the ASR spot check (``cluster.fetch``), the fallbacks when hostd is not there or not
linked to Core, the bearer token, and an error from hostd.
"""

from __future__ import annotations

import base64
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sing"))

import hostd_client  # noqa: E402
import lyrics  # noqa: E402
import lyricsllm  # noqa: E402

TOKEN = "service-token-1"


class FakeHostd:
    """Answers ``POST /rpc`` with ``answer(method, params)``: a result, or ``("error", code, message)``.
    Also serves ``POST /v1/chat/completions`` as a worker's own model would."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.answer: Callable[[str, dict[str, Any]], Any] = lambda method, params: {}
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
                fake.calls.append({"path": self.path, "auth": self.headers.get("authorization"), "body": body})
                if self.path == "/v1/chat/completions":
                    out: Any = {"choices": [{"message": {"content": "own model"}}]}
                else:
                    got = fake.answer(body.get("method"), body.get("params") or {})
                    if isinstance(got, tuple) and got[0] == "error":
                        out = {"jsonrpc": "2.0", "id": body.get("id"), "error": {"code": got[1], "message": got[2]}}
                    else:
                        out = {"jsonrpc": "2.0", "id": body.get("id"), "result": got}
                data = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def rpc(self) -> list[dict[str, Any]]:
        return [c for c in self.calls if c["path"] == "/rpc"]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def hostd(monkeypatch):
    for name in ("MIYORIA_HOSTD_URL", "MIYORIA_SERVICE_TOKEN", "SING_LYRICS_LLM", "SING_LYRICS_LLM_URL",
                 "SING_LYRICS_LLM_KEY", "SING_LYRICS_LLM_MODEL", "SING_LYRICS_ASR_URL"):
        monkeypatch.delenv(name, raising=False)
    fake = FakeHostd()
    yield fake
    fake.close()


def run_by(monkeypatch, fake: FakeHostd) -> None:
    """As hostd starts a service: its address and this service's token."""
    monkeypatch.setenv("MIYORIA_HOSTD_URL", fake.url)
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", TOKEN)


# ── the client ───────────────────────────────────────────────────────────────


def test_available_only_with_both_variables(hostd, monkeypatch):
    assert hostd_client.available() is False
    monkeypatch.setenv("MIYORIA_HOSTD_URL", hostd.url)
    assert hostd_client.available() is False
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", " ")
    assert hostd_client.available() is False
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", TOKEN)
    assert hostd_client.available() is True


def test_one_post_with_the_service_token_and_the_result(hostd, monkeypatch):
    run_by(monkeypatch, hostd)
    hostd.answer = lambda method, params: {"echo": [method, params]}
    assert hostd_client.call("cluster.resolve", {"capability": "asr"}) == {
        "echo": ["cluster.resolve", {"capability": "asr"}]}
    [call] = hostd.rpc()
    assert call["auth"] == f"Bearer {TOKEN}"
    assert call["body"]["jsonrpc"] == "2.0" and call["body"]["method"] == "cluster.resolve"


def test_an_error_keeps_its_code_and_message(hostd, monkeypatch):
    run_by(monkeypatch, hostd)
    hostd.answer = lambda method, params: ("error", hostd_client.NOT_ALLOWED, "sing may not fetch tts")
    with pytest.raises(hostd_client.HostdError) as raised:
        hostd_client.call("cluster.fetch", {})
    assert raised.value.code == hostd_client.NOT_ALLOWED and raised.value.message == "sing may not fetch tts"


def test_no_hostd_is_an_error_with_code_zero(hostd, monkeypatch):
    with pytest.raises(hostd_client.HostdError) as raised:
        hostd_client.call("cluster.llm", {})
    assert raised.value.code == 0
    monkeypatch.setenv("MIYORIA_HOSTD_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", TOKEN)
    with pytest.raises(hostd_client.HostdError) as raised:
        hostd_client.call("cluster.llm", {}, timeout=2.0)
    assert raised.value.code == 0 and "unreachable" in raised.value.message


# ── the lyrics lookup's language model ───────────────────────────────────────


def test_completions_go_to_core_through_hostd(hostd, monkeypatch):
    run_by(monkeypatch, hostd)
    hostd.answer = lambda method, params: {"text": json.dumps(
        {"is_song": True, "songs": [{"title": "Real Song", "artist": "Real Artist", "alt_titles": []}]})}
    cfg = lyricsllm.load_config()
    assert cfg is not None and cfg["via"] == "hostd"
    propose = lyricsllm.make_proposer(cfg, None)
    [q] = propose({"title": "a cover", "key": "k"}, [])
    assert (q.title, q.artist, q.how) == ("Real Song", "Real Artist", "llm")
    [call] = hostd.rpc()
    assert call["auth"] == f"Bearer {TOKEN}"
    assert call["body"]["method"] == "cluster.llm"
    params = call["body"]["params"]
    assert params["purpose"] == "fast" and params["json"] is True and params["max_tokens"] == 1200
    assert [m["role"] for m in params["messages"]] == ["system", "user"]
    assert "service" not in params  # hostd adds it; the service cannot name itself


def test_not_linked_falls_back_to_the_workers_own_model_else_fails(hostd, monkeypatch):
    run_by(monkeypatch, hostd)
    hostd.answer = lambda method, params: ("error", hostd_client.NOT_LINKED, "hostd is not linked")
    messages = [{"role": "user", "content": "x"}]
    with pytest.raises(hostd_client.HostdError):
        lyricsllm.chat(lyricsllm.load_config(), messages, 5.0)
    monkeypatch.setenv("SING_LYRICS_LLM_URL", hostd.url + "/v1")
    monkeypatch.setenv("SING_LYRICS_LLM_MODEL", "mine")
    assert lyricsllm.chat(lyricsllm.load_config(), messages, 5.0) == "own model"
    # Any other refusal is not a reason to spend the worker's own key.
    hostd.answer = lambda method, params: ("error", hostd_client.RATE_LIMITED, "slow down")
    with pytest.raises(hostd_client.HostdError):
        lyricsllm.chat(lyricsllm.load_config(), messages, 5.0)


def test_without_hostd_the_explicit_model_or_none(hostd, monkeypatch):
    assert lyricsllm.load_config() is None
    monkeypatch.setenv("SING_LYRICS_LLM_URL", hostd.url + "/v1")
    monkeypatch.setenv("SING_LYRICS_LLM_MODEL", "mine")
    cfg = lyricsllm.load_config()
    assert cfg == {"base_url": hostd.url + "/v1", "api_key": "", "model": "mine"}
    assert lyricsllm.chat(cfg, [{"role": "user", "content": "x"}], 5.0) == "own model"
    assert hostd.rpc() == []


# ── the ASR spot check ───────────────────────────────────────────────────────


def _fetch_answer(status: int, payload: Any) -> dict[str, Any]:
    return {"status": status, "headers": {"content-type": "application/json"},
            "body": base64.b64encode(json.dumps(payload).encode()).decode()}


def test_the_spot_check_goes_through_hostd_as_a_multipart_form(hostd, monkeypatch):
    run_by(monkeypatch, hostd)
    assert lyrics.default_asr_url() == lyrics.HOSTD_ASR
    hostd.answer = lambda method, params: _fetch_answer(200, {"text": "heard it"})
    wav = b"RIFF....WAVEfmt fake clip"
    assert lyrics.asr_text(wav, lyrics.HOSTD_ASR, 5.0) == "heard it"
    [call] = hostd.rpc()
    assert call["auth"] == f"Bearer {TOKEN}"
    params = call["body"]["params"]
    assert (params["method"], params["capability"], params["path"]) == ("POST", "asr", "/asr")
    ctype = params["headers"]["content-type"]
    assert ctype.startswith("multipart/form-data; boundary=")
    boundary = ctype.split("boundary=", 1)[1]
    body = base64.b64decode(params["body"])
    assert body.startswith(f"--{boundary}\r\n".encode()) and body.endswith(f"\r\n--{boundary}--\r\n".encode())
    assert b'name="audio"; filename="clip.wav"' in body and b"Content-Type: audio/wav" in body
    assert wav in body


def test_the_spot_check_through_hostd_has_no_verdict_on_a_refusal_or_a_bad_answer(hostd, monkeypatch):
    run_by(monkeypatch, hostd)
    hostd.answer = lambda method, params: ("error", hostd_client.NOT_ALLOWED, "no")
    assert lyrics.asr_text(b"wav", lyrics.HOSTD_ASR, 5.0) is None
    hostd.answer = lambda method, params: _fetch_answer(503, {"error": "offloaded"})
    assert lyrics.asr_text(b"wav", lyrics.HOSTD_ASR, 5.0) is None


def test_the_spot_check_falls_back_to_an_explicit_url_or_the_local_worker(hostd, monkeypatch):
    direct: list[str] = []
    monkeypatch.setattr(lyrics, "_asr_direct", lambda wav, url, timeout: direct.append(url) or "local")
    # without hostd: the ASR worker of this machine, as before
    assert lyrics.default_asr_url() == lyrics.LOCAL_ASR
    run_by(monkeypatch, hostd)
    # an explicit address wins over hostd; an empty one turns the check off
    monkeypatch.setenv("SING_LYRICS_ASR_URL", "http://10.0.0.5:8003")
    assert lyrics.default_asr_url() == "http://10.0.0.5:8003"
    monkeypatch.setenv("SING_LYRICS_ASR_URL", "")
    assert lyrics.default_asr_url() == ""
    monkeypatch.delenv("SING_LYRICS_ASR_URL")
    # hostd without a link to Core: the local worker
    hostd.answer = lambda method, params: ("error", hostd_client.NOT_LINKED, "not linked")
    assert lyrics.asr_text(b"wav", lyrics.HOSTD_ASR, 5.0) == "local"
    assert direct == [lyrics.LOCAL_ASR]
    assert lyrics.asr_text(b"wav", "http://a", 5.0) == "local" and direct[-1] == "http://a"


def test_search_uses_hostd_for_the_model_and_the_spot_check(hostd, monkeypatch, tmp_path):
    """``lyrics.search`` as the song worker calls it: both come through hostd when nothing else is set."""
    run_by(monkeypatch, hostd)
    seen: dict[str, Any] = {}

    def fake_find(hints, duration, *, llm, asr_url, **_kw):
        seen["asr_url"] = asr_url
        seen["songs"] = llm(hints, []) if llm else None
        return {"found": True}

    monkeypatch.setattr(lyrics, "find_lyrics", fake_find)
    hostd.answer = lambda method, params: {"text": '{"is_song": true, "songs": [{"title": "T", "artist": "A"}]}'}
    assert lyrics.search({"title": "x", "key": "k"}, 120.0, cache_dir=tmp_path) == {"found": True}
    assert seen["asr_url"] == lyrics.HOSTD_ASR
    assert [(q.title, q.artist) for q in seen["songs"]] == [("T", "A")]
    assert [c["body"]["method"] for c in hostd.rpc()] == ["cluster.llm"]
