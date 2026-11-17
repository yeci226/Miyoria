"""The bearer token check every worker app installs (docs/design/v5-hostd.md §7).

hostd starts a worker with two secrets in its environment:

``MIYORIA_SERVICE_TOKEN``  this service's own token, which Core and the CLI get from hostd.
``MIYORIA_HOST_TOKEN``     shared by the services of one machine; what a worker sends to a
                           neighbour on the same machine (the song worker asking TTS and ASR).

With either set, every route of the app needs ``Authorization: Bearer <one of them>``, compared in
constant time. The answer to anything else is 401 ``{"error": "unauthorized"}`` with
``WWW-Authenticate: Bearer``; a WebSocket is refused before it is accepted. Nothing is exempt:
``/health`` needs the token too (hostd's probe sends it), and so does a path that does not exist.

With neither set, ``install`` does nothing at all: a worker started by hand behaves as it always did.

The check is an ASGI middleware, so it sees HTTP and WebSocket alike and never reads a body.

Every server imports this module in a way that cannot fail open: when a token variable is set and this
file cannot be imported, the worker exits instead of serving without the check (the ``except ImportError``
block next to each server's import). Only the standard library is used here.
"""

from __future__ import annotations

import hmac
import os

SERVICE_TOKEN_ENV = "MIYORIA_SERVICE_TOKEN"
HOST_TOKEN_ENV = "MIYORIA_HOST_TOKEN"

_UNAUTHORIZED = b'{"error":"unauthorized"}'


def tokens(env: "os._Environ[str] | dict[str, str] | None" = None) -> list[bytes]:
    """The tokens that open this worker now: its own and its machine's, empty ones left out."""
    source = os.environ if env is None else env
    found = [(source.get(name) or "").strip() for name in (SERVICE_TOKEN_ENV, HOST_TOKEN_ENV)]
    return [t.encode("utf-8") for t in found if t]


def peer_headers() -> dict[str, str]:
    """What to send to a neighbour worker on this machine: the machine's token, when there is one."""
    token = (os.environ.get(HOST_TOKEN_ENV) or "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


def _presented(scope: dict) -> bytes | None:
    """The token of the request's ``Authorization: Bearer`` header, ``None`` when there is none."""
    for name, value in scope.get("headers", ()):
        if name == b"authorization":
            scheme, _, rest = value.partition(b" ")
            if scheme.lower() != b"bearer":
                return None
            return rest.strip()
    return None


def _allowed(scope: dict, accepted: list[bytes]) -> bool:
    got = _presented(scope)
    if got is None:
        return False
    # Every accepted token is compared, so the time taken does not say which one matched.
    ok = False
    for token in accepted:
        ok = hmac.compare_digest(got, token) or ok
    return ok


class _RequireToken:
    def __init__(self, app, accepted: list[bytes]) -> None:
        self.app = app
        self.accepted = accepted

    async def __call__(self, scope, receive, send) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket") or _allowed(scope, self.accepted):
            await self.app(scope, receive, send)
            return
        if kind == "websocket":
            # Closing before accept makes the server answer the handshake with 403.
            await receive()
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_UNAUTHORIZED)).encode()),
                (b"www-authenticate", b"Bearer"),
            ],
        })
        await send({"type": "http.response.body", "body": _UNAUTHORIZED})


def install(app) -> bool:
    """Requires the token on every route of ``app`` when the environment has one; ``True`` if it did."""
    accepted = tokens()
    if not accepted:
        return False
    app.add_middleware(_RequireToken, accepted=accepted)
    return True
