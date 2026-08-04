// ShadowEncoder 主框架 —— 左侧导航轨 + 三列工作区：共享素材 | 工具参数 | 结果
import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EncodeTab, MixTab, CheckTab, AlphaTab, ScreenshotTab, ExportTab, TaskRunnerProvider, useTaskRunner } from "./components/tabs";
import { DitBackupTab, DitWorkflowTab } from "./components/DitTabs";
import { MediaPickerDialog } from "./components/MediaPickerDialog";
import * as ui from "./components/ui";
import { ResizeHandle } from "./components/ResizeHandle";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { updateCheck, openPath, openUrl } from "./lib/ffmpeg";
import { FileListProvider, useFileList } from "./lib/fileListContext";
import { isAudioVisualPath, isVideoPath } from "./lib/mediaExtensions";
import { ColumnLayoutProvider, useColumnLayout } from "./lib/columnLayoutContext";
import { PresetStoreProvider } from "./components/presetSystem";
import {
  IconAlpha, IconCheckShield, IconClip, IconClose, IconCopy, IconEncode,
  IconExport, IconFolder, IconGif, IconList, IconMix, IconSettings, IconShot, IconUpdate, IconWebp,
} from "./components/icons";
import { AppThemeProvider, useAppTheme } from "./lib/AppThemeProvider";
import { normalizeThemeAccent } from "./lib/themeAccent";
import type { ThemePreference } from "./lib/themePreference";
import {
  cancelAgentTask,
  getAgentSnapshot,
  subscribeAgentStateChanged,
  updateAgentTask,
  type AgentTaskSnapshot,
} from "./lib/agentApi";
import { waitForAgentTaskHandler } from "./lib/agentTaskBridge";
import appIcon from "./assets/icon.svg";
import { useModalLayerRegistration } from "./lib/modalLayer";

type TabDef = {
  key: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  Comp: React.ComponentType;
  acceptsFile?: (path: string) => boolean;
};

const NAV_GROUPS: { label: string; items: TabDef[] }[] = [
  {
    label: "批量",
    items: [
      { key: "encode", label: "转码", desc: "按预设参数批量转码，自动避开同名文件", icon: <IconEncode size={20} />, Comp: EncodeTab, acceptsFile: isAudioVisualPath },
      { key: "mix", label: "混音", desc: "EBU R128 响度标准化与动态压缩", icon: <IconMix size={20} />, Comp: MixTab, acceptsFile: isAudioVisualPath },
      { key: "check", label: "检测", desc: "校验分辨率、帧率、黑帧等规格", icon: <IconCheckShield size={20} />, Comp: CheckTab, acceptsFile: isVideoPath },
    ],
  },
  {
    label: "工具",
    items: [
      { key: "alpha", label: "透明通道", desc: "上半 RGB + 下半 Alpha → ProRes 4444", icon: <IconAlpha size={20} />, Comp: AlphaTab, acceptsFile: isVideoPath },
      { key: "shot", label: "截图", desc: "按时间点与裁剪区域导出图片", icon: <IconShot size={20} />, Comp: ScreenshotTab, acceptsFile: isVideoPath },
      { key: "sequence", label: "序列帧", desc: "按时间范围导出 JPEG、PNG 等图片序列", icon: <IconCopy size={20} />, Comp: () => <ExportTab format="sequence" />, acceptsFile: isVideoPath },
      { key: "clip", label: "截取", desc: "按时间范围导出 MOV / MP4 片段", icon: <IconClip size={20} />, Comp: () => <ExportTab format="clip" />, acceptsFile: isVideoPath },
      { key: "gif", label: "GIF", desc: "将片段导出为 GIF 动图", icon: <IconGif size={20} />, Comp: () => <ExportTab format="gif" />, acceptsFile: isVideoPath },
      { key: "webp", label: "WebP", desc: "将片段导出为 WebP 动图", icon: <IconWebp size={20} />, Comp: () => <ExportTab format="webp" />, acceptsFile: isVideoPath },
    ],
  },
  {
    label: "DIT",
    items: [
      { key: "dit-backup", label: "备份", desc: "多目标素材备份、移动与 MD5 完整性校验", icon: <IconFolder size={20} />, Comp: DitBackupTab },
      { key: "dit-workflow", label: "流程", desc: "串行编排备份、转码、混音与检测", icon: <IconList size={20} />, Comp: DitWorkflowTab },
    ],
  },
];
const TABS: TabDef[] = NAV_GROUPS.flatMap((g) => g.items);

