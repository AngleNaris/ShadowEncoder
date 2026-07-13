#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 视频帧查看器 + 裁剪选区组件"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PySide6 import QtCore, QtGui, QtWidgets

from alpha_video_config import get_video_info, format_time, get_ffmpeg_bin, _hidden_process_kwargs


# ── 帧提取工作线程 ──────────────────────────────────────────

class FrameExtractor(QtCore.QObject):
    """在后台线程提取视频帧为 QPixmap"""
    frame_ready = QtCore.Signal(QtGui.QPixmap, float)  # pixmap, timestamp
    error = QtCore.Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._video_path = ''
        self._temp_dir = None

    def set_video(self, video_path: str) -> None:
        self._video_path = video_path
        if self._temp_dir and os.path.isdir(self._temp_dir):
            import shutil
            shutil.rmtree(self._temp_dir, ignore_errors=True)
        self._temp_dir = tempfile.mkdtemp(prefix='avt_frame_')

    def extract(self, time_sec: float) -> None:
        """提取指定时间点的帧"""
        if not self._video_path:
            return

        output_path = os.path.join(self._temp_dir, f'frame_{time_sec:.3f}.png')

        import subprocess
        cmd = [
            get_ffmpeg_bin(),
            '-y',
            '-ss', str(time_sec),
            '-i', self._video_path,
            '-vframes', '1',
            '-q:v', '2',
            output_path,
        ]
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           **_hidden_process_kwargs(), check=True)
            if os.path.isfile(output_path):
                pixmap = QtGui.QPixmap(output_path)
                self.frame_ready.emit(pixmap, time_sec)
            else:
                self.error.emit(f'帧提取失败: 文件未生成')
        except subprocess.CalledProcessError as e:
            self.error.emit(f'帧提取失败: {e}')
        except Exception as e:
            self.error.emit(f'帧提取失败: {e}')


# ── 裁剪选区覆盖层 ──────────────────────────────────────────

