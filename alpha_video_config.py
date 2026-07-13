#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 共享配置、FFmpeg 路径解析、QSS 主题、工具函数"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# ── 媒体文件扩展名 ──────────────────────────────────────────
MEDIA_EXTENSIONS = {
    '.mp4', '.mov', '.mkv', '.avi', '.flv', '.mpeg', '.mpg', '.ts', '.wmv',
    '.webm', '.m4v', '.3gp',
}

SUPPORTED_INPUT_MEDIA = ('.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v')

# ── 产品信息 ────────────────────────────────────────────────
APP_NAME = 'MagicK'
APP_VERSION = '1.0.0'
APP_AUTHOR = '@繁星之子卡萨蒂亚'

# ── QSS 暗色主题 (与 ShadowEncoder 一致) ─────────────────
DARK_QSS = """
QWidget {
    background: #141218;
    color: #e6e0e9;
    font-family: "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif;
    font-size: 13px;
}
QMainWindow {
    background: #141218;
    border: none;
}
QTabWidget {
    background: #141218;
    border: none;
}
QTabWidget::pane {
    background: #141218;
    border: none;
    padding: 0;
    margin: 0;
}
QFrame#PanelFrame {
    background: #211f26;
    border: 1px solid #49454f;
}
QFrame#MetricFrame {
    background: #211f26;
    border: 1px solid #49454f;
}
QFrame#InfoFrame {
    background: #1d1b20;
    border: 1px solid #49454f;
}
QLabel#PageTitle {
    font-size: 24px;
    font-weight: 500;
    color: #e6e0e9;
}
QLabel#PageSubtitle {
    color: #9e90a8;
    font-size: 12px;
}
QLabel#SectionTitle {
    color: #e6e0e9;
    font-size: 14px;
    font-weight: 500;
}
QLabel { background: transparent; }
QLabel#HintLabel { color: #9e90a8; }
QLabel#DetailLabel { color: #c8c0d0; }
QLineEdit, QComboBox, QDoubleSpinBox, QSpinBox, QTextEdit {
    background: #211f26;
    border: 1px solid #49454f;
    padding: 9px 10px;
    min-height: 20px;
    selection-background-color: #4f378b;
    selection-color: #e6e0e9;
}
QLineEdit:focus, QComboBox:focus, QDoubleSpinBox:focus, QSpinBox:focus, QTextEdit:focus {
    border-color: #4f378b;
}
QComboBox::drop-down { width: 26px; border: none; }
QComboBox::down-arrow { image: none; width: 0px; height: 0px; }
QCheckBox { spacing: 8px; background: transparent; }
QCheckBox::indicator {
    width: 14px;
    height: 14px;
    border: 1px solid #49454f;
    background: #211f26;
}
QCheckBox::indicator:checked {
    background: #4f378b;
    border: 1px solid #4f378b;
}
QPushButton {
    background: #211f26;
    border: 1px solid #49454f;
    padding: 9px 16px;
    min-height: 20px;
}
QPushButton:hover { background: #2d2b33; border-color: #4f378b; }
QPushButton:disabled {
    color: #585460;
    background: #1d1b20;
    border-color: #302d36;
}
QPushButton#PrimaryButton {
    background: #4f378b;
    color: #bfabf1;
    border: 1px solid #4f378b;
    font-weight: 500;
}
QPushButton#PrimaryButton:hover { background: #5c4a99; border-color: #5c4a99; }
QPushButton#AccentButton {
    background: #211f26;
    color: #bfabf1;
    border: 1px solid #4f378b;
}
QPushButton#AccentButton:hover { background: #2d2b33; }
QProgressBar {
    background: #211f26;
    border: 1px solid #49454f;
    min-height: 32px;
    max-height: 32px;
    text-align: center;
    color: #e6e0e9;
}
QProgressBar::chunk { background: #4f378b; }
QTabBar::tab {
    background: #211f26;
    border-top: 1px solid #49454f;
    border-bottom: none;
    border-left: 1px solid #49454f;
    border-right: 1px solid #49454f;
    padding: 22px 18px;
    min-width: 106px;
    margin-right: -1px;
}
QTabBar::tab:selected {
    background: #141218;
    color: #e6e0e9;
    border-top: 2px solid #4f378b;
}
QTabBar::tab:hover:!selected {
    background: #1d1b20;
}
QTabWidget::tab-bar {
    left: 0px;
    alignment: left;
}
QStatusBar {
    background: #141218;
    border-top: 1px solid #49454f;
}
QStatusBar::item {
    border: none;
}
QScrollBar:vertical {
    background: #141218;
    width: 8px;
    border: none;
}
QScrollBar::handle:vertical {
    background: #49454f;
    min-height: 30px;
}
QScrollBar::handle:vertical:hover { background: #4f378b; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar:horizontal {
    background: #141218;
    height: 8px;
    border: none;
}
QScrollBar::handle:horizontal {
    background: #49454f;
    min-width: 30px;
}
QScrollBar::handle:horizontal:hover { background: #4f378b; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
QSplitter::handle:horizontal {
    background: #49454f;
    width: 1px;
}
QSlider::groove:horizontal {
    background: #211f26;
    border: 1px solid #49454f;
    height: 6px;
}
QSlider::handle:horizontal {
    background: #4f378b;
    border: 1px solid #4f378b;
    width: 14px;
    height: 14px;
    margin: -5px 0;
}
QSlider::sub-page:horizontal {
    background: #4f378b;
}
QGroupBox {
    border: 1px solid #49454f;
    margin-top: 16px;
    padding-top: 16px;
    font-weight: 500;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 12px;
    padding: 0 6px;
}
QRadioButton {
    spacing: 8px;
    background: transparent;
}
QRadioButton::indicator {
    width: 14px;
    height: 14px;
    border: 1px solid #49454f;
    background: #211f26;
}
QRadioButton::indicator:checked {
    background: #4f378b;
    border: 1px solid #4f378b;
}
"""

