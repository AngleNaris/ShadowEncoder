// ShadowEncoder 复刻组件库 —— 1:1 对应原 PySide6 组件
// 配色 / 无圆角 / 过渡 全部沿用 theme.css 的设计 token
import React, { ReactNode, useState, useEffect, useRef } from 'react';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import {
  IconCaretDown, IconCaretUp, IconClose, IconDeselect, IconFile, IconFolder,
  IconSelectAll, IconTerminal, IconTrash, IconVideo,
} from './icons';

/* ── 面板（左固定 / 右自适应） ─────────────────────────────── */
export function LeftPanel({ alpha, children }: { alpha?: boolean; children: ReactNode }) {
  return <div className={`se-left${alpha ? ' alpha' : ''}`}>{children}</div>;
}
export function RightPanel({ alpha, children }: { alpha?: boolean; children: ReactNode }) {
  return <div className={`se-right${alpha ? ' alpha' : ''}`}>{children}</div>;
}
export function Splitter({ children }: { children: ReactNode }) {
  return <div className="se-splitter">{children}</div>;
}

/* ── 文本层级 ───────────────────────────────────────────────── */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="se-section-title">{children}</div>;
}
export function DetailLabel({ children }: { children: ReactNode }) {
  return <span className="se-detail-label">{children}</span>;
}
export function HintLabel({ children }: { children: ReactNode }) {
  return <span className="se-hint-label">{children}</span>;
}
export function WarnLabel({ children }: { children: ReactNode }) {
  return <div className="se-warn-label">{children}</div>;
}
export function VideoInfo({ children }: { children: ReactNode }) {
  return <div className="se-video-info">{children}</div>;
}

/* ── 卡片（InfoFrame / MetricFrame） ───────────────────────── */
export function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="se-card">
      {title ? <SectionTitle>{title}</SectionTitle> : null}
      {children}
    </div>
  );
}

/* ── 参数分组卡片（参数面板的基本组织单元） ────────────────── */
export function ParamGroup({ title, aside, children }: {
  title: string;
  /** 标题行右侧内容（开关、徽标等） */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="se-group">
      <header className="se-group-head">
        <span className="se-group-title">{title}</span>
        {aside}
      </header>
      <div className="se-group-body">{children}</div>
    </section>
  );
}

/* ── 参数网格（标签 + 控件） ───────────────────────────────── */
export function FieldGrid({ tight, children }: { tight?: boolean; children: ReactNode }) {
  return <div className={`se-field-grid${tight ? ' tight' : ''}`}>{children}</div>;
}
export function FieldLabel({ children }: { children: ReactNode }) {
  return <DetailLabel>{children}</DetailLabel>;
}

