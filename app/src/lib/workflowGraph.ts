import type { WorkflowActionKind, WorkflowActionNode, WorkflowDefinition } from './workflow';
import type { ScriptPlan } from './workflowScript';
import { mergeOutputOverride, type WorkflowOutputOverride } from './workflowOutput.ts';
import { isAudioPath, isVideoPath } from './mediaExtensions.ts';

export type WorkflowPortType = 'media' | 'bool' | 'number' | 'report' | 'error';
export type WorkflowGraphPosition = { x: number; y: number };

export type WorkflowGraphActionNode = WorkflowActionNode & { position: WorkflowGraphPosition };
export type WorkflowGraphFilterMediaKind = 'all' | 'video' | 'audio';
export type WorkflowGraphFilterNode = {
  id: string;
  type: 'filter';
  filter: { mediaKind: WorkflowGraphFilterMediaKind; nameIncludes: string };
  position: WorkflowGraphPosition;
};
export type WorkflowGraphProbeMetric = 'long_edge' | 'frame_rate' | 'list_index' | 'reverse_index';
export type WorkflowGraphProbeNode = {
  id: string;
  type: 'probe';
  metric: WorkflowGraphProbeMetric;
  position: WorkflowGraphPosition;
};
export type WorkflowGraphLogicKind = 'count' | 'math' | 'compare' | 'boolean';
export type WorkflowGraphMathOperator = 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo';
export type WorkflowGraphCompareOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type WorkflowGraphBooleanOperator = 'and' | 'or' | 'xor' | 'not';
export type WorkflowGraphLogicNode = {
  id: string;
  type: 'logic';
  logic: {
    kind: WorkflowGraphLogicKind;
    value: number;
    mathOperator: WorkflowGraphMathOperator;
    compareOperator: WorkflowGraphCompareOperator;
    booleanOperator: WorkflowGraphBooleanOperator;
  };
  position: WorkflowGraphPosition;
};
export type WorkflowGraphGateNode = {
  id: string;
  type: 'gate';
  position: WorkflowGraphPosition;
};
export type WorkflowGraphOutputNode = {
  id: string;
  type: 'output';
  output: { mode: 'collect' | 'copy' | 'move' | 'restore'; directory: string; writeLog: boolean };
  position: WorkflowGraphPosition;
};
export type WorkflowGraphMaterialNode = {
  id: string; type: 'material'; path: string; position: WorkflowGraphPosition;
};
export type WorkflowGraphScriptNode = {
  id: string; type: 'script'; script: string; position: WorkflowGraphPosition;
};
export type WorkflowGraphOutputOverrideNode = {
  id: string; type: 'outputOverride'; override: WorkflowOutputOverride; position: WorkflowGraphPosition;
};
export function createWorkflowGraphOutputOverride(position = { x: 280, y: 120 }): WorkflowGraphOutputOverrideNode {
  return { id: graphId('workflow-output-override'), type: 'outputOverride', override: { location: 'inherit', naming: 'inherit', directory: '', subdirectory: 'ShadowEncoder', nameTemplate: '{name}{suffix}' }, position };
}
export const DEFAULT_WORKFLOW_SCRIPT = `// inputs follow connection order; reorder indices to change the layout.
const order = inputs.map((_, i) => i);
const filters = order.map((index, i) =>
  \`[\${index}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v\${i}]\`);
filters.push(order.map((_, i) => \`[v\${i}]\`).join('') +
  (order.length > 1 ? \`hstack=inputs=\${order.length}[out]\` : 'null[out]'));
return { filterComplex: filters.join(';'), duration: 10 };`;
export function createWorkflowGraphMaterial(path: string, position = { x: 0, y: 260 }): WorkflowGraphMaterialNode {
  return { id: graphId('workflow-material'), type: 'material', path, position };
}
export function createWorkflowGraphScript(position = { x: 280, y: 120 }): WorkflowGraphScriptNode {
  return { id: graphId('workflow-script'), type: 'script', script: DEFAULT_WORKFLOW_SCRIPT, position };
}
export type WorkflowGraphNode = WorkflowGraphActionNode
  | WorkflowGraphOutputOverrideNode
  | WorkflowGraphMaterialNode
  | WorkflowGraphScriptNode
  | WorkflowGraphFilterNode
  | WorkflowGraphProbeNode
  | WorkflowGraphLogicNode
  | WorkflowGraphGateNode
  | WorkflowGraphOutputNode;

