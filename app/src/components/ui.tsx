// ShadowEncoder 复刻组件库 —— 1:1 对应原 PySide6 组件
// 配色 / 无圆角 / 过渡 全部沿用 theme.css 的设计 token
import React, { ReactNode, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal, flushSync } from 'react-dom';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import {
  IconCaretDown, IconCaretUp, IconClose, IconDeselect, IconFile, IconFolder, IconList,
  IconPlus, IconSelectAll, IconTerminal, IconTrash, IconVideo,
} from './icons';
import type { TaskLogEvent, TaskLogTone } from '../lib/ffmpeg';
import { isTauriRuntime, probePath } from '../lib/ffmpeg';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { FileListItem } from '../lib/fileListContext';
import { filePathKey } from '../lib/fileTree';
import type { GroupSelectionState } from '../lib/taskBatches';
import { isMediaPath } from '../lib/mediaExtensions';
import { startMaterialDrag } from '../lib/materialDrag';

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
export type ContextMenuItem = {
  label: string;
  groupLabel?: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
};

export function ContextMenu({ open, x, y, items, onClose }: {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const lastItemsRef = useRef(items);
  const [mounted, setMounted] = useState(open);
  const [position, setPosition] = useState({ x, y, originX: 0, originY: 0 });
  if (open) lastItemsRef.current = items;

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const nextX = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8));
    const nextY = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8));
    setPosition({
      x: nextX,
      y: nextY,
      originX: Math.max(0, Math.min(bounds.width, x - nextX)),
      originY: Math.max(0, Math.min(bounds.height, y - nextY)),
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [mounted, open, x, y]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={menuRef}
      className={`se-context-menu${open ? '' : ' is-closing'}`}
      role="menu"
      aria-label="快捷菜单"
      style={{
        left: position.x,
        top: position.y,
        '--se-context-menu-origin-x': `${position.originX}px`,
        '--se-context-menu-origin-y': `${position.originY}px`,
      } as React.CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onAnimationEnd={(event) => {
        if (!open && event.target === event.currentTarget) setMounted(false);
      }}
    >
      {(open ? items : lastItemsRef.current).map((item, index) => (
        <React.Fragment key={`${item.label}-${index}`}>
          {item.groupLabel && <div className="se-context-menu-group-label" role="presentation">{item.groupLabel}</div>}
          <button
            type="button"
            role="menuitem"
            className={`${item.danger ? ' is-danger' : ''}${item.separatorBefore ? ' has-separator' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon && <span className="se-context-menu-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}

export function ParamGroup({ title, aside, children, defaultOpen = true }: {
  title: string;
  /** 标题行右侧内容（开关、徽标等） */
  aside?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const bodyId = React.useId();
  return (
    <section
      className={`se-group${open ? ' is-open' : ' is-collapsed'}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <header className="se-group-head">
        <button
          type="button"
          className="se-group-head-toggle"
          aria-label={open ? `收起${title}` : `展开${title}`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="se-group-title">{title}</span>
        </button>
        {aside && <span className="se-group-head-actions">{aside}</span>}
      </header>
      <AnimatedCollapse open={open}>
        <div id={bodyId} className="se-group-body">{children}</div>
      </AnimatedCollapse>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={[{ label: open ? '收起面板' : '展开面板', onSelect: () => setOpen((current) => !current) }]}
        onClose={() => setMenu(null)}
      />
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

/* ── 内容过渡：保留旧视图完成退场，再显示新视图 ─────────────── */
export function AnimatedSwitch({
  transitionKey, children, className,
}: {
  transitionKey: string | number;
  children: ReactNode;
  className?: string;
}) {
  const nextRef = useRef({ key: transitionKey, content: children });
  const [view, setView] = useState({ key: transitionKey, content: children, phase: 'in' as 'in' | 'out' });

  useEffect(() => {
    if (transitionKey === view.key) {
      if (view.phase !== 'out' && view.content !== children) {
        setView((current) => ({ ...current, content: children }));
      }
      return;
    }
    nextRef.current = { key: transitionKey, content: children };
    if (view.phase !== 'out') setView((current) => ({ ...current, phase: 'out' }));
  }, [children, transitionKey, view.content, view.key, view.phase]);

  return (
    <div
      className={`se-animated-switch se-panel-${view.phase}${className ? ` ${className}` : ''}`}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget || event.animationName !== 'se-panel-out' || view.phase !== 'out') return;
        setView({ key: nextRef.current.key, content: nextRef.current.content, phase: 'in' });
      }}
    >
      {view.content}
    </div>
  );
}

/* ── 内容折叠：退出动画结束后才卸载，避免参数面板突变 ─────── */
export function AnimatedCollapse({
  open, children, className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<'entering' | 'open' | 'exiting'>(open ? 'open' : 'exiting');
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

  useLayoutEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;

    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    if (open && !mounted) {
      setPhase('entering');
      setMounted(true);
      return;
    }
    if (!mounted) return;

    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (open) {
      const currentHeight = outer.getBoundingClientRect().height;
      const targetHeight = inner.scrollHeight;
      if (reducedMotion || targetHeight < 0.5) {
        outer.style.height = 'auto';
        outer.style.overflow = 'visible';
        setPhase('open');
        return;
      }

      outer.style.overflow = 'hidden';
      outer.style.height = `${currentHeight}px`;
      setPhase(currentHeight < 0.5 ? 'entering' : 'open');
      frameRef.current = requestAnimationFrame(() => {
        outer.style.height = `${inner.scrollHeight}px`;
        setPhase('open');
        frameRef.current = null;
      });
      return () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      };
    }

    const currentHeight = outer.getBoundingClientRect().height;
    if (reducedMotion || currentHeight < 0.5) {
      setMounted(false);
      return;
    }

    outer.style.overflow = 'hidden';
    outer.style.height = `${currentHeight}px`;
    setPhase('exiting');
    frameRef.current = requestAnimationFrame(() => {
      outer.style.height = '0px';
      frameRef.current = null;
    });
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [mounted, open]);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!mounted || !open || !outer || !inner || typeof ResizeObserver === 'undefined') return undefined;

    let measuredHeight = inner.scrollHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = inner.scrollHeight;
      if (Math.abs(nextHeight - measuredHeight) < 0.5) return;
      measuredHeight = nextHeight;
      if (outer.style.height && outer.style.height !== 'auto') {
        outer.style.height = `${nextHeight}px`;
      }
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [mounted, open]);

  if (!mounted) return null;
  return (
    <div
      ref={outerRef}
      className={`se-collapse is-${phase}${className ? ` ${className}` : ''}`}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== 'height') return;
        if (!open) setMounted(false);
        else {
          event.currentTarget.style.height = 'auto';
          event.currentTarget.style.overflow = 'visible';
        }
      }}
    >
      <div ref={innerRef} className="se-collapse-inner">{children}</div>
    </div>
  );
}

/* ── 局部值变化：只让新值进入，不让整行或整块内容闪烁 ──────── */
export function AnimatedValue({ value, className }: { value: ReactNode; className?: string }) {
  const animationKey = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return (
    <span className={className}>
      <span key={animationKey} className="se-value-update">{value}</span>
    </span>
  );
}

