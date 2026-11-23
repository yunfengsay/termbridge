Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "TermBridge"
OutFile "../dist/TermBridge-Setup-0.2.4-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\TermBridge Native"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "../assets/icon.ico"
!define MUI_UNICON "../assets/icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\TermBridge.App.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "0.2.4.0"
VIAddVersionKey /LANG=1033 "ProductName" "TermBridge"
VIAddVersionKey /LANG=1033 "FileDescription" "TermBridge Native Windows Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "0.2.4"
VIAddVersionKey /LANG=1033 "LegalCopyright" "TermBridge contributors"
Section "TermBridge"
 SetShellVarContext current
 SetOutPath "$INSTDIR"
 File /r "../dist/app/*"
 File "../scripts/configure-install.ps1"
 nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\configure-install.ps1" -InstallDirectory "$INSTDIR"'
 Pop $0
 Pop $1
 ${If} $0 != 0
  MessageBox MB_ICONSTOP "TB command setup failed. Please retry installation."
  SetErrorLevel 1
  Abort
 ${EndIf}
 CreateDirectory "$SMPROGRAMS\TermBridge"
 CreateShortcut "$SMPROGRAMS\TermBridge\TermBridge.lnk" "$INSTDIR\TermBridge.App.exe" "" "$INSTDIR\Assets\icon.ico"
 CreateShortcut "$DESKTOP\TermBridge.lnk" "$INSTDIR\TermBridge.App.exe" "" "$INSTDIR\Assets\icon.ico"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermBridgeNative" "DisplayName" "TermBridge"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermBridgeNative" "DisplayVersion" "0.2.4"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermBridgeNative" "Publisher" "TermBridge"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermBridgeNative" "DisplayIcon" "$INSTDIR\Assets\icon.ico"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermBridgeNative" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 SendMessage 0xffff 0x001A 0 "STR:Environment" /TIMEOUT=5000
SectionEnd
Section "Uninstall"
 SetShellVarContext current
 nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\configure-install.ps1" -InstallDirectory "$INSTDIR" -Remove'
 Pop $0
 Pop $1
 Delete "$DESKTOP\TermBridge.lnk"
 Delete "$SMPROGRAMS\TermBridge\TermBridge.lnk"
 RMDir "$SMPROGRAMS\TermBridge"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermBridgeNative"
 RMDir /r "$INSTDIR"
 SendMessage 0xffff 0x001A 0 "STR:Environment" /TIMEOUT=5000
SectionEnd
