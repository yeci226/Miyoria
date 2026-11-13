"""The lyrics service (lyrics/server.py) and the song worker's client of it (sing/lyrics_remote.py)."""

from __future__ import annotations

import io
import sys
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sing"))
sys.path.insert(0, str(ROOT / "lyrics"))

pytest.importorskip("multipart")
from fastapi.testclient import TestClient  # noqa: E402

import lyrics  # noqa: E402
import lyrics_remote  # noqa: E402
import server  # noqa: E402  (lyrics/server.py)

FOUND = {"provider": "lrclib", "synced": True, "lrc": "[00:01.00]a", "plain": None, "track": "t", "artist": "a",
         "how": "title", "confidence": 0.95}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LYRICS_CACHE_DIR", str(tmp_path / "cache"))
    return TestClient(server.app)


def _wav(seconds: float = 0.5, rate: int = 44100) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * 2 * int(rate * seconds))
    return buf.getvalue()


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


def test_lyrics_passes_hints_duration_and_audio_to_the_search(client, monkeypatch):
    seen = {}

    def fake_search(hints, duration, *, cache_dir, audio, fresh):
        seen.update(hints=hints, duration=duration, fresh=fresh, audio_bytes=audio.read_bytes() if audio else None,
                    cache=cache_dir)
        return FOUND

    monkeypatch.setattr(lyrics, "search", fake_search)
    r = client.post("/lyrics", data={"hints": '{"title": "t"}', "duration": "201.5", "fresh": "1"},
                    files={"audio": ("lead.wav", b"RIFFdata", "audio/wav")})
    assert r.status_code == 200
    assert r.json() == {"found": True, "result": FOUND}
    assert seen["hints"] == {"title": "t"} and seen["duration"] == 201.5 and seen["fresh"] is True
    assert seen["audio_bytes"] == b"RIFFdata"
    assert seen["cache"].name == "cache"


def test_nothing_found_and_no_audio(client, monkeypatch):
    monkeypatch.setattr(lyrics, "search", lambda hints, duration, **kw: None if kw["audio"] is None else FOUND)
    assert client.post("/lyrics", data={"hints": "{}"}).json() == {"found": False, "result": None}


def test_bad_hints_are_a_400(client):
    assert client.post("/lyrics", data={"hints": "not json"}).status_code == 400
    assert client.post("/lyrics", data={"hints": "[1]"}).status_code == 400


def test_remote_url_is_off_by_default(monkeypatch):
    monkeypatch.delenv("SING_LYRICS_URL", raising=False)
    assert lyrics_remote.remote_url() is None
    monkeypatch.setenv("SING_LYRICS_URL", " http://100.64.0.1:8007/ ")
    assert lyrics_remote.remote_url() == "http://100.64.0.1:8007"


def test_search_remote_sends_a_small_mono_clip_and_returns_the_result(client, monkeypatch, tmp_path):
    got = {}

    def fake_search(hints, duration, *, cache_dir, audio, fresh):
        import soundfile as sf

        info = sf.info(str(audio))
        got.update(hints=hints, duration=duration, rate=info.samplerate, channels=info.channels)
        return FOUND

    monkeypatch.setattr(lyrics, "search", fake_search)
    monkeypatch.setattr("httpx.post", lambda url, **kw: client.post(url.removeprefix("http://testserver"), **kw))
    lead = tmp_path / "lead.wav"
    lead.write_bytes(_wav())
    monkeypatch.delenv("SING_LYRICS_ASR", raising=False)
    out = lyrics_remote.search_remote("http://testserver", {"title": "t"}, 120.0, lead)
    assert out == FOUND
    assert got == {"hints": {"title": "t"}, "duration": 120.0, "rate": 16000, "channels": 1}


def test_search_remote_without_asr_does_not_upload_audio(client, monkeypatch, tmp_path):
    monkeypatch.setattr(lyrics, "search", lambda hints, duration, **kw: dict(FOUND, audio=kw["audio"] is not None))
    monkeypatch.setattr("httpx.post", lambda url, **kw: client.post(url.removeprefix("http://testserver"), **kw))
    lead = tmp_path / "lead.wav"
    lead.write_bytes(_wav())
    monkeypatch.setenv("SING_LYRICS_ASR", "0")
    out = lyrics_remote.search_remote("http://testserver", {}, None, lead)
    assert out is not None and out["audio"] is False


def test_search_remote_survives_an_unreachable_service():
    assert lyrics_remote.search_remote("http://127.0.0.1:9", {"title": "t"}, None, timeout=1.0) is None
