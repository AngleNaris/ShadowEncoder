#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 基于 ffplay 的嵌入式视频播放器"""

from __future__ import annotations

import ctypes
import os
import re
import sys
from pathlib import Path

from PySide6 import QtCore, QtGui, QtWidgets

from alpha_video_config import format_time, parse_time, _hidden_process_kwargs


_FFPLAY_BIN = None


def _get_ffplay_bin() -> str:
    global _FFPLAY_BIN
    if _FFPLAY_BIN:
        return _FFPLAY_BIN
    from alpha_video_config import get_program_dir, _platform_bin_name
    candidates = [
        os.path.join(get_program_dir(), 'ffmpeg', 'win', _platform_bin_name('ffplay')),
        os.path.join(get_program_dir(), _platform_bin_name('ffplay')),
        os.path.join(os.path.dirname(get_program_dir()), 'video_check',
                     'ffmpeg-8.1-essentials_build', 'bin', _platform_bin_name('ffplay')),
    ]
    for c in candidates:
        if os.path.isfile(c):
            _FFPLAY_BIN = c
            return c
    return 'ffplay'


# ── Win32 API ───────────────────────────────────────────────

def _win32_find_window(title_part: str) -> int | None:
    """查找包含指定标题的窗口句柄"""
    if sys.platform != 'win32':
        return None
    try:
        hwnd = ctypes.windll.user32.FindWindowW(None, None)
        while hwnd:
            buf = ctypes.create_unicode_buffer(256)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
            if title_part.lower() in buf.value.lower():
                return hwnd
            hwnd = ctypes.windll.user32.GetWindow(hwnd, 2)  # GW_HWNDNEXT
    except Exception:
        pass
    return None


def _win32_reparent(child_hwnd: int, parent_hwnd: int) -> None:
    """将子窗口嵌入父窗口"""
    if sys.platform != 'win32':
        return
    try:
        GWL_STYLE = -16
        WS_CHILD = 0x40000000
        WS_CAPTION = 0x00C00000
        WS_THICKFRAME = 0x00040000
        style = ctypes.windll.user32.GetWindowLongW(child_hwnd, GWL_STYLE)
        style = (style & ~WS_CAPTION & ~WS_THICKFRAME) | WS_CHILD
        ctypes.windll.user32.SetWindowLongW(child_hwnd, GWL_STYLE, style)
        ctypes.windll.user32.SetParent(child_hwnd, parent_hwnd)
    except Exception:
        pass


def _win32_resize_window(hwnd: int, w: int, h: int) -> None:
    """调整窗口大小"""
    if sys.platform != 'win32':
        return
    try:
        SWP_NOZORDER = 0x0004
        ctypes.windll.user32.SetWindowPos(hwnd, 0, 0, 0, w, h, SWP_NOZORDER)
    except Exception:
        pass


def _win32_get_window_text(hwnd: int) -> str:
    """获取窗口标题"""
    buf = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


_BLOCKING = {'p': True, ' ': True, 's': True, 'q': True}

# ffplay 键盘按键 → Windows 虚拟键码
_KEY_MAP = {
    ' ': 0x20,   # VK_SPACE (暂停)
    'p': 0x50,   # P (暂停)
    'P': 0x50,
    's': 0x53,   # S (逐帧前进)
    'S': 0x53,
    'q': 0x51,   # Q (退出)
    'Q': 0x51,
    'left': 0x25,   # VK_LEFT (后退10s)
    'right': 0x27,  # VK_RIGHT (前进10s)
    'up': 0x26,     # VK_UP (前进60s)
    'down': 0x28,   # VK_DOWN (后退60s)
}


def _win32_send_key(hwnd: int, key_name: str) -> None:
    """发送按键消息到指定窗口"""
    if sys.platform != 'win32':
        return
    vk = _KEY_MAP.get(key_name)
    if vk is None:
        return
    try:
        WM_KEYDOWN = 0x0100
        WM_KEYUP = 0x0101
        ctypes.windll.user32.PostMessageW(hwnd, WM_KEYDOWN, vk, 0)
        ctypes.windll.user32.PostMessageW(hwnd, WM_KEYUP, vk, 0)
    except Exception:
        pass


# ── ffplay 嵌入播放器 ───────────────────────────────────────

