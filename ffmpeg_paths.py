#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""共享的 FFmpeg / FFprobe 路径解析与路径工具。

video_conv_config 与 alpha_video_config 都依赖这里的实现，故抽离到单一模块，
避免两份实现漂移（S5）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


class OperationCancelledError(RuntimeError):
    """用户取消操作的统一异常类型。"""
    pass


def get_program_dir() -> str:
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def _platform_bin_name(bin_name: str) -> str:
    """Return platform-appropriate executable name (e.g. ffmpeg vs ffmpeg.exe)."""
    return f'{bin_name}.exe' if sys.platform == 'win32' else bin_name


def _candidate_bin_paths(bin_name: str) -> list[str]:
    """Search paths for ffmpeg/ffprobe binaries.

    Strategy (in priority order):
    1. PyInstaller bundle root (sys._MEIPASS) — the binary lands there from --add-binary
    2. Platform-specific bundled directory (ffmpeg/win/, ffmpeg/mac/, ffmpeg/linux/)
    3. Legacy ffmpeg-8.1-essentials_build/bin/ (Windows development mode)
    4. System PATH (handled in _get_bin)
    """
    exe_name = _platform_bin_name(bin_name)
    program_dir = get_program_dir()

    candidates = []

    # 1. Directly in the program / bundle root (PyInstaller --add-binary)
    candidates.append(os.path.join(program_dir, exe_name))

    # 2. Platform-specific bundled directory
    platform_tag = {'win32': 'win', 'darwin': 'mac', 'linux': 'linux'}.get(sys.platform, 'linux')
    candidates.append(os.path.join(program_dir, 'ffmpeg', platform_tag, exe_name))

    # 3. Legacy directory (kept for backward compatibility during transition)
    candidates.append(os.path.join(program_dir, 'ffmpeg-8.1-essentials_build', 'bin', exe_name))

    return candidates


def _hidden_process_kwargs() -> dict[str, object]:
    """Hide console windows when spawning subprocesses on Windows.

    On macOS and Linux this returns an empty dict — nothing to suppress.
    """
    if os.name != 'nt':
        return {}

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {
        'creationflags': subprocess.CREATE_NO_WINDOW,
        'startupinfo': startupinfo,
    }


def _get_bin(bin_name: str) -> str:
    for candidate in _candidate_bin_paths(bin_name):
        if os.path.isfile(candidate):
            return candidate

    path_bin = shutil.which(bin_name) or shutil.which(f'{bin_name}.exe')
    if path_bin:
        return path_bin

    if getattr(sys, 'frozen', False):
        candidates = '\n  '.join(_candidate_bin_paths(bin_name))
        raise FileNotFoundError(
            f"未找到内置 {_platform_bin_name(bin_name)}，请确认打包时已包含该文件。\n"
            f"已搜索路径:\n  {candidates}"
        )
    # Development mode: fall back to bare name and let the OS resolve it
    return bin_name


def get_ffmpeg_bin() -> str:
    return _get_bin('ffmpeg')


def get_ffprobe_bin() -> str:
    return _get_bin('ffprobe')


def normalize_path(input_path: str) -> str:
    return os.path.abspath(input_path.strip().strip('"').strip("'"))
