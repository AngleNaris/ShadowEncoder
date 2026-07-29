Unicode true

!include "FileFunc.nsh"

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef OUTPUT_EXE
  !error "OUTPUT_EXE is required"
!endif

Name "ShadowEncoder Portable"
OutFile "${OUTPUT_EXE}"
Icon "${APP_ICON}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
SetCompress auto
SetCompressor /SOLID lzma
SetDatablockOptimize on
BrandingText "ShadowEncoder ${APP_VERSION}"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "ShadowEncoder Portable"
VIAddVersionKey /LANG=1033 "FileDescription" "ShadowEncoder single-file portable edition"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "ShadowEncoder contributors"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\ShadowEncoder"
  File /oname=ShadowEncoder.exe "${APP_EXE}"
  File /oname=shadowencoder-cli.exe "${CLI_EXE}"
  File /oname=ffmpeg.exe "${FFMPEG_EXE}"
  File /oname=ffprobe.exe "${FFPROBE_EXE}"
  File /oname=libmpv-2.dll "${LIBMPV_DLL}"
  File /oname=LICENSE.txt "${LICENSE_FILE}"
  File /oname=THIRD_PARTY_NOTICES.md "${THIRD_PARTY_FILE}"

  ReadEnvStr $R0 "PATH"
  System::Call 'Kernel32::SetEnvironmentVariable(t "PATH", t "$PLUGINSDIR\ShadowEncoder;$R0")'
  ${GetParameters} $R1

  StrCmp $R1 "--portable-verify" verify_bundle launch_app

  verify_bundle:
    nsExec::ExecToStack '"$PLUGINSDIR\ShadowEncoder\ShadowEncoder.exe" --portable-verify-runtime'
    Pop $R2
    Pop $R3
    StrCmp $R2 "0" verify_ffmpeg verify_failed

  verify_ffmpeg:
    nsExec::ExecToStack '"$PLUGINSDIR\ShadowEncoder\ffmpeg.exe" -version'
    Pop $R2
    Pop $R3
    StrCmp $R2 "0" verify_ffprobe verify_failed

  verify_ffprobe:
    nsExec::ExecToStack '"$PLUGINSDIR\ShadowEncoder\ffprobe.exe" -version'
    Pop $R2
    Pop $R3
    StrCmp $R2 "0" verify_cli verify_failed

  verify_cli:
    nsExec::ExecToStack '"$PLUGINSDIR\ShadowEncoder\shadowencoder-cli.exe" --version'
    Pop $R2
    Pop $R3
    StrCmp $R2 "0" verify_ok verify_failed

  verify_failed:
    SetErrorLevel 2
    Quit

  verify_ok:
    SetErrorLevel 0
    Quit

  launch_app:
    ExecWait '"$PLUGINSDIR\ShadowEncoder\ShadowEncoder.exe" $R1' $R2
    SetErrorLevel $R2
SectionEnd