/* ── 自动高度：内容行数变化时平滑移动容器边界 ───────────────── */
export function AnimatedHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const nextHeight = inner.getBoundingClientRect().height;
    const previousHeight = lastHeight.current;
    lastHeight.current = nextHeight;
    if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 0.5) return;

    const runningHeight = animationRef.current ? outer.getBoundingClientRect().height : previousHeight;
    animationRef.current?.cancel();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      outer.style.height = 'auto';
      animationRef.current = null;
      return;
    }

    outer.style.height = `${runningHeight}px`;
    const animation = outer.animate(
      [{ height: `${runningHeight}px` }, { height: `${nextHeight}px` }],
      { duration: 160, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );
    animationRef.current = animation;
    animation.onfinish = () => {
      outer.style.height = 'auto';
      animationRef.current = null;
    };
  });

  useEffect(() => () => animationRef.current?.cancel(), []);

  return (
    <div ref={outerRef} className={`se-auto-height${className ? ` ${className}` : ''}`}>
      <div ref={innerRef} className="se-auto-height-inner">{children}</div>
    </div>
  );
}

type AnimatedListEntry<T> = {
  item: T;
  index: number;
  state: 'stable' | 'entering' | 'exiting';
  exitBox?: AnimatedListExitBox;
};

type AnimatedListPosition = {
  top: number;
  left: number;
};

type AnimatedListExitBox = AnimatedListPosition & {
  width: number;
  height: number;
};

const ROW_MOTION_DURATION_MS = 160;
const ROW_MOTION_FALLBACK_MS = ROW_MOTION_DURATION_MS + 40;
const ROW_MOTION_EASING = 'cubic-bezier(0.2, 0.7, 0.3, 1)';

