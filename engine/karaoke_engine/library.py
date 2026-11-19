"""곡 목록 저장소: <저장 폴더>/library.json 과 <저장 폴더>/songs/<곡 번호>/ 폴더."""
import json
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import mutagen

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"}


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

    def _load(self) -> list[dict]:
        if not self.index.exists():
            return []
        return json.loads(self.index.read_text(encoding="utf-8"))["songs"]

    def _save(self) -> None:
        # 임시 파일에 다 쓴 뒤 바꿔치기: 쓰다가 꺼져도 기존 목록이 깨지지 않는다
        tmp = self.index.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"version": 1, "songs": self._songs}, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.index)

    def list(self) -> list[dict]:
        with self._lock:
            return [dict(s) for s in self._songs]

    def get(self, song_id: str) -> dict:
        with self._lock:
            for s in self._songs:
                if s["id"] == song_id:
                    return dict(s)
        raise KeyError(song_id)

    def audio_path(self, song_id: str) -> Path:
        song = self.get(song_id)
        return self.songs_dir / song["id"] / song["file"]

    def add_file(self, src: str) -> dict:
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
            "mode": "반주 그대로",  # 1단계: 분리 없이 그대로 재생
            "source": {"kind": "file", "name": path.name},
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            self._songs.append(song)
            self._save()
        return dict(song)
