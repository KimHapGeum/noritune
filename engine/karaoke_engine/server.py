"""화면(Tauri)과 주고받는 로컬 HTTP 서버. 127.0.0.1 에만 연다."""
import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from typing import Literal

from pydantic import BaseModel, Field

from .library import MODES_SEPARATE, Library, LibraryError
from .lyrics_service import LyricsService
from .worker import DetectFn, DownloadFn, SeparateFn, Worker

SONG_ID = re.compile(r"^[0-9a-f]{32}$")
PARTS = {"original", "video", "instrumental", "vocals", "chorus"}
# Tauri 창(배포판·개발판)과 Vite 개발 서버만 허용
ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]


class AddSong(BaseModel):
    path: str
    mode: str = "빠른 분리"


class Decide(BaseModel):
    choice: str  # keep: 분리 없이 반주로 쓰기 / separate: 그래도 분리


class AddYoutube(BaseModel):
    id: str
    video_title: str  # 분류(노래방/MR/Inst)는 이 제목으로 처리기가 정한다
    title: str = ""
    artist: str = ""
    duration: float = 0
    mode: str = "빠른 분리"
    lyrics_in_video: str | None = None  # MR 영상일 때: yes / no / unknown


class ChooseLyrics(BaseModel):
    candidate_id: int


class LyricLine(BaseModel):
    t: float = Field(ge=0, le=6 * 3600)
    text: str = Field(max_length=500)


class SaveLyrics(BaseModel):
    lines: list[LyricLine] = Field(max_length=5000)


class Prefs(BaseModel):
    """곡마다 기억하는 재생 설정 (기획서 F8~F10). 보낸 것만 바꾼다."""
    gender: Literal["male", "female", "mixed"] | None = None  # 원곡 가수 성별
    key: int | None = Field(None, ge=-6, le=6)
    preset: Literal["orig", "male", "female"] | None = None
    tempo: float | None = Field(None, ge=0.7, le=1.3)
    guide: int | None = Field(None, ge=0, le=100)
    chorus: int | None = Field(None, ge=0, le=150)
    lowpass: Literal[0, 12000, 9000, 7000, 5000, 3500] | None = None
    verb: int | None = Field(None, ge=0, le=100)


class Settings(BaseModel):
    """앱 설정 (모든 곡에 같이 쓴다). 새 항목은 기본값을 꼭 둔다: 예전 settings.json에는 없다."""
    lyrics_delay: float = Field(0, ge=-2, le=2)  # 가사 시간 보정(초). +면 가사가 늦게 나온다


class Queue(BaseModel):
    queue: list[str] = Field(max_length=500)  # 곡 번호. 같은 곡을 두 번 예약해도 된다


class SearchLyrics(BaseModel):
    title: str | None = None
    artist: str | None = None


