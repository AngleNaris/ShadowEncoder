#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AlphaVideoTool — 透明视频处理工具箱 主 GUI"""

from __future__ import annotations

import os
import threading
import time
import traceback
from datetime import datetime
from html import escape
from pathlib import Path

from PySide6 import QtCore, QtGui, QtWidgets

import alpha_video_backend as backend
from alpha_video_config import (
    MEDIA_EXTENSIONS, SUPPORTED_INPUT_MEDIA,
    get_video_info, format_time, parse_time, normalize_path,
    OperationCancelledError, get_ffmpeg_bin,
)
from alpha_video_player import CropOverlay
from alpha_video_player2 import CvPlayer


def configure_combo_box(combo: QtWidgets.QComboBox, minimum_contents: int = 16) -> None:
    combo.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToContentsOnFirstShow)
    combo.setMinimumContentsLength(minimum_contents)
    combo.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
    view = combo.view()
    if view is not None:
        view.setTextElideMode(QtCore.Qt.ElideNone)
        view.setMinimumWidth(340)


# ── 组件 ────────────────────────────────────────────────────

class ActivityLog(QtWidgets.QTextEdit):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setReadOnly(True)
        self.setAcceptRichText(True)
        self.setFont(QtGui.QFont('Consolas', 10))

    def append_line(self, line: str) -> None:
        if '\n' in line:
            for item in line.splitlines():
                self.append_line(item)
            return

        color = '#e6e0e9'
        weight = '400'
        stripped = line.strip()

        if stripped.startswith('[PASS]') or '完成' in stripped:
            color = '#188c49'
            weight = '600'
        elif stripped.startswith('[FAIL]') or '失败' in stripped or '错误' in stripped:
            color = '#8c1d18'
            weight = '600'
        elif '警告' in stripped:
            color = '#e6e0e9'
            weight = '600'
        elif stripped.startswith('Alpha 合成完成') or stripped.startswith('截图完成') or \
             stripped.startswith('GIF 导出完成') or stripped.startswith('WebP 导出完成'):
            color = '#188c49'
            weight = '600'

        self.append(
            f'<pre style="margin:0; color:{color}; font-weight:{weight}; '
            f'background:transparent; font-family:Consolas, \'PingFang SC\', '
            f'\'Microsoft YaHei UI\', \'Noto Sans CJK SC\', sans-serif;">'
            f'{escape(line)}</pre>'
        )
        self.moveCursor(QtGui.QTextCursor.End)
        self.horizontalScrollBar().setValue(0)


class TaskThread(QtCore.QThread):
    log_line = QtCore.Signal(str)
    progress_changed = QtCore.Signal(int, str)
    task_done = QtCore.Signal(bool, object)

    def __init__(self, task_callable, parent=None) -> None:
        super().__init__(parent)
        self.task_callable = task_callable
        self._cancel_event = threading.Event()
        self._process_lock = threading.Lock()
        self._current_process = None

    def is_cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def cancel(self) -> None:
        if self._cancel_event.is_set():
            return
        self._cancel_event.set()
        self.log_line.emit('正在请求停止任务...')
        self._terminate_current_process()

    def set_current_process(self, process) -> None:
        with self._process_lock:
            self._current_process = process
        if process is not None and self.is_cancelled():
            self._terminate_process(process)

    def _terminate_current_process(self) -> None:
        with self._process_lock:
            process = self._current_process
        self._terminate_process(process)

    @staticmethod
    def _terminate_process(process) -> None:
        if process is None:
            return
        try:
            if process.poll() is None:
                process.terminate()
        except Exception:
            pass

    def run(self) -> None:
        try:
            result = self.task_callable(self)
        except OperationCancelledError as exc:
            self.task_done.emit(True, {'cancelled': True, 'message': str(exc)})
            return
        except Exception as exc:
            for line in traceback.format_exc().splitlines():
                self.log_line.emit(line)
            self.task_done.emit(False, {'error': str(exc)})
            return
        self.task_done.emit(True, result)


class GuiLogger:
    """线程安全的日志记录器 — 通过信号/回调发送到主线程"""

    def __init__(self, emit_func) -> None:
        self._emit = emit_func

    def print(self, *args, sep: str = ' ', end: str = '\n') -> None:
        text = sep.join(str(arg) for arg in args) + end
        text = text.rstrip('\n')
        if text:
            for line in text.split('\n'):
                self._emit(line)
        elif end == '\n':
            self._emit('')


class PanelFrame(QtWidgets.QFrame):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName('PanelFrame')


# ── 支持拖放的输入框 ──────────────────────────────────────

class DropLineEdit(QtWidgets.QLineEdit):
    """支持拖放文件的输入框"""
    file_dropped = QtCore.Signal(str)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setReadOnly(True)
        self.setPlaceholderText('拖放视频文件到此处，或点击下方按钮选择')

    def dragEnterEvent(self, event: QtGui.QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            for url in event.mimeData().urls():
                if url.isLocalFile():
                    event.acceptProposedAction()
                    return
        event.ignore()

    def dragMoveEvent(self, event: QtGui.QDragMoveEvent) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QtGui.QDropEvent) -> None:
        for url in event.mimeData().urls():
            if url.isLocalFile():
                path = url.toLocalFile()
                self.setText(normalize_path(path))
                self.file_dropped.emit(path)
                return
        event.ignore()


# ── Tab 1: Alpha 合成 ──────────────────────────────────────

