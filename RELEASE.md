# 새 버전 내보내기

소스는 비공개 저장소 `KimHapGeum/noritune`, 설치 파일과 `latest.json`은 공개 저장소 `KimHapGeum/noritune-update`의 릴리스에 둔다.
앱은 `https://github.com/KimHapGeum/noritune-update/releases/latest/download/latest.json`을 읽어 새 버전을 확인한다.

## 비밀 열쇠
- 업데이트 서명 열쇠: `~/.tauri/noritune.key` (공개 열쇠는 `tauri.conf.json`의 `plugins.updater.pubkey`)
- **저장소에 절대 올리지 않는다.** 잃어버리면 이미 설치된 앱에 업데이트를 보낼 수 없으니 따로 백업해 둔다.

## 순서
1. 버전 올리기: `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json`의 `version`
2. 처리기 묶기 (`engine/`에서, 가상환경은 `UV_PROJECT_ENVIRONMENT=~/.venvs/karaoke-engine`):
   `uv run pyinstaller run_engine.py --name noritune-engine --onedir --noconfirm --console --distpath ~/.cache/karaoke/pyinstaller/dist --workpath ~/.cache/karaoke/pyinstaller/build --specpath ~/.cache/karaoke/pyinstaller --collect-submodules uvicorn`
3. 설치 파일 빌드 (`app/`에서, PowerShell):
   `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~/.tauri/noritune.key -Raw; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''; npx tauri build`
   → `~/.cache/karaoke/target/release/bundle/nsis/Noritune_<버전>_x64-setup.exe` 와 `.sig`
4. 설치해 보고 곡 추가·재생 확인 (`/S`로 조용히 설치, `uninstall.exe /S`로 지우기)
5. `python scripts/make_latest_json.py <버전> "<바뀐 내용>" <설치파일.exe> latest.json`
6. 공개 저장소에 릴리스: `gh release create v<버전> <설치파일.exe> latest.json -R KimHapGeum/noritune-update -t "Noritune <버전>" -n "<바뀐 내용>"`
   설치 파일과 latest.json을 같은 릴리스에 함께 올린다 (latest.json의 주소가 그 릴리스를 가리킨다)
7. 공개 저장소에 커밋할 일이 있으면 GitHub 비공개용 메일 `268497351+KimHapGeum@users.noreply.github.com`으로 커밋한다