const AGENT_TASK_TAB: Record<AgentTaskSnapshot['function'], string> = {
  encode: 'encode',
  mix: 'mix',
  check: 'check',
  alpha: 'alpha',
  backup: 'dit-backup',
  workflow: 'dit-workflow',
};

const AGENT_TASK_LABEL: Record<AgentTaskSnapshot['function'], string> = {
  encode: '转码',
  mix: '混音',
  check: '检测',
  alpha: '透明通道',
  backup: '备份',
  workflow: '流程',
};

const APP_VERSION = "2.2.2";
const PROJECT_GITHUB_URL = "https://github.com/AngleNaris/shadowencoder";

const THEME_ACCENT_OPTIONS = [
  { value: '#6d5da5', label: '默认紫' },
  { value: '#3578a8', label: '冷蓝' },
  { value: '#23858c', label: '青绿' },
  { value: '#3f7f5f', label: '松绿' },
  { value: '#9b6a2f', label: '琥珀' },
  { value: '#a24f63', label: '玫红' },
] as const;

type UpdateCheckInfo = {
  current_version?: string;
  latest_version?: string;
  update_available?: boolean;
  notes?: string;
  release_url?: string;
  error?: string;
};

function BrandRayField() {
  return (
    <span className="se-brand-rays" aria-hidden="true">
      {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
    </span>
  );
}

function UpdateDialog({ onClose }: { onClose: () => void }) {
  useModalLayerRegistration();
  const [info, setInfo] = useState<UpdateCheckInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setInfo(await updateCheck() as UpdateCheckInfo);
    } catch (e: any) {
      setInfo({ error: String(e?.message || e) });
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => { void check(); }, [check]);

  const statusTone = checking ? "running" : info?.error
    ? "error"
    : info?.update_available ? "warning" : "success";
  const statusBadge = checking ? "检查中" : info?.error
    ? "检查失败"
    : info?.update_available ? "有新版本" : "已是最新";
  const statusTitle = checking ? "正在检查更新" : info?.error
    ? "暂时无法完成检查"
    : info?.update_available ? "发现可用更新" : "当前已是最新版本";
  const statusDetail = checking ? "正在连接更新服务，请稍候"
    : info?.error ? "请稍后重新检查"
    : info?.update_available ? "可以前往项目仓库查看最新发布" : "当前安装版本无需更新";
  const displayedVersion = (info?.update_available ? info.latest_version : info?.current_version) || APP_VERSION;
  const repositoryUrl = info?.release_url || PROJECT_GITHUB_URL;

  return (
    <div className="se-dialog-backdrop" onClick={onClose}>
      <div className="se-dialog se-update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="se-dialog-head">
          <span className="se-dialog-title">应用更新</span>
          <button className="se-dialog-close" onClick={onClose} title="关闭">
            <IconClose size={14} />
          </button>
        </div>
        <div className="se-dialog-body">
          <div className="se-update-identity">
            <span className="se-update-logo-mark">
              <BrandRayField />
              <img className="se-update-logo" src={appIcon} alt="ShadowEncoder" />
            </span>
            <div className="se-update-identity-copy">
              <strong>ShadowEncoder</strong>
              <span>版本 v{APP_VERSION}</span>
            </div>
          </div>

          <div className="se-update-status">
            <div className="se-update-status-copy">
              <span className="se-update-status-label">版本状态</span>
              <strong>{statusTitle}</strong>
              <span>{statusDetail}</span>
            </div>
            <div className="se-update-status-meta">
              <ui.StatusBadge text={statusBadge} tone={statusTone} />
              <span className="se-update-version">v{displayedVersion}</span>
            </div>
          </div>

          <ui.AnimatedHeight>
            {info?.error && !checking ? (
              <div className="se-update-message is-error">{info.error}</div>
            ) : null}
            {info?.notes && !info.error && !checking ? (
              <div className="se-update-message">
                <span>更新说明</span>
                <p>{info.notes}</p>
              </div>
            ) : null}
          </ui.AnimatedHeight>

          <button
            type="button"
            className="se-update-repository"
            title="打开 ShadowEncoder GitHub 仓库"
            onClick={() => {
              void openUrl(repositoryUrl).catch((error) => {
                setInfo((current) => ({
                  ...current,
                  error: String(error?.message || error),
                }));
              });
            }}
          >
            <span>项目仓库</span>
            <strong>github.com/AngleNaris/shadowencoder</strong>
            <IconExport size={14} />
          </button>
        </div>
        <div className="se-dialog-foot">
          <ui.Button icon={<IconUpdate size={14} />} onClick={() => { void check(); }} disabled={checking}>
            重新检查
          </ui.Button>
          <ui.Button primary icon={<IconClose size={14} />} onClick={onClose}>
            关闭
          </ui.Button>
        </div>
      </div>
    </div>
  );
}

