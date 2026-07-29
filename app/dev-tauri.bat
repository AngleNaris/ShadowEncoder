@echo off
setlocal

REM Resolve paths from this script, so the repository can be moved safely.
set "APP_DIR=%~dp0"
for %%I in ("%APP_DIR%..") do set "PROJECT_DIR=%%~fI"
set "FFMPEG_DIR=%PROJECT_DIR%\ffmpeg\win"
if not defined MPV_SOURCE set "MPV_SOURCE=%PROJECT_DIR%\mpv\win"
set "MPV_ARCH_DIR=%MPV_SOURCE%\64"

if not defined VCVARS set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
  if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VCVARS=%%I\VC\Auxiliary\Build\vcvars64.bat"
  )
)
if exist "%VCVARS%" (
  call "%VCVARS%"
) else (
  echo [warn] vcvars64.bat not found, skip MSVC environment setup
)

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if exist "%FFMPEG_DIR%\ffmpeg.exe" set "PATH=%FFMPEG_DIR%;%PATH%"
if exist "%MPV_ARCH_DIR%\libmpv-2.dll" set "PATH=%MPV_ARCH_DIR%;%PATH%"

where cargo.exe >nul 2>nul
if errorlevel 1 (
  echo [error] cargo.exe not found. Install Rust from https://rustup.rs and reopen the terminal.
  exit /b 1
)

where ffmpeg.exe >nul 2>nul
if errorlevel 1 (
  echo [error] ffmpeg.exe not found. Place it in "%FFMPEG_DIR%" or add it to PATH.
  exit /b 1
)
where ffprobe.exe >nul 2>nul
if errorlevel 1 (
  echo [error] ffprobe.exe not found. Place it in "%FFMPEG_DIR%" or add it to PATH.
  exit /b 1
)
if not exist "%MPV_ARCH_DIR%\mpv.lib" (
  echo [error] mpv.lib not found at "%MPV_ARCH_DIR%".
  echo         Extract a 64-bit mpv-dev Windows build there, or set MPV_SOURCE
  echo         to a directory whose 64 subdirectory contains mpv.lib.
  exit /b 1
)
if not exist "%MPV_ARCH_DIR%\libmpv-2.dll" (
  echo [error] libmpv-2.dll not found at "%MPV_ARCH_DIR%".
  echo         Use the same 64-bit mpv-dev package that provides mpv.lib.
  exit /b 1
)

pushd "%APP_DIR%"
npm run tauri dev
set "EXIT_CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %EXIT_CODE%