class CropOverlay(QtWidgets.QWidget):
    """在视频帧上拖拽选择裁剪区域"""
    crop_changed = QtCore.Signal(int, int, int, int)  # x, y, w, h

    def __init__(self, parent=None):
        super().__init__(parent)
        self._selecting = False
        self._dragging = False
        self._resizing = False
        self._drag_handle = None
        self._start = QtCore.QPoint()
        self._end = QtCore.QPoint()
        self._rect = QtCore.QRect()  # 当前选区
        self._aspect_ratio = None  # 可选：锁定宽高比
        self._video_rect = QtCore.QRect()  # 视频画面在控件中的实际区域
        self.setMouseTracking(True)
        self.setCursor(QtCore.Qt.CrossCursor)
        self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents, False)

    def set_video_bounds(self, x: int, y: int, w: int, h: int) -> None:
        """设置视频画面在控件中的有效区域，选区将被限制在此范围内"""
        self._video_rect = QtCore.QRect(x, y, w, h)
        if not self._rect.isEmpty():
            self._clamp_rect_to_bounds()
            self.update()

    def set_aspect_ratio(self, w: int, h: int) -> None:
        """锁定宽高比 (0 表示不锁定)，已有选区会立即适配新比例"""
        if w > 0 and h > 0:
            self._aspect_ratio = w / h
        else:
            self._aspect_ratio = None
            return
        # 如果已有选区，按新比例裁剪
        if not self._rect.isEmpty():
            bounds = self._video_rect if self._video_rect.isValid() and not self._video_rect.isEmpty() else self.rect()
            r = self._rect
            new_h = int(r.width() / self._aspect_ratio)
            if new_h <= bounds.height():
                r.setHeight(new_h)
            else:
                new_w = int(r.height() * self._aspect_ratio)
                r.setWidth(new_w)
            self._rect = r
            self._clamp_rect_to_bounds()
            self.update()
            self.crop_changed.emit(r.x(), r.y(), r.width(), r.height())

    def clear_rect(self) -> None:
        self._rect = QtCore.QRect()
        self.update()
        self.crop_changed.emit(0, 0, 0, 0)

    def get_rect(self) -> QtCore.QRect:
        return self._rect

    def set_rect(self, rect: QtCore.QRect) -> None:
        self._rect = rect.normalized()
        self.update()
        if not self._rect.isEmpty():
            self.crop_changed.emit(self._rect.x(), self._rect.y(),
                                   self._rect.width(), self._rect.height())

    def _handle_at(self, pos: QtCore.QPoint) -> str | None:
        """检测鼠标是否在缩放手柄上"""
        if self._rect.isEmpty():
            return None
        r = self._rect
        margin = 8
        handles = {
            'tl': r.topLeft(),
            'tr': r.topRight(),
            'bl': r.bottomLeft(),
            'br': r.bottomRight(),
        }
        for name, pt in handles.items():
            if (pos - pt).manhattanLength() <= margin * 2:
                return name
        if r.adjusted(margin, margin, -margin, -margin).contains(pos):
            return 'move'
        return None

    def paintEvent(self, event) -> None:
        super().paintEvent(event)
        if self._rect.isEmpty():
            return

        painter = QtGui.QPainter(self)
        painter.setRenderHint(QtGui.QPainter.Antialiasing)

        # 半透明遮罩 (选区外)
        mask_color = QtGui.QColor(0, 0, 0, 120)
        painter.setBrush(mask_color)
        painter.setPen(QtCore.Qt.NoPen)

        w, h = self.width(), self.height()
        r = self._rect
        # 上
        painter.drawRect(0, 0, w, r.y())
        # 下
        painter.drawRect(0, r.bottom(), w, h - r.bottom())
        # 左
        painter.drawRect(0, r.y(), r.x(), r.height())
        # 右
        painter.drawRect(r.right(), r.y(), w - r.right(), r.height())

        # 选区边框
        pen = QtGui.QPen(QtGui.QColor('#4f378b'), 2, QtCore.Qt.DashLine)
        painter.setPen(pen)
        painter.setBrush(QtCore.Qt.NoBrush)
        painter.drawRect(r)

        # 角手柄
        handle_size = 8
        handle_color = QtGui.QColor('#bfabf1')
        painter.setBrush(handle_color)
        painter.setPen(QtGui.QPen(QtGui.QColor('#4f378b'), 1))
        for corner in [r.topLeft(), r.topRight(), r.bottomLeft(), r.bottomRight()]:
            painter.drawRect(QtCore.QRect(
                corner.x() - handle_size // 2,
                corner.y() - handle_size // 2,
                handle_size, handle_size
            ))

        # 尺寸信息
        info_rect = QtCore.QRect(r.x(), r.y() - 24, 200, 22)
        if info_rect.y() < 0:
            info_rect.moveTop(r.bottom() + 4)
        painter.setPen(QtCore.Qt.NoPen)
        painter.setBrush(QtGui.QColor(0, 0, 0, 160))
        painter.drawRoundedRect(info_rect, 4, 4)
        painter.setPen(QtGui.QColor('#e6e0e9'))
        font = painter.font()
        font.setPointSize(9)
        painter.setFont(font)
        painter.drawText(info_rect.adjusted(6, 0, -4, 0), QtCore.Qt.AlignVCenter,
                         f'{r.width()} × {r.height()}')

        painter.end()

    def mousePressEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() != QtCore.Qt.LeftButton:
            return
        pos = event.pos()
        handle = self._handle_at(pos)
        if handle:
            self._dragging = handle == 'move'
            self._resizing = handle in ('tl', 'tr', 'bl', 'br')
            self._drag_handle = handle
            self._start = pos
            self._start_rect = QtCore.QRect(self._rect)
        else:
            self._selecting = True
            b = self._bounds()
            self._start = self._clamp_to_bounds(pt=pos)
            self._rect = QtCore.QRect()
            self.update()

    def _clamp_to_bounds(self, pt: QtCore.QPoint | None = None,
                         x: int | None = None, y: int | None = None) -> QtCore.QPoint:
        """将点约束在视频画面边界内"""
        b = self._bounds()
        px = pt.x() if pt is not None else (x if x is not None else 0)
        py = pt.y() if pt is not None else (y if y is not None else 0)
        px = max(b.left(), min(px, b.right()))
        py = max(b.top(), min(py, b.bottom()))
        return QtCore.QPoint(px, py)

    def mouseMoveEvent(self, event: QtGui.QMouseEvent) -> None:
        pos = event.pos()

        # 更新光标
        if not self._selecting and not self._dragging and not self._resizing:
            handle = self._handle_at(pos)
            cursors = {
                'tl': QtCore.Qt.SizeFDiagCursor,
                'br': QtCore.Qt.SizeFDiagCursor,
                'tr': QtCore.Qt.SizeBDiagCursor,
                'bl': QtCore.Qt.SizeBDiagCursor,
                'move': QtCore.Qt.SizeAllCursor,
            }
            self.setCursor(cursors.get(handle, QtCore.Qt.CrossCursor))

        if self._selecting:
            end = self._clamp_to_bounds(pt=pos)
            if self._aspect_ratio:
                dx = abs(end.x() - self._start.x())
                dy = abs(end.y() - self._start.y())
                if dx / max(dy, 1) > self._aspect_ratio:
                    dy = int(dx / self._aspect_ratio)
                else:
                    dx = int(dy * self._aspect_ratio)
                end.setX(self._start.x() + (dx if end.x() > self._start.x() else -dx))
                end.setY(self._start.y() + (dy if end.y() > self._start.y() else -dy))
            self._rect = QtCore.QRect(self._start, end).normalized()
            self._clamp_rect_to_bounds()
            self.update()

        elif self._dragging:
            delta = pos - self._start
            new_rect = self._start_rect.translated(delta)
            b = self._bounds()
            # 限制不超出视频画面
            if new_rect.left() < b.left():
                new_rect.moveLeft(b.left())
            if new_rect.top() < b.top():
                new_rect.moveTop(b.top())
            if new_rect.right() > b.right():
                new_rect.moveRight(b.right())
            if new_rect.bottom() > b.bottom():
                new_rect.moveBottom(b.bottom())
            if new_rect.width() > 10 and new_rect.height() > 10:
                self._rect = new_rect
                self.update()

        elif self._resizing:
            self._resize_rect(pos)

    def _resize_rect(self, pos: QtCore.QPoint) -> None:
        """缩放手柄拖拽，保持在视频画面边界内"""
        r = QtCore.QRect(self._start_rect)
        h = self._drag_handle
        b = self._bounds()

        # 限制鼠标在视频画面内
        clamp = self._clamp_to_bounds(pt=pos)

        if 'l' in h:
            r.setLeft(min(clamp.x(), self._start_rect.right() - 10))
        if 'r' in h:
            r.setRight(max(clamp.x(), self._start_rect.left() + 10))
        if 't' in h:
            r.setTop(min(clamp.y(), self._start_rect.bottom() - 10))
        if 'b' in h:
            r.setBottom(max(clamp.y(), self._start_rect.top() + 10))

        # 强制不超出视频画面边界
        if r.left() < b.left():
            r.setLeft(b.left())
        if r.top() < b.top():
            r.setTop(b.top())
        if r.right() > b.right():
            r.setRight(b.right())
        if r.bottom() > b.bottom():
            r.setBottom(b.bottom())

        if self._aspect_ratio and r.width() > 10:
            new_h = int(r.width() / self._aspect_ratio)
            if 'b' in h:
                r.setBottom(min(r.top() + new_h, b.bottom()))
            else:
                r.setTop(max(r.bottom() - new_h, b.top()))

        if r.width() < 10 or r.height() < 10:
            return
        self._rect = r
        self.update()

    def _bounds(self) -> QtCore.QRect:
        """返回有效的选区边界（视频画面区域，若未设置则用控件边界）"""
        if self._video_rect.isValid() and not self._video_rect.isEmpty():
            return self._video_rect
        return self.rect()

    def _clamp_rect_to_bounds(self) -> None:
        """确保选区不超出视频画面边界"""
        if self._rect.isEmpty():
            return
        r = self._rect
        b = self._bounds()
        changed = False
        if r.left() < b.left():
            r.setLeft(b.left()); changed = True
        if r.top() < b.top():
            r.setTop(b.top()); changed = True
        if r.right() > b.right():
            r.setRight(b.right()); changed = True
        if r.bottom() > b.bottom():
            r.setBottom(b.bottom()); changed = True
        if changed:
            self._rect = r

    def mouseReleaseEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() != QtCore.Qt.LeftButton:
            return
        self._selecting = False
        self._dragging = False
        self._resizing = False
        self._drag_handle = None
        self.setCursor(QtCore.Qt.CrossCursor)

        if not self._rect.isEmpty():
            r = self._rect
            self.crop_changed.emit(r.x(), r.y(), r.width(), r.height())


