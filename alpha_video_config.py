#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 共享配置、FFmpeg 路径解析、QSS 主题、工具函数"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

# 说明：产品信息(APP_NAME/APP_VERSION/APP_AUTHOR)与暗色主题 QSS
# 现由 ShadowEncoder 侧统一提供(alpha_video 不再自带)，避免版本号与主题分裂。

# ── 媒体文件扩展名 ──────────────────────────────────────────
MEDIA_EXTENSIONS = {
    '.mp4', '.mov', '.mkv', '.avi', '.flv', '.mpeg', '.mpg', '.ts', '.wmv',
    '.webm', '.m4v', '.3gp',
}

SUPPORTED_INPUT_MEDIA = ('.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v')



# ── FFmpeg / FFprobe 路径解析（共享自 ffmpeg_paths，避免重复实现） ──

from ffmpeg_paths import (
    OperationCancelledError,
    get_program_dir,
    _platform_bin_name,
    _candidate_bin_paths,
    _hidden_process_kwargs,
    _get_bin,
    get_ffmpeg_bin,
    get_ffprobe_bin,
    normalize_path,
)


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
