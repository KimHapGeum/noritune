"""분리한 보컬로 시간 맞춘 가사 만들기. 사용: python whisper_test.py <vocals.wav> <출력.lrc>"""
import sys
import time

import soundfile as sf
import torch
import torchaudio
from faster_whisper import WhisperModel

src, out = sys.argv[1], sys.argv[2]
t = time.perf_counter()
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
load = time.perf_counter() - t
# faster-whisper의 PyAV 디코딩이 새 av와 안 맞아, 16kHz 모노로 직접 읽어 넘긴다
wav, sr = sf.read(src, dtype="float32")
audio = torchaudio.functional.resample(torch.from_numpy(wav.mean(axis=1) if wav.ndim > 1 else wav), sr, 16000).numpy()
segs, info = model.transcribe(audio, language="ko", vad_filter=True, word_timestamps=True)
lines = [f"[{int(s.start // 60):02d}:{s.start % 60:05.2f}] {s.text.strip()}" for s in segs]
total = time.perf_counter() - t
with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("\n".join(lines))
print(f"\n모델 준비 {load:.1f}초, 전체 {total:.1f}초, {len(lines)}줄 -> {out}")
