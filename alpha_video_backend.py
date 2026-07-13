#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 后端处理模块 (FFmpeg 命令封装)"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from alpha_video_config import (
    _hidden_process_kwargs,
    get_ffmpeg_bin,
    get_ffprobe_bin,
    get_video_info,
    OperationCancelledError,
)


def _get_img2webp_bin() -> str:
    """查找 img2webp.exe（与 ffmpeg 同目录）"""
    ff_dir = os.path.dirname(get_ffmpeg_bin())
    img2webp = os.path.join(ff_dir, 'img2webp.exe')
    if os.path.isfile(img2webp):
        return img2webp
    img2webp_noext = os.path.join(ff_dir, 'img2webp')
    if os.path.isfile(img2webp_noext):
        return img2webp_noext
    # fallback: try PATH
    found = shutil.which('img2webp') or shutil.which('img2webp.exe')
    if found:
        return found
    raise FileNotFoundError(
        "未找到 img2webp.exe，请确认 ffmpeg/win/ 目录中有 img2webp.exe"
    )


def _run_ffmpeg(cmd: list[str], logger, thread, progress_weight: float = 1.0) -> dict:
    """运行 FFmpeg 命令，实时输出日志和进度"""
    logger.print(' '.join(cmd))
    logger.print('')

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
        **_hidden_process_kwargs(),
    )
    thread.set_current_process(process)

    total_duration = None
    last_progress = 0

    for line in process.stderr:
        if thread.is_cancelled():
            process.terminate()
            raise OperationCancelledError('用户取消了操作')

        line = line.rstrip('\n')
        if line.strip():
            logger.print(line)

        # 解析 Duration
        if total_duration is None and 'Duration:' in line:
            import re
            m = re.search(r'Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})', line)
            if m:
                total_duration = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 +
                                  int(m.group(3)) + int(m.group(4)) / 100.0)

        # 解析 time= 进度
        if 'time=' in line:
            import re
            m = re.search(r'time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})', line)
            if m and total_duration and total_duration > 0:
                current = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 +
                           int(m.group(3)) + int(m.group(4)) / 100.0)
                progress = min(99, int(current / total_duration * 100 * progress_weight))
                if progress > last_progress:
                    last_progress = progress
                    thread.progress_changed.emit(progress, f'处理中... {progress}%')

    process.wait()
    thread.set_current_process(None)

    if process.returncode != 0 and not thread.is_cancelled():
        raise RuntimeError(f'FFmpeg 返回错误码 {process.returncode}')

    return {'returncode': process.returncode}


# ── 1. Alpha 合成：MP4(上RGB+下Alpha) → ProRes MOV ─────────

def compose_alpha(input_path: str, output_path: str, fps: float | None,
                  logger, thread) -> dict:
    """将上半RGB+下半Alpha的MP4合成带透明通道的ProRes MOV"""
    info = get_video_info(input_path)
    if not info:
        raise ValueError(f'无法读取视频信息: {input_path}')

    full_h = info['height']
    rgb_h = full_h // 2  # 上半 RGB
    alpha_h = full_h - rgb_h  # 下半 Alpha

    logger.print(f'输入视频: {input_path}')
    logger.print(f'原始尺寸: {info["width"]}x{info["height"]}')
    logger.print(f'RGB 区域: 0～{rgb_h}px, Alpha 区域: {rgb_h}～{full_h}px')
    logger.print(f'输出帧率: {fps or "原始"}')
    logger.print('')

    # 构建滤镜: 分离RGB和Alpha，再合并
    filter_complex = (
        f'[0:v]crop={info["width"]}:{rgb_h}:0:0[rgb];'
        f'[0:v]crop={info["width"]}:{alpha_h}:0:{rgb_h},'
        f'format=gray[alpha];'
        f'[rgb][alpha]alphamerge[out]'
    )

    cmd = [
        get_ffmpeg_bin(),
        '-y',
        '-i', input_path,
        '-filter_complex', filter_complex,
        '-map', '[out]',
        '-c:v', 'prores_ks',
        '-profile:v', '4444',
        '-pix_fmt', 'yuva444p10le',
        '-vendor', 'apl0',
    ]

    # 帧率
    if fps and fps > 0:
        cmd.extend(['-r', str(fps)])

    # 音频 copy
    if info.get('has_audio'):
        cmd.extend(['-map', '0:a:0', '-c:a', 'copy'])
    else:
        cmd.append('-an')

    cmd.append(output_path)

    result = _run_ffmpeg(cmd, logger, thread)
    logger.print('')
    logger.print(f'Alpha 合成完成 → {output_path}')
    return result


# ── 2. 截图：从视频提取带透明底的 PNG ──────────────────────

