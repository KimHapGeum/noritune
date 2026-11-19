import math
import struct
import wave

import pytest
from fastapi.testclient import TestClient

from karaoke_engine.server import create_app


def make_wav(path, seconds=1.0, rate=8000):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(i / 10))) for i in range(int(rate * seconds))))
    return path


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path / "data"))


def test_add_list_and_stream(client, tmp_path):
    src = make_wav(tmp_path / "내 노래.wav", seconds=1.5)
    r = client.post("/songs", json={"path": str(src)})
    assert r.status_code == 201, r.text
    song = r.json()
    assert song["title"] == "내 노래" and song["mode"] == "반주 그대로"
    assert abs(song["duration"] - 1.5) < 0.05

    assert [s["id"] for s in client.get("/songs").json()["songs"]] == [song["id"]]
    audio = client.get(f"/songs/{song['id']}/audio")
    assert audio.status_code == 200 and audio.content == src.read_bytes()
    assert src.exists()  # 원본은 그대로


def test_library_survives_restart(tmp_path):
    src = make_wav(tmp_path / "a.wav")
    TestClient(create_app(tmp_path / "data")).post("/songs", json={"path": str(src)})
    again = TestClient(create_app(tmp_path / "data")).get("/songs").json()["songs"]
    assert len(again) == 1


@pytest.mark.parametrize("name,body,msg", [
    ("없는파일.wav", None, "찾을 수 없어요"),
    ("메모.txt", b"hello", "지원하지 않는 형식"),
    ("깨진.mp3", b"not audio at all", "열 수 없어요"),
])
def test_rejects_bad_files(client, tmp_path, name, body, msg):
    p = tmp_path / name
    if body is not None:
        p.write_bytes(body)
    r = client.post("/songs", json={"path": str(p)})
    assert r.status_code == 400 and msg in r.json()["detail"]
    assert client.get("/songs").json()["songs"] == []


def test_cors_preflight_allows_only_app_origin(client):
    pna = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true"}
    ok = client.options("/songs", headers={"Origin": "http://tauri.localhost", **pna})
    assert ok.status_code == 200 and ok.headers["access-control-allow-private-network"] == "true"
    bad = client.options("/songs", headers={"Origin": "https://evil.example", **pna})
    assert bad.status_code == 400


@pytest.mark.parametrize("song_id", ["..%2F..%2Flibrary.json", "0" * 32, "abc"])
def test_unknown_or_malicious_id(client, song_id):
    assert client.get(f"/songs/{song_id}/audio").status_code == 404
