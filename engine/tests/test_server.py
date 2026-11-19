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


SAMPLE = {}  # 가짜 받기가 복사할 소리 파일 (fixture가 채운다)


def fake_download(vid, folder, with_video, on_progress):
    on_progress(0.5)
    (folder / "original.m4a").write_bytes(SAMPLE["wav"].read_bytes())
    if with_video:
        (folder / "video.mp4").write_bytes(b"video")
    return {"file": "original.m4a", "video": "video.mp4" if with_video else None}


def fake_search(q, karaoke_only):
    return [{"id": "aE3irDN5yqQ", "title": q, "karaoke_only": karaoke_only}]


LYRICS = {"cands": []}  # 가짜 가사 검색 결과 (시험마다 바꾼다)


def fake_lyrics_search(title, artist, duration):
    return LYRICS["cands"]


def fake_auto(src):
    return [{"t": 1.0, "text": "자동으로 만든 가사"}]


def make_client(data, separate=fake_separate, detect=None, download=fake_download):
    app = create_app(data, separators={"빠른 분리": separate, "고품질 분리": fake_hq}, detect=detect,
                     search=fake_search, download=download, lyrics_search=fake_lyrics_search, auto_lyrics=fake_auto)
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
    assert song["mode"] == "빠른 분리" and song["status"] in ("queued", "separating", "ready")  # 작업 줄이 바로 집어 갈 수 있다
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


@pytest.fixture
def sample(tmp_path):
    SAMPLE["wav"] = make_wav(tmp_path / "sample.wav")


def add_yt(c, video_title, **kw):
    body = {"id": "aE3irDN5yqQ", "video_title": video_title, "title": "우주를 줄게", "artist": "볼빨간사춘기", "duration": 1, **kw}
    return c.post("/songs/youtube", json=body)


def test_youtube_search_passes_query(client):
    r = client.get("/youtube/search", params={"q": "우주를 줄게", "karaoke_only": "true"}).json()
    assert r["results"][0]["karaoke_only"] is True
    assert client.get("/youtube/search", params={"q": " "}).status_code == 400


def test_youtube_normal_song_downloads_then_separates(client, sample):
    song = add_yt(client, "볼빨간사춘기 - 우주를 줄게 [가사]").json()
    assert song["status"] in ("queued", "downloading") and song["file"] is None
    wait(client.worker)
    s = client.get(f"/songs/{song['id']}").json()
    assert s["status"] == "ready" and s["mode"] == "빠른 분리" and s["stems"] and s["app_lyrics"] is True
    assert client.get(f"/songs/{song['id']}/audio?part=video").status_code == 404


def test_youtube_karaoke_video_keeps_video_and_hides_lyrics(client, sample):
    song = add_yt(client, "[TJ노래방] 우주를줄게 - 볼빨간사춘기 / TJ Karaoke", mode="고품질 분리").json()
    wait(client.worker)
    s = client.get(f"/songs/{song['id']}").json()
    assert s["status"] == "ready" and s["mode"] == "반주 그대로" and s["app_lyrics"] is False
    assert "stems" not in s  # 이미 반주라 분리하지 않는다
    assert client.get(f"/songs/{song['id']}/audio?part=video").content == b"video"


@pytest.mark.parametrize("answer,video,lyrics", [("yes", True, False), ("no", False, True), ("unknown", True, True)])
def test_youtube_mr_follows_answer(client, sample, answer, video, lyrics):
    song = add_yt(client, "우주를 줄게 피아노 반주 MR", lyrics_in_video=answer).json()
    wait(client.worker)
    s = client.get(f"/songs/{song['id']}").json()
    assert s["app_lyrics"] is lyrics and (s.get("video") is not None) is video and s["mode"] == "반주 그대로"


def test_youtube_mr_requires_answer(client):
    r = add_yt(client, "우주를 줄게 MR")
    assert r.status_code == 400 and "가사가 나오는지" in r.json()["detail"]


def test_youtube_rejects_bad_id(client):
    assert add_yt(client, "x", id="../../etc").status_code == 400


