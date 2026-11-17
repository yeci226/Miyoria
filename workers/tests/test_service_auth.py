"""The bearer token check (service_auth.py): open without a token variable, closed with one, on a
small app and on the fake worker app; HTTP and WebSocket; the headers a worker sends to a neighbour."""

from __future__ import annotations

import importlib.util
import sys

import pytest
from conftest import ROOT
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import service_auth

SERVICE, HOST = "service-token-aaaa", "host-token-bbbb"


@pytest.fixture(autouse=True)
def _no_tokens(monkeypatch):
    monkeypatch.delenv("MIYORIA_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("MIYORIA_HOST_TOKEN", raising=False)


def small_app() -> FastAPI:
    app = FastAPI(title="a small test app")

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/work")
    def work():
        return {"done": True}

    @app.websocket("/vad")
    async def vad(ws: WebSocket):
        await ws.accept()
        await ws.send_text("hello")
        await ws.close()

    return app


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── no variables: nothing changes ────────────────────────────────────────────


def test_without_a_token_variable_install_does_nothing():
    app = small_app()
    assert service_auth.install(app) is False
    assert app.user_middleware == []
    with TestClient(app) as c:
        assert c.get("/health").status_code == 200
        assert c.post("/work").status_code == 200
        with c.websocket_connect("/vad") as ws:
            assert ws.receive_text() == "hello"


def test_empty_variables_count_as_unset(monkeypatch):
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", "")
    monkeypatch.setenv("MIYORIA_HOST_TOKEN", "  ")
    app = small_app()
    assert service_auth.install(app) is False
    with TestClient(app) as c:
        assert c.get("/health").status_code == 200


# ── with a token ─────────────────────────────────────────────────────────────


def protected(monkeypatch, **env: str) -> FastAPI:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    app = small_app()
    assert service_auth.install(app) is True
    return app


def test_every_route_needs_one_of_the_tokens(monkeypatch):
    app = protected(monkeypatch, MIYORIA_SERVICE_TOKEN=SERVICE, MIYORIA_HOST_TOKEN=HOST)
    with TestClient(app) as c:
        for method, path in (("GET", "/health"), ("POST", "/work"), ("GET", "/no-such-route")):
            for headers in ({}, bearer("wrong"), bearer(""), {"Authorization": f"Basic {SERVICE}"},
                            {"Authorization": SERVICE}, bearer(SERVICE[:-1]), bearer(SERVICE + "x")):
                r = c.request(method, path, headers=headers)
                assert r.status_code == 401, (method, path, headers)
                assert r.json() == {"error": "unauthorized"}
                assert r.headers["www-authenticate"] == "Bearer"
                assert r.headers["content-type"] == "application/json"
        for token in (SERVICE, HOST):
            assert c.get("/health", headers=bearer(token)).json() == {"ok": True}
            assert c.post("/work", headers=bearer(token)).status_code == 200
        # The scheme's case does not matter, and a missing route is a 404 for someone with the token.
        assert c.get("/health", headers={"Authorization": f"bearer {SERVICE}"}).status_code == 200
        assert c.get("/no-such-route", headers=bearer(HOST)).status_code == 404


def test_one_variable_is_enough(monkeypatch):
    app = protected(monkeypatch, MIYORIA_HOST_TOKEN=HOST)
    with TestClient(app) as c:
        assert c.get("/health").status_code == 401
        assert c.get("/health", headers=bearer(SERVICE)).status_code == 401
        assert c.get("/health", headers=bearer(HOST)).status_code == 200


def test_the_token_is_compared_in_constant_time(monkeypatch):
    calls = []
    real = service_auth.hmac.compare_digest
    monkeypatch.setattr(service_auth.hmac, "compare_digest", lambda a, b: calls.append((a, b)) or real(a, b))
    app = protected(monkeypatch, MIYORIA_SERVICE_TOKEN=SERVICE, MIYORIA_HOST_TOKEN=HOST)
    with TestClient(app) as c:
        assert c.get("/health", headers=bearer(SERVICE)).status_code == 200
    # Both tokens were compared, so the time does not say which one matched.
    assert len(calls) == 2


def test_a_websocket_is_refused_before_accept_and_accepted_with_a_token(monkeypatch):
    app = protected(monkeypatch, MIYORIA_SERVICE_TOKEN=SERVICE, MIYORIA_HOST_TOKEN=HOST)
    with TestClient(app) as c:
        for headers in ({}, bearer("wrong")):
            with pytest.raises(WebSocketDisconnect):
                with c.websocket_connect("/vad", headers=headers) as ws:
                    ws.receive_text()
        for token in (SERVICE, HOST):
            with c.websocket_connect("/vad", headers=bearer(token)) as ws:
                assert ws.receive_text() == "hello"


# ── what a worker sends to a neighbour ───────────────────────────────────────


def test_peer_headers(monkeypatch):
    assert service_auth.peer_headers() == {}
    monkeypatch.setenv("MIYORIA_SERVICE_TOKEN", SERVICE)  # a service's own token is not the machine's
    assert service_auth.peer_headers() == {}
    monkeypatch.setenv("MIYORIA_HOST_TOKEN", HOST)
    assert service_auth.peer_headers() == {"Authorization": f"Bearer {HOST}"}


def test_the_song_worker_calls_to_its_neighbours_carry_the_host_token(monkeypatch):
    sing = str(ROOT / "sing")
    monkeypatch.syspath_prepend(sing)
    seen: list[dict] = []

    class Reply:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"text": "x", "result": None}

    import httpx

    def record(*_a, **kw):
        seen.append(kw.get("headers") or {})
        return Reply()

    monkeypatch.setattr(httpx, "post", record)
    monkeypatch.setattr(httpx, "get", record)
    import exclusive
    import lyrics
    import lyrics_remote
    import yielding

    def calls() -> list[dict]:
        seen.clear()
        yielding.http_get("http://w/health", 1.0)
        exclusive.http_post("http://w/offload", {}, 1.0)
        lyrics_remote.search_remote("http://l", {}, None)
        lyrics.asr_text(b"wav", "http://a", 1.0)
        return list(seen)

    assert calls() == [{}, {}, {}, {}]
    monkeypatch.setenv("MIYORIA_HOST_TOKEN", HOST)
    assert calls() == [bearer(HOST)] * 4


