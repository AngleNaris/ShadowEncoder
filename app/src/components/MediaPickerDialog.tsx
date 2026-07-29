import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconCaretDown,
  IconCaretUp,
  IconClose,
  IconFile,
  IconFolder,
  IconPlus,
  IconUpdate,
} from './icons';
import * as ui from './ui';
import {
  listMediaDirectory,
  type MediaBrowserEntry,
  type MediaBrowserListing,
} from '../lib/ffmpeg';

type SelectedMedia = Pick<MediaBrowserEntry, 'name' | 'path' | 'isDirectory'>;
type SortKey = 'name' | 'modified' | 'size' | 'type';
type SortDirection = 'asc' | 'desc';

const entryNameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});
const modifiedDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function selectionKey(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

function withDirectorySeparator(path: string): string {
  if (path.endsWith('/') || path.endsWith('\\')) return path;
  return path.includes('\\') ? `${path}\\` : `${path}/`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatModifiedTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : modifiedDateFormatter.format(date);
}

function entryTypeLabel(entry: MediaBrowserEntry): string {
  if (entry.isDirectory) return '文件夹';
  const dot = entry.name.lastIndexOf('.');
  const extension = dot > 0 && dot < entry.name.length - 1
    ? entry.name.slice(dot + 1).toLocaleUpperCase()
    : '';
  return extension ? `${extension} 文件` : '文件';
}

function compareOptionalNumber(
  left: number | null,
  right: number | null,
  direction: SortDirection,
): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return (left - right) * (direction === 'asc' ? 1 : -1);
}

function compareEntries(
  left: MediaBrowserEntry,
  right: MediaBrowserEntry,
  key: SortKey,
  direction: SortDirection,
): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  const factor = direction === 'asc' ? 1 : -1;
  let result = 0;
  if (key === 'name') result = entryNameCollator.compare(left.name, right.name) * factor;
  if (key === 'modified') {
    result = compareOptionalNumber(left.modifiedTimeMs, right.modifiedTimeMs, direction);
  }
  if (key === 'size') result = compareOptionalNumber(left.sizeBytes, right.sizeBytes, direction);
  if (key === 'type') {
    result = entryNameCollator.compare(entryTypeLabel(left), entryTypeLabel(right)) * factor;
  }
  return result || entryNameCollator.compare(left.name, right.name);
}

function SortButton({
  column,
  label,
  activeColumn,
  direction,
  onChange,
}: {
  column: SortKey;
  label: string;
  activeColumn: SortKey;
  direction: SortDirection;
  onChange: (column: SortKey) => void;
}) {
  const active = column === activeColumn;
  const directionLabel = active && direction === 'desc' ? '降序' : '升序';
  return (
    <button
      type="button"
      className={`se-media-picker-sort${active ? ' active' : ''}`}
      aria-label={`按${label}${active ? directionLabel : '排序'}`}
      aria-pressed={active}
      title={`按${label}排序`}
      onClick={() => onChange(column)}
    >
      <span>{label}</span>
      <span className="se-media-picker-sort-icon" aria-hidden>
        {active && (direction === 'asc' ? <IconCaretUp size={11} /> : <IconCaretDown size={11} />)}
      </span>
    </button>
  );
}

