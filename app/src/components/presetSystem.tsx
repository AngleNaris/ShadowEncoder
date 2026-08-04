// 统一预设系统：所有功能（转码/混音/检测/截图/截取/GIF/WebP）共享的预设管理能力
// 提供：类型与内存 store、各功能的参数 schema、schema 驱动的通用预设构建器、
// 美观的"当前预设"卡片、以及可嵌入任意 Tab 的 PresetManager（下拉+新建+导出+卡片）。
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import * as ui from './ui';
import { IconClose, IconCheckShield, IconPlus, IconExport, IconImport, IconTrash, IconCopy, IconSettings } from './icons';
import { useModalLayerRegistration } from '../lib/modalLayer';
import {
  DEFAULT_OUTPUT_FORM,
  OUTPUT_PRESET_FIELDS,
  OUTPUT_PRESET_KEYS,
  OutputLocationGroup,
  describeOutputSettings,
} from './OutputSettings';
import { DEFAULT_EXPORT_DIMENSIONS } from '../lib/outputDimensions';
import {
  isPresetUiFieldDisabled,
  isPresetUiFieldVisible,
  type SharedPresetUiType,
} from '../lib/presetUiRules';
import {
  normalizeWorkflowDefinition,
  workflowNodeCounts,
} from '../lib/workflow';
import {
  PRESET_STORAGE_KEY,
  clonePresets,
  createPresetId as genId,
  emptyPresetStore,
  loadPresetStore,
  serializePresetStore,
  type Preset,
  type PresetStore,
  type PresetType,
} from '../lib/presetStorage';
import {
  getAgentSnapshot,
  isAgentRevisionConflict,
  migrateAgentPresets,
  replaceAgentPresetType,
  subscribeAgentStateChanged,
  type AgentSnapshot,
} from '../lib/agentApi';
import { isTauriRuntime } from '../lib/ffmpeg';

export type { Preset, PresetType } from '../lib/presetStorage';

export const TYPE_LABEL: Record<PresetType, string> = {
  encode: '转码',
  mix: '混音',
  check: '检测',
  alpha: '透明通道',
  screenshot: '截图',
  segment: '截取',
  gif: 'GIF',
  webp: 'WebP',
  sequence: '序列帧',
  backup: 'DIT 备份',
  workflow: 'DIT 流程',
};

const OUTPUT_PRESENTATION: Partial<Record<PresetType, { extension: string; defaultSuffix: string }>> = {
  mix: { extension: 'mp4', defaultSuffix: '_mix' },
  alpha: { extension: 'mov', defaultSuffix: '_合成' },
  screenshot: { extension: 'png', defaultSuffix: '_screenshot' },
  segment: { extension: 'mp4', defaultSuffix: '_clip' },
  gif: { extension: 'gif', defaultSuffix: '' },
  webp: { extension: 'webp', defaultSuffix: '' },
  sequence: { extension: 'jpg', defaultSuffix: '_frames' },
};

type FieldDef = {
  key: string;
  label: string;
  kind: 'int' | 'number' | 'checkbox' | 'select' | 'text';
  options?: ui.ComboBoxOption[];
  min?: number;
  max?: number;
  step?: number;
  default: any;
  hint?: string;
};

