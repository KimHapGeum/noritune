; Noritune installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks)
; The engine runtime (Python + PyTorch, several GB) is downloaded on first launch,
; so the uninstaller does not know about it. Remove it here, but not during an update
; (updates run the old uninstaller with /UPDATE and the new version reuses the runtime).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\Noritune\runtime"
    RMDir /r "$LOCALAPPDATA\Noritune\python"
    RMDir /r "$LOCALAPPDATA\Noritune\uv-cache"
    RMDir /r "$INSTDIR\engine"
    ; "Delete app data" checkbox: also models and settings. Songs in Documents\Noritune are kept.
    ${If} $DeleteAppDataCheckboxState = 1
      RMDir /r "$LOCALAPPDATA\Noritune\models"
      Delete "$LOCALAPPDATA\Noritune\config.json"
    ${EndIf}
    RMDir "$LOCALAPPDATA\Noritune"
  ${EndIf}
!macroend