function AppSettingsDialog({
  preference,
  highContrast,
  accentColor,
  onPreferenceChange,
  onHighContrastChange,
  onAccentColorChange,
  onClose,
}: {
  preference: ThemePreference;
  highContrast: boolean;
  accentColor: string;
  onPreferenceChange: (preference: ThemePreference) => void;
  onHighContrastChange: (enabled: boolean) => void;
  onAccentColorChange: (accent: string) => void;
  onClose: () => void;
}) {
  useModalLayerRegistration();
  const [accentDraft, setAccentDraft] = useState(accentColor.toUpperCase());
  useEffect(() => setAccentDraft(accentColor.toUpperCase()), [accentColor]);
  const options: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: '跟随系统' },
    { value: 'dark', label: '深色' },
    { value: 'light', label: '浅色' },
  ];
  const commitAccent = (value: string) => {
    const normalized = normalizeThemeAccent(value);
    if (!normalized) return;
    setAccentDraft(normalized.toUpperCase());
    onAccentColorChange(normalized);
  };

  return (
    <div className="se-dialog-backdrop" onClick={onClose}>
      <div className="se-dialog se-settings-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="se-dialog-head">
          <span className="se-dialog-title">应用设置</span>
          <button className="se-dialog-close" onClick={onClose} title="关闭">
            <IconClose size={14} />
          </button>
        </div>
        <div className="se-dialog-body">
          <section className="se-settings-section">
            <div className="se-settings-section-head">
              <strong>外观模式</strong>
            </div>
            <div className="se-settings-theme-options" role="radiogroup" aria-label="应用主题">
              {options.map((option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={preference === option.value}
                  key={option.value}
                  className={preference === option.value ? 'is-active' : undefined}
                  onClick={() => onPreferenceChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="se-settings-section">
            <div className="se-settings-section-head">
              <strong>主题色</strong>
            </div>
            <div className="se-settings-accent-row">
              <div className="se-settings-swatches" aria-label="预设主题色">
                {THEME_ACCENT_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    className={`se-settings-swatch${accentColor === option.value ? ' is-active' : ''}`}
                    style={{ '--swatch-color': option.value } as React.CSSProperties}
                    onClick={() => commitAccent(option.value)}
                    title={option.label}
                    aria-label={option.label}
                    aria-pressed={accentColor === option.value}
                  />
                ))}
                <label className="se-settings-color-picker" title="选择自定义颜色">
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(event) => commitAccent(event.target.value)}
                    aria-label="选择自定义主题色"
                  />
                  <span style={{ '--swatch-color': accentColor } as React.CSSProperties} />
                </label>
              </div>
              <input
                className="se-settings-hex-input"
                value={accentDraft}
                maxLength={7}
                spellCheck={false}
                aria-label="主题色十六进制值"
                onChange={(event) => {
                  const value = event.target.value;
                  setAccentDraft(value.toUpperCase());
                  const normalized = normalizeThemeAccent(value);
                  if (normalized) onAccentColorChange(normalized);
                }}
                onBlur={() => setAccentDraft(accentColor.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </div>
          </section>

          <section className="se-settings-section se-settings-display-section">
            <div className="se-settings-section-head">
              <strong>辅助显示</strong>
            </div>
            <div className="se-settings-contrast-option">
              <ui.Checkbox checked={highContrast} onChange={onHighContrastChange}>
                高对比度
              </ui.Checkbox>
            </div>
          </section>
        </div>
        <div className="se-dialog-foot">
          <ui.Button icon={<IconClose size={14} />} onClick={onClose}>关闭</ui.Button>
        </div>
      </div>
    </div>
  );
}

function SharedFilesColumn({ disabled = false, acceptsFile }: {
  disabled?: boolean;
  acceptsFile?: (path: string) => boolean;
}) {
  const fl = useFileList();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <ui.SharedFilePanel
        items={fl.items}
        totalCount={fl.totalCount}
        activePath={fl.activePath}
        onDrop={fl.addPaths}
        onToggleSelect={fl.toggleSelect}
        onToggleExpanded={fl.toggleExpanded}
        onActivate={fl.setActivePath}
        onOpen={(path) => { void openPath(path).catch((error) => console.error('打开文件失败', error)); }}
        onRemove={fl.removePath}
        onClear={fl.clear}
        onSelectAll={fl.selectAll}
        onPick={() => setPickerOpen(true)}
        acceptsFile={acceptsFile}
        disabled={disabled}
      />
      <MediaPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={fl.addPaths}
      />
    </>
  );
}

function AppShell() {
  const [tab, setTab] = useState(0);
  const renderedTab = useDeferredValue(tab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const {
    preference: themePreference,
    highContrast,
    accentColor,
    setPreference: setThemePreference,
    setHighContrast,
    setAccentColor,
  } = useAppTheme();
  const [agentTaskState, setAgentTaskState] = useState<AgentTaskSnapshot | null>(null);
  const [activeAgentTaskId, setActiveAgentTaskId] = useState<string | null>(null);
  const { wFiles, resizeFiles } = useColumnLayout();
  const fl = useFileList();
  const task = useTaskRunner();
  const taskRef = useRef(task);
  const activeAgentTaskRef = useRef<string | null>(null);
  const claimedAgentTasksRef = useRef(new Set<string>());
  const cancelRequestedRef = useRef(new Set<string>());
  const terminalizingAgentTasksRef = useRef(new Set<string>());
  const progressUpdateRef = useRef({ progress: 0, detail: '' });
  const progressTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const progressWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastAgentProgressRef = useRef({ taskId: '', progress: 0 });
  const railNavRef = useRef<HTMLDivElement | null>(null);

  // 与参数列同一套滚动条测量：滚动条宽度写入 --se-scrollbar-width，
  // 滚动条吃掉右侧 4px 时左侧补回同宽，导航项保持与底部按钮对齐居中
  useLayoutEffect(() => {
    const element = railNavRef.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const scrollbarWidth = Math.max(0, Math.min(12, element.offsetWidth - element.clientWidth));
      element.style.setProperty('--se-scrollbar-width', `${scrollbarWidth}px`);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(element);
    measure();
    return () => {
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  taskRef.current = task;

  const switchTab = useCallback((targetTab: number) => {
    if (taskRef.current.running) return;
    setTab((currentTab) => currentTab === targetTab ? currentTab : targetTab);
  }, []);

  const refreshAgentTaskState = useCallback(async () => {
    try {
      const snapshot = await getAgentSnapshot();
      const current = snapshot.tasks.find((item) => (
        item.status === 'requested'
        || item.status === 'running'
        || item.status === 'cancel_requested'
      )) ?? null;
      setAgentTaskState(current);
    } catch (error) {
      // 浏览器预览模式或服务尚未完成初始化时不影响普通 GUI 使用。
      if (import.meta.env.DEV) console.debug('Agent 状态暂不可用', error);
    }
  }, []);

  useEffect(() => {
    try {
      getCurrentWindow().setTitle(`ShadowEncoder v${APP_VERSION}`);
    } catch {
      // 浏览器直开 Vite 时无 Tauri 运行时，忽略
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void refreshAgentTaskState();
    void subscribeAgentStateChanged(() => {
      if (!disposed) void refreshAgentTaskState();
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshAgentTaskState]);

  useEffect(() => {
    const current = agentTaskState;
    if (!current) return;

    if (current.status === 'cancel_requested') {
      cancelRequestedRef.current.add(current.id);
      if (activeAgentTaskRef.current === current.id) {
        void task.cancel();
      } else if (!claimedAgentTasksRef.current.has(current.id)) {
        claimedAgentTasksRef.current.add(current.id);
        void updateAgentTask(current.id, {
          status: 'canceled',
          progress: current.progress,
          detail: '任务在开始前已取消',
          outputPaths: [],
        }).catch((error) => console.error('回写 Agent 取消状态失败', error));
      }
      return;
    }

    if (current.status === 'running' && activeAgentTaskRef.current !== current.id) {
      if (claimedAgentTasksRef.current.has(current.id)) return;
      claimedAgentTasksRef.current.add(current.id);
      void updateAgentTask(current.id, {
        status: 'failed',
        progress: current.progress,
        detail: '应用已重启，无法恢复此前的运行中任务',
        outputPaths: [],
        error: '应用已重启，无法恢复此前的运行中任务',
      }).catch((error) => console.error('清理失效 Agent 任务失败', error));
      return;
    }

    if (current.status !== 'requested'
      || task.running
      || activeAgentTaskRef.current
      || claimedAgentTasksRef.current.has(current.id)) {
      return;
    }

    claimedAgentTasksRef.current.add(current.id);
    activeAgentTaskRef.current = current.id;
    lastAgentProgressRef.current = { taskId: current.id, progress: 0 };
    setActiveAgentTaskId(current.id);
    const targetTab = TABS.findIndex((item) => item.key === AGENT_TASK_TAB[current.function]);
    if (targetTab >= 0) setTab(targetTab);

    void (async () => {
      try {
        await updateAgentTask(current.id, {
          status: 'running',
          progress: 0,
          detail: `Agent 正在启动${AGENT_TASK_LABEL[current.function]}任务`,
          outputPaths: [],
        });
        const handler = await waitForAgentTaskHandler(current.function);
        if (cancelRequestedRef.current.has(current.id)) {
          await updateAgentTask(current.id, {
            status: 'canceled',
            progress: 0,
            detail: '任务在开始前已取消',
            outputPaths: [],
          });
          return;
        }

        const outcome = await handler(current);
        terminalizingAgentTasksRef.current.add(current.id);
        if (progressTimerRef.current) {
          globalThis.clearTimeout(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        await progressWriteQueueRef.current;
        if (outcome.status === 'completed') {
          await updateAgentTask(current.id, {
            status: 'completed',
            progress: 100,
            detail: outcome.value.detail,
            outputPaths: outcome.value.outputPaths,
          });
        } else if (outcome.status === 'canceled' || cancelRequestedRef.current.has(current.id)) {
          await updateAgentTask(current.id, {
            status: 'canceled',
            progress: taskRef.current.progress,
            detail: '任务已取消',
            outputPaths: [],
          });
        } else {
          await updateAgentTask(current.id, {
            status: 'failed',
            progress: taskRef.current.progress,
            detail: '任务失败',
            outputPaths: [],
            error: outcome.error,
          });
        }
      } catch (error: any) {
        const message = String(error?.message || error);
        try {
          const snapshot = await getAgentSnapshot();
          const latest = snapshot.tasks.find((item) => item.id === current.id);
          const canceled = latest?.status === 'cancel_requested'
            || cancelRequestedRef.current.has(current.id);
          await updateAgentTask(current.id, canceled ? {
            status: 'canceled',
            progress: latest?.progress ?? taskRef.current.progress,
            detail: '任务已取消',
            outputPaths: [],
          } : {
            status: 'failed',
            progress: latest?.progress ?? taskRef.current.progress,
            detail: '任务启动失败',
            outputPaths: [],
            error: message,
          });
        } catch (updateError) {
          console.error('回写 Agent 任务终态失败', updateError);
        }
      } finally {
        terminalizingAgentTasksRef.current.delete(current.id);
        cancelRequestedRef.current.delete(current.id);
        if (activeAgentTaskRef.current === current.id) activeAgentTaskRef.current = null;
        setActiveAgentTaskId((value) => value === current.id ? null : value);
        void refreshAgentTaskState();
      }
    })();
  }, [agentTaskState, refreshAgentTaskState, task.cancel, task.running]);

  useEffect(() => {
    const taskId = activeAgentTaskRef.current;
    if (!taskId || !task.running || !task.isCancelled() || cancelRequestedRef.current.has(taskId)) return;
    cancelRequestedRef.current.add(taskId);
    void cancelAgentTask(taskId).catch((error) => {
      console.error('同步 Agent 取消请求失败', error);
    });
  }, [activeAgentTaskId, task.detail, task.isCancelled, task.running]);

  useEffect(() => {
    if (!activeAgentTaskId || !task.running) return;
    progressUpdateRef.current = {
      progress: Math.max(0, Math.min(100, task.progress)),
      detail: task.detail,
    };
    if (progressTimerRef.current) return;
    progressTimerRef.current = globalThis.setTimeout(() => {
      progressTimerRef.current = null;
      const taskId = activeAgentTaskRef.current;
      if (!taskId
        || cancelRequestedRef.current.has(taskId)
        || terminalizingAgentTasksRef.current.has(taskId)) return;
      const update = progressUpdateRef.current;
      const previous = lastAgentProgressRef.current.taskId === taskId
        ? lastAgentProgressRef.current.progress
        : 0;
      const progress = Math.max(previous, update.progress);
      lastAgentProgressRef.current = { taskId, progress };
      progressWriteQueueRef.current = progressWriteQueueRef.current.then(async () => {
        if (activeAgentTaskRef.current !== taskId
          || cancelRequestedRef.current.has(taskId)
          || terminalizingAgentTasksRef.current.has(taskId)) return;
        await updateAgentTask(taskId, {
          status: 'running',
          progress,
          detail: update.detail,
        });
      }).catch((error) => console.error('回写 Agent 任务进度失败', error));
    }, 350);
  }, [activeAgentTaskId, task.detail, task.progress, task.running]);

  useEffect(() => () => {
    if (progressTimerRef.current) globalThis.clearTimeout(progressTimerRef.current);
  }, []);

  const Current = TABS[renderedTab].Comp;
  return (
    <div className="se-app-frame">
      <div className={`se-app${task.running ? ' is-task-running' : ''}`} aria-busy={task.running}>
      {/* 左侧功能导航轨 */}
      <nav className="se-rail">
        <button
          type="button"
          className="se-rail-brand"
          onClick={openSettings}
          title="应用设置"
          aria-label="打开应用设置"
        >
          <span className="se-rail-brand-mark">
            <BrandRayField />
            <img className="se-rail-brand-icon" src={appIcon} alt="" />
          </span>
        </button>
        <div className="se-rail-nav" ref={railNavRef}>
          {NAV_GROUPS.map((g) => (
            <div className="se-rail-group" key={g.label}>
              <div className="se-rail-group-label">{g.label}</div>
              {g.items.map((t) => {
                const i = TABS.indexOf(t);
                return (
                  <button
                    key={t.key}
                    className={`se-rail-item${i === tab ? " active" : ""}`}
                    onClick={() => switchTab(i)}
                    title={`${t.label} — ${t.desc}`}
                    disabled={task.running}
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
          <button className="se-rail-item" onClick={() => setUpdateOpen(true)} title="检查更新" disabled={task.running}>
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
            <SharedFilesColumn disabled={task.running} acceptsFile={TABS[renderedTab].acceptsFile} />
          </div>
          <ResizeHandle onDelta={resizeFiles} />
          <div className="se-col-tool">
            <Current />
          </div>
        </div>

        <div className="se-statusbar">
          <span className="se-status-live">
            <span className="se-status-dot" aria-hidden />
            <span className="se-status-live-copy" title={agentTaskState?.detail || (task.running ? task.detail : '就绪')}>
              {agentTaskState
                ? `Agent · ${AGENT_TASK_LABEL[agentTaskState.function]} · ${agentTaskState.detail}`
                : task.running ? task.detail : '就绪'}
            </span>
          </span>
          <span className="grow">
            素材 {fl.totalCount} · 已勾选 {fl.selectedCount}
          </span>
          <span className="author">@繁星之子卡萨蒂亚</span>
        </div>
      </div>

        {settingsOpen && (
          <AppSettingsDialog
            preference={themePreference}
            highContrast={highContrast}
            accentColor={accentColor}
            onPreferenceChange={setThemePreference}
            onHighContrastChange={setHighContrast}
            onAccentColorChange={setAccentColor}
            onClose={closeSettings}
          />
        )}
        {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
      </div>

    </div>
  );
}

export function App() {
  return (
    <AppThemeProvider>
      <FileListProvider>
        <PresetStoreProvider>
          <ColumnLayoutProvider>
            <TaskRunnerProvider>
              <AppShell />
            </TaskRunnerProvider>
          </ColumnLayoutProvider>
        </PresetStoreProvider>
      </FileListProvider>
    </AppThemeProvider>
  );
}
