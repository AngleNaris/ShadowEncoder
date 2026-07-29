export type WorkflowActionKind = 'backup' | 'transcode' | 'mix' | 'check';
export type WorkflowTriggerKind = 'manual' | 'removable';
export type WorkflowVolumeKind = 'removable' | 'any';
export type WorkflowFailureMode = 'stop' | 'continue';
export type WorkflowConditionKind =
  | 'source_has_media'
  | 'backup_destinations_fit'
  | 'last_step_succeeded'
  | 'last_backup_verified';

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
  failureMode: WorkflowFailureMode;
};

export type WorkflowCondition = {
  kind: WorkflowConditionKind;
  backupPresetId: string;
  reservePercent: number;
};

export type WorkflowConditionNode = {
  id: string;
  type: 'condition';
  condition: WorkflowCondition;
  thenSteps: WorkflowNode[];
  elseSteps: WorkflowNode[];
};

export type WorkflowNode = WorkflowActionNode | WorkflowConditionNode;

export type WorkflowDefinition = {
  trigger: WorkflowTrigger;
  steps: WorkflowNode[];
};

export const MAX_WORKFLOW_CONDITION_DEPTH = 3;

export const WORKFLOW_ACTION_LABELS: Record<WorkflowActionKind, string> = {
  backup: 'DIT · 备份',
  transcode: '批量 · 转码',
  mix: '批量 · 混音',
  check: '批量 · 检测',
};

export const WORKFLOW_CONDITION_LABELS: Record<WorkflowConditionKind, string> = {
  source_has_media: '来源中存在媒体文件',
  backup_destinations_fit: '备份预设的全部目标空间充足',
  last_step_succeeded: '上一步执行成功',
  last_backup_verified: '上一个备份已通过 MD5 校验',
};

let workflowNodeSequence = 0;

function workflowNodeId(prefix: string): string {
  workflowNodeSequence += 1;
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${workflowNodeSequence}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createWorkflowAction(
  kind: WorkflowActionKind = 'backup',
  presetId = '',
  presetRevision = 1,
): WorkflowActionNode {
  return {
    id: workflowNodeId('workflow-action'),
    type: 'action',
    kind,
    presetId,
    presetRevision,
    failureMode: 'stop',
  };
}

export function createWorkflowCondition(
  kind: WorkflowConditionKind = 'source_has_media',
): WorkflowConditionNode {
  return {
    id: workflowNodeId('workflow-condition'),
    type: 'condition',
    condition: {
      kind,
      backupPresetId: '',
      reservePercent: 10,
    },
    thenSteps: [],
    elseSteps: [],
  };
}

export const DEFAULT_WORKFLOW_DEFINITION: WorkflowDefinition = {
  trigger: {
    kind: 'manual',
    volumeKind: 'removable',
    labelContains: '',
    settleSeconds: 3,
  },
  steps: [],
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

function isActionKind(value: unknown): value is WorkflowActionKind {
  return value === 'backup' || value === 'transcode' || value === 'mix' || value === 'check';
}

function isConditionKind(value: unknown): value is WorkflowConditionKind {
  return value === 'source_has_media'
    || value === 'backup_destinations_fit'
    || value === 'last_step_succeeded'
    || value === 'last_backup_verified';
}

function normalizeWorkflowNodes(value: unknown, depth: number): WorkflowNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: WorkflowNode[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type === 'condition') {
      if (depth >= MAX_WORKFLOW_CONDITION_DEPTH) continue;
      const rawCondition = item.condition && typeof item.condition === 'object'
        ? item.condition as Record<string, unknown>
        : {};
      const kind = isConditionKind(rawCondition.kind) ? rawCondition.kind : 'source_has_media';
      nodes.push({
        id: text(item.id) || workflowNodeId('workflow-condition'),
        type: 'condition',
        condition: {
          kind,
          backupPresetId: text(rawCondition.backupPresetId),
          reservePercent: finiteNumber(rawCondition.reservePercent, 10, 0, 100),
        },
        thenSteps: normalizeWorkflowNodes(item.thenSteps, depth + 1),
        elseSteps: normalizeWorkflowNodes(item.elseSteps, depth + 1),
      });
      continue;
    }
    const kind = isActionKind(item.kind) ? item.kind : 'backup';
    nodes.push({
      id: text(item.id) || workflowNodeId('workflow-action'),
      type: 'action',
      kind,
      presetId: text(item.presetId),
      presetRevision: Math.max(1, Math.trunc(finiteNumber(item.presetRevision, 1, 1, Number.MAX_SAFE_INTEGER))),
      failureMode: item.failureMode === 'continue' ? 'continue' : 'stop',
    });
  }
  return nodes;
}

export function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!value || typeof value !== 'object') return cloneWorkflowDefinition(DEFAULT_WORKFLOW_DEFINITION);
  const raw = value as Record<string, unknown>;
  const trigger = raw.trigger && typeof raw.trigger === 'object'
    ? raw.trigger as Record<string, unknown>
    : {};
  const steps = normalizeWorkflowNodes(raw.steps, 0);
  return {
    trigger: {
      kind: trigger.kind === 'removable' ? 'removable' : 'manual',
      volumeKind: trigger.volumeKind === 'any' ? 'any' : 'removable',
      labelContains: text(trigger.labelContains),
      settleSeconds: finiteNumber(trigger.settleSeconds, 3, 1, 30),
    },
    steps,
  };
}

export function workflowNodeCounts(nodes: WorkflowNode[]): { actions: number; conditions: number } {
  let actions = 0;
  let conditions = 0;
  const visit = (items: WorkflowNode[]) => {
    for (const item of items) {
      if (item.type === 'action') actions += 1;
      else {
        conditions += 1;
        visit(item.thenSteps);
        visit(item.elseSteps);
      }
    }
  };
  visit(nodes);
  return { actions, conditions };
}

export function workflowDepth(nodes: WorkflowNode[]): number {
  let result = 0;
  const visit = (items: WorkflowNode[], depth: number) => {
    result = Math.max(result, depth);
    for (const item of items) {
      if (item.type === 'condition') {
        visit(item.thenSteps, depth + 1);
        visit(item.elseSteps, depth + 1);
      }
    }
  };
  visit(nodes, 0);
  return result;
}
