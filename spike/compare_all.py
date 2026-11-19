"""노래방 모델 후보를 모두 돌려 반주를 web 폴더에 쓰고 tracks.json을 만든다.
사용: python compare_all.py <입력.mp3> <작업폴더> <web폴더>
이미 만든 반주(A Demucs, B aufr33)는 web 폴더의 track.wav, track_karaoke.wav를 그대로 쓴다."""
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from audio_separator.separator import Separator

src, work, web = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
work.mkdir(parents=True, exist_ok=True)
GUIDE = web / "guide_vocal.wav"  # 노래 구간 판정용 (aufr33 주 목소리)

KARAOKE = [  # (id, 이름, 모델 파일)
    ("C", "Mel-Roformer 노래방 v2 (Gabox)", "mel_band_roformer_karaoke_gabox_v2.ckpt"),
    ("D", "Mel-Roformer 노래방 (becruily)", "mel_band_roformer_karaoke_becruily.ckpt"),
    ("E", "BS-Roformer 노래방 (frazer·becruily)", "bs_roformer_karaoke_frazer_becruily.ckpt"),
    ("F", "BS-Roformer 노래방 (anvuew)", "bs_roformer_karaoke_anvuew.ckpt"),
]
VOCAL_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"  # 두 단계 처리 1단계: 목소리 전부 빼기
LEAD_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"  # 2단계: 뺀 목소리에서 코러스 고르기


def quiet_pct(inst_path):
    """노래하는(가이드 보컬 > -35dB) 0.5초 창 중 반주가 -40dB 아래인 비율."""
    v, sr = sf.read(GUIDE)
    a, _ = sf.read(inst_path)
    win = sr // 2

    def db(x):
        x = x.mean(axis=1) if x.ndim > 1 else x
        n = len(x) // win
        return 20 * np.log10(np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(axis=1)) + 1e-9)

    vd, ad = db(v), db(a)
    n = min(len(vd), len(ad))
    sing = vd[:n] > -35
    return round(100 * float((sing & (ad[:n] < -40)).sum()) / max(int(sing.sum()), 1), 1)


def split(sep, model, path):
    """모델로 나누고 (보컬 파일, 반주 파일, 분리 초)를 돌려준다. 출력 이름 규칙이 모델마다 달라 보컬만 이름으로 찾는다."""
    sep.load_model(model_filename=model)
    t = time.perf_counter()
    files = [work / f for f in sep.separate(str(path))]
    secs = round(time.perf_counter() - t, 1)
    print(f"  {model}: {secs}초 -> {[f.name for f in files]}", flush=True)
    # 입력 이름에 앞 단계의 "(Vocals)"가 남을 수 있어, 이름 맨 뒤의 표시로 판단한다
    voc = [f for f in files if f.name.lower().rfind("(vocals)") > f.name.lower().rfind("(instrumental)")]
    assert len(files) == 2 and len(voc) == 1, f"출력 파일을 구분 못 함: {files}"
    inst = next(f for f in files if f != voc[0])
    return voc[0], inst, secs


sep = Separator(output_dir=str(work), output_format="WAV")
tracks = [
    {"id": "A", "name": "Demucs (목소리 전부 빼기)", "file": "track.wav", "secs": 20.1},
    {"id": "B", "name": "Mel-Roformer 노래방 (aufr33·viperx)", "file": "track_karaoke.wav", "secs": 55.1},
]
for tid, name, model in KARAOKE:
    try:
        _, inst, secs = split(sep, model, src)
    except Exception as e:  # 한 모델이 실패해도 나머지는 비교한다
        print(f"  실패 {model}: {e}", flush=True)
        continue
    out = web / f"track_{tid}.wav"
    out.write_bytes(inst.read_bytes())
    tracks.append({"id": tid, "name": name, "file": out.name, "secs": secs})

# G: 두 단계 처리 = 목소리 전부 뺀 반주 + 뺀 목소리 중 코러스
try:
    voc, inst, s1 = split(sep, VOCAL_MODEL, src)
    _, backing, s2 = split(sep, LEAD_MODEL, voc)  # 노래방 모델의 "반주" 쪽 = 주 목소리를 뺀 코러스
    a, sr = sf.read(inst)
    b, _ = sf.read(backing)
    n = min(len(a), len(b))
    mix = a[:n] + b[:n]
    peak = np.abs(mix).max()
    if peak > 1:
        mix /= peak  # 더해서 넘치는 경우만 줄인다
    sf.write(web / "track_G.wav", mix, sr)
    tracks.append({"id": "G", "name": "두 단계 (BS-Roformer 목소리 빼기 + 코러스 되살리기)", "file": "track_G.wav", "secs": round(s1 + s2, 1)})
except Exception as e:
    print(f"  실패 두 단계: {e}", flush=True)

for t in tracks:
    t["quiet"] = quiet_pct(web / t["file"])
    print(f"{t['id']} {t['name']}: 분리 {t['secs']}초, 빈 구간 {t['quiet']}%", flush=True)
(web / "tracks.json").write_text(json.dumps(tracks, ensure_ascii=False, indent=1), encoding="utf-8")
print("완료", flush=True)
