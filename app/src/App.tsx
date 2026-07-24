// ShadowEncoder 主框架 —— 左侧导航轨 + 三列工作区：共享素材 | 工具参数 | 结果
import React, { useState, useEffect } from "react";
import { EncodeTab, MixTab, CheckTab, AlphaTab, ScreenshotTab, ExportTab } from "./components/tabs";
import * as ui from "./components/ui";
import { ResizeHandle } from "./components/ResizeHandle";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { updateCheck, pickPath } from "./lib/ffmpeg";
import { FileListProvider, useFileList } from "./lib/fileListContext";
import { ColumnLayoutProvider, useColumnLayout } from "./lib/columnLayoutContext";
import {
  IconAlpha, IconCheckShield, IconClip, IconClose, IconEncode,
  IconGif, IconMix, IconShot, IconUpdate, IconWebp,
} from "./components/icons";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { muiTheme } from "./lib/muiTheme";
import appIcon from "./assets/icon.svg";

type TabDef = { key: string; label: string; desc: string; icon: React.ReactNode; Comp: React.ComponentType };

const NAV_GROUPS: { label: string; items: TabDef[] }[] = [
  {
    label: "批量",
    items: [
      { key: "encode", label: "转码", desc: "按预设参数批量转码，输出 _se.mp4", icon: <IconEncode size={20} />, Comp: EncodeTab },
      { key: "mix", label: "混音", desc: "EBU R128 响度标准化与动态压缩", icon: <IconMix size={20} />, Comp: MixTab },
      { key: "check", label: "检测", desc: "校验分辨率、帧率、黑帧等规格", icon: <IconCheckShield size={20} />, Comp: CheckTab },
    ],
  },
  {
    label: "工具",
    items: [
      { key: "alpha", label: "透明通道", desc: "上半 RGB + 下半 Alpha → ProRes 4444", icon: <IconAlpha size={20} />, Comp: AlphaTab },
      { key: "shot", label: "截图", desc: "按时间点与裁剪区域导出 PNG", icon: <IconShot size={20} />, Comp: ScreenshotTab },
      { key: "clip", label: "截取", desc: "按时间范围导出 MOV / MP4 片段", icon: <IconClip size={20} />, Comp: () => <ExportTab format="clip" /> },
      { key: "gif", label: "GIF", desc: "将片段导出为 GIF 动图", icon: <IconGif size={20} />, Comp: () => <ExportTab format="gif" /> },
      { key: "webp", label: "WebP", desc: "将片段导出为 WebP 动图", icon: <IconWebp size={20} />, Comp: () => <ExportTab format="webp" /> },
    ],
  },
];
const TABS: TabDef[] = NAV_GROUPS.flatMap((g) => g.items);

const APP_VERSION = "2.1.0";

function UpdateDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      setInfo(await updateCheck());
    } catch (e: any) {
      setInfo({ error: String(e?.message || e) });
    }
    setChecking(false);
  };
  useEffect(() => { check(); }, []);
  return (
    <div className="se-dialog-backdrop" onClick={onClose}>
      <div className="se-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="se-dialog-head">
          <span className="se-dialog-title">检查更新</span>
          <button className="se-dialog-close" onClick={onClose} title="关闭">
            <IconClose size={14} />
          </button>
        </div>
        <div className="se-dialog-body">
          <div className="se-hint-label">当前版本：v{APP_VERSION}</div>
          {info ? (
            info.error ? (
              <div className="se-warn-label">{info.error}</div>
            ) : (
              <div className="se-status-row">
                <ui.StatusBadge
                  text={info.update_available ? "有新版本" : "已是最新"}
                  tone={info.update_available ? "warning" : "success"}
                />
                <span className="se-status-text">{info.current_version}</span>
              </div>
            )
          ) : (
            <div className="se-hint-label">{checking ? "正在检查更新..." : "点击检查更新"}</div>
          )}
          {info && !info.error && info.notes ? (
            <div className="se-hint-label">{info.notes}</div>
          ) : null}
        </div>
        <div className="se-dialog-foot">
          <button onClick={check} disabled={checking}>重新检查</button>
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function SharedFilesColumn() {
  const fl = useFileList();

  const onPickFile = async () => {
    const p = await pickPath("file");
    if (p) fl.addPaths(p.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  };
  const onPickDir = async () => {
    const p = await pickPath("dir");
    if (p) {
      const dir = !p.endsWith("\\") && !p.endsWith("/") ? p + "\\" : p;
      fl.addPaths([dir]);
    }
  };

  return (
    <ui.SharedFilePanel
      paths={fl.paths}
      selected={fl.selected}
      activePath={fl.activePath}
      onDrop={fl.addPaths}
      onToggleSelect={fl.toggleSelect}
      onActivate={fl.setActivePath}
      onRemove={fl.removePath}
      onClear={fl.clear}
      onSelectAll={fl.selectAll}
      onClearSelection={fl.clearSelection}
      onPickFile={onPickFile}
      onPickDir={onPickDir}
    />
  );
}

function AppShell() {
  const [tab, setTab] = useState(0);
  const [updateOpen, setUpdateOpen] = useState(false);
  const { wFiles, resizeFiles } = useColumnLayout();
  const fl = useFileList();

  useEffect(() => {
    try {
      getCurrentWindow().setTitle(`ShadowEncoder v${APP_VERSION}`);
    } catch {
      // 浏览器直开 Vite 时无 Tauri 运行时，忽略
    }
  }, []);

  const Current = TABS[tab].Comp;
  const activeName = fl.activePath ? fl.activePath.split(/[/\\]/).filter(Boolean).pop() : "";

  return (
    <div className="se-app">
      {/* 左侧功能导航轨 */}
      <nav className="se-rail">
        <div className="se-rail-brand" title={`ShadowEncoder v${APP_VERSION}`}>
          <img className="se-rail-brand-icon" src={appIcon} alt="ShadowEncoder" />
        </div>
        <div className="se-rail-nav">
          {NAV_GROUPS.map((g) => (
            <div className="se-rail-group" key={g.label}>
              <div className="se-rail-group-label">{g.label}</div>
              {g.items.map((t) => {
                const i = TABS.indexOf(t);
                return (
                  <button
                    key={t.key}
                    className={`se-rail-item${i === tab ? " active" : ""}`}
                    onClick={() => setTab(i)}
                    title={`${t.label} — ${t.desc}`}
                  >
                    {t.icon}
                    <span className="se-rail-label">{t.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="se-rail-foot">
          <button className="se-rail-item" onClick={() => setUpdateOpen(true)} title="检查更新">
            <IconUpdate size={18} />
            <span className="se-rail-label">更新</span>
          </button>
          <span className="se-rail-version">v{APP_VERSION}</span>
        </div>
      </nav>

      {/* 主区：工作区 + 状态栏 */}
      <div className="se-main">
        <div className="se-body">
          <div
            className="se-col-files"
            style={{ flex: `0 0 ${wFiles}px`, width: wFiles, minWidth: wFiles }}
          >
            <SharedFilesColumn />
          </div>
          <ResizeHandle onDelta={resizeFiles} />
          <div className="se-col-tool">
            <Current />
          </div>
        </div>

        <div className="se-statusbar">
          <span className="se-status-live">
            <span className="se-status-dot" aria-hidden />
            就绪
          </span>
          <span className="grow">
            素材 {fl.paths.length} · 已勾选 {fl.selected.size}
            {activeName ? ` · 预览 ${activeName}` : ""}
          </span>
          <span className="author">@繁星之子卡萨蒂亚</span>
        </div>
      </div>

      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <FileListProvider>
        <ColumnLayoutProvider>
          <AppShell />
        </ColumnLayoutProvider>
      </FileListProvider>
    </ThemeProvider>
  );
}
