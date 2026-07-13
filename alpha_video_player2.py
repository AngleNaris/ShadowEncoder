#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 基于 OpenCV 的视频播放器"""

from __future__ import annotations

import cv2
import os
from pathlib import Path

from PySide6 import QtCore, QtGui, QtWidgets
from PySide6.QtMultimedia import QMediaPlayer, QAudioOutput

from alpha_video_config import get_video_info, format_time, parse_time


class SeekSlider(QtWidgets.QSlider):
    """任意位置按住即可跳转并连续拖动，支持显示区间"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._range_start = 0.0
        self._range_end = 0.0
        self._show_range = False

    def set_loop_range_visual(self, start_ratio: float, end_ratio: float) -> None:
        self._range_start = start_ratio
        self._range_end = end_ratio
        self._show_range = start_ratio < end_ratio
        self.update()

    def paintEvent(self, event) -> None:
        super().paintEvent(event)
        if not self._show_range:
            return
        # 在 groove 上方绘制淡黄色区间条（在 handle 之上，确保可见）
        painter = QtGui.QPainter(self)
        groove_h = 6
        bar_y = (self.height() - groove_h) // 2
        x1 = 4 + int((self.width() - 8) * self._range_start)
        x2 = 4 + int((self.width() - 8) * self._range_end)
        if x2 > x1 + 1:
            painter.fillRect(x1, bar_y, x2 - x1, groove_h, QtGui.QColor(255, 235, 140))
        painter.end()

    def mousePressEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() == QtCore.Qt.LeftButton:
            # 先跳到点击位置
            val = QtWidgets.QStyle.sliderValueFromPosition(
                self.minimum(), self.maximum(), event.position().x(), self.width()
            )
            self.setValue(val)
            self.sliderPressed.emit()
        # 交给父类处理，此时 handle 已在鼠标位置，自动进入拖动模式
        super().mousePressEvent(event)


class CvPlayer(QtWidgets.QWidget):
    """基于 OpenCV (cv2.VideoCapture) 的视频播放器"""
    frame_changed = QtCore.Signal(float)
    crop_changed = QtCore.Signal(int, int, int, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._video_path = ''
        self._cap: cv2.VideoCapture | None = None
        self._fps = 25.0
        self._duration = 0.0
        self._video_width = 0
        self._video_height = 0
        self._total_frames = 0
        self._current_frame = 0
        self._paused = True
        self._play_timer: int | None = None
        self._volume = 80
        self._loop_start = 0.0
        self._loop_end = 0.0
        self._loop_enabled = False

        # 音频播放 (QMediaPlayer 独立于 OpenCV 视频)
        self._audio_output = QAudioOutput()
        self._audio_output.setVolume(self._volume / 100.0)
        self._media_player = QMediaPlayer()
        self._media_player.setAudioOutput(self._audio_output)

        self._setup_ui()
        self.setEnabled(False)

    def _setup_ui(self):
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        # 视频显示
        self._video_label = QtWidgets.QLabel()
        self._video_label.setAlignment(QtCore.Qt.AlignCenter)
        self._video_label.setMinimumHeight(200)
        self._video_label.setStyleSheet(
            'background: #0d0b12; border: 1px solid #49454f;'
        )
        self._video_label.setText('拖放视频文件到左侧输入框')
        layout.addWidget(self._video_label, 1)

        # 进度条
        slider_row = QtWidgets.QHBoxLayout()
        slider_row.setSpacing(8)

        self._time_label = QtWidgets.QLabel('00:00:00.000')
        self._time_label.setObjectName('DetailLabel')
        self._time_label.setFixedWidth(95)

        self._time_slider = SeekSlider(QtCore.Qt.Horizontal)
        self._time_slider.setRange(0, 10000)
        self._time_slider.sliderPressed.connect(self._on_slider_pressed)
        self._time_slider.sliderReleased.connect(self._on_slider_released)
        self._time_slider.setStyleSheet(
            'QSlider::groove:horizontal { background: transparent; border: none; }'
        )

        self._duration_label = QtWidgets.QLabel('00:00:00.000')
        self._duration_label.setObjectName('DetailLabel')
        self._duration_label.setFixedWidth(95)
        self._duration_label.setAlignment(QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter)

        slider_row.addWidget(self._time_label)
        slider_row.addWidget(self._time_slider, 1)
        slider_row.addWidget(self._duration_label)
        layout.addLayout(slider_row)

        # 控制按钮 + 音量
        controls = QtWidgets.QHBoxLayout()
        controls.setSpacing(6)

        self._btn_prev = QtWidgets.QPushButton('上一帧')
        self._btn_prev.setMinimumWidth(65)
        self._btn_play = QtWidgets.QPushButton('播放')
        self._btn_play.setMinimumWidth(65)
        self._btn_next = QtWidgets.QPushButton('下一帧')
        self._btn_next.setMinimumWidth(65)
        self._btn_stop = QtWidgets.QPushButton('停止')
        self._btn_stop.setMinimumWidth(55)

        self._btn_prev.clicked.connect(self._step_backward)
        self._btn_play.clicked.connect(self._toggle_play)
        self._btn_next.clicked.connect(self._step_forward)
        self._btn_stop.clicked.connect(self._stop)

        controls.addWidget(self._btn_prev)
        controls.addWidget(self._btn_play)

        # 循环按钮 — 紧挨播放按钮右侧
        self._btn_loop = QtWidgets.QPushButton('循环')
        self._btn_loop.setCheckable(True)
        self._btn_loop.setMinimumWidth(45)
        self._btn_loop.toggled.connect(self._on_loop_toggled)
        self._btn_loop.setStyleSheet(
            'QPushButton:checked { background: #4f378b; color: #bfabf1; }'
        )
        controls.addWidget(self._btn_loop)

        controls.addWidget(self._btn_next)
        controls.addWidget(self._btn_stop)
        controls.addSpacing(8)

        # 音量
        controls.addSpacing(12)
        vol_label = QtWidgets.QLabel('音量:')
        vol_label.setObjectName('HintLabel')
        self._vol_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
        self._vol_slider.setRange(0, 100)
        self._vol_slider.setValue(self._volume)
        self._vol_slider.setFixedWidth(80)
        self._vol_slider.valueChanged.connect(self._on_volume_change)
        self._vol_slider.setStyleSheet(
            'QSlider::groove:horizontal { background: transparent; border: none; }'
        )

        controls.addWidget(vol_label)
        controls.addWidget(self._vol_slider)

        # 跳转
        controls.addStretch()
        jump_label = QtWidgets.QLabel('跳转到:')
        jump_label.setObjectName('HintLabel')
        self._jump_edit = QtWidgets.QLineEdit()
        self._jump_edit.setPlaceholderText('HH:MM:SS')
        self._jump_edit.setFixedWidth(75)
        self._jump_edit.returnPressed.connect(self._jump_to)
        btn_jump = QtWidgets.QPushButton('跳转')
        btn_jump.setMinimumWidth(45)
        btn_jump.clicked.connect(self._jump_to)

        controls.addWidget(jump_label)
        controls.addWidget(self._jump_edit)
        controls.addWidget(btn_jump)

        layout.addLayout(controls)

        # 裁剪覆盖层 (放在视频标签上面)
        from alpha_video_player import CropOverlay
        self._crop_overlay = CropOverlay(self._video_label)
        self._crop_overlay.setGeometry(self._video_label.rect())
        self._crop_overlay.crop_changed.connect(self.crop_changed.emit)

        # 裁剪信息
        self._crop_info_label = QtWidgets.QLabel('')
        self._crop_info_label.setObjectName('HintLabel')
        layout.addWidget(self._crop_info_label)

    # ── 裁剪选区支持 ────────────────────────────────────────

    def get_crop_rect(self) -> tuple | None:
        r = self._crop_overlay.get_rect()
        if r.isEmpty():
            return None
        return self._map_to_video_coords(r)

    def set_crop_aspect(self, w: int, h: int) -> None:
        """锁定裁剪框宽高比"""
        self._crop_overlay.set_aspect_ratio(w, h)

    def clear_crop(self) -> None:
        self._crop_overlay.clear_rect()
        self._crop_info_label.setText('')

    def _map_to_video_coords(self, widget_rect: QtCore.QRect) -> tuple:
        vw, vh = self._video_width, self._video_height
        cw, ch = self._video_label.width(), self._video_label.height()
        scale = min(cw / vw, ch / vh) if vw > 0 and vh > 0 else 1.0
        dw, dh = int(vw * scale), int(vh * scale)
        ox, oy = (cw - dw) // 2, (ch - dh) // 2
        x = max(0, int((widget_rect.x() - ox) / scale))
        y = max(0, int((widget_rect.y() - oy) / scale))
        w = min(vw - x, int(widget_rect.width() / scale))
        h = min(vh - y, int(widget_rect.height() / scale))
        return (x, y, w, h)

    # ── 公开 API ────────────────────────────────────────────

    def load_video(self, video_path: str) -> None:
        self._stop_playback()
        self._video_path = video_path

        # 获取视频信息
        info = get_video_info(video_path)
        if not info:
            self._video_label.setText('无法读取视频')
            self.setEnabled(False)
            return

        self._fps = info.get('fps', 25.0)
        self._duration = info.get('duration', 0)
        self._video_width = info.get('width', 0)
        self._video_height = info.get('height', 0)
        self._duration_label.setText(format_time(self._duration))

        # 打开视频
        self._cap = cv2.VideoCapture(video_path)
        if not self._cap.isOpened():
            self._video_label.setText('无法打开视频')
            self.setEnabled(False)
            return

        self._total_frames = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self._paused = True
        self._current_frame = 0
        self._btn_play.setText('播放')

        # 设置音频源
        self._media_player.setSource(QtCore.QUrl.fromLocalFile(video_path))

        # 显示第一帧
        self._seek_and_show(0)

        self._update_slider_from_time(0)
        self.setEnabled(True)

    def get_current_time(self) -> float:
        return self._current_frame / self._fps if self._fps > 0 else 0.0

    def clear_video(self) -> None:
        self._stop_playback()
        self._media_player.stop()
        if self._cap:
            self._cap.release()
            self._cap = None
        self._video_label.clear()
        self._video_label.setText('拖放视频文件到左侧输入框')
        self.setEnabled(False)

    def get_volume(self) -> int:
        return self._volume

    def set_loop_range(self, start: float, end: float) -> None:
        """设置循环播放区间（秒）"""
        self._loop_start = max(0.0, start)
        self._loop_end = min(end, self._duration)
        self._loop_enabled = self._loop_end > self._loop_start
        # 在进度条上显示区间
        if self._duration > 0:
            self._time_slider.set_loop_range_visual(
                self._loop_start / self._duration,
                self._loop_end / self._duration,
            )
        else:
            self._time_slider.set_loop_range_visual(0, 0)

    def toggle_loop(self) -> bool:
        """切换循环播放开关，返回当前状态"""
        if self._loop_end > self._loop_start:
            self._loop_enabled = not self._loop_enabled
        else:
            self._loop_enabled = False
        return self._loop_enabled

    def get_loop_range(self) -> tuple:
        """返回当前循环区间 (start, end, enabled)"""
        return (self._loop_start, self._loop_end, self._loop_enabled)

    # ── 内部 ────────────────────────────────────────────────

    def _stop_playback(self):
        self._paused = True
        if self._play_timer is not None:
            self.killTimer(self._play_timer)
            self._play_timer = None
        self._btn_play.setText('播放')

    def _seek_and_show(self, frame_idx: int):
        """Seek 到指定帧并显示"""
        if not self._cap:
            return
        frame_idx = max(0, min(frame_idx, max(0, self._total_frames - 1)))
        self._cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = self._cap.read()
        if ret and frame is not None:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            h, w, _ = frame.shape
            qimg = QtGui.QImage(frame.data, w, h, w * 3, QtGui.QImage.Format_RGB888)
            pixmap = QtGui.QPixmap.fromImage(qimg)
            self._show_pixmap(pixmap)
            self._current_frame = frame_idx
        else:
            self._current_frame = frame_idx
        # 同步音频位置
        self._media_player.setPosition(int(self.get_current_time() * 1000))

    def _show_pixmap(self, pixmap: QtGui.QPixmap):
        scaled = pixmap.scaled(
            self._video_label.size(),
            QtCore.Qt.KeepAspectRatio,
            QtCore.Qt.SmoothTransformation,
        )
        self._video_label.setPixmap(scaled)

    def _update_video_bounds(self) -> None:
        """计算并设置视频画面在控件内的实际区域，限制裁剪选区不超出画面"""
        vw, vh = self._video_width, self._video_height
        cw, ch = self._video_label.width(), self._video_label.height()
        if vw <= 0 or vh <= 0 or cw <= 0 or ch <= 0:
            return
        scale = min(cw / vw, ch / vh)
        dw, dh = int(vw * scale), int(vh * scale)
        ox, oy = (cw - dw) // 2, (ch - dh) // 2
        self._crop_overlay.set_video_bounds(ox, oy, dw, dh)

    def _show_current_frame(self):
        """显示当前帧 (不 seek)"""
        if not self._cap:
            return
        ret, frame = self._cap.read()
        if ret and frame is not None:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            h, w, _ = frame.shape
            qimg = QtGui.QImage(frame.data, w, h, w * 3, QtGui.QImage.Format_RGB888)
            pixmap = QtGui.QPixmap.fromImage(qimg)
            self._show_pixmap(pixmap)
            self._current_frame += 1

    def _update_slider_from_time(self, t: float):
        val = int(t / self._duration * 10000) if self._duration > 0 else 0
        self._time_slider.blockSignals(True)
        self._time_slider.setValue(min(val, 10000))
        self._time_slider.blockSignals(False)
        self._time_label.setText(format_time(t))
        self.frame_changed.emit(t)

    # ── 播放控制 ────────────────────────────────────────────

    def _toggle_play(self):
        if self._paused:
            self._play()
        else:
            self._pause()

    def _play(self):
        if not self._cap:
            return
        if self._current_frame >= self._total_frames - 1:
            self._seek_and_show(0)
        self._paused = False
        self._btn_play.setText('暂停')
        interval = max(16, int(1000.0 / self._fps))
        self._play_timer = self.startTimer(interval)
        # 音频: 从当前位置开始播放
        self._media_player.setPosition(int(self.get_current_time() * 1000))
        self._media_player.play()

    def _pause(self):
        self._stop_playback()
        self._media_player.pause()

    def _stop(self):
        self._stop_playback()
        self._media_player.stop()
        if self._cap:
            self._seek_and_show(0)
        self._time_slider.setValue(0)
        self._time_label.setText('00:00:00.000')

    def _step_forward(self):
        self._pause()
        self._seek_and_show(self._current_frame + 1)
        self._update_slider_from_time(self.get_current_time())

    def _step_backward(self):
        self._pause()
        self._seek_and_show(self._current_frame - 1)
        self._update_slider_from_time(self.get_current_time())

    def _jump_to(self):
        text = self._jump_edit.text().strip()
        if not text:
            return
        t = parse_time(text)
        if t is not None:
            self._pause()
            frame = int(t * self._fps)
            self._seek_and_show(frame)
            self._update_slider_from_time(t)
        self._jump_edit.clear()

    def _on_volume_change(self, value: int):
        self._volume = value
        self._audio_output.setVolume(value / 100.0)

    # ── 定时器 ──────────────────────────────────────────────

    def timerEvent(self, event):
        if self._paused or not self._cap:
            return
        # 循环播放检查
        end_check = (self._loop_end if self._loop_enabled and self._loop_end > 0
                     else self._duration)
        if self._current_frame / self._fps >= end_check:
            if self._loop_enabled and self._loop_start < self._loop_end:
                frame = int(self._loop_start * self._fps)
                self._seek_and_show(frame)
                self._update_slider_from_time(self._loop_start)
                return
            else:
                self._pause()
                return
        self._show_current_frame()
        t = self.get_current_time()
        self._update_slider_from_time(t)

    # ── 滑块 ────────────────────────────────────────────────

    def _on_slider_pressed(self):
        self._pause()

    def _on_slider_released(self):
        val = self._time_slider.value()
        t = val / 10000.0 * self._duration if self._duration > 0 else 0
        frame = int(t * self._fps)
        self._seek_and_show(frame)
        self._update_slider_from_time(t)

    def _on_loop_toggled(self, checked: bool) -> None:
        self._loop_enabled = checked

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self._video_label.pixmap():
            self._show_pixmap(self._video_label.pixmap())
        self._crop_overlay.setGeometry(self._video_label.rect())
        self._update_video_bounds()
