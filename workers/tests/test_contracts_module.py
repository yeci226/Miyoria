"""workers/contracts.py: generated from the JSON Schema, used by the workers, and the check that holds
every answer in these tests to it (response_contract.py)."""

from __future__ import annotations

import contracts
import gen_contracts
import pytest
from response_contract import ContractError, check


def test_contracts_py_is_what_the_schema_gives():
    want, have = gen_contracts.pinned_version(), gen_contracts.installed_version()
    if have != want:
        pytest.skip(f"datamodel-code-generator {want} is not installed here "
                    "(pip install -r requirements-contracts.txt); the CI job installs it")
    assert gen_contracts.OUTPUT.read_text(encoding="utf-8") == gen_contracts.generate(), (
        "contracts.py is not what packages/contracts/schema/workers.json gives: python workers/gen_contracts.py")


def test_the_workers_take_their_bodies_with_the_generated_models():
    import fake_server

    assert fake_server.TtsRequest is contracts.WorkersTtsRequest
    for name in ("asr", "tts", "sing"):
        text = (gen_contracts.HERE / name / "server.py").read_text(encoding="utf-8")
        assert "from contracts import " in text, name
        assert "(BaseModel)" not in text, f"{name}/server.py defines its own pydantic model again"


def test_a_wrong_answer_is_caught():
    from fake_server import app

    check(app, "GET", "/busy", 200, "application/json", b'{"busy": 0, "more": "is fine"}')
    with pytest.raises(ContractError, match="WorkersBusy"):
        check(app, "GET", "/busy", 200, "application/json", b'{"busy": "0"}')
    with pytest.raises(ContractError, match="WorkersBusy"):
        check(app, "GET", "/busy", 200, "application/json", b'{"busy": -1}')
    with pytest.raises(ContractError, match="WorkersError"):
        check(app, "POST", "/tts", 400, "application/json", b'{"detail": "bad"}')
    with pytest.raises(ContractError, match="not JSON"):
        check(app, "POST", "/tts", 500, "text/plain", b"Internal Server Error")
    with pytest.raises(ContractError, match="JSON where the contract has none"):
        check(app, "POST", "/tts", 200, "application/json", b"{}")
    with pytest.raises(ContractError, match="does not know that route"):
        check(app, "GET", "/no-such-route", 200, "application/json", b"{}")
