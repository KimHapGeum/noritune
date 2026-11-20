# 새 버전 내보내기

소스는 비공개 저장소 `KimHapGeum/noritune`, 설치 파일과 `latest.json`은 공개 저장소 `KimHapGeum/noritune-update`의 릴리스에 둔다.
앱은 `https://github.com/KimHapGeum/noritune-update/releases/latest/download/latest.json`을 읽어 새 버전을 확인한다.

## 비밀 열쇠
- 업데이트 서명 열쇠: `~/.tauri/noritune.key` (공개 열쇠는 `tauri.conf.json`의 `plugins.updater.pubkey`)
- **저장소에 절대 올리지 않는다.** 잃어버리면 이미 설치된 앱에 업데이트를 보낼 수 없으니 따로 백업해 둔다.

## 오픈 소스 라이선스
- 남의 코드를 앱에 넣으면 라이선스 전문을 세 곳에 둔다: `app/src/licenses/<이름>.txt`(앱 설정 → 정보, 설치 폴더 `licenses/`로 자동 포함), `README.md`의 "오픈 소스 라이선스", `Settings.tsx`의 `NAMES`(보이는 이름)
- 전문은 원본 저장소의 LICENSE 파일을 그대로 받아 쓴다 (요약하거나 옮겨 적지 않는다)

## 순서
1. 버전 올리기: `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json`의 `version`
2. 함께 넣을 프로그램 받기: `scripts/fetch_bins.ps1` (uv·ffmpeg LGPL·yt-dlp·deno → `~/.cache/karaoke/bin`, 라이선스 → `app/src/licenses/`). 판을 올릴 때만 다시 실행
   - 처리기(파이썬·PyTorch)는 설치 파일에 넣지 않는다 (GPU용 PyTorch가 3GB를 넘어 NSIS 한계 2GB를 넘는다). 설치 파일에는 `engine/` 소스와 `uv.lock`만 들어가고,
     앱이 처음 켤 때 uv로 `%LOCALAPPDATA%\Noritune\runtime`에 받는다. NVIDIA 드라이버 570.65 이상이면 `--extra cu128`, 아니면 `--extra cpu` (`lib.rs`의 `prepare_runtime`)
   - 엔진 의존성을 바꾸면 `engine/`에서 `uv lock` 후 개발 환경은 `uv sync --extra cu128`. 설치된 앱은 uv.lock이 바뀐 것을 알아채고 바뀐 것만 받는다
3. 설치 파일 빌드 (`app/`에서, PowerShell):
   `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~/.tauri/noritune.key -Raw; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''; npx tauri build`
   → `~/.cache/karaoke/target/release/bundle/nsis/Noritune_<버전>_x64-setup.exe` 와 `.sig`
4. 설치해 보고 처음 켤 때 부품 받기 → 곡 추가·분리·재생·유튜브 받기 확인 (`/S`로 조용히 설치, `uninstall.exe /S`로 지우기. 지우면 받은 부품도 지워진다: `windows/hooks.nsh`)
   설치 폴더에 `licenses/`(라이선스 전문)가 있는지, 앱 설정 → 정보에 라이선스가 보이는지 확인
5. `python scripts/make_latest_json.py <버전> "<바뀐 내용>" <설치파일.exe> latest.json`
6. 공개 저장소에 릴리스: `gh release create v<버전> <설치파일.exe> latest.json -R KimHapGeum/noritune-update -t "Noritune <버전>" -n "<바뀐 내용>"`
   설치 파일과 latest.json을 같은 릴리스에 함께 올린다 (latest.json의 주소가 그 릴리스를 가리킨다)
7. 공개 저장소에 커밋할 일이 있으면 GitHub 비공개용 메일 `268497351+KimHapGeum@users.noreply.github.com`으로 커밋한다

## 업데이트를 공개하지 않고 시험하기
1. 덮어쓰기 설정 두 개: `{"version":"0.1.0","plugins":{"updater":{"endpoints":["http://127.0.0.1:8765/latest.json"],"dangerousInsecureTransportProtocol":true}}}` 와 버전만 0.1.1인 것 (http 주소는 `dangerousInsecureTransportProtocol` 없이는 거부된다)
2. 각각 `npx tauri build --config <파일>`로 빌드 (저장소 설정은 그대로), 0.1.0을 `/S`로 설치
3. 0.1.1 설치 파일을 둔 폴더에서 `make_latest_json.py`로 latest.json을 만들고 url을 `http://127.0.0.1:8765/<설치파일>`로 바꾼 뒤 `python -m http.server 8765 --bind 127.0.0.1`
4. 앱을 켜서 "업데이트" → 0.1.1로 다시 켜지는지, 받은 부품을 다시 받지 않는지, 옛 처리기가 남지 않는지 본다
5. 끝나면 정상 설정으로 다시 빌드해 설치해 둔다 (시험판은 이 PC 주소만 본다)
2026-11-20 시험: 업데이트 누르고 14초 만에 0.1.1로 다시 켜짐, 곡·부품 그대로