class AlphaTab(QtWidgets.QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._build_ui()

    def _build_ui(self) -> None:
        root = QtWidgets.QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        root.addWidget(splitter)

        # ── 左面板 ──
        left = PanelFrame()
        left.setFixedWidth(429)
        left.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; '
            'border-right: none; border-left: none; }'
        )
        left_layout = QtWidgets.QVBoxLayout(left)
        self._left_layout = left_layout
        left_layout.setContentsMargins(20, 20, 20, 20)
        left_layout.setSpacing(14)

        # 输入
        input_title = QtWidgets.QLabel('输入文件')
        input_title.setObjectName('SectionTitle')
        left_layout.addWidget(input_title)

        self._input_edit = DropLineEdit()
        self._input_edit.file_dropped.connect(self._on_input_changed)
        left_layout.addWidget(self._input_edit)

        input_btns = QtWidgets.QHBoxLayout()
        btn_browse = QtWidgets.QPushButton('选择文件')
        btn_browse.clicked.connect(self._browse_input)
        btn_clear = QtWidgets.QPushButton('清除')
        btn_clear.clicked.connect(lambda: self._clear_input())
        input_btns.addWidget(btn_browse)
        input_btns.addWidget(btn_clear)
        left_layout.addLayout(input_btns)

        # 输出路径
        output_title = QtWidgets.QLabel('输出路径')
        output_title.setObjectName('SectionTitle')
        left_layout.addWidget(output_title)

        self._output_edit = QtWidgets.QLineEdit()
        self._output_edit.setPlaceholderText('自动生成：原文件名_合成.mov')
        left_layout.addWidget(self._output_edit)

        output_btns = QtWidgets.QHBoxLayout()
        btn_out = QtWidgets.QPushButton('选择位置')
        btn_out.clicked.connect(self._browse_output)
        output_btns.addWidget(btn_out)
        output_btns.addStretch()
        left_layout.addLayout(output_btns)

        # 帧率设置
        fps_title = QtWidgets.QLabel('帧率设置')
        fps_title.setObjectName('SectionTitle')
        left_layout.addWidget(fps_title)

        self._fps_original = QtWidgets.QRadioButton('保持原始帧率')
        self._fps_original.setChecked(True)
        self._fps_custom = QtWidgets.QRadioButton('自定义帧率:')
        self._fps_input = QtWidgets.QDoubleSpinBox()
        self._fps_input.setRange(1.0, 120.0)
        self._fps_input.setValue(25.0)
        self._fps_input.setDecimals(1)
        self._fps_input.setEnabled(False)
        self._fps_custom.toggled.connect(lambda checked: self._fps_input.setEnabled(checked))

        fps_row = QtWidgets.QHBoxLayout()
        fps_row.addWidget(self._fps_custom)
        fps_row.addWidget(self._fps_input)
        fps_row.addStretch()
        left_layout.addWidget(self._fps_original)
        left_layout.addLayout(fps_row)

        # 提示
        info = QtWidgets.QFrame()
        info.setObjectName('InfoFrame')
        info_layout = QtWidgets.QVBoxLayout(info)
        info_layout.setContentsMargins(14, 12, 14, 12)
        hint = QtWidgets.QLabel(
            '要求：上半部分 RGB 彩色内容，下半部分 Alpha 黑白遮罩\n'
            '输出：ProRes 4444 MOV 带透明通道，音频原样复制'
        )
        hint.setObjectName('HintLabel')
        hint.setWordWrap(True)
        info_layout.addWidget(hint)
        left_layout.addWidget(info)

        # 奇数高度警告
        self._warn_label = QtWidgets.QLabel('')
        self._warn_label.setObjectName('DetailLabel')
        self._warn_label.setStyleSheet('color: #e8b84b;')
        self._warn_label.setWordWrap(True)
        self._warn_label.hide()
        left_layout.addWidget(self._warn_label)

        left_layout.addStretch(1)

        # 操作按钮
        actions = QtWidgets.QHBoxLayout()
        self._btn_start = QtWidgets.QPushButton('开始合成')
        self._btn_start.setObjectName('PrimaryButton')
        self._btn_start.setMinimumWidth(90)
        self._btn_cancel = QtWidgets.QPushButton('停止')
        self._btn_cancel.setEnabled(False)
        actions.addWidget(self._btn_start)
        actions.addWidget(self._btn_cancel)
        left_layout.addLayout(actions)

        # ── 右面板 (预览 + 状态) ──
        right = PanelFrame()
        right.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; '
            'border-left: none; border-right: none; }'
        )
        right_layout = QtWidgets.QVBoxLayout(right)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(10)

        # 状态 + 进度
        self._progress = QtWidgets.QProgressBar()
        self._progress.setRange(0, 100)
        self._progress_detail = QtWidgets.QLabel('尚未开始任务')
        self._progress_detail.setObjectName('HintLabel')
        right_layout.addWidget(self._progress)
        right_layout.addWidget(self._progress_detail)

        # 视频预览
        self._player = CvPlayer()
        right_layout.addWidget(self._player, 1)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([429, 700])

        self._task = None
        self._btn_start.clicked.connect(self._start_task)
        self._btn_cancel.clicked.connect(self._cancel_task)

    def _on_input_changed(self, path: str) -> None:
        """拖放或选择文件后更新输出路径和预览"""
        p = Path(path)
        self._output_edit.setText(str(p.parent / p.stem) + '_合成.mov')
        info = get_video_info(path)
        if info:
            self._player.load_video(path)
            # 奇数高度警告（合成会忽略最底 1 行）
            if info.get('height', 0) % 2 != 0:
                self._warn_label.setText(
                    f'⚠ 视频高度为奇数({info["height"]}px)，合成时将忽略最底部 1 行，'
                    f'建议导出前裁剪为偶数高度。'
                )
                self._warn_label.show()
            else:
                self._warn_label.hide()

    def _clear_input(self) -> None:
        self._input_edit.clear()
        self._output_edit.clear()

    def _browse_input(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, '选择 MP4 文件', '', 'MP4 视频 (*.mp4);;所有文件 (*.*)'
        )
        if path:
            self._input_edit.setText(normalize_path(path))
            self._on_input_changed(path)

    def _browse_output(self) -> None:
        default = self._output_edit.text()
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, '保存 MOV 文件', default or '', 'MOV 视频 (*.mov)'
        )
        if path:
            self._output_edit.setText(path)

    def _start_task(self) -> None:
        input_path = self._input_edit.text().strip()
        output_path = self._output_edit.text().strip()

        if not input_path:
            QtWidgets.QMessageBox.warning(self, '提示', '请先选择输入文件')
            return
        if not os.path.isfile(input_path):
            QtWidgets.QMessageBox.warning(self, '提示', f'输入文件不存在:\n{input_path}')
            return

        # 输出路径未填则自动生成
        if not output_path:
            output_path = str(Path(input_path).parent / Path(input_path).stem) + '_合成.mov'
            self._output_edit.setText(output_path)

        # 确保输出目录存在
        out_dir = Path(output_path).parent
        if not out_dir.exists():
            QtWidgets.QMessageBox.warning(self, '提示', f'输出目录不存在:\n{out_dir}')
            return

        fps = self._fps_input.value() if self._fps_custom.isChecked() else None

        self._set_running(True)
        self._progress.setValue(0)
        self._progress_detail.setText('正在准备...')

        output_path_final = output_path

        def task(thread):
            logger = GuiLogger(thread.log_line.emit)
            backend.compose_alpha(input_path, output_path_final, fps, logger, thread)

        self._task = TaskThread(task)
        self._task.log_line.connect(self._append_log)
        self._task.progress_changed.connect(self._update_progress)
        self._task.task_done.connect(self._on_done)
        self._task.start()

    def _append_log(self, line: str) -> None:
        # 日志直接显示在进度详情中
        stripped = line.strip()
        if stripped:
            self._progress_detail.setText(stripped)

    def _cancel_task(self) -> None:
        if self._task and self._task.isRunning():
            self._task.cancel()

    def _update_progress(self, value: int, detail: str) -> None:
        self._progress.setValue(value)
        self._progress_detail.setText(detail)

    def _on_done(self, success: bool, result: object) -> None:
        self._set_running(False)
        if isinstance(result, dict) and result.get('cancelled'):
            self._progress_detail.setText('任务已取消')
        elif not success:
            msg = result.get('error', '未知错误') if isinstance(result, dict) else str(result)
            self._progress_detail.setText('任务失败')
            QtWidgets.QMessageBox.critical(self, '合成失败', msg)
        else:
            self._progress_detail.setText('合成完成')
            self._progress.setValue(100)
            QtWidgets.QMessageBox.information(self, '完成', '透明通道合成完成！')

    def _set_running(self, running: bool) -> None:
        self._btn_start.setEnabled(not running)
        self._btn_cancel.setEnabled(running)
        self._input_edit.setEnabled(not running)
        self._output_edit.setEnabled(not running)
        self._fps_original.setEnabled(not running)
        self._fps_custom.setEnabled(not running)
        self._fps_input.setEnabled(not running and self._fps_custom.isChecked())


