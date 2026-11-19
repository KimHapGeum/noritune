# 이 PC에서 쓰는 Noritune 바로가기 만들기 (설치판을 내기 전까지)
# 개발판 실행 파일을 따로 복사해 두고 바탕화면에 바로가기를 만든다. 코드를 고친 뒤 다시 실행하면 새 판으로 바뀐다.
# - 따로 복사하는 까닭: 개발 중 다시 빌드하거나 시험 앱을 끌 때(noritune.exe) 쓰던 앱이 같이 꺼지지 않게
# - 처리기는 개발 PC의 가상환경 파이썬(~/.venvs/karaoke-engine)으로 돈다. 곡은 문서\Noritune 에 저장된다
# 먼저 app 폴더에서: npx tauri build --debug --no-bundle
$ErrorActionPreference = "Stop"
$src = Join-Path $env:USERPROFILE ".cache\karaoke\target\debug\noritune.exe"
$dir = Join-Path $env:LOCALAPPDATA "Noritune\app"
$exe = Join-Path $dir "Noritune-PC.exe"
if (-not (Test-Path $src)) { throw "먼저 app 폴더에서 'npx tauri build --debug --no-bundle'로 빌드하세요" }
if (Get-Process -Name "Noritune-PC" -ErrorAction SilentlyContinue) { throw "Noritune을 끄고 다시 실행하세요" }
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item $src $exe -Force

$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "Noritune.lnk"))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = "$exe,0"
$lnk.Description = "내 노래를 반주로 만들어 부르는 PC 노래방"
$lnk.Save()
Write-Output "바로가기: $(Join-Path $desktop 'Noritune.lnk') -> $exe"
