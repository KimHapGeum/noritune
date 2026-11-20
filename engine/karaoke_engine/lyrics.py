"""가사 (기획서 F4): 인터넷(LRCLIB) 후보 찾기, LRC 읽고 쓰기, 음성 인식 자동 생성."""
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

LRCLIB = "https://lrclib.net/api/search"
_LINE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)")
# 음성 인식이 조용한 곳에서 지어내는 말 (시험에서 곡 끝에 나왔다)
HALLUCINATIONS = ["다음 영상에서 만나요", "시청해 주셔서", "구독과 좋아요", "구독 좋아요", "감사합니다", "MBC 뉴스", "자막 제공"]


def parse_lrc(text: str) -> list[dict]:
    """'[mm:ss.xx] 가사' 줄들을 [{"t": 시작초, "text": 가사, "e": 끝초(있으면)}]로.
    가사 없이 시간만 있는 줄은 바로 앞 줄이 끝나는 때로 읽는다 (LRC에서 흔한 쓰는 법)."""
    marks = []
    for raw in text.splitlines():
        m = _LINE.match(raw.strip())
        if m:
            marks.append((round(int(m.group(1)) * 60 + float(m.group(2)), 2), m.group(3).strip()))
    marks.sort(key=lambda x: x[0])
    lines: list[dict] = []
    for t, txt in marks:
        if txt:
            lines.append({"t": t, "text": txt})
        elif lines and "e" not in lines[-1] and t > lines[-1]["t"]:
            lines[-1]["e"] = t
    return lines


def _ts(t: float) -> str:
    return f"[{int(t // 60):02d}:{t % 60:05.2f}]"


def to_lrc(lines: list[dict]) -> str:
    """끝 시간이 있으면 다음 줄 시작 전에 빈 시간 줄로 적는다 (다른 플레이어도 그대로 읽는다)"""
    out = []
    for i, x in enumerate(lines):
        out.append(f"{_ts(x['t'])} {x['text']}")
        e = x.get("e")
        nxt = lines[i + 1]["t"] if i + 1 < len(lines) else None
        if e is not None and e > x["t"] and (nxt is None or e < nxt):
            out.append(_ts(e))
    return "\n".join(out) + "\n"


def _get(params: dict) -> list[dict]:
    url = LRCLIB + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Noritune/0.1"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def _norm(s: str) -> str:
    """비교용: 소문자, 글자·숫자만 (띄어쓰기·기호 차이를 없앤다. '우주를줄게' = '우주를 줄게')."""
    return re.sub(r"[\W_]+", "", s.lower())


def search(title: str, artist: str, duration: float) -> list[dict]:
    """후보를 찾아 추천 순으로 돌려준다: 시간 맞춘 가사 → 제목·가수가 맞는 것 → 곡 길이가 가까운 것."""
    from .youtube import clean

    title, artist = clean(title) or title, clean(artist) or artist
    nt, na = _norm(title), _norm(artist)
    seen, found = set(), []
    # LRCLIB은 띄어쓰기가 다르면 못 찾는다. 넓게 찾고(가수만 등) 아래에서 제목으로 거른다
    queries = [{"track_name": title, "artist_name": artist}, {"q": f"{artist} {title}"}, {"q": artist}] if artist else []
    queries.append({"q": title})
    for q in queries:
        try:
            results = _get(q)
        except Exception:
            continue
        for d in results:
            if d["id"] in seen or d.get("instrumental"):
                continue
            ct = _norm(d.get("trackName", ""))
            if nt and nt not in ct and ct not in nt:
                continue  # 제목이 다른 곡 (가수로 넓게 찾은 결과)
            seen.add(d["id"])
            found.append(d)
    out = []
    for d in found:
        synced = parse_lrc(d.get("syncedLyrics") or "")
        plain = (d.get("plainLyrics") or "").strip()
        out.append({
            "id": d["id"],
            "title": d.get("trackName", ""),
            "artist": d.get("artistName", ""),
            "album": d.get("albumName", ""),
            "duration": round(d.get("duration") or 0, 1),
            "diff": round((d.get("duration") or 0) - duration, 1) if duration else None,
            "synced": bool(synced),
            "lines": synced,
            "plain": plain,
            # 제목이 똑같거나 가수가 맞으면 '확실한' 후보 (IU/아이유처럼 표기가 다르면 확실하지 않다고 본다)
            "sure": _norm(d.get("trackName", "")) == nt
            or (bool(na) and (na in _norm(d.get("artistName", "")) or _norm(d.get("artistName", "")) in na)),
        })
    close = lambda c: c["diff"] is not None and abs(c["diff"]) <= 3  # noqa: E731
    out.sort(key=lambda c: (not c["synced"], not close(c), not c["sure"], abs(c["diff"]) if c["diff"] is not None else 999))
    out = out[:12]
    for i, c in enumerate(out):
        # 첫 후보가 확실하고 길이도 맞을 때만 미리 고른다. 아니면 사용자가 목록에서 고른다
        c["recommended"] = i == 0 and c["synced"] and close(c) and c["sure"]
    return out