# ── Tab 2: 截图 ────────────────────────────────────────────

class ScreenshotTab(QtWidgets.QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._build_ui()

    def _build_ui(self) -> None:
        root = QtWidgets.QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        root.addWidget(splitter)

        # ── 左面板 ──
        left = PanelFrame()
        left.setFixedWidth(429)
        left.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; '
            'border-right: none; border-left: none; }'
        )
        left_layout = QtWidgets.QVBoxLayout(left)
        self._left_layout = left_layout
        left_layout.setContentsMargins(20, 20, 20, 20)
        left_layout.setSpacing(12)

        # 输入
        input_title = QtWidgets.QLabel('输入文件')
        input_title.setObjectName('SectionTitle')
        left_layout.addWidget(input_title)

        self._input_edit = DropLineEdit()
        self._input_edit.file_dropped.connect(lambda p: self._load_video(p))
        left_layout.addWidget(self._input_edit)

        input_btns = QtWidgets.QHBoxLayout()
        btn_browse = QtWidgets.QPushButton('选择文件')
        btn_browse.clicked.connect(self._browse_input)
        btn_clear = QtWidgets.QPushButton('清除')
        btn_clear.clicked.connect(self._clear_input)
        input_btns.addWidget(btn_browse)
        input_btns.addWidget(btn_clear)
        left_layout.addLayout(input_btns)

        # 视频信息
        self._video_info_label = QtWidgets.QLabel('未载入视频')
        self._video_info_label.setObjectName('HintLabel')
        self._video_info_label.setWordWrap(True)
        left_layout.addWidget(self._video_info_label)

        # 输出尺寸
        size_title = QtWidgets.QLabel('输出尺寸')
        size_title.setObjectName('SectionTitle')
        left_layout.addWidget(size_title)

        size_grid = QtWidgets.QGridLayout()
        size_grid.setHorizontalSpacing(8)
        size_grid.setVerticalSpacing(6)

        size_grid.addWidget(QtWidgets.QLabel('宽:'), 0, 0)
        self._output_w = QtWidgets.QSpinBox()
        self._output_w.setRange(1, 8192)
        self._output_w.setValue(1920)
        size_grid.addWidget(self._output_w, 0, 1)

        size_grid.addWidget(QtWidgets.QLabel('高:'), 0, 2)
        self._output_h = QtWidgets.QSpinBox()
        self._output_h.setRange(1, 8192)
        self._output_h.setValue(1080)
        size_grid.addWidget(self._output_h, 0, 3)

        # 锁定比例按钮
        self._lock_ratio = QtWidgets.QCheckBox('使用裁剪区域选择 (在播放器中拖拽)')
        self._lock_ratio.setChecked(True)
        left_layout.addLayout(size_grid)
        left_layout.addWidget(self._lock_ratio)

        # 当前时间
        time_row = QtWidgets.QHBoxLayout()
        time_row.addWidget(QtWidgets.QLabel('截图时间:'))
        self._time_label = QtWidgets.QLabel('00:00:00.000')
        self._time_label.setObjectName('DetailLabel')
        time_row.addWidget(self._time_label)
        time_row.addStretch()
        left_layout.addLayout(time_row)

        # 裁剪信息
        self._crop_info = QtWidgets.QLabel('裁剪区域: 未选择 (将使用完整画面缩放)')
        self._crop_info.setObjectName('HintLabel')
        self._crop_info.setWordWrap(True)
        left_layout.addWidget(self._crop_info)

        left_layout.addStretch(1)

        # 操作
        actions = QtWidgets.QHBoxLayout()
        self._btn_save = QtWidgets.QPushButton('截图保存')
        self._btn_save.setObjectName('PrimaryButton')
        self._btn_save.setMinimumWidth(90)
        self._btn_clear_crop = QtWidgets.QPushButton('清除选区')
        self._btn_clear_crop.clicked.connect(self._clear_crop)
        actions.addWidget(self._btn_save)
        actions.addWidget(self._btn_clear_crop)
        left_layout.addLayout(actions)

        # ── 右面板 (播放器) ──
        right = PanelFrame()
        right.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; '
            'border-left: none; border-right: none; }'
        )
        right_layout = QtWidgets.QVBoxLayout(right)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(10)

        self._player = CvPlayer()
        self._player.frame_changed.connect(self._on_frame_changed)
        self._player.crop_changed.connect(self._on_crop_changed)
        right_layout.addWidget(self._player, 1)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([429, 700])

        self._btn_save.clicked.connect(self._capture)
        # 输出尺寸变化时更新裁剪框比例
        self._output_w.valueChanged.connect(self._update_crop_aspect)
        self._output_h.valueChanged.connect(self._update_crop_aspect)

    def _on_crop_changed(self, x, y, w, h):
        if w == 0 and h == 0:
            self._crop_info.setText('裁剪区域: 未选择 (将使用完整画面缩放)')
        else:
            self._crop_info.setText(f'裁剪区域: {x},{y}  尺寸: {w}×{h}')

    def _update_crop_aspect(self):
        w = self._output_w.value()
        h = self._output_h.value()
        self._player.set_crop_aspect(w, h)

    def _browse_input(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, '选择视频文件', '',
            '视频文件 (*.mp4 *.mov *.mkv *.avi *.webm);;所有文件 (*.*)'
        )
        if path:
            self._input_edit.setText(normalize_path(path))
            self._load_video(path)

    def _clear_input(self) -> None:
        self._input_edit.clear()
        self._video_info_label.setText('未载入视频')

    def _load_video(self, path: str) -> None:
        info = get_video_info(path)
        if info:
            self._video_info_label.setText(
                f'分辨率: {info["width"]}×{info["height"]} | '
                f'帧率: {info["fps"]:.2f} | '
                f'时长: {format_time(info["duration"])} | '
                f'{"✓ 含透明通道" if info["has_alpha"] else "✗ 无透明通道"}'
            )
            self._player.load_video(path)
            self._update_crop_aspect()
        else:
            self._video_info_label.setText('无法读取视频信息')

    def _on_frame_changed(self, time_sec: float) -> None:
        self._time_label.setText(format_time(time_sec))

    def _clear_crop(self) -> None:
        self._player.clear_crop()
        self._crop_info.setText('裁剪区域: 未选择 (将使用完整画面缩放)')

    def _capture(self) -> None:
        input_path = self._input_edit.text().strip()
        if not input_path or not os.path.isfile(input_path):
            QtWidgets.QMessageBox.warning(self, '提示', '请先选择输入文件')
            return

        out_w = self._output_w.value()
        out_h = self._output_h.value()
        time_sec = self._player.get_current_time()

        # 裁剪参数
        crop = self._player.get_crop_rect() if self._lock_ratio.isChecked() else None
        crop_args = {}
        if crop and crop[2] > 0 and crop[3] > 0:
            crop_args = {'crop_x': crop[0], 'crop_y': crop[1],
                         'crop_w': crop[2], 'crop_h': crop[3]}

        # 确定输出路径
        base = Path(input_path).stem
        out_path = Path(input_path).parent / f'{base}_screenshot_{time_sec:.2f}s.png'
        out_path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, '保存截图', str(out_path), 'PNG 图片 (*.png)'
        )
        if not out_path:
            return

        try:
            # 构建 ffmpeg 命令。如果有裁剪，先裁剪再缩放
            vf_parts = []
            if crop_args:
                vf_parts.append(
                    f'crop={crop_args["crop_w"]}:{crop_args["crop_h"]}:'
                    f'{crop_args["crop_x"]}:{crop_args["crop_y"]}'
                )
            vf_parts.append(f'scale={out_w}:{out_h}')

            import subprocess
            from alpha_video_config import get_ffmpeg_bin, _hidden_process_kwargs

            cmd = [
                get_ffmpeg_bin(), '-y',
                '-ss', str(time_sec),
                '-i', input_path,
                '-vframes', '1',
                '-vf', ','.join(vf_parts),
                out_path,
            ]

            msg = QtWidgets.QMessageBox()
            msg.setWindowTitle('处理中')
            msg.setText('正在截图，请稍候...')
            msg.setStandardButtons(QtWidgets.QMessageBox.NoButton)
            msg.show()
            QtWidgets.QApplication.processEvents()

            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding='utf-8', errors='replace',
                                    **_hidden_process_kwargs())
            msg.close()

            if result.returncode == 0 and os.path.isfile(out_path):
                QtWidgets.QMessageBox.information(
                    self, '完成',
                    f'截图已保存到:\n{out_path}\n尺寸: {out_w}×{out_h}'
                )
                self._crop_info.setText(f'截图已保存: {out_path}')
            else:
                QtWidgets.QMessageBox.critical(
                    self, '失败', f'截图失败:\n{result.stderr[:500]}'
                )
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, '错误', str(e))


