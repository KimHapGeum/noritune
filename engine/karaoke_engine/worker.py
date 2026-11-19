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
INSTRUMENTAL_BELOW = 0.10  # 시험: 노래 있는 곡 63~65%, 반주·피아노 곡 0%


class Worker:
    def __init__(self, lib: Library, separators: dict[str, SeparateFn], detect: DetectFn | None = None):
        self.lib = lib
        self.separators = separators
        self.detect = detect
        self.q: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._run, daemon=True, name="separate-worker").start()
        # 지난번에 끝내지 못한 곡은 다시 줄에 세운다
        for s in lib.list():
            if s["status"] in BUSY:
                lib.update(s["id"], status="queued", progress=0.0)
                self.q.put(s["id"])

    def enqueue(self, song_id: str) -> None:
        self.lib.update(song_id, status="queued", progress=0.0, error=None)
        self.q.put(song_id)

    def _run(self) -> None:
        while True:
            song_id = self.q.get()
            try:
                self._one(song_id)
            finally:
                self.q.task_done()

    def _one(self, song_id: str) -> None:
        try:
            song = self.lib.get(song_id)
        except KeyError:
            return  # 그사이 지워진 곡
        folder = self.lib.folder(song_id)
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

        last = [0.0]

        def on_progress(p: float) -> None:
            if p - last[0] >= 0.01:  # 1%마다만 저장
                last[0] = p
                self.lib.update(song_id, progress=round(min(p, 0.99), 2))

        self.lib.update(song_id, status="separating", progress=0.0)
        try:
            stems = self.separators[song["mode"]](src, folder, song["duration"], on_progress)
        except Exception as e:
            log.exception("분리 실패 %s", song_id)
            self.lib.update(song_id, status="failed", error=str(e) or e.__class__.__name__)
            return
        self.lib.update(song_id, status="ready", progress=1.0, stems=stems, error=None)
