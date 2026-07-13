#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

cfg_base = [
        '-preset', 'slow',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        ]

# cfg_xxx : [hint, vfCmd, base, pass1, pass2]

cfg_gpu_list = [
        [['', '不使用显卡加速'], [], ['-c:v', 'h264'], [], []],
        [['', 'NVidia 显卡'], [], ['-c:v', 'h264_nvenc'], [], []],
        [['', 'Intel 显卡'], [], ['-c:v', 'h264_qsv'], [], []],
        [['', 'AMD 显卡'], [], ['-c:v', 'h264_amf'], [], []],
        ]

cfg_unsharp_list = [
        [['s0', '强度0'], [], [], [], []],
        [['s0.5', '强度0.5'], ['unsharp=5:5:0.5:5:5:0.0'], [], [], []],
        [['s0.8', '强度0.8 (默认)'], ['unsharp=5:5:0.8:5:5:0.0'], [], [], []],
        [['s1.2', '强度1.2'], ['unsharp=5:5:1.2:5:5:0.0'], [], [], []],
        [['s1.5', '强度1.5'], ['unsharp=7:7:1.5:7:7:0.0'], [], [], []],
        ]

cfg_denoise_list = [
        [['d0', '无降噪'], [], [], [], []],
        [['d1', '轻度降噪', '(默认)'], ['hqdn3d=2:2:3:3'], [], [], []],
        [['d2', '中度降噪+去块'], ['hqdn3d=4:4:6:6,deblock=filter=weak:block=4'], [], [], []],
        [['d3', '强力降噪+去块'], ['hqdn3d=7:7:10:10,deblock=filter=strong:block=4'], [], [], []],
        ]

cfg_tune_list = [
        [['tn', '无风格'], [], [], [], []],
        [['tfilm', '实拍视频'], [], ['-tune', 'film'], [], []],
        [['tani', '动画类', '(默认)'], [], ['-tune', 'animation'], [], []],
        ]

cfg_preset_list = [
        [['vod1280', "点歌屏\t1280 x ???\t无音频"], ['scale=1280:-2'], [
            '-b:v', '2M',
            '-maxrate', '2M',
            '-bufsize', '4M',
            '-r', '25',
            ], [], [
            '-an',
            ]],
        [['int720', "互动屏标清\t720 x ???\t无音频"], ['scale=720:-2'], [
            '-b:v', '2M',
            '-maxrate', '2M',
            '-bufsize', '4M',
            '-r', '25',
            ], [], [
            '-an',
            ]],
        [['int1080', "互动屏高清\t1080 x ???\t无音频"], ['scale=1080:-2'], [
            '-b:v', '5M',
            '-maxrate', '5M',
            '-bufsize', '10M',
            '-r', '25',
            ], [], [
            '-an',
            ]],
        [['tv1280', "电视屏低清\t1280 x ???"], ['scale=1280:-2'], [
            '-b:v', '5M',
            '-maxrate', '5M',
            '-bufsize', '10M',
            '-r', '25',
            ], [], [
            '-ar', '44100',
            '-profile:a', 'aac_low',
            '-c:a', 'aac',
            '-b:a', '320k',
            ]],
        [['tv1920', "电视屏标清\t1920 x ???"], ['scale=1920:-2'], [
            '-b:v', '10M',
            '-maxrate', '10M',
            '-bufsize', '20M',
            '-r', '25',
            ], [], [
            '-ar', '44100',
            '-profile:a', 'aac_low',
            '-c:a', 'aac',
            '-b:a', '320k',
            ]],
        [['tv2560', "电视屏高清\t2560 x ???"], ['scale=2560:-2'], [
            '-b:v', '12M',
            '-maxrate', '12M',
            '-bufsize', '24M',
            '-r', '25',
            ], [], [
            '-ar', '44100',
            '-profile:a', 'aac_low',
            '-c:a', 'aac',
            '-b:a', '320k',
            ]],
        [['tv3840', "电视屏4K\t3840 x ???"], ['scale=3840:-2'], [
            '-b:v', '14M',
            '-maxrate', '14M',
            '-bufsize', '28M',
            '-r', '25',
            '-level:v', '5.1',
            ], [], [
            '-ar', '44100',
            '-profile:a', 'aac_low',
            '-c:a', 'aac',
            '-b:a', '320k',
            ]],
        ]

DEFAULT_CFG_GPU = 0
DEFAULT_CFG_UNSHARP = 2
DEFAULT_CFG_DENOISE = 1
DEFAULT_CFG_TUNE = 2
DEFAULT_CFG_PRESET = 6
DEFAULT_CFG_LOUDNORM = True
DEFAULT_CFG_AUDIO_ONLY = 0

MEDIA_EXTENSIONS = {
        '.avi',
        '.flv',
        '.mkv',
        '.mov',
        '.mp4',
        '.mpeg',
        '.mpg',
        '.ts',
        '.wmv',
}

AAC_LOW_PROFILE_NAMES = ('lc', 'aac lc', 'aac low')


class OperationCancelledError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExpectedOutputSpec:
    preset_index: int
    preset_key: str
    preset_label: str
    audio_only_mode: bool
    container_extension: str
    requires_faststart: bool
    width: int | None
    video_codec_names: tuple[str, ...]
    pixel_formats: tuple[str, ...]
    video_profiles: tuple[str, ...]
    video_level: int | None
    fps: float | None
    target_video_bitrate: int | None
    max_video_bitrate: int | None
    bufsize: int | None
    expects_audio: bool
    audio_codec_names: tuple[str, ...]
    audio_profiles: tuple[str, ...]
    audio_sample_rate: int | None
    target_audio_bitrate: int | None
    unchecked_options: tuple[str, ...]


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