# ── FFmpeg / FFprobe 路径解析 (与 ShadowEncoder 一致) ─────

class OperationCancelledError(RuntimeError):
    pass


def get_program_dir() -> str:
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def _platform_bin_name(bin_name: str) -> str:
    return f'{bin_name}.exe' if sys.platform == 'win32' else bin_name


def _candidate_bin_paths(bin_name: str) -> list[str]:
    exe_name = _platform_bin_name(bin_name)
    program_dir = get_program_dir()

    candidates = []
    # 1. PyInstaller bundle root
    candidates.append(os.path.join(program_dir, exe_name))
    # 2. Platform-specific bundled directory
    platform_tag = {'win32': 'win', 'darwin': 'mac', 'linux': 'linux'}.get(sys.platform, 'linux')
    candidates.append(os.path.join(program_dir, 'ffmpeg', platform_tag, exe_name))
    # 3. Legacy directory
    candidates.append(os.path.join(program_dir, 'ffmpeg-8.1-essentials_build', 'bin', exe_name))

    return candidates


def _hidden_process_kwargs() -> dict:
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
    return bin_name


def get_ffmpeg_bin() -> str:
    return _get_bin('ffmpeg')


def get_ffprobe_bin() -> str:
    return _get_bin('ffprobe')


def normalize_path(input_path: str) -> str:
    return os.path.abspath(input_path.strip().strip('"').strip("'"))


def is_media_file(file_path: str | os.PathLike) -> bool:
    return Path(file_path).suffix.lower() in MEDIA_EXTENSIONS


# ── FFprobe 信息获取 ───────────────────────────────────────

def get_video_info(file_path: str) -> dict | None:
    """获取视频基本信息：宽度、高度、时长、帧率、是否有alpha通道"""
    try:
        cmd = [
            get_ffprobe_bin(),
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            file_path,
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                encoding='utf-8', errors='ignore', **_hidden_process_kwargs())
        if result.returncode != 0:
            return None

        import json
        data = json.loads(result.stdout)

        video_stream = None
        for stream in data.get('streams', []):
            if stream.get('codec_type') == 'video':
                video_stream = stream
                break

        if not video_stream:
            return None

        fmt = data.get('format', {})

        # 解析帧率
        fps = None
        r_frame_rate = video_stream.get('r_frame_rate', '')
        if '/' in r_frame_rate:
            parts = r_frame_rate.split('/')
            if int(parts[1]) != 0:
                fps = float(parts[0]) / float(parts[1])
        elif r_frame_rate:
            fps = float(r_frame_rate)

        if not fps:
            avg_fps = video_stream.get('avg_frame_rate', '')
            if '/' in avg_fps:
                parts = avg_fps.split('/')
                if int(parts[1]) != 0:
                    fps = float(parts[0]) / float(parts[1])

        # 检测 alpha 通道
        has_alpha = False
        pix_fmt = video_stream.get('pix_fmt', '')
        alpha_formats = {'rgba', 'bgra', 'argb', 'abgr', 'yuva420p', 'yuva422p',
                         'yuva444p', 'yuva420p10le', 'yuva422p10le', 'yuva444p10le',
                         'yuva444p12le', 'gbrp16le', 'gbrap', 'gbrap16le'}
        has_alpha = pix_fmt in alpha_formats

        # 检查是否有 alpha 流 (ProRes 4444 等)
        for s in data.get('streams', []):
            if s.get('codec_type') == 'video' and s.get('index', 0) > 0:
                has_alpha = True
                break

        return {
            'width': video_stream.get('width', 0),
            'height': video_stream.get('height', 0),
            'duration': float(fmt.get('duration', 0)),
            'fps': fps or 25.0,
            'has_alpha': has_alpha,
            'pix_fmt': pix_fmt,
            'codec_name': video_stream.get('codec_name', ''),
            'has_audio': any(s.get('codec_type') == 'audio' for s in data.get('streams', [])),
        }
    except Exception:
        return None


def get_frame_at_time(file_path: str, time_sec: float, output_path: str) -> bool:
    """提取指定时间点的帧到 PNG 文件"""
    try:
        cmd = [
            get_ffmpeg_bin(),
            '-y',
            '-ss', str(time_sec),
            '-i', file_path,
            '-vframes', '1',
            '-q:v', '2',
            output_path,
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                encoding='utf-8', errors='ignore', **_hidden_process_kwargs())
        return result.returncode == 0 and os.path.isfile(output_path)
    except Exception:
        return False


# ── 时间格式化 ──────────────────────────────────────────────

def format_time(seconds: float) -> str:
    """秒 → HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f'{h:02d}:{m:02d}:{s:06.3f}'


def parse_time(text: str) -> float | None:
    """HH:MM:SS.mmm 或直接数字 → 秒"""
    text = text.strip()
    try:
        return float(text)
    except ValueError:
        pass

    # HH:MM:SS.mmm 或 HH:MM:SS
    pattern = r'^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$'
    match = re.match(pattern, text)
    if match:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))

    # MM:SS.mmm
    pattern2 = r'^(\d{1,2}):(\d{1,2}(?:\.\d+)?)$'
    match2 = re.match(pattern2, text)
    if match2:
        return int(match2.group(1)) * 60 + float(match2.group(2))

    return None