def test_youtube_download_failure_can_retry(tmp_path, sample):
    def broken(*a):
        raise RuntimeError("유튜브에서 받지 못했어요")

    c, w = make_client(tmp_path / "data", download=broken)
    song = add_yt(c, "볼빨간사춘기 - 우주를 줄게").json()
    wait(w)
    assert c.get(f"/songs/{song['id']}").json()["status"] == "failed"
    w.download = fake_download
    c.post(f"/songs/{song['id']}/retry")
    wait(w)
    assert c.get(f"/songs/{song['id']}").json()["status"] == "ready"


def cand(i, synced=True, recommended=False):
    return {"id": i, "title": "밤편지", "artist": "아이유", "duration": 253, "diff": 0, "synced": synced,
            "lines": [{"t": 10.0, "text": f"후보 {i}의 가사"}] if synced else [], "plain": "글자만", "recommended": recommended}


def wait_lyrics(c, song_id):
    import time
    for _ in range(100):
        st = c.get(f"/songs/{song_id}").json().get("lyrics", {}).get("state")
        if st not in (None, "searching"):
            return st
        time.sleep(0.02)
    raise AssertionError("가사 찾기가 끝나지 않음")


def test_lyrics_review_then_choose(client, tmp_path):
    LYRICS["cands"] = [cand(1, recommended=True), cand(2), cand(3, synced=False)]
    song = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "원곡 그대로"}).json()
    assert wait_lyrics(client, song["id"]) == "review"  # 후보를 찾으면 '목록 확인'
    lyr = client.get(f"/songs/{song['id']}/lyrics").json()
    assert lyr["lines"][0]["text"] == "후보 1의 가사"  # 고르기 전에도 추천 후보로 부를 수 있다
    assert len(client.get(f"/songs/{song['id']}/lyrics/candidates").json()["candidates"]) == 3
    assert client.post(f"/songs/{song['id']}/lyrics/choose", json={"candidate_id": 3}).status_code == 400  # 글자만
    assert client.post(f"/songs/{song['id']}/lyrics/choose", json={"candidate_id": 99}).status_code == 404
    r = client.post(f"/songs/{song['id']}/lyrics/choose", json={"candidate_id": 2}).json()
    assert r["lyrics"]["state"] == "internet"
    assert client.get(f"/songs/{song['id']}/lyrics").json()["lines"][0]["text"] == "후보 2의 가사"


def test_lyrics_none_then_auto(client, tmp_path):
    LYRICS["cands"] = []
    song = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()
    assert wait_lyrics(client, song["id"]) == "none"
    wait(client.worker)  # 분리까지 끝낸다
    assert client.post(f"/songs/{song['id']}/lyrics/auto").json()["lyrics"]["state"] == "generating"
    wait(client.worker)
    lyr = client.get(f"/songs/{song['id']}/lyrics").json()
    assert lyr["state"] == "auto" and lyr["lines"][0]["text"] == "자동으로 만든 가사"


def test_lyrics_auto_refused_for_instrumental(client, tmp_path):
    LYRICS["cands"] = []
    song = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "반주 그대로"}).json()
    r = client.post(f"/songs/{song['id']}/lyrics/auto")
    assert r.status_code == 400 and "목소리가 없는" in r.json()["detail"]


def test_lyrics_sidecar_lrc_is_used(client, tmp_path):
    src = make_wav(tmp_path / "내 노래.wav")
    (tmp_path / "내 노래.lrc").write_text("[00:05.00] 파일에 있던 가사" + chr(10), encoding="utf-8")
    song = client.post("/songs", json={"path": str(src), "mode": "원곡 그대로"}).json()
    assert song["lyrics"]["state"] == "file"
    assert client.get(f"/songs/{song['id']}/lyrics").json()["lines"] == [{"t": 5.0, "text": "파일에 있던 가사"}]


def test_karaoke_video_lyrics_off(client, sample):
    song = add_yt(client, "[TJ노래방] 우주를줄게 - 볼빨간사춘기 / TJ Karaoke").json()
    assert song["lyrics"]["state"] == "off"


