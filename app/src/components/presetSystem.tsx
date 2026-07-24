// 统一预设系统：所有功能（转码/混音/检测/截图/截取/GIF/WebP）共享的预设管理能力
// 提供：类型与内存 store、各功能的参数 schema、schema 驱动的通用预设构建器、
// 美观的"当前预设"卡片、以及可嵌入任意 Tab 的 PresetManager（下拉+新建+导出+卡片）。
import React, { useState, useRef } from 'react';
import * as ui from './ui';
import { IconClose, IconCheckShield, IconPlus, IconExport, IconImport, IconTrash, IconCopy, IconSettings } from './icons';

export type PresetType = 'encode' | 'mix' | 'check' | 'screenshot' | 'segment' | 'gif' | 'webp';

export interface Preset {
  id: string;
  name: string;
  type: PresetType;
  params: Record<string, any>;
}

export const TYPE_LABEL: Record<PresetType, string> = {
  encode: '转码',
  mix: '混音',
  check: '检测',
  screenshot: '截图',
  segment: '截取',
  gif: 'GIF',
  webp: 'WebP',
};

type FieldDef = {
  key: string;
  label: string;
  kind: 'int' | 'number' | 'checkbox' | 'select' | 'text';
  options?: { label: string; value: any }[];
  min?: number;
  max?: number;
  step?: number;
  default: any;
  hint?: string;
};

// 选取比例选项（工具页与管理预设共用）。增加「自定义」以支持任意 W:H 比例输入。
export const CROP_ASPECT_OPTIONS = [
  { label: '自由', value: 'free' },
  { label: '1:1 方形', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '16:9', value: '16:9' },
  { label: '9:16 竖屏', value: '9:16' },
  { label: '匹配输出尺寸', value: 'match' },
  { label: '自定义…', value: 'custom' },
];