# ── 自定义滑块 (支持直接点击跳转) ──────────────────────────

class SeekSlider(QtWidgets.QSlider):
    """支持点击滑块轨道直接跳转的时间轴"""

    def mousePressEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() == QtCore.Qt.LeftButton:
            # 直接跳转到点击位置
            val = QtWidgets.QStyle.sliderValueFromPosition(
                self.minimum(), self.maximum(), event.position().x(), self.width()
            )
            self.setValue(val)
            # 手动发出 sliderPressed → sliderReleased 模拟拖拽完成
            self.sliderPressed.emit()
            self.sliderReleased.emit()
        super().mousePressEvent(event)


# ── 视频帧查看器面板 ────────────────────────────────────────

class VideoFrameViewer(QtWidgets.QWidget):
    """视频帧查看器：帧显示 + 时间滑块 + 裁剪选区"""
    frame_changed = QtCore.Signal(float)  # 当前时间 (秒)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._video_path = ''
        self._video_info = None
        self._current_time = 0.0
        self._current_pixmap = None
        self._paused = True
        self._play_timer = None
        self._pending_seek_time = None

        # 防抖定时器：延迟提取帧，避免快速拖拽时大量 ffmpeg 子进程
        self._seek_timer = QtCore.QTimer(self)
        self._seek_timer.setSingleShot(True)
        self._seek_timer.setInterval(200)
        self._seek_timer.timeout.connect(self._do_seek)

        # 帧提取器移到单独线程执行
        self._extractor = FrameExtractor(self)
        self._extractor.frame_ready.connect(self._on_frame_ready)
        self._extractor.error.connect(self._on_extract_error)

        self._setup_ui()

    def _setup_ui(self) -> None:
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        # ── 帧显示区域 ──
        self._frame_container = QtWidgets.QWidget()
        self._frame_container.setMinimumHeight(240)
        self._frame_container.setStyleSheet(
            'background: #0d0b12; border: 1px solid #49454f;'
        )
        frame_layout = QtWidgets.QStackedLayout(self._frame_container)
        frame_layout.setStackingMode(QtWidgets.QStackedLayout.StackAll)

        self._frame_label = QtWidgets.QLabel()
        self._frame_label.setAlignment(QtCore.Qt.AlignCenter)
        self._frame_label.setStyleSheet('background: transparent; border: none;')
        self._frame_label.setText('请先载入视频文件')
        frame_layout.addWidget(self._frame_label)

        self._crop_overlay = CropOverlay()
        self._crop_overlay.crop_changed.connect(self._on_crop_changed)
        frame_layout.addWidget(self._crop_overlay)

        layout.addWidget(self._frame_container, 1)

        # ── 进度条 ──
        slider_row = QtWidgets.QHBoxLayout()
        slider_row.setSpacing(8)

        self._time_label = QtWidgets.QLabel('00:00:00.000')
        self._time_label.setObjectName('DetailLabel')
        self._time_label.setFixedWidth(95)

        self._time_slider = SeekSlider(QtCore.Qt.Horizontal)
        self._time_slider.setRange(0, 1000)
        self._time_slider.setValue(0)
        self._time_slider.sliderPressed.connect(self._on_slider_pressed)
        self._time_slider.sliderReleased.connect(self._on_slider_released)
        self._time_slider.valueChanged.connect(self._on_slider_value_changed)

        self._duration_label = QtWidgets.QLabel('00:00:00.000')
        self._duration_label.setObjectName('DetailLabel')
        self._duration_label.setFixedWidth(95)
        self._duration_label.setAlignment(QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter)

        slider_row.addWidget(self._time_label)
        slider_row.addWidget(self._time_slider, 1)
        slider_row.addWidget(self._duration_label)
        layout.addLayout(slider_row)

        # ── 控制按钮行 ──
        controls = QtWidgets.QHBoxLayout()
        controls.setSpacing(6)

        self._btn_prev_frame = QtWidgets.QPushButton('上一帧')
        self._btn_prev_frame.setMinimumWidth(60)
        self._btn_play = QtWidgets.QPushButton('播放')
        self._btn_play.setMinimumWidth(60)
        self._btn_next_frame = QtWidgets.QPushButton('下一帧')
        self._btn_next_frame.setMinimumWidth(60)

        self._btn_prev_frame.clicked.connect(self._step_backward)
        self._btn_play.clicked.connect(self._toggle_play)
        self._btn_next_frame.clicked.connect(self._step_forward)

        controls.addWidget(self._btn_prev_frame)
        controls.addWidget(self._btn_play)
        controls.addWidget(self._btn_next_frame)
        controls.addStretch()

        jump_label = QtWidgets.QLabel('跳转到:')
        jump_label.setObjectName('HintLabel')
        self._jump_edit = QtWidgets.QLineEdit()
        self._jump_edit.setPlaceholderText('HH:MM:SS')
        self._jump_edit.setFixedWidth(90)
        self._jump_edit.returnPressed.connect(self._jump_to)
        btn_jump = QtWidgets.QPushButton('跳转')
        btn_jump.setFixedWidth(50)
        btn_jump.clicked.connect(self._jump_to)

        controls.addWidget(jump_label)
        controls.addWidget(self._jump_edit)
        controls.addWidget(btn_jump)

        layout.addLayout(controls)

        self._crop_info = QtWidgets.QLabel('裁剪区域: 未选择')
        self._crop_info.setObjectName('HintLabel')
        layout.addWidget(self._crop_info)

        self.setEnabled(False)

    # ── 公共接口 ────────────────────────────────────────────

    def load_video(self, video_path: str) -> None:
        self._video_path = video_path
        self._video_info = get_video_info(video_path)
        self._current_time = 0.0
        self._paused = True
        self._pending_seek_time = None
        self._stop_play_timer()
        self._seek_timer.stop()

        if not self._video_info:
            self._frame_label.setText('无法读取视频信息')
            self.setEnabled(False)
            return

        self._extractor.set_video(video_path)
        self._duration_label.setText(format_time(self._video_info['duration']))
        self._crop_overlay.clear_rect()

        self._btn_play.setText('播放')
        self.setEnabled(True)
        self._seek_to(0.0)

    def get_current_time(self) -> float:
        return self._current_time

    def get_crop_rect(self) -> tuple:
        r = self._crop_overlay.get_rect()
        if r.isEmpty():
            return None
        return self._map_to_video_coords(r)

    def set_crop_aspect(self, w: int, h: int) -> None:
        self._crop_overlay.set_aspect_ratio(w, h)

    def clear_crop(self) -> None:
        self._crop_overlay.clear_rect()
        self._crop_info.setText('裁剪区域: 未选择')

    # ── 内部 ────────────────────────────────────────────────

    def _map_to_video_coords(self, widget_rect: QtCore.QRect) -> tuple:
        if not self._video_info or not self._current_pixmap:
            return (0, 0, 0, 0)

        vw = self._video_info['width']
        vh = self._video_info['height']
        cw = self._frame_label.width()
        ch = self._frame_label.height()

        scale = min(cw / vw, ch / vh) if vw > 0 and vh > 0 else 1.0
        display_w = int(vw * scale)
        display_h = int(vh * scale)
        offset_x = (cw - display_w) // 2
        offset_y = (ch - display_h) // 2

        x = max(0, int((widget_rect.x() - offset_x) / scale))
        y = max(0, int((widget_rect.y() - offset_y) / scale))
        w = min(vw - x, int(widget_rect.width() / scale))
        h = min(vh - y, int(widget_rect.height() / scale))

        return (x, y, w, h)

    def _update_video_bounds(self) -> None:
        """计算并设置视频画面在控件内的实际区域，限制裁剪选区不超出画面"""
        if not self._video_info:
            return
        vw = self._video_info['width']
        vh = self._video_info['height']
        cw = self._frame_label.width()
        ch = self._frame_label.height()
        if vw <= 0 or vh <= 0 or cw <= 0 or ch <= 0:
            return
        scale = min(cw / vw, ch / vh)
        display_w = int(vw * scale)
        display_h = int(vh * scale)
        offset_x = (cw - display_w) // 2
        offset_y = (ch - display_h) // 2
        self._crop_overlay.set_video_bounds(offset_x, offset_y, display_w, display_h)

    def _seek_to(self, time_sec: float) -> None:
        """发起跳转（防抖：手动拖拽时延迟提取，播放时立即提取）"""
        if not self._video_info:
            return
        duration = self._video_info['duration']
        time_sec = max(0.0, min(time_sec, duration))
        self._current_time = time_sec
        self._time_label.setText(format_time(time_sec))
        self._time_slider.blockSignals(True)
        self._time_slider.setValue(int(time_sec / duration * 1000) if duration > 0 else 0)
        self._time_slider.blockSignals(False)
        self.frame_changed.emit(time_sec)

        if self._paused:
            # 手动拖拽时使用防抖
            self._pending_seek_time = time_sec
            self._seek_timer.start()
        else:
            # 播放中立即提取帧
            self._pending_seek_time = None
            self._seek_timer.stop()
            self._extractor.extract(time_sec)

    def _do_seek(self) -> None:
        """防抖定时器触发，真正执行帧提取"""
        if self._pending_seek_time is not None:
            self._extractor.extract(self._pending_seek_time)
            self._pending_seek_time = None

    def _on_frame_ready(self, pixmap: QtGui.QPixmap, timestamp: float) -> None:
        if abs(timestamp - self._current_time) > 0.1:
            return  # 过时的帧
        self._current_pixmap = pixmap
        scaled = pixmap.scaled(
            self._frame_label.size(),
            QtCore.Qt.KeepAspectRatio,
            QtCore.Qt.SmoothTransformation,
        )
        self._frame_label.setPixmap(scaled)
        self._frame_label.setText('')
        self._update_video_bounds()

    def _on_extract_error(self, msg: str) -> None:
        self._frame_label.setText(f'加载失败: {msg}')

    def _on_crop_changed(self, x: int, y: int, w: int, h: int) -> None:
        if w == 0 and h == 0:
            self._crop_info.setText('裁剪区域: 未选择')
            return
        real = self._map_to_video_coords(QtCore.QRect(x, y, w, h))
        self._crop_info.setText(f'裁剪区域: {real[0]},{real[1]}  尺寸: {real[2]}×{real[3]} (视频坐标)')

    # ── 播放控制 ────────────────────────────────────────────

    def _toggle_play(self) -> None:
        if self._paused:
            self._start_play()
        else:
            self._pause()

    def _start_play(self) -> None:
        if not self._video_info:
            return
        self._paused = False
        self._btn_play.setText('暂停')
        fps = self._video_info.get('fps', 25.0)
        interval = max(33, int(1000.0 / fps))
        self._play_timer = self.startTimer(interval)

    def _pause(self) -> None:
        self._paused = True
        self._btn_play.setText('播放')
        self._stop_play_timer()

    def _stop_play_timer(self) -> None:
        if self._play_timer is not None:
            self.killTimer(self._play_timer)
            self._play_timer = None

    def timerEvent(self, event) -> None:
        if not self._video_info or self._paused:
            return
        fps = self._video_info.get('fps', 25.0)
        self._seek_to(self._current_time + 1.0 / fps)

    def _step_forward(self) -> None:
        if not self._video_info:
            return
        fps = self._video_info.get('fps', 25.0)
        self._seek_to(self._current_time + 1.0 / fps)

    def _step_backward(self) -> None:
        if not self._video_info:
            return
        fps = self._video_info.get('fps', 25.0)
        self._seek_to(self._current_time - 1.0 / fps)

    def _jump_to(self) -> None:
        text = self._jump_edit.text().strip()
        if not text:
            return
        from alpha_video_config import parse_time
        t = parse_time(text)
        if t is not None:
            self._seek_to(t)
        self._jump_edit.clear()

    # ── 滑块事件 ────────────────────────────────────────────

    def _on_slider_pressed(self) -> None:
        self._pause()
        self._seek_timer.stop()

    def _on_slider_released(self) -> None:
        if self._video_info:
            val = self._time_slider.value() / 1000.0 * self._video_info['duration']
            self._seek_to(val)

    def _on_slider_value_changed(self, value: int) -> None:
        if self._video_info:
            t = value / 1000.0 * self._video_info['duration']
            self._time_label.setText(format_time(t))

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self._current_pixmap and not self._current_pixmap.isNull():
            scaled = self._current_pixmap.scaled(
                self._frame_label.size(),
                QtCore.Qt.KeepAspectRatio,
                QtCore.Qt.SmoothTransformation,
            )
            self._frame_label.setPixmap(scaled)
        self._update_video_bounds()

    def closeEvent(self, event) -> None:
        self._stop_play_timer()
        self._seek_timer.stop()
        super().closeEvent(event)
