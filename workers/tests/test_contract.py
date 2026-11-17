"""HTTP contract of docs/protocols/voice-link.md (推論 Worker HTTP 介面)."""

from __future__ import annotations

import re
import struct

import pytest
from conftest import NO_BODY, make_wav, pcm_to_wav, send

TEXT = "哼,你終於來了喔?我才、才沒有在等你呢。好啦,今天要做什麼?"


# ── /health ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("which", ["asr_client", "tts_client"])
def test_health(which, request):
    r = request.getfixturevalue(which).get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert isinstance(body["model"], str) and body["model"]
    assert isinstance(body["device"], str) and body["device"]


# ── /asr ─────────────────────────────────────────────────────────────────────


def _asr(client, wav: bytes, **form):
    return client.post("/asr", files={"audio": ("a.wav", wav, "audio/wav")}, data=form)


def test_asr_response_fields(asr_client):
    r = _asr(asr_client, make_wav(0.5, 16_000))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    body = r.json()
    assert isinstance(body["text"], str)
    assert isinstance(body.get("language", ""), str)  # optional: omitted when the model cannot tell
    assert isinstance(body["duration_ms"], int)
    assert abs(body["duration_ms"] - 500) <= 2
    # optional fields, when present, have the documented types
    if "emotion" in body:
        assert isinstance(body["emotion"], str)
    if "audio_events" in body:
        assert isinstance(body["audio_events"], list)
        assert all(isinstance(e, str) for e in body["audio_events"])


@pytest.mark.parametrize("rate,channels,seconds", [(48_000, 2, 1.0), (8_000, 1, 0.25), (44_100, 1, 0.5)])
def test_asr_accepts_any_rate_and_channels(asr_client, rate, channels, seconds):
    r = _asr(asr_client, make_wav(seconds, rate, channels))
    assert r.status_code == 200
    assert abs(r.json()["duration_ms"] - seconds * 1000) <= 2


def test_asr_optional_form_fields(asr_client):
    r = _asr(asr_client, make_wav(), language="zh", prompt="Miyoria, DeepSeek-chan")
    assert r.status_code == 200


def test_asr_fake_canned_text(asr_client, asr_is_fake, monkeypatch):
    if not asr_is_fake:
        pytest.skip("fake-only")
    monkeypatch.setenv("FAKE_ASR_TEXT", "測試文字")
    r = _asr(asr_client, make_wav(), language="zh-TW")
    assert r.json()["text"] == "測試文字"
    assert r.json()["language"] == "zh"


def test_asr_rejects_garbage(asr_client):
    r = asr_client.post("/asr", files={"audio": ("a.wav", b"this is not a wav file", "audio/wav")})
    assert 400 <= r.status_code < 500
    assert isinstance(r.json()["error"], str)


def test_asr_missing_audio_field(asr_client):
    r = asr_client.post("/asr", data={"language": "zh"})
    assert 400 <= r.status_code < 500
    assert "error" in r.json()


# ── /tts ─────────────────────────────────────────────────────────────────────


def _tts(client, **payload):
    payload.setdefault("text", TEXT)
    return client.post("/tts", json=payload)


def test_tts_headers(tts_client):
    r = _tts(tts_client, voice="deepseek-chan", language="Chinese", emotion="annoyed", instruct="不耐煩、拖長音")
    assert r.status_code == 200
    ctype = r.headers["content-type"]
    assert ctype.startswith("audio/L16")
    assert "channels=1" in ctype
    rate = int(re.search(r"rate=(\d+)", ctype).group(1))
    assert int(r.headers["x-sample-rate"]) == rate  # X-Sample-Rate is mandatory and matches
    assert rate in (16_000, 22_050, 24_000, 44_100, 48_000)


def test_tts_pcm_is_whole_s16_samples(tts_client):
    r = _tts(tts_client)
    assert len(r.content) > 0
    assert len(r.content) % 2 == 0


def test_tts_pcm_length_parity(tts_client, tts_is_fake):
    """Fake: exactly SAMPLES_PER_CHAR s16 samples per non-whitespace char, however it is split."""
    if not tts_is_fake:
        pytest.skip("fake-only")
    from fake_server import expected_pcm_bytes

    for text in [TEXT, "嗯……讓我想一下。", "Hello world. This is a test!", "哼!\n你是笨蛋嗎?\n\n這種事情也要問我?", "短"]:
        r = _tts(tts_client, text=text)
        assert r.status_code == 200
        assert len(r.content) == expected_pcm_bytes(text), text


def test_tts_default_voice_and_optional_fields(tts_client):
    r = tts_client.post("/tts", json={"text": "你好。"})
    assert r.status_code == 200 and len(r.content) > 0


def test_tts_streams_per_sentence_fake(tts_client, tts_is_fake):
    if not tts_is_fake:
        pytest.skip("fake-only")
    from fake_server import synth_sentence
    from text_split import split_sentences

    parts = [synth_sentence(s) for s in split_sentences(TEXT, min_chars=1)]
    assert len(parts) == 3
    assert b"".join(parts) == _tts(tts_client).content  # neutral emotion -> identical bytes


