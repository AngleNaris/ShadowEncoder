# -*- coding: utf-8 -*-
import os
import subprocess
import sys

root = os.path.dirname(os.path.abspath(__file__))
os.chdir(root)
os.environ["PATH"] = os.path.join(root, "ffmpeg", "win") + os.pathsep + os.environ.get("PATH", "")

# Prefer Python GUI (works without MSVC/Rust)
gui = os.path.join(root, "shadowencoder_gui.py")
print("Starting ShadowEncoder GUI:", gui)
os.execv(sys.executable, [sys.executable, gui])
