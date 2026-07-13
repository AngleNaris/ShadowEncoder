#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import ctypes
import sys
import threading
import time
import traceback
from datetime import datetime
from html import escape
from pathlib import Path

from PySide6 import QtCore, QtGui, QtSvg, QtWidgets

import video_check_backend
import video_conv_backend
import video_mix_backend
import video_update_backend
from video_conv_config import (
    DEFAULT_CFG_AUDIO_ONLY,
    DEFAULT_CFG_DENOISE,
    DEFAULT_CFG_LOUDNORM,
    DEFAULT_CFG_PRESET,
    DEFAULT_CFG_TUNE,
    DEFAULT_CFG_UNSHARP,
    cfg_denoise_list,
    cfg_preset_list,
    cfg_tune_list,
    cfg_unsharp_list,
    format_gui_preset_label,
    normalize_path,
    OperationCancelledError,
)


def resource_dir() -> Path:
    if getattr(sys, '_MEIPASS', None):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def resource_path(name: str) -> Path:
    return resource_dir() / name


def load_svg_icon() -> QtGui.QIcon:
    icon_path = resource_path('icon.svg')
    if not icon_path.exists():
        return QtGui.QIcon()

    renderer = QtSvg.QSvgRenderer(str(icon_path))
    icon = QtGui.QIcon()
    for size in (16, 24, 32, 48, 64, 128, 256):
        pixmap = QtGui.QPixmap(size, size)
        pixmap.fill(QtCore.Qt.GlobalColor.transparent)
        painter = QtGui.QPainter(pixmap)
        renderer.render(painter)
        painter.end()
        icon.addPixmap(pixmap)
    return icon


def apply_windows_app_id() -> None:
    if sys.platform != 'win32':
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('ShadowEncoder')
    except Exception:
        pass




def _format_eta(elapsed: float, percent: int) -> str:
    if percent <= 0:
        return ""
    remaining = elapsed / percent * (100 - percent)
    if remaining < 0:
        return ""
    total = int(remaining)
    h, remainder = divmod(total, 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"预计剩余 {h}分{m:02d}秒{s:02d}"
    return f"预计剩余 {m}分{s:02d}秒"
def configure_combo_box(combo: QtWidgets.QComboBox, minimum_contents: int = 16) -> None:
    combo.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToContentsOnFirstShow)
    combo.setMinimumContentsLength(minimum_contents)
    combo.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
    view = combo.view()
    if view is not None:
        view.setTextElideMode(QtCore.Qt.ElideNone)
        view.setMinimumWidth(340)


def apply_dark_theme(app: QtWidgets.QApplication) -> None:
    palette = QtGui.QPalette()
    palette.setColor(QtGui.QPalette.Window, QtGui.QColor('#141218'))
    palette.setColor(QtGui.QPalette.WindowText, QtGui.QColor('#e6e0e9'))
    palette.setColor(QtGui.QPalette.Base, QtGui.QColor('#141218'))
    palette.setColor(QtGui.QPalette.AlternateBase, QtGui.QColor('#1d1b20'))
    palette.setColor(QtGui.QPalette.Text, QtGui.QColor('#e6e0e9'))
    palette.setColor(QtGui.QPalette.Button, QtGui.QColor('#211f26'))
    palette.setColor(QtGui.QPalette.ButtonText, QtGui.QColor('#e6e0e9'))
    palette.setColor(QtGui.QPalette.Highlight, QtGui.QColor('#4f378b'))
    palette.setColor(QtGui.QPalette.HighlightedText, QtGui.QColor('#e6e0e9'))
    app.setPalette(palette)
    app.setStyle('Fusion')
    app.setStyleSheet(
        """
        QWidget {
            background: #141218;
            color: #e6e0e9;
            font-family: "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif;
            font-size: 13px;
        }
        QMainWindow, QTabWidget::pane {
            background: #141218;
            border: none;
            padding: 0;
            margin: 0;
        }
        QFrame#PanelFrame {
            background: #211f26;
            border: 1px solid #49454f;
        }
        QFrame#MetricFrame {
            background: #211f26;
            border: 1px solid #49454f;
        }
        QFrame#InfoFrame {
            background: #1d1b20;
            border: 1px solid #49454f;
        }
        QLabel#PageTitle {
            font-size: 24px;
            font-weight: 500;
            color: #e6e0e9;
        }
        QLabel#PageSubtitle {
            color: #9e90a8;
            font-size: 12px;
        }
        QLabel#SectionTitle {
            color: #e6e0e9;
            font-size: 14px;
            font-weight: 500;
        }
        QLabel { background: transparent; }
        QLabel#HintLabel { color: #9e90a8; }
        QLabel#DetailLabel { color: #c8c0d0; }
        QLineEdit, QComboBox, QDoubleSpinBox, QTextEdit {
            background: #211f26;
            border: 1px solid #49454f;
            padding: 8px 10px;
            selection-background-color: #4f378b;
            selection-color: #e6e0e9;
        }
        QLineEdit:focus, QComboBox:focus, QDoubleSpinBox:focus, QTextEdit:focus {
            border-color: #4f378b;
        }
        QComboBox::drop-down { width: 26px; border: none; }
        QComboBox::down-arrow { image: none; width: 0px; height: 0px; }
        QCheckBox { spacing: 8px; background: transparent; }
        QCheckBox::indicator {
            width: 14px;
            height: 14px;
            border: 1px solid #49454f;
            background: #211f26;
        }
        QCheckBox::indicator:checked {
            background: #4f378b;
            border: 1px solid #4f378b;
        }
        QPushButton {
            background: #211f26;
            border: 1px solid #49454f;
            padding: 9px 16px;
            min-height: 20px;
        }
        QPushButton:hover { background: #2d2b33; border-color: #4f378b; }
        QPushButton:disabled {
            color: #585460;
            background: #1d1b20;
            border-color: #302d36;
        }
        QPushButton#PrimaryButton {
            background: #4f378b;
            color: #bfabf1;
            border: 1px solid #4f378b;
            font-weight: 500;
        }
        QPushButton#PrimaryButton:hover { background: #5c4a99; border-color: #5c4a99; }
        QProgressBar {
            background: #211f26;
            border: 1px solid #49454f;
            min-height: 32px;
            max-height: 32px;
            text-align: center;
            color: #e6e0e9;
        }
        QProgressBar::chunk { background: #4f378b; }
        QTabBar::tab {
            background: #211f26;
            border: 1px solid #49454f;
            border-bottom: none;
            padding: 22px 18px;
            min-width: 100px;
        }
        QTabBar::tab:selected {
            background: #141218;
            color: #e6e0e9;
            border-top: 2px solid #4f378b;
        }
        QTabBar::tab:hover:!selected {
            background: #1d1b20;
        }
        QStatusBar {
            background: #141218;
            border-top: 1px solid #49454f;
        }
        QScrollBar:vertical {
            background: #141218;
            width: 8px;
            border: none;
        }
        QScrollBar::handle:vertical {
            background: #49454f;
            min-height: 30px;
        }
        QScrollBar::handle:vertical:hover { background: #4f378b; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QScrollBar:horizontal {
            background: #141218;
            height: 8px;
            border: none;
        }
        QScrollBar::handle:horizontal {
            background: #49454f;
            min-width: 30px;
        }
        QScrollBar::handle:horizontal:hover { background: #4f378b; }
        QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
        QSplitter::handle:horizontal {
            background: #49454f;
            width: 1px;
        }
        """
    )


class GuiLogger:
    def __init__(self, emit_line, log_path: Path) -> None:
        self.emit_line = emit_line
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.log_path.open('w', encoding='utf-8', newline='\n')
        self.buffer = ''

    def close(self) -> None:
        self.flush()
        self.handle.close()

    def flush(self) -> None:
        self.handle.flush()
        if self.buffer:
            self.emit_line(self.buffer)
            self.buffer = ''

    def write(self, text: str) -> int:
        if not text:
            return 0

        normalized = text.replace('\r', '\n')
        self.handle.write(normalized)
        self.handle.flush()
        self.buffer += normalized
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            self.emit_line(line)
        return len(text)

    def print(self, *args: object, sep: str = ' ', end: str = '\n') -> None:
        self.write(sep.join(str(arg) for arg in args) + end)


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


class StatusBadge(QtWidgets.QLabel):
    COLORS = {
        'idle': ('#9e90a8', 'transparent', '#49454f'),
        'running': ('#e6e0e9', 'transparent', '#4f378b'),
        'success': ('#e6e0e9', 'transparent', '#49454f'),
        'warning': ('#e6e0e9', 'transparent', '#49454f'),
        'error': ('#e6e0e9', 'transparent', '#49454f'),
    }

    def __init__(self, text: str = '空闲', tone: str = 'idle', parent=None) -> None:
        super().__init__(text, parent)
        self.setAlignment(QtCore.Qt.AlignCenter)
        self.setMinimumWidth(90)
        self.setMinimumHeight(30)
        self.set_state(text, tone)

    def set_state(self, text: str, tone: str) -> None:
        fg, bg, border = self.COLORS.get(tone, self.COLORS['idle'])
        self.setText(text)
        self.setStyleSheet(f'color:{fg}; background:{bg}; border:1px solid {border}; padding:4px 10px; font-weight:600;')