def capture_screenshot(input_path: str, output_path: str, time_sec: float,
                       crop_w: int | None = None, crop_h: int | None = None,
                       crop_x: int = 0, crop_y: int = 0,
                       logger=None, thread=None) -> dict:
    """从视频指定时间点截取 PNG，支持裁剪和透明通道"""
    info = get_video_info(input_path)

    vf_parts = []

    # 裁剪
    if crop_w and crop_h:
        vf_parts.append(f'crop={crop_w}:{crop_h}:{crop_x}:{crop_y}')

    cmd = [
        get_ffmpeg_bin(),
        '-y',
        '-ss', str(time_sec),
        '-i', input_path,
        '-vframes', '1',
    ]

    if vf_parts:
        cmd.extend(['-vf', ','.join(vf_parts)])

    cmd.append(output_path)

    if logger:
        logger.print(f'截图时间: {time_sec:.3f}s')
        if crop_w and crop_h:
            logger.print(f'裁剪区域: {crop_w}x{crop_h} @ ({crop_x},{crop_y})')
        logger.print(' '.join(cmd))

    process = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, encoding='utf-8', errors='replace',
                             **_hidden_process_kwargs())

    if process.returncode != 0:
        raise RuntimeError(f'截图失败: {process.stderr}')

    if logger:
        logger.print(f'截图完成 → {output_path}')

    return {'returncode': process.returncode}


# ── 3. 导出透明 GIF ─────────────────────────────────────────