def test_lyrics_editor_saves(client, tmp_path):
    LYRICS["cands"] = []
    song = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "원곡 그대로"}).json()
    sid = song["id"]
    assert wait_lyrics(client, sid) == "none"
    body = {"lines": [{"t": 12.345, "text": " 둘째 줄 "}, {"t": 3, "text": "첫 줄"}, {"t": 20, "text": "  "}]}
    assert client.put(f"/songs/{sid}/lyrics", json=body).json()["lyrics"]["state"] == "manual"  # 없던 가사를 직접 씀
    assert client.get(f"/songs/{sid}/lyrics").json()["lines"] == [{"t": 3.0, "text": "첫 줄"}, {"t": 12.35, "text": "둘째 줄"}]
    assert client.put(f"/songs/{sid}/lyrics", json={"lines": [{"t": -1, "text": "x"}]}).status_code == 422
    assert client.put(f"/songs/{sid}/lyrics", json={"lines": []}).json()["lyrics"]["state"] == "none"
    assert client.get(f"/songs/{sid}/lyrics").json()["lines"] == []


def test_lyrics_editor_keeps_source_and_waits_for_auto(client, tmp_path):
    src = make_wav(tmp_path / "곡.wav")
    (tmp_path / "곡.lrc").write_text("[00:05.00] 원래 가사" + chr(10), encoding="utf-8")
    sid = client.post("/songs", json={"path": str(src), "mode": "원곡 그대로"}).json()["id"]
    r = client.put(f"/songs/{sid}/lyrics", json={"lines": [{"t": 5.1, "text": "고친 가사"}]}).json()
    assert r["lyrics"]["state"] == "file"  # 출처는 그대로
    client.worker.lib.update(sid, lyrics={"state": "generating"})
    r = client.put(f"/songs/{sid}/lyrics", json={"lines": [{"t": 1, "text": "x"}]})
    assert r.status_code == 409  # 자동 생성이 끝나면 덮어써질 테니 막는다


def test_prefs_are_remembered_per_song(client, tmp_path):
    sid = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "원곡 그대로"}).json()["id"]
    client.patch(f"/songs/{sid}/prefs", json={"key": -5, "preset": "male", "tempo": 1.1})
    r = client.patch(f"/songs/{sid}/prefs", json={"guide": 30, "gender": "female"}).json()
    assert r["prefs"] == {"key": -5, "preset": "male", "tempo": 1.1, "guide": 30} and r["gender"] == "female"
    for bad in ({"key": 7}, {"tempo": 2}, {"gender": "x"}, {"lowpass": 4000}):
        assert client.patch(f"/songs/{sid}/prefs", json=bad).status_code == 422


def test_settings_saved_and_validated(tmp_path):
    c, _ = make_client(tmp_path / "data")
    assert c.get("/settings").json()["lyrics_delay"] == 0
    assert c.put("/settings", json={"lyrics_delay": 0.25}).json()["lyrics_delay"] == 0.25
    assert c.put("/settings", json={"lyrics_delay": 5}).status_code == 422
    (tmp_path / "data" / "settings.json").write_text("{깨짐", encoding="utf-8")
    assert c.get("/settings").json()["lyrics_delay"] == 0  # 깨진 파일은 기본값
    c.put("/settings", json={"lyrics_delay": -0.1})
    c2, _ = make_client(tmp_path / "data")  # 다시 켜도 남는다
    assert c2.get("/settings").json()["lyrics_delay"] == -0.1


def test_queue_saved_and_reserved_song_made_first(tmp_path):
    import threading
    gate = threading.Event()
    order = []

    def slow_separate(src, out_dir, duration, on_progress):
        gate.wait(5)  # 첫 곡을 붙잡아 두는 동안 나머지는 줄에서 기다린다
        order.append(src.parent.name)
        return fake_separate(src, out_dir, duration, on_progress)

    c, w = make_client(tmp_path / "data", separate=slow_separate)
    ids = [c.post("/songs", json={"path": str(make_wav(tmp_path / f"{n}.wav"))}).json()["id"] for n in "abc"]
    assert c.put("/queue", json={"queue": [ids[2], ids[2]]}).json() == {"queue": [ids[2], ids[2]]}  # 같은 곡 두 번도 된다
    gate.set()
    wait(w)
    assert order[1] == ids[2]  # 예약한 c가 b보다 먼저
    assert c.put("/queue", json={"queue": ["0" * 32]}).status_code == 404
    c2, _ = make_client(tmp_path / "data")
    assert c2.get("/queue").json() == {"queue": [ids[2], ids[2]]}  # 다시 켜도 남는다


