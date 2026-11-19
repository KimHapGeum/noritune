"""Demucs 보컬 분리 시간 재기. 사용: python separate_test.py <입력.mp3> <출력폴더> <cuda|cpu>"""
import subprocess
import sys
import time
from pathlib import Path

src, out, device = sys.argv[1], sys.argv[2], sys.argv[3]
t = time.perf_counter()
# demucs CLI를 같은 파이썬으로 실행: 반주(no_vocals)와 보컬 두 줄로 나눈다
subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs",
                "-d", device, "-o", out, src], check=True)
elapsed = time.perf_counter() - t
stems = list(Path(out).rglob("*.wav"))
assert {p.stem for p in stems} >= {"vocals", "no_vocals"}, f"결과 파일 없음: {stems}"
print(f"\n[{device}] 분리 {elapsed:.1f}초  결과: {[str(p) for p in stems]}")
