#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from video_conv_config import (
    DEFAULT_CFG_PRESET,
    ExpectedOutputSpec,
    _hidden_process_kwargs,
    build_expected_output_spec,
    get_ffmpeg_bin,
    get_ffprobe_bin,
    is_media_file,
    OperationCancelledError,
)

BLACK_SEGMENT_RE = re.compile(
    r'black_start:(?P<start>-?\d+(?:\.\d+)?)\s+'
    r'black_end:(?P<end>-?\d+(?:\.\d+)?)\s+'
    r'black_duration:(?P<duration>-?\d+(?:\.\d+)?)'
)


@dataclass
class Issue:
    severity: str
    code: str
    message: str


@dataclass
class CheckOptions:
    preset_index: int = DEFAULT_CFG_PRESET
    audio_only: bool = False
    ffmpeg_bin: str = field(default_factory=get_ffmpeg_bin)
    ffprobe_bin: str = field(default_factory=get_ffprobe_bin)
    black_min_duration: float = 0.04
    black_picture_threshold: float = 0.98
    black_pixel_threshold: float = 0.10
    ignore_edge_black: float = 0.50
    no_black_detect: bool = False
    recursive: bool = True
    fps_tolerance: float = 0.50
    video_bitrate_tolerance: float = 0.25
    audio_bitrate_tolerance: float = 0.35
    fail_on_warning: bool = False
    report_json: str | None = None
    verbose: bool = False



def _run_command_capture(
    command: list[str],
    *,
    output_to_stdout: bool = False,
    cancel_callback=None,
    process_callback=None,
) -> tuple[int, str, str]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT if output_to_stdout else subprocess.PIPE,
        encoding='utf-8',
        errors='replace',
        **_hidden_process_kwargs(),
    )
    if process_callback is not None:
        process_callback(process)

    try:
        while True:
            try:
                stdout_text, stderr_text = process.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                if cancel_callback is not None and cancel_callback():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    raise OperationCancelledError('检测任务已取消。')
        return process.returncode, stdout_text or '', '' if output_to_stdout else (stderr_text or '')
    finally:
        if process_callback is not None:
            process_callback(None)


