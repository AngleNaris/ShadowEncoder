@echo off
set "PATH=%USERPROFILE%\.cargo\bin;D:\_3.AI\shadowencoder\ffmpeg\win;%PATH%"
cd /d D:\_3.AI\shadowencoder\app
npm run tauri dev
