"""곡 목록 저장소: <저장 폴더>/library.json 과 <저장 폴더>/songs/<곡 번호>/ 폴더."""
import json
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import mutagen

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"}
# 반주 방식. 분리하는 방식은 작업 줄(worker)이 뒤에서 처리한다
MODES_READY = {"반주 그대로", "원곡 그대로"}
MODES_SEPARATE = {"빠른 분리", "고품질 분리"}
MODES = MODES_READY | MODES_SEPARATE
# 곡 상태: ready(부를 수 있음) / queued(기다림) / checking(반주인지 검사) / confirm(반주 같아 사용자에게 물음)
#          / separating(만드는 중) / failed(실패)
BUSY = {"queued", "downloading", "checking", "separating"}


class LibraryError(ValueError):
    """사용자에게 그대로 보여 줄 수 있는 오류."""


class Library:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.songs_dir = self.data_dir / "songs"
        self.index = self.data_dir / "library.json"
        self._lock = threading.Lock()
        self.songs_dir.mkdir(parents=True, exist_ok=True)
        self._songs: list[dict] = self._load()

    @staticmethod
    def _retry(fn):
        # 윈도우는 바꿔치기하는 순간 다른 쪽(백신, OneDrive 동기화 등)이 파일을 잡고 있으면 접근 거부를 낸다. 잠깐 뒤 다시 한다
        for i in range(10):
            try:
                return fn()
            except PermissionError:
                if i == 9:
                    raise
                time.sleep(0.05 * (i + 1))

    def _load(self) -> list[dict]:
        if not self.index.exists():
            return []
        songs = json.loads(self._retry(lambda: self.index.read_text(encoding="utf-8")))["songs"]
        for s in songs:  # 1단계에서 만든 곡에는 상태가 없다
            s.setdefault("status", "ready")
        return songs

    def _save(self) -> None:
        # 임시 파일에 다 쓴 뒤 바꿔치기: 쓰다가 꺼져도 기존 목록이 깨지지 않는다
        tmp = self.index.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"version": 1, "songs": self._songs}, ensure_ascii=False, indent=1), encoding="utf-8")
        self._retry(lambda: os.replace(tmp, self.index))

    def list(self) -> list[dict]:
        with self._lock:
            return [dict(s) for s in self._songs]

    def get(self, song_id: str) -> dict:
        with self._lock:
            return dict(self._find(song_id))

    def _find(self, song_id: str) -> dict:
        for s in self._songs:
            if s["id"] == song_id:
                return s
        raise KeyError(song_id)

    def update(self, song_id: str, **fields) -> dict:
        with self._lock:
            song = self._find(song_id)
            song.update(fields)
            self._save()
            return dict(song)

    def remove(self, song_id: str) -> None:
        """곡과 곡 폴더(받은 원곡·반주·가사)를 지운다. 사용자 PC의 원본 파일은 건드리지 않는다."""
        with self._lock:
            song = self._find(song_id)
            self._songs.remove(song)
            self._save()
        folder = self.songs_dir / song["id"]
        if folder.is_dir():
            self._retry(lambda: shutil.rmtree(folder))

    def folder(self, song_id: str) -> Path:
        return self.songs_dir / self.get(song_id)["id"]

    def audio_path(self, song_id: str, part: str = "original") -> Path:
        """part: original(받은 원곡) / video(노래방 영상) / instrumental(반주) / vocals(가이드 보컬) / chorus(코러스)."""
        song = self.get(song_id)
        if part in ("original", "video"):
            name = song.get("file" if part == "original" else "video")
        else:
            name = (song.get("stems") or {}).get(part)
        if not name:
            raise KeyError(part)
        return self.songs_dir / song["id"] / name

    def add_youtube(self, vid: str, video_title: str, title: str, artist: str, duration: float,
                    mode: str = "빠른 분리", lyrics_in_video: str | None = None) -> dict:
        """유튜브 곡을 '받는 중'으로 올린다. 실제 받기는 작업 줄이 한다.

        영상 제목으로 나눠 처리한다 (기획서 F12): 노래방 영상은 영상까지 받고 앱 가사를 끈다.
        MR은 사용자 답(yes/no/unknown)에 따르고, 노래방·MR·Inst는 이미 반주이므로 분리하지 않는다."""
        from .youtube import VIDEO_ID, classify

        if not VIDEO_ID.match(vid):
            raise LibraryError("유튜브 영상 번호가 아니에요")
        if mode not in MODES:
            raise LibraryError(f"알 수 없는 반주 방식이에요 ({mode})")
        kind = classify(video_title)
        with_video, app_lyrics = False, True
        if kind == "karaoke":
            with_video, app_lyrics = True, False
        elif kind == "mr":
            if lyrics_in_video not in ("yes", "no", "unknown"):
                raise LibraryError("MR 영상은 가사가 나오는지 골라 주세요")
            with_video, app_lyrics = lyrics_in_video != "no", lyrics_in_video != "yes"
        if kind != "normal":
            mode = "반주 그대로"

        song_id = uuid.uuid4().hex
        (self.songs_dir / song_id).mkdir()
        song = {
            "id": song_id,
            "title": title.strip() or video_title,
            "artist": artist.strip(),
            "duration": round(float(duration or 0), 2),
            "file": None,
            "mode": mode,
            "status": "queued",
            "progress": 0.0,
            "app_lyrics": app_lyrics,
            "want_video": with_video,
            "source": {"kind": "youtube", "id": vid, "title": video_title, "type": kind},
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            self._songs.append(song)
            self._save()
        return dict(song)

    def add_file(self, src: str, mode: str = "빠른 분리") -> dict:
        if mode not in MODES:
            raise LibraryError(f"알 수 없는 반주 방식이에요 ({mode})")
        path = Path(src)
        if not path.is_file():
            raise LibraryError("파일을 찾을 수 없어요")
        ext = path.suffix.lower()
        if ext not in AUDIO_EXTS:
            raise LibraryError(f"지원하지 않는 형식이에요 ({ext or '확장자 없음'})")
        try:
            info = mutagen.File(path, easy=True)
        except Exception:
            info = None
        if info is None or not getattr(info, "info", None):
            raise LibraryError("이 파일은 열 수 없어요 (손상되었거나 지원하지 않는 형식)")

        song_id = uuid.uuid4().hex
        folder = self.songs_dir / song_id
        folder.mkdir()
        file_name = "original" + ext
        # 원본은 건드리지 않고 저장 폴더로 복사한다
        shutil.copy2(path, folder / file_name)

        tags = info.tags or {}
        first = lambda key: (tags.get(key) or [""])[0].strip()  # noqa: E731
        song = {
            "id": song_id,
            "title": first("title") or path.stem,
            "artist": first("artist"),
            "duration": round(float(info.info.length), 2),
            "file": file_name,
            "mode": mode,
            "status": "queued" if mode in MODES_SEPARATE else "ready",
            "progress": 0.0,
            "source": {"kind": "file", "name": path.name},
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            self._songs.append(song)
            self._save()
        return dict(song)