def test_tts_emotion_changes_pitch_not_length_fake(tts_client, tts_is_fake):
    if not tts_is_fake:
        pytest.skip("fake-only")
    neutral = _tts(tts_client, text="你好。").content
    happy = _tts(tts_client, text="你好。", emotion="happy").content
    assert len(neutral) == len(happy)
    assert neutral != happy


def test_tts_output_is_audible_not_silent(tts_client):
    pcm = _tts(tts_client, text="你好嗎?").content
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
    assert max(abs(s) for s in samples) > 1000


def test_tts_empty_text(tts_client):
    r = tts_client.post("/tts", json={"text": "   "})
    assert 400 <= r.status_code < 500
    assert isinstance(r.json()["error"], str)


def test_tts_missing_text(tts_client):
    r = tts_client.post("/tts", json={"voice": "deepseek-chan"})
    assert 400 <= r.status_code < 500
    assert "error" in r.json()


def test_tts_unknown_voice(tts_client):
    r = tts_client.post("/tts", json={"text": "你好。", "voice": "no-such-voice-xyz"})
    assert r.status_code == 404
    assert "error" in r.json()


# ── round trip ───────────────────────────────────────────────────────────────


def test_tts_then_asr_roundtrip(asr_client, tts_client):
    r = _tts(tts_client, text="今天要做什麼?")
    rate = int(r.headers["x-sample-rate"])
    a = _asr(asr_client, pcm_to_wav(r.content, rate))
    assert a.status_code == 200
    expected_ms = len(r.content) / 2 / rate * 1000
    assert abs(a.json()["duration_ms"] - expected_ms) <= 2


# ── request bodies the fake takes and refuses ────────────────────────────────
# Pinned with the hand-written request model, before it was generated from the JSON Schema: the
# generated one must take and refuse exactly the same, with the same status and error body.

INVALID = "invalid request: "
NOT_AN_OBJECT = INVALID + "body: Input should be a valid dictionary or object to extract fields from"

FAKE_TTS_BODIES = [
    ({"text": "你好。"}, 200, None),
    ({"text": "你好。", "language": None, "emotion": None, "instruct": None, "voice": None, "priority": None}, 200, None),
    ({"text": "你好。", "language": "zh", "emotion": "happy", "instruct": "輕聲", "voice": "default", "priority": "ahead"},
     200, None),
    ({"text": "你好。", "unknown": [1, 2]}, 200, None),
    ({"text": "   "}, 400, {"error": "text is empty"}),
    ({"text": "你好。", "voice": "nobody"}, 404, {"error": "unknown voice 'nobody' (available: deepseek-chan, default)"}),
    ({}, 400, {"error": INVALID + "text: Field required"}),
    ({"text": None}, 400, {"error": INVALID + "text: Input should be a valid string"}),
    ({"text": 5}, 400, {"error": INVALID + "text: Input should be a valid string"}),
    ({"text": "你好。", "language": 5}, 400, {"error": INVALID + "language: Input should be a valid string"}),
    ({"text": "你好。", "emotion": ["happy"]}, 400, {"error": INVALID + "emotion: Input should be a valid string"}),
    ({"text": "你好。", "instruct": {}}, 400, {"error": INVALID + "instruct: Input should be a valid string"}),
    ({"text": "你好。", "voice": True}, 400, {"error": INVALID + "voice: Input should be a valid string"}),
    ({"text": "你好。", "priority": 1}, 400, {"error": INVALID + "priority: Input should be a valid string"}),
    ({"text": 1, "voice": 2}, 400, {"error": INVALID + "text: Input should be a valid string"}),
    (b"[]", 400, {"error": NOT_AN_OBJECT}),
    (b"null", 400, {"error": NOT_AN_OBJECT}),
    (b"nope", 400, {"error": INVALID + "0: JSON decode error"}),
    (NO_BODY, 400, {"error": INVALID + "body: Field required"}),
]


@pytest.mark.parametrize("body,status,answer", FAKE_TTS_BODIES)
def test_fake_tts_request_bodies(fake_client, monkeypatch, body, status, answer):
    monkeypatch.delenv("FAKE_VOICES", raising=False)
    assert send(fake_client, "POST", "/tts", body) == (status, answer)


def test_answers_fit_the_contract(asr_client, tts_client, asr_is_fake, tts_is_fake):
    """The same for a real worker (WORKER_ASR_URL / WORKER_TTS_URL). In process, every answer is
    checked anyway (response_contract.py); the fake's /health only has what every health has."""
    import contracts

    asr_health = contracts.WorkersHealth if asr_is_fake else contracts.WorkersAsrHealth
    tts_health = contracts.WorkersHealth if tts_is_fake else contracts.WorkersTtsHealth
    asr_health.model_validate_json(asr_client.get("/health").content, strict=True)
    tts_health.model_validate_json(tts_client.get("/health").content, strict=True)
    for client in (asr_client, tts_client):
        contracts.WorkersBusy.model_validate_json(client.get("/busy").content, strict=True)
    contracts.WorkersAsrReply.model_validate_json(_asr(asr_client, make_wav()).content, strict=True)
    contracts.WorkersError.model_validate_json(tts_client.post("/tts", json={"text": " "}).content, strict=True)
    if not tts_is_fake:
        contracts.WorkersTtsVoices.model_validate_json(tts_client.get("/voices").content, strict=True)