export function MediaPickerDialog({ open, onClose, onConfirm }: {
  open: boolean;
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
}) {
  const [listing, setListing] = useState<MediaBrowserListing | null>(null);
  const [selected, setSelected] = useState<Map<string, SelectedMedia>>(() => new Map());
  const [focusedPath, setFocusedPath] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const addressRef = useRef<HTMLInputElement>(null);

  const navigate = useCallback(async (path?: string | null) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const next = await listMediaDirectory(path);
      if (currentRequest !== requestId.current) return;
      setListing(next);
      setAddress(next.currentPath);
      setFocusedPath('');
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(new Map());
    setFocusedPath('');
    setListing(null);
    setAddress('');
    setError('');
    void navigate(null);
  }, [navigate, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  const toggle = (entry: SelectedMedia) => {
    const key = selectionKey(entry.path);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, entry);
      return next;
    });
  };

  const setEntrySelected = (entry: SelectedMedia, checked: boolean) => {
    const key = selectionKey(entry.path);
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(key, entry);
      else next.delete(key);
      return next;
    });
  };

  const sortedEntries = useMemo(() => (
    [...(listing?.entries ?? [])].sort((left, right) => (
      compareEntries(left, right, sortKey, sortDirection)
    ))
  ), [listing?.entries, sortDirection, sortKey]);

  const changeSort = (column: SortKey) => {
    if (column === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(column);
    setSortDirection('asc');
  };

  const confirm = () => {
    const paths = Array.from(selected.values()).map((item) => (
      item.isDirectory ? withDirectorySeparator(item.path) : item.path
    ));
    onConfirm(paths);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="se-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="se-dialog se-media-picker" role="dialog" aria-modal="true" aria-labelledby="se-media-picker-title">
        <div className="se-dialog-head">
          <div className="se-media-picker-title-group">
            <span className="se-dialog-title" id="se-media-picker-title">添加素材</span>
            <span className="se-count-chip">{selected.size}</span>
          </div>
          <button className="se-dialog-close" onClick={onClose} title="关闭">
            <IconClose size={14} />
          </button>
        </div>

        <div className="se-media-picker-toolbar">
          <ui.Button
            className="se-icon-btn"
            icon={<IconCaretUp size={14} />}
            title="上一级"
            disabled={!listing?.parentPath || loading}
            onClick={() => void navigate(listing?.parentPath)}
          />
          <form className="se-media-picker-address" onSubmit={(event) => {
            event.preventDefault();
            void navigate(address);
          }}>
            <input
              ref={addressRef}
              value={address}
              aria-label="当前目录"
              spellCheck={false}
              onChange={(event) => setAddress(event.target.value)}
            />
          </form>
          <ui.Button
            className="se-icon-btn"
            icon={<IconUpdate size={14} />}
            title="刷新"
            disabled={loading}
            onClick={() => void navigate(listing?.currentPath)}
          />
        </div>

        <div className="se-media-picker-body">
          <aside className="se-media-picker-roots" aria-label="磁盘位置">
            <span className="se-media-picker-side-title">位置</span>
            {(listing?.roots ?? []).map((root) => (
              <button
                type="button"
                key={root.path}
                className={listing?.currentPath.toLocaleLowerCase().startsWith(root.path.toLocaleLowerCase()) ? 'active' : ''}
                title={root.label}
                onClick={() => void navigate(root.path)}
              >
                <IconFolder size={14} />
                <span>{root.label}</span>
              </button>
            ))}
          </aside>

          <section className="se-media-picker-content" aria-busy={loading}>
            <div className="se-media-picker-list-viewport">
              <div className="se-media-picker-list-head" aria-label="排序方式">
                <SortButton column="name" label="名称" activeColumn={sortKey} direction={sortDirection} onChange={changeSort} />
                <SortButton column="modified" label="修改日期" activeColumn={sortKey} direction={sortDirection} onChange={changeSort} />
                <SortButton column="size" label="大小" activeColumn={sortKey} direction={sortDirection} onChange={changeSort} />
                <SortButton column="type" label="类型" activeColumn={sortKey} direction={sortDirection} onChange={changeSort} />
              </div>
              <div className="se-media-picker-list" role="listbox" aria-multiselectable="true">
                {!loading && sortedEntries.map((entry) => {
                  const checked = selected.has(selectionKey(entry.path));
                  const focused = focusedPath === entry.path;
                  return (
                    <div
                      className={`se-media-picker-entry${focused ? ' focused' : ''}${checked ? ' selected' : ''}`}
                      key={entry.path}
                      role="option"
                      aria-selected={checked}
                      tabIndex={0}
                      title={entry.path}
                      onClick={(event) => {
                        setFocusedPath(entry.path);
                        event.currentTarget.focus();
                      }}
                      onFocus={() => setFocusedPath(entry.path)}
                      onDoubleClick={() => {
                        if (entry.isDirectory) void navigate(entry.path);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === ' ') {
                          event.preventDefault();
                          toggle(entry);
                        } else if (event.key === 'Enter' && entry.isDirectory) {
                          void navigate(entry.path);
                        }
                      }}
                    >
                      <label className={`se-check se-check-sm${checked ? ' is-checked' : ''}`} onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="se-check-input"
                          checked={checked}
                          aria-label={`选择 ${entry.name}`}
                          onChange={(event) => setEntrySelected(entry, event.target.checked)}
                        />
                        <span className="se-check-box" aria-hidden />
                      </label>
                      <span className="se-media-picker-name">
                        {entry.isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
                        <span>{entry.name}</span>
                      </span>
                      <span className="se-media-picker-modified">{formatModifiedTime(entry.modifiedTimeMs)}</span>
                      <span className="se-media-picker-size">{formatBytes(entry.sizeBytes)}</span>
                      <span className="se-media-picker-kind">{entryTypeLabel(entry)}</span>
                    </div>
                  );
                })}
                {!loading && listing && sortedEntries.length === 0 && <ui.EmptyState text="此目录为空" />}
                {loading && <div className="se-media-picker-loading">正在读取目录...</div>}
              </div>
            </div>
            {error && <div className="se-media-picker-error">{error}</div>}
          </section>
        </div>

        <div className="se-dialog-foot">
          <div className="se-foot-actions">
            <ui.Button icon={<IconClose size={14} />} onClick={onClose}>取消</ui.Button>
            <ui.Button primary icon={<IconPlus size={14} />} disabled={selected.size === 0} onClick={confirm}>
              添加
            </ui.Button>
          </div>
        </div>
      </div>
    </div>
  );
}