class FfplayPlayer(QtWidgets.QWidget):
    """使用 ffplay 嵌入式窗口进行视频播放"""
    position_changed = QtCore.Signal(float)
    frame_changed = position_changed  # 兼容 VideoFrameViewer API

    def __init__(self, parent=None):
        super().__init__(parent)
        self._video_path = ''
        self._duration = 0.0
        self._paused = False
        self._process = None
        self._ffplay_hwnd = None
        self._title_prefix = f'avt_player_{id(self)}'

        self._setup_ui()

        # 定时器：定期同步播放位置
        self._sync_timer = QtCore.QTimer(self)
        self._sync_timer.setInterval(200)
        self._sync_timer.timeout.connect(self._sync_position)

    def _setup_ui(self) -> None:
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        # 视频容器
        self._container = QtWidgets.QWidget()
        self._container.setMinimumHeight(240)
        self._container.setStyleSheet('background: #0d0b12; border: 1px solid #49454f;')
        layout.addWidget(self._container, 1)

        # 裁剪覆盖层
        from alpha_video_player import CropOverlay
        self._crop_overlay = CropOverlay(self._container)
        self._crop_overlay.setGeometry(self._container.rect())

        # 进度条
        slider_row = QtWidgets.QHBoxLayout()
        slider_row.setSpacing(8)

        self._time_label = QtWidgets.QLabel('00:00:00.000')
        self._time_label.setObjectName('DetailLabel')
        self._time_label.setFixedWidth(95)

        self._time_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
        self._time_slider.setRange(0, 1000)
        self._time_slider.setValue(0)
        self._time_slider.sliderPressed.connect(self._on_slider_pressed)
        self._time_slider.sliderReleased.connect(self._on_slider_released)

        self._duration_label = QtWidgets.QLabel('00:00:00.000')
        self._duration_label.setObjectName('DetailLabel')
        self._duration_label.setFixedWidth(95)
        self._duration_label.setAlignment(QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter)

        slider_row.addWidget(self._time_label)
        slider_row.addWidget(self._time_slider, 1)
        slider_row.addWidget(self._duration_label)
        layout.addLayout(slider_row)

        # 控制按钮
        controls = QtWidgets.QHBoxLayout()
        controls.setSpacing(6)

        self._btn_prev_frame = QtWidgets.QPushButton('上一帧')
        self._btn_prev_frame.setMinimumWidth(60)
        self._btn_play = QtWidgets.QPushButton('播放')
        self._btn_play.setMinimumWidth(60)
        self._btn_next_frame = QtWidgets.QPushButton('下一帧')
        self._btn_next_frame.setMinimumWidth(60)
        self._btn_stop = QtWidgets.QPushButton('停止')
        self._btn_stop.setMinimumWidth(50)

        self._btn_prev_frame.clicked.connect(self._step_backward)
        self._btn_play.clicked.connect(self._toggle_play)
        self._btn_next_frame.clicked.connect(self._step_forward)
        self._btn_stop.clicked.connect(self._stop)

        controls.addWidget(self._btn_prev_frame)
        controls.addWidget(self._btn_play)
        controls.addWidget(self._btn_next_frame)
        controls.addWidget(self._btn_stop)

        # 跳转
        jump_label = QtWidgets.QLabel('跳转到:')
        jump_label.setObjectName('HintLabel')
        self._jump_edit = QtWidgets.QLineEdit()
        self._jump_edit.setPlaceholderText('HH:MM:SS')
        self._jump_edit.setFixedWidth(90)
        self._jump_edit.returnPressed.connect(self._jump_to)
        btn_jump = QtWidgets.QPushButton('跳转')
        btn_jump.setFixedWidth(50)
        btn_jump.clicked.connect(self._jump_to)

        controls.addStretch()
        controls.addWidget(jump_label)
        controls.addWidget(self._jump_edit)
        controls.addWidget(btn_jump)

        layout.addLayout(controls)

        # 裁剪信息
        self._crop_info = QtWidgets.QLabel('裁剪区域: 未选择')
        self._crop_info.setObjectName('HintLabel')
        layout.addWidget(self._crop_info)

        self.setEnabled(False)

    # ── 公共接口 ────────────────────────────────────────────

    def load_video(self, video_path: str) -> None:
        self._stop_ffplay()
        self._video_path = video_path
        self._paused = True
        self._duration = 0.0

        from alpha_video_config import get_video_info
        info = get_video_info(video_path)
        if not info:
            self.setEnabled(False)
            return
        self._duration = info.get('duration', 0)
        self._duration_label.setText(format_time(self._duration))

        self._start_ffplay()
        self._btn_play.setText('播放')
        self._sync_timer.stop()
        self.setEnabled(True)

    def close_video(self) -> None:
        self._stop_ffplay()
        self._sync_timer.stop()
        self._crop_overlay.clear_rect()
        # 不 disable，允许重新播放

    def replay(self) -> None:
        """用上次的视频路径重新播放"""
        if self._video_path and os.path.isfile(self._video_path):
            self.load_video(self._video_path)

    def get_current_time(self) -> float:
        return self._current_position

    def _current_position(self) -> float:
        """从进度条位置推算当前时间"""
        val = self._time_slider.value()
        return val / 1000.0 * self._duration if self._duration > 0 else 0.0

    def get_crop_rect(self) -> tuple | None:
        r = self._crop_overlay.get_rect()
        if r.isEmpty():
            return None
        return self._map_to_video_coords(r)

    def clear_crop(self) -> None:
        self._crop_overlay.clear_rect()
        self._crop_info.setText('裁剪区域: 未选择')

    # ── 内部 ────────────────────────────────────────────────

    def _map_to_video_coords(self, widget_rect: QtCore.QRect) -> tuple:
        from alpha_video_config import get_video_info
        info = get_video_info(self._video_path) if self._video_path else None
        if not info:
            return (0, 0, 0, 0)

        vw = info['width']
        vh = info['height']
        cw = self._container.width()
        ch = self._container.height()

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

    def _start_ffplay(self, seek_time: float | None = None) -> None:
        if not self._video_path:
            return
        self._stop_ffplay()

        # 用容器尺寸初始化 ffplay 窗口
        cw = max(self._container.width(), 320)
        ch = max(self._container.height(), 180)

        title = f'{self._title_prefix} - {self._video_path}'
        cmd = [
            _get_ffplay_bin(),
            '-window_title', title,
            '-noborder',
            '-x', str(cw),
            '-y', str(ch),
            '-loop', '0',
            '-autoexit',
        ]
        if seek_time is not None and seek_time > 0:
            cmd.extend(['-ss', str(seek_time)])
        cmd.append(self._video_path)

        self._process = QtCore.QProcess(self)
        self._process.setProcessChannelMode(QtCore.QProcess.ForwardedChannels)
        self._process.finished.connect(self._on_ffplay_finished)
        self._process.start(cmd[0], cmd[1:])

        # 等待 ffplay 窗口出现并嵌入
        QtCore.QTimer.singleShot(500, self._embed_ffplay)

    def _embed_ffplay(self) -> None:
        if sys.platform != 'win32' or not self._process:
            return
        hwnd = _win32_find_window(self._title_prefix)
        if hwnd:
            self._ffplay_hwnd = hwnd
            container_hwnd = int(self._container.winId())
            _win32_reparent(hwnd, container_hwnd)
            # 延迟 resize：等待容器完成布局
            QtCore.QTimer.singleShot(50, self._resize_ffplay)
            QtCore.QTimer.singleShot(200, self._resize_ffplay)
            return
        # 重试
        QtCore.QTimer.singleShot(300, self._embed_ffplay)

    def _resize_ffplay(self) -> None:
        if self._ffplay_hwnd:
            cw = self._container.width()
            ch = self._container.height()
            if cw > 0 and ch > 0:
                _win32_resize_window(self._ffplay_hwnd, cw, ch)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        QtCore.QTimer.singleShot(100, self._resize_ffplay)

    def _stop_ffplay(self) -> None:
        self._sync_timer.stop()
        if self._process:
            # 断开旧信号避免干扰新进程
            try:
                self._process.finished.disconnect(self._on_ffplay_finished)
            except (TypeError, RuntimeError):
                pass
            self._process.kill()
            self._process.waitForFinished(2000)
            self._process = None
        self._ffplay_hwnd = None
        self._btn_play.setText('播放')
        self._paused = True

    def _sync_position(self) -> None:
        """从 ffplay 窗口标题解析当前播放位置"""
        if not self._ffplay_hwnd or self._paused:
            return
        # ffplay 标题格式: "xxx  00:00:05 / 00:01:00" 或类似
        title = _win32_get_window_text(self._ffplay_hwnd)
        match = re.search(r'(\d{2}):(\d{2}):(\d{2})[\.:](\d{2})', title)
        if match:
            t = (int(match.group(1)) * 3600 + int(match.group(2)) * 60 +
                 int(match.group(3)) + int(match.group(4)) / 100.0)
            self._time_label.setText(format_time(t))
            self._time_slider.blockSignals(True)
            self._time_slider.setValue(
                int(t / self._duration * 1000) if self._duration > 0 else 0
            )
            self._time_slider.blockSignals(False)
            self.position_changed.emit(t)

    def _send_key(self, key: str) -> None:
        """向 ffplay 窗口发送按键"""
        if self._ffplay_hwnd:
            _win32_send_key(self._ffplay_hwnd, key)

    def _seek_ffplay(self, time_sec: float) -> None:
        """Seek ffplay 到指定时间"""
        if not self._paused:
            self._send_key('p')  # 先暂停
            self._paused = True
            self._btn_play.setText('播放')
        # 使用 seek 命令：左/右方向键 seek ±10s, 上下方向键 seek ±60s
        # 更精确的方式：通过 seek 命令（ffplay 没有直接的 goto 命令）
        # 使用 -ss 重启 ffplay
        self._stop_ffplay()
        self._paused = True
        self._start_ffplay()
        self._btn_play.setText('播放')
        self._sync_timer.stop()

    # ── 控制 ────────────────────────────────────────────────

    def _toggle_play(self) -> None:
        if not self._ffplay_hwnd and self._video_path:
            # ffplay 进程可能已退出，重新启动
            self._start_ffplay()
            self._paused = True
        if self._paused:
            self._send_key(' ')  # 空格暂停/播放
            self._paused = False
            self._btn_play.setText('暂停')
            self._sync_timer.start()
        else:
            self._send_key(' ')
            self._paused = True
            self._btn_play.setText('播放')
            self._sync_timer.stop()

    def _stop(self) -> None:
        """停止播放，可以再次播放"""
        self._stop_ffplay()
        self._btn_play.setText('播放')
        self._paused = True
        self._time_label.setText('00:00:00.000')
        self._time_slider.setValue(0)

    def _step_forward(self) -> None:
        """前进一帧"""
        if not self._paused:
            self._send_key(' ')
            self._paused = True
            self._btn_play.setText('播放')
            self._sync_timer.stop()
        self._send_key('s')  # ffplay: s = step forward one frame
        # 手动更新进度条估算
        from alpha_video_config import get_video_info
        info = get_video_info(self._video_path) if self._video_path else None
        fps = info.get('fps', 25.0) if info else 25.0
        new_t = min(self._current_position() + 1.0 / fps, self._duration)
        self._time_label.setText(format_time(new_t))
        self._time_slider.blockSignals(True)
        self._time_slider.setValue(int(new_t / self._duration * 1000) if self._duration > 0 else 0)
        self._time_slider.blockSignals(False)

    def _step_backward(self) -> None:
        """后退约 0.5 秒"""
        if not self._paused:
            self._send_key(' ')
            self._paused = True
            self._btn_play.setText('播放')
            self._sync_timer.stop()
        new_t = max(0, self._current_position() - 0.5)
        self._restart_at(new_t)

    def _jump_to(self) -> None:
        text = self._jump_edit.text().strip()
        if not text:
            return
        t = parse_time(text)
        if t is not None:
            self._restart_at(t)
        self._jump_edit.clear()

    def _restart_at(self, time_sec: float) -> None:
        """在指定时间位置重新启动播放"""
        self._stop_ffplay()
        self._paused = True
        self._start_ffplay(seek_time=time_sec)
        self._btn_play.setText('播放')
        self._sync_timer.stop()
        self._time_label.setText(format_time(time_sec))
        self._time_slider.blockSignals(True)
        self._time_slider.setValue(
            int(time_sec / self._duration * 1000) if self._duration > 0 else 0
        )
        self._time_slider.blockSignals(False)
        self.position_changed.emit(time_sec)

    # ── 滑块 ────────────────────────────────────────────────

    def _on_slider_pressed(self) -> None:
        if not self._paused:
            self._send_key('p')
            self._paused = True
            self._btn_play.setText('播放')
            self._sync_timer.stop()

    def _on_slider_released(self) -> None:
        val = self._time_slider.value()
        t = val / 1000.0 * self._duration if self._duration > 0 else 0
        self._restart_at(t)

    def _on_ffplay_finished(self) -> None:
        # 确认是当前进程的结束信号
        sender = self.sender()
        if sender is not self._process:
            return
        self._sync_timer.stop()
        self._ffplay_hwnd = None
        self._btn_play.setText('播放')
        self._paused = True

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._resize_ffplay()
        self._crop_overlay.setGeometry(self._container.rect())

    def closeEvent(self, event) -> None:
        self._stop_ffplay()
        super().closeEvent(event)
