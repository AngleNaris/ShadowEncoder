import React from "react";

export interface ProgressBarProps {
  /** 0..100 */
  value: number;
  /** 当前步骤/文件名等详情 */
  detail?: string;
  /** 剩余时间文案 */
  eta?: string;
  pass?: number;
  fail?: number;
  /** 进度条高度，默认 36 */
  height?: number;
}

/**
 * 统一进度条：百分比 / 成败 / 剩余时间 / 详情叠在条内。
 * 与 ui.ProgressBar 保持一致，供需要单独引用的场景使用。
 */
export function ProgressBar({
  value,
  detail,
  eta,
  pass,
  fail,
  height = 34,
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  const parts: string[] = [`${Math.round(pct)}%`];
  if (pass !== undefined) parts.push(`成功 ${pass}`);
  if (fail !== undefined) parts.push(`失败 ${fail}`);
  if (eta !== undefined) parts.push(`剩余 ${eta}`);
  if (detail) parts.push(detail);
  const label = parts.join("  ·  ");
  return (
    <div className="se-progress">
      <div className="se-progress-track" style={{ height }}>
        <div className="se-progress-fill" style={{ width: `${pct}%` }} />
        <div className="se-progress-label" title={label}>{label}</div>
      </div>
    </div>
  );
}