# ── Tab 3 & 4 基类: GIF / WebP 导出 ───────────────────────

class _ExportTabBase(QtWidgets.QWidget):
    """GIF / WebP 导出标签页基类"""
    FORMAT_NAME = ''
    FORMAT_EXT = ''

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._build_ui()

    def _build_ui(self) -> None:
        root = QtWidgets.QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        root.addWidget(splitter)

        # ── 左面板 ──
        left = PanelFrame()
        left.setFixedWidth(429)
        left.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; '
            'border-right: none; border-left: none; }'
        )
        left_layout = QtWidgets.QVBoxLayout(left)
        self._left_layout = left_layout
        left_layout.setContentsMargins(20, 20, 20, 20)
        left_layout.setSpacing(12)

        # 输入
        input_title = QtWidgets.QLabel('输入文件')
        input_title.setObjectName('SectionTitle')
        left_layout.addWidget(input_title)

        self._input_edit = DropLineEdit()
        self._input_edit.file_dropped.connect(lambda p: self._load_video(p))
        left_layout.addWidget(self._input_edit)

        input_btns = QtWidgets.QHBoxLayout()
        btn_browse = QtWidgets.QPushButton('选择文件')
        btn_browse.clicked.connect(self._browse_input)
        btn_clear = QtWidgets.QPushButton('清除')
        btn_clear.clicked.connect(self._clear_input)
        input_btns.addWidget(btn_browse)
        input_btns.addWidget(btn_clear)
        left_layout.addLayout(input_btns)

        # 视频信息
        self._video_info_label = QtWidgets.QLabel('未载入视频')
        self._video_info_label.setObjectName('HintLabel')
        self._video_info_label.setWordWrap(True)
        left_layout.addWidget(self._video_info_label)

        # 时间范围
        time_title = QtWidgets.QLabel('时间范围')
        time_title.setObjectName('SectionTitle')
        left_layout.addWidget(time_title)

        time_grid = QtWidgets.QGridLayout()
        time_grid.setHorizontalSpacing(8)
        time_grid.setVerticalSpacing(6)

        time_grid.addWidget(QtWidgets.QLabel('起始:'), 0, 0)
        self._start_time = QtWidgets.QLineEdit('00:00:00.000')
        self._start_time.setFixedWidth(115)
        time_grid.addWidget(self._start_time, 0, 1)
        btn_set_start = QtWidgets.QPushButton('设为当前')
        btn_set_start.setMinimumWidth(70)
        btn_set_start.clicked.connect(self._set_start)
        time_grid.addWidget(btn_set_start, 0, 2)

        time_grid.addWidget(QtWidgets.QLabel('结束:'), 1, 0)
        self._end_time = QtWidgets.QLineEdit('00:00:05.000')
        self._end_time.setFixedWidth(115)
        time_grid.addWidget(self._end_time, 1, 1)
        btn_set_end = QtWidgets.QPushButton('设为当前')
        btn_set_end.setMinimumWidth(70)
        btn_set_end.clicked.connect(self._set_end)
        time_grid.addWidget(btn_set_end, 1, 2)

        left_layout.addLayout(time_grid)

        self._duration_label = QtWidgets.QLabel('片段时长: 5.000s')
        self._duration_label.setObjectName('HintLabel')
        left_layout.addWidget(self._duration_label)

        # 固定时长模式
        fixed_row = QtWidgets.QHBoxLayout()
        self._fixed_duration_cb = QtWidgets.QCheckBox('固定时长:')
        self._fixed_duration_cb.toggled.connect(self._on_fixed_duration_toggled)
        self._fixed_dur = QtWidgets.QDoubleSpinBox()
        self._fixed_dur.setRange(0.1, 9999.0)
        self._fixed_dur.setValue(2.0)
        self._fixed_dur.setDecimals(1)
        self._fixed_dur.setSuffix('s')
        self._fixed_dur.setFixedWidth(70)
        self._fixed_dur.setEnabled(False)
        self._fixed_dur.valueChanged.connect(self._on_fixed_dur_change)
        fixed_row.addWidget(self._fixed_duration_cb)
        fixed_row.addWidget(self._fixed_dur)
        fixed_row.addStretch()
        left_layout.addLayout(fixed_row)

        # 输出参数
        params_title = QtWidgets.QLabel('输出参数')
        params_title.setObjectName('SectionTitle')
        left_layout.addWidget(params_title)

        params_grid = QtWidgets.QGridLayout()
        params_grid.setHorizontalSpacing(8)
        params_grid.setVerticalSpacing(6)

        params_grid.addWidget(QtWidgets.QLabel('宽度:'), 0, 0)
        self._output_w = QtWidgets.QSpinBox()
        self._output_w.setRange(1, 4096)
        self._output_w.setValue(480)
        params_grid.addWidget(self._output_w, 0, 1)

        params_grid.addWidget(QtWidgets.QLabel('高度:'), 1, 0)
        self._output_h = QtWidgets.QSpinBox()
        self._output_h.setRange(1, 4096)
        self._output_h.setValue(270)
        params_grid.addWidget(self._output_h, 1, 1)

        params_grid.addWidget(QtWidgets.QLabel('帧率:'), 1, 2)
        self._fps_input = QtWidgets.QDoubleSpinBox()
        self._fps_input.setRange(1.0, 60.0)
        self._fps_input.setValue(15.0)
        self._fps_input.setDecimals(1)
        params_grid.addWidget(self._fps_input, 1, 3)

        self._use_crop = QtWidgets.QCheckBox('使用裁剪区域 (在播放器中拖拽选择)')
        self._use_crop.setChecked(True)
        left_layout.addLayout(params_grid)
        left_layout.addWidget(self._use_crop)

        # 裁剪信息
        self._crop_info = QtWidgets.QLabel('裁剪区域: 未选择 (将使用完整画面缩放)')
        self._crop_info.setObjectName('HintLabel')
        self._crop_info.setWordWrap(True)
        left_layout.addWidget(self._crop_info)

        # WebP 额外：质量
        if self.FORMAT_EXT == 'webp':
            q_row = QtWidgets.QHBoxLayout()
            q_row.addWidget(QtWidgets.QLabel('质量:'))
            self._quality = QtWidgets.QSpinBox()
            self._quality.setRange(1, 100)
            self._quality.setValue(75)
            q_row.addWidget(self._quality)
            q_row.addStretch()
            left_layout.addLayout(q_row)

        left_layout.addStretch(1)

        # 操作
        actions = QtWidgets.QHBoxLayout()
        self._btn_export = QtWidgets.QPushButton(f'导出 {self.FORMAT_NAME}')
        self._btn_export.setObjectName('PrimaryButton')
        self._btn_export.setMinimumWidth(90)
        self._btn_cancel = QtWidgets.QPushButton('停止')
        self._btn_cancel.setEnabled(False)
        self._btn_clear_crop = QtWidgets.QPushButton('清除选区')
        self._btn_clear_crop.clicked.connect(self._clear_crop)
        actions.addWidget(self._btn_export)
        actions.addWidget(self._btn_cancel)
        actions.addWidget(self._btn_clear_crop)
        left_layout.addLayout(actions)

        # ── 右面板 (播放器 + 进度) ──
        right = PanelFrame()
        right.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; '
            'border-left: none; border-right: none; }'
        )
        right_layout = QtWidgets.QVBoxLayout(right)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(10)

        # 进度
        self._progress = QtWidgets.QProgressBar()
        self._progress.setRange(0, 100)
        self._progress_detail = QtWidgets.QLabel('尚未开始任务')
        self._progress_detail.setObjectName('HintLabel')
        right_layout.addWidget(self._progress)
        right_layout.addWidget(self._progress_detail)

        self._player = CvPlayer()
        self._player.crop_changed.connect(self._on_crop_changed)
        right_layout.addWidget(self._player, 1)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([429, 700])

        self._btn_export.clicked.connect(self._do_export)
        self._btn_cancel.clicked.connect(self._cancel_export)
        # 输出尺寸变化时更新裁剪框比例
        self._output_w.valueChanged.connect(self._update_crop_aspect)
        self._output_h.valueChanged.connect(self._update_crop_aspect)

    def _browse_input(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, '选择视频文件', '',
            '视频文件 (*.mp4 *.mov *.mkv *.avi *.webm);;所有文件 (*.*)'
        )
        if path:
            self._input_edit.setText(normalize_path(path))
            self._load_video(path)

    def _clear_input(self) -> None:
        self._input_edit.clear()
        self._video_info_label.setText('未载入视频')

    def _load_video(self, path: str) -> None:
        info = get_video_info(path)
        if info:
            self._video_info_label.setText(
                f'分辨率: {info["width"]}×{info["height"]} | '
                f'帧率: {info["fps"]:.2f} | '
                f'时长: {format_time(info["duration"])} | '
                f'{"✓ 含透明通道" if info["has_alpha"] else "✗ 无透明通道"}'
            )
            self._player.load_video(path)
            self._update_crop_aspect()
        else:
            self._video_info_label.setText('无法读取视频信息')

    def _set_start(self) -> None:
        t = self._player.get_current_time()
        self._start_time.setText(format_time(t))
        if self._fixed_duration_cb.isChecked():
            dur = self._fixed_dur.value()
            info = get_video_info(self._input_edit.text().strip()) if self._input_edit.text().strip() else None
            max_t = info.get('duration', 9999) if info else 9999
            end_t = min(t + dur, max_t)
            self._end_time.setText(format_time(end_t))
        self._update_duration()
        self._sync_player_loop()

    def _sync_player_loop(self) -> None:
        s = parse_time(self._start_time.text())
        e = parse_time(self._end_time.text())
        if s is not None and e is not None and e > s:
            self._player.set_loop_range(s, e)

    def _on_fixed_duration_toggled(self, checked: bool) -> None:
        self._fixed_dur.setEnabled(checked)
        if checked:
            # 用当前结束时间更新时长
            s = parse_time(self._start_time.text())
            e = parse_time(self._end_time.text())
            if s is not None and e is not None and e > s:
                self._fixed_dur.blockSignals(True)
                self._fixed_dur.setValue(e - s)
                self._fixed_dur.blockSignals(False)
            self._sync_player_loop()
        else:
            self._player._time_slider.set_loop_range_visual(0, 0)
            self._player._loop_enabled = False

    def _on_fixed_dur_change(self, val: float) -> None:
        s = parse_time(self._start_time.text())
        if s is not None:
            info = get_video_info(self._input_edit.text().strip()) if self._input_edit.text().strip() else None
            max_t = info.get('duration', 9999) if info else 9999
            self._end_time.setText(format_time(min(s + val, max_t)))
            self._update_duration()
            self._sync_player_loop()

    def _set_end(self) -> None:
        t = self._player.get_current_time()
        self._end_time.setText(format_time(t))
        if self._fixed_duration_cb.isChecked():
            dur = self._fixed_dur.value()
            self._start_time.setText(format_time(max(0, t - dur)))
        self._update_duration()
        self._sync_player_loop()

    def _update_duration(self) -> None:
        s = parse_time(self._start_time.text())
        e = parse_time(self._end_time.text())
        if s is not None and e is not None:
            self._duration_label.setText(f'片段时长: {e - s:.3f}s')

    def _clear_crop(self) -> None:
        self._player.clear_crop()
        self._crop_info.setText('裁剪区域: 未选择 (将使用完整画面缩放)')

    def _on_crop_changed(self, x, y, w, h):
        if w == 0 and h == 0:
            self._crop_info.setText('裁剪区域: 未选择 (将使用完整画面缩放)')
        else:
            self._crop_info.setText(f'裁剪区域: {x},{y}  尺寸: {w}×{h}')

    def _update_crop_aspect(self):
        w = self._output_w.value()
        h = self._output_h.value()
        self._player.set_crop_aspect(w, h)

    def _do_export(self) -> None:
        input_path = self._input_edit.text().strip()
        if not input_path or not os.path.isfile(input_path):
            QtWidgets.QMessageBox.warning(self, '提示', '请先选择输入文件')
            return

        s = parse_time(self._start_time.text())
        e = parse_time(self._end_time.text())
        if s is None or e is None:
            QtWidgets.QMessageBox.warning(self, '提示', '请输入有效的时间范围')
            return
        if e <= s:
            QtWidgets.QMessageBox.warning(self, '提示', '结束时间必须大于起始时间')
            return

        out_w = self._output_w.value()
        out_h = self._output_h.value()
        fps = self._fps_input.value()

        # 裁剪
        crop = self._player.get_crop_rect() if self._use_crop.isChecked() else None
        crop_kwargs = {}
        if crop and crop[2] > 0 and crop[3] > 0:
            crop_kwargs = {'crop_x': crop[0], 'crop_y': crop[1],
                           'crop_w': crop[2], 'crop_h': crop[3]}

        # 输出路径
        base = Path(input_path).stem
        ext = self.FORMAT_EXT
        out_path = Path(input_path).parent / f'{base}_{s:.1f}s-{e:.1f}s.{ext}'
        out_path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, f'保存{self.FORMAT_NAME}',
            str(out_path),
            f'{self.FORMAT_NAME} (*.{ext})'
        )
        if not out_path:
            return

        # 在线程中执行
        self._set_export_running(True)

        if self.FORMAT_EXT == 'gif':
            export_func = backend.export_gif
        else:
            export_func = backend.export_webp

        kwargs = dict(
            input_path=input_path, output_path=out_path,
            start_time=s, duration=e - s,
            fps=fps, width=out_w, height=out_h,
            **crop_kwargs,
        )
        if self.FORMAT_EXT == 'webp':
            kwargs['quality'] = self._quality.value() if hasattr(self, '_quality') else 75

        def task(thread):
            logger = GuiLogger(thread.log_line.emit)
            return export_func(logger=logger, thread=thread, **kwargs)

        self._task_thread = TaskThread(task)
        self._task_thread.log_line.connect(self._on_export_log)
        self._task_thread.progress_changed.connect(self._on_export_progress)
        self._task_thread.task_done.connect(self._on_export_done)
        self._task_thread.start()

    def _on_export_log(self, line: str) -> None:
        stripped = line.strip()
        if stripped:
            self._progress_detail.setText(stripped)

    def _on_export_progress(self, value: int, detail: str) -> None:
        self._progress.setValue(value)
        self._progress_detail.setText(detail)

    def _set_export_running(self, running: bool) -> None:
        self._btn_export.setEnabled(not running)
        self._btn_cancel.setEnabled(running)
        self._input_edit.setEnabled(not running)
        if running:
            self._progress.setValue(0)
            self._progress_detail.setText('正在处理...')

    def _cancel_export(self) -> None:
        if self._task_thread and self._task_thread.isRunning():
            self._task_thread.cancel()

    def _on_export_done(self, success: bool, result: object) -> None:
        self._set_export_running(False)

        if isinstance(result, dict) and result.get('cancelled'):
            self._progress_detail.setText('任务已取消')
        elif not success:
            msg = result.get('error', '未知错误') if isinstance(result, dict) else str(result)
            self._progress_detail.setText('导出失败')
            QtWidgets.QMessageBox.critical(self, '失败', f'导出失败:\n{msg}')
        else:
            self._progress.setValue(100)
            self._progress_detail.setText('导出完成')
            QtWidgets.QMessageBox.information(self, '完成',
                                              f'{self.FORMAT_NAME} 已导出!')
            self._crop_info.setText(f'导出成功')


