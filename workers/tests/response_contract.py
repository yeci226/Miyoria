"""Every JSON answer a worker gives in these tests is held to its response model in contracts.py.

conftest.py installs ``check`` on ``TestClient.request`` for the whole session, so each test that
talks to a worker in process (the fake, and the real servers with stubbed models) also checks what
it got: the model of the route for a 2xx, ``WorkersError`` for a 4xx or 5xx. The handlers keep
building dicts; this is what keeps those dicts and the JSON Schema the same. A miss fails the test
it happened in, naming the worker, the route and what does not fit.

Validation is strict (no "3" for a number, no 1.0 for an integer) and extra keys are allowed: the
workers send more than the contract describes, on purpose.
"""

from __future__ import annotations

from typing import Any

import contracts
from pydantic import BaseModel, ValidationError

NOT_JSON = "not JSON"
"""A 2xx that is not JSON: streamed PCM, song files."""

NOT_IN_CONTRACT = "not in the contract"
"""A route the contract does not describe (yet): only checked to answer JSON."""

# (method, route path) -> the model of its 2xx answer, by the worker's FastAPI title. A file route
# maps the file's name (the last part of the path; ``*`` any other) to the model of each file.
ROUTES: dict[str, dict[tuple[str, str], str | dict[str, str]]] = {
    "Miyoria fake worker": {
        ("POST", "/asr"): "WorkersAsrReply",
        ("POST", "/tts"): NOT_JSON,
        ("POST", "/turn"): "WorkersTurnReply",
        ("GET", "/busy"): "WorkersBusy",
        # One fake for three workers: only what every health has in common.
        ("GET", "/health"): "WorkersHealth",
    },
    "Miyoria ASR worker": {
        ("POST", "/asr"): "WorkersAsrReply",
        ("GET", "/busy"): "WorkersBusy",
        ("GET", "/health"): "WorkersAsrHealth",
        ("POST", "/offload"): "WorkersOffloadReply",
        ("POST", "/reload"): "WorkersReloadReply",
    },
    "Miyoria TTS worker": {
        ("POST", "/tts"): NOT_JSON,
        ("GET", "/voices"): "WorkersTtsVoices",
        ("POST", "/voices/reload"): "WorkersTtsVoices",
        ("GET", "/busy"): "WorkersBusy",
        ("POST", "/offload"): "WorkersOffloadReply",
        ("POST", "/reload"): "WorkersReloadReply",
        ("GET", "/health"): "WorkersTtsHealth",
    },
    "Miyoria end-of-turn worker": {
        ("POST", "/turn"): "WorkersTurnReply",
        ("GET", "/health"): "WorkersTurnHealth",
    },
    "miyoria-lyrics": {
        ("POST", "/lyrics"): "WorkersLyricsReply",
        ("GET", "/health"): "WorkersLyricsHealth",
    },
    "Miyoria song worker": {
        ("POST", "/jobs"): "WorkersSingJobReply",
        ("GET", "/jobs"): "WorkersSingJobsReply",
        ("GET", "/jobs/{job_id}"): "WorkersSingJobReply",
        ("POST", "/jobs/{job_id}/exclusive"): "WorkersSingJobReply",
        ("DELETE", "/jobs/{job_id}"): "WorkersSingJobReply",
        ("GET", "/songs"): "WorkersSingSongsReply",
        ("GET", "/songs/{sid}"): "WorkersSingSongReply",
        ("POST", "/songs/{sid}/lyrics"): "WorkersSingLyricsReply",
        ("GET", "/songs/{sid}/files/{name}"): NOT_JSON,
        ("GET", "/karaoke"): NOT_IN_CONTRACT,
        ("GET", "/karaoke/{kid}/files/{name}"): {"reference.json": "WorkersKaraokeReference", "*": NOT_JSON},
        ("POST", "/karaoke/{kid}/keys"): "WorkersKaraokeKeyReply",
        ("POST", "/karaoke/voice"): "WorkersKaraokeVoicePitch",
        ("POST", "/karaoke/stream"): "WorkersKaraokeStreamAnswer",
        ("POST", "/gpu/context"): "WorkersSingOk",
        ("GET", "/cache"): NOT_IN_CONTRACT,
        ("POST", "/cache/prune"): NOT_IN_CONTRACT,
        ("GET", "/library"): "WorkersSingLibrary",
        ("GET", "/health"): "WorkersSingHealth",
    },
}

seen: set[tuple[str, str, str, int]] = set()
"""(worker, method, route, status) of every answer checked in this session."""


class ContractError(AssertionError):
    pass


def _route(app: Any, method: str, path: str) -> str | None:
    for route in getattr(app, "routes", ()):
        regex, methods = getattr(route, "path_regex", None), getattr(route, "methods", None)
        if regex is not None and methods and method in methods and regex.match(path):
            return route.path
    return None


def model_for(worker: str, method: str, route: str | None, status: int, path: str = "") -> type[BaseModel] | str:
    if status >= 400:
        return contracts.WorkersError
    name = ROUTES[worker].get((method, route or ""))
    if isinstance(name, dict):
        name = name.get(path.rsplit("/", 1)[-1], name.get("*"))
    if name is None:
        raise ContractError(f"{worker}: {method} {route} answered {status}, and the contract test does not "
                            f"know that route: add it to tests/response_contract.py")
    return getattr(contracts, name) if name not in (NOT_JSON, NOT_IN_CONTRACT) else name


def check(app: Any, method: str, path: str, status: int, content_type: str, content: bytes) -> None:
    """Raises ``ContractError`` when the answer is not what the contract says."""
    worker = getattr(app, "title", None)
    if worker not in ROUTES:
        return  # not a worker (a test's own small app)
    route = _route(app, method, path)
    is_json = content_type.startswith("application/json")
    want = model_for(worker, method, route, status, path)
    seen.add((worker, method, route or path, status))
    where = f"{worker}: {method} {path} -> {status}"
    if want == NOT_JSON:
        if is_json:
            raise ContractError(f"{where}: JSON where the contract has none")
        return
    if not is_json:
        raise ContractError(f"{where}: not JSON ({content_type or 'no content type'}): {content[:120]!r}")
    if want == NOT_IN_CONTRACT:
        return
    try:
        want.model_validate_json(content, strict=True)
    except ValidationError as e:
        raise ContractError(f"{where} does not fit {want.__name__}:\n{e}\nbody: {content[:600]!r}") from None


def install() -> Any:
    """Wraps ``TestClient.request``; returns the function that undoes it."""
    from starlette.testclient import TestClient

    original = TestClient.request

    def request(self: Any, method: str, url: Any, *args: Any, **kwargs: Any) -> Any:
        response = original(self, method, url, *args, **kwargs)
        check(self.app, response.request.method, response.request.url.path, response.status_code,
              response.headers.get("content-type", ""), response.content)
        return response

    TestClient.request = request  # type: ignore[method-assign]

    def undo() -> None:
        TestClient.request = original  # type: ignore[method-assign]

    return undo
