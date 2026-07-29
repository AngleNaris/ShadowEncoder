import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from './ffmpeg';
import {
  PRESET_TYPES,
  clonePresets,
  emptyPresetStore,
  type Preset,
  type PresetStore,
  type PresetType,
} from './presetStorage';

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_STATE_EVENT = 'shadowencoder://agent-state-changed';

export type AgentActor = 'agent' | 'gui' | 'system';

export type AgentReceipt = {
  operationId: string;
  sequence: number;
  entityRevision?: number;
  reversible: boolean;
  summary: string;
};

export type AgentStateChanged = {
  actor: AgentActor;
  receipt: AgentReceipt;
};

export type AgentSourceSnapshot = {
  id: string;
  path: string;
  selected: boolean;
  revision: number;
};

export type AgentTaskSnapshot = {
  id: string;
  function: 'encode' | 'mix' | 'check' | 'alpha' | 'backup' | 'workflow';
  presetId: string;
  presetRevision: number;
  presetSnapshots: Preset[];
  scope: 'selected';
  inputPaths: string[];
  status: 'requested' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'canceled' | 'undone';
  progress: number;
  detail: string;
  outputPaths: string[];
  error?: string;
  revision: number;
};

export type AgentSnapshot = {
  sequence: number;
  presetRevision: number;
  sourceRevision: number;
  presets: PresetStore;
  sources: AgentSourceSnapshot[];
  selectedPaths: string[];
  selectedSourcePaths: string[];
  activePath?: string;
  tasks: AgentTaskSnapshot[];
};

type AgentResponse<T> = {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  result?: T;
  receipt?: AgentReceipt;
  error?: { code: string; message: string; details?: string };
};

type AgentCommand = { type: string; [key: string]: unknown };

export class AgentApiError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = 'AgentApiError';
    this.code = code;
    this.details = details;
  }
}

let requestCounter = 0;
const guiSessionId = `gui_${createId()}`;

function createId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${(++requestCounter).toString(36)}`;
}

function normalizePresetStore(value: Partial<PresetStore> | undefined): PresetStore {
  const result = emptyPresetStore();
  for (const type of PRESET_TYPES) {
    result[type] = clonePresets((value?.[type] ?? []).map((preset) => ({ ...preset, type })));
  }
  return result;
}

async function agentRequest<T>(
  command: AgentCommand,
  expectedRevision?: number,
): Promise<{ result: T; receipt?: AgentReceipt }> {
  if (!isTauriRuntime()) {
    throw new AgentApiError('APP_NOT_RUNNING', 'ShadowEncoder Agent 服务只在桌面应用中可用');
  }
  const response = await invoke<AgentResponse<T>>('agent_request', {
    request: {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      requestId: `gui_${createId()}`,
      actor: 'gui',
      sessionId: guiSessionId,
      ...(expectedRevision == null ? {} : { expectedRevision }),
      command,
    },
  });
  if (!response.ok) {
    throw new AgentApiError(
      response.error?.code ?? 'INTERNAL_ERROR',
      response.error?.message ?? 'Agent 请求失败',
      response.error?.details,
    );
  }
  if (response.result === undefined) {
    throw new AgentApiError('INTERNAL_ERROR', 'Agent 响应缺少 result');
  }
  return { result: response.result, receipt: response.receipt };
}

export async function getAgentSnapshot(): Promise<AgentSnapshot> {
  const { result } = await agentRequest<AgentSnapshot>({ type: 'snapshot' });
  return {
    ...result,
    presets: normalizePresetStore(result.presets),
    selectedPaths: result.selectedPaths ?? [],
    selectedSourcePaths: result.selectedSourcePaths ?? result.selectedPaths ?? [],
    tasks: (result.tasks ?? []).map((task) => ({
      ...task,
      presetRevision: task.presetRevision ?? 0,
      presetSnapshots: clonePresets(task.presetSnapshots ?? []),
      inputPaths: task.inputPaths ?? [],
    })),
  };
}

export async function migrateAgentPresets(presets: PresetStore): Promise<AgentSnapshot> {
  const { result } = await agentRequest<AgentSnapshot>({
    type: 'preset.migrate',
    presets: normalizePresetStore(presets),
  });
  return { ...result, presets: normalizePresetStore(result.presets) };
}

export async function replaceAgentPresetType(
  type: PresetType,
  presets: Preset[],
  expectedRevision: number,
): Promise<AgentSnapshot> {
  const { result } = await agentRequest<AgentSnapshot>({
    type: 'preset.gui_replace_type',
    presetType: type,
    presets: clonePresets(presets.map((preset) => ({ ...preset, type }))),
  }, expectedRevision);
  return { ...result, presets: normalizePresetStore(result.presets) };
}

export async function replaceAgentSources(
  paths: string[],
  selectedPaths: string[],
  selectedSourcePaths: string[],
  activePath: string | null,
  expectedRevision: number,
): Promise<AgentSnapshot> {
  const { result } = await agentRequest<AgentSnapshot>({
    type: 'source.gui_replace',
    paths,
    selectedPaths,
    selectedSourcePaths,
    activePath,
  }, expectedRevision);
  return result;
}

export async function updateAgentTask(
  taskId: string,
  update: {
    status: AgentTaskSnapshot['status'];
    progress?: number;
    detail?: string;
    outputPaths?: string[];
    error?: string | null;
  },
): Promise<AgentTaskSnapshot> {
  const { result } = await agentRequest<AgentTaskSnapshot>({
    type: 'task.gui_update',
    taskId,
    ...update,
  });
  return result;
}

export async function cancelAgentTask(taskId: string): Promise<AgentTaskSnapshot> {
  const { result } = await agentRequest<AgentTaskSnapshot>({ type: 'task.cancel', taskId });
  return result;
}

export function subscribeAgentStateChanged(
  callback: (event: AgentStateChanged) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  return getCurrentWebview().listen<AgentStateChanged>(AGENT_STATE_EVENT, (event) => callback(event.payload));
}

export function isAgentRevisionConflict(error: unknown): boolean {
  return error instanceof AgentApiError && error.code === 'REVISION_CONFLICT';
}