export type WorkflowGraphPort = {
  id: string;
  type: WorkflowPortType;
  label: string;
  required?: boolean;
};

export type WorkflowGraphEdge = {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
};

export type WorkflowGraph = {
  startEnabled?: boolean;
  startPosition: WorkflowGraphPosition;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
};

export type WorkflowAsset = {
  id: string;
  path: string;
  sourcePath: string;
  index: number;
  preprocessing?: { paths: string[]; plan: ScriptPlan };
  outputOverride?: WorkflowOutputOverride;
};
export type WorkflowMediaValue = { type: 'media'; assets: WorkflowAsset[] };
export type WorkflowBoolValue = { type: 'bool'; values: Map<string, boolean>; batch?: boolean };
export type WorkflowNumberValue = { type: 'number'; values: Map<string, number>; batch?: number };
export type WorkflowReportValue = { type: 'report'; entries: string[] };
export type WorkflowErrorValue = { type: 'error'; values: Map<string, string> };
export type WorkflowPortValue = WorkflowMediaValue | WorkflowBoolValue | WorkflowNumberValue | WorkflowReportValue | WorkflowErrorValue;
export type WorkflowNodeOutputs = Record<string, WorkflowPortValue | undefined>;

export type WorkflowGraphRunHooks = {
  runMaterial?: (node: WorkflowGraphMaterialNode) => Promise<WorkflowNodeOutputs>;
  runScript?: (node: WorkflowGraphScriptNode, assets: WorkflowAsset[]) => Promise<WorkflowNodeOutputs>;
  runAction: (node: WorkflowGraphActionNode, assets: WorkflowAsset[]) => Promise<WorkflowNodeOutputs>;
  runProbe: (node: WorkflowGraphProbeNode, assets: WorkflowAsset[]) => Promise<WorkflowNodeOutputs>;
  runOutput?: (node: WorkflowGraphOutputNode, assets: WorkflowAsset[], inputs: Record<string, WorkflowPortValue>) => Promise<WorkflowNodeOutputs>;
  isCancelled?: () => boolean;
};

export type WorkflowGraphRunResult = {
  outputs: Map<string, WorkflowNodeOutputs>;
  executed: string[];
  errors: WorkflowErrorValue;
};

export const WORKFLOW_GRAPH_START_ID = '__workflow_start__';
export const WORKFLOW_GRAPH_START_PORT = 'media';
export const DEFAULT_WORKFLOW_GRAPH_START_POSITION: WorkflowGraphPosition = { x: 0, y: 68 };

