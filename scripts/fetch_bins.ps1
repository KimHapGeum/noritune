# 설치 파일에 함께 넣을 프로그램 받기 (RELEASE.md 2단계). 판을 올릴 때는 아래 버전만 바꾼다
# - uv: 처음 켤 때 파이썬과 PyTorch 등을 받아 처리기 실행 환경을 만든다
# - ffmpeg(LGPL 빌드, GPL 빌드는 넣지 않는다), yt-dlp, deno(유튜브가 요구하는 JavaScript 실행기)
# 받는 곳: -Out (기본 ~/.cache/karaoke/bin, OneDrive 밖. GitHub Actions는 따로 준다). 라이선스 전문은 app/src/licenses/ 에 쓴다
# 모두 판을 고정한다: 같은 소스에서 같은 설치 파일이 나와야 한다 (무료 코드 서명 조건)
param([string]$Out = (Join-Path $env:USERPROFILE ".cache\karaoke\bin"))
$ErrorActionPreference = "Stop"
$UV = "0.13.9"; $DENO = "v2.9.8"; $YTDLP = "2026.10.26"
$FFMPEG = "n9.0"; $FFMPEG_TAG = "autobuild-2026-11-19-12-39"; $FFMPEG_ZIP = "ffmpeg-n9.0.2-58-g8c7ef49002-win64-lgpl-9.0.zip"

$bin = $Out
$lic = Join-Path $PSScriptRoot "..\app\src\licenses"
$tmp = Join-Path $env:TEMP "noritune-fetch"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $bin, $tmp | Out-Null

function Get-File($url, $out) { Write-Host "받는 중: $url"; Invoke-WebRequest $url -OutFile $out -UseBasicParsing }
function Get-Zip($url, $name) {
    $zip = Join-Path $tmp "$name.zip"; $dir = Join-Path $tmp $name
    Get-File $url $zip
    Expand-Archive $zip $dir -Force
    return $dir
}

$d = Get-Zip "https://github.com/astral-sh/uv/releases/download/$UV/uv-x86_64-pc-windows-msvc.zip" "uv"
Copy-Item (Get-ChildItem $d -Recurse -Filter uv.exe | Select-Object -First 1).FullName $bin -Force
Get-File "https://raw.githubusercontent.com/astral-sh/uv/$UV/LICENSE-MIT" (Join-Path $lic "uv.txt")

$d = Get-Zip "https://github.com/denoland/deno/releases/download/$DENO/deno-x86_64-pc-windows-msvc.zip" "deno"
Copy-Item (Join-Path $d "deno.exe") $bin -Force
Get-File "https://raw.githubusercontent.com/denoland/deno/$DENO/LICENSE.md" (Join-Path $lic "deno.txt")

Get-File "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP/yt-dlp.exe" (Join-Path $bin "yt-dlp.exe")
Get-File "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$YTDLP/LICENSE" (Join-Path $lic "yt-dlp.txt")

$d = Get-Zip "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FFMPEG_TAG/$FFMPEG_ZIP" "ffmpeg"
# ffprobe는 넣지 않는다 (128MB, yt-dlp의 영상 합치기는 ffmpeg만 쓴다)
Copy-Item (Get-ChildItem $d -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName $bin -Force
$ffLicense = Get-Content (Get-ChildItem $d -Recurse -Filter LICENSE.txt | Select-Object -First 1).FullName -Raw
# LGPL: 고치지 않은 FFmpeg를 그대로 넣었고, 소스는 아래에서 받을 수 있다고 함께 적는다
Set-Content (Join-Path $lic "ffmpeg.txt") -Encoding utf8 -Value @"
FFmpeg $($FFMPEG_ZIP -replace '^ffmpeg-(.+?)-win64.*$', '$1') (LGPL build by BtbN/FFmpeg-Builds $FFMPEG_TAG, unmodified)
Source code: https://github.com/FFmpeg/FFmpeg/tree/release/$($FFMPEG.TrimStart('n'))
Build scripts: https://github.com/BtbN/FFmpeg-Builds/releases/tag/$FFMPEG_TAG

$ffLicense
"@

Remove-Item $tmp -Recurse -Force
if (-not (& (Join-Path $bin "ffmpeg.exe") -hide_banner -encoders 2>$null | Select-String "libopus")) { throw "받은 ffmpeg에 libopus가 없어요 (반주를 Opus로 저장한다)" }
Get-ChildItem $bin | Format-Table Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
