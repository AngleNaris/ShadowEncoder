#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import os
import re
import subprocess
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from video_conv_config import (
    _hidden_process_kwargs,
    get_ffmpeg_bin,
    get_ffprobe_bin,
    is_media_file,
    OperationCancelledError,
)

AUDIO_EXTENSIONS = {'.mp3', '.wav', '.flac', '.aac', '.m4a', '.wma', '.ogg', '.opus', '.aiff', '.au'}


def is_audio_file(path: str | os.PathLike[str]) -> bool:
    return Path(path).suffix.lower() in AUDIO_EXTENSIONS


def is_processable(path: str | os.PathLike[str]) -> bool:
    return is_media_file(path) or is_audio_file(path)


def output_extension(input_file: str) -> str:
    if is_audio_file(input_file):
        return Path(input_file).suffix.lower()
    return '.mp4'


@dataclass
class MixOptions:
    loudnorm_enabled: bool = True
    loudnorm_i: float = -24.0
    loudnorm_tp: float = -2.0
    loudnorm_lra: float = 7.0
    compand_enabled: bool = True
    compand_threshold: float = -27.0
    compand_gain: float = 5.0
    output_suffix: str = '_mix'
    audio_bitrate: str = '320k'




def ensure_runtime_binary() -> None:
    subprocess.run(
        [get_ffmpeg_bin(), '-version'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        **_hidden_process_kwargs(),
    )


def build_default_log_path(input_path: Path) -> Path:
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    if input_path.is_dir():
        return input_path / f'_audio_mix_{timestamp}.log'
    return input_path.with_name(f'{input_path.stem}_audio_mix_{timestamp}.log')


def source_has_audio_stream(input_file: str) -> bool:
    process = subprocess.run(
        [
            get_ffprobe_bin(),
            '-v', 'error',
            '-select_streams', 'a',
            '-show_entries', 'stream=index',
            '-of', 'csv=p=0',
            input_file,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        encoding='utf-8',
        errors='ignore',
        **_hidden_process_kwargs(),
    )
    return process.returncode == 0 and bool(process.stdout.strip())


def source_has_video_stream(input_file: str) -> bool:
    process = subprocess.run(
        [
            get_ffprobe_bin(),
            '-v', 'error',
            '-select_streams', 'v',
            '-show_entries', 'stream=index',
            '-of', 'csv=p=0',
            input_file,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        encoding='utf-8',
        errors='ignore',
        **_hidden_process_kwargs(),
    )
    return process.returncode == 0 and bool(process.stdout.strip())


def build_audio_filters(options: MixOptions) -> str:
    filters: list[str] = []
    if options.compand_enabled:
        t = options.compand_threshold
        filters.append(
            f'compand=attacks=0.3:decays=0.8:'
            f'points=-80/-80|-45/-15|{t}/{t + 18:.0f}|0/-7|20/-7:'
            f'soft-knee=6:gain={options.compand_gain}:volume=-90:delay=0.2'
        )
    if options.loudnorm_enabled:
        filters.append(
            f'loudnorm=I={options.loudnorm_i}:TP={options.loudnorm_tp}:LRA={options.loudnorm_lra}'
        )
    return ','.join(filters)


def build_command(input_file: str, output_file: str, options: MixOptions) -> list[str]:
    has_video = source_has_video_stream(input_file)
    cmd = [get_ffmpeg_bin(), '-y', '-i', input_file]

    if has_video:
        cmd.extend(['-c:v', 'copy'])

    audio_filters = build_audio_filters(options)
    if audio_filters:
        cmd.extend(['-af', audio_filters])

    ext = Path(output_file).suffix.lower()
    if ext == '.mp4':
        cmd.extend(['-c:a', 'aac', '-b:a', options.audio_bitrate])
    # 其他音频格式由 ffmpeg 根据扩展名自动选择编码器

    cmd.append(output_file)
    return cmd


def _read_duration(line: str) -> float | None:
    m = re.search(r'Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})', line)
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _extract_progress(line: str, duration: float | None) -> int | None:
    if duration is None:
        return None
    m = re.search(r'time=(\d{2}):(\d{2}):(\d{2}\.\d{2})', line)
    if not m:
        return None
    current = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return min(100, int(current / duration * 100))


def _run_ffmpeg(
    cmd: list[str],
    title: str,
    output=print,
    progress_callback=None,
    cancel_callback=None,
    process_callback=None,
) -> bool:
    tail_lines: deque[str] = deque(maxlen=40)
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding='utf-8',
        errors='ignore',
        **_hidden_process_kwargs(),
    )
    if process_callback is not None:
        process_callback(process)

    try:
        output(title)
        duration: float | None = None
        last_progress = -1
        for line in process.stdout or []:
            tail_lines.append(line.rstrip())
            if cancel_callback is not None and cancel_callback():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                raise OperationCancelledError('混音任务已取消。')

            if duration is None:
                duration = _read_duration(line)
            progress = _extract_progress(line, duration)
            if progress is not None and progress != last_progress and (progress == 100 or progress >= last_progress + 5):
                last_progress = progress
                if progress_callback is not None:
                    progress_callback(progress)

        process.wait()
        if cancel_callback is not None and cancel_callback():
            raise OperationCancelledError('混音任务已取消。')
        if process.returncode != 0:
            output(f'ffmpeg 退出码: {process.returncode}')
            for line in tail_lines:
                if line.strip():
                    output(line)
        if process.returncode == 0 and progress_callback is not None:
            progress_callback(100)
        return process.returncode == 0
    finally:
        if process_callback is not None:
            process_callback(None)


def build_job_list(input_path: Path, options: MixOptions) -> tuple[list[tuple[str, str]], str]:
    if input_path.is_file():
        name, _ext = os.path.splitext(str(input_path))
        ext = output_extension(str(input_path))
        output_file = name + options.output_suffix + ext
        return [(str(input_path), output_file)], output_file

    output_root = str(input_path) + options.output_suffix
    jobs: list[tuple[str, str]] = []
    for root, _dirs, files in os.walk(input_path):
        for file in files:
            input_file = os.path.join(root, file)
            if not is_processable(input_file):
                continue
            rel_path = os.path.relpath(input_file, input_path)
            output_file = os.path.join(output_root, rel_path)
            name, _ext = os.path.splitext(output_file)
            ext = output_extension(input_file)
            jobs.append((input_file, name + ext))
    return jobs, output_root


def mix_audio_file(
    input_file: str,
    output_file: str,
    options: MixOptions,
    output=print,
    progress_callback=None,
    cancel_callback=None,
    process_callback=None,
) -> bool:
    try:
        output_dir = os.path.dirname(output_file)
        os.makedirs(output_dir, exist_ok=True)
        output(f'正在混音: {input_file} -> {output_file}')

        if not source_has_audio_stream(input_file):
            output('提示: 源文件未检测到音频流，跳过处理。')
            return True

        cmd = build_command(input_file, output_file, options)
        filters_desc = []
        if options.compand_enabled:
            filters_desc.append(f'压缩(阈值={options.compand_threshold}dB, 增益={options.compand_gain}dB)')
        if options.loudnorm_enabled:
            filters_desc.append(f'响度标准化(I={options.loudnorm_i}, TP={options.loudnorm_tp}, LRA={options.loudnorm_lra})')
        output(f'音频处理: {", ".join(filters_desc)}')

        success = _run_ffmpeg(
            cmd,
            '正在处理音频...',
            output=output,
            progress_callback=progress_callback,
            cancel_callback=cancel_callback,
            process_callback=process_callback,
        )
        if not success:
            output('✗ 处理失败')
            return False
        output('✓ 混音成功')
        return True
    except OperationCancelledError:
        output('✗ 已取消当前混音任务')
        raise
    except Exception as exc:
        output(f'✗ 处理文件时发生错误: {input_file}')
        output(f'错误信息: {exc}')
        return False


def process_path(
    input_path: Path,
    options: MixOptions,
    output=print,
    progress_callback=None,
    cancel_callback=None,
    process_callback=None,
) -> tuple[int, int, str]:
    jobs, output_target = build_job_list(input_path, options)
    if input_path.is_dir():
        output(f'正在扫描目录: {input_path}')

    if not jobs:
        raise ValueError('没有找到可处理的媒体文件。')

    if progress_callback is not None:
        progress_callback(0, '准备任务...')

    success_count = 0
    fail_count = 0
    total_jobs = len(jobs)

    for index, (input_file, output_file) in enumerate(jobs):
        if cancel_callback is not None and cancel_callback():
            raise OperationCancelledError('混音任务已取消。')

        current_name = Path(input_file).name

        def file_progress(percent: int) -> None:
            if progress_callback is None or total_jobs == 0:
                return
            overall = int(((index + percent / 100.0) / total_jobs) * 100)
            progress_callback(min(100, overall), f'[{index + 1}/{total_jobs}] {current_name}')

        if progress_callback is not None:
            file_progress(0)

        if mix_audio_file(
            input_file,
            output_file,
            options,
            output=output,
            progress_callback=file_progress,
            cancel_callback=cancel_callback,
            process_callback=process_callback,
        ):
            success_count += 1
        else:
            fail_count += 1

        if progress_callback is not None:
            file_progress(100)

    return success_count, fail_count, output_target