export function AnimatedList<T>({ items, getKey, renderItem, className, itemClassName, empty, layout = 'stack', tail, onClick }: {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  itemClassName?: string;
  empty?: ReactNode;
  layout?: 'stack' | 'flow' | 'wrap';
  tail?: ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const [entries, setEntries] = useState<AnimatedListEntry<T>[]>(() => (
    items.map((item, index) => ({ item, index, state: 'stable' }))
  ));
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const positions = useRef(new Map<string, AnimatedListPosition>());
  const previousOrder = useRef<string[]>([]);
  const moveAnimations = useRef(new Map<string, Animation>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const heightAnimation = useRef<Animation | null>(null);
  const pendingFlowHeight = useRef<number | null>(null);
  const enterTimers = useRef(new Map<string, number>());
  const exitTimers = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    pendingFlowHeight.current = layout !== 'stack' && listRef.current
      ? listRef.current.getBoundingClientRect().height
      : null;
    setEntries((current) => {
      const activeByKey = new Map(
        current
          .filter((entry) => entry.state !== 'exiting')
          .map((entry) => [getKey(entry.item), entry]),
      );
      const nextKeys = new Set(items.map(getKey));
      const next = items.map((item, index): AnimatedListEntry<T> => {
        const existing = activeByKey.get(getKey(item));
        return existing
          ? { item, index, state: existing.state === 'entering' ? 'entering' : 'stable' }
          : { item, index, state: 'entering' };
      });
      const merged = [...next];
      current.forEach((entry, oldIndex) => {
        const key = getKey(entry.item);
        if (nextKeys.has(key)) return;
        const node = itemRefs.current.get(key);
        const exitBox = entry.exitBox ?? (layout !== 'stack' && node ? {
          top: node.offsetTop,
          left: node.offsetLeft,
          width: node.offsetWidth,
          height: node.offsetHeight,
        } : undefined);
        const exitingEntry = { ...entry, state: 'exiting' as const, exitBox };
        const nextAnchor = current
          .slice(oldIndex + 1)
          .find((candidate) => nextKeys.has(getKey(candidate.item)));
        if (nextAnchor) {
          const anchorIndex = merged.findIndex((candidate) => (
            getKey(candidate.item) === getKey(nextAnchor.item)
          ));
          merged.splice(anchorIndex < 0 ? merged.length : anchorIndex, 0, exitingEntry);
          return;
        }
        const previousAnchor = current
          .slice(0, oldIndex)
          .reverse()
          .find((candidate) => nextKeys.has(getKey(candidate.item)));
        if (!previousAnchor) {
          merged.push(exitingEntry);
          return;
        }
        let insertionIndex = merged.findIndex((candidate) => (
          getKey(candidate.item) === getKey(previousAnchor.item)
        )) + 1;
        while (insertionIndex > 0 && merged[insertionIndex]?.state === 'exiting') insertionIndex += 1;
        merged.splice(insertionIndex, 0, exitingEntry);
      });
      if (merged.length === 0) {
        return current.length === 0 ? current : merged;
      }
      const unchanged = current.length === merged.length && current.every((entry, index) => (
        getKey(entry.item) === getKey(merged[index].item)
        && entry.item === merged[index].item
        && entry.state === merged[index].state
        && entry.index === merged[index].index
      ));
      if (unchanged) pendingFlowHeight.current = null;
      return unchanged ? current : merged;
    });
  }, [items, layout]);

  useLayoutEffect(() => {
    moveAnimations.current.forEach((animation) => animation.cancel());
    moveAnimations.current.clear();

    const activeEntries = entries.filter((entry) => entry.state !== 'exiting');
    const activeKeys = activeEntries.map((entry) => getKey(entry.item));
    const nextPositions = new Map<string, AnimatedListPosition>();
    activeKeys.forEach((key) => {
      const node = itemRefs.current.get(key);
      if (node) nextPositions.set(key, { top: node.offsetTop, left: node.offsetLeft });
    });
    const sameKeys = previousOrder.current.length === activeKeys.length
      && previousOrder.current.every((key) => activeKeys.includes(key));
    const orderChanged = sameKeys && previousOrder.current.some((key, index) => key !== activeKeys[index]);
    const pureReorder = orderChanged && entries.every((entry) => entry.state === 'stable');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fromHeight = pendingFlowHeight.current;
    pendingFlowHeight.current = null;
    if (layout !== 'stack' && listRef.current && fromHeight !== null) {
      const node = listRef.current;
      const previousHeightAnimation = heightAnimation.current;
      heightAnimation.current = null;
      previousHeightAnimation?.cancel();
      const targetHeight = node.offsetHeight;
      if (!reducedMotion && Math.abs(fromHeight - targetHeight) >= 0.5) {
        node.style.overflow = 'hidden';
        node.style.willChange = 'height';
        const animation = node.animate(
          [{ height: `${fromHeight}px` }, { height: `${targetHeight}px` }],
          { duration: ROW_MOTION_DURATION_MS, easing: ROW_MOTION_EASING },
        );
        heightAnimation.current = animation;
        const finishHeightAnimation = () => {
          if (heightAnimation.current !== animation) return;
          heightAnimation.current = null;
          node.style.removeProperty('overflow');
          node.style.removeProperty('will-change');
        };
        animation.onfinish = finishHeightAnimation;
        animation.oncancel = finishHeightAnimation;
      } else {
        node.style.removeProperty('overflow');
        node.style.removeProperty('will-change');
      }
    }
    if ((pureReorder || layout !== 'stack') && !reducedMotion) {
      activeKeys.forEach((key) => {
        const node = itemRefs.current.get(key);
        const previous = positions.current.get(key);
        const nextPosition = nextPositions.get(key);
        if (!node || !previous || !nextPosition) return;
        const dx = previous.left - nextPosition.left;
        const dy = previous.top - nextPosition.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        const animation = node.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: ROW_MOTION_DURATION_MS, easing: ROW_MOTION_EASING },
        );
        moveAnimations.current.set(key, animation);
        animation.onfinish = () => {
          if (moveAnimations.current.get(key) === animation) moveAnimations.current.delete(key);
        };
        animation.oncancel = animation.onfinish;
      });
    }
    positions.current = nextPositions;
    previousOrder.current = activeKeys;
  }, [entries, layout]);

  useEffect(() => {
    const enteringKeys = new Set(
      entries.filter((entry) => entry.state === 'entering').map((entry) => getKey(entry.item)),
    );
    enterTimers.current.forEach((timer, key) => {
      if (enteringKeys.has(key)) return;
      window.clearTimeout(timer);
      enterTimers.current.delete(key);
    });
    enteringKeys.forEach((key) => {
      if (enterTimers.current.has(key)) return;
      const timer = window.setTimeout(() => {
        enterTimers.current.delete(key);
        setEntries((current) => current.map((entry) => (
          getKey(entry.item) === key && entry.state === 'entering'
            ? { ...entry, state: 'stable' }
            : entry
        )));
      }, ROW_MOTION_DURATION_MS);
      enterTimers.current.set(key, timer);
    });

    const exitingKeys = new Set(
      entries.filter((entry) => entry.state === 'exiting').map((entry) => getKey(entry.item)),
    );
    exitTimers.current.forEach((timer, key) => {
      if (exitingKeys.has(key)) return;
      window.clearTimeout(timer);
      exitTimers.current.delete(key);
    });
    exitingKeys.forEach((key) => {
      if (exitTimers.current.has(key)) return;
      const timer = window.setTimeout(() => {
        exitTimers.current.delete(key);
        setEntries((current) => current.filter((entry) => getKey(entry.item) !== key));
      }, ROW_MOTION_FALLBACK_MS);
      exitTimers.current.set(key, timer);
    });
  }, [entries]);

  useEffect(() => () => {
    moveAnimations.current.forEach((animation) => animation.cancel());
    heightAnimation.current?.cancel();
    enterTimers.current.forEach((timer) => window.clearTimeout(timer));
    exitTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const showEmpty = items.length === 0 && empty != null;
  if (entries.length === 0 && tail == null && !showEmpty) return null;
  return (
    <div ref={listRef} onClick={onClick} className={[
      'se-animated-list',
      layout === 'flow' ? 'se-animated-list--flow' : '',
      layout === 'wrap' ? 'se-animated-list--wrap' : '',
      className || '',
    ].filter(Boolean).join(' ')}>
      {entries.map((entry) => {
        const key = getKey(entry.item);
        const exitStyle: React.CSSProperties | undefined = (
          layout !== 'stack' && entry.state === 'exiting' && entry.exitBox
        ) ? {
            position: 'absolute',
            top: entry.exitBox.top,
            left: entry.exitBox.left,
            width: entry.exitBox.width,
            height: entry.exitBox.height,
          }
          : undefined;
        return (
          <div
            key={key}
            style={exitStyle}
            ref={(node) => {
              if (node) itemRefs.current.set(key, node);
              else itemRefs.current.delete(key);
            }}
            className={[
              'se-animated-list-item',
              itemClassName || '',
              entry.state === 'entering' ? 'is-entering' : '',
              entry.state === 'exiting' ? 'is-exiting' : '',
            ].filter(Boolean).join(' ')}
            onAnimationEnd={(event) => {
              if (event.target !== event.currentTarget || entry.state !== 'entering') return;
              setEntries((current) => current.map((currentEntry) => (
                getKey(currentEntry.item) === key
                  ? { ...currentEntry, state: 'stable' }
                  : currentEntry
              )));
            }}
            onTransitionEnd={(event) => {
              const exitProperty = layout === 'stack' ? 'grid-template-rows' : 'opacity';
              if (event.target !== event.currentTarget || entry.state !== 'exiting' || event.propertyName !== exitProperty) return;
              const timer = exitTimers.current.get(key);
              if (timer !== undefined) window.clearTimeout(timer);
              exitTimers.current.delete(key);
              setEntries((current) => current.filter((currentEntry) => getKey(currentEntry.item) !== key));
            }}
          >
            <div className="se-animated-list-item-inner">
              <div className="se-animated-list-item-content">
                {renderItem(entry.item, entry.index)}
              </div>
            </div>
          </div>
        );
      })}
      {showEmpty ? (
        <div className={`se-animated-list-empty${entries.length > 0 ? ' is-entering' : ''}`}>
          <div className="se-animated-list-empty-inner">{empty}</div>
        </div>
      ) : null}
      {tail}
    </div>
  );
}

export type AnimatedFieldRow = {
  id: string;
  content: ReactNode;
};

export function AnimatedFieldGrid({ rows, tight }: { rows: AnimatedFieldRow[]; tight?: boolean }) {
  return (
    <AnimatedList
      items={rows}
      getKey={(row) => row.id}
      className={`se-field-grid${tight ? ' tight' : ''}`}
      itemClassName="se-field-row-motion"
      layout="flow"
      renderItem={(row) => row.content}
    />
  );
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
            <span className="se-num-suffix-baseline">
              <span className="se-num-mirror">{String(displayVal)}</span>
              <span className="se-num-suffix-text">{suffix}</span>
            </span>
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
            <span className="se-num-suffix-baseline">
              <span className="se-num-mirror">{String(displayInt)}</span>
              <span className="se-num-suffix-text">{suffix}</span>
            </span>
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
export type ComboBoxOption = {
  label: string;
  value: any;
  tags?: readonly (string | number)[];
  group?: string;
};

function ComboBoxOptionContent({
  option,
  tagAreaWidth,
}: {
  option: ComboBoxOption;
  tagAreaWidth?: number;
}) {
  const tags = (option.tags ?? []).filter((tag) => String(tag).trim().length > 0);
  return (
    <span className="se-combo-option">
      <span className="se-combo-option-label">{option.label}</span>
      {tags.length > 0 && (
        <span
          className="se-combo-option-tags"
          style={tagAreaWidth ? { width: tagAreaWidth } : undefined}
          aria-hidden
        >
          {tags.map((tag, index) => (
            <span className="se-combo-option-tag" key={`${String(tag)}-${index}`}>
              {tag}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export function ComboBox({
  value, options, onChange, minContents, menuTagAreaWidth, disabled, placeholder,
}: {
  value: any; options: readonly ComboBoxOption[]; onChange: (v: any) => void;
  minContents?: number; menuTagAreaWidth?: number; disabled?: boolean;
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
          const selected = options.find((o) => String(o.value) === s);
          return selected ? <ComboBoxOptionContent option={selected} /> : s;
        }}
      >
        {!inRange && <MenuItem value={valStr} sx={{ display: 'none' }} />}
        {options.flatMap((o, index) => {
          const items: React.ReactNode[] = [];
          if (o.group && (index === 0 || options[index - 1]?.group !== o.group)) {
            items.push(<ListSubheader key={`group-${o.group}`} className="se-combo-group" disableSticky>{o.group}</ListSubheader>);
          }
          items.push(
            <MenuItem key={String(o.value)} value={String(o.value)}>
              <ComboBoxOptionContent option={o} tagAreaWidth={menuTagAreaWidth} />
            </MenuItem>,
          );
          return items;
        })}
      </Select>
    </FormControl>
  );
}

/* ── 勾选 / 单选（Material 方形指示器，隐藏原生控件） ─────── */
export function Checkbox({
  checked, onChange, children, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  const hasLabel = children !== '';
  return (
    <label className={`se-check${hasLabel ? ' has-label' : ''}${disabled ? ' disabled' : ''}${checked ? ' is-checked' : ''}`}>
      <input
        type="checkbox"
        className="se-check-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="se-check-box" aria-hidden />
      {hasLabel ? <span className="se-detail-label">{children}</span> : null}
    </label>
  );
}
export function Radio({
  checked, onToggle, children, disabled,
}: { checked: boolean; onToggle: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`se-radio has-label${disabled ? ' disabled' : ''}${checked ? ' is-checked' : ''}`}>
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
  running = false,
  height = 34,
}: {
  value: number;
  detail?: string;
  /** 剩余时间文案，如 "1:23" 或 "—" */
  eta?: string;
  pass?: number;
  fail?: number;
  running?: boolean;
  /** 进度条高度，默认与统一控件高度 --ctrl-h 对齐 */
  height?: number;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const pristine = !running && pct === 0 && !pass && !fail && (!detail || detail === '尚未开始任务');
  const showEta = running && !!eta && eta !== '—';
  const parts: string[] = pristine ? ['尚未开始任务'] : [`${Math.round(pct)}%`];
  if (!pristine && pass && pass > 0) parts.push(`成功 ${pass}`);
  if (!pristine && fail && fail > 0) parts.push(`失败 ${fail}`);
  if (!pristine && showEta) parts.push(`剩余 ${eta}`);
  if (!pristine && detail && detail !== '尚未开始任务') parts.push(detail);
  const label = parts.join('  ·  ');
  const done = !running && pct >= 100;
  const fillCls = done
    ? (fail && fail > 0 ? ' done-with-fail' : ' done')
    : running && pct > 0 ? ' active' : '';
  return (
    <div className="se-progress">
      <div
        className={`se-progress-track${running ? ' is-running' : ''}${running && pct <= 0 ? ' is-preparing' : ''}`}
        style={{ height }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={label}
      >
        <div className={`se-progress-fill${fillCls}`} style={{ width: `${pct}%` }} />
        <div className="se-progress-label" title={label}>
          <span className="se-progress-label-text">{label}</span>
        </div>
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
type LogGroup = {
  header: TaskLogEvent;
  lines: TaskLogEvent[];
  status?: TaskLogEvent;
};

function buildLogBlocks(lines: TaskLogEvent[]): Array<{ kind: 'group'; group: LogGroup } | { kind: 'lines'; lines: TaskLogEvent[] }> {
  const blocks: Array<{ kind: 'group'; group: LogGroup } | { kind: 'lines'; lines: TaskLogEvent[] }> = [];
  let active: LogGroup | null = null;
  let loose: TaskLogEvent[] = [];
  const flushLoose = () => {
    if (loose.length > 0) blocks.push({ kind: 'lines', lines: loose });
    loose = [];
  };
  for (const event of lines) {
    if (event.kind === 'file_start') {
      flushLoose();
      active = { header: event, lines: [] };
      blocks.push({ kind: 'group', group: active });
    } else if (event.kind === 'file_end' && active) {
      active.status = event;
      active = null;
    } else if (active) {
      active.lines.push(event);
    } else {
      loose.push(event);
    }
  }
  flushLoose();
  return blocks;
}

function logEventTone(event: TaskLogEvent): string {
  return event.tone ?? logTone(event.message);
}

export function LogView({ lines }: { lines: TaskLogEvent[] }) {
  if (lines.length === 0) {
    return (
      <div className="se-log" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <EmptyState icon={<IconTerminal size={26} />} text="暂无日志 · 运行任务后此处显示输出" />
      </div>
    );
  }
  const blocks = buildLogBlocks(lines);
  return (
    <div className="se-log se-log-structured">
      {blocks.map((block, blockIndex) => block.kind === 'group' ? (
        <section className="se-log-card" key={`group-${blockIndex}-${block.group.header.queueIndex ?? 0}`}>
          <header className="se-log-card-head">
            <span className="se-log-card-index">
              {block.group.header.queueIndex ?? 1}/{block.group.header.queueTotal ?? 1}
            </span>
            <span className="se-log-card-name" title={block.group.header.sourcePath}>
              {block.group.header.filename || block.group.header.sourcePath || '未命名素材'}
            </span>
            {block.group.status && (
              <span className={`se-log-card-status ${logEventTone(block.group.status)}`}>
                {block.group.status.message}
              </span>
            )}
          </header>
          <div className="se-log-card-body">
            {block.group.lines.length > 0 ? block.group.lines.map((event, index) => (
              <p key={index} className={`se-log-line ${logEventTone(event)}`}>{event.message}</p>
            )) : (
              <p className="se-log-line muted">{block.group.header.message || '正在准备...'}</p>
            )}
          </div>
        </section>
      ) : (
        <div className="se-log-summary" key={`lines-${blockIndex}`}>
          {block.lines.map((event, index) => (
            <p key={index} className={`se-log-line ${logEventTone(event)}`}>{event.message}</p>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── 拖放输入框 DropLineEdit ─────────────────────────────── */
export function DropInput({
  value, placeholder, onDrop, onChange, readOnly, disabled, width, ariaLabel,
}: {
  value: string;
  placeholder?: string;
  onDrop?: (p: string) => void;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
  width?: number;
  ariaLabel?: string;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <input
      className="se-drop-input"
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange?.(event.target.value)}
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

export function TagInput({
  values,
  onChange,
  placeholder,
  disabled,
  normalize = (value) => value.trim(),
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  normalize?: (value: string) => string;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (raw = draft) => {
    const additions = raw
      .split(/[\s,;]+/)
      .map(normalize)
      .filter(Boolean);
    if (additions.length > 0) {
      const seen = new Set(values.map((value) => value.toLocaleLowerCase()));
      onChange([...values, ...additions.filter((value) => {
        const key = value.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })]);
    }
    setDraft('');
  };

  return (
    <AnimatedList
      items={values}
      getKey={(value) => value}
      renderItem={(value) => (
        <span className="se-tag-input-item">
          <span>{value}</span>
          <button
            type="button"
            title={`移除 ${value}`}
            aria-label={`移除 ${value}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onChange(values.filter((item) => item !== value));
            }}
          >
            <IconClose size={11} />
          </button>
        </span>
      )}
      className={`se-tag-input${disabled ? ' is-disabled' : ''}`}
      itemClassName="se-tag-input-motion-item"
      layout="wrap"
      onClick={() => inputRef.current?.focus()}
      tail={(
        <input
          ref={inputRef}
          value={draft}
          placeholder={values.length === 0 ? placeholder : undefined}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === ',' || event.key === ';') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && draft.length === 0 && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
        />
      )}
    />
  );
}

/* ── 拖放文件列表 FileListWidget（支持勾选 + 单击激活预览） ── */
function updateFileNameMarquee(row: HTMLLIElement, active: boolean) {
  const viewport = row.querySelector<HTMLElement>('.se-filelist-name');
  const text = row.querySelector<HTMLElement>('.se-filelist-name-text');
  if (!viewport || !text) return;
  if (!active) {
    viewport.classList.remove('is-overflowing');
    return;
  }
  const distance = Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth));
  viewport.classList.toggle('is-overflowing', distance > 1);
  if (distance > 1) {
    viewport.style.setProperty('--se-file-name-offset', `-${distance}px`);
    viewport.style.setProperty('--se-file-name-duration', `${Math.max(3.6, distance / 28 + 1.8).toFixed(2)}s`);
  }
}

function fileListBranchRows(row: HTMLLIElement, includeRoot: boolean): HTMLLIElement[] {
  const depth = Number(row.dataset.treeDepth ?? 0);
  const rows = includeRoot ? [row] : [];
  let sibling = row.nextElementSibling;
  while (sibling instanceof HTMLLIElement) {
    const siblingDepth = Number(sibling.dataset.treeDepth ?? 0);
    if (siblingDepth <= depth) break;
    rows.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  return rows;
}

function animateFileListRowsOut(rows: HTMLLIElement[], onComplete: () => void) {
  if (rows.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    onComplete();
    return;
  }
  const animations = rows.map((row) => {
    row.dataset.seExiting = 'true';
    const height = row.getBoundingClientRect().height;
    return row.animate(
      [
        { height: `${height}px`, opacity: 1 },
        { height: '0px', opacity: 0 },
      ],
      { duration: ROW_MOTION_DURATION_MS, easing: ROW_MOTION_EASING, fill: 'forwards' },
    );
  });
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(onComplete);
}


type RowDrag = {
  kind: 'group' | 'member' | 'root' | 'sibling';
  key: string;
  path: string;
  label: string;
  groupId?: string;
  groupLabel?: string;
  parentPath?: string;
  isDirectory: boolean;
};

export function FileList({
  items = [],
  groups = [],
  hasSelection = false,
  activePath,
  onDrop,
  onToggleSelect,
  onToggleExpanded,
  onActivate,
  onOpen,
  onRemove,
  acceptsFile,
  onCreateGroup,
  onRenameGroup,
  onRemoveGroup,
  onRemoveSelectionFromGroup,
  onToggleGroupChecked,
  onRemoveGroupMember,
  onReorderRoots,
  onReorderSiblings,
  onReorderGroups,
  onReorderGroupMember,
  disabled = false,
}: {
  items?: FileListItem[];
  groups?: GroupSelectionState[];
  hasSelection?: boolean;
  activePath?: string | null;
  onDrop: (p: string[]) => void;
  onToggleSelect: (p: string) => void;
  onToggleExpanded: (p: string) => void;
  onActivate?: (p: string) => void;
  onOpen?: (p: string) => void;
  onRemove?: (p: string) => void;
  acceptsFile?: (path: string) => boolean;
  onCreateGroup?: () => void;
  onRenameGroup?: (id: string, label: string) => void;
  onRemoveGroup?: (id: string) => void;
  onRemoveSelectionFromGroup?: (id: string) => void;
  onToggleGroupChecked?: (id: string) => void;
  onRemoveGroupMember?: (groupId: string, path: string) => void;
  onReorderRoots?: (fromPath: string, toPath: string, placeAfter: boolean) => void;
  onReorderSiblings?: (parentPath: string, fromPath: string, toPath: string, placeAfter: boolean) => void;
  onReorderGroups?: (fromId: string, toId: string, placeAfter: boolean) => void;
  onReorderGroupMember?: (groupId: string, fromPath: string, toPath: string, placeAfter: boolean) => void;
  disabled?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const [contextItem, setContextItem] = useState<{
    item: FileListItem;
    x: number;
    y: number;
    groupId?: string;
    groupLabel?: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cancelMaterialDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelMaterialDrag.current?.(), [disabled]);

  // Tauri 下 wry 在 OS 层拦截文件拖放，HTML5 drop 事件收不到；改用 webview 拖放事件驱动。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // 事件坐标为相对 webview 客户区的物理像素，需换算成 CSS 像素再做命中测试。
    const hitTest = (position: { x: number; y: number }) => {
      const rect = listRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const x = position.x / window.devicePixelRatio;
      const y = position.y / window.devicePixelRatio;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    getCurrentWebview().onDragDropEvent((event) => {
      if (disabled) return;
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        setDrag(hitTest(payload.position));
      } else if (payload.type === 'leave') {
        setDrag(false);
      } else if (payload.type === 'drop') {
        setDrag(false);
        if (!hitTest(payload.position)) return;
        // 目录路径不带尾部分隔符，探测后按列表约定补上（Windows 用 '\'）；探测失败按文件处理。
        void Promise.all(payload.paths.map(async (raw) => {
          if (raw.endsWith('/') || raw.endsWith('\\')) return raw;
          try {
            const probe = await probePath(raw);
            return probe.exists && probe.is_directory ? `${raw}\\` : raw;
          } catch {
            return raw;
          }
        })).then((paths) => {
          if (paths.length) onDrop(paths);
        });
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [disabled, onDrop]);

  const [contextGroup, setContextGroup] = useState<{ group: GroupSelectionState; x: number; y: number } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; draft: string } | null>(null);
  const cancelRenameRef = useRef(false);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  /** 拖动中的行：直接改 transform 让它跟着指针走（不走 React 渲染，保证跟手）。 */
  const dragVisualRef = useRef<{ row: HTMLElement; grabOffset: number; translate: number } | null>(null);
  const gestureRef = useRef<{
    drag: RowDrag;
    pointerId: number;
    startX: number;
    startY: number;
    mode: 'pending' | 'reorder' | 'material' | 'ignored';
    down: PointerEvent;
    lastMove?: string;
    lastCommittedY?: number;
  } | null>(null);

  const memberKeys = useMemo(
    () => groups.flatMap((group) => group.members.map((member) => filePathKey(member.path))),
    [groups],
  );
  const coveredByGroup = useCallback((path: string) => {
    const key = filePathKey(path);
    return memberKeys.some((memberKey) => key === memberKey || key.startsWith(`${memberKey}/`));
  }, [memberKeys]);
  const ungroupedItems = useMemo(
    () => items.filter((item) => !coveredByGroup(item.path)),
    [coveredByGroup, items],
  );

  const dragOfItem = (item: FileListItem): RowDrag => (item.depth === 0
    ? { kind: 'root', key: item.path, path: item.path, label: item.name, isDirectory: item.isDirectory }
    : {
      kind: 'sibling',
      key: item.path,
      path: item.path,
      label: item.name,
      parentPath: item.parentPath ?? '',
      isDirectory: item.isDirectory,
    });

  const beginRowDrag = (event: React.PointerEvent, drag: RowDrag) => {
    if (disabled || event.button !== 0 || !event.isPrimary) return;
    if ((event.target as HTMLElement).closest('button, input, label')) return;
    // 拖动时不要选中行内文件名文本。
    event.preventDefault();
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    gestureRef.current = {
      drag,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      mode: 'pending',
      down: event.nativeEvent,
    };
  };

  const commitRowDrag = (drag: RowDrag, targetKey: string, placeAfter: boolean) => {
    if (drag.kind === 'group') onReorderGroups?.(drag.key, targetKey, placeAfter);
    else if (drag.kind === 'member') onReorderGroupMember?.(drag.groupId ?? '', drag.path, targetKey, placeAfter);
    else if (drag.kind === 'root') onReorderRoots?.(drag.path, targetKey, placeAfter);
    else onReorderSiblings?.(drag.parentPath ?? '', drag.path, targetKey, placeAfter);
  };
  const commitRowDragRef = useRef(commitRowDrag);
  commitRowDragRef.current = commitRowDrag;

  /** 同一容器内的行才允许互换：组↔组、同组成员、顶层↔顶层、同目录↔同目录。 */
  const dragContainerKey = (drag: RowDrag) => {
    if (drag.kind === 'group') return 'groups';
    if (drag.kind === 'member') return `members:${drag.groupId ?? ''}`;
    if (drag.kind === 'root') return 'roots';
    return `siblings:${drag.parentPath ?? ''}`;
  };
  const dragContainerKeyRef = useRef(dragContainerKey);
  dragContainerKeyRef.current = dragContainerKey;

  // 整行拖拽：列表内按 Y 轴实时换位（其它行立即让位），越过列表边界=拖素材进流程图。
  useEffect(() => {
    if (disabled) return undefined;
    const rowsOf = (containerKey: string) => Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-se-row]') ?? [],
    ).filter((row) => row.dataset.seContainer === containerKey);
    const move = (event: PointerEvent) => {
      const state = gestureRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.mode === 'pending') {
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 6) return;
        const rect = listRef.current?.getBoundingClientRect();
        const inside = Boolean(rect)
          && event.clientX >= rect!.left && event.clientX <= rect!.right
          && event.clientY >= rect!.top && event.clientY <= rect!.bottom;
        if (inside) {
          state.mode = 'reorder';
          setDraggingKey(state.drag.key);
          const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-se-row]') ?? [])
            .find((item) => item.dataset.seKey === state!.drag.key);
          // 永久摘掉在场行的入场动画：用类名开关会让所有行动画重启一次，松手时整列表重播。
          for (const each of Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-se-row]') ?? [])) {
            each.style.animation = 'none';
          }
          if (row) {
            const rect = row.getBoundingClientRect();
            dragVisualRef.current = { row, grabOffset: event.clientY - rect.top, translate: 0 };
            row.style.position = 'relative';
            row.style.zIndex = '2';
            row.style.pointerEvents = 'none';
            row.style.transition = 'none';
          }
        } else if ((state.drag.kind === 'root' || state.drag.kind === 'sibling') && !state.drag.isDirectory) {
          state.mode = 'material';
          cancelMaterialDrag.current?.();
          cancelMaterialDrag.current = startMaterialDrag(state.down, state.drag.path);
          return;
        } else {
          state.mode = 'ignored';
          return;
        }
      }
      if (state.mode !== 'reorder') return;
      const visual = dragVisualRef.current;
      const listRect = listRef.current?.getBoundingClientRect();
      if (visual && listRect) {
        const rect = visual.row.getBoundingClientRect();
        // rect 含当前 translate，先还原基准位置，再按指针落点求新的位移。
        const baseTop = rect.top - visual.translate;
        const minTranslate = listRect.top - baseTop;
        const maxTranslate = listRect.bottom - baseTop - rect.height;
        const wanted = event.clientY - visual.grabOffset - baseTop;
        visual.translate = Math.max(minTranslate, Math.min(wanted, Math.max(minTranslate, maxTranslate)));
        visual.row.style.transform = `translateY(${visual.translate}px)`;
      }
      const rows = rowsOf(dragContainerKeyRef.current(state.drag));
      const fromIndex = rows.findIndex((row) => row.dataset.seKey === state.drag.key);
      if (fromIndex < 0) return;
      const others = rows.filter((row) => row.dataset.seKey !== state.drag.key);
      if (others.length === 0) return;
      // 插入位置只看 Y：越过某行中线就排到它前面；越过最后一行就排到末尾。
      let insertAt = others.length;
      for (let index = 0; index < others.length; index += 1) {
        const rect = others[index].getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
          insertAt = index;
          break;
        }
      }
      if (insertAt === fromIndex) return;
      const placeAfter = insertAt >= others.length;
      const targetKey = (placeAfter ? others[others.length - 1] : others[insertAt]).dataset.seKey ?? '';
      if (!targetKey) return;
      const pair = `${targetKey}|${placeAfter}`;
      if (state.lastMove === pair) return;
      // 每次换位后必须再移动半个行高才允许下一次：否则指针早已越过下一行中线，会连跳两行。
      const rowHeight = visual?.row.getBoundingClientRect().height ?? 0;
      if (state.lastCommittedY !== undefined && rowHeight > 0
        && Math.abs(event.clientY - state.lastCommittedY) < rowHeight * 0.5) return;
      state.lastCommittedY = event.clientY;
      state.lastMove = pair;
      // 换位前后都在同一帧内量测：同步刷 DOM，避免等待帧里「新位置 + 旧位移」的闪跳。
      const beforeTop = new Map<HTMLElement, number>();
      for (const row of rows) beforeTop.set(row, row.getBoundingClientRect().top);
      flushSync(() => { commitRowDragRef.current(state.drag, targetKey, placeAfter); });
      const visualRow = dragVisualRef.current;
      const after = rowsOf(dragContainerKeyRef.current(state.drag));
      if (visualRow) {
        const rect = visualRow.row.getBoundingClientRect();
        const baseTop = rect.top - visualRow.translate;
        const prev = beforeTop.get(visualRow.row);
        if (prev !== undefined) {
          visualRow.translate = prev - baseTop;
          visualRow.row.style.transform = `translateY(${visualRow.translate}px)`;
        }
        // 重渲染可能覆盖行内样式：这里把拖动状态整体重刷一遍，避免这一行闪回基准位置。
        const row = visualRow.row;
        row.style.position = 'relative';
        row.style.zIndex = '2';
        row.style.pointerEvents = 'none';
        row.style.transition = 'none';
      }
      for (const row of after) {
        if (visualRow && row === visualRow.row) continue;
        const prev = beforeTop.get(row);
        if (prev === undefined) continue;
        const next = row.getBoundingClientRect().top;
        const delta = prev - next;
        // 位移≈0 的行不要动：清掉它会让仍在过渡中的行瞬间归位，表现为闪烁。
        if (Math.abs(delta) < 0.5) continue;
        row.style.transition = 'none';
        row.style.transform = `translateY(${delta}px)`;
        void row.offsetHeight;
        row.style.transition = 'transform 170ms cubic-bezier(0.2, 0.7, 0.3, 1)';
        row.style.transform = '';
      }
    };
    const releaseRow = () => {
      const visual = dragVisualRef.current;
      dragVisualRef.current = null;
      setDraggingKey(null);
      if (!visual) return;
      visual.row.style.transform = '';
      visual.row.style.position = '';
      visual.row.style.zIndex = '';
      visual.row.style.pointerEvents = '';
      visual.row.style.transition = '';
    };
    const finish = (event: PointerEvent) => {
      const state = gestureRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      gestureRef.current = null;
      releaseRow();
    };
    const cancel = () => {
      gestureRef.current = null;
      releaseRow();
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      releaseRow();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [disabled]);

  const beginRename = (group: GroupSelectionState) => {
    if (disabled) return;
    cancelRenameRef.current = false;
    setRenamingGroup({ id: group.id, draft: group.label });
  };
  const commitRename = () => {
    if (!renamingGroup) return;
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenamingGroup(null);
      return;
    }
    const label = renamingGroup.draft.trim();
    if (label) onRenameGroup?.(renamingGroup.id, label);
    setRenamingGroup(null);
  };

  const rowClass = (item: FileListItem, drag: RowDrag, depth: number) => {
    const nonMedia = !item.isDirectory && !isMediaPath(item.path);
    const unsupported = !item.isDirectory && !!acceptsFile && !acceptsFile(item.path);
    return `${item.isDirectory ? 'dir' : 'file'}${activePath === item.path ? ' active' : ''}${item.checked ? ' checked' : ''}${item.indeterminate ? ' partial' : ''}${item.error ? ' has-error' : ''}${nonMedia ? ' is-non-media' : ''}${unsupported ? ' is-unsupported' : ''}${drag.kind === 'member' ? ' is-group-member' : ''}${draggingKey === drag.key ? ' is-dragging' : ''}`;
  };

  const renderRow = (item: FileListItem, drag: RowDrag, depth: number) => {
    const nonMedia = !item.isDirectory && !isMediaPath(item.path);
    const unsupported = !item.isDirectory && !!acceptsFile && !acceptsFile(item.path);
    return (
      <li
        key={drag.key}
        role="treeitem"
        data-se-row
        data-se-key={drag.key}
        data-se-container={dragContainerKey(drag)}
        data-se-row-kind={drag.kind}
        data-se-group-id={drag.groupId}
        data-se-parent-key={drag.parentPath}
        data-tree-depth={item.depth}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => beginRowDrag(event, drag)}
        aria-level={depth + 1}
        aria-expanded={item.isDirectory ? item.expanded : undefined}
        aria-disabled={unsupported || undefined}
        className={rowClass(item, drag, depth)}
        title={unsupported ? `当前功能不支持此素材\n${item.path}` : item.error ? `${item.path}\n${item.error}` : `${item.path}\n拖拽行可调整顺序`}
        style={{ '--tree-depth': depth } as React.CSSProperties}
        onClick={(event) => {
          if (disabled || unsupported) return;
          if (item.isDirectory && drag.kind !== 'member' && item.expanded) {
            const row = event.currentTarget;
            if (row.dataset.treeTransition === 'true') return;
            row.dataset.treeTransition = 'true';
            animateFileListRowsOut(fileListBranchRows(row, false), () => {
              delete row.dataset.treeTransition;
              onToggleExpanded(item.path);
            });
          } else if (item.isDirectory && drag.kind !== 'member') onToggleExpanded(item.path);
          else onActivate?.(item.path);
        }}
        onDoubleClick={(event) => {
          if (!disabled && !unsupported && !item.isDirectory && !(event.target as HTMLElement).closest('button, label')) onOpen?.(item.path);
        }}
        onMouseEnter={(event) => updateFileNameMarquee(event.currentTarget, true)}
        onMouseLeave={(event) => updateFileNameMarquee(event.currentTarget, false)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextItem({
            item,
            x: event.clientX,
            y: event.clientY,
            groupId: drag.groupId,
            groupLabel: drag.groupLabel,
          });
        }}
      >
        <label
          className={`se-check se-check-sm${item.checked ? ' is-checked' : ''}${item.indeterminate ? ' is-indeterminate' : ''}`}
          title={item.checked ? '取消勾选' : '勾选'}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            className="se-check-input"
            checked={item.checked}
            aria-checked={item.indeterminate ? 'mixed' : item.checked}
            disabled={disabled || unsupported}
            onChange={() => onToggleSelect(item.path)}
          />
          <span className="se-check-box" aria-hidden />
        </label>
        <span className="se-filelist-type" aria-hidden>
          {item.isDirectory ? <IconFolder size={16} /> : <IconFile size={16} />}
        </span>
        <span className="se-filelist-name">
          <span className="se-filelist-name-text">{item.name}</span>
        </span>
        {onRemove && item.removable && (
          <button
            type="button"
            className="se-filelist-remove se-icon-btn"
            title="从列表移除"
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              const row = event.currentTarget.closest<HTMLLIElement>('li[data-tree-depth]');
              if (!row || row.dataset.seExiting === 'true') return;
              animateFileListRowsOut(fileListBranchRows(row, true), () => onRemove(item.path));
            }}
          >
            <IconClose size={15} />
          </button>
        )}
      </li>
    );
  };

  const memberItem = (member: GroupSelectionState['members'][number]): FileListItem => ({
    path: member.path,
    name: member.name,
    isDirectory: member.isDirectory,
    parentPath: null,
    depth: 1,
    rootPath: member.path,
    checked: member.selected,
    indeterminate: false,
    expanded: false,
    loading: false,
    error: '',
    removable: false,
  });

  return (
    <div
      ref={listRef}
      className={`se-filelist se-filelist-shared${drag ? ' drag' : ''}${disabled ? ' is-readonly' : ''}`}
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        setDrag(false);
        if (disabled) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
          onDrop(files.map((file, index) => {
            let path = (file as any).path || file.name;
            const entry = (e.dataTransfer.items?.[index] as any)?.webkitGetAsEntry?.();
            if (entry?.isDirectory && !path.endsWith('/') && !path.endsWith('\\')) {
              path += path.includes('\\') ? '\\' : '/';
            }
            return path;
          }));
        }
      }}
    >
      {items.length === 0 && (
        <div className="se-filelist-placeholder">
          <IconVideo size={28} />
          <span>将文件拖动至此<br />或点击下方按钮选择</span>
        </div>
      )}
      <ul role="tree">
        {groups.map((group) => {
          return (
            <React.Fragment key={`group:${group.id}`}>
              <li
                data-se-row
                data-se-key={group.id}
                data-se-container="groups"
                data-se-row-kind="group"
                className={`se-group-row is-${group.state}`}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => beginRowDrag(event, { kind: 'group', key: group.id, path: group.id, label: group.label, isDirectory: true })}
                title={`${group.label}\n拖拽调整组顺序 · 双击重命名`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setContextGroup({ group, x: event.clientX, y: event.clientY });
                }}
              >
                <label
                  className={`se-check se-check-sm${group.state === 'checked' ? ' is-checked' : ''}${group.state === 'partial' ? ' is-indeterminate' : ''}`}
                  title={group.state === 'checked' ? `取消整组勾选（${group.label}）` : `勾选整组（${group.label}）`}
                >
                  <input
                    type="checkbox"
                    className="se-check-input"
                    checked={group.state === 'checked'}
                    aria-checked={group.state === 'partial' ? 'mixed' : group.state === 'checked'}
                    aria-label={`勾选分组 ${group.label}`}
                    disabled={disabled || !onToggleGroupChecked}
                    onChange={() => onToggleGroupChecked?.(group.id)}
                  />
                  <span className="se-check-box" aria-hidden />
                </label>
                <span className="se-filelist-type" aria-hidden>
                  <IconList size={16} />
                </span>
                {renamingGroup?.id === group.id ? (
                  <input
                    className="se-group-rename"
                    autoFocus
                    value={renamingGroup.draft}
                    aria-label="分组名称"
                    onChange={(event) => setRenamingGroup({ id: group.id, draft: event.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRenameRef.current = true;
                        setRenamingGroup(null);
                      }
                    }}
                  />
                ) : (
                  <span className="se-group-name" onDoubleClick={() => beginRename(group)}>{group.label}</span>
                )}
                <span className="se-group-count" title={`已勾选 ${group.selectedCount} / ${group.memberCount} 项`}>
                  {group.selectedCount}/{group.memberCount}
                </span>
              </li>
              {group.members.map((member) => renderRow(
                memberItem(member),
                {
                  kind: 'member',
                  key: member.path,
                  path: member.path,
                  label: member.name,
                  groupId: group.id,
                  groupLabel: group.label,
                  isDirectory: member.isDirectory,
                },
                1,
              ))}
            </React.Fragment>
          );
        })}
        {groups.length > 0 && ungroupedItems.length > 0 && (
          <li className="se-filelist-section" aria-hidden>未分组</li>
        )}
        {ungroupedItems.map((item) => renderRow(item, dragOfItem(item), item.depth))}
      </ul>
      <ContextMenu
        open={contextItem !== null}
        x={contextItem?.x ?? 0}
        y={contextItem?.y ?? 0}
        onClose={() => setContextItem(null)}
        items={contextItem ? [
          ...(contextItem.item.isDirectory ? [{
            label: contextItem.item.expanded ? '收起目录' : '展开目录',
            disabled,
            onSelect: () => onToggleExpanded(contextItem.item.path),
          }] : [
            { label: '设为当前素材', disabled: disabled || !onActivate, onSelect: () => onActivate?.(contextItem.item.path) },
            { label: '打开素材', disabled: disabled || !onOpen, onSelect: () => onOpen?.(contextItem.item.path) },
          ]),
          {
            label: contextItem.item.checked ? '取消勾选' : '勾选',
            disabled: disabled || (!contextItem.item.isDirectory && !!acceptsFile && !acceptsFile(contextItem.item.path)),
            separatorBefore: true,
            onSelect: () => onToggleSelect(contextItem.item.path),
          },
          {
            label: '分为一组',
            disabled: disabled || !hasSelection || !onCreateGroup,
            onSelect: () => onCreateGroup?.(),
          },
          ...(contextItem.groupId && onRemoveGroupMember ? [{
            label: `移出分组${contextItem.groupLabel ? `「${contextItem.groupLabel}」` : ''}`,
            disabled,
            onSelect: () => onRemoveGroupMember(contextItem.groupId!, contextItem.item.path),
          }] : []),
          ...(onRemove && contextItem.item.removable ? [{
            label: '从列表移除',
            danger: true,
            separatorBefore: true,
            disabled,
            onSelect: () => onRemove(contextItem.item.path),
          }] : []),
        ] : []}
      />
      <ContextMenu
        open={contextGroup !== null}
        x={contextGroup?.x ?? 0}
        y={contextGroup?.y ?? 0}
        onClose={() => setContextGroup(null)}
        items={contextGroup ? [
          { label: '重命名分组', disabled, onSelect: () => beginRename(contextGroup.group) },
          {
            label: '移出勾选素材',
            disabled: disabled || !hasSelection || !onRemoveSelectionFromGroup,
            onSelect: () => onRemoveSelectionFromGroup?.(contextGroup.group.id),
          },
          {
            label: '取消分组',
            danger: true,
            separatorBefore: true,
            disabled: disabled || !onRemoveGroup,
            onSelect: () => onRemoveGroup?.(contextGroup.group.id),
          },
        ] : []}
      />
    </div>
  );
}

/* ── 共享素材侧栏 ─────────────────────────────────────────── */
export function SharedFilePanel({
  items = [],
  totalCount = 0,
  selectedCount = 0,
  hasSelection = false,
  allSelected = false,
  groups = [],
  activePath,
  onDrop,
  onToggleSelect,
  onToggleExpanded,
  onActivate,
  onOpen,
  onRemove,
  onClear,
  onSelectAll,
  onClearSelection,
  onCreateGroup,
  onRenameGroup,
  onRemoveGroup,
  onRemoveSelectionFromGroup,
  onToggleGroupChecked,
  onRemoveGroupMember,
  onReorderRoots,
  onReorderSiblings,
  onReorderGroups,
  onReorderGroupMember,
  onPick,
  acceptsFile,
  disabled,
}: {
  items?: FileListItem[];
  totalCount?: number;
  selectedCount?: number;
  hasSelection?: boolean;
  allSelected?: boolean;
  groups?: GroupSelectionState[];
  activePath: string | null;
  onDrop: (p: string[]) => void;
  onToggleSelect: (p: string) => void;
  onToggleExpanded: (p: string) => void;
  onActivate: (p: string) => void;
  onOpen: (p: string) => void;
  onRemove: (p: string) => void;
  onClear: () => void;
  onSelectAll: () => void;
  onClearSelection?: () => void;
  onCreateGroup?: () => void;
  onRenameGroup?: (id: string, label: string) => void;
  onRemoveGroup?: (id: string) => void;
  onRemoveSelectionFromGroup?: (id: string) => void;
  onToggleGroupChecked?: (id: string) => void;
  onRemoveGroupMember?: (groupId: string, path: string) => void;
  onReorderRoots?: (fromPath: string, toPath: string, placeAfter: boolean) => void;
  onReorderSiblings?: (parentPath: string, fromPath: string, toPath: string, placeAfter: boolean) => void;
  onReorderGroups?: (fromId: string, toId: string, placeAfter: boolean) => void;
  onReorderGroupMember?: (groupId: string, fromPath: string, toPath: string, placeAfter: boolean) => void;
  onPick: () => void;
  acceptsFile?: (path: string) => boolean;
  disabled?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className="se-shared-files"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="se-panel-head">
        <span className="se-panel-title">素材列表</span>
        <span className="se-count-chip" title="已勾选 / 列表总数">{selectedCount}/{totalCount}</span>
      </div>
      <FileList
        items={items}
        groups={groups}
        hasSelection={hasSelection}
        activePath={activePath}
        onDrop={onDrop}
        onToggleSelect={onToggleSelect}
        onToggleExpanded={onToggleExpanded}
        onActivate={onActivate}
        onOpen={onOpen}
        onRemove={onRemove}
        acceptsFile={acceptsFile}
        onCreateGroup={onCreateGroup}
        onRenameGroup={onRenameGroup}
        onRemoveGroup={onRemoveGroup}
        onRemoveSelectionFromGroup={onRemoveSelectionFromGroup}
        onToggleGroupChecked={onToggleGroupChecked}
        onRemoveGroupMember={onRemoveGroupMember}
        onReorderRoots={onReorderRoots}
        onReorderSiblings={onReorderSiblings}
        onReorderGroups={onReorderGroups}
        onReorderGroupMember={onReorderGroupMember}
        disabled={disabled}
      />
      <div className="se-btn-grid">
        <Button disabled={disabled} onClick={onPick} icon={<IconPlus size={15} />} title="选择文件或目录" className="se-btn-span2">添加素材</Button>
        <Button
          disabled={disabled || items.length === 0}
          onClick={allSelected ? onClearSelection : onSelectAll}
          icon={allSelected ? <IconDeselect size={15} /> : <IconSelectAll size={15} />}
          title={allSelected ? '取消全部勾选' : '全选素材'}
        >
          {allSelected ? '全不选' : '全选'}
        </Button>
        <Button disabled={disabled || items.length === 0} onClick={onClear} icon={<IconTrash size={15} />} title="清除列表" className="se-btn-danger">清除列表</Button>
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={[
          { label: '添加素材', disabled, onSelect: onPick },
          {
            label: allSelected ? '取消全选' : '全选素材',
            disabled: disabled || items.length === 0,
            onSelect: allSelected ? () => onClearSelection?.() : onSelectAll,
          },
          {
            label: '分为一组',
            disabled: disabled || !hasSelection || !onCreateGroup,
            onSelect: () => onCreateGroup?.(),
          },
          { label: '清除列表', danger: true, separatorBefore: true, disabled: disabled || items.length === 0, onSelect: onClear },
        ]}
      />
    </div>
  );
}
