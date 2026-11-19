"""화면(Tauri)과 주고받는 로컬 HTTP 서버. 127.0.0.1 에만 연다."""
import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from .library import MODES_READY, MODES_SEPARATE, Library, LibraryError
from .lyrics_service import LyricsService
from .worker import DetectFn, DownloadFn, SeparateFn, Worker

SONG_ID = re.compile(r"^[0-9a-f]{32}$")
# 배경으로 쓸 수 있는 내 파일 (기획서 F11 사용자 설정 배경화면)
BG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov", ".m4v"}


def bg_file(path: str) -> str:
    p = Path(path)
    if not p.is_absolute() or p.suffix.lower() not in BG_EXTS:
        raise ValueError("사진(jpg·png·webp·gif)이나 영상(mp4·webm·mov) 파일만 배경으로 쓸 수 있어요")
    return str(p)
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
    lyrics: bool | None = None  # 이 곡에서 앱 가사를 켤지 (기획서 F12: 곡마다 기억)
    favorite: bool | None = None  # 즐겨찾기 (기획서 F16)
    # 이 곡만의 배경 (기획서 F11 "배경 바꾸기"). auto: 설정을 따른다
    bg_kind: Literal["auto", "default", "youtube", "file"] | None = None
    bg_value: str | None = Field(None, max_length=1000)


class Settings(BaseModel):
    """앱 설정 (모든 곡에 같이 쓴다). 새 항목은 기본값을 꼭 둔다: 예전 settings.json에는 없다."""
    lyrics_delay: float = Field(0, ge=-2, le=2)  # 가사 시간 보정(초). +면 가사가 늦게 나온다
    # 재생 화면 배경 (기획서 F11)
    bg_mode: Literal["default", "mv", "custom"] = "mv"
    bg_mv_fallback: Literal["default", "custom"] = "default"  # 뮤비를 못 찾았을 때
    bg_files: list[str] = Field(default_factory=list, max_length=50)
    bg_interval: Literal[10, 30, 0] = 10  # 사진 여러 장일 때 바꾸는 간격(초). 0: 곡마다
    bg_dim: int = Field(55, ge=0, le=90)
    auto_hide: bool = True  # 부르는 동안 버튼 줄 자동 숨김 (기획서 F6)
    # 마이크 (기획서 F13). 기본은 꺼짐: 앰프·믹서를 따로 쓰는 사람도 있다
    mic_on: bool = False
    mic_device: str = Field("", max_length=500)  # 비우면 Windows 기본 마이크
    mic_volume: int = Field(80, ge=0, le=150)
    mic_echo: int = Field(30, ge=0, le=100)

    @field_validator("bg_files")
    @classmethod
    def _files(cls, v: list[str]) -> list[str]:
        return [bg_file(x) for x in v]


class Queue(BaseModel):
    queue: list[str] = Field(max_length=500)  # 곡 번호. 같은 곡을 두 번 예약해도 된다


class Remake(BaseModel):
    mode: str


class SearchLyrics(BaseModel):
    title: str | None = None
    artist: str | None = None


