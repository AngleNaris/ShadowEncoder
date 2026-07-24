@echo off
REM Tauri 开发启动脚本：设置 MSVC 环境 + Rust PATH + 代理，然后启动
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" (
  call "%VCVARS%"
) else (
  echo [warn] vcvars64.bat not found, skip MSVC env setup
)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "HTTP_PROXY=http://127.0.0.1:10808"
set "HTTPS_PROXY=http://127.0.0.1:10808"
set "PATH=D:\_3.AI\shadowencoder\ffmpeg\win;%PATH%"
cd /d D:\_3.AI\shadowencoder\app
npm run tauri dev
