// 精简 SVG 图标（非 emoji），统一 16px stroke
import React from 'react';

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, strokeWidth = 2, children }: IconProps & { strokeWidth?: number | string; children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconFile({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </Svg>
  );
}

export function IconFolder({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </Svg>
  );
}

export function IconSelectAll({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <path d="M14 17.5l2 2 4-4" />
    </Svg>
  );
}

export function IconDeselect({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M8 12h8" />
    </Svg>
  );
}

export function IconTrash({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </Svg>
  );
}

export function IconClose({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconPlaySelected({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="6" height="16" />
      <path d="M12 6l9 6-9 6V6z" />
    </Svg>
  );
}

export function IconPlayAll({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 4l10 8-10 8V4z" />
      <path d="M19 4v16" />
    </Svg>
  );
}

export function IconStop({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="5" width="14" height="14" />
    </Svg>
  );
}

export function IconPlay({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M7 4l12 8-12 8V4z" />
    </Svg>
  );
}

export function IconPause({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="4" width="5" height="16" />
      <rect x="14" y="4" width="5" height="16" />
    </Svg>
  );
}

export function IconCropClear({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 2v4H2" />
      <path d="M18 22v-4h4" />
      <path d="M6 6h12v12" />
      <path d="M4 4l16 16" />
    </Svg>
  );
}

export function IconLock({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="10" width="14" height="11" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function IconUnlock({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="10" width="14" height="11" />
      <path d="M8 10V7a4 4 0 0 1 7.5-2" />
    </Svg>
  );
}

/* ── 功能导航图标（20px 使用，直角硬朗） ───────────────────── */

/** 转码：双向交换箭头 */
export function IconEncode({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 7h12l-3.5-3.5" />
      <path d="M20 17H8l3.5 3.5" />
    </Svg>
  );
}

/** 混音：三联推子 */
export function IconMix({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 3v18" />
      <path d="M12 3v18" />
      <path d="M18 3v18" />
      <rect x="4" y="7" width="4" height="3" />
      <rect x="10" y="13" width="4" height="3" />
      <rect x="16" y="5" width="4" height="3" />
    </Svg>
  );
}

/** 检测：盾牌 + 勾 */
export function IconCheckShield({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 3l7 2.5V11c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V5.5z" />
      <path d="M9 11.5l2 2 4-4.5" />
    </Svg>
  );
}

/** 透明通道：双层叠方 */
export function IconAlpha({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M17 7V4H4v13h3" />
      <rect x="7" y="7" width="13" height="13" />
    </Svg>
  );
}

/** 截图：四角对焦框 + 中心块 */
export function IconShot({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 8V3h5" />
      <path d="M16 3h5v5" />
      <path d="M21 16v5h-5" />
      <path d="M8 21H3v-5" />
      <rect x="10" y="10" width="4" height="4" />
    </Svg>
  );
}

/** 截取视频：胶片 + 切割线 */
export function IconClip({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M7 5v2.5M11 5v2.5M15 5v2.5M7 16.5V19M11 16.5V19M15 16.5V19" />
      <path d="M3 12h18" strokeDasharray="3 2.5" />
    </Svg>
  );
}

/** GIF：帧框 + 播放三角 */
export function IconGif({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M10 9.5l5 2.5-5 2.5V9.5z" />
    </Svg>
  );
}

/** WebP：图像（山形 + 角标） */
export function IconWebp({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M3 16l5.5-5 4 4 3-3 5.5 5.5" />
      <rect x="14" y="7" width="3" height="3" />
    </Svg>
  );
}

/** 检查更新：直角循环箭头 */
export function IconUpdate({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 3v5h-5" />
    </Svg>
  );
}

export function IconUndo({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 7H4v-5" />
      <path d="M4 7l4-4" />
      <path d="M4 7h10a6 6 0 0 1 0 12h-3" />
    </Svg>
  );
}

export function IconRedo({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M15 7h5v-5" />
      <path d="M20 7l-4-4" />
      <path d="M20 7H10a6 6 0 0 0 0 12h3" />
    </Svg>
  );
}

/* ── 数值步进器三角 ────────────────────────────────────────── */
export function IconCaretUp({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth="2.5">
      <path d="M7 15l5-6 5 6" />
    </Svg>
  );
}
export function IconCaretDown({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth="2.5">
      <path d="M7 9l5 6 5-6" />
    </Svg>
  );
}

/** 视频/空状态：胶片帧 */
export function IconVideo({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
    </Svg>
  );
}

/** 日志/终端空状态 */
export function IconTerminal({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M7 9l3 3-3 3" />
      <path d="M12 15h5" />
    </Svg>
  );
}

/** 新建（加号） */
export function IconPlus({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

/** 导出（方框+向上箭头） */
export function IconExport({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </Svg>
  );
}

/** 导入（方框+向下箭头） */
export function IconImport({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </Svg>
  );
}

/** 复制（两张重叠卡片） */
export function IconCopy({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="1" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Svg>
  );
}

/** 列表（三行条目） */
export function IconList({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3.5 6h.01" />
      <path d="M3.5 12h.01" />
      <path d="M3.5 18h.01" />
    </Svg>
  );
}

/** 管理 / 设置（齿轮） */
export function IconSettings({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/** 帮助 */
export function IconHelp({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.4 2.4 0 1 1 3.5 2.15c-.75.4-1.2.9-1.2 1.85" />
      <path d="M12 17h.01" />
    </Svg>
  );
}
