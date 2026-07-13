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
    DEFAULT_CFG_AUDIO_ONLY,
    DEFAULT_CFG_DENOISE,
    DEFAULT_CFG_LOUDNORM,
    DEFAULT_CFG_PRESET,
    DEFAULT_CFG_TUNE,
    DEFAULT_CFG_UNSHARP,
    _hidden_process_kwargs,
    cfg_base,
    cfg_denoise_list,
    cfg_preset_list,
    cfg_tune_list,
    cfg_unsharp_list,
    get_ffmpeg_bin,
    get_ffprobe_bin,
    is_media_file,
    OperationCancelledError,
)


@dataclass
class TranscodeOptions:
    preset_index: int = DEFAULT_CFG_PRESET
    unsharp_index: int = DEFAULT_CFG_UNSHARP
    denoise_index: int = DEFAULT_CFG_DENOISE
    tune_index: int = DEFAULT_CFG_TUNE
    loudnorm: bool = DEFAULT_CFG_LOUDNORM
    audio_only: bool = bool(DEFAULT_CFG_AUDIO_ONLY)
    keep_resolution: bool = False


def ensure_runtime_binary() -> None:
    subprocess.run(
        [get_ffmpeg_bin(), '-version'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        **_hidden_process_kwargs(),
    )


def build_default_log_path(input_path: Path, preset_key: str) -> Path:
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    if input_path.is_dir():
        return input_path / f'_video_conv_{preset_key}_{timestamp}.log'
    return input_path.with_name(f'{input_path.stem}_video_conv_{preset_key}_{timestamp}.log')


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


def preset_expects_audio(options: TranscodeOptions) -> bool:
    return '-an' not in cfg_preset_list[options.preset_index][4]


def build_command(input_file: str, output_file: str, is_pass2: bool, options: TranscodeOptions, source_has_audio: bool) -> list[str]:
    cmd = [
        get_ffmpeg_bin(),
        '-y',
        '-i', input_file,
    ]

    use_silent_audio = not source_has_audio
    if use_silent_audio:
        cmd.extend(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'])

    if options.audio_only:
        cmd.extend(['-map', '0:v:0'])
        cmd.extend(['-map', '0:a:0' if source_has_audio else '1:a:0'])
        if use_silent_audio:
            cmd.append('-shortest')
        cmd.extend(['-c:v', 'copy'])
        if options.loudnorm:
            cmd.extend(['-af', 'compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-15|-27/-9|0/-7|20/-7:soft-knee=6:gain=5:volume=-90:delay=0.2,loudnorm=I=-9:TP=0:LRA=7'])
        else:
            cmd.extend(['-af', 'compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-15|-27/-9|0/-7|20/-7:soft-knee=6:gain=5:volume=-90:delay=0.2'])
        cmd.extend(['-c:a', 'aac', '-b:a', '320k'])
        cmd.append(output_file)
        return cmd

    cmd.extend(cfg_base)
    cmd.extend(['-c:v', 'libx264', '-profile:v', 'main'])
    cmd.extend(['-map', '0:v'])
    if is_pass2 and preset_expects_audio(options):
        cmd.extend(['-map', '0:a:0' if source_has_audio else '1:a:0'])
        if use_silent_audio:
            cmd.append('-shortest')
    cmd.extend(cfg_unsharp_list[options.unsharp_index][2])
    cmd.extend(cfg_denoise_list[options.denoise_index][2])
    cmd.extend(cfg_tune_list[options.tune_index][2])
    cmd.extend(cfg_preset_list[options.preset_index][2])

    if is_pass2:
        cmd.extend(cfg_unsharp_list[options.unsharp_index][4])
        cmd.extend(cfg_denoise_list[options.denoise_index][4])
        cmd.extend(cfg_tune_list[options.tune_index][4])
        cmd.extend(cfg_preset_list[options.preset_index][4])
    else:
        cmd.extend(cfg_unsharp_list[options.unsharp_index][3])
        cmd.extend(cfg_denoise_list[options.denoise_index][3])
        cmd.extend(cfg_tune_list[options.tune_index][3])
        cmd.extend(cfg_preset_list[options.preset_index][3])

    vf_cmd: list[str] = []
    vf_cmd.extend(cfg_unsharp_list[options.unsharp_index][1])
    vf_cmd.extend(cfg_denoise_list[options.denoise_index][1])
    vf_cmd.extend(cfg_tune_list[options.tune_index][1])
    if not options.keep_resolution:
        vf_cmd.extend(cfg_preset_list[options.preset_index][1])
    cmd.extend(['-vf', ','.join(vf_cmd)])

    if options.loudnorm and '-an' not in cmd:
        cmd.extend(['-af', 'loudnorm=I=-9:TP=0:LRA=7'])

    if is_pass2:
        cmd.extend(['-pass', '2'])
        cmd.append(output_file)
    else:
        cmd.extend(['-pass', '1', '-an', '-f', 'null', 'NUL'])

    return cmd


def get_output_name(name: str, options: TranscodeOptions) -> str:
    return (
        name
        + f"_{cfg_preset_list[options.preset_index][0][0]}"
        + f"_{cfg_unsharp_list[options.unsharp_index][0][0]}"
        + f"_{cfg_denoise_list[options.denoise_index][0][0]}"
        + f"_{cfg_tune_list[options.tune_index][0][0]}"
    )


def build_job_list(input_path: Path, options: TranscodeOptions) -> tuple[list[tuple[str, str]], str]:
    if input_path.is_file():
        name, _ext = os.path.splitext(os.path.basename(input_path))
        output_file = os.path.join(os.path.dirname(input_path), get_output_name(name, options) + '.mp4')
        return [(str(input_path), output_file)], output_file

    output_root = get_output_name(str(input_path), options)
    jobs: list[tuple[str, str]] = []
    for root, _dirs, files in os.walk(input_path):
        for file in files:
            input_file = os.path.join(root, file)
            if not is_media_file(input_file):
                continue

            rel_path = os.path.relpath(input_file, input_path)
            output_file = os.path.join(output_root, rel_path)
            name, _ext = os.path.splitext(output_file)
            jobs.append((input_file, name + '.mp4'))
    return jobs, output_root


def _extract_progress(line: str, duration_seconds: float | None) -> int | None:
    if duration_seconds is None:
        return None
    time_match = re.search(r'time=(\d{2}):(\d{2}):(\d{2}\.\d{2})', line)
    if not time_match:
        return None
    h, m, s = time_match.groups()
    current = int(h) * 3600 + int(m) * 60 + float(s)
    return min(100, int(current / duration_seconds * 100))


def _read_duration(line: str) -> float | None:
    duration_match = re.search(r'Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})', line)
    if not duration_match:
        return None
    h, m, s = duration_match.groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def _run_ffmpeg_with_progress(
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
                raise OperationCancelledError('转码任务已取消。')

            if duration is None:
                duration = _read_duration(line)
            progress = _extract_progress(line, duration)
            if progress is not None and progress != last_progress and (progress == 100 or progress >= last_progress + 5):
                last_progress = progress
                if progress_callback is not None:
                    progress_callback(progress)

        process.wait()
        if cancel_callback is not None and cancel_callback():
            raise OperationCancelledError('转码任务已取消。')
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


def cleanup_pass_logs() -> None:
    for name in (
        'ffmpeg2pass-0.log',
        'ffmpeg2pass-0.log.temp',
        'ffmpeg2pass-0.log.mbtree',
        'ffmpeg2pass-0.log.mbtree.temp',
    ):
        try:
            os.remove(name)
        except OSError:
            pass


def transcode_file(
    input_file: str,
    output_file: str,
    options: TranscodeOptions,
    output=print,
    progress_callback=None,
    cancel_callback=None,
    process_callback=None,
) -> bool:
    try:
        output_dir = os.path.dirname(output_file)
        os.makedirs(output_dir, exist_ok=True)
        output(f'正在转码: {input_file} -> {output_file}')
        has_audio = source_has_audio_stream(input_file)
        if not has_audio:
            output('提示: 源文件未检测到音频流，将自动补入静音音轨。')

        if options.audio_only:
            cmd = build_command(
                input_file=input_file,
                output_file=output_file,
                is_pass2=True,
                options=options,
                source_has_audio=has_audio,
            )
            success = _run_ffmpeg_with_progress(
                cmd,
                '正在处理音频（视频将直接复制）...',
                output=output,
                progress_callback=progress_callback,
                cancel_callback=cancel_callback,
                process_callback=process_callback,
            )
            if not success:
                output('✗ 处理失败')
                return False
            output('✓ 转码成功')
            return True

        cmd1 = build_command(
            input_file=input_file,
            output_file=output_file,
            is_pass2=False,
            options=options,
            source_has_audio=has_audio,
        )
        pass1_callback = None if progress_callback is None else lambda percent: progress_callback(min(50, int(percent * 0.5)))
        if not _run_ffmpeg_with_progress(
            cmd1,
            'Pass 1/2: 分析视频...',
            output=output,
            progress_callback=pass1_callback,
            cancel_callback=cancel_callback,
            process_callback=process_callback,
        ):
            output('✗ Pass 1 失败')
            return False

        cmd2 = build_command(
            input_file=input_file,
            output_file=output_file,
            is_pass2=True,
            options=options,
            source_has_audio=has_audio,
        )
        pass2_callback = None if progress_callback is None else lambda percent: progress_callback(min(100, 50 + int(percent * 0.5)))
        if not _run_ffmpeg_with_progress(
            cmd2,
            'Pass 2/2: 编码视频...',
            output=output,
            progress_callback=pass2_callback,
            cancel_callback=cancel_callback,
            process_callback=process_callback,
        ):
            output('✗ Pass 2 失败')
            return False

        output('✓ 转码成功')
        return True
    except subprocess.CalledProcessError:
        output(f'✗ ffmpeg执行错误: {input_file}')
        return False
    except OperationCancelledError:
        output('✗ 已取消当前转码任务')
        raise
    except Exception as exc:
        output(f'✗ 处理文件时发生错误: {input_file}')
        output(f'错误信息: {exc}')
        return False
    finally:
        cleanup_pass_logs()


def process_path(
    input_path: Path,
    options: TranscodeOptions,
    output=print,
    progress_callback=None,
    cancel_callback=None,
    process_callback=None,
) -> tuple[int, int, str]:
    jobs, output_target = build_job_list(input_path, options)
    if input_path.is_dir():
        output(f'正在扫描目录: {input_path}')

    if not jobs:
        raise ValueError('没有找到可转码的视频文件。')

    if progress_callback is not None:
        progress_callback(0, '准备任务...')

    success_count = 0
    fail_count = 0
    total_jobs = len(jobs)

    for index, (input_file, output_file) in enumerate(jobs):
        if cancel_callback is not None and cancel_callback():
            raise OperationCancelledError('转码任务已取消。')

        current_name = Path(input_file).name

        def file_progress(percent: int) -> None:
            if progress_callback is None or total_jobs == 0:
                return
            overall = int(((index + percent / 100.0) / total_jobs) * 100)
            progress_callback(min(100, overall), f'[{index + 1}/{total_jobs}] {current_name}')

        if progress_callback is not None:
            file_progress(0)

        if transcode_file(
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