def is_media_file(file_path: str | os.PathLike[str]) -> bool:
    return Path(file_path).suffix.lower() in MEDIA_EXTENSIONS


def list_preset_choices() -> list[tuple[int, str, str]]:
    return [
        (index, item[0][0], item[0][1])
        for index, item in enumerate(cfg_preset_list)
    ]


def format_gui_choice_label(raw_label: str) -> str:
    parts = [part.strip() for part in str(raw_label).split('\t') if part.strip()]
    if not parts:
        return str(raw_label).strip()
    return ' | '.join(parts)


def format_gui_preset_label(index: int) -> str:
    preset = cfg_preset_list[index]
    return format_gui_choice_label(preset[0][1])


def resolve_preset(preset_value: str | int | None) -> int:
    if preset_value is None:
        return DEFAULT_CFG_PRESET
    if isinstance(preset_value, int):
        if 0 <= preset_value < len(cfg_preset_list):
            return preset_value
        raise ValueError(f"无效预设索引: {preset_value}")

    value = str(preset_value).strip()
    if value.isdigit():
        return resolve_preset(int(value))

    lowered = value.lower()
    for index, preset in enumerate(cfg_preset_list):
        if preset[0][0].lower() == lowered:
            return index
    raise ValueError(f"未找到预设: {preset_value}")


def _get_option_value(args: list[str], option: str) -> str | None:
    for index in range(len(args) - 1):
        if args[index] == option:
            return args[index + 1]
    return None


def _parse_bitrate(value: str | None) -> int | None:
    if not value:
        return None

    match = re.fullmatch(r'(?P<number>\d+(?:\.\d+)?)(?P<unit>[kKmMgG]?)', value.strip())
    if not match:
        return None

    number = float(match.group('number'))
    unit = match.group('unit').lower()
    multiplier = {
        '': 1,
        'k': 1_000,
        'm': 1_000_000,
        'g': 1_000_000_000,
    }[unit]
    return int(number * multiplier)


def _parse_scale_width(filters: list[str]) -> int | None:
    for item in filters:
        match = re.search(r'scale=(\d+):', item)
        if match:
            return int(match.group(1))
    return None


def _parse_h264_level(value: str | None) -> int | None:
    if not value:
        return None

    try:
        return int(round(float(value) * 10))
    except ValueError:
        return None


def build_expected_output_spec(
    preset_index: int,
    audio_only: bool = False,
) -> ExpectedOutputSpec:
    preset = cfg_preset_list[preset_index]
    preset_key = preset[0][0]
    preset_label = preset[0][1]
    preset_filters = preset[1]
    preset_base = preset[2]
    preset_pass2 = preset[4]

    if audio_only:
        return ExpectedOutputSpec(
            preset_index=preset_index,
            preset_key=preset_key,
            preset_label=preset_label,
            audio_only_mode=True,
            container_extension='mp4',
            requires_faststart=False,
            width=None,
            video_codec_names=(),
            pixel_formats=(),
            video_profiles=(),
            video_level=None,
            fps=None,
            target_video_bitrate=None,
            max_video_bitrate=None,
            bufsize=None,
            expects_audio=True,
            audio_codec_names=('aac',),
            audio_profiles=(),
            audio_sample_rate=None,
            target_audio_bitrate=320_000,
            unchecked_options=(
                '仅处理音频模式会直接复制视频流，无法校验固定视频编码参数。',
                '动态压缩和响度标准化效果无法仅凭元数据反推。',
            ),
        )

    expects_audio = '-an' not in preset_pass2
    audio_profiles = AAC_LOW_PROFILE_NAMES if _get_option_value(preset_pass2, '-profile:a') == 'aac_low' else ()

    return ExpectedOutputSpec(
        preset_index=preset_index,
        preset_key=preset_key,
        preset_label=preset_label,
        audio_only_mode=False,
        container_extension='mp4',
        requires_faststart='+faststart' in cfg_base,
        width=_parse_scale_width(preset_filters),
        video_codec_names=('h264',),
        pixel_formats=(str(_get_option_value(cfg_base, '-pix_fmt') or '').lower(),),
        video_profiles=(),
        video_level=_parse_h264_level(_get_option_value(preset_base, '-level:v')),
        fps=float(_get_option_value(preset_base, '-r')) if _get_option_value(preset_base, '-r') else None,
        target_video_bitrate=_parse_bitrate(_get_option_value(preset_base, '-b:v')),
        max_video_bitrate=_parse_bitrate(_get_option_value(preset_base, '-maxrate')),
        bufsize=_parse_bitrate(_get_option_value(preset_base, '-bufsize')),
        expects_audio=expects_audio,
        audio_codec_names=('aac',) if expects_audio else (),
        audio_profiles=audio_profiles,
        audio_sample_rate=int(_get_option_value(preset_pass2, '-ar')) if _get_option_value(preset_pass2, '-ar') else None,
        target_audio_bitrate=_parse_bitrate(_get_option_value(preset_pass2, '-b:a')),
        unchecked_options=(
            'GPU 编码后端无法从成品文件中可靠区分。',
            '锐化、降噪和 tune 风格滤镜无法仅凭元数据反推。',
            'loudnorm 是否启用无法仅凭元数据严格验证。',
            '两遍码率控制只能通过平均码率做近似判断，无法还原 maxrate/bufsize 的运行时行为。',
        ),
    )
