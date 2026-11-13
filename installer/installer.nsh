; Keep the upstream NSIS installer/uninstaller and restrict its destructive options.
; MosaicBrowser is a fixed runtime data path, outside the installation directory.
!include "path-guards.nsh"
!macro mosaicUserOnly
  ${If} ${isForAllUsers}
    SetErrorLevel 1639
    Quit
  ${EndIf}
  !insertmacro setInstallModePerUser
  !insertmacro mosaicValidateInstallDirectory "$APPDATA" "$LOCALAPPDATA" "$PROFILE"
!macroend

!macro customInit
  !insertmacro mosaicUserOnly
!macroend

!macro customUnInit
  ${If} ${isDeleteAppData}
    SetErrorLevel 1639
    Quit
  ${EndIf}
  !insertmacro mosaicUserOnly
!macroend

; Never auto-close a user's browser. Silent operations fail rather than kill it.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 != 603
    IfSilent mosaicAppBusy 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Mosaic yourself before installing or uninstalling it. Your workspace data will be kept."
    mosaicAppBusy:
    SetErrorLevel 1618
    Quit
  ${EndIf}
  ${nsProcess::Unload}
!macroend