def create_app(data_dir: Path, separators: dict[str, SeparateFn] | None = None, detect: DetectFn | None = None,
               search=None, download: DownloadFn | None = None, lyrics_search=None, auto_lyrics=None) -> FastAPI:
    if separators is None:  # 시험은 가짜를 넣는다. 진짜는 torch를 쓰므로 여기서만 불러온다
        from . import separate as real

        separators = {"빠른 분리": real.quick, "고품질 분리": real.hq}
        detect = real.singing_ratio
    if search is None or download is None:
        from . import youtube

        search = search or youtube.search
        download = download or youtube.download
    if lyrics_search is None or auto_lyrics is None:
        from . import lyrics

        lyrics_search = lyrics_search or lyrics.search
        auto_lyrics = auto_lyrics or lyrics.auto
    lib = Library(data_dir)
    worker = Worker(lib, separators, detect, download, auto_lyrics)
    lyr = LyricsService(lib, lyrics_search)
    app = FastAPI(title="karaoke-engine")
    # WebView2는 127.0.0.1로 요청하기 전에 사설망 접근 사전 요청을 보낸다. 허용 출처는 위 목록뿐이다
    app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"],
                       allow_private_network=True)

    def find(song_id: str) -> dict:
        if not SONG_ID.match(song_id):
            raise HTTPException(404, "곡을 찾을 수 없어요")
        try:
            return lib.get(song_id)
        except KeyError:
            raise HTTPException(404, "곡을 찾을 수 없어요") from None

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/songs")
    def songs():
        return {"songs": lib.list()}

    @app.post("/songs", status_code=201)
    def add_song(body: AddSong):
        try:
            song = lib.add_file(body.path, body.mode)
        except LibraryError as e:
            raise HTTPException(400, str(e)) from None
        if song["mode"] in MODES_SEPARATE:
            worker.enqueue(song["id"])
        lyr.on_added(song, body.path)
        return lib.get(song["id"])

    @app.get("/youtube/search")
    def youtube_search(q: str, karaoke_only: bool = False):
        if not q.strip() or len(q) > 300:
            raise HTTPException(400, "검색어를 입력해 주세요")
        try:
            return {"results": search(q.strip(), karaoke_only)}
        except Exception as e:
            raise HTTPException(502, str(e) or "유튜브에서 찾지 못했어요") from None

    @app.post("/songs/youtube", status_code=201)
    def add_youtube(body: AddYoutube):
        try:
            song = lib.add_youtube(body.id, body.video_title, body.title, body.artist, body.duration,
                                   body.mode, body.lyrics_in_video)
        except LibraryError as e:
            raise HTTPException(400, str(e)) from None
        worker.enqueue(song["id"])  # 받기부터 시작한다
        lyr.on_added(song)  # 가사는 받는 동안 제목으로 찾는다
        return lib.get(song["id"])

    @app.get("/songs/{song_id}/lyrics")
    def lyrics_lines(song_id: str):
        s = find(song_id)
        return {"state": (s.get("lyrics") or {}).get("state", "none"), "lines": lyr.lines(song_id)}

    @app.get("/songs/{song_id}/lyrics/candidates")
    def lyrics_candidates(song_id: str):
        find(song_id)
        return {"candidates": lyr.candidates(song_id)}

    @app.post("/songs/{song_id}/lyrics/choose")
    def lyrics_choose(song_id: str, body: ChooseLyrics):
        find(song_id)
        try:
            lyr.choose(song_id, body.candidate_id)
        except KeyError:
            raise HTTPException(404, "그 가사 후보를 찾을 수 없어요") from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return lib.get(song_id)

    settings_file = lib.data_dir / "settings.json"
    queue_file = lib.data_dir / "queue.json"

    def write_json(path: Path, text: str) -> None:
        # 임시 파일에 다 쓴 뒤 바꿔치기: 쓰다가 꺼져도 기존 파일이 깨지지 않는다
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(text, encoding="utf-8")
        lib._retry(lambda: os.replace(tmp, path))

    def load_settings() -> Settings:
        try:
            return Settings(**json.loads(lib._retry(lambda: settings_file.read_text(encoding="utf-8"))))
        except (FileNotFoundError, ValueError):  # 없거나 깨졌으면 기본값
            return Settings()

    @app.get("/settings")
    def get_settings():
        return load_settings()

    @app.put("/settings")
    def put_settings(body: Settings):
        write_json(settings_file, body.model_dump_json(indent=1))
        return body

    # 예약 목록 (기획서 F7, 11.6): 화면이 아니라 처리기가 들고 있어야 나중에 손님 휴대폰과 나눠 볼 수 있다
    def load_queue() -> list[str]:
        try:
            ids = json.loads(lib._retry(lambda: queue_file.read_text(encoding="utf-8")))["queue"]
        except (FileNotFoundError, ValueError, KeyError, TypeError):
            return []
        known = {s["id"] for s in lib.list()}
        return [i for i in ids if i in known]

    @app.get("/queue")
    def get_queue():
        return {"queue": load_queue()}

    @app.put("/queue")
    def put_queue(body: Queue):
        for i in body.queue:
            find(i)  # 없는 곡은 404
        write_json(queue_file, json.dumps({"queue": body.queue}))
        worker.prioritize([i for i in body.queue if lib.get(i)["status"] == "queued"])
        return {"queue": body.queue}

    @app.patch("/songs/{song_id}/prefs")
    def save_prefs(song_id: str, body: Prefs):
        s = find(song_id)
        new = body.model_dump(exclude_unset=True, exclude_none=True)
        fields = {"prefs": {**(s.get("prefs") or {}), **{k: v for k, v in new.items() if k != "gender"}}}
        if "gender" in new:
            fields["gender"] = new["gender"]
        return lib.update(song_id, **fields)

    @app.put("/songs/{song_id}/lyrics")
    def lyrics_save(song_id: str, body: SaveLyrics):
        find(song_id)
        try:
            lyr.save(song_id, [x.model_dump() for x in body.lines])
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        return lib.get(song_id)

    @app.post("/songs/{song_id}/lyrics/search")
    def lyrics_search_again(song_id: str, body: SearchLyrics):
        find(song_id)
        lyr.start(song_id, body.title, body.artist)
        return lib.get(song_id)

    @app.post("/songs/{song_id}/lyrics/auto")
    def lyrics_auto(song_id: str):
        s = find(song_id)
        if not s.get("file"):
            raise HTTPException(409, "곡을 다 받은 뒤에 만들 수 있어요")
        if s["mode"] == "반주 그대로" and not s.get("stems"):
            raise HTTPException(400, "목소리가 없는 반주라 가사를 만들 수 없어요")
        worker.enqueue_lyrics(song_id)
        return lib.get(song_id)

    @app.get("/songs/{song_id}")
    def song(song_id: str):
        return find(song_id)

    @app.post("/songs/{song_id}/retry")
    def retry(song_id: str):
        s = find(song_id)
        if s["status"] != "failed":
            raise HTTPException(409, "실패한 곡만 다시 만들 수 있어요")
        worker.enqueue(song_id)
        return lib.get(song_id)

    @app.post("/songs/{song_id}/decide")
    def decide(song_id: str, body: Decide):
        s = find(song_id)
        if s["status"] != "confirm":
            raise HTTPException(409, "물어볼 일이 없는 곡이에요")
        if body.choice == "keep":
            return lib.update(song_id, mode="반주 그대로", status="ready", progress=1.0)
        if body.choice == "separate":
            worker.enqueue(song_id)  # 이미 검사했으니 바로 분리한다
            return lib.get(song_id)
        raise HTTPException(400, "keep 또는 separate 중 하나를 골라 주세요")

    @app.get("/songs/{song_id}/audio")
    def audio(song_id: str, part: str = "original"):
        find(song_id)
        if part not in PARTS:
            raise HTTPException(400, "알 수 없는 소리 종류예요")
        try:
            return FileResponse(lib.audio_path(song_id, part))
        except KeyError:
            raise HTTPException(404, "아직 만들지 않은 소리예요") from None

    app.state.worker = worker  # 시험에서 작업이 끝나기를 기다릴 때 쓴다
    return app
