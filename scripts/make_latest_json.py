"""업데이트 정보 파일(latest.json) 만들기. 앱은 공개 저장소 릴리스의 이 파일을 읽어 새 버전을 확인한다.

사용: python scripts/make_latest_json.py <버전> "<바뀐 내용>" <설치파일.exe> <출력 latest.json>
설치 파일 옆의 .sig(서명)를 읽어 넣는다. 다운로드 주소는 공개 저장소 noritune-update 의 v<버전> 릴리스."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

version, notes, setup, out = sys.argv[1], sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
assert setup.is_file(), f"설치 파일 없음: {setup}"
sig = setup.with_name(setup.name + ".sig")
assert sig.is_file(), f"서명 파일 없음: {sig} (TAURI_SIGNING_PRIVATE_KEY 를 넣고 빌드했는지 확인)"
assert version in setup.name, f"버전 {version} 이 설치 파일 이름 {setup.name} 과 다름"

data = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/KimHapGeum/noritune-update/releases/download/v{version}/{setup.name}",
        }
    },
}
out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"만듦: {out}")
