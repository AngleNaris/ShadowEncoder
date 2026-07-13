#!/usr/bin/env python3
"""ShadowEncoder 合并工程跨平台构建脚本。

Usage:
    python build.py          # 构建当前平台
    python build.py --clean  # 从零清理构建

Prerequisites:
    - PyInstaller (pip install pyinstaller)
    - PySide6 (pip install PySide6)
    - opencv-python-headless (AlphaVideoTool 播放/截图预览需要)
    - ffmpeg 二进制放在 ffmpeg/<platform>/
"""

import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent
SPEC_FILE = PROJECT_DIR / 'shadowencoder.spec'
ICON_SVG = PROJECT_DIR / 'icon.svg'
ICON_ICO = PROJECT_DIR / 'icon.ico'


def ensure_icon() -> None:
    """若缺少 icon.ico，则从 icon.svg 生成（继承 video_check）。"""
    if ICON_ICO.exists():
        return
    build_icon = PROJECT_DIR / 'build_icon.py'
    if build_icon.exists():
        print('从 icon.svg 生成 icon.ico ...')
        subprocess.run([sys.executable, str(build_icon)], check=True, cwd=str(PROJECT_DIR))


def clean_build_dirs() -> None:
    for name in ('build', 'dist', '__pycache__'):
        path = PROJECT_DIR / name
        if path.exists():
            print(f'清理: {path}')
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()


def check_ffmpeg_bundled() -> None:
    """校验 ffmpeg / ffprobe / img2webp 是否可被定位。"""
    try:
        from video_conv_config import get_ffmpeg_bin, get_ffprobe_bin
        print(f'ffmpeg:  {get_ffmpeg_bin()}')
        print(f'ffprobe: {get_ffprobe_bin()}')
    except FileNotFoundError as exc:
        print(f'WARNING: {exc}')

    try:
        from alpha_video_backend import _get_img2webp_bin
        print(f'img2webp: {_get_img2webp_bin()}')
    except Exception as exc:  # noqa: BLE001
        print(f'WARNING: img2webp 未找到: {exc}')


def build() -> None:
    ensure_icon()
    check_ffmpeg_bundled()

    print('运行 PyInstaller ...')
    cmd = [sys.executable, '-m', 'PyInstaller', '--noconfirm', str(SPEC_FILE)]
    subprocess.run(cmd, check=True, cwd=str(PROJECT_DIR))

    dist_dir = PROJECT_DIR / 'dist'
    if not dist_dir.exists():
        print('构建完成但未找到 dist/ 目录。')
        return

    entries = list(dist_dir.iterdir())
    if not entries:
        print('构建完成但 dist/ 为空。')
        return

    print('\n构建成功！输出：')
    for entry in entries:
        if entry.is_file():
            size_mb = entry.stat().st_size / (1024 * 1024)
            print(f'  {entry.name}  ({size_mb:.1f} MB)')
        elif entry.is_dir():
            total = sum(f.stat().st_size for f in entry.rglob('*') if f.is_file())
            print(f'  {entry.name}/  ({total / (1024 * 1024):.1f} MB)')
        else:
            print(f'  {entry.name}')


def main() -> int:
    if '--clean' in sys.argv:
        clean_build_dirs()
    build()
    return 0


if __name__ == '__main__':
    sys.exit(main())
