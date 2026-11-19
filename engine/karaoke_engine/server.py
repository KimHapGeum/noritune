"""화면(Tauri)과 주고받는 로컬 HTTP 서버. 127.0.0.1 에만 연다."""
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .library import Library, LibraryError

SONG_ID = re.compile(r"^[0-9a-f]{32}$")
# Tauri 창(배포판·개발판)과 Vite 개발 서버만 허용
ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]


class AddSong(BaseModel):
    path: str


def create_app(data_dir: Path) -> FastAPI:
    lib = Library(data_dir)
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
            return lib.add_file(body.path)
        except LibraryError as e:
            raise HTTPException(400, str(e)) from None

    @app.get("/songs/{song_id}")
    def song(song_id: str):
        return find(song_id)

    @app.get("/songs/{song_id}/audio")
    def audio(song_id: str):
        find(song_id)
        return FileResponse(lib.audio_path(song_id))

    return app
