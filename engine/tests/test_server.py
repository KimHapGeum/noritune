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


def fake_separate(src, out_dir, duration, on_progress):
    """진짜 모델 대신: 원곡을 그대로 반주·보컬 파일로 복사한다."""
    on_progress(0.5)
    for part in ("instrumental", "vocals"):
        (out_dir / f"{part}.ogg").write_bytes(src.read_bytes())
    return {"instrumental": "instrumental.ogg", "vocals": "vocals.ogg"}


def failing_separate(src, out_dir, duration, on_progress):
    raise RuntimeError("그래픽카드 메모리 부족")


def fake_hq(src, out_dir, duration, on_progress):
    stems = fake_separate(src, out_dir, duration, on_progress)
    (out_dir / "chorus.ogg").write_bytes(src.read_bytes())
    return {**stems, "chorus": "chorus.ogg"}


def make_client(data, separate=fake_separate, detect=None):
    app = create_app(data, separators={"빠른 분리": separate, "고품질 분리": fake_hq}, detect=detect)
    return TestClient(app), app.state.worker


def wait(worker):
    worker.q.join()


@pytest.fixture
def client(tmp_path):
    c, w = make_client(tmp_path / "data")
    c.worker = w
    return c


def test_add_list_and_stream(client, tmp_path):
    src = make_wav(tmp_path / "내 노래.wav", seconds=1.5)
    r = client.post("/songs", json={"path": str(src), "mode": "반주 그대로"})
    assert r.status_code == 201, r.text
    song = r.json()
    assert song["title"] == "내 노래" and song["mode"] == "반주 그대로" and song["status"] == "ready"
    assert abs(song["duration"] - 1.5) < 0.05

    assert [s["id"] for s in client.get("/songs").json()["songs"]] == [song["id"]]
    audio = client.get(f"/songs/{song['id']}/audio")
    assert audio.status_code == 200 and audio.content == src.read_bytes()
    assert src.exists()  # 원본은 그대로
    assert client.get(f"/songs/{song['id']}/audio?part=instrumental").status_code == 404  # 분리 안 한 곡


def test_quick_separation_makes_stems(client, tmp_path):
    src = make_wav(tmp_path / "a.wav")
    song = client.post("/songs", json={"path": str(src)}).json()  # 기본 방식 = 빠른 분리
    assert song["mode"] == "빠른 분리" and song["status"] == "queued"
    wait(client.worker)
    done = client.get(f"/songs/{song['id']}").json()
    assert done["status"] == "ready" and done["progress"] == 1.0
    for part in ("instrumental", "vocals"):
        assert client.get(f"/songs/{song['id']}/audio?part={part}").status_code == 200


def test_failure_then_retry(tmp_path):
    data = tmp_path / "data"
    c, w = make_client(data, failing_separate)
    song = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()
    wait(w)
    failed = c.get(f"/songs/{song['id']}").json()
    assert failed["status"] == "failed" and "메모리" in failed["error"]
    w.separators["빠른 분리"] = fake_separate  # 원인이 풀렸다고 치고 다시 시도
    assert c.post(f"/songs/{song['id']}/retry").status_code == 200
    wait(w)
    assert c.get(f"/songs/{song['id']}").json()["status"] == "ready"
    assert c.post(f"/songs/{song['id']}/retry").status_code == 409  # 성공한 곡은 다시 시도 안 함


def test_unfinished_song_resumes_after_restart(tmp_path):
    data = tmp_path / "data"
    started = []

    def stuck(src, out_dir, duration, on_progress):  # 앱이 분리 도중 꺼진 상황
        started.append(1)
        raise SystemExit  # 작업 줄 스레드만 멈추고 상태는 separating 으로 남는다

    c, w = make_client(data, stuck)
    song = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()
    import time
    for _ in range(50):
        if c.get(f"/songs/{song['id']}").json()["status"] == "separating":
            break
        time.sleep(0.05)
    assert started

    c2, w2 = make_client(data)  # 다시 켜면 이어서 만든다
    wait(w2)
    assert c2.get(f"/songs/{song['id']}").json()["status"] == "ready"