def export_gif(input_path: str, output_path: str,
               start_time: float, duration: float,
               fps: float, width: int | None = None,
               height: int | None = None,
               crop_x: int = 0, crop_y: int = 0,
               crop_w: int | None = None, crop_h: int | None = None,
               logger=None, thread=None) -> dict:
    """导出带透明通道的 GIF"""
    info = get_video_info(input_path)

    vf_filters = []

    # 裁剪
    if crop_w and crop_h and crop_w > 0 and crop_h > 0:
        vf_filters.append(f'crop={crop_w}:{crop_h}:{crop_x}:{crop_y}')

    # 缩放 — 使用精确宽高
    if width and width > 0 and height and height > 0:
        vf_filters.append(f'scale={width}:{height}:flags=lanczos')
    elif width and width > 0:
        vf_filters.append(f'scale={width}:-2:flags=lanczos')  # -2 保证偶数避免奇偶问题

    # 帧率
    vf_filters.append(f'fps={fps}')

    # 生成调色板 (保留透明色, 最大颜色数, 优化统计模式)
    palette_filter = ','.join(vf_filters + [
        'split[s0][s1]',
        '[s0]palettegen=max_colors=256:reserve_transparent=1:stats_mode=diff[p]',
        '[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    ])

    cmd = [
        get_ffmpeg_bin(),
        '-y',
        '-i', input_path,
        '-ss', str(start_time),
        '-t', str(duration),
        '-vf', palette_filter,
        '-loop', '0',
        output_path,
    ]

    if logger:
        logger.print(f'GIF 参数: 起始={start_time:.3f}s, 时长={duration:.3f}s, 帧率={fps}')
        if crop_w and crop_h:
            logger.print(f'裁剪区域: {crop_w}x{crop_h} @ ({crop_x},{crop_y})')
        if width:
            logger.print(f'输出尺寸: {width}x{height}')

    result = _run_ffmpeg(cmd, logger, thread)
    logger.print('')
    logger.print(f'GIF 导出完成 → {output_path}')
    return result


# ── 4. 导出动态 WebP ────────────────────────────────────────

def export_webp(input_path: str, output_path: str,
                start_time: float, duration: float,
                fps: float, width: int | None = None,
                height: int | None = None,
                crop_x: int = 0, crop_y: int = 0,
                crop_w: int | None = None, crop_h: int | None = None,
                quality: int = 75,
                logger=None, thread=None) -> dict:
    """导出带透明通道的动画 WebP

    分两步：
      1. FFmpeg 提取帧为 PNG（保留 alpha）
      2. img2webp 组装为动画 WebP（默认不混合帧，每帧独立）
    """
    info = get_video_info(input_path)

    vf_filters = []

    # 裁剪
    if crop_w and crop_h and crop_w > 0 and crop_h > 0:
        vf_filters.append(f'crop={crop_w}:{crop_h}:{crop_x}:{crop_y}')

    # 缩放
    if width and width > 0 and height and height > 0:
        vf_filters.append(f'scale={width}:{height}:flags=lanczos')
    elif width and width > 0:
        vf_filters.append(f'scale={width}:-2:flags=lanczos')

    # 帧率
    vf_filters.append(f'fps={fps}')

    if logger:
        logger.print(f'WebP 参数: 起始={start_time:.3f}s, 时长={duration:.3f}s, 帧率={fps}, 质量={quality}')
        if crop_w and crop_h:
            logger.print(f'裁剪区域: {crop_w}x{crop_h} @ ({crop_x},{crop_y})')
        if width:
            logger.print(f'输出宽度: {width}px')

    # ── Step 1: FFmpeg 提取帧为 PNG ──
    tmp_dir = tempfile.mkdtemp(prefix='avt_webp_')
    png_pattern = os.path.join(tmp_dir, 'frame_%04d.png')

    extract_cmd = [
        get_ffmpeg_bin(),
        '-y',
        '-i', input_path,
        '-ss', str(start_time),
        '-t', str(duration),
        '-pix_fmt', 'rgba',
        '-vsync', '1',
    ]
    if vf_filters:
        extract_cmd.extend(['-vf', ','.join(vf_filters)])
    extract_cmd.append(png_pattern)

    if logger:
        logger.print('步骤1/2: 提取 PNG 帧...')

    result = _run_ffmpeg(extract_cmd, logger, thread)
    if result['returncode'] != 0:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return result

    # ── Step 2: img2webp 组装动画 WebP ──
    frame_duration_ms = 1000.0 / fps

    img2webp_cmd = [
        _get_img2webp_bin(),
        '-loop', '0',
        '-lossy',
        '-q', str(quality),
        '-d', str(int(frame_duration_ms)),
    ]
    # 收集所有 PNG 帧
    png_files = sorted(Path(tmp_dir).glob('frame_*.png'))
    if not png_files:
        if logger:
            logger.print('错误: 未生成任何 PNG 帧')
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {'returncode': 1, 'stdout': '', 'stderr': 'No PNG frames generated'}

    img2webp_cmd.extend(str(p) for p in png_files)
    img2webp_cmd.extend(['-o', output_path])

    if logger:
        logger.print(f'步骤2/2: img2webp 组装 ({len(png_files)} 帧, 每帧 {frame_duration_ms:.1f}ms)...')

    try:
        proc = subprocess.run(
            img2webp_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding='utf-8', errors='ignore',
        )
        result = {
            'returncode': proc.returncode,
            'stdout': proc.stdout.strip(),
            'stderr': proc.stderr.strip(),
        }
    except Exception as e:
        result = {'returncode': 1, 'stdout': '', 'stderr': str(e)}

    # 清理临时文件
    shutil.rmtree(tmp_dir, ignore_errors=True)

    if logger:
        logger.print('')
        if result['returncode'] == 0:
            logger.print(f'WebP 导出完成 → {output_path}')
        else:
            logger.print(f'WebP 导出失败')
            if result['stderr']:
                logger.print(result['stderr'])

    return result


# ── 5. 截取视频片段 (MOV/MP4) ──────────────────────────────

def export_segment(input_path: str, output_path: str,
                   start_time: float, duration: float,
                   fps: float | None, out_format: str = 'mov',
                   width: int | None = None, height: int | None = None,
                   crop_x: int = 0, crop_y: int = 0,
                   crop_w: int | None = None, crop_h: int | None = None,
                   logger=None, thread=None) -> dict:
    """截取视频片段，支持透明 MOV 和普通 MP4"""
    info = get_video_info(input_path)

    vf_filters = []

    if crop_w and crop_h and crop_w > 0 and crop_h > 0:
        vf_filters.append(f'crop={crop_w}:{crop_h}:{crop_x}:{crop_y}')

    if width and width > 0 and height and height > 0:
        vf_filters.append(f'scale={width}:{height}:flags=lanczos')
    elif width and width > 0:
        vf_filters.append(f'scale={width}:-2:flags=lanczos')

    cmd = [
        get_ffmpeg_bin(),
        '-y',
        '-i', input_path,
        '-ss', str(start_time),
        '-t', str(duration),
    ]

    if out_format == 'mov':
        cmd.extend(['-c:v', 'prores_ks', '-profile:v', '4444',
                     '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'])
    else:
        cmd.extend(['-c:v', 'libx264', '-preset', 'medium',
                     '-crf', '18', '-pix_fmt', 'yuv420p'])

    if vf_filters:
        cmd.extend(['-vf', ','.join(vf_filters)])

    if fps and fps > 0:
        cmd.extend(['-r', str(fps)])

    # 音频
    if info and info.get('has_audio'):
        if out_format == 'mov':
            cmd.extend(['-c:a', 'pcm_s16le'])
        else:
            cmd.extend(['-c:a', 'aac', '-b:a', '192k'])
    else:
        cmd.append('-an')

    cmd.append(output_path)

    if logger:
        logger.print(f'截取参数: {start_time:.3f}s ~ {start_time + duration:.3f}s, '
                     f'格式={out_format.upper()}, 帧率={fps or "原始"}')
        if crop_w and crop_h:
            logger.print(f'裁剪区域: {crop_w}x{crop_h} @ ({crop_x},{crop_y})')
        if width:
            logger.print(f'输出尺寸: {width}x{height}')

    result = _run_ffmpeg(cmd, logger, thread)
    logger.print('')
    logger.print(f'截取完成 → {output_path}')
    return result