def test_mv_found_once_and_bad_ones_dropped(tmp_path):
    calls = []

    def search(q, karaoke_only):
        calls.append(q)
        return [{"id": "x" * 11, "title": "가수 노래 Official MV", "channel": "가수"},
                {"id": "y" * 11, "title": "가수 노래 노래방", "channel": "TJ"}]

    app = create_app(tmp_path / "data", separators={"빠른 분리": fake_separate}, search=search, download=fake_download,
                     lyrics_search=fake_lyrics_search, auto_lyrics=fake_auto)
    c = TestClient(app)
    sid = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "원곡 그대로"}).json()["id"]
    assert c.get(f"/songs/{sid}/mv").json() == {"ids": ["x" * 11]}
    assert c.get(f"/songs/{sid}/mv").json() == {"ids": ["x" * 11]}
    assert len(calls) == 1 and calls[0].endswith("Official MV")  # 두 번째는 저장해 둔 것
    assert c.post(f"/songs/{sid}/mv/bad", json={"queue": ["x" * 11]}).json() == {"ids": []}


def test_background_settings_and_files(client, tmp_path):
    pic = tmp_path / "내 사진.png"
    pic.write_bytes(b"png")
    s = client.get("/settings").json()
    assert (s["bg_mode"], s["bg_mv_fallback"], s["bg_dim"], s["bg_files"]) == ("mv", "default", 55, [])
    assert client.put("/settings", json={"bg_files": [str(tmp_path / "x.exe")]}).status_code == 422
    assert client.put("/settings", json={"bg_files": ["relative.png"]}).status_code == 422
    assert client.put("/settings", json={"bg_mode": "custom", "bg_files": [str(pic)]}).status_code == 200
    assert client.get("/background/0").content == b"png"
    assert client.get("/background/1").status_code == 404

    sid = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "원곡 그대로"}).json()["id"]
    assert client.patch(f"/songs/{sid}/prefs", json={"bg_kind": "youtube", "bg_value": "주소 아님"}).status_code == 400
    r = client.patch(f"/songs/{sid}/prefs", json={"bg_kind": "youtube", "bg_value": "https://youtu.be/aE3irDN5yqQ"}).json()
    assert r["prefs"]["bg_value"] == "aE3irDN5yqQ"
    assert client.get(f"/songs/{sid}/background").status_code == 404  # 파일 배경이 아니다
    client.patch(f"/songs/{sid}/prefs", json={"bg_kind": "file", "bg_value": str(pic)})
    assert client.get(f"/songs/{sid}/background").content == b"png"


def test_turning_lyrics_on_for_karaoke_video_starts_search(client, sample):
    LYRICS["cands"] = [cand(1, recommended=True)]
    song = add_yt(client, "밤편지 [TJ노래방]").json()
    assert song["lyrics"]["state"] == "off"
    client.patch(f"/songs/{song['id']}/prefs", json={"lyrics": True})
    assert wait_lyrics(client, song["id"]) == "review"


def test_favorite_and_play_count(client, tmp_path):
    sid = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "원곡 그대로"}).json()["id"]
    assert client.patch(f"/songs/{sid}/prefs", json={"favorite": True}).json()["prefs"]["favorite"] is True
    client.post(f"/songs/{sid}/played")
    s = client.post(f"/songs/{sid}/played").json()
    assert s["plays"] == 2 and s["last_played"]
    assert client.get("/settings").json()["auto_hide"] is True


def test_mic_settings_default_off_and_validated(client):
    s = client.get("/settings").json()
    assert (s["mic_on"], s["mic_device"], s["mic_volume"], s["mic_echo"]) == (False, "", 80, 30)
    assert client.put("/settings", json={**s, "mic_volume": 200}).status_code == 422
    assert client.put("/settings", json={**s, "mic_on": True, "mic_echo": 50}).json()["mic_echo"] == 50


