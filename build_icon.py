#!/usr/bin/env python3

from __future__ import annotations

import struct
from pathlib import Path

from PyQt5 import QtCore, QtGui, QtSvg


ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def render_png_bytes(renderer: QtSvg.QSvgRenderer, size: int) -> bytes:
    image = QtGui.QImage(size, size, QtGui.QImage.Format_ARGB32)
    image.fill(QtCore.Qt.transparent)

    painter = QtGui.QPainter(image)
    renderer.render(painter)
    painter.end()

    byte_array = QtCore.QByteArray()
    buffer = QtCore.QBuffer(byte_array)
    buffer.open(QtCore.QIODevice.WriteOnly)
    if not image.save(buffer, b'PNG'):
        raise SystemExit(f'Failed to render PNG icon at size {size}')
    buffer.close()
    return bytes(byte_array)


def build_icon(svg_path: Path, ico_path: Path) -> None:
    renderer = QtSvg.QSvgRenderer(str(svg_path))
    if not renderer.isValid():
        raise SystemExit(f'Invalid SVG icon: {svg_path}')

    image_blobs: list[tuple[int, bytes]] = [
        (size, render_png_bytes(renderer, size))
        for size in ICON_SIZES
    ]

    header = struct.pack('<HHH', 0, 1, len(image_blobs))
    entries: list[bytes] = []
    offset = 6 + 16 * len(image_blobs)

    for size, blob in image_blobs:
        icon_size = 0 if size >= 256 else size
        entries.append(
            struct.pack(
                '<BBBBHHII',
                icon_size,
                icon_size,
                0,
                0,
                1,
                32,
                len(blob),
                offset,
            )
        )
        offset += len(blob)

    ico_path.write_bytes(header + b''.join(entries) + b''.join(blob for _size, blob in image_blobs))


def main() -> int:
    project_dir = Path(__file__).resolve().parent
    svg_path = project_dir / 'icon.svg'
    ico_path = project_dir / 'icon.ico'

    if not svg_path.exists():
        raise SystemExit(f'Missing icon.svg: {svg_path}')

    build_icon(svg_path, ico_path)
    print(f'Wrote {ico_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