def test_library_survives_restart(tmp_path):
    src = make_wav(tmp_path / "a.wav")
    make_client(tmp_path / "data")[0].post("/songs", json={"path": str(src), "mode": "원곡 그대로"})
    again = make_client(tmp_path / "data")[0].get("/songs").json()["songs"]
    assert len(again) == 1 and again[0]["status"] == "ready"


@pytest.mark.parametrize("name,body,mode,msg", [
    ("없는파일.wav", None, "빠른 분리", "찾을 수 없어요"),
    ("메모.txt", b"hello", "빠른 분리", "지원하지 않는 형식"),
    ("깨진.mp3", b"not audio at all", "빠른 분리", "열 수 없어요"),
    ("a.wav", "wav", "고속 분리", "알 수 없는 반주 방식"),
])
def test_rejects_bad_input(client, tmp_path, name, body, mode, msg):
    p = tmp_path / name
    if body == "wav":
        make_wav(p)
    elif body is not None:
        p.write_bytes(body)
    r = client.post("/songs", json={"path": str(p), "mode": mode})
    assert r.status_code == 400 and msg in r.json()["detail"]
    assert client.get("/songs").json()["songs"] == []


def test_cors_preflight_allows_only_app_origin(client):
    pna = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true"}
    ok = client.options("/songs", headers={"Origin": "http://tauri.localhost", **pna})
    assert ok.status_code == 200 and ok.headers["access-control-allow-private-network"] == "true"
    bad = client.options("/songs", headers={"Origin": "https://evil.example", **pna})
    assert bad.status_code == 400


@pytest.mark.parametrize("url", ["/songs/..%2F..%2Flibrary.json/audio", f"/songs/{'0' * 32}/audio", "/songs/abc/audio"])
def test_unknown_or_malicious_id(client, url):
    assert client.get(url).status_code == 404


def test_rejects_unknown_part(client, tmp_path):
    song = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "반주 그대로"}).json()
    assert client.get(f"/songs/{song['id']}/audio?part=../../library.json").status_code == 400


def test_high_quality_makes_chorus(client, tmp_path):
    song = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "고품질 분리"}).json()
    wait(client.worker)
    assert client.get(f"/songs/{song['id']}").json()["status"] == "ready"
    assert client.get(f"/songs/{song['id']}/audio?part=chorus").status_code == 200


def test_instrumental_is_detected_and_asked(tmp_path):
    c, w = make_client(tmp_path / "data", detect=lambda src, dur: 0.0)  # 목소리 없음 = 반주
    song = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()
    wait(w)
    s = c.get(f"/songs/{song['id']}").json()
    assert s["status"] == "confirm" and s["singing"] == 0.0
    kept = c.post(f"/songs/{song['id']}/decide", json={"choice": "keep"}).json()
    assert kept["status"] == "ready" and kept["mode"] == "반주 그대로"
    assert c.post(f"/songs/{song['id']}/decide", json={"choice": "keep"}).status_code == 409


def test_separate_anyway_skips_second_check(tmp_path):
    calls = []
    c, w = make_client(tmp_path / "data", detect=lambda src, dur: calls.append(1) or 0.0)
    song = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()
    wait(w)
    assert c.post(f"/songs/{song['id']}/decide", json={"choice": "separate"}).status_code == 200
    wait(w)
    assert c.get(f"/songs/{song['id']}").json()["status"] == "ready" and len(calls) == 1


def test_song_with_vocals_is_not_asked(tmp_path):
    c, w = make_client(tmp_path / "data", detect=lambda src, dur: 0.6)
    song = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()
    wait(w)
    assert c.get(f"/songs/{song['id']}").json()["status"] == "ready"
