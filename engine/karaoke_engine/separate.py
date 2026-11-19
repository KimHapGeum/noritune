"""반주 분리. 기획서 F3 (모델과 비율은 12장 시험 결과).

- 빠른 분리: 노래방 모델(aufr33·viperx) 하나로 주 목소리만 뺀다 → 반주 + 가이드 보컬
- 고품질 분리: ① 노래방 모델 v2(Gabox)로 반주 ② BS-Roformer로 목소리 전부 ③ 그 목소리를 aufr33으로
  주 목소리(가이드 보컬)와 코러스로 나눈다 → 반주 + 가이드 보컬 + 코러스
- 반주 알아채기: 곡 가운데 30초를 빠른 모델로 나눠 목소리가 나오는 비율을 잰다
결과는 Opus로 압축해 둔다."""
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

QUICK = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
HQ_INST = "mel_band_roformer_karaoke_gabox_v2.ckpt"
HQ_VOCALS = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
# GPU에서 곡 길이 대비 걸린 시간 (RTX 3080 실측). 진행률 어림에 쓴다. CPU는 6배로 잡는다
SPEED = {QUICK: 0.21, HQ_INST: 0.41, HQ_VOCALS: 0.46}
SINGING_DB = -35  # 이보다 크면 그 0.5초에 목소리가 있다고 본다

_lock = threading.Lock()
_separator = None
_loaded = None
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def model_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Noritune" / "models"


def work_dir() -> Path:
    return model_dir().parent / "work"  # 분리 도구가 결과 wav를 쓰는 고정 폴더


def _ffmpeg() -> str:
    # shortcut: 개발 PC의 PATH에 있는 ffmpeg을 쓴다. 설치 파일을 만들 때 ffmpeg을 함께 넣는다
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg을 찾을 수 없어요")
    return exe


def _gpu() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


def _split(model: str, src: Path) -> tuple[Path, Path]:
    """model로 src를 나눠 (목소리 wav, 나머지 wav)를 작업 폴더에 만든다. _lock 안에서 부른다."""
    global _separator, _loaded
    if _separator is None:
        from audio_separator.separator import Separator  # torch 불러오기가 무거워 처음 쓸 때 부른다

        model_dir().mkdir(parents=True, exist_ok=True)
        work_dir().mkdir(parents=True, exist_ok=True)
        _separator = Separator(output_dir=str(work_dir()), output_format="WAV", model_file_dir=str(model_dir()))
    if _loaded != model:
        _separator.load_model(model_filename=model)
        _loaded = model
    files = [work_dir() / Path(f).name for f in _separator.separate(str(src))]
    # 이름 맨 뒤 표시로 가린다 (두 번째 단계는 입력 이름에 앞 단계 표시가 남아 있다)
    vocals = [f for f in files if f.name.lower().rfind("(vocals)") > f.name.lower().rfind("(instrumental)")]
    if len(files) != 2 or len(vocals) != 1:
        raise RuntimeError(f"분리 결과를 알아볼 수 없어요: {[f.name for f in files]}")
    return vocals[0], next(f for f in files if f != vocals[0])


def _clean_work() -> None:
    work_dir().mkdir(parents=True, exist_ok=True)
    for old in work_dir().glob("*"):
        old.unlink()


def _as_wav(src: Path) -> Path:
    """분리 도구(libsndfile)는 m4a·webm 등을 못 읽는다. 작업 폴더에 wav로 바꿔 둔다. _lock 안에서 부른다."""
    wav = work_dir() / "input.wav"
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100", str(wav)],
                   check=True, creationflags=_NO_WINDOW)
    return wav


def _to_opus(wav: Path, out: Path) -> None:
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "libopus", "-b:a", "160k", str(out)],
                   check=True, creationflags=_NO_WINDOW)


class _Progress:
    """분리 도구가 진행률을 알려 주지 않아, 단계별 예상 시간으로 0~0.9를 채운다."""

    def __init__(self, on_progress, duration: float, models: list[str]):
        factor = 1 if _gpu() else 6
        self.est = [duration * SPEED[m] * factor + 3 for m in models]
        self.total = sum(self.est)
        self.on_progress = on_progress
        self.done_before = 0.0
        self.step_start = time.monotonic()
        self.step = 0
        self.stop = threading.Event()
        threading.Thread(target=self._tick, daemon=True).start()

    def _tick(self):
        while not self.stop.wait(1.0):
            cur = min(1.0, (time.monotonic() - self.step_start) / self.est[self.step])
            self.on_progress(0.9 * (self.done_before + cur * self.est[self.step]) / self.total)

    def next(self):
        self.done_before += self.est[self.step]
        self.step = min(self.step + 1, len(self.est) - 1)
        self.step_start = time.monotonic()


def quick(src: Path, out_dir: Path, duration: float, on_progress) -> dict:
    prog = _Progress(on_progress, duration, [QUICK])
    try:
        with _lock:
            _clean_work()
            vocals, inst = _split(QUICK, _as_wav(src))
    finally:
        prog.stop.set()
    on_progress(0.92)
    _to_opus(inst, out_dir / "instrumental.ogg")
    _to_opus(vocals, out_dir / "vocals.ogg")
    _clean_work()
    return {"instrumental": "instrumental.ogg", "vocals": "vocals.ogg"}


def hq(src: Path, out_dir: Path, duration: float, on_progress) -> dict:
    prog = _Progress(on_progress, duration, [HQ_INST, HQ_VOCALS, QUICK])
    try:
        with _lock:
            _clean_work()
            wav = _as_wav(src)
            _, inst = _split(HQ_INST, wav)  # ① 반주 (코러스가 남은 노래방 반주)
            _to_opus(inst, out_dir / "instrumental.ogg")
            prog.next()
            all_vocals, _ = _split(HQ_VOCALS, wav)  # ② 목소리 전부
            prog.next()
            lead, chorus = _split(QUICK, all_vocals)  # ③ 주 목소리 / 코러스
    finally:
        prog.stop.set()
    on_progress(0.94)
    _to_opus(lead, out_dir / "vocals.ogg")
    _to_opus(chorus, out_dir / "chorus.ogg")
    _clean_work()
    return {"instrumental": "instrumental.ogg", "vocals": "vocals.ogg", "chorus": "chorus.ogg"}


def singing_ratio(src: Path, duration: float) -> float:
    """곡 가운데 30초에서 목소리가 나오는 0.5초 구간의 비율 (0~1). 반주(MR)면 0에 가깝다."""
    import numpy as np
    import soundfile as sf

    with _lock:
        _clean_work()
        clip = work_dir() / "clip.wav"
        start = max(0.0, duration / 2 - 15)
        subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-ss", f"{start:.1f}", "-t", "30", "-i", str(src),
                        "-ac", "2", "-ar", "44100", str(clip)], check=True, creationflags=_NO_WINDOW)
        vocals, _ = _split(QUICK, clip)
        v, sr = sf.read(vocals)
        _clean_work()
    v = v.mean(axis=1) if v.ndim > 1 else v
    win = sr // 2
    n = len(v) // win
    if n == 0:
        return 0.0
    db = 20 * np.log10(np.sqrt((v[: n * win].reshape(n, win) ** 2).mean(axis=1)) + 1e-9)
    return float((db > SINGING_DB).mean())