# ── the fake worker app ──────────────────────────────────────────────────────


def fake_app(monkeypatch, **env: str):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.syspath_prepend(str(ROOT / "fake"))
    spec = importlib.util.spec_from_file_location("fake_server_under_test", ROOT / "fake" / "fake_server.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "fake_server_under_test", module)
    spec.loader.exec_module(module)
    return module.app


def test_the_fake_worker_is_open_without_a_variable_and_closed_with_one(monkeypatch):
    with TestClient(fake_app(monkeypatch)) as c:
        assert c.get("/health").status_code == 200
        assert c.get("/busy").status_code == 200
    with TestClient(fake_app(monkeypatch, MIYORIA_SERVICE_TOKEN=SERVICE, MIYORIA_HOST_TOKEN=HOST)) as c:
        for path in ("/health", "/busy", "/voices"):
            assert c.get(path).status_code == 401
            assert c.get(path, headers=bearer("wrong")).json() == {"error": "unauthorized"}
        assert c.get("/health", headers=bearer(SERVICE)).status_code == 200
        assert c.get("/health", headers=bearer(HOST)).status_code == 200
        assert c.post("/tts", json={"text": "hi"}).status_code == 401
        assert c.post("/tts", json={"text": "hi"}, headers=bearer(HOST)).status_code == 200
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/vad") as ws:
                ws.receive_text()
        with c.websocket_connect("/vad", headers=bearer(SERVICE)) as ws:
            ws.send_bytes(b"\x00\x00" * 512)
            assert ws.receive_text() == "0.020"


def test_a_worker_refuses_to_start_when_the_token_check_cannot_be_imported(monkeypatch):
    # `sys.modules[name] = None` makes `import name` raise ImportError.
    monkeypatch.setitem(sys.modules, "service_auth", None)
    # With no token variable the worker still starts, as a worker run by hand always did.
    assert fake_app(monkeypatch) is not None
    for variable in ("MIYORIA_SERVICE_TOKEN", "MIYORIA_HOST_TOKEN"):
        with pytest.raises(SystemExit) as stopped:
            fake_app(monkeypatch, **{variable: "x"})
        assert "refusing to start" in str(stopped.value)
        monkeypatch.delenv(variable)
