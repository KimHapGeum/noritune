"""노래방 모델(주 목소리만 빼기) 분리 시간 재기. 사용: python karaoke_test.py <입력> <출력폴더> <모델파일명>..."""
import sys
import time

from audio_separator.separator import Separator

src, out, models = sys.argv[1], sys.argv[2], sys.argv[3:]
sep = Separator(output_dir=out, output_format="WAV")
for m in models:
    t = time.perf_counter()
    sep.load_model(model_filename=m)
    load = time.perf_counter() - t
    files = sep.separate(src)
    print(f"\n[{m}] 모델 준비 {load:.1f}초, 분리 {time.perf_counter() - t - load:.1f}초 -> {files}")
