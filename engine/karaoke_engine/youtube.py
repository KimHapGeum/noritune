"""유튜브: 검색, 영상 제목 분류(기획서 F12), 가수·제목 추정, 받기. yt-dlp 실행 파일을 쓴다."""
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_ID = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{11})")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# 제목에 이런 말이 있으면 화면에 가사가 들어 있는 노래방 영상
KARAOKE_WORDS = ["노래방", "tj karaoke", "karaoke", "가라오케", "금영", "ky karaoke", "[ky", "(ky"]
# 꾸밈말: 가수·제목 추정과 가사 검색 전에 지운다
_DECOR = re.compile(
    r"\[[^\]]*\]|\([^)]*\)|【[^】]*】|official\s*(music\s*)?(video|audio|mv)|m/?v|lyrics?|가사|inst(rumental)?\.?|"
    r"\bmr\b|노래방|karaoke|반주|멜로디\s*제거|tj|ky|금영|/.*$",
    re.IGNORECASE,
)


def classify(title: str) -> str:
    """karaoke(가사 있는 노래방 영상) / mr(가사가 있을 수도 있음, 사용자에게 묻는다) / inst(가사 없는 반주) / normal."""
    t = title.lower()
    if any(w in t for w in KARAOKE_WORDS):
        return "karaoke"
    if re.search(r"\bmr\b", t):
        return "mr"
    if re.search(r"\binst(rumental)?\b|\binst\.", t):
        return "inst"
    return "normal"


def clean(text: str) -> str:
    return re.sub(r"\s{2,}", " ", _DECOR.sub(" ", text)).strip(" -–—|·:")


def guess(title: str, channel: str = "") -> tuple[str, str]:
    """영상 제목에서 (제목, 가수)를 어림한다. 노래방 영상은 '제목 - 가수', 나머지는 '가수 - 제목'이 흔하다."""
    kind = classify(title)
    base = clean(title)
    parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", base) if p.strip()]
    if len(parts) >= 2:
        a, b = parts[0], parts[1]
        return (a, b) if kind == "karaoke" else (b, a)
    return base or title, re.sub(r"\s*-\s*Topic$", "", channel or "").strip()


_NOT_MV = re.compile(r"노래방|karaoke|가라오케|\bmr\b|\binst|cover|커버|lyrics?|가사|\blive\b|라이브|reaction|리액션|teaser|티저|"
                     r"behind|비하인드|직캠|fancam|shorts|piano|피아노", re.IGNORECASE)
_MV = re.compile(r"official|\bm/?v\b|뮤직비디오|music video", re.IGNORECASE)


def pick_mv(results: list[dict], artist: str, title: str, keep: int = 3) -> list[str]:
    """검색 결과에서 공식 뮤직비디오 같은 것을 고른다 (기획서 F11). 좋은 순서로 영상 번호를 돌려준다.
    제목에 Official·MV가 있거나 가수 이름의 채널이면 앞으로, 노래방·커버·라이브 같은 것은 뺀다. 곡 길이는 보지 않는다."""
    a = re.sub(r"\s", "", artist).lower()
    t = re.sub(r"\s", "", title).lower()
    scored = []
    for i, r in enumerate(results):
        name = r.get("title") or ""
        if _NOT_MV.search(name):
            continue
        flat = re.sub(r"\s", "", name).lower()
        ch = re.sub(r"\s", "", r.get("channel") or "").lower()
        score = 2 * bool(_MV.search(name)) + 2 * bool(a and a in ch) + bool(t and t in flat) + bool(a and a in flat)
        scored.append((-score, i, r["id"]))
    return [vid for _, _, vid in sorted(scored)[:keep]]


def video_id(text: str) -> str | None:
    text = text.strip()
    if VIDEO_ID.match(text):
        return text
    m = _URL_ID.search(text)
    return m.group(1) if m else None


def yt_dlp() -> str:
    # shortcut: 개발 PC의 PATH 또는 %LOCALAPPDATA%\Noritune\bin 의 yt-dlp.exe 를 쓴다.
    # 설치판에서는 처음 쓸 때 받아 두고 일주일마다 -U 로 업데이트한다 (기획서 F18)
    local = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Noritune" / "bin" / "yt-dlp.exe"
    exe = str(local) if local.exists() else shutil.which("yt-dlp")
    if not exe:
        raise RuntimeError("yt-dlp를 찾을 수 없어요")
    return exe


