# -*- mode: python ; coding: utf-8 -*-
# ShadowEncoder 合并工程 PyInstaller 打包配置
# 应用名与图标继承 video_check（ShadowEncoder）。

import sys
from pathlib import Path

_project_dir = Path(SPECPATH)
_is_win = sys.platform == 'win32'
_platform_tag = {'win32': 'win', 'darwin': 'mac', 'linux': 'linux'}.get(sys.platform, 'linux')

datas = []
icon_dat_path = None

# SVG 图标作为数据文件随包
svg_path = _project_dir / 'icon.svg'
if svg_path.exists():
    datas.append((str(svg_path), '.'))

# 应用图标（继承 video_check）
if _is_win:
    icon_path = _project_dir / 'icon.ico'
    if not icon_path.exists():
        raise SystemExit('Missing required icon.ico. Run build_icon.py before packaging.')
    icon_dat_path = str(icon_path)

# ── 捆绑 ffmpeg 二进制（统一放在 ffmpeg/win）──
_bin_dir = _project_dir / 'ffmpeg' / _platform_tag
_binaries = []
for _tool in ['ffmpeg', 'ffprobe', 'ffplay', 'img2webp', 'webpmux']:
    _ext = '.exe' if _is_win else ''
    _p = _bin_dir / f'{_tool}{_ext}'
    if _p.is_file():
        _binaries.append((str(_p), '.'))
        print(f'[打包] 捆绑 {_tool}{_ext}: {_p}')
    else:
        print(f'[警告] 未找到 {_tool}{_ext}，跳过（开发模式可走 PATH）')

a = Analysis(
    ['shadowencoder_gui.py'],
    pathex=[str(_project_dir)],
    binaries=_binaries,
    datas=datas,
    hiddenimports=[
        'PySide6.QtSvg',
        'PySide6.QtSvgWidgets',
        'PySide6.QtMultimedia',
        'PySide6.QtMultimediaWidgets',
        'cv2',
        'numpy',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

if sys.platform == 'darwin':
    app = BUNDLE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        name='ShadowEncoder.app',
        icon=icon_dat_path,
        bundle_identifier='com.shadowencoder.app',
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='ShadowEncoder',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=icon_dat_path,
    )