def test_delete_song_removes_folder_and_queue(client, tmp_path):
    src = make_wav(tmp_path / "내 원본.wav")
    sid = client.post("/songs", json={"path": str(src), "mode": "원곡 그대로"}).json()["id"]
    client.put("/queue", json={"queue": [sid]})
    folder = tmp_path / "data" / "songs" / sid
    assert folder.is_dir()
    assert client.delete(f"/songs/{sid}").status_code == 200
    assert not folder.exists() and src.exists()  # 내 PC 원본은 그대로
    assert client.get(f"/songs/{sid}").status_code == 404
    assert client.get("/queue").json() == {"queue": []}


def test_remake_changes_mode_and_drops_old_stems(client, tmp_path):
    sid = client.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav")), "mode": "고품질 분리"}).json()["id"]
    wait(client.worker)
    assert (tmp_path / "data" / "songs" / sid / "chorus.ogg").exists()
    r = client.post(f"/songs/{sid}/remake", json={"mode": "원곡 그대로"}).json()
    assert r["status"] == "ready" and r["stems"] is None
    assert not (tmp_path / "data" / "songs" / sid / "chorus.ogg").exists()
    client.post(f"/songs/{sid}/remake", json={"mode": "빠른 분리"})
    wait(client.worker)
    s = client.get(f"/songs/{sid}").json()
    assert s["status"] == "ready" and set(s["stems"]) == {"instrumental", "vocals"}
    assert client.post(f"/songs/{sid}/remake", json={"mode": "엉터리"}).status_code == 400


def test_gpu_out_of_memory_retries_on_cpu(tmp_path):
    calls = []

    def oom_once(src, out_dir, duration, on_progress):
        calls.append("try")
        if len(calls) == 1:
            raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
        return fake_separate(src, out_dir, duration, on_progress)

    cpu = []
    app = create_app(tmp_path / "data", separators={"빠른 분리": oom_once}, search=fake_search, download=fake_download,
                     lyrics_search=fake_lyrics_search, auto_lyrics=fake_auto, to_cpu=lambda: cpu.append(1))
    c = TestClient(app)
    sid = c.post("/songs", json={"path": str(make_wav(tmp_path / "a.wav"))}).json()["id"]
    wait(app.state.worker)
    assert c.get(f"/songs/{sid}").json()["status"] == "ready" and cpu == [1] and len(calls) == 2


def test_download_failure_updates_ytdlp_then_retries(tmp_path, sample):
    tries, updated = [], []

    def flaky(vid, folder, with_video, on_progress):
        tries.append(1)
        if len(tries) == 1:
            raise RuntimeError("HTTP Error 403")
        return fake_download(vid, folder, with_video, on_progress)

    app = create_app(tmp_path / "data", separators={"빠른 분리": fake_separate}, search=fake_search, download=flaky,
                     lyrics_search=fake_lyrics_search, auto_lyrics=fake_auto, update_downloader=lambda: updated.append(1))
    c = TestClient(app)
    sid = add_yt(c, "우주를 줄게 (Inst.)").json()["id"]
    wait(app.state.worker)
    assert c.get(f"/songs/{sid}").json()["status"] == "ready" and updated == [1] and len(tries) == 2


def test_offline_and_low_disk_fail_with_clear_message(tmp_path, sample):
    app = create_app(tmp_path / "data", separators={"빠른 분리": fake_separate}, search=fake_search, download=fake_download,
                     lyrics_search=fake_lyrics_search, auto_lyrics=fake_auto, online=lambda: False)
    c = TestClient(app)
    sid = add_yt(c, "우주를 줄게 (Inst.)").json()["id"]
    wait(app.state.worker)
    assert c.get(f"/songs/{sid}").json()["error"] == "인터넷에 연결되어 있지 않아요"

    app2 = create_app(tmp_path / "data2", separators={"빠른 분리": fake_separate}, search=fake_search, download=fake_download,
                      lyrics_search=fake_lyrics_search, auto_lyrics=fake_auto, free_space=lambda: 1024**3)
    c2 = TestClient(app2)
    sid2 = c2.post("/songs", json={"path": str(make_wav(tmp_path / "b.wav"))}).json()["id"]
    wait(app2.state.worker)
    assert c2.get(f"/songs/{sid2}").json()["error"] == "저장 공간이 부족해요 (남은 공간 1.0GB)"
    assert c2.get("/system").json()["free"] == 1024**3