/* ── 数值输入（带步进器） ─────────────────────────────────── */
function clampStep(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
export function NumberField({
  value, min, max, step, decimals = 1, suffix, onChange, disabled, width,
}: {
  value: number; min: number; max: number; step?: number; decimals?: number; suffix?: string;
  onChange: (v: number) => void; disabled?: boolean; width?: number;
}) {
  const s = step ?? (decimals ? 1 / Math.pow(10, decimals) : 1);
  const inputRef = useRef<HTMLInputElement>(null);
  const bump = (dir: 1 | -1) => {
    const base = Number.isFinite(value) ? value : 0;
    const next = clampStep(base + dir * s, min, max);
    onChange(decimals ? parseFloat(next.toFixed(decimals)) : Math.round(next));
  };
  // 在输入框内滚动时：阻止页面滚动，并手动步进数值
  useEffect(() => {
    const el = inputRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      bump(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [value, min, max, s, disabled]);
  // 单位渲染在输入框内部、紧跟数字之后（隐藏镜像文本负责定位）
  const displayVal = Number.isFinite(value) ? value : 0;
  return (
    <div className={`se-num${suffix ? ' has-suffix' : ''}`} style={width ? { width } : undefined}>
      <div className="se-num-wrap">
        <input
          ref={inputRef}
          type="number"
          value={displayVal}
          min={min}
          max={max}
          step={s}
          disabled={disabled}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            onChange(Number.isFinite(v) ? clampStep(v, min, max) : min);
          }}
        />
        {suffix && (
          <span className="se-num-suffix-flow" aria-hidden>
            <span className="se-num-mirror">{String(displayVal)}</span>
            <span className="se-num-suffix-text">{suffix}</span>
          </span>
        )}
        <div className="se-num-steps">
          <button type="button" tabIndex={-1} disabled={disabled} onClick={() => bump(1)} title="增加">
            <IconCaretUp size={10} />
          </button>
          <button type="button" tabIndex={-1} disabled={disabled} onClick={() => bump(-1)} title="减少">
            <IconCaretDown size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}
export function IntField({
  value, min, max, step, onChange, disabled, width, suffix,
}: {
  value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; disabled?: boolean; width?: number; suffix?: string;
}) {
  const s = step ?? 1;
  const inputRef = useRef<HTMLInputElement>(null);
  const bump = (dir: 1 | -1) => {
    const base = Number.isFinite(value) ? value : 0;
    onChange(clampStep(base + dir * s, min, max));
  };
  useEffect(() => {
    const el = inputRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      bump(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [value, min, max, s, disabled]);
  // 单位渲染在输入框内部、紧跟数字之后（隐藏镜像文本负责定位）
  const displayInt = Number.isFinite(value) ? Math.round(value) : 0;
  return (
    <div className={`se-num${suffix ? ' has-suffix' : ''}`} style={width ? { width } : undefined}>
      <div className="se-num-wrap">
        <input
          ref={inputRef}
          type="number"
          value={displayInt}
          min={min}
          max={max}
          step={s}
          disabled={disabled}
          onChange={(e) => {
            const v = parseInt(e.target.value || '0', 10);
            onChange(Number.isFinite(v) ? clampStep(v, min, max) : min);
          }}
        />
        {suffix && (
          <span className="se-num-suffix-flow" aria-hidden>
            <span className="se-num-mirror">{String(displayInt)}</span>
            <span className="se-num-suffix-text">{suffix}</span>
          </span>
        )}
        <div className="se-num-steps">
          <button type="button" tabIndex={-1} disabled={disabled} onClick={() => bump(1)} title="增加">
            <IconCaretUp size={10} />
          </button>
          <button type="button" tabIndex={-1} disabled={disabled} onClick={() => bump(-1)} title="减少">
            <IconCaretDown size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 下拉框（MUI Select，深色直角主题） ────────────────────── */
export function ComboBox({
  value, options, onChange, minContents, disabled, placeholder,
}: {
  value: any; options: { label: string; value: any }[]; onChange: (v: any) => void;
  minContents?: number; disabled?: boolean;
  /** 空值时显示的占位文案（弱化颜色），默认「请选择」 */
  placeholder?: string;
}) {
  const valStr = value === undefined || value === null ? '' : String(value);
  const inRange = options.some((o) => String(o.value) === valStr);
  const handle = (raw: string) => {
    const found = options.find((o) => String(o.value) === raw);
    onChange(found ? found.value : raw);
  };
  return (
    <FormControl
      size="small"
      disabled={disabled}
      sx={{ minWidth: minContents ? minContents * 12 : 96 }}
    >
      <Select
        value={valStr}
        displayEmpty
        onChange={(e) => handle(e.target.value as string)}
        inputProps={{ 'aria-label': 'select' }}
        renderValue={(sel) => {
          const s = String(sel ?? '');
          if (s === '') return <span className="se-combo-placeholder">{placeholder ?? '请选择'}</span>;
          return options.find((o) => String(o.value) === s)?.label ?? s;
        }}
      >
        {!inRange && <MenuItem value={valStr} sx={{ display: 'none' }} />}
        {options.map((o) => (
          <MenuItem key={String(o.value)} value={String(o.value)}>
            {o.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

/* ── 勾选 / 单选（Material 方形指示器，隐藏原生控件） ─────── */
export function Checkbox({
  checked, onChange, children, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`se-check${disabled ? ' disabled' : ''}${checked ? ' is-checked' : ''}`}>
      <input
        type="checkbox"
        className="se-check-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="se-check-box" aria-hidden />
      <span className="se-detail-label">{children}</span>
    </label>
  );
}
export function Radio({
  checked, onToggle, children, disabled,
}: { checked: boolean; onToggle: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`se-radio${disabled ? ' disabled' : ''}${checked ? ' is-checked' : ''}`}>
      <input
        type="radio"
        className="se-check-input"
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle()}
      />
      <span className="se-radio-box" aria-hidden />
      <span className="se-detail-label">{children}</span>
    </label>
  );
}

/* ── 按钮 ─────────────────────────────────────────────────── */
export function Button({
  children, onClick, disabled, primary, minWidth, title, icon, className,
}: {
  children?: ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean;
  minWidth?: number; title?: string; icon?: ReactNode; className?: string;
}) {
  const cls = [primary ? 'primary' : '', icon ? 'se-btn-with-icon' : '', className || ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls || undefined}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={minWidth ? { minWidth } : undefined}
    >
      {icon}
      {children != null && children !== '' ? <span>{children}</span> : null}
    </button>
  );
}

/* ── 状态徽标 StatusBadge（状态点 + 文字） ────────────────── */
export function StatusBadge({ text, tone }: { text: string; tone: 'idle' | 'running' | 'success' | 'warning' | 'error' }) {
  return (
    <span className={`se-badge ${tone}`}>
      <span className="se-badge-dot" aria-hidden />
      {text}
    </span>
  );
}

/* ── 统一进度条：百分比 / 成败 / 剩余时间 / 详情 全部叠在条内 ── */
export function ProgressBar({
  value,
  detail,
  eta,
  pass,
  fail,
  height = 34,
}: {
  value: number;
  detail?: string;
  /** 剩余时间文案，如 "1:23" 或 "—" */
  eta?: string;
  pass?: number;
  fail?: number;
  /** 进度条高度，默认与统一控件高度 --ctrl-h 对齐 */
  height?: number;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const parts: string[] = [`${Math.round(pct)}%`];
  if (pass !== undefined) parts.push(`成功 ${pass}`);
  if (fail !== undefined) parts.push(`失败 ${fail}`);
  if (eta !== undefined) parts.push(`剩余 ${eta}`);
  if (detail) parts.push(detail);
  const label = parts.join('  ·  ');
  // 完成态着色：全部成功 → 绿；有失败 → 琥珀；进行中 → 紫 + 条纹流动
  const done = pct >= 100;
  const fillCls = done
    ? (fail && fail > 0 ? ' done-with-fail' : ' done')
    : pct > 0 ? ' active' : '';
  return (
    <div className="se-progress">
      <div className="se-progress-track" style={{ height }}>
        <div className={`se-progress-fill${fillCls}`} style={{ width: `${pct}%` }} />
        <div className="se-progress-label" title={label}>{label}</div>
      </div>
    </div>
  );
}

/* ── 通用空状态 ───────────────────────────────────────────── */
export function EmptyState({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="se-empty">
      {icon && <span className="se-empty-icon">{icon}</span>}
      <span className="se-empty-text">{text}</span>
    </div>
  );
}

/* ── 实时日志 ActivityLog ────────────────────────────────── */
function logTone(line: string): string {
  const s = line.trim();
  if (s.startsWith('[PASS]') || s.startsWith('✓')) return 'pass';
  if (s.startsWith('[FAIL]') || s.startsWith('✗') || s.startsWith('  E') || s.includes('错误')) return 'fail';
  if (s.startsWith('[PASS_WITH_WARNINGS]') || s.startsWith('  W') || s.includes('警告')) return 'warn';
  if (
    s.startsWith('日志已保存') || s.startsWith('输出位置') || s.startsWith('JSON 报告已写入') ||
    s.startsWith('开始时间') || s.startsWith('输入路径') || s.startsWith('检查目标') || s.startsWith('预设:')
  ) return 'muted';
  return 'normal';
}
export function LogView({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return (
      <div className="se-log" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <EmptyState icon={<IconTerminal size={26} />} text="暂无日志 · 运行任务后此处显示输出" />
      </div>
    );
  }
  return (
    <div className="se-log">
      {lines.map((l, i) => (
        <p key={i} className={`se-log-line ${logTone(l)}`}>{l}</p>
      ))}
    </div>
  );
}

/* ── 拖放输入框 DropLineEdit ─────────────────────────────── */
export function DropInput({
  value, placeholder, onDrop, readOnly, width,
}: { value: string; placeholder?: string; onDrop?: (p: string) => void; readOnly?: boolean; width?: number }) {
  const [drag, setDrag] = useState(false);
  return (
    <input
      className="se-drop-input"
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      onDragOver={(e) => { if (onDrop) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        setDrag(false);
        if (onDrop) {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          const path = (file as any)?.path || e.dataTransfer.getData('text/uri-list');
          if (path) onDrop(path.replace('file://', ''));
        }
      }}
      style={drag ? { border: '1px dashed var(--primary)', ...(width ? { width } : {}) } : (width ? { width } : undefined)}
    />
  );
}

/* ── 拖放文件列表 FileListWidget（支持勾选 + 单击激活预览） ── */
export function FileList({
  paths,
  selected,
  activePath,
  onDrop,
  onToggleSelect,
  onActivate,
  onRemove,
}: {
  paths: string[];
  selected: Set<string>;
  activePath?: string | null;
  onDrop: (p: string[]) => void;
  onToggleSelect: (p: string) => void;
  onActivate?: (p: string) => void;
  onRemove?: (p: string) => void;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`se-filelist se-filelist-shared${drag ? ' drag' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        setDrag(false);
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onDrop(files.map((f) => (f as any).path || f.name));
      }}
    >
      {paths.length === 0 && (
        <div className="se-filelist-placeholder">
          <IconVideo size={28} />
          <span>将文件拖动至此<br />或点击下方按钮选择</span>
        </div>
      )}
      <ul>
        {paths.map((p) => {
          const isDir = p.endsWith('/') || p.endsWith('\\');
          const name = p.split(/[/\\]/).filter(Boolean).pop() || p;
          const active = activePath === p;
          const checked = selected.has(p);
          return (
            <li
              key={p}
              className={`${isDir ? 'dir' : 'file'}${active ? ' active' : ''}${checked ? ' checked' : ''}`}
              title={p}
              onClick={() => onActivate?.(p)}
            >
              <label className={`se-check se-check-sm${checked ? ' is-checked' : ''}`} onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="se-check-input"
                  checked={checked}
                  onChange={() => onToggleSelect(p)}
                />
                <span className="se-check-box" aria-hidden />
              </label>
              <span className="se-filelist-type" aria-hidden>
                {isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
              </span>
              <span className="se-filelist-name">{name}</span>
              {onRemove && (
                <button
                  type="button"
                  className="se-filelist-remove se-icon-btn"
                  title="从列表移除"
                  onClick={(e) => { e.stopPropagation(); onRemove(p); }}
                >
                  <IconClose size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── 共享素材侧栏 ─────────────────────────────────────────── */
export function SharedFilePanel({
  paths,
  selected,
  activePath,
  onDrop,
  onToggleSelect,
  onActivate,
  onRemove,
  onClear,
  onSelectAll,
  onClearSelection,
  onPickFile,
  onPickDir,
  disabled,
}: {
  paths: string[];
  selected: Set<string>;
  activePath: string | null;
  onDrop: (p: string[]) => void;
  onToggleSelect: (p: string) => void;
  onActivate: (p: string) => void;
  onRemove: (p: string) => void;
  onClear: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onPickFile: () => void;
  onPickDir: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="se-shared-files">
      <div className="se-panel-head">
        <span className="se-panel-title">素材列表</span>
        <span className="se-count-chip">{paths.length}</span>
      </div>
      <FileList
        paths={paths}
        selected={selected}
        activePath={activePath}
        onDrop={onDrop}
        onToggleSelect={onToggleSelect}
        onActivate={onActivate}
        onRemove={onRemove}
      />
      <div className="se-btn-grid">
        <Button disabled={disabled} onClick={onPickFile} icon={<IconFile size={15} />} title="选择文件">文件</Button>
        <Button disabled={disabled} onClick={onPickDir} icon={<IconFolder size={15} />} title="选择目录">目录</Button>
        <Button disabled={disabled || paths.length === 0} onClick={onSelectAll} icon={<IconSelectAll size={15} />} title="全选">全选</Button>
        <Button disabled={disabled || selected.size === 0} onClick={onClearSelection} icon={<IconDeselect size={15} />} title="取消勾选">取消</Button>
        <Button disabled={disabled || paths.length === 0} onClick={onClear} icon={<IconTrash size={15} />} title="清除列表" className="se-btn-span2 se-btn-danger">清除列表</Button>
      </div>
    </div>
  );
}