class GifTab(_ExportTabBase):
    FORMAT_NAME = 'GIF'
    FORMAT_EXT = 'gif'


class WebpTab(_ExportTabBase):
    FORMAT_NAME = 'WebP'
    FORMAT_EXT = 'webp'


class ClipTab(_ExportTabBase):
    """截取视频片段，导出 MOV 或 MP4"""
    FORMAT_NAME = 'MOV'
    FORMAT_EXT = 'mov'

    def _build_ui(self) -> None:
        super()._build_ui()
        # 在输出参数区域后添加格式选择
        format_row = QtWidgets.QHBoxLayout()
        format_row.addWidget(QtWidgets.QLabel('输出格式:'))
        self._format_combo = QtWidgets.QComboBox()
        self._format_combo.addItem('MOV (ProRes 4444 + 透明通道)', 'mov')
        self._format_combo.addItem('MP4 (H.264)', 'mp4')
        self._format_combo.currentIndexChanged.connect(self._on_format_change)
        format_row.addWidget(self._format_combo, 1)
        # 插入到 stretch 之前
        self._left_layout.insertLayout(self._left_layout.count() - 1, format_row)
        self._btn_export.setText('截取导出')

    def _on_format_change(self, idx: int) -> None:
        fmt = self._format_combo.currentData()
        self.FORMAT_EXT = fmt
        self.FORMAT_NAME = fmt.upper()

    def _do_export(self) -> None:
        input_path = self._input_edit.text().strip()
        if not input_path or not os.path.isfile(input_path):
            QtWidgets.QMessageBox.warning(self, '提示', '请先选择输入文件')
            return

        s = parse_time(self._start_time.text())
        e = parse_time(self._end_time.text())
        if s is None or e is None:
            QtWidgets.QMessageBox.warning(self, '提示', '请输入有效的时间范围')
            return
        if e <= s:
            QtWidgets.QMessageBox.warning(self, '提示', '结束时间必须大于起始时间')
            return

        out_w = self._output_w.value()
        out_h = self._output_h.value()
        fps = self._fps_input.value()

        crop = self._player.get_crop_rect() if self._use_crop.isChecked() else None
        crop_kwargs = {}
        if crop and crop[2] > 0 and crop[3] > 0:
            crop_kwargs = {'crop_x': crop[0], 'crop_y': crop[1],
                           'crop_w': crop[2], 'crop_h': crop[3]}

        out_format = self._format_combo.currentData()
        ext = out_format
        base = Path(input_path).stem
        out_path = Path(input_path).parent / f'{base}_{s:.1f}s-{e:.1f}s.{ext}'
        out_path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, '保存视频', str(out_path),
            f'MOV (*.mov);;MP4 (*.mp4)' if out_format == 'mov' else 'MP4 (*.mp4);;MOV (*.mov)'
        )
        if not out_path:
            return

        self._set_export_running(True)

        kwargs = dict(
            input_path=input_path, output_path=out_path,
            start_time=s, duration=e - s,
            fps=fps, width=out_w, height=out_h,
            out_format=out_format,
            **crop_kwargs,
        )

        def task(thread):
            logger = GuiLogger(thread.log_line.emit)
            return backend.export_segment(logger=logger, thread=thread, **kwargs)

        self._task_thread = TaskThread(task)
        self._task_thread.log_line.connect(self._on_export_log)
        self._task_thread.progress_changed.connect(self._on_export_progress)
        self._task_thread.task_done.connect(self._on_clip_done)
        self._task_thread.start()

    def _on_clip_done(self, success: bool, result: object) -> None:
        self._set_export_running(False)
        if isinstance(result, dict) and result.get('cancelled'):
            self._progress_detail.setText('任务已取消')
        elif not success:
            msg = result.get('error', '未知错误') if isinstance(result, dict) else str(result)
            self._progress_detail.setText('截取失败')
            QtWidgets.QMessageBox.critical(self, '失败', f'截取失败:\n{msg}')
        else:
            self._progress.setValue(100)
            self._progress_detail.setText('截取完成')
            QtWidgets.QMessageBox.information(self, '完成', '视频片段已导出!')


