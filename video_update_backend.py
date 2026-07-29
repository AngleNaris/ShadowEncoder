#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

__version__ = "2.2.0"

UPDATE_URL = "https://cdn.3efs.com/xtools/shadowencoder/version.json"


@dataclass
class UpdateInfo:
    version: str
    release_date: str
    release_notes: str
    download_url: str
    file_size: int
    sha256: str = ""


def _version_tuple(v: str) -> tuple[int, ...]:
    """将版本号解析为可比较的整数元组。

    容错规则：
    - 去除首尾空白与可选的 'v' 前缀（如 'v1.2.3' → '1.2.3'）
    - 对非数字段（如 dev / beta / rc，或 '1.0.0-beta' 这类带后缀的段）：
      提取前导数字部分参与比较，无数字时按 0 处理，避免崩溃。
    """
    v = v.strip()
    if v[:1].lower() == 'v':
        v = v[1:]
    result = []
    for part in v.split('.'):
        m = re.match(r'\d+', part)
        result.append(int(m.group(0)) if m else 0)
    return tuple(result)


def is_newer(remote: str, local: str) -> bool:
    return _version_tuple(remote) > _version_tuple(local)


class UpdateCheckError(Exception):
    pass


def check_update() -> UpdateInfo | None:
    req = urllib.request.Request(UPDATE_URL)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise UpdateCheckError(f"无法获取更新信息: {exc}") from exc

    remote_version = data.get("version", "")
    if not remote_version:
        raise UpdateCheckError("version.json 缺少 version 字段")

    if not is_newer(remote_version, __version__):
        return None

    return UpdateInfo(
        version=data["version"],
        release_date=data.get("release_date", ""),
        release_notes=data.get("release_notes", ""),
        download_url=data["download_url"],
        file_size=data.get("file_size", 0),
        sha256=data.get("sha256", ""),
    )


def _platform_update_suffix() -> str:
    if sys.platform == 'win32':
        return '.exe'
    elif sys.platform == 'darwin':
        return '.app'
    return ''


def download_update(info: UpdateInfo, progress_callback: Callable[[int], None] | None = None) -> Path:
    dest_dir = Path(tempfile.gettempdir()) / "ShadowEncoder_update"
    dest_dir.mkdir(parents=True, exist_ok=True)
    suffix = _platform_update_suffix()
    dest_path = dest_dir / f"ShadowEncoder_v{info.version}{suffix}"

    def reporthook(count: int, block_size: int, total: int) -> None:
        if progress_callback and total > 0:
            percent = min(100, int(count * block_size / total * 100))
            progress_callback(percent)

    urllib.request.urlretrieve(info.download_url, str(dest_path), reporthook=reporthook)

    if info.sha256:
        actual = _sha256_file(dest_path)
        if actual != info.sha256.lower():
            dest_path.unlink(missing_ok=True)
            raise UpdateCheckError(f"SHA256 校验失败\n期望: {info.sha256}\n实际: {actual}")

    return dest_path


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _current_exe_path() -> Path:
    return Path(sys.executable) if getattr(sys, "frozen", False) else Path(sys.argv[0]).resolve()


def cleanup_old_versions() -> None:
    exe_dir = _current_exe_path().parent
    if sys.platform == 'win32':
        for old in exe_dir.glob("*.old.exe"):
            try:
                old.unlink()
            except OSError:
                pass
    else:
        for old in exe_dir.glob("*.old"):
            try:
                if old.is_file():
                    old.unlink()
            except OSError:
                pass


def apply_update(new_path: Path) -> None:
    """Apply a downloaded update. Platform-specific behaviour:

    Windows: NTFS rename trick (rename old → copy new → launch → quit).
    macOS:   Replace .app bundle via shell script.
    Linux:   Replace AppImage via shell script.
    CLI:     Instruct user to replace manually.
    """
    if not getattr(sys, 'frozen', False):
        raise UpdateCheckError(
            '当前运行在开发模式，无法自动更新。\n'
            f'请手动将新版本文件复制到: {_current_exe_path().parent}'
        )

    target = _current_exe_path()

    if sys.platform == 'win32':
        # Try NTFS rename first, fall back to .bat script
        try:
            _ntfs_update(new_path, target)
        except OSError:
            _windows_fallback_update(new_path, target)
    elif sys.platform == 'darwin':
        _macos_update(new_path, target)
    else:
        _linux_update(new_path, target)


def _ntfs_update(new_path: Path, target: Path) -> None:
    new_target = target.parent / new_path.name

    if new_target == target:
        tmp = target.with_suffix(".tmp.exe")
        tmp.unlink(missing_ok=True)
        os.rename(str(target), str(tmp))
        shutil.copy2(str(new_path), str(new_target))
        tmp.unlink(missing_ok=True)
    else:
        shutil.copy2(str(new_path), str(new_target))

    old_path = target.with_suffix(".old.exe")
    old_path.unlink(missing_ok=True)
    if target != new_target:
        os.rename(str(target), str(old_path))

    subprocess.Popen([str(new_target)])


def _windows_fallback_update(new_path: Path, target: Path) -> None:
    new_target = target.parent / new_path.name
    bat = os.path.join(tempfile.gettempdir(), 'ShadowEncoder_updater.bat')
    with open(bat, 'w', encoding='utf-8') as f:
        f.write('@echo off\n')
        f.write('chcp 65001 >nul\n')
        f.write('echo Updating ShadowEncoder...\n')
        f.write('timeout /t 5 /nobreak >nul\n')
        f.write(f'if not exist "{new_path}" (\n')
        f.write('  echo New version file not found.\n')
        f.write('  pause\n')
        f.write('  exit /b 1\n')
        f.write(')\n')
        f.write(f'move /y "{new_path}" "{new_target}"\n')
        f.write('if errorlevel 1 (\n')
        f.write('  echo Update failed. Please replace the file manually.\n')
        f.write('  pause\n')
        f.write('  exit /b 1\n')
        f.write(')\n')
        f.write(f'start "" "{new_target}"\n')
        f.write('del "%~f0"\n')

    subprocess.Popen(
        ['cmd', '/c', bat],
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )


def _macos_update(new_path: Path, target: Path) -> None:
    sh = os.path.join(tempfile.gettempdir(), 'ShadowEncoder_updater.sh')
    with open(sh, 'w', encoding='utf-8') as f:
        f.write('#!/bin/bash\n')
        f.write('sleep 3\n')
        f.write(f'rm -rf "{target}"\n')
        f.write(f'cp -R "{new_path}" "{target}"\n')
        f.write(f'open "{target}"\n')
        f.write(f'rm -f "{sh}"\n')

    os.chmod(sh, 0o755)
    subprocess.Popen([sh])


def _linux_update(new_path: Path, target: Path) -> None:
    sh = os.path.join(tempfile.gettempdir(), 'ShadowEncoder_updater.sh')
    with open(sh, 'w', encoding='utf-8') as f:
        f.write('#!/bin/bash\n')
        f.write('sleep 3\n')
        f.write(f'mv "{new_path}" "{target}"\n')
        f.write(f'chmod +x "{target}"\n')
        f.write(f'"{target}" &\n')
        f.write(f'rm -f "{sh}"\n')

    os.chmod(sh, 0o755)
    subprocess.Popen([sh])