let sequence = 0;
function graphId(prefix: string): string {
  sequence += 1;
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${sequence}`;
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function finite(value: unknown, fallback: number, min = -10000, max = 10000): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function isActionKind(value: unknown): value is WorkflowActionKind {
  return value === 'backup' || value === 'transcode' || value === 'mix' || value === 'check';
}
function isFilterKind(value: unknown): value is WorkflowGraphFilterMediaKind {
  return value === 'video' || value === 'audio' || value === 'all';
}
function isProbeMetric(value: unknown): value is WorkflowGraphProbeMetric {
  return value === 'long_edge' || value === 'frame_rate' || value === 'list_index' || value === 'reverse_index';
}
function isLogicKind(value: unknown): value is WorkflowGraphLogicKind {
  return value === 'count' || value === 'math' || value === 'compare' || value === 'boolean';
}

export function workflowNodePorts(node: WorkflowGraphNode): { inputs: WorkflowGraphPort[]; outputs: WorkflowGraphPort[] } {
  const mediaIn: WorkflowGraphPort = { id: 'media', type: 'media', label: '素材', required: true };
  const mediaOut: WorkflowGraphPort = { id: 'media', type: 'media', label: '素材' };
  if (node.type === 'material') return { inputs: [], outputs: [mediaOut] };
  if (node.type === 'outputOverride') return { inputs: [mediaIn], outputs: [mediaOut] };
  if (node.type === 'script') return { inputs: [mediaIn], outputs: [mediaOut, { id: 'error', type: 'error', label: '错误' }] };
  if (node.type === 'action') {
    return {
      inputs: [mediaIn],
      outputs: [
        mediaOut,
        { id: 'failed', type: 'media', label: '失败素材' },
        { id: 'success', type: 'bool', label: node.kind === 'check' ? '合格' : '成功' },
        { id: 'report', type: 'report', label: '报告' },
        { id: 'error', type: 'error', label: '错误' },
      ],
    };
  }
  if (node.type === 'filter') return { inputs: [mediaIn], outputs: [mediaOut] };
  if (node.type === 'probe') {
    return { inputs: [mediaIn], outputs: [mediaOut, { id: 'value', type: 'number', label: '数值' }, { id: 'error', type: 'error', label: '错误' }] };
  }
  if (node.type === 'gate') {
    return {
      inputs: [mediaIn, { id: 'condition', type: 'bool', label: '条件', required: true }],
      outputs: [{ id: 'matched', type: 'media', label: '满足' }, { id: 'unmatched', type: 'media', label: '不满足' }],
    };
  }
  if (node.type === 'output') return { inputs: [mediaIn, { id: 'report', type: 'report', label: '报告' }], outputs: [mediaOut, { id: 'report', type: 'report', label: '日志' }, { id: 'error', type: 'error', label: '错误' }] };
  if (node.logic.kind === 'count') return { inputs: [mediaIn], outputs: [{ id: 'value', type: 'number', label: '数量' }] };
  if (node.logic.kind === 'boolean') {
    const inputs = [{ id: 'left', type: 'bool' as const, label: 'A', required: true }];
    if (node.logic.booleanOperator !== 'not') inputs.push({ id: 'right', type: 'bool', label: 'B', required: true });
    return { inputs, outputs: [{ id: 'result', type: 'bool', label: '结果' }] };
  }
  return {
    inputs: [{ id: 'value', type: 'number', label: '数值', required: true }],
    outputs: [{ id: node.logic.kind === 'compare' ? 'result' : 'value', type: node.logic.kind === 'compare' ? 'bool' : 'number', label: node.logic.kind === 'compare' ? '结果' : '数值' }],
  };
}

export function workflowStartPorts(): { outputs: WorkflowGraphPort[] } {
  return { outputs: [{ id: WORKFLOW_GRAPH_START_PORT, type: 'media', label: '素材' }] };
}

export function createWorkflowGraph(): WorkflowGraph {
  return { startPosition: { ...DEFAULT_WORKFLOW_GRAPH_START_POSITION }, nodes: [], edges: [] };
}
export function createWorkflowGraphAction(kind: WorkflowActionKind = 'backup', presetId = '', presetRevision = 1, position = { x: 280, y: 120 }): WorkflowGraphActionNode {
  return { id: graphId(`workflow-${kind}`), type: 'action', kind, presetId, presetRevision, position };
}
export function createWorkflowGraphFilter(position = { x: 280, y: 120 }): WorkflowGraphFilterNode {
  return { id: graphId('workflow-filter'), type: 'filter', filter: { mediaKind: 'all', nameIncludes: '' }, position };
}
export function createWorkflowGraphProbe(metric: WorkflowGraphProbeMetric = 'long_edge', position = { x: 280, y: 120 }): WorkflowGraphProbeNode {
  return { id: graphId('workflow-probe'), type: 'probe', metric, position };
}
export function createWorkflowGraphLogic(kind: WorkflowGraphLogicKind = 'compare', position = { x: 280, y: 120 }): WorkflowGraphLogicNode {
  return {
    id: graphId(`workflow-${kind}`), type: 'logic', position,
    logic: { kind, value: 3000, mathOperator: 'add', compareOperator: 'gt', booleanOperator: 'and' },
  };
}
export function createWorkflowGraphGate(position = { x: 280, y: 120 }): WorkflowGraphGateNode {
  return { id: graphId('workflow-gate'), type: 'gate', position };
}
export function createWorkflowGraphOutput(position = { x: 280, y: 120 }): WorkflowGraphOutputNode {
  return { id: graphId('workflow-output'), type: 'output', output: { mode: 'collect', directory: '', writeLog: false }, position };
}

export function normalizeWorkflowGraph(value: unknown): WorkflowGraph {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const nodes: WorkflowGraphNode[] = [];
  const ids = new Set<string>();
  for (const [index, value] of (Array.isArray(raw.nodes) ? raw.nodes : []).entries()) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    let id = text(item.id) || graphId('workflow-node');
    while (ids.has(id)) id = graphId('workflow-node');
    ids.add(id);
    const sourcePosition = item.position && typeof item.position === 'object' ? item.position as Record<string, unknown> : {};
    const position = { x: finite(sourcePosition.x, 280 + (index % 3) * 300), y: finite(sourcePosition.y, 80 + Math.floor(index / 3) * 180) };
    if (item.type === 'material') {
      nodes.push({ id, type: 'material', path: text(item.path), position });
    } else if (item.type === 'script') {
      nodes.push({ id, type: 'script', script: text(item.script), position });
    } else if (item.type === 'outputOverride') {
      const node = createWorkflowGraphOutputOverride(position);
      const rawOverride = item.override && typeof item.override === 'object' ? item.override as Record<string, unknown> : {};
      nodes.push({ ...node, id, override: { ...mergeOutputOverride(node.override, rawOverride as WorkflowOutputOverride), directory: text(rawOverride.directory), subdirectory: text(rawOverride.subdirectory), nameTemplate: text(rawOverride.nameTemplate) } });
    } else if (item.type === 'action') {
      nodes.push({ id, type: 'action', kind: isActionKind(item.kind) ? item.kind : 'transcode', presetId: text(item.presetId), presetRevision: Math.max(1, Math.trunc(finite(item.presetRevision, 1, 1, Number.MAX_SAFE_INTEGER))), position });
    } else if (item.type === 'filter') {
      const filter = item.filter && typeof item.filter === 'object' ? item.filter as Record<string, unknown> : {};
      nodes.push({ id, type: 'filter', filter: { mediaKind: isFilterKind(filter.mediaKind) ? filter.mediaKind : 'all', nameIncludes: text(filter.nameIncludes) }, position });
    } else if (item.type === 'probe') {
      nodes.push({ id, type: 'probe', metric: isProbeMetric(item.metric) ? item.metric : 'long_edge', position });
    } else if (item.type === 'logic') {
      const logic = item.logic && typeof item.logic === 'object' ? item.logic as Record<string, unknown> : {};
      const node = createWorkflowGraphLogic(isLogicKind(logic.kind) ? logic.kind : 'compare', position);
      node.id = id;
      node.logic.value = finite(logic.value, node.logic.value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (logic.mathOperator === 'subtract' || logic.mathOperator === 'multiply' || logic.mathOperator === 'divide' || logic.mathOperator === 'modulo') node.logic.mathOperator = logic.mathOperator;
      if (logic.compareOperator === 'eq' || logic.compareOperator === 'ne' || logic.compareOperator === 'lt' || logic.compareOperator === 'lte' || logic.compareOperator === 'gt' || logic.compareOperator === 'gte') node.logic.compareOperator = logic.compareOperator;
      if (logic.booleanOperator === 'or' || logic.booleanOperator === 'xor' || logic.booleanOperator === 'not') node.logic.booleanOperator = logic.booleanOperator;
      nodes.push(node);
    } else if (item.type === 'gate') {
      nodes.push({ id, type: 'gate', position });
    } else if (item.type === 'output') {
      const output = item.output && typeof item.output === 'object' ? item.output as Record<string, unknown> : {};
      nodes.push({ id, type: 'output', output: { mode: output.mode === 'copy' || output.mode === 'move' || output.mode === 'restore' ? output.mode : 'collect', directory: text(output.directory), writeLog: output.writeLog === true }, position });
    }
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: WorkflowGraphEdge[] = [];
  const connections = new Set<string>();
  for (const value of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const source = text(item.source);
    const target = text(item.target);
    const sourcePort = text(item.sourcePort);
    const targetPort = text(item.targetPort);
    const sourceType = source === WORKFLOW_GRAPH_START_ID
      ? workflowStartPorts().outputs.find((port) => port.id === sourcePort)?.type
      : nodeById.get(source) && workflowNodePorts(nodeById.get(source)!).outputs.find((port) => port.id === sourcePort)?.type;
    const targetType = nodeById.get(target) && workflowNodePorts(nodeById.get(target)!).inputs.find((port) => port.id === targetPort)?.type;
    const key = `${source}:${sourcePort}:${target}:${targetPort}`;
    if (!sourceType || sourceType !== targetType || source === target || connections.has(key)) continue;
    connections.add(key);
    edges.push({ id: text(item.id) || graphId('workflow-edge'), source, sourcePort, target, targetPort });
  }
  const start = raw.startPosition && typeof raw.startPosition === 'object' ? raw.startPosition as Record<string, unknown> : {};
  return { startEnabled: raw.startEnabled !== false, startPosition: { x: finite(start.x, 0), y: finite(start.y, 68) }, nodes, edges };
}

function adjacency(graph: WorkflowGraph): Map<string, string[]> {
  const map = new Map(graph.nodes.map((node): [string, string[]] => [node.id, []]));
  for (const edge of graph.edges) map.get(edge.source)?.push(edge.target);
  return map;
}
export function workflowGraphWouldCreateCycle(graph: WorkflowGraph, source: string, target: string): boolean {
  if (source === WORKFLOW_GRAPH_START_ID) return false;
  const map = adjacency(graph);
  const seen = new Set<string>();
  const visit = (id: string): boolean => id === source || (!seen.has(id) && !!seen.add(id) && (map.get(id) ?? []).some(visit));
  return visit(target);
}
export function connectWorkflowGraph(graph: WorkflowGraph, source: string, sourcePort: string, target: string, targetPort: string): WorkflowGraph {
  if (source === WORKFLOW_GRAPH_START_ID && graph.startEnabled === false) return graph;
  const sourceType = source === WORKFLOW_GRAPH_START_ID
    ? workflowStartPorts().outputs.find((port) => port.id === sourcePort)?.type
    : graph.nodes.find((node) => node.id === source) && workflowNodePorts(graph.nodes.find((node) => node.id === source)!).outputs.find((port) => port.id === sourcePort)?.type;
  const targetNode = graph.nodes.find((node) => node.id === target);
  const targetType = targetNode && workflowNodePorts(targetNode).inputs.find((port) => port.id === targetPort)?.type;
  if (!sourceType || sourceType !== targetType || source === target || workflowGraphWouldCreateCycle(graph, source, target)) return graph;
  if (graph.edges.some((edge) => edge.source === source && edge.sourcePort === sourcePort && edge.target === target && edge.targetPort === targetPort)) return graph;
  return { ...graph, edges: [...graph.edges, { id: graphId('workflow-edge'), source, sourcePort, target, targetPort }] };
}
export function removeWorkflowGraphEdge(graph: WorkflowGraph, edgeId: string): WorkflowGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}
export function removeWorkflowGraphNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  return { ...graph, ...(nodeId === WORKFLOW_GRAPH_START_ID ? { startEnabled: false } : {}), nodes: graph.nodes.filter((node) => node.id !== nodeId), edges: graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId) };
}

export function workflowGraphIssues(graph: WorkflowGraph): string[] {
  const issues: string[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const startEdges = graph.edges.filter((edge) => edge.source === WORKFLOW_GRAPH_START_ID);
  const materials = graph.nodes.filter((node) => node.type === 'material');
  if ((graph.startEnabled === false || startEdges.length === 0) && materials.length === 0) issues.push('流程未连接输入节点');
  if (!graph.nodes.some((node) => node.type === 'output')) issues.push('流程需要至少一个文件输出节点');
  for (const edge of graph.edges) {
    if (edge.source === WORKFLOW_GRAPH_START_ID && graph.startEnabled === false) issues.push('连线引用了已删除的输入节点');
    if (workflowGraphWouldCreateCycle(graph, edge.source, edge.target)) issues.push('流程包含环路');
    const sourceType = edge.source === WORKFLOW_GRAPH_START_ID
      ? workflowStartPorts().outputs.find((port) => port.id === edge.sourcePort)?.type
      : nodeById.get(edge.source) && workflowNodePorts(nodeById.get(edge.source)!).outputs.find((port) => port.id === edge.sourcePort)?.type;
    const targetType = nodeById.get(edge.target) && workflowNodePorts(nodeById.get(edge.target)!).inputs.find((port) => port.id === edge.targetPort)?.type;
    if (!sourceType || sourceType !== targetType) issues.push('流程包含端口类型不匹配的连线');
  }
  const reachable = new Set<string>();
  const map = adjacency(graph);
  const walk = (id: string) => { if (!reachable.has(id)) { reachable.add(id); (map.get(id) ?? []).forEach(walk); } };
  startEdges.forEach((edge) => walk(edge.target));
  materials.forEach((node) => walk(node.id));
  if (reachable.size !== graph.nodes.length) issues.push('存在未接入流程的节点');
  for (const node of graph.nodes) {
    if (node.type === 'material' && !node.path.trim()) issues.push('素材节点未指定文件');
    if (node.type === 'script' && (!node.script.trim() || node.script.length > 65536)) issues.push('高级自定义节点脚本为空或超过 64K 字符');
    if (node.type === 'script' || node.type === 'outputOverride') {
      const seen = new Set<string>();
      const checkNext = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const next = nodeById.get(id);
        if (!next) return;
        if (next.type === 'action' && (next.kind === 'transcode' || (node.type === 'outputOverride' && next.kind === 'mix'))) return;
        if ((node.type === 'script' ? ['output', 'action', 'probe', 'script'] : ['output', 'action']).includes(next.type)) {
          issues.push(node.type === 'script' ? '自定义预处理必须先连接编码节点，再输出或执行其他处理' : '输出设置覆盖请放在编码或混音节点之前');
          return;
        }
        graph.edges.filter(edge => edge.source === id && edge.targetPort === 'media').forEach(edge => checkNext(edge.target));
      };
      graph.edges.filter(edge => edge.source === node.id && edge.sourcePort === 'media').forEach(edge => checkNext(edge.target));
    }
    if (node.type === 'outputOverride') {
      if (node.override.location === 'fixed' && !node.override.directory.trim()) issues.push('输出设置覆盖节点未选择目录');
      if (node.override.location === 'subdir' && (!node.override.subdirectory.trim() || /(^|[/\\])\.\.([/\\]|$)|^[\/\\]|:/.test(node.override.subdirectory))) issues.push('输出设置覆盖节点的子目录无效');
      if (node.override.naming === 'template' && !node.override.nameTemplate.trim()) issues.push('输出设置覆盖节点未填写命名模板');
    }
    if (node.type === 'output' && (node.output.mode === 'copy' || node.output.mode === 'move' || node.output.writeLog) && !node.output.directory.trim()) issues.push('文件输出节点未选择目录');
    if (!graph.edges.some((edge) => edge.source === node.id) && node.type !== 'output') issues.push('存在未连接后续节点或文件输出的节点');
    const connected = new Set(graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetPort));
    const missing = workflowNodePorts(node).inputs.filter((port) => port.required && !connected.has(port.id));
    if (missing.length > 0) issues.push(`${node.type === 'gate' ? '分流' : '节点'}缺少${missing.map((port) => port.label).join('、')}输入`);
  }
  return [...new Set(issues)];
}

export function workflowGraphNodeCounts(graph: WorkflowGraph): { actions: number; conditions: number } {
  return graph.nodes.reduce((counts, node) => {
    if (node.type === 'logic' || node.type === 'gate' || node.type === 'probe') counts.conditions += 1;
    else counts.actions += 1;
    return counts;
  }, { actions: 0, conditions: 0 });
}
export function workflowDefinitionNodeCounts(definition: WorkflowDefinition) { return workflowGraphNodeCounts(definition.graph); }
export function workflowGraphForDefinition(definition: WorkflowDefinition) { return definition.graph; }

function dedupeAssets(assets: WorkflowAsset[]): WorkflowAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = JSON.stringify([asset.id, asset.path, asset.outputOverride]);
    return !seen.has(key) && !!seen.add(key);
  });
}
export function filterWorkflowGraphAssets(node: WorkflowGraphFilterNode, assets: WorkflowAsset[]): WorkflowAsset[] {
  const needle = node.filter.nameIncludes.trim().toLocaleLowerCase();
  return dedupeAssets(assets).filter((asset) => {
    if (node.filter.mediaKind === 'video' && !isVideoPath(asset.path)) return false;
    if (node.filter.mediaKind === 'audio' && !isAudioPath(asset.path)) return false;
    return !needle || (asset.path.split(/[/\\]/).pop()?.toLocaleLowerCase() ?? '').includes(needle);
  });
}
export function filterWorkflowGraphPaths(filter: WorkflowGraphFilterNode['filter'], paths: string[]): string[] {
  const node: WorkflowGraphFilterNode = { id: '', type: 'filter', filter, position: { x: 0, y: 0 } };
  return filterWorkflowGraphAssets(node, paths.map((path, index) => ({ id: `${index}:${path}`, path, sourcePath: path, index }))).map((asset) => asset.path);
}

function mergeValues(type: WorkflowPortType, values: WorkflowPortValue[]): WorkflowPortValue | undefined {
  const matching = values.filter((value) => value.type === type);
  if (matching.length === 0) return undefined;
  if (type === 'media') return { type, assets: dedupeAssets(matching.flatMap((value) => (value as WorkflowMediaValue).assets)) };
  if (type === 'report') return { type, entries: matching.flatMap((value) => (value as WorkflowReportValue).entries) };
  if (type === 'error') return { type, values: new Map(matching.flatMap((value) => [...(value as WorkflowErrorValue).values])) };
  if (type === 'bool') {
    const typed = matching as WorkflowBoolValue[];
    return { type, values: new Map(typed.flatMap((value) => [...value.values])), batch: [...typed].reverse().find((value) => value.batch != null)?.batch };
  }
  const typed = matching as WorkflowNumberValue[];
  return { type, values: new Map(typed.flatMap((value) => [...value.values])), batch: [...typed].reverse().find((value) => value.batch != null)?.batch };
}
function boolForAsset(value: WorkflowBoolValue, asset: WorkflowAsset): boolean { return value.values.get(asset.id) ?? value.batch ?? false; }
function numberMap(value: WorkflowNumberValue, transform: (number: number) => number): WorkflowNumberValue {
  return { type: 'number', values: new Map([...value.values].map(([key, number]) => [key, transform(number)])), batch: value.batch == null ? undefined : transform(value.batch) };
}
function executeBuiltin(node: Exclude<WorkflowGraphNode, WorkflowGraphActionNode | WorkflowGraphProbeNode | WorkflowGraphOutputNode | WorkflowGraphMaterialNode | WorkflowGraphScriptNode>, inputs: Record<string, WorkflowPortValue>): WorkflowNodeOutputs {
  if (node.type === 'outputOverride') return { media: { type: 'media', assets: (inputs.media as WorkflowMediaValue).assets.map(asset => ({ ...asset, outputOverride: mergeOutputOverride(asset.outputOverride, node.override) })) } };
  if (node.type === 'filter') {
    const media = inputs.media as WorkflowMediaValue;
    return { media: { type: 'media', assets: filterWorkflowGraphAssets(node, media.assets) } };
  }
  if (node.type === 'gate') {
    const media = inputs.media as WorkflowMediaValue;
    const condition = inputs.condition as WorkflowBoolValue;
    return {
      matched: { type: 'media', assets: media.assets.filter((asset) => boolForAsset(condition, asset)) },
      unmatched: { type: 'media', assets: media.assets.filter((asset) => !boolForAsset(condition, asset)) },
    };
  }
  const logic = node.logic;
  if (logic.kind === 'count') {
    const assets = (inputs.media as WorkflowMediaValue).assets;
    return { value: { type: 'number', values: new Map(), batch: assets.length } };
  }
  if (logic.kind === 'boolean') {
    const left = inputs.left as WorkflowBoolValue;
    const right = inputs.right as WorkflowBoolValue | undefined;
    const keys = new Set([...left.values.keys(), ...(right ? right.values.keys() : [])]);
    const calculate = (a: boolean, b: boolean) => logic.booleanOperator === 'not' ? !a : logic.booleanOperator === 'or' ? a || b : logic.booleanOperator === 'xor' ? a !== b : a && b;
    return { result: { type: 'bool', values: new Map([...keys].map((key) => [key, calculate(left.values.get(key) ?? left.batch ?? false, right?.values.get(key) ?? right?.batch ?? false)])), batch: calculate(left.batch ?? false, right?.batch ?? false) } };
  }
  const input = inputs.value as WorkflowNumberValue;
  if (logic.kind === 'math') {
    const calculate = (number: number) => logic.mathOperator === 'subtract' ? number - logic.value : logic.mathOperator === 'multiply' ? number * logic.value : logic.mathOperator === 'divide' ? (logic.value === 0 ? 0 : number / logic.value) : logic.mathOperator === 'modulo' ? (logic.value === 0 ? 0 : number % logic.value) : number + logic.value;
    return { value: numberMap(input, calculate) };
  }
  const compare = (number: number) => logic.compareOperator === 'ne' ? number !== logic.value : logic.compareOperator === 'lt' ? number < logic.value : logic.compareOperator === 'lte' ? number <= logic.value : logic.compareOperator === 'gt' ? number > logic.value : logic.compareOperator === 'gte' ? number >= logic.value : number === logic.value;
  return { result: { type: 'bool', values: new Map([...input.values].map(([key, number]) => [key, compare(number)])), batch: input.batch == null ? undefined : compare(input.batch) } };
}

export async function executeWorkflowGraphDAG(graph: WorkflowGraph, initialPaths: string[], hooks: WorkflowGraphRunHooks): Promise<WorkflowGraphRunResult> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, WorkflowGraphEdge[]>();
  const outgoing = new Map<string, WorkflowGraphEdge[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const arrivals = new Map<string, Map<string, WorkflowPortValue | null>>();
  let ready: Array<{ node: WorkflowGraphNode; inputs: Record<string, WorkflowPortValue> }> = [];
  const outputs = new Map<string, WorkflowNodeOutputs>();
  const executed: string[] = [];
  const errors: WorkflowErrorValue = { type: 'error', values: new Map() };
  const initial: WorkflowMediaValue = { type: 'media', assets: initialPaths.map((path, index) => ({ id: `${index}:${path}`, path, sourcePath: path, index })) };

  const settle = (edge: WorkflowGraphEdge, value: WorkflowPortValue | null) => {
    const node = nodeById.get(edge.target);
    if (!node) return;
    const nodeArrivals = arrivals.get(node.id) ?? new Map<string, WorkflowPortValue | null>();
    nodeArrivals.set(edge.id, value);
    arrivals.set(node.id, nodeArrivals);
    const requiredEdges = incoming.get(node.id) ?? [];
    if (!requiredEdges.every((item) => nodeArrivals.has(item.id))) return;
    const inputs: Record<string, WorkflowPortValue> = {};
    for (const port of workflowNodePorts(node).inputs) {
      const portValues = requiredEdges.filter((item) => item.targetPort === port.id).map((item) => nodeArrivals.get(item.id)).filter((item): item is WorkflowPortValue => !!item);
      const merged = mergeValues(port.type, portValues);
      if (merged) inputs[port.id] = merged;
    }
    const missing = workflowNodePorts(node).inputs.some((port) => port.required && !inputs[port.id]);
    if (missing) {
      for (const edge of outgoing.get(node.id) ?? []) settle(edge, null);
    } else {
      ready.push({ node, inputs });
    }
  };

  if (graph.startEnabled !== false) for (const edge of outgoing.get(WORKFLOW_GRAPH_START_ID) ?? []) settle(edge, edge.sourcePort === WORKFLOW_GRAPH_START_PORT ? initial : null);
  for (const node of graph.nodes) if (node.type === 'material') ready.push({ node, inputs: {} });
  while (ready.length > 0 && !(hooks.isCancelled?.() ?? false)) {
    const batch = ready;
    ready = [];
    const results = await Promise.all(batch.map(async ({ node, inputs }) => {
      try {
        if (node.type === 'material') return { node, result: hooks.runMaterial ? await hooks.runMaterial(node) : { media: { type: 'media', assets: [{ id: node.id, path: node.path, sourcePath: node.path, index: 0 }] } } as WorkflowNodeOutputs };
        if (node.type === 'script') {
          if (!hooks.runScript) throw new Error('高级自定义脚本执行器不可用');
          return { node, result: await hooks.runScript(node, (inputs.media as WorkflowMediaValue).assets) };
        }
        if (node.type === 'action') return { node, result: await hooks.runAction(node, (inputs.media as WorkflowMediaValue).assets) };
        if (node.type === 'probe') return { node, result: await hooks.runProbe(node, (inputs.media as WorkflowMediaValue).assets) };
        if (node.type === 'output') return { node, result: hooks.runOutput ? await hooks.runOutput(node, (inputs.media as WorkflowMediaValue | undefined)?.assets ?? [], inputs) : { media: inputs.media, report: inputs.report } };
        return { node, result: executeBuiltin(node, inputs) };
      } catch (error) {
        const message = String((error as Error)?.message || error);
        const media = inputs.media as WorkflowMediaValue | undefined;
        const values = new Map((media?.assets ?? []).map((asset) => [asset.id, message]));
        if (!values.size) values.set(node.id, message);
        return { node, result: { error: { type: 'error', values } as WorkflowErrorValue } as WorkflowNodeOutputs };
      }
    }));
    for (const { node, result } of results) {
      outputs.set(node.id, result);
      executed.push(node.id);
      const error = result.error;
      if (error?.type === 'error') for (const [id, message] of error.values) errors.values.set(id, message);
      for (const edge of outgoing.get(node.id) ?? []) settle(edge, result[edge.sourcePort] ?? null);
    }
  }
  return { outputs, executed, errors };
}