class MetricBox(QtWidgets.QFrame):
    def __init__(self, title: str, tone: str = 'idle', parent=None) -> None:
        super().__init__(parent)
        self.setObjectName('MetricFrame')
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(4)
        self.title_label = QtWidgets.QLabel(title)
        self.title_label.setObjectName('HintLabel')
        self.value_label = QtWidgets.QLabel('0')
        layout.addWidget(self.title_label)
        layout.addWidget(self.value_label)
        self.set_tone(tone)

    def set_value(self, value: object) -> None:
        self.value_label.setText(str(value))

    def set_tone(self, tone: str) -> None:
        color = {
            'idle': '#9e90a8',
            'info': '#e6e0e9',
            'success': '#e6e0e9',
            'warning': '#e6e0e9',
            'error': '#e6e0e9',
        }.get(tone, '#9e90a8')
        self.value_label.setStyleSheet(f'font-size:24px; font-weight:700; color:{color};')


class FileListWidget(QtWidgets.QFrame):
    """Drag-and-drop file/folder list with placeholder text.

    Drag-drop is handled on the outer frame to avoid QListWidget's internal
    drag-drop handling which conflicts with external file drops.
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setObjectName('FileListFrame')
        self._default_style = self.styleSheet()

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._list = QtWidgets.QListWidget()
        self._list.setSelectionMode(QtWidgets.QAbstractItemView.ExtendedSelection)
        self._list.setFixedHeight(96)
        self._list.setDragDropMode(QtWidgets.QAbstractItemView.NoDragDrop)
        layout.addWidget(self._list)

        # placeholder label overlaid on the list
        self._placeholder = QtWidgets.QLabel('将文件拖动至此，或点击下方按钮选择', self._list)
        self._placeholder.setAlignment(QtCore.Qt.AlignCenter)
        self._placeholder.setObjectName('HintLabel')
        self._placeholder.setStyleSheet('padding: 10px; background: transparent;')
        self._placeholder.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents, True)
        self._update_placeholder()

    # ── public API ──────────────────────────────────────────────────
    def add_paths(self, paths: list[str]) -> None:
        existing = {self._list.item(i).text() for i in range(self._list.count())}
        for p in paths:
            p = p.strip()
            if p and p not in existing:
                item = QtWidgets.QListWidgetItem(p)
                if Path(p).is_dir():
                    item.setIcon(self.style().standardIcon(QtWidgets.QStyle.SP_DirIcon))
                else:
                    item.setIcon(self.style().standardIcon(QtWidgets.QStyle.SP_FileIcon))
                self._list.addItem(item)
                existing.add(p)
        self._update_placeholder()

    def set_single_path(self, path: str) -> None:
        self._list.clear()
        if path.strip():
            self.add_paths([path])

    def current_paths(self) -> list[str]:
        return [self._list.item(i).text() for i in range(self._list.count())]

    def clear_all(self) -> None:
        self._list.clear()
        self._update_placeholder()

    # ── internal ────────────────────────────────────────────────────
    def _update_placeholder(self) -> None:
        self._placeholder.setVisible(self._list.count() == 0)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._recenter_placeholder()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        self._recenter_placeholder()

    def _recenter_placeholder(self) -> None:
        if not self._list.viewport():
            return
        w = self._list.viewport().width()
        h = self._list.viewport().height()
        self._placeholder.setGeometry(0, 0, w, h)
        self._placeholder.setAlignment(QtCore.Qt.AlignCenter)

    # ── drag & drop on the outer frame ──────────────────────────────
    def _has_urls(self, mime_data: QtCore.QMimeData) -> bool:
        if not mime_data.hasUrls():
            return False
        for url in mime_data.urls():
            if url.isLocalFile():
                return True
        return False

    def _extract_paths(self, mime_data: QtCore.QMimeData) -> list[str]:
        return [url.toLocalFile() for url in mime_data.urls() if url.isLocalFile()]

    def dragEnterEvent(self, event: QtGui.QDragEnterEvent) -> None:
        if self._has_urls(event.mimeData()):
            event.acceptProposedAction()
            self.setStyleSheet('QFrame#FileListFrame { border: 2px dashed #4f378b; }')
        else:
            event.ignore()

    def dragMoveEvent(self, event: QtGui.QDragMoveEvent) -> None:
        if self._has_urls(event.mimeData()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragLeaveEvent(self, event) -> None:
        self.setStyleSheet(self._default_style)

    def dropEvent(self, event: QtGui.QDropEvent) -> None:
        self.setStyleSheet(self._default_style)
        paths = self._extract_paths(event.mimeData())
        if paths:
            event.acceptProposedAction()
            self.add_paths(paths)
        else:
            event.ignore()


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

        if stripped.startswith('[PASS]') or stripped.startswith('✓'):
            color = '#188c49'
            weight = '600'
        elif stripped.startswith('[FAIL]') or stripped.startswith('✗') or stripped.startswith('  E') or '错误' in stripped:
            color = '#8c1d18'
            weight = '600'
        elif stripped.startswith('[PASS_WITH_WARNINGS]') or stripped.startswith('  W') or '警告' in stripped:
            color = '#e6e0e9'
            weight = '600'
        elif stripped.startswith('日志已保存') or stripped.startswith('输出位置') or stripped.startswith('JSON 报告已写入'):
            color = '#9e90a8'
        elif stripped.startswith('开始时间') or stripped.startswith('输入路径') or stripped.startswith('检查目标') or stripped.startswith('预设:'):
            color = '#9e90a8'
        elif stripped.startswith('汇总') or stripped.startswith('通过') or stripped.startswith('失败') or stripped.startswith('警告通过'):
            color = '#e6e0e9'
            weight = '600'

        self.append(f'<pre style="margin:0; color:{color}; font-weight:{weight}; background:transparent; font-family:Consolas, \'PingFang SC\', \'Microsoft YaHei UI\', \'Noto Sans CJK SC\', sans-serif;">{escape(line)}</pre>')
        self.moveCursor(QtGui.QTextCursor.End)
        self.horizontalScrollBar().setValue(0)


class PanelFrame(QtWidgets.QFrame):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName('PanelFrame')


class EncodeTab(QtWidgets.QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.last_log_path: Path | None = None
        self.input_controls: list[QtWidgets.QWidget] = []
        self._build_ui()
        self._update_output_hint()

    def _build_ui(self) -> None:
        root = QtWidgets.QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        root.addWidget(splitter)

        left_panel = PanelFrame()
        left_panel.setFixedWidth(430)
        left_panel.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; border-right: none; border-left: none; }'
        )
        left_layout = QtWidgets.QVBoxLayout(left_panel)
        left_layout.setContentsMargins(20, 20, 20, 20)
        left_layout.setSpacing(16)

        self.input_edit = FileListWidget()
        left_layout.addWidget(self.input_edit)

        input_buttons = QtWidgets.QHBoxLayout()
        file_button = QtWidgets.QPushButton('选择文件')
        file_button.setMinimumWidth(90)
        dir_button = QtWidgets.QPushButton('选择目录')
        dir_button.setMinimumWidth(90)
        clear_button = QtWidgets.QPushButton('清除列表')
        clear_button.setMinimumWidth(90)
        clear_button.clicked.connect(self.input_edit.clear_all)
        input_buttons.addWidget(file_button)
        input_buttons.addWidget(dir_button)
        input_buttons.addWidget(clear_button)
        left_layout.addLayout(input_buttons)

        options_title = QtWidgets.QLabel('转码参数')
        options_title.setObjectName('SectionTitle')
        left_layout.addWidget(options_title)

        options_grid = QtWidgets.QGridLayout()
        options_grid.setHorizontalSpacing(12)
        options_grid.setVerticalSpacing(10)

        self.preset_combo = QtWidgets.QComboBox()
        for index, item in enumerate(cfg_preset_list):
            self.preset_combo.addItem(format_gui_preset_label(index), index)
        self.preset_combo.setCurrentIndex(DEFAULT_CFG_PRESET)
        configure_combo_box(self.preset_combo, 22)

        self.unsharp_combo = QtWidgets.QComboBox()
        for index, item in enumerate(cfg_unsharp_list):
            self.unsharp_combo.addItem(item[0][1], index)
        self.unsharp_combo.setCurrentIndex(DEFAULT_CFG_UNSHARP)
        configure_combo_box(self.unsharp_combo, 12)

        self.denoise_combo = QtWidgets.QComboBox()
        for index, item in enumerate(cfg_denoise_list):
            self.denoise_combo.addItem(item[0][1], index)
        self.denoise_combo.setCurrentIndex(DEFAULT_CFG_DENOISE)
        configure_combo_box(self.denoise_combo, 14)

        self.tune_combo = QtWidgets.QComboBox()
        for index, item in enumerate(cfg_tune_list):
            self.tune_combo.addItem(item[0][1], index)
        self.tune_combo.setCurrentIndex(DEFAULT_CFG_TUNE)
        configure_combo_box(self.tune_combo, 12)

        rows = [
            ('预设', self.preset_combo),
            ('锐化', self.unsharp_combo),
            ('降噪', self.denoise_combo),
            ('风格', self.tune_combo),
        ]
        for row, (label_text, widget) in enumerate(rows):
            label = QtWidgets.QLabel(label_text)
            label.setObjectName('DetailLabel')
            options_grid.addWidget(label, row, 0)
            options_grid.addWidget(widget, row, 1)
        left_layout.addLayout(options_grid)

        self.audio_only_check = QtWidgets.QCheckBox('仅处理音频（视频 copy）')
        self.audio_only_check.setChecked(bool(DEFAULT_CFG_AUDIO_ONLY))
        self.loudnorm_check = QtWidgets.QCheckBox('启用音频标准化')
        self.loudnorm_check.setChecked(bool(DEFAULT_CFG_LOUDNORM))
        self.keep_res_check = QtWidgets.QCheckBox('保持原始分辨率（不缩放，仅改码率）')
        left_layout.addWidget(self.audio_only_check)
        left_layout.addWidget(self.loudnorm_check)
        left_layout.addWidget(self.keep_res_check)

        info_frame = QtWidgets.QFrame()
        info_frame.setObjectName('InfoFrame')
        info_layout = QtWidgets.QVBoxLayout(info_frame)
        info_layout.setContentsMargins(14, 12, 14, 12)
        info_layout.setSpacing(6)
        info_title = QtWidgets.QLabel('输出预览')
        info_title.setObjectName('SectionTitle')
        self.output_hint = QtWidgets.QLabel()
        self.output_hint.setObjectName('HintLabel')
        self.output_hint.setWordWrap(True)
        info_layout.addWidget(info_title)
        info_layout.addWidget(self.output_hint)
        left_layout.addWidget(info_frame)

        left_layout.addStretch(1)

        actions = QtWidgets.QHBoxLayout()
        self.start_button = QtWidgets.QPushButton('开始转码')
        self.start_button.setObjectName('PrimaryButton')
        self.cancel_button = QtWidgets.QPushButton('停止任务')
        self.cancel_button.setEnabled(False)
        self.open_log_button = QtWidgets.QPushButton('打开日志目录')
        self.open_log_button.setEnabled(False)
        actions.addWidget(self.start_button)
        actions.addWidget(self.cancel_button)
        actions.addWidget(self.open_log_button)
        left_layout.addLayout(actions)

        right_panel = PanelFrame()
        right_panel.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; border-left: none; border-right: none; }'
        )
        right_layout = QtWidgets.QVBoxLayout(right_panel)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(14)

        top_row = QtWidgets.QHBoxLayout()
        self.status_badge = StatusBadge('空闲', 'idle')
        self.status_text = QtWidgets.QLabel('等待开始')
        self.status_text.setObjectName('DetailLabel')
        self.status_text.setWordWrap(True)
        top_row.addWidget(self.status_badge)
        top_row.addWidget(self.status_text, 1)
        right_layout.addLayout(top_row)

        self.progress_bar = QtWidgets.QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_detail = QtWidgets.QLabel('尚未开始任务')
        self.progress_detail.setObjectName('HintLabel')
        right_layout.addWidget(self.progress_bar)
        right_layout.addWidget(self.progress_detail)

        metrics_row = QtWidgets.QHBoxLayout()
        self.metric_success = MetricBox('成功文件', 'success')
        self.metric_fail = MetricBox('失败文件', 'error')
        self.metric_eta = MetricBox('剩余时间', 'idle')
        metrics_row.addWidget(self.metric_success)
        metrics_row.addWidget(self.metric_fail)
        metrics_row.addWidget(self.metric_eta)
        right_layout.addLayout(metrics_row)

        log_title = QtWidgets.QLabel('实时日志')
        log_title.setObjectName('SectionTitle')
        right_layout.addWidget(log_title)

        self.log_edit = ActivityLog()
        right_layout.addWidget(self.log_edit, 1)

        splitter.addWidget(left_panel)
        splitter.addWidget(right_panel)
        splitter.setSizes([430, 600])
        self._splitter = splitter

        file_button.clicked.connect(self._browse_file)
        dir_button.clicked.connect(self._browse_dir)
        self.open_log_button.clicked.connect(self._open_log_dir)

        for widget in (self.preset_combo, self.unsharp_combo, self.denoise_combo, self.tune_combo):
            widget.currentIndexChanged.connect(self._update_output_hint)
        self.audio_only_check.toggled.connect(self._update_output_hint)

        self.input_controls = [
            self.input_edit,
            file_button,
            dir_button,
            clear_button,
            self.preset_combo,
            self.unsharp_combo,
            self.denoise_combo,
            self.tune_combo,
            self.audio_only_check,
            self.loudnorm_check,
            self.keep_res_check,
        ]

    def _browse_file(self) -> None:
        paths, _ = QtWidgets.QFileDialog.getOpenFileNames(self, '选择视频文件')
        if paths:
            self.input_edit.add_paths(paths)
            self._update_output_hint()

    def _browse_dir(self) -> None:
        path = QtWidgets.QFileDialog.getExistingDirectory(self, '选择视频目录')
        if path:
            self.input_edit.add_paths([path])
            self._update_output_hint()

    def _open_log_dir(self) -> None:
        if self.last_log_path:
            QtGui.QDesktopServices.openUrl(QtCore.QUrl.fromLocalFile(str(self.last_log_path.parent)))

    def _update_output_hint(self) -> None:
        paths = self.input_edit.current_paths()
        preset_key = cfg_preset_list[self.preset_combo.currentData()][0][0]
        unsharp_key = cfg_unsharp_list[self.unsharp_combo.currentData()][0][0]
        denoise_key = cfg_denoise_list[self.denoise_combo.currentData()][0][0]
        tune_key = cfg_tune_list[self.tune_combo.currentData()][0][0]
        suffix = f'_{preset_key}_{unsharp_key}_{denoise_key}_{tune_key}'

        if not paths:
            self.output_hint.setText(f'单文件会输出为 "原文件名{suffix}.mp4"；目录会输出到 "原目录名{suffix}" 目录。')
            return

        if len(paths) > 1:
            self.output_hint.setText(f'已选择 {len(paths)} 个路径，输出到各路径对应的 "{suffix}" 子目录。')
        else:
            input_path = Path(normalize_path(paths[0]))
            if input_path.is_file():
                self.output_hint.setText(f'输出文件: {input_path.with_name(input_path.stem + suffix + ".mp4")}')
            else:
                self.output_hint.setText(f'输出目录: {Path(str(input_path) + suffix)}')

    def reset_view(self) -> None:
        self.log_edit.clear()
        self._start_time = time.time()
        self.progress_bar.setValue(0)
        self.progress_detail.setText('正在准备转码任务...')
        self.status_badge.set_state('运行中', 'running')
        self.status_text.setText('后台正在执行转码任务')
        self.metric_success.set_value(0)
        self.metric_fail.set_value(0)
        self.metric_eta.set_value('—')

    def append_log(self, line: str) -> None:
        self.log_edit.append_line(line)

    def update_progress(self, value: int, detail: str) -> None:
        self.progress_bar.setValue(max(0, min(100, value)))
        elapsed = time.time() - getattr(self, "_start_time", time.time())
        eta = _format_eta(elapsed, value)
        base = detail or '正在处理...'
        self.progress_detail.setText(base)
        if eta:
            self.metric_eta.set_value(eta.replace('预计剩余 ', ''))
            self.metric_eta.set_tone('info')
        else:
            self.metric_eta.set_value('—')
            self.metric_eta.set_tone('idle')

    def show_success(self, success_count: int, fail_count: int, output_target: str) -> None:
        tone = 'success' if fail_count == 0 else 'warning'
        text = '已完成' if fail_count == 0 else '部分失败'
        self.status_badge.set_state(text, tone)
        self.status_text.setText(f'成功 {success_count}，失败 {fail_count}')
        self.progress_bar.setValue(100)
        self.progress_detail.setText('转码任务结束')
        self.metric_success.set_value(success_count)
        self.metric_fail.set_value(fail_count)
        self.metric_eta.set_value('已完成')
        self.metric_eta.set_tone('success')

    def show_error(self, message: str) -> None:
        self.status_badge.set_state('失败', 'error')
        self.status_text.setText(message)
        self.progress_detail.setText('转码任务失败')
        self.metric_eta.set_value('—')
        self.metric_eta.set_tone('idle')

    def show_cancelled(self, message: str) -> None:
        self.status_badge.set_state('已取消', 'warning')
        self.status_text.setText(message)
        self.progress_detail.setText('转码任务已取消')
        self.metric_eta.set_value('—')
        self.metric_eta.set_tone('idle')

    def set_running(self, running: bool) -> None:
        self.start_button.setEnabled(not running)
        self.cancel_button.setEnabled(running)
        for widget in self.input_controls:
            widget.setEnabled(not running)


class MixTab(QtWidgets.QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.last_log_path: Path | None = None
        self.input_controls: list[QtWidgets.QWidget] = []
        self._build_ui()

    def _build_ui(self) -> None:
        root = QtWidgets.QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        root.addWidget(splitter)

        left_panel = PanelFrame()
        left_panel.setFixedWidth(430)
        left_panel.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; border-right: none; border-left: none; }'
        )
        left_layout = QtWidgets.QVBoxLayout(left_panel)
        left_layout.setContentsMargins(20, 20, 20, 20)
        left_layout.setSpacing(16)

        self.input_edit = FileListWidget()
        left_layout.addWidget(self.input_edit)

        path_buttons = QtWidgets.QHBoxLayout()
        file_button = QtWidgets.QPushButton('选择文件')
        file_button.setMinimumWidth(90)
        dir_button = QtWidgets.QPushButton('选择目录')
        dir_button.setMinimumWidth(90)
        clear_button = QtWidgets.QPushButton('清除列表')
        clear_button.setMinimumWidth(90)
        clear_button.clicked.connect(self.input_edit.clear_all)
        path_buttons.addWidget(file_button)
        path_buttons.addWidget(dir_button)
        path_buttons.addWidget(clear_button)
        left_layout.addLayout(path_buttons)

        loudnorm_title = QtWidgets.QLabel('响度标准化')
        loudnorm_title.setObjectName('SectionTitle')
        left_layout.addWidget(loudnorm_title)

        self.loudnorm_check = QtWidgets.QCheckBox('启用响度标准化 (EBU R128)')
        self.loudnorm_check.setChecked(True)
        left_layout.addWidget(self.loudnorm_check)

        loudnorm_grid = QtWidgets.QGridLayout()
        loudnorm_grid.setHorizontalSpacing(12)
        loudnorm_grid.setVerticalSpacing(8)

        self.loudnorm_i_spin = QtWidgets.QDoubleSpinBox()
        self.loudnorm_i_spin.setRange(-70.0, -5.0)
        self.loudnorm_i_spin.setDecimals(1)
        self.loudnorm_i_spin.setSingleStep(1.0)
        self.loudnorm_i_spin.setValue(-24.0)
        self.loudnorm_i_spin.setSuffix(' LUFS')

        self.loudnorm_tp_spin = QtWidgets.QDoubleSpinBox()
        self.loudnorm_tp_spin.setRange(-9.0, 0.0)
        self.loudnorm_tp_spin.setDecimals(1)
        self.loudnorm_tp_spin.setSingleStep(0.5)
        self.loudnorm_tp_spin.setValue(-2.0)
        self.loudnorm_tp_spin.setSuffix(' dBTP')

        self.loudnorm_lra_spin = QtWidgets.QDoubleSpinBox()
        self.loudnorm_lra_spin.setRange(1.0, 50.0)
        self.loudnorm_lra_spin.setDecimals(1)
        self.loudnorm_lra_spin.setSingleStep(1.0)
        self.loudnorm_lra_spin.setValue(7.0)
        self.loudnorm_lra_spin.setSuffix(' LU')

        loudnorm_rows = [
            ('目标响度 (I)', self.loudnorm_i_spin),
            ('真峰限制 (TP)', self.loudnorm_tp_spin),
            ('响度范围 (LRA)', self.loudnorm_lra_spin),
        ]
        for row, (label_text, widget) in enumerate(loudnorm_rows):
            label = QtWidgets.QLabel(label_text)
            label.setObjectName('DetailLabel')
            loudnorm_grid.addWidget(label, row, 0)
            loudnorm_grid.addWidget(widget, row, 1)
        left_layout.addLayout(loudnorm_grid)

        compand_title = QtWidgets.QLabel('动态压缩')
        compand_title.setObjectName('SectionTitle')
        left_layout.addWidget(compand_title)

        self.compand_check = QtWidgets.QCheckBox('启用动态压缩 (Compand)')
        self.compand_check.setChecked(True)
        left_layout.addWidget(self.compand_check)

        compand_grid = QtWidgets.QGridLayout()
        compand_grid.setHorizontalSpacing(12)
        compand_grid.setVerticalSpacing(8)

        self.compand_threshold_spin = QtWidgets.QDoubleSpinBox()
        self.compand_threshold_spin.setRange(-80.0, 0.0)
        self.compand_threshold_spin.setDecimals(1)
        self.compand_threshold_spin.setSingleStep(1.0)
        self.compand_threshold_spin.setValue(-27.0)
        self.compand_threshold_spin.setSuffix(' dB')

        self.compand_gain_spin = QtWidgets.QDoubleSpinBox()
        self.compand_gain_spin.setRange(-20.0, 40.0)
        self.compand_gain_spin.setDecimals(1)
        self.compand_gain_spin.setSingleStep(1.0)
        self.compand_gain_spin.setValue(5.0)
        self.compand_gain_spin.setSuffix(' dB')

        compand_rows = [
            ('压缩阈值', self.compand_threshold_spin),
            ('补偿增益', self.compand_gain_spin),
        ]
        for row, (label_text, widget) in enumerate(compand_rows):
            label = QtWidgets.QLabel(label_text)
            label.setObjectName('DetailLabel')
            compand_grid.addWidget(label, row, 0)
            compand_grid.addWidget(widget, row, 1)
        left_layout.addLayout(compand_grid)

        self.loudnorm_check.toggled.connect(self._update_param_state)
        self.compand_check.toggled.connect(self._update_param_state)

        hint_frame = QtWidgets.QFrame()
        hint_frame.setObjectName('InfoFrame')
        hint_layout = QtWidgets.QVBoxLayout(hint_frame)
        hint_layout.setContentsMargins(14, 12, 14, 12)
        hint_layout.setSpacing(6)
        hint_title = QtWidgets.QLabel('处理说明')
        hint_title.setObjectName('SectionTitle')
        hint_text = QtWidgets.QLabel(
            '视频流直接复制，仅对音频轨进行响度标准化和/或动态压缩处理。\n'
            '输出为 AAC 320kbps，文件后缀 _mix。\n'
            '无音频轨的文件将自动跳过。'
        )
        hint_text.setObjectName('HintLabel')
        hint_text.setWordWrap(True)
        hint_layout.addWidget(hint_title)
        hint_layout.addWidget(hint_text)
        left_layout.addWidget(hint_frame)

        left_layout.addStretch(1)

        actions = QtWidgets.QHBoxLayout()
        self.start_button = QtWidgets.QPushButton('开始混音')
        self.start_button.setObjectName('PrimaryButton')
        self.cancel_button = QtWidgets.QPushButton('停止任务')
        self.cancel_button.setEnabled(False)
        self.open_log_button = QtWidgets.QPushButton('打开日志目录')
        self.open_log_button.setEnabled(False)
        actions.addWidget(self.start_button)
        actions.addWidget(self.cancel_button)
        actions.addWidget(self.open_log_button)
        left_layout.addLayout(actions)

        right_panel = PanelFrame()
        right_panel.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; border-left: none; border-right: none; }'
        )
        right_layout = QtWidgets.QVBoxLayout(right_panel)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(14)

        top_row = QtWidgets.QHBoxLayout()
        self.status_badge = StatusBadge('空闲', 'idle')
        self.status_text = QtWidgets.QLabel('等待开始')
        self.status_text.setObjectName('DetailLabel')
        self.status_text.setWordWrap(True)
        top_row.addWidget(self.status_badge)
        top_row.addWidget(self.status_text, 1)
        right_layout.addLayout(top_row)

        self.progress_bar = QtWidgets.QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_detail = QtWidgets.QLabel('尚未开始任务')
        self.progress_detail.setObjectName('HintLabel')
        right_layout.addWidget(self.progress_bar)
        right_layout.addWidget(self.progress_detail)

        metrics_row = QtWidgets.QHBoxLayout()
        self.metric_success = MetricBox('成功文件', 'success')
        self.metric_fail = MetricBox('失败文件', 'error')
        self.metric_eta = MetricBox('剩余时间', 'idle')
        metrics_row.addWidget(self.metric_success)
        metrics_row.addWidget(self.metric_fail)
        metrics_row.addWidget(self.metric_eta)
        right_layout.addLayout(metrics_row)

        log_title = QtWidgets.QLabel('实时日志')
        log_title.setObjectName('SectionTitle')
        right_layout.addWidget(log_title)

        self.log_edit = ActivityLog()
        right_layout.addWidget(self.log_edit, 1)

        splitter.addWidget(left_panel)
        splitter.addWidget(right_panel)
        splitter.setSizes([430, 600])
        self._splitter = splitter

        file_button.clicked.connect(self._browse_file)
        dir_button.clicked.connect(self._browse_dir)
        self.open_log_button.clicked.connect(self._open_log_dir)

        self.input_controls = [
            self.input_edit,
            file_button,
            dir_button,
            self.loudnorm_check,
            self.loudnorm_i_spin,
            self.loudnorm_tp_spin,
            self.loudnorm_lra_spin,
            self.compand_check,
            self.compand_threshold_spin,
            self.compand_gain_spin,
        ]

    def _update_param_state(self) -> None:
        loudnorm_on = self.loudnorm_check.isChecked()
        self.loudnorm_i_spin.setEnabled(loudnorm_on)
        self.loudnorm_tp_spin.setEnabled(loudnorm_on)
        self.loudnorm_lra_spin.setEnabled(loudnorm_on)

        compand_on = self.compand_check.isChecked()
        self.compand_threshold_spin.setEnabled(compand_on)
        self.compand_gain_spin.setEnabled(compand_on)

    def _browse_file(self) -> None:
        paths, _ = QtWidgets.QFileDialog.getOpenFileNames(
            self, '选择媒体文件', '',
            '媒体文件 (*.mp4 *.mkv *.mov *.avi *.mpg *.mpeg *.ts *.wmv *.flv '
            '*.mp3 *.wav *.flac *.aac *.m4a *.wma *.ogg *.opus);;所有文件 (*.*)'
        )
        if paths:
            self.input_edit.add_paths(paths)

    def _browse_dir(self) -> None:
        path = QtWidgets.QFileDialog.getExistingDirectory(self, '选择媒体目录')
        if path:
            self.input_edit.add_paths([path])

    def _open_log_dir(self) -> None:
        if self.last_log_path:
            QtGui.QDesktopServices.openUrl(QtCore.QUrl.fromLocalFile(str(self.last_log_path.parent)))

    def reset_view(self) -> None:
        self.log_edit.clear()
        self._start_time = time.time()
        self.progress_bar.setValue(0)
        self.progress_detail.setText('正在准备混音任务...')
        self.status_badge.set_state('运行中', 'running')
        self.status_text.setText('后台正在执行混音任务')
        self.metric_success.set_value(0)
        self.metric_fail.set_value(0)
        self.metric_eta.set_value('—')

    def append_log(self, line: str) -> None:
        self.log_edit.append_line(line)

    def update_progress(self, value: int, detail: str) -> None:
        self.progress_bar.setValue(max(0, min(100, value)))
        elapsed = time.time() - getattr(self, "_start_time", time.time())
        eta = _format_eta(elapsed, value)
        base = detail or '正在处理...'
        self.progress_detail.setText(base)
        if eta:
            self.metric_eta.set_value(eta.replace('预计剩余 ', ''))
            self.metric_eta.set_tone('info')
        else:
            self.metric_eta.set_value('—')
            self.metric_eta.set_tone('idle')

    def show_success(self, success_count: int, fail_count: int, output_target: str) -> None:
        tone = 'success' if fail_count == 0 else 'warning'
        text = '已完成' if fail_count == 0 else '部分失败'
        self.status_badge.set_state(text, tone)
        self.status_text.setText(f'成功 {success_count}，失败 {fail_count}')
        self.progress_bar.setValue(100)
        self.progress_detail.setText('混音任务结束')
        self.metric_success.set_value(success_count)
        self.metric_fail.set_value(fail_count)
        self.metric_eta.set_value('已完成')
        self.metric_eta.set_tone('success')

    def show_error(self, message: str) -> None:
        self.status_badge.set_state('失败', 'error')
        self.status_text.setText(message)
        self.progress_detail.setText('混音任务失败')
        self.metric_eta.set_value('—')
        self.metric_eta.set_tone('idle')

    def show_cancelled(self, message: str) -> None:
        self.status_badge.set_state('已取消', 'warning')
        self.status_text.setText(message)
        self.progress_detail.setText('混音任务已取消')
        self.metric_eta.set_value('—')
        self.metric_eta.set_tone('idle')

    def set_running(self, running: bool) -> None:
        self.start_button.setEnabled(not running)
        self.cancel_button.setEnabled(running)
        for widget in self.input_controls:
            widget.setEnabled(not running)


class CheckTab(QtWidgets.QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.last_log_path: Path | None = None
        self.input_controls: list[QtWidgets.QWidget] = []
        self._build_ui()

    def _build_ui(self) -> None:
        root = QtWidgets.QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        root.addWidget(splitter)

        left_panel = PanelFrame()
        left_panel.setFixedWidth(430)
        left_panel.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; border-right: none; border-left: none; }'
        )
        left_layout = QtWidgets.QVBoxLayout(left_panel)
        left_layout.setContentsMargins(20, 20, 20, 20)
        left_layout.setSpacing(16)

        self.input_edit = FileListWidget()
        left_layout.addWidget(self.input_edit)

        path_buttons = QtWidgets.QHBoxLayout()
        file_button = QtWidgets.QPushButton('选择文件')
        file_button.setMinimumWidth(90)
        dir_button = QtWidgets.QPushButton('选择目录')
        dir_button.setMinimumWidth(90)
        clear_button = QtWidgets.QPushButton('清除列表')
        clear_button.setMinimumWidth(90)
        clear_button.clicked.connect(self.input_edit.clear_all)
        path_buttons.addWidget(file_button)
        path_buttons.addWidget(dir_button)
        path_buttons.addWidget(clear_button)
        left_layout.addLayout(path_buttons)

        config_title = QtWidgets.QLabel('检测规则')
        config_title.setObjectName('SectionTitle')
        left_layout.addWidget(config_title)

        config_grid = QtWidgets.QGridLayout()
        config_grid.setHorizontalSpacing(12)
        config_grid.setVerticalSpacing(10)

        self.preset_combo = QtWidgets.QComboBox()
        for index, item in enumerate(cfg_preset_list):
            self.preset_combo.addItem(format_gui_preset_label(index), index)
        self.preset_combo.setCurrentIndex(DEFAULT_CFG_PRESET)
        configure_combo_box(self.preset_combo, 22)

        self.fps_tolerance_spin = QtWidgets.QDoubleSpinBox()
        self.fps_tolerance_spin.setRange(0.0, 10.0)
        self.fps_tolerance_spin.setDecimals(2)
        self.fps_tolerance_spin.setSingleStep(0.1)
        self.fps_tolerance_spin.setValue(0.5)

        self.video_bitrate_spin = QtWidgets.QDoubleSpinBox()
        self.video_bitrate_spin.setRange(0.0, 200.0)
        self.video_bitrate_spin.setDecimals(1)
        self.video_bitrate_spin.setSingleStep(5.0)
        self.video_bitrate_spin.setSuffix('%')
        self.video_bitrate_spin.setValue(25.0)

        self.audio_bitrate_spin = QtWidgets.QDoubleSpinBox()
        self.audio_bitrate_spin.setRange(0.0, 200.0)
        self.audio_bitrate_spin.setDecimals(1)
        self.audio_bitrate_spin.setSingleStep(5.0)
        self.audio_bitrate_spin.setSuffix('%')
        self.audio_bitrate_spin.setValue(35.0)

        self.black_min_spin = QtWidgets.QDoubleSpinBox()
        self.black_min_spin.setRange(0.0, 10.0)
        self.black_min_spin.setDecimals(3)
        self.black_min_spin.setSingleStep(0.01)
        self.black_min_spin.setValue(0.04)

        self.ignore_edge_spin = QtWidgets.QDoubleSpinBox()
        self.ignore_edge_spin.setRange(0.0, 30.0)
        self.ignore_edge_spin.setDecimals(2)
        self.ignore_edge_spin.setSingleStep(0.1)
        self.ignore_edge_spin.setValue(0.5)

        rows = [
            ('预设', self.preset_combo),
            ('帧率容差', self.fps_tolerance_spin),
            ('视频码率容差', self.video_bitrate_spin),
            ('音频码率容差', self.audio_bitrate_spin),
            ('黑场最短时长', self.black_min_spin),
            ('忽略头尾黑场', self.ignore_edge_spin),
        ]
        for row, (label_text, widget) in enumerate(rows):
            label = QtWidgets.QLabel(label_text)
            label.setObjectName('DetailLabel')
            config_grid.addWidget(label, row, 0)
            config_grid.addWidget(widget, row, 1)
        left_layout.addLayout(config_grid)

        self.audio_only_check = QtWidgets.QCheckBox('按仅处理音频模式检查')
        self.recursive_check = QtWidgets.QCheckBox('目录递归扫描')
        self.black_detect_check = QtWidgets.QCheckBox('启用中间黑帧检测')
        self.audio_only_check.setChecked(False)
        self.recursive_check.setChecked(True)
        self.black_detect_check.setChecked(True)
        left_layout.addWidget(self.audio_only_check)
        left_layout.addWidget(self.recursive_check)
        left_layout.addWidget(self.black_detect_check)

        hint_frame = QtWidgets.QFrame()
        hint_frame.setObjectName('InfoFrame')
        hint_layout = QtWidgets.QVBoxLayout(hint_frame)
        hint_layout.setContentsMargins(14, 12, 14, 12)
        hint_title = QtWidgets.QLabel('检测范围')
        hint_title.setObjectName('SectionTitle')
        hint_text = QtWidgets.QLabel('只校验分辨率宽度、帧率范围、音视频平均码率，以及中间黑帧。头尾黑场会按设定秒数忽略。')
        hint_text.setObjectName('HintLabel')
        hint_text.setWordWrap(True)
        hint_layout.addWidget(hint_title)
        hint_layout.addWidget(hint_text)
        left_layout.addWidget(hint_frame)

        left_layout.addStretch(1)

        actions = QtWidgets.QHBoxLayout()
        self.start_button = QtWidgets.QPushButton('开始检测')
        self.start_button.setObjectName('PrimaryButton')
        self.cancel_button = QtWidgets.QPushButton('停止任务')
        self.cancel_button.setEnabled(False)
        self.open_log_button = QtWidgets.QPushButton('打开日志目录')
        self.open_log_button.setEnabled(False)
        actions.addWidget(self.start_button)
        actions.addWidget(self.cancel_button)
        actions.addWidget(self.open_log_button)
        left_layout.addLayout(actions)

        right_panel = PanelFrame()
        right_panel.setStyleSheet(
            'QFrame#PanelFrame { background: #211f26; border: 1px solid #49454f; border-left: none; border-right: none; }'
        )
        right_layout = QtWidgets.QVBoxLayout(right_panel)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setSpacing(14)

        top_row = QtWidgets.QHBoxLayout()
        self.status_badge = StatusBadge('空闲', 'idle')
        self.status_text = QtWidgets.QLabel('等待开始')
        self.status_text.setObjectName('DetailLabel')
        self.status_text.setWordWrap(True)
        top_row.addWidget(self.status_badge)
        top_row.addWidget(self.status_text, 1)
        right_layout.addLayout(top_row)

        self.progress_bar = QtWidgets.QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_detail = QtWidgets.QLabel('尚未开始任务')
        self.progress_detail.setObjectName('HintLabel')
        right_layout.addWidget(self.progress_bar)
        right_layout.addWidget(self.progress_detail)

        metrics_row = QtWidgets.QHBoxLayout()
        self.metric_pass = MetricBox('通过', 'success')
        self.metric_warn = MetricBox('警告通过', 'warning')
        self.metric_fail = MetricBox('失败', 'error')
        metrics_row.addWidget(self.metric_pass)
        metrics_row.addWidget(self.metric_warn)
        metrics_row.addWidget(self.metric_fail)
        right_layout.addLayout(metrics_row)

        log_title = QtWidgets.QLabel('检测日志')
        log_title.setObjectName('SectionTitle')
        right_layout.addWidget(log_title)

        self.log_edit = ActivityLog()
        right_layout.addWidget(self.log_edit, 1)

        splitter.addWidget(left_panel)
        splitter.addWidget(right_panel)
        splitter.setSizes([430, 600])
        self._splitter = splitter

        file_button.clicked.connect(self._browse_file)
        dir_button.clicked.connect(self._browse_dir)
        self.open_log_button.clicked.connect(self._open_log_dir)

        self.input_controls = [
            self.input_edit,
            file_button,
            dir_button,
            self.preset_combo,
            self.fps_tolerance_spin,
            self.video_bitrate_spin,
            self.audio_bitrate_spin,
            self.black_min_spin,
            self.ignore_edge_spin,
            self.audio_only_check,
            self.recursive_check,
            self.black_detect_check,
        ]

    def _browse_file(self) -> None:
        paths, _ = QtWidgets.QFileDialog.getOpenFileNames(self, '选择视频文件')
        if paths:
            self.input_edit.add_paths(paths)

    def _browse_dir(self) -> None:
        path = QtWidgets.QFileDialog.getExistingDirectory(self, '选择视频目录')
        if path:
            self.input_edit.add_paths([path])

    def _open_log_dir(self) -> None:
        if self.last_log_path:
            QtGui.QDesktopServices.openUrl(QtCore.QUrl.fromLocalFile(str(self.last_log_path.parent)))

    def reset_view(self) -> None:
        self.log_edit.clear()
        self._start_time = time.time()
        self.progress_bar.setValue(0)
        self.progress_detail.setText('正在准备检测任务...')
        self.status_badge.set_state('运行中', 'running')
        self.status_text.setText('后台正在执行检测任务')
        self.metric_pass.set_value(0)
        self.metric_warn.set_value(0)
        self.metric_fail.set_value(0)

    def append_log(self, line: str) -> None:
        self.log_edit.append_line(line)

    def update_progress(self, value: int, detail: str) -> None:
        self.progress_bar.setValue(max(0, min(100, value)))
        elapsed = time.time() - getattr(self, "_start_time", time.time())
        eta = _format_eta(elapsed, value)
        base = detail or '正在检测...'
        self.progress_detail.setText(f"{base}  {eta}" if eta else base)
    def show_success(self, summary: dict[str, int], ok: bool) -> None:
        tone = 'success' if ok else 'warning'
        text = '已完成' if ok else '有异常'
        self.status_badge.set_state(text, tone)
        self.status_text.setText(f'通过 {summary.get("pass", 0)}，警告通过 {summary.get("pass_with_warnings", 0)}，失败 {summary.get("fail", 0)}')
        self.progress_bar.setValue(100)
        self.progress_detail.setText('检测任务结束')
        self.metric_pass.set_value(summary.get('pass', 0))
        self.metric_warn.set_value(summary.get('pass_with_warnings', 0))
        self.metric_fail.set_value(summary.get('fail', 0))

    def show_error(self, message: str) -> None:
        self.status_badge.set_state('失败', 'error')
        self.status_text.setText(message)
        self.progress_detail.setText('检测任务失败')

    def show_cancelled(self, message: str) -> None:
        self.status_badge.set_state('已取消', 'warning')
        self.status_text.setText(message)
        self.progress_detail.setText('检测任务已取消')

    def set_running(self, running: bool) -> None:
        self.start_button.setEnabled(not running)
        self.cancel_button.setEnabled(running)
        for widget in self.input_controls:
            widget.setEnabled(not running)


class UpdateDialog(QtWidgets.QDialog):
    def __init__(self, info: video_update_backend.UpdateInfo, parent=None) -> None:
        super().__init__(parent)
        self.info = info
        self._downloaded_path: Path | None = None
        self._build_ui()

    def _build_ui(self) -> None:
        self.setWindowTitle('发现新版本')
        self.setMinimumWidth(480)
        self.setMaximumWidth(520)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        title = QtWidgets.QLabel(f'ShadowEncoder v{self.info.version}')
        title.setObjectName('PageTitle')
        layout.addWidget(title)

        date_label = QtWidgets.QLabel(f'发布日期: {self.info.release_date}')
        date_label.setObjectName('HintLabel')
        layout.addWidget(date_label)

        notes_label = QtWidgets.QLabel('更新内容:')
        notes_label.setObjectName('SectionTitle')
        layout.addWidget(notes_label)

        notes_edit = QtWidgets.QTextEdit()
        notes_edit.setReadOnly(True)
        notes_edit.setPlainText(self.info.release_notes)
        notes_edit.setMinimumHeight(120)
        notes_edit.setMaximumHeight(200)
        layout.addWidget(notes_edit)

        self.progress_bar = QtWidgets.QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)

        self.status_label = QtWidgets.QLabel('')
        self.status_label.setObjectName('HintLabel')
        layout.addWidget(self.status_label)

        btn_row = QtWidgets.QHBoxLayout()
        btn_row.addStretch()

        self.skip_btn = QtWidgets.QPushButton('稍后提醒')
        btn_row.addWidget(self.skip_btn)

        self.action_btn = QtWidgets.QPushButton('下载更新')
        self.action_btn.setObjectName('PrimaryButton')
        btn_row.addWidget(self.action_btn)
        layout.addLayout(btn_row)

        self.skip_btn.clicked.connect(self.reject)
        self.action_btn.clicked.connect(self._on_action)

    def _on_action(self) -> None:
        if self._downloaded_path is not None:
            self.status_label.setText('正在准备更新...')
            self._disable_buttons()
            video_update_backend.apply_update(self._downloaded_path)
            QtWidgets.QApplication.quit()
            return

        self.status_label.setText('正在下载...')
        self.progress_bar.setVisible(True)
        self.progress_bar.setValue(0)
        self._disable_buttons()

        self._thread = TaskThread(self._download_task, self)
        self._thread.log_line.connect(lambda msg: self.status_label.setText(msg))
        self._thread.progress_changed.connect(lambda val, _: self.progress_bar.setValue(val))
        self._thread.task_done.connect(self._on_download_done)
        self._thread.start()

    def _download_task(self, thread: TaskThread):
        return video_update_backend.download_update(
            self.info,
            progress_callback=lambda pct: thread.progress_changed.emit(pct, ''),
        )

    def _on_download_done(self, success: bool, result: object) -> None:
        if not success:
            error_text = result.get('error', '下载失败') if isinstance(result, dict) else '下载失败'
            self.status_label.setText(error_text)
            self._enable_buttons()
            self.action_btn.setText('重试下载')
            return

        self._downloaded_path = Path(str(result))
        self.progress_bar.setValue(100)
        self.status_label.setText('下载完成，可点击按钮重启更新。')
        self.action_btn.setText('重启并更新')
        self.action_btn.setEnabled(True)
        self.skip_btn.setText('取消')
        self.skip_btn.setEnabled(True)

    def _disable_buttons(self) -> None:
        self.action_btn.setEnabled(False)
        self.skip_btn.setEnabled(False)

    def _enable_buttons(self) -> None:
        self.action_btn.setEnabled(True)
        self.skip_btn.setEnabled(True)


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.active_thread: TaskThread | None = None
        self._update_info: video_update_backend.UpdateInfo | None = None
        self._build_ui()
        video_update_backend.cleanup_old_versions()
        QtCore.QTimer.singleShot(2000, self._startup_check_update)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        QtCore.QTimer.singleShot(100, self._sync_splitters)

    def _sync_splitters(self) -> None:
        for tab in (self.encode_tab, self.mix_tab, self.check_tab):
            if hasattr(tab, '_splitter'):
                tab._splitter.setSizes([430, 600])

    def _build_ui(self) -> None:
        self.setWindowTitle(f'ShadowEncoder v{video_update_backend.__version__}')
        self.resize(1260, 820)
        self.setWindowIcon(load_svg_icon())

        central = QtWidgets.QWidget()
        central_layout = QtWidgets.QVBoxLayout(central)
        central_layout.setContentsMargins(0, 0, 0, 0)
        central_layout.setSpacing(0)

        self.tabs = QtWidgets.QTabWidget()
        self.tabs.tabBar().setExpanding(True)
        self.tabs.tabBar().setFixedWidth(431)
        self.encode_tab = EncodeTab()
        self.mix_tab = MixTab()
        self.check_tab = CheckTab()
        self.tabs.addTab(self.encode_tab, '转码')
        self.tabs.addTab(self.mix_tab, '混音')
        self.tabs.addTab(self.check_tab, '检测')
        central_layout.addWidget(self.tabs, 1)
        self.setCentralWidget(central)

        self.encode_tab.start_button.clicked.connect(self.start_encode_task)
        self.encode_tab.cancel_button.clicked.connect(self.cancel_active_task)
        self.mix_tab.start_button.clicked.connect(self.start_mix_task)
        self.mix_tab.cancel_button.clicked.connect(self.cancel_active_task)
        self.check_tab.start_button.clicked.connect(self.start_check_task)
        self.check_tab.cancel_button.clicked.connect(self.cancel_active_task)

        status_bar = self.statusBar()
        status_bar.showMessage('就绪')

        self.update_btn = QtWidgets.QPushButton('检查更新')
        self.update_btn.setStyleSheet(
            'QPushButton { background: transparent; border: none; color: #a0a0a0; padding: 4px 8px; }'
            'QPushButton:hover { color: #e6e0e9; text-decoration: underline; }'
        )
        self.update_btn.clicked.connect(self._manual_check_update)
        status_bar.addPermanentWidget(self.update_btn)

        author_label = QtWidgets.QLabel('@繁星之子卡萨蒂亚')
        author_label.setStyleSheet('color:#cfcfcf; padding-left:12px;')
        status_bar.addPermanentWidget(author_label)

    def _startup_check_update(self) -> None:
        self._check_update(silent=True)

    def _manual_check_update(self) -> None:
        self._check_update(silent=False)

    def _check_update(self, silent: bool) -> None:
        self.update_btn.setEnabled(False)
        self.update_btn.setText('正在检查...')

        def task(thread: TaskThread):
            result = video_update_backend.check_update()
            if result is not None:
                self._update_info = result
            return result

        thread = TaskThread(task, self)
        thread.task_done.connect(lambda ok, res: self._on_check_done(ok, res, silent))
        thread.start()

    def _on_check_done(self, success: bool, result: object, silent: bool) -> None:
        self.update_btn.setEnabled(True)
        self.update_btn.setText('检查更新')

        if not success or result is None:
            if not silent:
                error_msg = result.get('error', '检查失败') if isinstance(result, dict) else '暂无更新'
                self.statusBar().showMessage(error_msg)
            return

        info = result
        self.statusBar().showMessage(f'发现新版本 v{info.version}')
        self.update_btn.setText(f'v{info.version} 可用')
        dialog = UpdateDialog(info, self)
        dialog.exec()

    def _set_busy(self, busy: bool, message: str) -> None:
        self.encode_tab.set_running(busy)
        self.mix_tab.set_running(busy)
        self.check_tab.set_running(busy)
        self.tabs.setTabEnabled(0, not busy or self.tabs.currentIndex() == 0)
        self.tabs.setTabEnabled(1, not busy or self.tabs.currentIndex() == 1)
        self.tabs.setTabEnabled(2, not busy or self.tabs.currentIndex() == 2)
        self.statusBar().showMessage(message)

    def _thread_finished(self) -> None:
        self.active_thread = None
        self._set_busy(False, '就绪')

    def cancel_active_task(self) -> None:
        if self.active_thread is None:
            return
        self.statusBar().showMessage('正在停止任务...')
        self.active_thread.cancel()

    def _ensure_input_paths(self, list_widget: FileListWidget) -> list[Path]:
        """Validate paths from a FileListWidget, return list of existing Paths."""
        raw_paths = list_widget.current_paths()
        if not raw_paths:
            QtWidgets.QMessageBox.warning(self, '缺少路径', '请先选择视频文件或目录。')
            return []

        paths: list[Path] = []
        for raw in raw_paths:
            p = Path(normalize_path(raw))
            if not p.exists():
                QtWidgets.QMessageBox.warning(self, '路径不存在', f'路径不存在:\n{p}')
                return []
            paths.append(p)
        return paths

    def _start_thread(self, thread: TaskThread, progress_handler, done_handler, busy_message: str) -> None:
        if self.active_thread is not None:
            QtWidgets.QMessageBox.warning(self, '任务进行中', '当前已有任务在运行，请等待其完成。')
            return

        self.active_thread = thread
        thread.progress_changed.connect(progress_handler)
        thread.task_done.connect(done_handler)
        thread.finished.connect(self._thread_finished)
        self._set_busy(True, busy_message)
        thread.start()

    def start_encode_task(self) -> None:
        input_paths = self._ensure_input_paths(self.encode_tab.input_edit)
        if not input_paths:
            return

        preset_index = int(self.encode_tab.preset_combo.currentData())
        unsharp_index = int(self.encode_tab.unsharp_combo.currentData())
        denoise_index = int(self.encode_tab.denoise_combo.currentData())
        tune_index = int(self.encode_tab.tune_combo.currentData())
        audio_only = self.encode_tab.audio_only_check.isChecked()
        loudnorm = self.encode_tab.loudnorm_check.isChecked()
        keep_resolution = self.encode_tab.keep_res_check.isChecked()

        preset_key = cfg_preset_list[preset_index][0][0]
        log_path = video_conv_backend.build_default_log_path(input_paths[0], preset_key)
        self.encode_tab.last_log_path = log_path
        self.encode_tab.open_log_button.setEnabled(True)
        self.encode_tab.reset_view()

        def task(thread: TaskThread):
            try:
                logger = GuiLogger(thread.log_line.emit, log_path)
            except Exception as init_err:
                thread.log_line.emit(f'<span style="color:#ff4d4d;">无法创建日志文件: {init_err}</span>')
                return {'ok': False, 'error': str(init_err)}
            try:
                logger.print('正在初始化转码环境...')
                video_conv_backend.ensure_runtime_binary()
                options = video_conv_backend.TranscodeOptions(
                    preset_index=preset_index,
                    unsharp_index=unsharp_index,
                    denoise_index=denoise_index,
                    tune_index=tune_index,
                    audio_only=audio_only,
                    loudnorm=loudnorm,
                    keep_resolution=keep_resolution,
                )
                logger.print(f'开始时间: {datetime.now().astimezone().isoformat()}')
                logger.print(f'输入路径 ({len(input_paths)} 个):')
                for p in input_paths:
                    logger.print(f'    {p}')
                logger.print(f'预设: {format_gui_preset_label(preset_index)}')
                logger.print(f'日志文件: {log_path}')

                total_success = 0
                total_fail = 0
                output_targets: list[Path] = []
                for input_path in input_paths:
                    if thread.is_cancelled():
                        break
                    sc, fc, ot = video_conv_backend.process_path(
                        input_path,
                        options,
                        output=logger.print,
                        progress_callback=lambda value, detail: thread.progress_changed.emit(value, detail),
                        cancel_callback=thread.is_cancelled,
                        process_callback=thread.set_current_process,
                    )
                    total_success += sc
                    total_fail += fc
                    output_targets.append(Path(ot) if ot else Path('.'))
                logger.print('转码完成!')
                logger.print(f'    成功: {total_success} 个文件')
                logger.print(f'    失败: {total_fail} 个文件')
                logger.print(f'输出位置: {output_targets[0] if output_targets else "."}')
                return {
                    'ok': total_fail == 0,
                    'success_count': total_success,
                    'fail_count': total_fail,
                    'output_target': str(output_targets[0]) if output_targets else '.',
                }
            finally:
                logger.print(f'日志已保存: {log_path}')
                logger.close()

        thread = TaskThread(task, self)
        thread.log_line.connect(self.encode_tab.append_log)
        self._start_thread(thread, self.encode_tab.update_progress, self._encode_done, '转码进行中...')

    def _encode_done(self, success: bool, result: object) -> None:
        if not success:
            error_text = result.get('error', '未知错误') if isinstance(result, dict) else '未知错误'
            self.encode_tab.show_error(error_text)
            self.statusBar().showMessage(f'转码失败: {error_text}')
            return

        if isinstance(result, dict) and result.get('cancelled'):
            message = result.get('message', '转码任务已取消。')
            self.encode_tab.show_cancelled(message)
            self.statusBar().showMessage(message)
            return

        ok = bool(result['ok'])
        self.encode_tab.show_success(result['success_count'], result['fail_count'], result['output_target'])
        summary = f'转码完成: 成功 {result["success_count"]}，失败 {result["fail_count"]}'
        self.statusBar().showMessage(summary)

    def start_mix_task(self) -> None:
        input_paths = self._ensure_input_paths(self.mix_tab.input_edit)
        if not input_paths:
            return

        loudnorm_on = self.mix_tab.loudnorm_check.isChecked()
        compand_on = self.mix_tab.compand_check.isChecked()
        if not loudnorm_on and not compand_on:
            QtWidgets.QMessageBox.warning(self, '未启用处理', '请至少启用响度标准化或动态压缩中的一个效果。')
            return

        options = video_mix_backend.MixOptions(
            loudnorm_enabled=loudnorm_on,
            loudnorm_i=float(self.mix_tab.loudnorm_i_spin.value()),
            loudnorm_tp=float(self.mix_tab.loudnorm_tp_spin.value()),
            loudnorm_lra=float(self.mix_tab.loudnorm_lra_spin.value()),
            compand_enabled=compand_on,
            compand_threshold=float(self.mix_tab.compand_threshold_spin.value()),
            compand_gain=float(self.mix_tab.compand_gain_spin.value()),
            output_suffix='_mix',
            audio_bitrate='320k',
        )

        log_path = video_mix_backend.build_default_log_path(input_paths[0])
        self.mix_tab.last_log_path = log_path
        self.mix_tab.open_log_button.setEnabled(True)
        self.mix_tab.reset_view()

        def task(thread: TaskThread):
            try:
                logger = GuiLogger(thread.log_line.emit, log_path)
            except Exception as init_err:
                thread.log_line.emit(f'<span style="color:#ff4d4d;">无法创建日志文件: {init_err}</span>')
                return {'ok': False, 'error': str(init_err)}
            try:
                logger.print('正在初始化混音环境...')
                video_mix_backend.ensure_runtime_binary()
                logger.print(f'开始时间: {datetime.now().astimezone().isoformat()}')
                logger.print(f'输入路径 ({len(input_paths)} 个):')
                for p in input_paths:
                    logger.print(f'    {p}')
                logger.print(f'日志文件: {log_path}')
                if options.loudnorm_enabled:
                    logger.print(f'响度标准化: I={options.loudnorm_i} LUFS, TP={options.loudnorm_tp} dBTP, LRA={options.loudnorm_lra} LU')
                if options.compand_enabled:
                    logger.print(f'动态压缩: 阈值={options.compand_threshold} dB, 增益={options.compand_gain} dB')
                total_success = 0
                total_fail = 0
                output_targets: list[Path] = []
                for input_path in input_paths:
                    if thread.is_cancelled():
                        break
                    sc, fc, ot = video_mix_backend.process_path(
                        input_path,
                        options,
                        output=logger.print,
                        progress_callback=lambda value, detail: thread.progress_changed.emit(value, detail),
                        cancel_callback=thread.is_cancelled,
                        process_callback=thread.set_current_process,
                    )
                    total_success += sc
                    total_fail += fc
                    output_targets.append(Path(ot) if ot else Path('.'))
                logger.print('混音完成!')
                logger.print(f'    成功: {total_success} 个文件')
                logger.print(f'    失败: {total_fail} 个文件')
                logger.print(f'输出位置: {output_targets[0] if output_targets else "."}')
                return {
                    'ok': total_fail == 0,
                    'success_count': total_success,
                    'fail_count': total_fail,
                    'output_target': str(output_targets[0]) if output_targets else '.',
                }
            finally:
                logger.print(f'日志已保存: {log_path}')
                logger.close()

        thread = TaskThread(task, self)
        thread.log_line.connect(self.mix_tab.append_log)
        self._start_thread(thread, self.mix_tab.update_progress, self._mix_done, '混音进行中...')

    def _mix_done(self, success: bool, result: object) -> None:
        if not success:
            error_text = result.get('error', '未知错误') if isinstance(result, dict) else '未知错误'
            self.mix_tab.show_error(error_text)
            self.statusBar().showMessage(f'混音失败: {error_text}')
            return

        if isinstance(result, dict) and result.get('cancelled'):
            message = result.get('message', '混音任务已取消。')
            self.mix_tab.show_cancelled(message)
            self.statusBar().showMessage(message)
            return

        ok = bool(result['ok'])
        self.mix_tab.show_success(result['success_count'], result['fail_count'], result['output_target'])
        summary = f'混音完成: 成功 {result["success_count"]}，失败 {result["fail_count"]}'
        self.statusBar().showMessage(summary)

    def start_check_task(self) -> None:
        input_paths = self._ensure_input_paths(self.check_tab.input_edit)
        if not input_paths:
            return

        options = video_check_backend.CheckOptions(
            preset_index=int(self.check_tab.preset_combo.currentData()),
            audio_only=self.check_tab.audio_only_check.isChecked(),
            recursive=self.check_tab.recursive_check.isChecked(),
            no_black_detect=not self.check_tab.black_detect_check.isChecked(),
            fps_tolerance=float(self.check_tab.fps_tolerance_spin.value()),
            video_bitrate_tolerance=float(self.check_tab.video_bitrate_spin.value()) / 100.0,
            audio_bitrate_tolerance=float(self.check_tab.audio_bitrate_spin.value()) / 100.0,
            black_min_duration=float(self.check_tab.black_min_spin.value()),
            ignore_edge_black=float(self.check_tab.ignore_edge_spin.value()),
        )

        spec = video_check_backend.build_expected_output_spec(
            preset_index=options.preset_index,
            audio_only=options.audio_only,
        )
        log_path = video_check_backend.build_default_log_path(input_paths[0], spec.preset_key)
        self.check_tab.last_log_path = log_path
        self.check_tab.open_log_button.setEnabled(True)
        self.check_tab.reset_view()

        def task(thread: TaskThread):
            try:
                logger = GuiLogger(thread.log_line.emit, log_path)
            except Exception as init_err:
                thread.log_line.emit(f'<span style="color:#ff4d4d;">无法创建日志文件: {init_err}</span>')
                return {'ok': False, 'error': str(init_err)}
            try:
                logger.print('正在初始化检测环境...')
                video_check_backend.ensure_runtime_binaries(options)
                logger.print(f'开始时间: {datetime.now().astimezone().isoformat()}')
                logger.print(f'输入路径 ({len(input_paths)} 个):')
                for p in input_paths:
                    logger.print(f'    {p}')
                logger.print(f'预设: {format_gui_preset_label(options.preset_index)}')
                logger.print(f'日志文件: {log_path}')
                aggregated = {'total': 0, 'passed': 0, 'failed': 0, 'warnings': 0}
                all_ok = True
                for input_path in input_paths:
                    if thread.is_cancelled():
                        break
                    exit_code, report = video_check_backend.run_check(
                        input_path,
                        options,
                        output=logger.print,
                        progress_callback=lambda value, detail: thread.progress_changed.emit(value, detail),
                        cancel_callback=thread.is_cancelled,
                        process_callback=thread.set_current_process,
                    )
                    if exit_code != 0:
                        all_ok = False
                    s = report.get('summary', {})
                    for key in aggregated:
                        aggregated[key] += s.get(key, 0)
                return {
                    'ok': all_ok,
                    'summary': aggregated,
                }
            finally:
                logger.print(f'日志已保存: {log_path}')
                logger.close()

        thread = TaskThread(task, self)
        thread.log_line.connect(self.check_tab.append_log)
        self._start_thread(thread, self.check_tab.update_progress, self._check_done, '检测进行中...')

    def _check_done(self, success: bool, result: object) -> None:
        if not success:
            error_text = result.get('error', '未知错误') if isinstance(result, dict) else '未知错误'
            self.check_tab.show_error(error_text)
            self.statusBar().showMessage(f'检测失败: {error_text}')
            return

        if isinstance(result, dict) and result.get('cancelled'):
            message = result.get('message', '检测任务已取消。')
            self.check_tab.show_cancelled(message)
            self.statusBar().showMessage(message)
            return

        summary = result.get('summary', {})
        self.check_tab.show_success(summary, bool(result.get('ok', False)))
        summary_text = f'检测完成: 通过 {summary.get("pass", 0)}，警告通过 {summary.get("pass_with_warnings", 0)}，失败 {summary.get("fail", 0)}'
        self.statusBar().showMessage(summary_text)


def main() -> int:
    apply_windows_app_id()
    app = QtWidgets.QApplication(sys.argv)
    app.setApplicationName('ShadowEncoder')
    icon = load_svg_icon()
    if not icon.isNull():
        app.setWindowIcon(icon)
    apply_dark_theme(app)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == '__main__':
    sys.exit(main())

