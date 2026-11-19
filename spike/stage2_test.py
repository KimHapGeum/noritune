"""두 단계 처리의 2단계(뺀 목소리 → 코러스만 고르기)를 여러 노래방 모델로 돌려 web 폴더에 chorus_<id>.wav로 쓴다.
사용: python stage2_test.py <1단계 보컬.wav> <작업폴더> <web폴더>"""
import json
import sys
import time
from pathlib import Path

from audio_separator.separator import Separator

voc, work, web = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
MODELS = [
    ("I2", "becruily (Mel)", "mel_band_roformer_karaoke_becruily.ckpt"),
    ("I3", "frazer·becruily (BS)", "bs_roformer_karaoke_frazer_becruily.ckpt"),
    ("I4", "anvuew (BS)", "bs_roformer_karaoke_anvuew.ckpt"),
]
sep = Separator(output_dir=str(work), output_format="WAV")
choruses = [{"id": "I", "name": "aufr33·viperx (Mel)", "file": "track_I.wav", "secs": 52.2}]
for cid, name, model in MODELS:
    try:
        sep.load_model(model_filename=model)
        t = time.perf_counter()
        files = [work / f for f in sep.separate(voc)]
        secs = round(time.perf_counter() - t, 1)
        # 이름 맨 뒤 표시가 (Instrumental)인 쪽 = 주 목소리를 뺀 나머지 = 코러스
        back = [f for f in files if f.name.lower().rfind("(instrumental)") > f.name.lower().rfind("(vocals)")]
        assert len(back) == 1, files
        (web / f"chorus_{cid}.wav").write_bytes(back[0].read_bytes())
        choruses.append({"id": cid, "name": name, "file": f"chorus_{cid}.wav", "secs": secs})
        print(f"{cid} {name}: {secs}초", flush=True)
    except Exception as e:
        print(f"실패 {model}: {e}", flush=True)
(web / "choruses.json").write_text(json.dumps(choruses, ensure_ascii=False, indent=1), encoding="utf-8")
print("완료", flush=True)
