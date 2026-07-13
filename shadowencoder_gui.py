# -*- coding: utf-8 -*-
"""ShadowEncoder —— video_check(ShadowEncoder) 与 AlphaVideoTool 合并后的统一 GUI。

设计要点：
- 继承 ``video_tool_gui.MainWindow``：它自带「转码 / 混音 / 检测」三个标签页、任务编排、
  在线更新检查，以及 ShadowEncoder 的窗口标题与图标（名称、图标均继承 video_check）。
- 追加 AlphaVideoTool 的 5 个*自包含*标签页：合成透明通道 / 截图 / 截取视频 /
  导出GIF / 导出WebP（这些标签页自行管理任务线程与按钮）。
"""
from __future__ import annotations

import sys

from PySide6 import QtWidgets

import video_tool_gui as vc
import alpha_video_tool_gui as av


class MainWindow(vc.MainWindow):
    """统一主窗口：ShadowEncoder 原生功能 + AlphaVideoTool 透明通道工具。"""

    def __init__(self) -> None:
        # 父类会构建 转码/混音/检测 标签页、连接信号、设置 ShadowEncoder 标题与图标，
        # 并注册在线更新检查（启动时静默检查 + 状态栏「检查更新」按钮）。
        super().__init__()

        # 解除父类对 tabBar 的固定宽度限制（原按 3 个标签设定 431px），适配 8 个标签。
        bar = self.tabs.tabBar()
        bar.setMinimumWidth(0)
        bar.setMaximumWidth(16777215)
        bar.setSizePolicy(QtWidgets.QSizePolicy.Minimum, QtWidgets.QSizePolicy.Preferred)

        # ── 追加 AlphaVideoTool 的自包含标签页 ──
        self.alpha_tab = av.AlphaTab()
        self.screenshot_tab = av.ScreenshotTab()
        self.clip_tab = av.ClipTab()
        self.gif_tab = av.GifTab()
        self.webp_tab = av.WebpTab()

        self.tabs.addTab(self.alpha_tab, '合成透明通道')
        self.tabs.addTab(self.screenshot_tab, '截图')
        self.tabs.addTab(self.clip_tab, '截取视频')
        self.tabs.addTab(self.gif_tab, '导出GIF')
        self.tabs.addTab(self.webp_tab, '导出WebP')


def main() -> int:
    vc.apply_windows_app_id()

    app = QtWidgets.QApplication(sys.argv)
    # 使用 ShadowEncoder 的暗色主题（与 AlphaVideoTool 配色一致）。
    vc.apply_dark_theme(app)

    window = MainWindow()
    window.show()

    return app.exec()


if __name__ == '__main__':
    sys.exit(main())
