# 이 PC에서 쓰는 Noritune 개발판 바로가기 만들기 (설치판 "Noritune"과 따로 둔다: 코드를 고치고 바로 써 보는 용도)
# 개발판 실행 파일을 따로 복사해 두고 바탕화면에 바로가기를 만들고, 프로그램 추가/제거에 등록한다. 코드를 고친 뒤 다시 실행하면 새 판으로 바뀐다.
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
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "Noritune 개발판.lnk"))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = "$exe,0"
$lnk.Description = "내 노래를 반주로 만들어 부르는 PC 노래방"
$lnk.Save()
Write-Output "바로가기: $(Join-Path $desktop 'Noritune 개발판.lnk') -> $exe"

# 제어판 > 프로그램 추가/제거에 등록 (설치판의 "Noritune"과 겹치지 않게 키 이름은 Noritune-PC)
Copy-Item (Join-Path $PSScriptRoot "uninstall.ps1") (Join-Path $dir "uninstall.ps1") -Force
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Noritune-PC"
New-Item -Path $key -Force | Out-Null
$ver = (Get-Item $exe).VersionInfo.ProductVersion
@{
    DisplayName     = "Noritune 개발판"
    DisplayIcon     = "$exe,0"
    DisplayVersion  = $ver
    Publisher       = "Noritune"
    InstallLocation = $dir
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $dir 'uninstall.ps1')`""
}.GetEnumerator() | ForEach-Object { Set-ItemProperty -Path $key -Name $_.Key -Value $_.Value }
Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name EstimatedSize -Value ([int]((Get-Item $exe).Length / 1KB)) -Type DWord
Write-Output "프로그램 추가/제거에 등록: Noritune $ver"