// 选取比例选项（工具页与管理预设共用）。增加「自定义」以支持任意 W:H 比例输入。
export const CROP_ASPECT_OPTIONS = [
  { label: '自由', value: 'free' },
  { label: '1:1', value: '1:1', tags: ['方形'] },
  { label: '4:3', value: '4:3' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16', tags: ['竖屏'] },
  { label: '匹配输出尺寸', value: 'match' },
  { label: '自定义', value: 'custom' },
];

export const GIF_COMPRESSION_OPTIONS = [
  { label: '智能压缩', value: 'optimized', tags: ['推荐'] },
  { label: '体积优先', value: 'compact' },
  { label: '极限压缩', value: 'aggressive' },
];

export const IMAGE_SEQUENCE_FORMAT_OPTIONS = [
  { label: 'JPEG', value: 'jpg' },
  { label: 'PNG', value: 'png', tags: ['无损'] },
  { label: 'WebP', value: 'webp' },
  { label: 'TIFF', value: 'tiff', tags: ['无损'] },
  { label: 'BMP', value: 'bmp', tags: ['无压缩'] },
];

export const DEFAULT_BACKUP_PRESET_PARAMS = {
  destinations: [''],
  extensions: [] as string[],
  minSizeMb: 0,
  mediaOnly: true,
  recursive: true,
  operation: 'copy' as const,
  verifyMd5: true,
  destinationNameMode: 'original' as const,
  destinationNameTemplate: '',
  directoryStructure: 'preserve' as const,
  renameMode: 'original' as const,
  renameTemplate: '',
  conflictStrategy: 'rename' as const,
  conflictRenameTemplate: '{name}_{index}',
  conflictSubdirectory: 'Conflicts',
};

// 各功能预设的参数 schema（encode 使用专属构建器，不在此列）
export const PRESET_SCHEMAS: Record<Exclude<PresetType, 'encode'>, FieldDef[]> = {
  mix: [
    { key: 'lnOn', label: '响度标准化', kind: 'checkbox', default: true },
    { key: 'lnI', label: '目标响度 (I)', kind: 'number', min: -70, max: -5, step: 1, default: -24, hint: 'LUFS' },
    { key: 'lnTp', label: '真峰限制 (TP)', kind: 'number', min: -9, max: 0, step: 0.5, default: -2, hint: 'dBTP' },
    { key: 'lnLra', label: '响度范围 (LRA)', kind: 'number', min: 1, max: 50, step: 1, default: 7, hint: 'LU' },
    { key: 'tpOn', label: '动态压缩', kind: 'checkbox', default: true },
    { key: 'cpTh', label: '压缩阈值', kind: 'number', min: -80, max: 0, step: 1, default: -27, hint: 'dB' },
    { key: 'cpGain', label: '补偿增益', kind: 'number', min: -20, max: 40, step: 1, default: 5, hint: 'dB' },
    ...OUTPUT_PRESET_FIELDS,
  ],
  check: [
    { key: 'refEncPresetId', label: '编码规范预设', kind: 'text', default: '' },
    { key: 'fpsTol', label: '帧率容差', kind: 'number', min: 0, max: 10, step: 0.1, default: 0.5 },
    { key: 'recursive', label: '目录递归扫描', kind: 'checkbox', default: true },
    { key: 'blackDetect', label: '黑帧检测', kind: 'checkbox', default: true },
  ],
  alpha: [
    { key: 'fpsOriginal', label: '保持原始帧率', kind: 'checkbox', default: true },
    { key: 'fps', label: '输出帧率', kind: 'number', min: 1, max: 120, step: 1, default: 25 },
    ...OUTPUT_PRESET_FIELDS,
  ],
  screenshot: [
    { key: 'aspect', label: '比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 8192, default: DEFAULT_EXPORT_DIMENSIONS.width },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 8192, default: DEFAULT_EXPORT_DIMENSIONS.height },
    { key: 'imageFormat', label: '图片格式', kind: 'select', options: IMAGE_SEQUENCE_FORMAT_OPTIONS, default: 'png' },
    { key: 'quality', label: '质量', kind: 'int', min: 1, max: 100, default: 90 },
    { key: 'pngCompression', label: 'PNG 压缩级别', kind: 'int', min: 0, max: 9, default: 6 },
    ...OUTPUT_PRESET_FIELDS,
  ],
  segment: [
    { key: 'aspect', label: '比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 8192, default: DEFAULT_EXPORT_DIMENSIONS.width },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 8192, default: DEFAULT_EXPORT_DIMENSIONS.height },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
    { key: 'clipPresetId', label: '编码预设', kind: 'text', default: '' },
    ...OUTPUT_PRESET_FIELDS,
  ],
  gif: [
    { key: 'aspect', label: '比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 4096, default: DEFAULT_EXPORT_DIMENSIONS.width },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 4096, default: DEFAULT_EXPORT_DIMENSIONS.height },
    { key: 'fps', label: '帧率', kind: 'number', min: 1, max: 60, step: 0.1, default: 15 },
    { key: 'gifCompression', label: '压缩方式', kind: 'select', options: GIF_COMPRESSION_OPTIONS, default: 'optimized' },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
    ...OUTPUT_PRESET_FIELDS,
  ],
  webp: [
    { key: 'aspect', label: '比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 4096, default: DEFAULT_EXPORT_DIMENSIONS.width },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 4096, default: DEFAULT_EXPORT_DIMENSIONS.height },
    { key: 'fps', label: '帧率', kind: 'number', min: 1, max: 60, step: 0.1, default: 15 },
    { key: 'quality', label: '质量', kind: 'int', min: 1, max: 100, default: 75 },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
    ...OUTPUT_PRESET_FIELDS,
  ],
  sequence: [
    { key: 'aspect', label: '比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 8192, default: DEFAULT_EXPORT_DIMENSIONS.width },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 8192, default: DEFAULT_EXPORT_DIMENSIONS.height },
    { key: 'fps', label: '帧率', kind: 'number', min: 0.1, max: 120, step: 0.1, default: 25 },
    { key: 'imageFormat', label: '图片格式', kind: 'select', options: IMAGE_SEQUENCE_FORMAT_OPTIONS, default: 'jpg' },
    { key: 'quality', label: '质量', kind: 'int', min: 1, max: 100, default: 90 },
    { key: 'pngCompression', label: 'PNG 压缩级别', kind: 'int', min: 0, max: 9, default: 6 },
    { key: 'fullDuration', label: '完整素材长度', kind: 'checkbox', default: false },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
    ...OUTPUT_PRESET_FIELDS,
  ],
  // DIT 备份使用包含目标目录、标签输入和模板编辑器的专属构建器。
  backup: [],
  // DIT 流程使用包含条件分支的专属构建器。
  workflow: [],
};

function storedPresetStore(): PresetStore {
  if (typeof window === 'undefined') return emptyPresetStore();
  return loadPresetStore(window.localStorage);
}

type PresetStoreContextValue = {
  presets: PresetStore;
  setType: (type: PresetType, update: (current: Preset[]) => Preset[]) => void;
};

const PresetStoreContext = createContext<PresetStoreContextValue | null>(null);

function samePresetList(left: Preset[], right: Preset[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function presetApplyFingerprint(preset: Preset): string {
  return JSON.stringify([preset.id, preset.name, preset.revision ?? 1, preset.params]);
}

export function PresetStoreProvider({ children }: { children: ReactNode }) {
  const desktopRuntime = isTauriRuntime();
  const [presets, setPresetsState] = useState<PresetStore>(storedPresetStore);
  const presetsRef = useRef(presets);
  const presetRevisionRef = useRef(0);
  const backendReadyRef = useRef(!desktopRuntime);
  const pendingBeforeReadyRef = useRef(new Set<PresetType>());
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const localChangeVersionRef = useRef(0);
  const mountedRef = useRef(true);

  const applySnapshot = useCallback((snapshot: AgentSnapshot, expectedLocalVersion?: number) => {
    presetRevisionRef.current = snapshot.presetRevision;
    if (expectedLocalVersion != null && expectedLocalVersion !== localChangeVersionRef.current) return;
    const next = snapshot.presets;
    presetsRef.current = next;
    if (mountedRef.current) setPresetsState(next);
  }, []);

  const queuePresetCommit = useCallback((
    type: PresetType,
    base: Preset[],
    intended: Preset[],
    localVersion: number,
  ) => {
    commandQueueRef.current = commandQueueRef.current.then(async () => {
      try {
        let snapshot: AgentSnapshot;
        try {
          snapshot = await replaceAgentPresetType(type, intended, presetRevisionRef.current);
        } catch (error) {
          if (!isAgentRevisionConflict(error)) throw error;
          const latest = await getAgentSnapshot();
          presetRevisionRef.current = latest.presetRevision;
          if (!samePresetList(latest.presets[type], base)) {
            applySnapshot(latest, localVersion);
            console.error(`预设 ${type} 已被其他操作修改，本次 GUI 修改未覆盖远程状态`);
            return;
          }
          snapshot = await replaceAgentPresetType(type, intended, latest.presetRevision);
        }
        presetRevisionRef.current = snapshot.presetRevision;
        if (localVersion !== localChangeVersionRef.current) return;
        const next = {
          ...presetsRef.current,
          [type]: snapshot.presets[type],
        };
        presetsRef.current = next;
        if (mountedRef.current) setPresetsState(next);
      } catch (error) {
        console.error('无法同步预设到 Agent 状态服务', error);
        try {
          applySnapshot(await getAgentSnapshot(), localVersion);
        } catch (refreshError) {
          console.error('无法刷新 Agent 预设快照', refreshError);
        }
      }
    });
  }, [applySnapshot]);

  useEffect(() => {
    if (desktopRuntime) return;
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, serializePresetStore(presets));
    } catch {
      // The in-memory store remains usable when WebView persistence is unavailable.
    }
  }, [desktopRuntime, presets]);

  useEffect(() => {
    if (!desktopRuntime) return undefined;
    mountedRef.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void subscribeAgentStateChanged((event) => {
      if (event.actor === 'gui' || !backendReadyRef.current) return;
      const localVersion = localChangeVersionRef.current;
      commandQueueRef.current = commandQueueRef.current.then(async () => {
        const snapshot = await getAgentSnapshot();
        applySnapshot(snapshot, localVersion);
      }).catch((error) => console.error('无法接收 Agent 预设更新', error));
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    const migrationSource = presetsRef.current;
    void migrateAgentPresets(migrationSource).then((snapshot) => {
      if (disposed) return;
      presetRevisionRef.current = snapshot.presetRevision;
      const pendingTypes = [...pendingBeforeReadyRef.current];
      pendingBeforeReadyRef.current.clear();
      const optimistic = presetsRef.current;
      const next = { ...snapshot.presets };
      for (const type of pendingTypes) next[type] = optimistic[type];
      presetsRef.current = next;
      setPresetsState(next);
      backendReadyRef.current = true;
      const localVersion = localChangeVersionRef.current;
      for (const type of pendingTypes) {
        queuePresetCommit(type, snapshot.presets[type], optimistic[type], localVersion);
      }
    }).catch((error) => {
      console.error('无法初始化 Agent 预设状态', error);
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, [applySnapshot, desktopRuntime, queuePresetCommit]);

  const setType = useCallback((type: PresetType, update: (current: Preset[]) => Preset[]) => {
    const current = presetsRef.current;
    const base = current[type];
    const nextType = clonePresets(update(base));
    if (samePresetList(base, nextType)) return;
    const next = { ...current, [type]: nextType };
    presetsRef.current = next;
    setPresetsState(next);
    const localVersion = ++localChangeVersionRef.current;
    if (!desktopRuntime) return;
    if (!backendReadyRef.current) {
      pendingBeforeReadyRef.current.add(type);
      return;
    }
    queuePresetCommit(type, base, nextType, localVersion);
  }, [desktopRuntime, queuePresetCommit]);

  const value = useMemo<PresetStoreContextValue>(() => ({
    presets,
    setType,
  }), [presets, setType]);
  return <PresetStoreContext.Provider value={value}>{children}</PresetStoreContext.Provider>;
}

// 所有功能共享一个持久化预设仓库，流程中的 presetId 与功能页保持同一引用。
export function usePresets(type: PresetType) {
  const store = useContext(PresetStoreContext);
  if (!store) throw new Error('usePresets 必须在 PresetStoreProvider 内使用');
  const presets = store.presets[type];
  const setPresets = (update: (current: Preset[]) => Preset[]) => store.setType(type, update);
  const addPreset = (preset: Preset) => setPresets((prev) => [...prev, ...clonePresets([{ ...preset, type }])]);
  const removePreset = (id: string) => setPresets((prev) => prev.filter((preset) => preset.id !== id));
  // 拖拽排序：将 from 位置的预设移动到 to 位置
  const reorder = (from: number, to: number) => setPresets((prev) => {
    if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });
  // 更新已有预设（按 id）：编辑列表中已存在的预设时使用
  const updatePreset = (id: string, params: Record<string, any>, name?: string) =>
    setPresets((prev) => prev.map((preset) => (preset.id === id
      ? {
        ...preset,
        params: JSON.parse(JSON.stringify(params || {})),
        name: (name && String(name).trim()) || preset.name,
        revision: (preset.revision ?? 1) + 1,
      }
      : preset)));
  // 合并导入的预设：强制 type 为当前类型，并重新生成 id 避免与现有冲突
  const mergePresets = (list: Preset[]) => setPresets((prev) => [
    ...prev,
    ...clonePresets(list.filter((preset) => preset && preset.params).map((preset) => ({
      ...preset,
      id: genId(),
      type,
      revision: 1,
    }))),
  ]);
  const exportAll = () => {
    const data = JSON.stringify({ type, presets }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}-presets.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return { presets, addPreset, removePreset, updatePreset, reorder, mergePresets, exportAll };
}

function fieldValueLabel(def: FieldDef, val: any): string {
  if (val === undefined || val === null || val === '') return '—';
  if (def.kind === 'checkbox') return val ? '开' : '关';
  if (def.kind === 'select') return def.options?.find((o) => String(o.value) === String(val))?.label ?? String(val);
  if (def.hint) return `${val} ${def.hint}`;
  return String(val);
}

// 解析比例（'1:1' / 'custom'+'3:2'）→ 数值 {aw,ah}；自由 / 匹配 / 无效 返回 null（无约束）
export function aspectToRatio(aspect: string, customRatio?: string): { aw: number; ah: number } | null {
  if (aspect === 'free' || aspect === 'match' || !aspect) return null;
  let raw = aspect;
  if (aspect === 'custom') raw = customRatio || '3:2';
  const parts = String(raw).split(':');
  const aw = Number(parts[0]);
  const ah = Number(parts[1]);
  if (!parts[1] || !isFinite(aw) || !isFinite(ah) || aw <= 0 || ah <= 0) return null;
  return { aw, ah };
}

// 比例↔尺寸联动：固定比例下改一边自动算另一边（结果最小为 1）
export function linkAspectHeight(w: number, ratio: { aw: number; ah: number } | null): number {
  if (!ratio || !w) return 0;
  return Math.max(1, Math.round((w * ratio.ah) / ratio.aw));
}
export function linkAspectWidth(h: number, ratio: { aw: number; ah: number } | null): number {
  if (!ratio || !h) return 0;
  return Math.max(1, Math.round((h * ratio.aw) / ratio.ah));
}
// 解析自定义比例字符串（'3:2'）→ [宽比, 高比]；非法回退 [3, 2]
export function parseCustomRatioParts(str?: string): [number, number] {
  const m = String(str || '3:2').split(':');
  const w = Number(m[0]);
  const h = Number(m[1]);
  return [isFinite(w) && w > 0 ? w : 3, isFinite(h) && h > 0 ? h : 2];
}

// 预设管理构建器上下文：由 PresetManager 注入，encode 专属构建器与通用构建器共用同一套增删改查能力
export interface PresetBuilderCtx {
  isOpen: boolean;
  /** 关闭动画期间仍保留弹窗内容，避免条件卸载打断退场。 */
  isMounted: boolean;
  closing: boolean;
  onClose: () => void;
  onExited: () => void;
  presets: Preset[];
  onSaveNew: (data: any) => void;              // data = { name, ...params }
  onUpdate: (id: string, data: any) => void;   // data = { name, ...params }
  onRemove: (id: string) => void;
  onImport: (list: Preset[]) => void;
  onExport: () => void;
  onReorder: (from: number, to: number) => void;
}

function AnimatedPresetList({
  presets, editingId, dragIndex, overIndex, onSelect, onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  presets: Preset[];
  editingId: string | null;
  dragIndex: number | null;
  overIndex: number | null;
  onSelect: (id: string) => void;
  onDragStart: (index: number) => (event: React.DragEvent) => void;
  onDragOver: (index: number) => (event: React.DragEvent) => void;
  onDrop: (index: number) => (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <ui.AnimatedList
      items={presets}
      getKey={(preset) => preset.id}
      className="se-preset-list-motion"
      itemClassName="se-preset-list-motion-item"
      empty={<div className="se-preset-list-empty">暂无预设</div>}
      renderItem={(preset, index) => (
          <button
            type="button"
            draggable
            className={[
              'se-preset-list-item',
              editingId === preset.id ? 'active' : '',
              dragIndex === index ? 'dragging' : '',
              overIndex === index && dragIndex !== index ? 'drag-over' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelect(preset.id)}
            onDragStart={onDragStart(index)}
            onDragOver={onDragOver(index)}
            onDrop={onDrop(index)}
            onDragEnd={onDragEnd}
            title={`${preset.name}（拖拽可调整顺序）`}
          >
            <span className="se-preset-grip" aria-hidden>⋮⋮</span>
            <span className="se-preset-list-name">{preset.name}</span>
          </button>
      )}
    />
  );
}

// 预设管理弹窗外壳：最左侧预设列表 + 列表下方操作按钮（新建/复制/删除/导入/导出），右侧为编辑区（children）
export function PresetManageDialog({
  title, presets, editingId, onSelect, onNew, onCopy, onDelete,
  onImport, onExport, onReorder, onClose, onExited, onSave, saveLabel, canSave = true, compact = false, closing = false, children,
  scrollEditor = false,
}: {
  title: string;
  presets: Preset[];
  editingId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onImport: (list: Preset[]) => void;
  onExport: () => void;
  onReorder: (from: number, to: number) => void;
  onClose: () => void;
  onExited: () => void;
  onSave: () => void;
  saveLabel: string;
  canSave?: boolean;
  /** 窄版：用于字段较少的功能（检测/截图等），宽度贴合内容，避免右侧大空白 */
  compact?: boolean;
  /** 非编码编辑器共用单一滚动容器，保证名称行与参数分组右边界一致。 */
  scrollEditor?: boolean;
  closing?: boolean;
  children: React.ReactNode;
}) {
  useModalLayerRegistration(!closing);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const clearDragState = () => {
    dragIndexRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
  };
  const onDragStart = (i: number) => (e: React.DragEvent) => {
    dragIndexRef.current = i;
    setDragIndex(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  };
  const onDragOver = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overIndex !== i) setOverIndex(i);
  };
  const onDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const transferredIndex = Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
    const from = dragIndexRef.current ?? (Number.isInteger(transferredIndex) ? transferredIndex : null);
    if (from !== null && from !== i) onReorder(from, i);
    clearDragState();
  };
  const onDragEnd = clearDragState;

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!f) return;
    setImportErr(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const list = Array.isArray(data) ? data : (data && data.presets);
        if (!Array.isArray(list) || list.length === 0) throw new Error('empty');
        onImport(list.map((p: any) => ({ id: p.id || '', name: p.name || '导入预设', type: p.type, params: p.params || {} })));
      } catch {
        setImportErr('导入失败：文件不是有效的预设 JSON');
      }
    };
    reader.onerror = () => setImportErr('导入失败：无法读取文件');
    reader.readAsText(f);
  };

  return (
    <div className={`se-dialog-backdrop${closing ? ' is-closing' : ''}`} onClick={onClose}>
      <div
        className={`se-dialog se-preset-dialog${compact ? ' se-preset-dialog--compact' : ''}${scrollEditor ? ' se-preset-dialog--scroll-edit' : ''}${closing ? ' is-closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && closing && event.animationName === 'se-dialog-out') onExited();
        }}
      >
        <div className="se-dialog-head">
          <span className="se-dialog-title">{title}</span>
          <button className="se-dialog-close" onClick={onClose} title="关闭">
            <IconClose size={14} />
          </button>
        </div>
        <div className="se-dialog-body">
          <div className="se-preset-manage">
            <aside className="se-preset-list-panel">
              <div className="se-preset-list-title">预设列表</div>
              <div className="se-preset-list">
                <AnimatedPresetList
                  presets={presets}
                  editingId={editingId}
                  dragIndex={dragIndex}
                  overIndex={overIndex}
                  onSelect={onSelect}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                />
              </div>
              <div className="se-preset-list-actions">
                <ui.Button className="se-btn-new" onClick={onNew} icon={<IconPlus size={15} />} title="新建空白预设">新建</ui.Button>
                <ui.Button onClick={onCopy} disabled={!editingId} icon={<IconCopy size={15} />} title="复制当前预设为新预设">复制</ui.Button>
                <ui.Button className="se-btn-danger" onClick={onDelete} disabled={!editingId} icon={<IconTrash size={15} />} title="删除当前预设">删除</ui.Button>
                <ui.Button onClick={() => fileRef.current?.click()} icon={<IconImport size={15} />} title="导入预设">导入</ui.Button>
                <ui.Button onClick={onExport} icon={<IconExport size={15} />} title="导出全部预设">导出</ui.Button>
              </div>
              <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={handleImportFile} />
              {importErr && <div className="se-warn-label">{importErr}</div>}
            </aside>
            <div className="se-preset-edit">
              {children}
            </div>
          </div>
        </div>
        <div className="se-dialog-foot">
          <div className="se-foot-actions">
            <ui.Button primary disabled={!canSave} icon={<IconCheckShield size={14} />} onClick={onSave}>{saveLabel}</ui.Button>
          </div>
        </div>
      </div>
    </div>
  );
}

type GenericPresetGroupSpec = {
  id: string;
  title: string;
  rowIds: string[];
  toggleKey?: 'lnOn' | 'tpOn';
  checkboxKeys?: Array<'recursive' | 'blackDetect'>;
  layout?: 'alpha';
};

// 与各功能主界面的参数分组保持一致；编码预设继续使用专属双栏构建器。
const GENERIC_PRESET_GROUPS: Partial<Record<PresetType, GenericPresetGroupSpec[]>> = {
  mix: [
    { id: 'loudness', title: '响度标准化 (EBU R128)', rowIds: ['field-lnI', 'field-lnTp', 'field-lnLra'], toggleKey: 'lnOn' },
    { id: 'compand', title: '动态压缩 (Compand)', rowIds: ['field-cpTh', 'field-cpGain'], toggleKey: 'tpOn' },
  ],
  check: [
    { id: 'reference', title: '编码规范参照', rowIds: ['reference-encode-preset'] },
    { id: 'rules', title: '检测规则', rowIds: ['field-fpsTol'], checkboxKeys: ['recursive', 'blackDetect'] },
  ],
  alpha: [
    { id: 'frame-rate', title: '帧率设置', rowIds: [], layout: 'alpha' },
  ],
  screenshot: [
    { id: 'aspect', title: '选取比例', rowIds: ['field-aspect', 'custom-ratio'] },
    { id: 'dimensions', title: '输出尺寸', rowIds: ['resolution'] },
  ],
  segment: [
    { id: 'range', title: '时间范围', rowIds: ['fixed-duration'] },
    { id: 'aspect', title: '选取比例', rowIds: ['field-aspect', 'custom-ratio'] },
    { id: 'output', title: '输出参数 (片段)', rowIds: ['resolution', 'clip-encode-preset'] },
  ],
  gif: [
    { id: 'range', title: '时间范围', rowIds: ['fixed-duration'] },
    { id: 'aspect', title: '选取比例', rowIds: ['field-aspect', 'custom-ratio'] },
    { id: 'output', title: '输出参数 (GIF)', rowIds: ['resolution', 'field-fps', 'field-gifCompression'] },
  ],
  webp: [
    { id: 'range', title: '时间范围', rowIds: ['fixed-duration'] },
    { id: 'aspect', title: '选取比例', rowIds: ['field-aspect', 'custom-ratio'] },
    { id: 'output', title: '输出参数 (WebP)', rowIds: ['resolution', 'field-fps', 'field-quality'] },
  ],
  sequence: [
    { id: 'range', title: '时间范围', rowIds: ['full-duration', 'fixed-duration'] },
    { id: 'aspect', title: '选取比例', rowIds: ['field-aspect', 'custom-ratio'] },
    { id: 'output', title: '输出参数 (序列帧)', rowIds: ['resolution', 'field-fps', 'field-imageFormat', 'field-quality'] },
  ],
};

// 通用预设构建器（schema 驱动），用于无需专属编辑器的非编码功能。
function GenericPresetBuilder({ type, ctx, initial }: {
  type: PresetType; ctx: PresetBuilderCtx; initial?: Record<string, any>;
}) {
  const schema = PRESET_SCHEMAS[type as Exclude<PresetType, 'encode'>] || [];
  const uiType = type as SharedPresetUiType;
  const encPresets = usePresets('encode'); // 检测功能可选编码预设为规范基准
  const normalizeEncodePresetId = (value: unknown) => {
    const requested = typeof value === 'string' ? value : '';
    return encPresets.presets.some((preset) => preset.id === requested)
      ? requested
      : '';
  };
  const makeNew = () => {
    const values = Object.fromEntries(schema.map((d) => [d.key, initial && initial[d.key] !== undefined ? initial[d.key] : d.default]));
    if (type === 'segment') values.clipPresetId = normalizeEncodePresetId(values.clipPresetId);
    if (type === 'check') values.refEncPresetId = normalizeEncodePresetId(values.refEncPresetId);
    return values;
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [form, setForm] = useState<Record<string, any>>(makeNew);
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  // 比例↔尺寸联动：固定比例下改一边自动算另一边（自定义则在 aspect 切换时即时生效）
  const curRatio = aspectToRatio(form.aspect, form.customRatio);
  const onW = (v: number) => { set('w', v); if (curRatio) set('h', linkAspectHeight(v, curRatio)); };
  const onH = (v: number) => { set('h', v); if (curRatio) set('w', linkAspectWidth(v, curRatio)); };

  const onNew = () => { setEditingId(null); setForm(makeNew()); setName(''); };
  const onSelect = (id: string) => {
    const p = ctx.presets.find((x) => x.id === id);
    if (!p) return;
    setEditingId(id);
    const values = Object.fromEntries(schema.map((d) => [d.key, p.params[d.key] !== undefined ? p.params[d.key] : d.default]));
    if (type === 'segment') values.clipPresetId = normalizeEncodePresetId(values.clipPresetId);
    if (type === 'check') values.refEncPresetId = normalizeEncodePresetId(values.refEncPresetId);
    setForm(values);
    setName(p.name);
  };
  const onCopy = () => { if (editingId) { setEditingId(null); setName((n) => (n ? `${n} 副本` : '副本')); } };
  const onDelete = () => { if (editingId) { ctx.onRemove(editingId); onNew(); } };
  const onSave = () => {
    if (editingId) ctx.onUpdate(editingId, { ...form, name });
    else ctx.onSaveNew({ ...form, name });
  };

  // 打开弹窗时重置为「新建」状态
  const prevOpen = useRef(false);
  React.useEffect(() => {
    if (ctx.isOpen && !prevOpen.current) onNew();
    prevOpen.current = ctx.isOpen;
  }, [ctx.isOpen]);

  if (!ctx.isMounted) return null;
  const customRenderedKeys = new Set([
    'lnOn', 'tpOn', 'fpsOriginal', 'recursive', 'blackDetect', 'fullDuration', 'fixedDur', 'fixedVal',
    ...(type === 'alpha' ? ['fps'] : []),
  ]);
  const visibleSchema = schema
    .filter((d) => d.key !== 'refEncPresetId' && d.key !== 'clipPresetId' && !OUTPUT_PRESET_KEYS.has(d.key))
    .filter((d) => isPresetUiFieldVisible(uiType, d.key, form))
    .filter((d) => !customRenderedKeys.has(d.key));
  const fieldRows: ui.AnimatedFieldRow[] = [];
  if (type === 'check') {
    fieldRows.push({
      id: 'reference-encode-preset',
      content: (
        <>
          <ui.FieldLabel>对照预设</ui.FieldLabel>
          <ui.ComboBox
            value={form.refEncPresetId || ''}
            options={encPresets.presets.length
              ? [{ label: '不指定编码规范', value: '' }, ...encPresets.presets.map((p) => ({ label: p.name, value: p.id }))]
              : [{ label: '无转码预设', value: '' }]}
            onChange={(v) => set('refEncPresetId', v)}
          />
        </>
      ),
    });
  }
  if (type === 'segment') {
    fieldRows.push({
      id: 'clip-encode-preset',
      content: (
        <>
          <ui.FieldLabel>编码预设</ui.FieldLabel>
          <ui.ComboBox
            value={form.clipPresetId || ''}
            options={encPresets.presets.map((p) => ({
              label: p.name,
              value: p.id,
              tags: p.params.container ? [String(p.params.container).toUpperCase()] : undefined,
            }))}
            onChange={(v) => set('clipPresetId', v)}
            disabled={encPresets.presets.length === 0}
            placeholder={encPresets.presets.length ? '请选择' : '没有可用的编码预设'}
          />
        </>
      ),
    });
  }
  if (type === 'sequence') {
    fieldRows.push({
      id: 'full-duration',
      content: (
        <>
          <ui.FieldLabel>范围</ui.FieldLabel>
          <ui.Checkbox
            checked={!!form.fullDuration}
            onChange={(value) => {
              set('fullDuration', value);
              if (value) set('fixedDur', false);
            }}
          >
            完整素材长度
          </ui.Checkbox>
        </>
      ),
    });
  }
  if (type === 'segment' || type === 'gif' || type === 'webp' || type === 'sequence') {
    fieldRows.push({
      id: 'fixed-duration',
      content: (
        <>
          <ui.Checkbox
            checked={!!form.fixedDur}
            disabled={type === 'sequence' && form.fullDuration === true}
            onChange={(value) => set('fixedDur', value)}
          >
            固定时长
          </ui.Checkbox>
          <ui.NumberField
            value={form.fixedVal}
            min={0.1}
            max={9999}
            step={0.1}
            suffix="s"
            disabled={isPresetUiFieldDisabled(uiType, 'fixedVal', form)}
            onChange={(value) => set('fixedVal', value)}
          />
        </>
      ),
    });
  }
  visibleSchema.forEach((d, index) => {
    if (d.key === 'customRatio') {
      const [rw, rh] = parseCustomRatioParts(form.customRatio);
      fieldRows.push({
        id: 'custom-ratio',
        content: (
          <>
            <ui.FieldLabel>宽比</ui.FieldLabel>
            <ui.IntField value={rw} min={1} max={99} onChange={(v) => set('customRatio', `${v}:${rh}`)} />
            <ui.FieldLabel>高比</ui.FieldLabel>
            <ui.IntField value={rh} min={1} max={99} onChange={(v) => set('customRatio', `${rw}:${v}`)} />
          </>
        ),
      });
      return;
    }
    const nextField = visibleSchema[index + 1];
    if (d.key === 'w' && d.kind === 'int' && nextField?.key === 'h' && nextField.kind === 'int') {
      const outputOriginal = d.label.includes('0=原始') || nextField.label.includes('0=原始');
      const disabled = isPresetUiFieldDisabled(uiType, 'w', form);
      fieldRows.push({
        id: 'resolution',
        content: (
          <>
            <ui.FieldLabel>{outputOriginal ? '分辨率 (0=原始)' : '分辨率 (长×宽)'}</ui.FieldLabel>
            <div className="se-res-row">
              <ui.IntField value={form.w} min={d.min ?? 0} max={d.max ?? 9999} suffix="px" disabled={disabled} onChange={onW} />
              <span className="se-x">×</span>
              <ui.IntField value={form.h} min={nextField.min ?? 0} max={nextField.max ?? 9999} suffix="px" disabled={disabled} onChange={onH} />
            </div>
          </>
        ),
      });
      return;
    }
    if (d.key === 'h' && visibleSchema[index - 1]?.key === 'w') return;
    const disabled = isPresetUiFieldDisabled(uiType, d.key, form);
    fieldRows.push({
      id: `field-${d.key}`,
      content: (
        <>
          <ui.FieldLabel>{d.label}</ui.FieldLabel>
          {d.kind === 'select' && (
            <ui.ComboBox
              value={form[d.key]}
              options={d.options || []}
              onChange={(v) => {
                set(d.key, v);
                if (d.key === 'aspect') {
                  const r = aspectToRatio(v, form.customRatio);
                  if (r && form.w > 0) set('h', linkAspectHeight(form.w, r));
                }
              }}
            />
          )}
          {d.kind === 'int' && (
            <ui.IntField
              value={form[d.key]}
              min={d.min ?? 0}
              max={d.max ?? 9999}
              disabled={disabled}
              onChange={(v) => {
                if (d.key === 'w') onW(v);
                else if (d.key === 'h') onH(v);
                else set(d.key, v);
              }}
            />
          )}
          {d.kind === 'number' && (
            <ui.NumberField value={form[d.key]} min={d.min ?? 0} max={d.max ?? 9999} step={d.step ?? 1} suffix={d.hint} disabled={disabled} onChange={(v) => set(d.key, v)} />
          )}
          {d.kind === 'checkbox' && (
            <ui.Checkbox checked={!!form[d.key]} onChange={(v) => set(d.key, v)}>{d.hint || '启用'}</ui.Checkbox>
          )}
          {d.kind === 'text' && (
            <input className="se-drop-input" value={form[d.key]} onChange={(e) => set(d.key, e.target.value)} />
          )}
        </>
      ),
    });
  });
  const rowById = new Map(fieldRows.map((row) => [row.id, row]));
  const groupedIds = new Set<string>();
  const sections = (GENERIC_PRESET_GROUPS[type] ?? []).map((section) => {
    const rows = section.rowIds.flatMap((id) => {
      const row = rowById.get(id);
      if (!row) return [];
      groupedIds.add(id);
      return [row];
    });
    return { ...section, rows };
  }).filter((section) => (
    section.rows.length > 0
    || section.layout != null
    || (section.checkboxKeys?.length ?? 0) > 0
  ));
  const remainingRows = fieldRows.filter((row) => !groupedIds.has(row.id));
  if (remainingRows.length > 0) {
    sections.push({ id: 'other', title: '参数设置', rowIds: [], rows: remainingRows });
  }
  return (
    <PresetManageDialog
      title={`管理${TYPE_LABEL[type]}预设`}
      compact
      scrollEditor
      presets={ctx.presets}
      editingId={editingId}
      onSelect={onSelect}
      onNew={onNew}
      onCopy={onCopy}
      onDelete={onDelete}
      onImport={ctx.onImport}
      onExport={ctx.onExport}
      onReorder={ctx.onReorder}
      onClose={ctx.onClose}
      onExited={ctx.onExited}
      closing={ctx.closing}
      onSave={onSave}
      saveLabel={editingId ? '保存修改' : '保存预设'}
      canSave={!!String(name).trim()}
    >
      <div className="se-preset-name">
        <ui.FieldLabel>预设名称</ui.FieldLabel>
        <input className="se-drop-input" value={name} placeholder="例如：广播响度" onChange={(e) => setName(e.target.value)} />
      </div>
      {sections.map((section) => (
        <ui.ParamGroup
          key={section.id}
          title={section.title}
          aside={section.toggleKey ? (
            <ui.Checkbox checked={!!form[section.toggleKey]} onChange={(value) => set(section.toggleKey!, value)}>{''}</ui.Checkbox>
          ) : undefined}
        >
          {section.layout === 'alpha' ? (
            <>
              <ui.Radio checked={form.fpsOriginal !== false} onToggle={() => set('fpsOriginal', true)}>保持原始帧率</ui.Radio>
              <div className="se-btn-row">
                <ui.Radio checked={form.fpsOriginal === false} onToggle={() => set('fpsOriginal', false)}>自定义帧率</ui.Radio>
                <ui.NumberField
                  value={form.fps}
                  min={1}
                  max={120}
                  step={0.1}
                  width={110}
                  disabled={isPresetUiFieldDisabled(uiType, 'fps', form)}
                  onChange={(value) => set('fps', value)}
                />
              </div>
            </>
          ) : (
            <>
              {section.rows.length > 0 && <ui.AnimatedFieldGrid rows={section.rows} />}
              {section.checkboxKeys?.map((key) => (
                <ui.Checkbox key={key} checked={!!form[key]} onChange={(value) => set(key, value)}>
                  {key === 'recursive' ? '目录递归扫描' : '启用中间黑帧检测'}
                </ui.Checkbox>
              ))}
            </>
          )}
        </ui.ParamGroup>
      ))}
      {type !== 'check' && type !== 'backup' && (
        <OutputLocationGroup
          value={form}
          presetName={name}
          extension={type === 'sequence' ? form.imageFormat : OUTPUT_PRESENTATION[type]?.extension}
          defaultSuffix={OUTPUT_PRESENTATION[type]?.defaultSuffix}
          onChange={(key, value) => set(key, value)}
        />
      )}
    </PresetManageDialog>
  );
}

type PresetCardRow = { k: string; v: string };

function PresetCardRows({ rows }: { rows: PresetCardRow[] }) {
  return (
    <ui.AnimatedList
      items={rows}
      getKey={(row) => row.k}
      className="se-preset-kv-grid"
      itemClassName="se-preset-kv-motion-item"
      layout="flow"
      renderItem={(row) => (
        <div className="se-preset-kv">
          <span className="se-preset-k">{row.k}</span>
          <ui.AnimatedValue value={row.v} className="se-preset-v" />
        </div>
      )}
    />
  );
}

// 当前参数预览卡片（只展示关键参数网格；预设名称与类型 tag 已移除，避免重复）
export function PresetCard({ type, params }: { type: PresetType; params: Record<string, any> | null }) {
  if (!params) return null;
  const p = params;
  let rows: PresetCardRow[];
  if (type === 'encode') {
    const codecLabel = (VIDEO_CODEC_LABEL[p.videoCodec] as string) || p.videoCodec || '—';
    const prof = p.videoProfile ? ` / ${p.videoProfile}` : '';
    const scaleMode = p.scaleMode || (p.keepRes ? 'original' : ((p.scaleW && p.scaleH) ? 'dimensions' : 'original'));
    const res = scaleMode === 'longEdge'
      ? `长边 ${p.scaleEdge || '—'}px`
      : scaleMode === 'shortEdge'
        ? `短边 ${p.scaleEdge || '—'}px`
        : scaleMode === 'dimensions' && p.scaleW && p.scaleH
          ? `${p.scaleW}×${p.scaleH}`
          : '原始分辨率';
    // 码控模式（兼容旧预设：无 rateMode 默认 CRF）
    const mode = p.rateMode || 'crf';
    let q: string;
    let vbr: string;
    if (mode === 'filesize') {
      q = `目标体积 ${p.targetFileSizeMb ?? 0} MB`;
      vbr = '自动（按体积计算）';
    } else if (mode === 'bitrate') {
      q = '码率优先';
      vbr = p.videoBitrate > 0 ? `${p.videoBitrate / 1000} Mbps` : '—';
    } else if (mode === 'capped') {
      q = p.crf != null ? `CRF ${p.crf}` : '—';
      vbr = `上限 ${p.maxrate > 0 ? `${p.maxrate / 1000} Mbps` : '—'} · 缓冲 ${p.bufsize > 0 ? `${p.bufsize / 1000} Mbps` : '—'}`;
    } else {
      q = p.crf != null ? `CRF ${p.crf}` : '—';
      vbr = p.videoBitrate > 0 ? `${p.videoBitrate / 1000} Mbps` : (p.crf != null ? 'CRF（自动码率）' : '—');
    }
    const aLabel = (AUDIO_CODEC_LABEL[p.audioCodec] as string) || p.audioCodec || '—';
    let abr = '—';
    if (p.videoCodec === 'gif') abr = '无音频轨';
    else if (p.audioOnly) abr = '仅输出音频';
    else if (p.noAudio) abr = '不输出音轨';
    else if (p.audioCodec === 'copy') abr = '复制音频流';
    else if (p.audioBitrate > 0) abr = `${p.audioBitrate} kbps`;
    rows = [
      { k: '封装', v: (p.container || '—').toUpperCase() },
      { k: '视频', v: `${codecLabel}${prof}` },
      { k: 'Level', v: p.videoLevel || '自动' },
      { k: mode === 'filesize' ? '目标体积' : (mode === 'bitrate' ? '质量' : '质量'), v: q },
      { k: '视频码率', v: vbr },
      { k: '分辨率', v: res },
      { k: '帧率', v: p.fps != null ? `${p.fps} fps` : '—' },
      { k: '音频', v: aLabel },
      { k: '音频码率', v: abr },
      { k: '锐化', v: String(p.unsharp ?? '—') },
      { k: '降噪', v: String(p.denoise ?? '—') },
      { k: '去块', v: String(p.deblock ?? '—') },
      { k: '调优', v: p.tune && p.tune !== 'none' ? p.tune : '无' },
      { k: '2-pass 编码', v: p.twoPass ? '开启' : '关闭' },
      { k: '进度预览', v: p.previewDuringEncode === false ? '关闭' : '开启' },
      { k: '存储位置', v: describeOutputSettings(p) },
    ];
  } else if (type === 'mix') {
    // 混音：开关关闭时隐藏对应子参数，卡片始终反映实际生效项
    rows = [];
    if (p.lnOn) {
      rows.push({ k: '响度标准化', v: '开' });
      rows.push({ k: '目标响度 I', v: `${p.lnI} LUFS` });
      rows.push({ k: '真峰 TP', v: `${p.lnTp} dBTP` });
      rows.push({ k: '响度范围 LRA', v: `${p.lnLra} LU` });
    } else {
      rows.push({ k: '响度标准化', v: '关' });
    }
    if (p.tpOn) {
      rows.push({ k: '动态压缩', v: '开' });
      rows.push({ k: '压缩阈值', v: `${p.cpTh} dB` });
      rows.push({ k: '补偿增益', v: `${p.cpGain} dB` });
    } else {
      rows.push({ k: '动态压缩', v: '关' });
    }
    rows.push({ k: '存储位置', v: describeOutputSettings(p) });
  } else if (type === 'workflow') {
    const workflow = normalizeWorkflowDefinition(p);
    const counts = workflowNodeCounts(workflow.steps);
    rows = [
      { k: '触发方式', v: workflow.trigger.kind === 'removable' ? '新接入磁盘' : '手动执行' },
      { k: '执行步骤', v: `${counts.actions} 个` },
      { k: '逻辑判断', v: `${counts.conditions} 个` },
    ];
    if (workflow.trigger.kind === 'removable') {
      rows.push({
        k: '磁盘范围',
        v: workflow.trigger.volumeKind === 'any' ? '任意新接入卷' : '可移动磁盘',
      });
      rows.push({
        k: '卷标过滤',
        v: workflow.trigger.labelContains.trim() || '不过滤',
      });
      rows.push({
        k: '稳定等待',
        v: `${workflow.trigger.settleSeconds} 秒`,
      });
    }
  } else if (type === 'backup') {
    const destinations = Array.isArray(p.destinations)
      ? p.destinations
        .map((value: unknown) => typeof value === 'object' && value !== null && 'path' in value
          ? String((value as { path: unknown }).path || '')
          : String(value || ''))
        .filter((value: string) => value.trim())
      : [];
    const extensions = Array.isArray(p.extensions)
      ? p.extensions.filter((value: unknown) => String(value || '').trim())
      : [];
    const filter = extensions.length > 0
      ? extensions.join(' ')
      : (p.mediaOnly === false ? '全部文件' : '媒体文件');
    const destinationName = p.destinationNameMode === 'template'
      ? (p.destinationNameTemplate || '名称模板')
      : '原文件/目录名';
    const rename = p.renameMode === 'template'
      ? (p.renameTemplate || '名称模板')
      : '保留原文件名';
    const conflict = p.conflictStrategy === 'subdirectory'
      ? `保存到 ${p.conflictSubdirectory || '冲突文件'} 子目录`
      : `自动重命名 · ${p.conflictRenameTemplate || '{name}_{index}'}`;
    rows = [
      { k: '目标目录', v: destinations.length > 0 ? `${destinations.length} 个` : '未设置' },
      { k: '文件过滤', v: filter },
      { k: '最小体积', v: p.minSizeMb > 0 ? `${p.minSizeMb} MB` : '不限制' },
      { k: '目录命名', v: destinationName },
      { k: '目录结构', v: p.directoryStructure === 'flatten' ? '塌陷子目录' : '保留子目录结构' },
      { k: '文件命名', v: rename },
      { k: '冲突解决', v: conflict },
      { k: '操作方式', v: p.operation === 'move' ? '移动' : '复制' },
      { k: 'MD5 校验', v: p.verifyMd5 === false ? '关闭' : '开启' },
    ];
  } else {
    const isRatioType = type === 'screenshot' || type === 'segment' || type === 'gif' || type === 'webp';
    const schema = PRESET_SCHEMAS[type as Exclude<PresetType, 'encode'>] || [];
    const visibleFields = schema
      .filter((d) => !OUTPUT_PRESET_KEYS.has(d.key))
      .filter((d) => !(isRatioType && d.key === 'customRatio' && p.aspect !== 'custom'));
    rows = [];
    for (let index = 0; index < visibleFields.length; index += 1) {
      const field = visibleFields[index];
      const nextField = visibleFields[index + 1];
      if (field.key === 'w' && nextField?.key === 'h') {
        rows.push({ k: '分辨率', v: `${p.w ?? '—'}×${p.h ?? '—'}` });
        index += 1;
        continue;
      }
      rows.push({ k: field.label, v: fieldValueLabel(field, p[field.key]) });
    }
    // 检测功能：扩展显示编码规范对照项（由 CheckTab 通过 currentParams 传入）
    if (type === 'check') {
      if (p.refEncName) rows.push({ k: '对照预设', v: p.refEncName });
      if (p.refEncCodec) rows.push({ k: '期望编码器', v: p.refEncCodec });
      if (p.refEncRes) rows.push({ k: '期望分辨率', v: p.refEncRes });
      if (p.refEncFps > 0) rows.push({ k: '期望帧率', v: `${p.refEncFps} fps` });
    } else {
      rows.push({ k: '存储位置', v: describeOutputSettings(p) });
    }
  }

  return (
    <div className="se-preset-card">
      <PresetCardRows rows={rows} />
    </div>
  );
}

// 可嵌入任意 Tab 的预设管理器：下拉选择套用 + 「管理预设」入口 + 当前预设卡片
// renderBuilder 用于 encode（专属级联构建器）；其余功能用通用构建器
// 增删改查（新建/复制/编辑/删除/导入/导出）统一在「管理预设」弹窗内完成
export function PresetManager({ type, onApply, builderTitle, initialValues, currentParams, renderBuilder }: {
  type: PresetType;
  onApply: (params: any, presetName?: string) => void;
  builderTitle?: string;
  initialValues?: Record<string, any>;
  /** 当前面板里实际会用于处理的参数（实时值）；传入后卡片展示实时值，并启用「更新当前预设」 */
  currentParams?: Record<string, any>;
  renderBuilder?: (ctx: PresetBuilderCtx) => React.ReactNode;
}) {
  const { presets, addPreset, removePreset, updatePreset, reorder, mergePresets, exportAll } = usePresets(type);
  const [selId, setSelId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const onApplyRef = useRef(onApply);
  const appliedPresetRef = useRef('');

  useEffect(() => {
    onApplyRef.current = onApply;
  }, [onApply]);

  const sel = presets.find((p) => p.id === selId) ?? null;
  const options = [
    { label: '未选择预设', value: '' },
    ...presets.map((p) => ({ label: p.name, value: p.id })),
  ];

  const onPick = (id: string) => {
    if (!id) {
      setSelId(null);
      appliedPresetRef.current = '';
      onApply({}, '');
      return;
    }
    setSelId(id);
    const p = presets.find((x) => x.id === id);
    if (p) {
      appliedPresetRef.current = presetApplyFingerprint(p);
      onApply(p.params, p.name);
    }
  };

  useEffect(() => {
    if (!selId) return;
    const selected = presets.find((preset) => preset.id === selId);
    if (!selected) {
      appliedPresetRef.current = '';
      setSelId(null);
      onApplyRef.current({}, '');
      return;
    }
    const fingerprint = presetApplyFingerprint(selected);
    if (fingerprint === appliedPresetRef.current) return;
    appliedPresetRef.current = fingerprint;
    onApplyRef.current(selected.params, selected.name);
  }, [presets, selId]);

  // 将面板当前的实时参数写回所选预设；未选择时新建一个同名规则的预设。
  const onUpdateCurrent = () => {
    if (!currentParams) return;
    if (!selId) {
      const preset: Preset = {
        id: genId(),
        name: `预设 ${presets.length + 1}`,
        type,
        params: currentParams,
      };
      addPreset(preset);
      setSelId(preset.id);
      appliedPresetRef.current = presetApplyFingerprint({ ...preset, revision: 1 });
      onApply(preset.params, preset.name);
      return;
    }
    const p = presets.find((x) => x.id === selId);
    if (!p) return;
    appliedPresetRef.current = presetApplyFingerprint({
      ...p,
      params: currentParams,
      revision: (p.revision ?? 1) + 1,
    });
    updatePreset(selId, currentParams, p.name);
    onApply(currentParams, p.name);
  };

  const ctx: PresetBuilderCtx = {
    isOpen: open,
    isMounted: open || closing,
    closing,
    onClose: () => {
      if (!open) return;
      setOpen(false);
      setClosing(true);
    },
    onExited: () => setClosing(false),
    presets,
    onSaveNew: (raw: any) => {
      const { name: pName, ...params } = raw;
      const preset: Preset = {
        id: genId(),
        name: (pName && String(pName).trim()) || `预设 ${presets.length + 1}`,
        type,
        params,
      };
      addPreset(preset);
      setSelId(preset.id);
      appliedPresetRef.current = presetApplyFingerprint({ ...preset, revision: 1 });
      onApply(preset.params, preset.name);
    },
    onUpdate: (id: string, raw: any) => {
      const { name: pName, ...params } = raw;
      const current = presets.find((preset) => preset.id === id);
      const nextName = String(pName || '').trim() || current?.name || '未命名预设';
      if (id === selId && current) {
        appliedPresetRef.current = presetApplyFingerprint({
          ...current,
          name: nextName,
          params,
          revision: (current.revision ?? 1) + 1,
        });
      }
      updatePreset(id, params, pName);
      if (id === selId) onApply(params, nextName);
    },
    onRemove: (id: string) => {
      removePreset(id);
      if (id === selId) {
        setSelId(null);
        appliedPresetRef.current = '';
        onApply({}, '');
      }
    },
    onImport: (list: Preset[]) => mergePresets(list),
    onExport: exportAll,
    onReorder: (from: number, to: number) => reorder(from, to),
  };

  const builder = renderBuilder
    ? renderBuilder(ctx)
    : <GenericPresetBuilder type={type} ctx={ctx} initial={initialValues} />;

  return (
    <div className="se-preset-panel">
      <div className="se-panel-head">
        <span className="se-panel-title">{builderTitle ?? '预设管理'}</span>
        <span className="se-count-chip">{presets.length}</span>
      </div>
      <div className="se-preset-panel-body">
        <ui.ComboBox value={selId ?? ''} options={options} onChange={onPick} placeholder="未选择预设" />
        <PresetCard type={type} params={currentParams ?? sel?.params ?? null} />
      </div>
      <div className="se-preset-foot">
        <ui.Button className="se-btn-new" onClick={() => { setClosing(false); setOpen(true); }} icon={<IconSettings size={15} className="se-preset-manage-icon" />} title="管理预设">管理预设</ui.Button>
        <ui.Button className="se-btn-new" onClick={onUpdateCurrent} disabled={!currentParams} icon={<IconCheckShield size={15} />} title={selId ? '将面板当前的实时参数保存到所选预设' : '将面板当前的实时参数保存为新预设'}>{selId ? '更新当前预设' : '保存为预设'}</ui.Button>
      </div>
      {builder}
    </div>
  );
}

// 标签映射（供 encode 卡片展示）
const VIDEO_CODEC_LABEL: Record<string, string> = {
  libx264: 'H.264', libx265: 'H.265', h264_nvenc: 'H.264 (NVENC)', hevc_nvenc: 'H.265 (NVENC)',
  h264_amf: 'H.264 (AMF)', hevc_amf: 'H.265 (AMF)', h264_qsv: 'H.264 (QSV)', hevc_qsv: 'H.265 (QSV)',
  libsvtav1: 'AV1', 'libaom-av1': 'AV1', av1_nvenc: 'AV1 (NVENC)', av1_amf: 'AV1 (AMF)', av1_qsv: 'AV1 (QSV)',
  'libvpx': 'VP8', 'libvpx-vp9': 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2',
  prores: 'ProRes', dnxhd: 'DNxHR', mjpeg: 'MJPEG', ffv1: 'FFV1', gif: 'GIF',
};
const AUDIO_CODEC_LABEL: Record<string, string> = {
  aac: 'AAC', 'libmp3lame': 'MP3', 'libopus': 'Opus', 'libvorbis': 'Vorbis', flac: 'FLAC',
  'pcm_s16le': 'PCM 16', 'pcm_s24le': 'PCM 24', alac: 'ALAC', ac3: 'AC-3', eac3: 'E-AC-3',
  wmav2: 'WMA', copy: '复制',
};
