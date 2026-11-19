"""반주 만들기 작업 줄: 한 번에 한 곡씩, 들어온 순서대로 뒤에서 처리한다.

곡마다: (처음 한 번) 반주인지 검사 → 목소리가 거의 없으면 멈추고 사용자에게 물음(confirm) → 분리."""
import logging
import queue
import threading
from pathlib import Path
from typing import Callable

from .library import BUSY, Library

log = logging.getLogger("karaoke_engine.worker")

# separate(원곡 경로, 결과 폴더, 곡 길이(초), 진행률 알림) -> {"instrumental": ..., "vocals": ..., ["chorus": ...]}
SeparateFn = Callable[[Path, Path, float, Callable[[float], None]], dict]
# detect(원곡 경로, 곡 길이) -> 목소리가 나오는 비율 0~1
DetectFn = Callable[[Path, float], float]
# download(영상 번호, 곡 폴더, 영상도 받을지, 진행률 알림) -> {"file": 소리 파일 이름, "video": 영상 파일 이름 또는 None}
DownloadFn = Callable[[str, Path, bool, Callable[[float], None]], dict]
INSTRUMENTAL_BELOW = 0.10  # 시험: 노래 있는 곡 63~65%, 반주·피아노 곡 0%


class Worker:
    def __init__(self, lib: Library, separators: dict[str, SeparateFn], detect: DetectFn | None = None,
                 download: DownloadFn | None = None, auto_lyrics=None):
        self.lib = lib
        self.separators = separators
        self.detect = detect
        self.download = download
        self.auto_lyrics = auto_lyrics  # 원곡/목소리 경로 -> [{"t", "text"}] (음성 인식)
        self.q: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._run, daemon=True, name="separate-worker").start()
        # 지난번에 끝내지 못한 곡은 다시 줄에 세운다
        for s in lib.list():
            if s["status"] in BUSY:
                lib.update(s["id"], status="queued", progress=0.0)
                self.q.put(s["id"])

        for s in lib.list():
            if (s.get("lyrics") or {}).get("state") == "generating":
                self.q.put(("lyrics", s["id"]))

    def enqueue(self, song_id: str) -> None:
        self.lib.update(song_id, status="queued", progress=0.0, error=None)
        self.q.put(song_id)

    def enqueue_lyrics(self, song_id: str) -> None:
        """음성 인식으로 가사 만들기. 그래픽카드를 쓰므로 분리와 같은 줄에 선다."""
        self.lib.update(song_id, lyrics={"state": "generating"})
        self.q.put(("lyrics", song_id))

    def _run(self) -> None:
        while True:
            job = self.q.get()
            try:
                if isinstance(job, tuple):
                    self._lyrics(job[1])
                else:
                    self._one(job)
            finally:
                self.q.task_done()

    def _lyrics(self, song_id: str) -> None:
        try:
            song = self.lib.get(song_id)
        except KeyError:
            return
        folder = self.lib.folder(song_id)
        src = folder / ((song.get("stems") or {}).get("vocals") or song["file"])  # 분리한 목소리가 있으면 그것으로
        try:
            lines = self.auto_lyrics(src)
        except Exception as e:
            log.exception("가사 자동 생성 실패 %s", song_id)
            self.lib.update(song_id, lyrics={"state": "none", "error": str(e) or "가사를 만들지 못했어요"})
            return
        if not lines:
            self.lib.update(song_id, lyrics={"state": "none", "error": "노래 속 목소리를 찾지 못했어요"})
            return
        from .lyrics import to_lrc

        (folder / "lyrics.lrc").write_text(to_lrc(lines), encoding="utf-8")
        self.lib.update(song_id, lyrics={"state": "auto"})

    def _one(self, song_id: str) -> None:
        try:
            song = self.lib.get(song_id)
        except KeyError:
            return  # 그사이 지워진 곡
        folder = self.lib.folder(song_id)
        last = [0.0]

        def on_progress(p: float) -> None:
            if abs(p - last[0]) >= 0.01:  # 1%마다만 저장
                last[0] = p
                self.lib.update(song_id, progress=round(min(p, 0.99), 2))

        if not song.get("file"):  # 유튜브 곡: 먼저 받는다
            self.lib.update(song_id, status="downloading", progress=0.0)
            try:
                got = self.download(song["source"]["id"], folder, song.get("want_video", False), on_progress)
            except Exception as e:
                log.exception("받기 실패 %s", song_id)
                self.lib.update(song_id, status="failed", error=str(e) or e.__class__.__name__)
                return
            song = self.lib.update(song_id, file=got["file"], video=got.get("video"), progress=0.0)
            last[0] = 0.0
            if song["mode"] not in self.separators:
                self.lib.update(song_id, status="ready", progress=1.0)
                return
        src = folder / song["file"]

        if self.detect and not song.get("checked"):
            self.lib.update(song_id, status="checking")
            try:
                ratio = self.detect(src, song["duration"])
            except Exception:
                log.exception("반주 검사 실패 %s", song_id)
                ratio = 1.0  # 검사가 안 되면 그냥 분리한다
            self.lib.update(song_id, checked=True, singing=round(ratio, 2))
            if ratio < INSTRUMENTAL_BELOW:
                self.lib.update(song_id, status="confirm")
                return

        self.lib.update(song_id, status="separating", progress=0.0)
        try:
            stems = self.separators[song["mode"]](src, folder, song["duration"], on_progress)
        except Exception as e:
            log.exception("분리 실패 %s", song_id)
            self.lib.update(song_id, status="failed", error=str(e) or e.__class__.__name__)
            return
        self.lib.update(song_id, status="ready", progress=1.0, stems=stems, error=None)