def create_app(data_dir: Path, separators: dict[str, SeparateFn] | None = None, detect: DetectFn | None = None,
               search=None, download: DownloadFn | None = None, lyrics_search=None, auto_lyrics=None,
               to_cpu=None, update_downloader=None, online=None, free_space=None) -> FastAPI:
    if separators is None:  # 시험은 가짜를 넣는다. 진짜는 torch를 쓰므로 여기서만 불러온다
        from . import separate as real

        separators = {"빠른 분리": real.quick, "고품질 분리": real.hq}
        detect = real.singing_ratio
        to_cpu = real.use_cpu
    if search is None or download is None:
        from . import youtube

        search = search or youtube.search
        download = download or youtube.download
        update_downloader = update_downloader or youtube.update_ytdlp
        online = online or youtube.online
    if lyrics_search is None or auto_lyrics is None:
        from . import lyrics

        lyrics_search = lyrics_search or lyrics.search
        auto_lyrics = auto_lyrics or lyrics.auto
    lib = Library(data_dir)
    worker = Worker(lib, separators, detect, download, auto_lyrics, to_cpu, update_downloader, online, free_space)
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

    @app.post("/songs/{song_id}/played")
    def played(song_id: str):
        """부른 횟수와 마지막으로 부른 때 (기획서 F16)"""
        from datetime import datetime, timezone

        s = find(song_id)
        return lib.update(song_id, plays=s.get("plays", 0) + 1,
                          last_played=datetime.now(timezone.utc).isoformat(timespec="seconds"))

    @app.get("/songs/{song_id}/mv")
    def find_mv(song_id: str):
        """이 곡의 공식 뮤직비디오 후보 (좋은 순). 한 번 찾으면 곡 정보에 남겨 다시 찾지 않는다."""
        s = find(song_id)
        if "mv" not in s:
            from .youtube import pick_mv

            try:
                ids = pick_mv(search(f"{s['artist']} {s['title']} Official MV".strip(), False), s["artist"], s["title"])
            except Exception:
                return {"ids": []}  # 인터넷이 없으면 저장하지 않고 다음에 다시 찾는다
            s = lib.update(song_id, mv=ids)
        return {"ids": s["mv"]}

    @app.post("/songs/{song_id}/mv/bad")
    def bad_mv(song_id: str, body: Queue):
        """퍼가기를 막아 둔 영상처럼 틀 수 없던 뮤비를 후보에서 뺀다."""
        s = find(song_id)
        return {"ids": lib.update(song_id, mv=[i for i in s.get("mv", []) if i not in body.queue])["mv"]}

    def send_bg(path: str | None):
        if not path or not Path(path).is_file():
            raise HTTPException(404, "배경 파일을 찾을 수 없어요")
        return FileResponse(path)

    @app.get("/background/{index}")
    def background(index: int):
        files = load_settings().bg_files  # 설정에 넣은 파일만 보낸다
        return send_bg(files[index] if 0 <= index < len(files) else None)

    @app.get("/songs/{song_id}/background")
    def song_background(song_id: str):
        p = find(song_id).get("prefs") or {}
        return send_bg(p.get("bg_value") if p.get("bg_kind") == "file" else None)

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
        if new.get("bg_kind") == "youtube":
            from .youtube import video_id

            if not (vid := video_id(new.get("bg_value") or "")):
                raise HTTPException(400, "유튜브 주소를 알아볼 수 없어요")
            new["bg_value"] = vid
        elif new.get("bg_kind") == "file":
            try:
                new["bg_value"] = bg_file(new.get("bg_value") or "")
            except ValueError as e:
                raise HTTPException(400, str(e)) from None
        if new.get("lyrics") and (s.get("lyrics") or {}).get("state") == "off":
            lyr.start(song_id)  # 노래방 영상 곡에서 가사를 켜는 순간 찾는다 (기획서 F12)
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

    BUSY_NOW = {"downloading", "checking", "separating"}

    @app.delete("/songs/{song_id}")
    def delete_song(song_id: str):
        s = find(song_id)
        if s["status"] in BUSY_NOW or (s.get("lyrics") or {}).get("state") == "generating":
            raise HTTPException(409, "만드는 중인 곡은 지울 수 없어요. 끝난 뒤에 지워 주세요")
        lib.remove(song_id)
        q = load_queue()
        if song_id in q:
            write_json(queue_file, json.dumps({"queue": [i for i in q if i != song_id]}))
        return {"ok": True}

    @app.post("/songs/{song_id}/remake")
    def remake(song_id: str, body: Remake):
        """반주 방식을 바꿔 다시 만든다 (빠른 분리로 시도 / 고품질로 다시 / 원곡 그대로 부르기 등, 기획서 F3·8.1)"""
        s = find(song_id)
        if body.mode not in MODES_READY | MODES_SEPARATE:
            raise HTTPException(400, f"알 수 없는 반주 방식이에요 ({body.mode})")
        if s["status"] in BUSY_NOW or s["status"] == "queued":
            raise HTTPException(409, "만드는 중인 곡이에요. 끝난 뒤에 다시 해 주세요")
        folder = lib.folder(song_id)
        for f in (s.get("stems") or {}).values():  # 예전 반주는 지운다 (원곡은 남는다)
            (folder / f).unlink(missing_ok=True)
        lib.update(song_id, mode=body.mode, stems=None, checked=True, error=None)
        if body.mode in MODES_SEPARATE or not s.get("file"):
            worker.enqueue(song_id)  # 분리, 또는 아직 못 받은 유튜브 곡은 받기부터
        else:
            lib.update(song_id, status="ready", progress=1.0)
        return lib.get(song_id)

    @app.get("/system")
    def system():
        """저장 폴더와 남은 공간 (기획서 6장·8.1: 2GB 아래면 알린다)"""
        import shutil

        return {"data_dir": str(lib.data_dir), "free": (free_space or (lambda: shutil.disk_usage(lib.data_dir).free))()}

    @app.post("/logs/open")
    def open_logs():
        """로그 폴더를 탐색기로 연다 (문제 신고용)"""
        logs = lib.data_dir / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        os.startfile(logs)  # type: ignore[attr-defined]  # Windows 전용 앱
        return {"path": str(logs)}

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
