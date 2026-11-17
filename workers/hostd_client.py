"""Calls to this machine's hostd (docs/design/v5-hostd.md §5): what a service asks Core for through it.

hostd starts every service with two variables:

``MIYORIA_HOSTD_URL``      its local API, ``http://127.0.0.1:<port>``
``MIYORIA_SERVICE_TOKEN``  this service's own token, which is how hostd knows who is asking

A service calls a method with one ``POST {MIYORIA_HOSTD_URL}/rpc`` (JSON-RPC 2.0, the token as a bearer
token). hostd passes ``cluster.llm`` (a completion through Core's language model), ``cluster.fetch`` (one
small HTTP request to a capability, such as the ASR spot check) and ``cluster.resolve`` on to Core, adding
the service's name; Core decides what the service may use. The model's key never leaves Core.

A worker started by hand has neither variable: ``available()`` is False and it does what it did before.
Standard library plus ``httpx``.
"""

from __future__ import annotations

import itertools
import os
from typing import Any

HOSTD_URL_ENV = "MIYORIA_HOSTD_URL"
SERVICE_TOKEN_ENV = "MIYORIA_SERVICE_TOKEN"

# The JSON-RPC codes hostd and Core answer with (packages/contracts/host/src/protocol.ts HOST_ERROR_CODE).
NOT_ALLOWED = -32014
NOT_LINKED = -32015
UNAVAILABLE = -32016
TOO_LARGE = -32017
RATE_LIMITED = -32018

_ids = itertools.count(1)


class HostdError(Exception):
    """A call that failed: the JSON-RPC ``code`` and ``message`` (code 0 when hostd could not be reached
    or did not answer with JSON-RPC)."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{message} ({code})")
        self.code = code
        self.message = message
        self.data = data


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def available() -> bool:
    """Whether hostd runs this service: both its address and this service's token are set."""
    return bool(_env(HOSTD_URL_ENV) and _env(SERVICE_TOKEN_ENV))


def call(method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
    """One method of hostd's local API; its result, or ``HostdError``."""
    import httpx

    url, token = _env(HOSTD_URL_ENV).rstrip("/"), _env(SERVICE_TOKEN_ENV)
    if not url or not token:
        raise HostdError(0, "hostd does not run this service (MIYORIA_HOSTD_URL / MIYORIA_SERVICE_TOKEN unset)")
    request = {"jsonrpc": "2.0", "id": next(_ids), "method": method, "params": params or {}}
    try:
        r = httpx.post(url + "/rpc", json=request, timeout=timeout,
                       headers={"Authorization": f"Bearer {token}"})
    except Exception as e:  # noqa: BLE001 - every transport failure is the same to the caller
        raise HostdError(0, f"hostd unreachable at {url}: {e}") from e
    try:
        body = r.json()
    except ValueError as e:
        raise HostdError(0, f"hostd answered HTTP {r.status_code} without JSON") from e
    if not isinstance(body, dict):
        raise HostdError(0, "hostd answered something that is not JSON-RPC")
    error = body.get("error")
    if isinstance(error, dict):
        code = error.get("code")
        raise HostdError(code if isinstance(code, int) else 0, str(error.get("message") or "error"),
                         error.get("data"))
    if "result" not in body:
        raise HostdError(0, f"hostd answered HTTP {r.status_code} without a result")
    return body["result"]
