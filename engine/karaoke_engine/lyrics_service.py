"""곡마다 가사 상태를 관리한다 (기획서 F4).

상태(lyrics.state): searching(찾는 중) → review(후보를 찾음, 사용자가 골라야 함) → internet(고름)
                    / generating(자동 생성 중) → auto / file(곡 옆 .lrc) / none(없음) / off(노래방 영상: 앱 가사 끔)
가사는 곡 폴더의 lyrics.lrc, 후보는 lyrics_candidates.json 에 둔다.
review 상태에서도 추천 후보가 있으면 lyrics.lrc 에 임시로 넣어 바로 부를 수 있게 한다."""
import json
import logging
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .library import Library
from .lyrics import parse_lrc, to_lrc

log = logging.getLogger("karaoke_engine.lyrics")


class LyricsService:
    def __init__(self, lib: Library, search):
        self.lib = lib
        self.search_fn = search
        self.pool = ThreadPoolExecutor(2, thread_name_prefix="lyrics")  # 인터넷 검색만 한다 (가볍다)
        for s in lib.list():  # 지난번에 찾다 만 곡
            if (s.get("lyrics") or {}).get("state") == "searching":
                self.start(s["id"])

    def _paths(self, song_id: str) -> tuple[Path, Path]:
        folder = self.lib.folder(song_id)
        return folder / "lyrics.lrc", folder / "lyrics_candidates.json"

    def on_added(self, song: dict, source_file: str | None = None) -> None:
        """곡을 추가했을 때: 노래방 영상은 끄고, 곡 옆에 .lrc가 있으면 그것을, 아니면 인터넷에서 찾는다."""
        if song.get("app_lyrics") is False:
            self.lib.update(song["id"], lyrics={"state": "off"})
            return
        if source_file:
            side = Path(source_file).with_suffix(".lrc")
            if side.is_file() and parse_lrc(side.read_text(encoding="utf-8", errors="replace")):
                shutil.copyfile(side, self._paths(song["id"])[0])
                self.lib.update(song["id"], lyrics={"state": "file"})
                return
        self.start(song["id"])

    def start(self, song_id: str, title: str | None = None, artist: str | None = None) -> None:
        self.lib.update(song_id, lyrics={"state": "searching"})
        self.pool.submit(self._search, song_id, title, artist)

    def _search(self, song_id: str, title: str | None, artist: str | None) -> None:
        try:
            song = self.lib.get(song_id)
            cands = self.search_fn(title or song["title"], artist if artist is not None else song["artist"],
                                   song["duration"])
        except Exception:
            log.exception("가사 검색 실패 %s", song_id)
            cands = []
        lrc, cand_file = self._paths(song_id)
        cand_file.write_text(json.dumps(cands, ensure_ascii=False), encoding="utf-8")
        rec = next((c for c in cands if c.get("recommended")), None)
        if rec and not lrc.exists():
            lrc.write_text(to_lrc(rec["lines"]), encoding="utf-8")
        prev = self.lib.get(song_id).get("lyrics") or {}
        if prev.get("state") != "searching":
            return  # 그사이 사용자가 고르거나 자동 생성을 시작했다
        state = "review" if cands else ("none" if not lrc.exists() else prev.get("state", "none"))
        self.lib.update(song_id, lyrics={"state": state, "candidate_id": rec["id"] if rec else None})

    def candidates(self, song_id: str) -> list[dict]:
        f = self._paths(song_id)[1]
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []

    def choose(self, song_id: str, candidate_id: int) -> None:
        cand = next((c for c in self.candidates(song_id) if c["id"] == candidate_id), None)
        if cand is None:
            raise KeyError(candidate_id)
        if not cand["synced"]:
            raise ValueError("시간 정보가 없는 가사라 아직 고를 수 없어요")
        self._paths(song_id)[0].write_text(to_lrc(cand["lines"]), encoding="utf-8")
        self.lib.update(song_id, lyrics={"state": "internet", "candidate_id": candidate_id})

    def lines(self, song_id: str) -> list[dict]:
        lrc = self._paths(song_id)[0]
        return parse_lrc(lrc.read_text(encoding="utf-8")) if lrc.exists() else []
