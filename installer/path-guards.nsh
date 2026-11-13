; Pure validation: this include never removes or writes a file. The test harness
; passes isolated fake profile roots; production passes Windows known folders.
!macro mosaicUnsafeDestination
  IfSilent +2 0
  MessageBox MB_OK|MB_ICONSTOP "This location contains user data or uses a linked folder. Choose a dedicated application folder. Mosaic has made no installation changes."
  SetErrorLevel 1639
  Quit
!macroend

!macro mosaicRejectAncestor PATH
  System::Call 'kernel32::GetFullPathNameW(w "${PATH}", i ${NSIS_MAX_STRLEN}, w .r6, p 0)i.r7'
  ${If} $7 == 0
  ${OrIf} $7 >= ${NSIS_MAX_STRLEN}
    !insertmacro mosaicUnsafeDestination
  ${EndIf}
  StrCpy $6 "$6\"
  StrLen $7 $2
  StrCpy $8 $6 $7
  ${If} $8 == $2
    !insertmacro mosaicUnsafeDestination
  ${EndIf}
!macroend

!macro mosaicRejectIntersection PATH
  !insertmacro mosaicRejectAncestor "${PATH}"
  StrLen $7 $6
  StrCpy $8 $2 $7
  ${If} $8 == $6
    !insertmacro mosaicUnsafeDestination
  ${EndIf}
!macroend

!macro mosaicValidateInstallDirectory ROAMING LOCAL PROFILE
  ; Resolve the nearest existing ancestor to a long path, so short (8.3) names
  ; and paths with a not-yet-created suffix cannot evade the prefix comparison.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r2, p 0)i.r4'
  ${If} $4 == 0
  ${OrIf} $4 >= ${NSIS_MAX_STRLEN}
    !insertmacro mosaicUnsafeDestination
  ${EndIf}
  ${GetRoot} "$2" $3
  ${If} $2 == $3
  ${OrIf} $2 == "$3\"
    !insertmacro mosaicUnsafeDestination
  ${EndIf}
  StrCpy $3 $2 1 -1
  ${If} $3 == "\"
    StrCpy $2 $2 -1
  ${EndIf}
  StrCpy $3 ""
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r2)i.r4'
    ${If} $4 != -1
      System::Call 'kernel32::GetLongPathNameW(w r2, w .r5, i ${NSIS_MAX_STRLEN})i.r4'
      ${If} $4 == 0
        !insertmacro mosaicUnsafeDestination
      ${EndIf}
      StrCpy $2 "$5$3"
      ${Break}
    ${EndIf}
    ${GetFileName} "$2" $5
    StrCpy $3 "\$5$3"
    ${GetParent} "$2" $2
    ${If} $2 == ""
      !insertmacro mosaicUnsafeDestination
    ${EndIf}
  ${Loop}
  StrCpy $3 $2
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r3)i.r4'
    ${If} $4 != -1
      IntOp $4 $4 & 0x400
      ${If} $4 != 0
        !insertmacro mosaicUnsafeDestination
      ${EndIf}
    ${EndIf}
    ${GetParent} "$3" $4
    ${If} $4 == $3
    ${OrIf} $4 == ""
      ${Break}
    ${EndIf}
    StrCpy $3 $4
  ${Loop}
  StrCpy $INSTDIR $2
  StrCpy $2 "$2\"
  !insertmacro mosaicRejectIntersection "${ROAMING}\MosaicBrowser"
  !insertmacro mosaicRejectIntersection "${LOCAL}\MosaicBrowser"
  !insertmacro mosaicRejectAncestor "${ROAMING}"
  !insertmacro mosaicRejectAncestor "${LOCAL}"
  !insertmacro mosaicRejectAncestor "${PROFILE}"
  ReadEnvStr $9 "MOSAIC_USER_DATA"
  ${If} $9 != ""
    !insertmacro mosaicRejectIntersection "$9"
  ${EndIf}
!macroend