// 各功能预设的参数 schema（encode 使用专属构建器，不在此列）
export const PRESET_SCHEMAS: Record<Exclude<PresetType, 'encode'>, FieldDef[]> = {
  mix: [
    { key: 'lnOn', label: '响度标准化', kind: 'checkbox', default: true },
    { key: 'lnI', label: '目标响度 I', kind: 'number', min: -70, max: -5, step: 1, default: -24, hint: 'LUFS' },
    { key: 'lnTp', label: '真峰 TP', kind: 'number', min: -9, max: 0, step: 0.5, default: -2, hint: 'dBTP' },
    { key: 'lnLra', label: '响度范围 LRA', kind: 'number', min: 1, max: 50, step: 1, default: 7, hint: 'LU' },
    { key: 'tpOn', label: '动态压缩', kind: 'checkbox', default: true },
    { key: 'cpTh', label: '压缩阈值', kind: 'number', min: -80, max: 0, step: 1, default: -27, hint: 'dB' },
    { key: 'cpGain', label: '补偿增益', kind: 'number', min: -20, max: 40, step: 1, default: 5, hint: 'dB' },
  ],
  check: [
    { key: 'refEncPresetId', label: '编码规范预设', kind: 'text', default: '' },
    { key: 'fpsTol', label: '帧率容差', kind: 'number', min: 0, max: 10, step: 0.1, default: 0.5 },
    { key: 'recursive', label: '目录递归扫描', kind: 'checkbox', default: true },
    { key: 'blackDetect', label: '黑帧检测', kind: 'checkbox', default: true },
  ],
  screenshot: [
    { key: 'aspect', label: '选取比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 8192, default: 1920 },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 8192, default: 1080 },
  ],
  segment: [
    { key: 'w', label: '宽度 (0=原始)', kind: 'int', min: 0, max: 8192, default: 0 },
    { key: 'h', label: '高度 (0=原始)', kind: 'int', min: 0, max: 8192, default: 0 },
    { key: 'fps', label: '帧率', kind: 'number', min: 1, max: 60, step: 0.1, default: 25 },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
  ],
  gif: [
    { key: 'aspect', label: '选取比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 4096, default: 480 },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 4096, default: 270 },
    { key: 'fps', label: '帧率', kind: 'number', min: 1, max: 60, step: 0.1, default: 15 },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
  ],
  webp: [
    { key: 'aspect', label: '选取比例', kind: 'select', options: CROP_ASPECT_OPTIONS, default: 'free' },
    { key: 'customRatio', label: '自定义比例', kind: 'text', default: '3:2' },
    { key: 'w', label: '宽度', kind: 'int', min: 1, max: 4096, default: 480 },
    { key: 'h', label: '高度', kind: 'int', min: 1, max: 4096, default: 270 },
    { key: 'fps', label: '帧率', kind: 'number', min: 1, max: 60, step: 0.1, default: 15 },
    { key: 'quality', label: '质量', kind: 'int', min: 1, max: 100, default: 75 },
    { key: 'fixedDur', label: '固定时长', kind: 'checkbox', default: false },
    { key: 'fixedVal', label: '时长', kind: 'number', min: 0.1, max: 9999, step: 0.1, default: 2 },
  ],
};

// 各功能内置默认预设（让下拉不空、且直接演示卡片）
const DEFAULT_PRESETS: Record<PresetType, Preset[]> = {
  encode: [
    {
      id: 'enc-default-1', name: '点歌屏 1080p', type: 'encode',
      params: { container: 'mp4', videoCodec: 'libx264', videoProfile: 'high', crf: 23, preset: 'medium', tune: 'none', pixelFormat: 'yuv420p', scaleW: 1920, scaleH: 1080, fps: 25, keepRes: false, audioOnly: true, audioCodec: 'aac', audioProfile: 'lc', audioBitrate: 192, audioSampleRate: 48000, audioChannels: 2, unsharp: 2, denoise: 1, style: 2, rateMode: 'crf', targetFileSizeMb: 0 },
    },
    {
      id: 'enc-default-2', name: 'ProRes 422 HQ (MOV)', type: 'encode',
      params: { container: 'mov', videoCodec: 'prores', videoProfile: '422hq', crf: 23, preset: 'medium', tune: 'none', pixelFormat: 'yuv422p10le', scaleW: 1920, scaleH: 1080, fps: 25, keepRes: false, audioOnly: false, audioCodec: 'pcm_s16le', audioProfile: 'lc', audioBitrate: 192, audioSampleRate: 48000, audioChannels: 2, unsharp: 2, denoise: 1, style: 2, rateMode: 'crf', targetFileSizeMb: 0 },
    },
  ],
  mix: [{ id: 'mix-default-1', name: '广播响度 -24 LUFS', type: 'mix', params: { lnOn: true, lnI: -24, lnTp: -2, lnLra: 7, tpOn: true, cpTh: -27, cpGain: 5 } }],
  check: [{ id: 'check-default-1', name: '标准检测', type: 'check', params: { refEncPresetId: '', fpsTol: 0.5, recursive: true, blackDetect: true } }],
  screenshot: [{ id: 'shot-default-1', name: '1080p 截图', type: 'screenshot', params: { aspect: 'free', customRatio: '3:2', w: 1920, h: 1080 } }],
  segment: [{ id: 'seg-default-1', name: 'MOV 原始画质', type: 'segment', params: { w: 0, h: 0, fps: 25, fixedDur: false, fixedVal: 2 } }],
  gif: [{ id: 'gif-default-1', name: '小尺寸 480p', type: 'gif', params: { aspect: 'free', customRatio: '3:2', w: 480, h: 270, fps: 15, fixedDur: false, fixedVal: 2 } }],
  webp: [{ id: 'webp-default-1', name: '中等质量', type: 'webp', params: { aspect: 'free', customRatio: '3:2', w: 480, h: 270, fps: 15, quality: 75, fixedDur: false, fixedVal: 2 } }],
};

function genId(): string {
  return (crypto && crypto.randomUUID && crypto.randomUUID()) || `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clonePresets(list: Preset[]): Preset[] {
  return list.map((p) => ({ ...p, params: { ...p.params } }));
}

// 每个功能独立的内存预设列表（组件级共享，足以覆盖单页使用）
export function usePresets(type: PresetType) {
  const [presets, setPresets] = useState<Preset[]>(() => clonePresets(DEFAULT_PRESETS[type] || []));
  const addPreset = (p: Preset) => setPresets((prev) => [...prev, p]);
  const removePreset = (id: string) => setPresets((prev) => prev.filter((p) => p.id !== id));
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
    setPresets((prev) => prev.map((p) => (p.id === id
      ? { ...p, params: { ...params }, name: (name && String(name).trim()) || p.name }
      : p)));
  // 合并导入的预设：强制 type 为当前类型，并重新生成 id 避免与现有冲突
  const mergePresets = (list: Preset[]) => setPresets((prev) => [
    ...prev,
    ...list.filter((p) => p && p.params).map((p) => ({ ...p, id: genId(), type })),
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
  onClose: () => void;
  presets: Preset[];
  onSaveNew: (data: any) => void;              // data = { name, ...params }
  onUpdate: (id: string, data: any) => void;   // data = { name, ...params }
  onRemove: (id: string) => void;
  onImport: (list: Preset[]) => void;
  onExport: () => void;
  onReorder: (from: number, to: number) => void;
}

// 预设管理弹窗外壳：最左侧预设列表 + 列表下方操作按钮（新建/复制/删除/导入/导出），右侧为编辑区（children）
export function PresetManageDialog({
  title, presets, editingId, onSelect, onNew, onCopy, onDelete,
  onImport, onExport, onReorder, onClose, onSave, saveLabel, canSave = true, compact = false, children,
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
  onSave: () => void;
  saveLabel: string;
  canSave?: boolean;
  /** 窄版：用于字段较少的功能（检测/截图等），宽度贴合内容，避免右侧大空白 */
  compact?: boolean;
  children: React.ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const onDragStart = (i: number) => (e: React.DragEvent) => {
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
    if (dragIndex !== null && dragIndex !== i) onReorder(dragIndex, i);
    setDragIndex(null);
    setOverIndex(null);
  };
  const onDragEnd = () => { setDragIndex(null); setOverIndex(null); };

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
    <div className="se-dialog-backdrop" onClick={onClose}>
      <div className={`se-dialog se-preset-dialog${compact ? ' se-preset-dialog--compact' : ''}`} onClick={(e) => e.stopPropagation()}>
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
                {presets.length === 0 && <div className="se-preset-list-empty">暂无预设</div>}
                {presets.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    draggable
                    className={[
                      'se-preset-list-item',
                      editingId === p.id ? 'active' : '',
                      dragIndex === i ? 'dragging' : '',
                      overIndex === i && dragIndex !== i ? 'drag-over' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => onSelect(p.id)}
                    onDragStart={onDragStart(i)}
                    onDragOver={onDragOver(i)}
                    onDrop={onDrop(i)}
                    onDragEnd={onDragEnd}
                    title={`${p.name}（拖拽可调整顺序）`}
                  >
                    <span className="se-preset-grip" aria-hidden>⋮⋮</span>
                    <span className="se-preset-list-name">{p.name}</span>
                  </button>
                ))}
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
            <ui.Button icon={<IconClose size={14} />} onClick={onClose}>取消</ui.Button>
            <ui.Button primary disabled={!canSave} icon={<IconCheckShield size={14} />} onClick={onSave}>{saveLabel}</ui.Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 通用预设构建器（schema 驱动），用于除 encode 外的所有功能
function GenericPresetBuilder({ type, ctx, initial }: {
  type: PresetType; ctx: PresetBuilderCtx; initial?: Record<string, any>;
}) {
  const schema = PRESET_SCHEMAS[type as Exclude<PresetType, 'encode'>] || [];
  const encPresets = usePresets('encode'); // 检测功能可选编码预设为规范基准
  const makeNew = () => Object.fromEntries(schema.map((d) => [d.key, initial && initial[d.key] !== undefined ? initial[d.key] : d.default]));
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
    setForm(Object.fromEntries(schema.map((d) => [d.key, p.params[d.key] !== undefined ? p.params[d.key] : d.default])));
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

  if (!ctx.isOpen) return null;
  return (
    <PresetManageDialog
      title={`管理${TYPE_LABEL[type]}预设`}
      compact
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
      onSave={onSave}
      saveLabel={editingId ? '保存修改' : '保存预设'}
      canSave={!!String(name).trim()}
    >
      <div className="se-preset-name">
        <ui.FieldLabel>预设名称</ui.FieldLabel>
        <input className="se-drop-input" value={name} placeholder="例如：广播响度" onChange={(e) => setName(e.target.value)} />
      </div>
      <ui.FieldGrid>
        {type === 'check' && (
          <React.Fragment key="refEncPresetId">
            <ui.FieldLabel>编码规范</ui.FieldLabel>
            <ui.ComboBox
              value={form.refEncPresetId || ''}
              options={encPresets.presets.length
                ? [{ label: '(不指定)', value: '' }, ...encPresets.presets.map((p) => ({ label: p.name, value: p.id }))]
                : [{ label: '(无转码预设)', value: '' }]}
              onChange={(v) => set('refEncPresetId', v)}
            />
          </React.Fragment>
        )}
        {schema
          .filter((d) => d.key !== 'refEncPresetId' && !(d.key === 'customRatio' && form.aspect !== 'custom'))
          .map((d) => {
            // 自定义比例拆成两个输入框（宽比 / 高比），避免出现可删冒号的单文本框
            if (d.key === 'customRatio') {
              const [rw, rh] = parseCustomRatioParts(form.customRatio);
              return (
                <React.Fragment key={d.key}>
                  <ui.FieldLabel>宽比</ui.FieldLabel>
                  <ui.IntField value={rw} min={1} max={99} onChange={(v) => set('customRatio', `${v}:${rh}`)} />
                  <ui.FieldLabel>高比</ui.FieldLabel>
                  <ui.IntField value={rh} min={1} max={99} onChange={(v) => set('customRatio', `${rw}:${v}`)} />
                </React.Fragment>
              );
            }
            const disabled = (d.key === 'w' || d.key === 'h') && form.aspect === 'free';
            return (
          <React.Fragment key={d.key}>
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
              <ui.NumberField value={form[d.key]} min={d.min ?? 0} max={d.max ?? 9999} step={d.step ?? 1} suffix={d.hint} onChange={(v) => set(d.key, v)} />
            )}
            {d.kind === 'checkbox' && (
              <ui.Checkbox checked={!!form[d.key]} onChange={(v) => set(d.key, v)}>{d.hint || '启用'}</ui.Checkbox>
            )}
            {d.kind === 'text' && (
              <input className="se-drop-input" value={form[d.key]} onChange={(e) => set(d.key, e.target.value)} />
            )}
          </React.Fragment>
            );
          })}
      </ui.FieldGrid>
    </PresetManageDialog>
  );
}

// 当前参数预览卡片（只展示关键参数网格；预设名称与类型 tag 已移除，避免重复）
export function PresetCard({ type, params }: { type: PresetType; params: Record<string, any> | null }) {
  if (!params) return null;
  const p = params;
  let rows: { k: string; v: string }[];
  if (type === 'encode') {
    const codecLabel = (VIDEO_CODEC_LABEL[p.videoCodec] as string) || p.videoCodec || '—';
    const prof = p.videoProfile ? ` / ${p.videoProfile}` : '';
    const res = (p.scaleW && p.scaleH) ? `${p.scaleW}×${p.scaleH}` : '原始分辨率';
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
    } else {
      q = p.crf != null ? `CRF ${p.crf}` : '—';
      vbr = p.videoBitrate > 0 ? `${p.videoBitrate / 1000} Mbps` : (p.crf != null ? 'CRF（自动码率）' : '—');
    }
    const aLabel = (AUDIO_CODEC_LABEL[p.audioCodec] as string) || p.audioCodec || '—';
    let abr = '—';
    if (p.videoCodec === 'gif') abr = '无音频轨';
    else if (p.audioOnly || p.audioCodec === 'copy') abr = '复制音频流';
    else if (p.audioBitrate > 0) abr = `${p.audioBitrate} kbps`;
    rows = [
      { k: '封装', v: (p.container || '—').toUpperCase() },
      { k: '视频', v: `${codecLabel}${prof}` },
      { k: mode === 'filesize' ? '目标体积' : (mode === 'bitrate' ? '质量' : '质量'), v: q },
      { k: '视频码率', v: vbr },
      { k: '分辨率', v: res },
      { k: '帧率', v: p.fps != null ? `${p.fps} fps` : '—' },
      { k: '音频', v: aLabel },
      { k: '音频码率', v: abr },
      { k: '锐化', v: String(p.unsharp ?? '—') },
      { k: '降噪', v: String(p.denoise ?? '—') },
      { k: '风格', v: STYLE_LABEL[p.style] || String(p.style ?? '—') },
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
  } else {
    const isRatioType = type === 'screenshot' || type === 'gif' || type === 'webp';
    const schema = PRESET_SCHEMAS[type as Exclude<PresetType, 'encode'>] || [];
    rows = schema
      .filter((d) => !(isRatioType && d.key === 'customRatio' && p.aspect !== 'custom'))
      .map((d) => ({ k: d.label, v: fieldValueLabel(d, p[d.key]) }));
    // 检测功能：扩展显示编码规范对照项（由 CheckTab 通过 currentParams 传入）
    if (type === 'check') {
      if (p.refEncName) rows.push({ k: '对照预设', v: p.refEncName });
      if (p.refEncCodec) rows.push({ k: '期望编码器', v: p.refEncCodec });
      if (p.refEncRes) rows.push({ k: '期望分辨率', v: p.refEncRes });
      if (p.refEncFps > 0) rows.push({ k: '期望帧率', v: `${p.refEncFps} fps` });
    }
  }

  return (
    <div className="se-preset-card">
      <div className="se-preset-kv-grid">
        {rows.map((r, i) => (
          <div className="se-preset-kv" key={i}>
            <span className="se-preset-k">{r.k}</span>
            <span className="se-preset-v">{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 可嵌入任意 Tab 的预设管理器：下拉选择套用 + 「管理预设」入口 + 当前预设卡片
// renderBuilder 用于 encode（专属级联构建器）；其余功能用通用构建器
// 增删改查（新建/复制/编辑/删除/导入/导出）统一在「管理预设」弹窗内完成
export function PresetManager({ type, onApply, builderTitle, initialValues, currentParams, renderBuilder }: {
  type: PresetType;
  onApply: (params: any) => void;
  builderTitle?: string;
  initialValues?: Record<string, any>;
  /** 当前面板里实际会用于处理的参数（实时值）；传入后卡片展示实时值，并启用「更新当前预设」 */
  currentParams?: Record<string, any>;
  renderBuilder?: (ctx: PresetBuilderCtx) => React.ReactNode;
}) {
  const { presets, addPreset, removePreset, updatePreset, reorder, mergePresets, exportAll } = usePresets(type);
  const [selId, setSelId] = useState<string | null>(presets[0]?.id ?? null);
  const [open, setOpen] = useState(false);

  const sel = presets.find((p) => p.id === selId) ?? null;
  const options = presets.length
    ? presets.map((p) => ({ label: p.name, value: p.id }))
    : [{ label: '(无预设)', value: '' }];

  const onPick = (id: string) => {
    setSelId(id);
    if (!id) return;
    const p = presets.find((x) => x.id === id);
    if (p) onApply(p.params);
  };

  // 将面板当前的实时参数写回所选预设（无需打开管理弹窗）
  const onUpdateCurrent = () => {
    if (!selId || !currentParams) return;
    const p = presets.find((x) => x.id === selId);
    if (!p) return;
    updatePreset(selId, currentParams, p.name);
    onApply(currentParams);
  };

  const ctx: PresetBuilderCtx = {
    isOpen: open,
    onClose: () => setOpen(false),
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
      onApply(preset.params);
    },
    onUpdate: (id: string, raw: any) => {
      const { name: pName, ...params } = raw;
      updatePreset(id, params, pName);
      if (id === selId) onApply(params);
    },
    onRemove: (id: string) => {
      removePreset(id);
      if (id === selId) {
        const next = presets.filter((p) => p.id !== id)[0] ?? null;
        setSelId(next ? next.id : null);
        if (next) onApply(next.params);
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
        <ui.ComboBox value={selId ?? ''} options={options} onChange={onPick} />
        <PresetCard type={type} params={currentParams ?? sel?.params ?? null} />
      </div>
      <div className="se-preset-foot">
        <ui.Button className="se-btn-new" onClick={() => setOpen(true)} icon={<IconSettings size={15} />} title="管理预设">管理预设</ui.Button>
        <ui.Button className="se-btn-new" onClick={onUpdateCurrent} disabled={!selId || !currentParams} icon={<IconCheckShield size={15} />} title="将面板当前的实时参数保存到所选预设">更新当前预设</ui.Button>
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
const STYLE_LABEL: Record<number, string> = { 0: '无风格', 1: '实拍视频', 2: '动画类' };
