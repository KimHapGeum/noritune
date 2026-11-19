"""PyInstaller 진입점 (패키지 밖에서 karaoke_engine 을 불러야 상대 import 가 된다)."""
from karaoke_engine.__main__ import main

main()
