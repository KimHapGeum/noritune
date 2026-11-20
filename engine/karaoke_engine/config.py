"""저장 폴더 위치 (기획서 6장: 설정에서 바꿀 수 있다). 저장 폴더 안에 두면 폴더를 옮길 때 같이 옮겨 가므로 밖에 둔다."""
import json
import os
from pathlib import Path


def config_path() -> Path:
    # NORITUNE_CONFIG: 시험할 때 실제 설정 대신 쓸 파일
    return Path(os.environ.get("NORITUNE_CONFIG") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Noritune" / "config.json")


def data_dir() -> Path:
    """KARAOKE_DATA_DIR(시험용) > 설정 파일 > 문서\\Noritune"""
    if os.environ.get("KARAOKE_DATA_DIR"):
        return Path(os.environ["KARAOKE_DATA_DIR"])
    try:
        return Path(json.loads(config_path().read_text(encoding="utf-8"))["data_dir"])
    except (FileNotFoundError, ValueError, KeyError, TypeError):
        return Path.home() / "Documents" / "Noritune"


def set_data_dir(path: Path) -> None:
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"data_dir": str(path)}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)
