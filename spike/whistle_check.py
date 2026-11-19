"""휘파람 같은 좁은 고음(지속되는 날카로운 주파수 봉우리)을 원곡과 비교해 찾는다.
사용: python whistle_check.py <원곡> <비교 파일>...
원곡보다 봉우리가 크게 솟은 주파수 = 분리 과정에서 생긴 소리 후보."""
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio


def spectrum(path, sr_out=44100):
    """평균 크기 스펙트럼(dB)과 시간별 스펙트로그램."""
    if path.lower().endswith(".mp3"):
        w, sr = torchaudio.load(path)
        x = w.mean(0).numpy()
    else:
        x, sr = sf.read(path, dtype="float32")
        x = x.mean(axis=1) if x.ndim > 1 else x
    if sr != sr_out:  # 원곡 48kHz, 분리 결과 44.1kHz
        x = torchaudio.functional.resample(torch.from_numpy(np.ascontiguousarray(x)), sr, sr_out).numpy()
    S = torch.stft(torch.from_numpy(x), 4096, 1024, window=torch.hann_window(4096), return_complex=True).abs().numpy()
    return 20 * np.log10(S + 1e-7)  # (주파수, 시간)


ref = spectrum(sys.argv[1])
freqs = np.fft.rfftfreq(4096, 1 / 44100)
for p in sys.argv[2:]:
    S = spectrum(p)
    n = min(S.shape[1], ref.shape[1])
    diff = S[:, :n] - ref[:, :n]  # 원곡보다 커진 정도
    # 원곡보다 10dB 이상 큰 칸이 많은 2kHz 이상 주파수
    hot = ((diff > 10) & (S[:, :n] > -60)).mean(axis=1)
    band = freqs > 2000
    idx = np.argsort(-hot * band)[:5]
    secs = [(diff[i] > 10).sum() * 1024 / 44100 for i in idx]
    print(f"{p.split('/')[-1][:60]}")
    for i, s in zip(idx, secs):
        print(f"   {freqs[i]:7.0f}Hz  원곡보다 10dB↑ 구간 {s:5.1f}초 ({hot[i]:.1%})")