def _js_args() -> list[str]:
    """유튜브는 JavaScript 실행기가 없으면 막는 일이 잦다. deno(기본) 또는 node가 있으면 쓴다.
    shortcut: 둘 다 없는 PC는 실행기 없이 받는다. 설치판에 deno를 함께 넣을지 출시 전에 정한다."""
    if shutil.which("deno"):
        return []
    node = shutil.which("node")
    return ["--js-runtimes", f"node:{node}"] if node else []


def _item(d: dict) -> dict:
    title = d.get("title") or ""
    channel = d.get("channel") or d.get("uploader") or ""
    t, a = guess(title, channel)
    return {
        "id": d["id"],
        "title": title,
        "channel": channel,
        "duration": d.get("duration") or 0,
        "thumbnail": f"https://i.ytimg.com/vi/{d['id']}/mqdefault.jpg",
        "kind": classify(title),
        "guess": {"title": t, "artist": a},
    }


def search(query: str, karaoke_only: bool = False, count: int = 5) -> list[dict]:
    """검색어 또는 유튜브 주소로 찾는다."""
    vid = video_id(query)
    if vid:
        target = [f"https://www.youtube.com/watch?v={vid}", "--no-playlist"]
    else:
        q = f"{query} 노래방 MR" if karaoke_only else query
        target = [f"ytsearch{count}:{q}", "--flat-playlist"]
    out = subprocess.run([yt_dlp(), "--dump-json", "--no-warnings", *_js_args(), *target], capture_output=True, text=True,
                         encoding="utf-8", timeout=60, creationflags=_NO_WINDOW)
    if out.returncode != 0 and not out.stdout.strip():
        raise RuntimeError("유튜브에서 찾지 못했어요")
    items = [json.loads(line) for line in out.stdout.splitlines() if line.startswith("{")]
    return [_item(d) for d in items if d.get("id")]


_PCT = re.compile(r"(\d+(?:\.\d+)?)%")


def download(vid: str, folder: Path, with_video: bool, on_progress) -> dict:
    """소리(original.m4a)와, with_video면 영상(video.mp4)까지 받는다."""
    if not VIDEO_ID.match(vid):
        raise ValueError("유튜브 영상 번호가 아니에요")
    url = f"https://www.youtube.com/watch?v={vid}"
    fmt = "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" if with_video else "ba[ext=m4a]/ba"
    target = folder / ("video.%(ext)s" if with_video else "download.%(ext)s")
    cmd = [yt_dlp(), "--no-playlist", "--no-warnings", "--newline", *_js_args(), "-f", fmt, "-o", str(target), url]
    if with_video:
        cmd[1:1] = ["--merge-output-format", "mp4"]
    errors = []
    for attempt in range(3):  # 유튜브가 가끔 403을 돌려준다. 잠깐 쉬고 다시 받으면 대개 된다
        if attempt:
            time.sleep(2 * attempt)
        for leftover in folder.glob("video.*" if with_video else "download.*"):
            leftover.unlink()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                errors="replace", creationflags=_NO_WINDOW)
        tail = []
        for line in proc.stdout:
            tail = (tail + [line.strip()])[-5:]
            m = _PCT.search(line)
            if m and "[download]" in line:
                on_progress(float(m.group(1)) / 100)
        if proc.wait() == 0:
            break
        errors = [t for t in tail if "ERROR" in t]
    else:
        raise RuntimeError("유튜브에서 받지 못했어요: " + " / ".join(errors)[:200])

    from .separate import _ffmpeg  # ffmpeg 위치는 한곳에서 정한다

    got = next(folder.glob("video.*" if with_video else "download.*"))
    audio = folder / "original.m4a"
    # 영상에서 소리만 떼거나(복사), 받은 소리를 m4a로 맞춘다
    codec = ["-c:a", "copy"] if got.suffix in (".m4a", ".mp4") else ["-c:a", "aac", "-b:a", "192k"]
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-i", str(got), "-vn", *codec, str(audio)],
                   check=True, creationflags=_NO_WINDOW)
    if not with_video:
        got.unlink()
    return {"file": audio.name, "video": got.name if with_video else None}