def ensure_runtime_binaries(options: CheckOptions) -> None:
    subprocess.run(
        [options.ffmpeg_bin, '-version'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        **_hidden_process_kwargs(),
    )
    subprocess.run(
        [options.ffprobe_bin, '-version'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        **_hidden_process_kwargs(),
    )


def format_bitrate(bits_per_second: int | None) -> str:
    if bits_per_second is None:
        return '未知'
    if bits_per_second >= 1_000_000:
        return f'{bits_per_second / 1_000_000:.2f} Mbps'
    if bits_per_second >= 1_000:
        return f'{bits_per_second / 1_000:.0f} kbps'
    return f'{bits_per_second} bps'


def format_fps(value: float | None) -> str:
    if value is None:
        return '未知'
    return f'{value:.3f}'.rstrip('0').rstrip('.')


def spec_to_dict(spec: ExpectedOutputSpec) -> dict[str, object]:
    result = asdict(spec)
    result['target_video_bitrate_text'] = format_bitrate(spec.target_video_bitrate)
    result['max_video_bitrate_text'] = format_bitrate(spec.max_video_bitrate)
    result['target_audio_bitrate_text'] = format_bitrate(spec.target_audio_bitrate)
    result['fps_text'] = format_fps(spec.fps)
    return result


def build_default_log_path(input_path: Path, preset_key: str) -> Path:
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    if input_path.is_dir():
        return input_path / f'_video_check_{preset_key}_{timestamp}.log'
    return input_path.with_name(f'{input_path.stem}_video_check_{preset_key}_{timestamp}.log')


def parse_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_int(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_ratio(value: str | None) -> float | None:
    if not value or value in {'0/0', 'N/A'}:
        return None
    if '/' in value:
        numerator, denominator = value.split('/', 1)
        numerator_value = parse_float(numerator)
        denominator_value = parse_float(denominator)
        if numerator_value is None or denominator_value in (None, 0):
            return None
        return numerator_value / denominator_value
    return parse_float(value)


def collect_media_files(path: Path, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path]

    files: list[Path] = []
    iterator = path.rglob('*') if recursive else path.glob('*')
    for candidate in iterator:
        if candidate.is_file() and is_media_file(candidate):
            files.append(candidate)
    return sorted(files)


def run_ffprobe(ffprobe_bin: str, file_path: Path, cancel_callback=None, process_callback=None) -> dict[str, object]:
    returncode, stdout_text, stderr_text = _run_command_capture(
        [
            ffprobe_bin,
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            str(file_path),
        ],
        cancel_callback=cancel_callback,
        process_callback=process_callback,
    )
    if returncode != 0:
        raise subprocess.CalledProcessError(returncode, [ffprobe_bin, str(file_path)], stdout_text, stderr_text)
    return json.loads(stdout_text)


def detect_black_segments(
    ffmpeg_bin: str,
    file_path: Path,
    min_duration: float,
    picture_threshold: float,
    pixel_threshold: float,
    cancel_callback=None,
    process_callback=None,
) -> list[dict[str, float]]:
    command = [
        ffmpeg_bin,
        '-hide_banner',
        '-nostats',
        '-i', str(file_path),
        '-vf',
        (
            f'blackdetect=d={min_duration}:'
            f'pic_th={picture_threshold}:'
            f'pix_th={pixel_threshold}'
        ),
        '-an',
        '-f', 'null',
        '-',
    ]
    returncode, output_text, _ = _run_command_capture(
        command,
        output_to_stdout=True,
        cancel_callback=cancel_callback,
        process_callback=process_callback,
    )
    if returncode != 0:
        raise subprocess.CalledProcessError(returncode, command, output_text)

    segments: list[dict[str, float]] = []
    for match in BLACK_SEGMENT_RE.finditer(output_text):
        segments.append({
            'start': round(float(match.group('start')), 6),
            'end': round(float(match.group('end')), 6),
            'duration': round(float(match.group('duration')), 6),
        })
    return segments


def split_black_segments(
    segments: list[dict[str, float]],
    duration: float | None,
    ignore_edge_black: float,
) -> tuple[list[dict[str, float]], list[dict[str, float]]]:
    interior: list[dict[str, float]] = []
    ignored: list[dict[str, float]] = []
    for segment in segments:
        near_start = segment['start'] <= ignore_edge_black
        near_end = duration is not None and segment['end'] >= max(duration - ignore_edge_black, 0)
        if near_start or near_end:
            ignored.append(segment)
        else:
            interior.append(segment)
    return interior, ignored


def estimate_video_bitrate(
    format_info: dict[str, object],
    video_stream: dict[str, object],
    audio_streams: list[dict[str, object]],
) -> int | None:
    direct_value = parse_int(video_stream.get('bit_rate'))
    if direct_value:
        return direct_value

    format_bitrate = parse_int(format_info.get('bit_rate'))
    if not format_bitrate:
        return None

    audio_total = 0
    for stream in audio_streams:
        audio_total += parse_int(stream.get('bit_rate')) or 0

    estimated = format_bitrate - audio_total
    if estimated <= 0:
        return None
    return estimated


def bitrate_out_of_range(measured: int, expected: int, tolerance: float) -> bool:
    lower_bound = expected * (1 - tolerance)
    upper_bound = expected * (1 + tolerance)
    return measured < lower_bound or measured > upper_bound


def make_issue(severity: str, code: str, message: str) -> Issue:
    return Issue(severity=severity, code=code, message=message)


def check_file(
    file_path: Path,
    spec: ExpectedOutputSpec,
    options: CheckOptions,
    cancel_callback=None,
    process_callback=None,
) -> dict[str, object]:
    errors: list[Issue] = []
    warnings: list[Issue] = []

    probe_data = run_ffprobe(
        options.ffprobe_bin,
        file_path,
        cancel_callback=cancel_callback,
        process_callback=process_callback,
    )
    streams = probe_data.get('streams', [])
    format_info = probe_data.get('format', {})

    video_streams = [stream for stream in streams if stream.get('codec_type') == 'video']
    audio_streams = [stream for stream in streams if stream.get('codec_type') == 'audio']
    video_stream = video_streams[0] if video_streams else None
    audio_stream = audio_streams[0] if audio_streams else None

    duration = parse_float(format_info.get('duration'))

    if not video_stream:
        errors.append(make_issue('error', 'video_missing', '未找到视频流。'))
    else:
        if not spec.audio_only_mode and spec.width is not None:
            actual_width = parse_int(video_stream.get('width'))
            if actual_width != spec.width:
                actual_height = parse_int(video_stream.get('height'))
                errors.append(
                    make_issue(
                        'error',
                        'video_width',
                        f'视频分辨率宽度应为 {spec.width}，实际为 {(str(actual_width) if actual_width else "未知")}x{(str(actual_height) if actual_height else "未知")}',
                    )
                )

            actual_fps = parse_ratio(video_stream.get('avg_frame_rate')) or parse_ratio(video_stream.get('r_frame_rate'))
            if actual_fps is None:
                errors.append(make_issue('error', 'video_fps_unknown', '无法读取视频帧率。'))
            elif spec.fps is not None and abs(actual_fps - spec.fps) > options.fps_tolerance:
                errors.append(
                    make_issue(
                        'error',
                        'video_fps',
                        (
                            f'视频帧率应在 {format_fps(spec.fps - options.fps_tolerance)}'
                            f' 到 {format_fps(spec.fps + options.fps_tolerance)} fps 之间，'
                            f'实际为 {format_fps(actual_fps)} fps'
                        ),
                    )
                )

            if spec.target_video_bitrate is not None:
                actual_video_bitrate = estimate_video_bitrate(format_info, video_stream, audio_streams)
                if actual_video_bitrate is None:
                    errors.append(make_issue('error', 'video_bitrate_unknown', f'无法稳定估算视频平均码率，目标约为 {format_bitrate(spec.target_video_bitrate)}'))
                elif bitrate_out_of_range(actual_video_bitrate, spec.target_video_bitrate, options.video_bitrate_tolerance):
                    errors.append(
                        make_issue(
                            'error',
                            'video_bitrate',
                            (
                                f'视频平均码率偏离目标，目标约为 {format_bitrate(spec.target_video_bitrate)}，'
                                f'实际约为 {format_bitrate(actual_video_bitrate)}'
                            ),
                        )
                    )

    if spec.expects_audio:
        if not audio_stream:
            errors.append(make_issue('error', 'audio_missing', '预设要求存在音频流，但文件中未找到音频流。'))
        else:
            if spec.target_audio_bitrate is not None:
                actual_audio_bitrate = parse_int(audio_stream.get('bit_rate'))
                if actual_audio_bitrate is None:
                    errors.append(make_issue('error', 'audio_bitrate_unknown', f'无法读取音频平均码率，目标约为 {format_bitrate(spec.target_audio_bitrate)}'))
                elif bitrate_out_of_range(actual_audio_bitrate, spec.target_audio_bitrate, options.audio_bitrate_tolerance):
                    errors.append(
                        make_issue(
                            'error',
                            'audio_bitrate',
                            (
                                f'音频平均码率偏离目标，目标约为 {format_bitrate(spec.target_audio_bitrate)}，'
                                f'实际约为 {format_bitrate(actual_audio_bitrate)}'
                            ),
                        )
                    )

    black_segments: list[dict[str, float]] = []
    ignored_black_segments: list[dict[str, float]] = []
    if video_stream and not options.no_black_detect:
        detected = detect_black_segments(
            options.ffmpeg_bin,
            file_path,
            options.black_min_duration,
            options.black_picture_threshold,
            options.black_pixel_threshold,
            cancel_callback=cancel_callback,
            process_callback=process_callback,
        )
        black_segments, ignored_black_segments = split_black_segments(
            detected,
            duration,
            options.ignore_edge_black,
        )
        if black_segments:
            preview = ', '.join(
                f'{segment["start"]:.3f}-{segment["end"]:.3f}s'
                for segment in black_segments[:5]
            )
            errors.append(make_issue('error', 'black_frames', f'检测到中间黑场/黑帧 {len(black_segments)} 处: {preview}'))
        elif ignored_black_segments and options.verbose:
            preview = ', '.join(
                f'{segment["start"]:.3f}-{segment["end"]:.3f}s'
                for segment in ignored_black_segments[:5]
            )
            warnings.append(make_issue('warning', 'black_frames_ignored', f'忽略了首尾黑场 {len(ignored_black_segments)} 处: {preview}'))

    status = 'PASS'
    if errors:
        status = 'FAIL'
    elif warnings and options.fail_on_warning:
        status = 'FAIL'
    elif warnings:
        status = 'PASS_WITH_WARNINGS'

    result = {
        'path': str(file_path),
        'status': status,
        'duration_seconds': duration,
        'issues': {
            'errors': [asdict(item) for item in errors],
            'warnings': [asdict(item) for item in warnings],
            'info': [],
        },
        'black_segments': black_segments,
        'ignored_black_segments': ignored_black_segments,
        'detected': {
            'video_width': parse_int(video_stream.get('width')) if video_stream else None,
            'video_height': parse_int(video_stream.get('height')) if video_stream else None,
            'video_fps': (
                parse_ratio(video_stream.get('avg_frame_rate')) or parse_ratio(video_stream.get('r_frame_rate'))
            ) if video_stream else None,
            'video_bitrate': estimate_video_bitrate(format_info, video_stream, audio_streams) if video_stream else None,
            'audio_bitrate': parse_int(audio_stream.get('bit_rate')) if audio_stream else None,
        },
    }
    return result


def print_file_result(base_path: Path, result: dict[str, object], verbose: bool, output=print) -> None:
    file_path = Path(str(result['path']))
    try:
        display_path = file_path.relative_to(base_path)
    except ValueError:
        display_path = file_path

    output(f'[{result["status"]}] {display_path}')
    issues = result['issues']
    for error in issues['errors']:
        output(f'  E {error["message"]}')
    if verbose or result['status'] != 'PASS':
        for warning in issues['warnings']:
            output(f'  W {warning["message"]}')
    if verbose:
        for info in issues['info']:
            output(f'  I {info["message"]}')


def run_check(
    input_path: Path,
    options: CheckOptions,
    output=print,
    progress_callback=None,
    cancel_callback=None,
    process_callback=None,
) -> tuple[int, dict[str, object]]:
    spec = build_expected_output_spec(
        preset_index=options.preset_index,
        audio_only=options.audio_only,
    )
    files = collect_media_files(input_path, recursive=options.recursive)
    if not files:
        output('错误: 没有找到可检查的视频文件。')
        return 2, {}

    if progress_callback is not None:
        progress_callback(0, '准备检测...')

    output(f'检查目标: {input_path}')
    output(f'预设: {spec.preset_index} / {spec.preset_key} / {spec.preset_label}')
    output(f'模式: {"仅处理音频" if spec.audio_only_mode else "完整转码"}')
    output(f'文件数: {len(files)}')
    if not options.no_black_detect:
        output(
            '黑场检测: '
            f'd={options.black_min_duration}, '
            f'pic_th={options.black_picture_threshold}, '
            f'pix_th={options.black_pixel_threshold}, '
            f'ignore_edge={options.ignore_edge_black}s'
        )

    results: list[dict[str, object]] = []
    pass_count = 0
    warning_count = 0
    fail_count = 0
    base_path = input_path if input_path.is_dir() else input_path.parent

    total_files = len(files)
    for index, file_path in enumerate(files):
        if cancel_callback is not None and cancel_callback():
            raise OperationCancelledError('检测任务已取消。')
        try:
            result = check_file(
                file_path,
                spec,
                options,
                cancel_callback=cancel_callback,
                process_callback=process_callback,
            )
        except subprocess.CalledProcessError as exc:
            result = {
                'path': str(file_path),
                'status': 'FAIL',
                'duration_seconds': None,
                'issues': {
                    'errors': [asdict(make_issue('error', 'subprocess', f'ffmpeg/ffprobe 执行失败: {exc}'))],
                    'warnings': [],
                    'info': [],
                },
                'black_segments': [],
                'ignored_black_segments': [],
                'detected': {},
            }
        except (OSError, json.JSONDecodeError) as exc:
            result = {
                'path': str(file_path),
                'status': 'FAIL',
                'duration_seconds': None,
                'issues': {
                    'errors': [asdict(make_issue('error', 'probe_read', f'读取媒体信息失败: {exc}'))],
                    'warnings': [],
                    'info': [],
                },
                'black_segments': [],
                'ignored_black_segments': [],
                'detected': {},
            }

        results.append(result)
        print_file_result(base_path, result, verbose=options.verbose, output=output)
        if progress_callback is not None:
            progress_callback(int(((index + 1) / total_files) * 100), f'[{index + 1}/{total_files}] {file_path.name}')

        if result['status'] == 'PASS':
            pass_count += 1
        elif result['status'] == 'PASS_WITH_WARNINGS':
            warning_count += 1
        else:
            fail_count += 1

    summary = {
        'total': len(results),
        'pass': pass_count,
        'pass_with_warnings': warning_count,
        'fail': fail_count,
    }

    output('\n汇总:')
    output(f'  通过: {summary["pass"]}')
    output(f'  警告通过: {summary["pass_with_warnings"]}')
    output(f'  失败: {summary["fail"]}')

    report = {
        'checked_at': datetime.now().astimezone().isoformat(),
        'input': str(input_path),
        'spec': spec_to_dict(spec),
        'summary': summary,
        'files': results,
    }

    if options.report_json:
        report_path = Path(options.report_json)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        output(f'JSON 报告已写入: {report_path}')

    return (1 if fail_count else 0), report
