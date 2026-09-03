import { createWorkflowGraph, normalizeWorkflowGraph, type WorkflowGraph } from './workflowGraph.ts';

export type WorkflowActionKind = 'backup' | 'transcode' | 'mix' | 'check';
export type WorkflowTriggerKind = 'manual' | 'removable';
export type WorkflowVolumeKind = 'removable' | 'any';
export type WorkflowConditionKind =
  | 'source_has_media'
  | 'backup_destinations_fit'
  | 'upstream_steps_succeeded'
  | 'upstream_backup_verified';

export type WorkflowTrigger = {
  kind: WorkflowTriggerKind;
  volumeKind: WorkflowVolumeKind;
  labelContains: string;
  settleSeconds: number;
};

export type WorkflowActionNode = {
  id: string;
  type: 'action';
  kind: WorkflowActionKind;
  presetId: string;
  presetRevision: number;
};

export type WorkflowCondition = {
  kind: WorkflowConditionKind;
  backupPresetId: string;
  reservePercent: number;
};

export type WorkflowDefinition = {
  trigger: WorkflowTrigger;
  graph: WorkflowGraph;
};

export const WORKFLOW_ACTION_LABELS: Record<WorkflowActionKind, string> = {
  backup: 'DIT · 备份',
  transcode: '批量 · 转码',
  mix: '批量 · 混音',
  check: '批量 · 检测',
};

export const WORKFLOW_CONDITION_LABELS: Record<WorkflowConditionKind, string> = {
  source_has_media: '来源中存在媒体文件',
  backup_destinations_fit: '备份预设的全部目标空间充足',
  upstream_steps_succeeded: '全部上游步骤执行成功',
  upstream_backup_verified: '上游备份均通过 MD5 校验',
};

export const DEFAULT_WORKFLOW_DEFINITION: WorkflowDefinition = {
  trigger: {
    kind: 'manual',
    volumeKind: 'removable',
    labelContains: '',
    settleSeconds: 3,
  },
  graph: createWorkflowGraph(),
};

export function cloneWorkflowDefinition(value: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(value)) as WorkflowDefinition;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

export function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!value || typeof value !== 'object') return cloneWorkflowDefinition(DEFAULT_WORKFLOW_DEFINITION);
  const raw = value as Record<string, unknown>;
  const trigger = raw.trigger && typeof raw.trigger === 'object'
    ? raw.trigger as Record<string, unknown>
    : {};
  return {
    trigger: {
      kind: trigger.kind === 'removable' ? 'removable' : 'manual',
      volumeKind: trigger.volumeKind === 'any' ? 'any' : 'removable',
      labelContains: text(trigger.labelContains),
      settleSeconds: finiteNumber(trigger.settleSeconds, 3, 1, 30),
    },
    graph: normalizeWorkflowGraph(raw.graph),
  };
}