_model = None


def auto(src: Path) -> list[dict]:
    """분리한 목소리(없으면 원곡)를 받아 적어 시간 맞춘 가사를 만든다."""
    global _model
    import numpy as np
    import soundfile as sf
    from faster_whisper import WhisperModel

    from .separate import _as_wav, _clean_work, _lock

    with _lock:  # 그래픽카드를 분리와 나눠 쓰지 않는다
        _clean_work()
        wav = _as_wav(src)
        audio, sr = sf.read(wav, dtype="float32")
        _clean_work()
        audio = audio.mean(axis=1) if audio.ndim > 1 else audio
        # 44.1kHz → 16kHz (whisper 입력). 간단한 선형 보간으로 충분하다
        n = int(len(audio) * 16000 / sr)
        audio16 = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype("float32")
        if _model is None:
            # faster-whisper(ctranslate2)는 cuBLAS·cuDNN을 PATH에서 찾는다. PyTorch에 들어 있는 것을 쓰게 한다
            # (개발 PC는 다른 앱이 PATH에 넣어 둬서 됐지만, 다른 PC에서는 "cublas64_12.dll is not found")
            import torch
            os.environ["PATH"] = str(Path(torch.__file__).parent / "lib") + os.pathsep + os.environ.get("PATH", "")
            try:
                _model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
            except Exception:
                _model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
        segs, _ = _model.transcribe(audio16, language="ko", vad_filter=True, condition_on_previous_text=False,
                                    word_timestamps=True)
        segs = list(segs)
    lines = []
    for s in segs:
        text = s.text.strip()
        if not text or s.no_speech_prob > 0.6 or s.avg_logprob < -1.0:
            continue
        if any(h in text for h in HALLUCINATIONS):
            continue
        words = [(float(w.start), float(w.end), w.word) for w in (s.words or [])]  # numpy 숫자를 보통 숫자로
        lines += split_words(words) or [{"t": round(float(s.start), 2), "text": text}]
    return lines


MAX_LINE = 16  # 노래방 화면 한 줄에 알맞은 글자 수 (띄어쓰기 빼고)


def split_words(words: list[tuple[float, float, str]], gap: float = 0.6) -> list[dict]:
    """음성 인식 낱말들을 노래방 한 줄 길이로 나눈다: 쉬는 틈이 gap초를 넘거나 글자가 MAX_LINE을 넘으면 새 줄."""
    lines, cur, start, last_end = [], [], None, None
    for st, en, w in words:
        w = w.strip()
        if not w:
            continue
        length = sum(len(x) for x in cur)
        if cur and (st - last_end > gap or length + len(w) > MAX_LINE):
            lines.append({"t": round(start, 2), "text": " ".join(cur), "e": round(last_end, 2)})
            cur = []
        if not cur:
            start = st
        cur.append(w)
        last_end = en
    if cur:
        lines.append({"t": round(start, 2), "text": " ".join(cur), "e": round(last_end, 2)})
    return lines
