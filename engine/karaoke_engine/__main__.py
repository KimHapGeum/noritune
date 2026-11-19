"""처리기 실행: python -m karaoke_engine --data-dir <저장 폴더> [--port 0]

빈 포트를 골라 열고, 준비되면 표준 출력에 `KARAOKE_ENGINE_READY port=<번호>` 한 줄을 낸다.
Tauri는 이 줄을 읽어 포트를 알아낸다."""
import argparse
import os
import socket
from pathlib import Path

import uvicorn

from .server import create_app


def default_data_dir() -> Path:
    # KARAOKE_DATA_DIR: 시험할 때 실제 저장 폴더 대신 쓸 곳
    return Path(os.environ.get("KARAOKE_DATA_DIR") or Path.home() / "Documents" / "Noritune")


def main() -> None:
    p = argparse.ArgumentParser(prog="karaoke-engine")
    p.add_argument("--data-dir", type=Path, default=default_data_dir())
    p.add_argument("--port", type=int, default=0, help="0이면 빈 포트를 고른다")
    args = p.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))  # 다른 PC에서는 접근 못 하게 127.0.0.1 에만
    sock.listen(128)  # 준비 신호 전에 연결을 받기 시작해야 화면의 첫 요청이 거절되지 않는다
    port = sock.getsockname()[1]

    # 오류는 저장 폴더의 logs/engine.log 에 남긴다 (설정 → 로그 폴더 열기, 기획서 8.1)
    import logging
    from logging.handlers import RotatingFileHandler

    (args.data_dir / "logs").mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(args.data_dir / "logs" / "engine.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.INFO)

    app = create_app(args.data_dir)
    print(f"KARAOKE_ENGINE_READY port={port}", flush=True)
    log_level = os.environ.get("KARAOKE_ENGINE_LOG", "warning")  # 문제 찾을 때 info로
    uvicorn.Server(uvicorn.Config(app, log_level=log_level)).run(sockets=[sock])


if __name__ == "__main__":
    main()
