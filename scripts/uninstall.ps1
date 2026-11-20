# Noritune 개발판 지우기 (제어판 > 프로그램 추가/제거에서 실행된다. make_shortcut.ps1이 등록)
# 개발판 실행 파일·바로가기·등록만 지운다. 곡·설정·모델은 설치판과 같이 쓰므로 건드리지 않는다
# (모두 지우려면 설치판 "Noritune"을 지울 때 "앱 데이터 삭제"를 고른다)
# Windows PowerShell 5.1이 읽으므로 UTF-8 BOM을 붙여 둔다 (없으면 한글이 깨진다)
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = "Continue"

$ans = [System.Windows.Forms.MessageBox]::Show("Noritune 개발판을 지울까요?`n곡과 설정은 그대로 남아요.", "Noritune 개발판 제거", "OKCancel", "Question")
if ($ans -ne "OK") { exit 1 }

# 처리기는 앱이 꺼지면 따라 꺼진다
Get-Process -Name "Noritune-PC" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(5000)) { $_.Kill() }
}
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "Noritune 개발판.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Noritune-PC" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA "Noritune\app") -Recurse -Force -ErrorAction SilentlyContinue
[System.Windows.Forms.MessageBox]::Show("Noritune 개발판을 지웠어요.", "Noritune 개발판 제거") | Out-Null
