"""화면(Tauri)과 주고받는 로컬 HTTP 서버. 127.0.0.1 에만 연다."""
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .library import MODES_SEPARATE, Library, LibraryError
from .worker import DetectFn, SeparateFn, Worker

SONG_ID = re.compile(r"^[0-9a-f]{32}$")
PARTS = {"original", "instrumental", "vocals", "chorus"}
# Tauri 창(배포판·개발판)과 Vite 개발 서버만 허용
ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]


class AddSong(BaseModel):
    path: str
    mode: str = "빠른 분리"


class Decide(BaseModel):
    choice: str  # keep: 분리 없이 반주로 쓰기 / separate: 그래도 분리


def create_app(data_dir: Path, separators: dict[str, SeparateFn] | None = None,
               detect: DetectFn | None = None) -> FastAPI:
    if separators is None:  # 시험은 가짜를 넣는다. 진짜는 torch를 쓰므로 여기서만 불러온다
        from . import separate as real

        separators = {"빠른 분리": real.quick, "고품질 분리": real.hq}
        detect = real.singing_ratio
    lib = Library(data_dir)
    worker = Worker(lib, separators, detect)
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
        return song

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
