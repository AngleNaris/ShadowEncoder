@echo off
cd /d "%~dp0"
set "PATH=%~dp0ffmpeg\win;%PATH%"
python shadowencoder_gui.py
