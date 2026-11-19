"""보컬이 나오는 구간에서 반주가 거의 비는 비율을 잰다. 사용: python silence_check.py <분리 폴더(vocals.wav, no_vocals.wav)>"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

d = Path(sys.argv[1])
v, sr = sf.read(d / "vocals.wav")
a, _ = sf.read(d / "no_vocals.wav")
win = sr // 2  # 0.5초 창


def db(x):
    n = len(x) // win
    r = np.sqrt((x[: n * win].mean(axis=1).reshape(n, win) ** 2).mean(axis=1))
    return 20 * np.log10(r + 1e-9)


vd, ad = db(v), db(a)
sing = vd > -35  # 노래하는 창
quiet = sing & (ad < -40)  # 노래하는데 반주가 거의 없는 창
print(f"노래 구간 {sing.sum() * 0.5:.0f}초 중 반주가 거의 빈 곳 {quiet.sum() * 0.5:.0f}초 ({quiet.sum() / max(sing.sum(), 1):.0%})")
print(f"반주 평균 {ad[sing].mean():.1f}dB, 보컬 평균 {vd[sing].mean():.1f}dB")
