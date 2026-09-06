import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MATERIAL_DROP_EVENT, type MaterialDrop } from '../lib/materialDrag';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
  type NodeProps,
  type OnConnectStartParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import * as ui from './ui';
import { IconFolder, IconHelp, IconRedo, IconTrash, IconUndo, IconUpdate } from './icons';
import { pickPath } from '../lib/ffmpeg';
import { evaluateWorkflowScript } from '../lib/workflowScript';
import { TemplateEditor, TEMPLATE_TOKENS } from './OutputSettings';
import {
  PresetManageDialog,
  usePresets,
  type Preset,
  type PresetBuilderCtx,
} from './presetSystem';
import {
  WORKFLOW_ACTION_LABELS,
  cloneWorkflowDefinition,
  normalizeWorkflowDefinition,
  type WorkflowActionKind,
  type WorkflowDefinition,
} from '../lib/workflow';
import {
  WORKFLOW_GRAPH_START_ID,
  WORKFLOW_GRAPH_START_PORT,
  connectWorkflowGraph,
  createWorkflowGraphAction,
  createWorkflowGraphFilter,
  createWorkflowGraphGate,
  createWorkflowGraphLogic,
  createWorkflowGraphOutput,
  createWorkflowGraphProbe,
  createWorkflowGraphMaterial,
  createWorkflowGraphScript,
  createWorkflowGraphOutputOverride,
  removeWorkflowGraphEdge,
  removeWorkflowGraphNode,
  workflowDefinitionNodeCounts,
  workflowGraphForDefinition,
  workflowGraphIssues,
  workflowNodePorts,
  workflowStartPorts,
  type WorkflowGraph,
  type WorkflowGraphLogicKind,
  type WorkflowGraphNode,
  type WorkflowGraphPort,
  type WorkflowGraphProbeMetric,
} from '../lib/workflowGraph';

type WorkflowPresetSets = Record<WorkflowActionKind, Preset[]>;
type WorkflowNodeCreateKind = WorkflowActionKind | WorkflowGraphLogicKind | WorkflowGraphProbeMetric | 'filter' | 'gate' | 'output' | 'script' | 'outputOverride';
type MenuState = { x: number; y: number; graphX: number; graphY: number; nodeId?: string; edgeId?: string } | null;
type ActiveConnection = { nodeId: string; handleId: string; handleType: 'source' | 'target' } | null;
type FlowNodeData = {
  start?: boolean;
  graphNode?: WorkflowGraphNode;
  expanded: boolean;
  disabled: boolean;
  presets: WorkflowPresetSets;
  removableTrigger: boolean;
  activeConnection: ActiveConnection;
  isValidConnection: IsValidConnection<Edge>;
  onChangeNode: (node: WorkflowGraphNode) => void;
  onDeleteNode: (id: string) => void;
};
type FlowNode = Node<FlowNodeData, 'workflow'>;

const ACTION_PRESET_LABELS: Record<WorkflowActionKind, string> = {
  backup: '备份预设',
  transcode: '编码预设',
  mix: '混音预设',
  check: '检测预设',
};
const LOGIC_LABELS: Record<WorkflowGraphLogicKind, string> = {
  count: '素材计数',
  math: '数值运算',
  compare: '数值比较',
  boolean: '布尔运算',
};
const PROBE_LABELS: Record<WorkflowGraphProbeMetric, string> = {
  long_edge: '长边检测',
  frame_rate: '帧率检测',
  list_index: '列表序号',
  reverse_index: '倒序序号',
};

function useWorkflowPresetSets(): WorkflowPresetSets {
  const backup = usePresets('backup').presets;
  const transcode = usePresets('encode').presets;
  const mix = usePresets('mix').presets;
  const check = usePresets('check').presets;
  return useMemo(() => ({ backup, transcode, mix, check }), [backup, check, mix, transcode]);
}
function presetOptions(presets: Preset[]) {
  return presets.length ? presets.map((preset) => ({ label: preset.name, value: preset.id })) : [{ label: '没有可用预设', value: '' }];
}
function nodeTitle(node: WorkflowGraphNode): string {
  if (node.type === 'material') return node.path.split(/[/\\]/).pop() || '指定素材';
  if (node.type === 'script') return '高级自定义';
  if (node.type === 'outputOverride') return '输出设置覆盖';
  if (node.type === 'action') return WORKFLOW_ACTION_LABELS[node.kind].split(' · ').pop() ?? WORKFLOW_ACTION_LABELS[node.kind];
  if (node.type === 'filter') return '素材筛选';
  if (node.type === 'probe') return PROBE_LABELS[node.metric];
  if (node.type === 'logic') return LOGIC_LABELS[node.logic.kind];
  if (node.type === 'gate') return '条件分流';
  return '文件输出';
}
function nodeCategory(node: WorkflowGraphNode): string {
  if (node.type === 'material') return '来源';
  if (node.type === 'script') return '脚本';
  if (node.type === 'action') return '执行';
  if (node.type === 'probe') return '检测';
  if (node.type === 'logic' || node.type === 'gate') return '逻辑';
  if (node.type === 'filter') return '筛选';
  return '输出';
}

function PortHandle({ nodeId, port, kind, activeConnection, isValidConnection }: {
  nodeId: string;
  port: WorkflowGraphPort;
  kind: 'source' | 'target';
  activeConnection: ActiveConnection;
  isValidConnection: IsValidConnection<Edge>;
}) {
  const handleId = `${kind === 'source' ? 'out' : 'in'}:${port.id}`;
  let connectionState = '';
  if (activeConnection) {
    if (activeConnection.nodeId === nodeId && activeConnection.handleId === handleId) connectionState = ' is-connection-origin';
    else if (activeConnection.handleType === kind) connectionState = ' is-incompatible-target';
    else {
      const candidate = activeConnection.handleType === 'source'
        ? { source: activeConnection.nodeId, sourceHandle: activeConnection.handleId, target: nodeId, targetHandle: handleId }
        : { source: nodeId, sourceHandle: handleId, target: activeConnection.nodeId, targetHandle: activeConnection.handleId };
      connectionState = isValidConnection(candidate) ? ' is-connectable-target' : ' is-incompatible-target';
    }
  }
  return (
    <div className={`se-workflow-port-row is-${kind}`}>
      {kind === 'target' && <span>{port.label}</span>}
      <Handle
        id={handleId}
        type={kind}
        position={kind === 'source' ? Position.Right : Position.Left}
        className={`se-workflow-handle is-${port.type}${connectionState}`}
        aria-label={`${port.label} ${kind === 'source' ? '输出' : '输入'}`}
      />
      {kind === 'source' && <span>{port.label}</span>}
    </div>
  );
}

function ScriptEditor({ script, disabled, onChange }: { script: string; disabled: boolean; onChange: (script: string) => void }) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const cancelled = useRef(false);
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true; }; }, []);
  useEffect(() => { setMessage(''); }, [script]);
  return <div className="se-workflow-node-editor nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()}>
    <label className="se-workflow-node-field"><span>素材预处理脚本</span><textarea className="se-drop-input se-workflow-script-editor" aria-label="高级自定义脚本" value={script} maxLength={65536} spellCheck={false} disabled={disabled || checking} onChange={(event) => onChange(event.target.value)} /></label>
    <ui.Button disabled={disabled || checking} onClick={async () => {
      setChecking(true); setMessage('');
      try { await evaluateWorkflowScript(script, [], () => cancelled.current, true); if (!cancelled.current) setMessage('语法有效'); }
      catch (error) { if (!cancelled.current) setMessage(String((error as Error).message || error)); }
      finally { if (!cancelled.current) setChecking(false); }
    }}>{checking ? '校验中' : '校验语法'}</ui.Button>
    {message && <div className={`se-workflow-node-issue${message === '语法有效' ? ' is-valid' : ''}`} role="status">{message}</div>}
  </div>;
}

function WorkflowNodeEditor({ node, presets, removableTrigger, disabled, onChange }: {
  node: WorkflowGraphNode;
  presets: WorkflowPresetSets;
  removableTrigger: boolean;
  disabled: boolean;
  onChange: (node: WorkflowGraphNode) => void;
}) {
  const stopDrag = (event: React.PointerEvent) => event.stopPropagation();
  if (node.type === 'material') return <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}><label className="se-workflow-node-field"><span>素材路径</span><ui.DropInput value={node.path} onChange={(path) => onChange({ ...node, path })} disabled={disabled} /></label></div>;
  if (node.type === 'script') return <ScriptEditor script={node.script} disabled={disabled} onChange={(script) => onChange({ ...node, script })} />;
  if (node.type === 'outputOverride') {
    const value = node.override;
    const update = (patch: Partial<typeof value>) => onChange({ ...node, override: { ...value, ...patch } });
    return <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}>
      <label className="se-workflow-node-field"><span>输出位置</span><ui.ComboBox value={value.location} options={[{ label: '继承', value: 'inherit' }, { label: '原素材目录', value: 'source' }, { label: '原目录的子目录', value: 'subdir' }, { label: '指定目录', value: 'fixed' }]} onChange={location => update({ location: location as typeof value.location })} disabled={disabled} /></label>
      <ui.AnimatedCollapse open={value.location === 'fixed'}><label className="se-workflow-node-field"><span>输出目录</span><div className="se-workflow-output-path"><ui.DropInput value={value.directory} onChange={directory => update({ directory })} disabled={disabled} /><ui.Button className="se-icon-btn" icon={<IconFolder size={14} />} title="选择输出目录" disabled={disabled} onClick={async () => { const directory = await pickPath('dir'); if (directory) update({ directory }); }} /></div></label></ui.AnimatedCollapse>
      <ui.AnimatedCollapse open={value.location === 'subdir'}><label className="se-workflow-node-field"><span>子目录</span><ui.DropInput value={value.subdirectory} onChange={subdirectory => update({ subdirectory })} disabled={disabled} /></label></ui.AnimatedCollapse>
      <label className="se-workflow-node-field"><span>文件命名</span><ui.ComboBox value={value.naming} options={[{ label: '继承', value: 'inherit' }, { label: '原名与功能后缀', value: 'default' }, { label: '自定义模板', value: 'template' }]} onChange={naming => update({ naming: naming as typeof value.naming })} disabled={disabled} /></label>
      <ui.AnimatedCollapse open={value.naming === 'template'}><TemplateEditor value={value.nameTemplate} tokens={TEMPLATE_TOKENS} preview="" ariaLabel="覆盖文件名模板" onChange={nameTemplate => update({ nameTemplate })} disabled={disabled} /></ui.AnimatedCollapse>
    </div>;
  }
  if (node.type === 'action') {
    const choices = presets[node.kind];
    const selected = choices.find((preset) => preset.id === node.presetId);
    const stale = selected && (selected.revision ?? 1) !== node.presetRevision;
    const issue = !selected ? `请选择${ACTION_PRESET_LABELS[node.kind]}`
      : removableTrigger && node.kind === 'backup' && selected.params?.operation === 'move' ? '磁盘触发流程禁止移动源盘'
        : stale ? '预设已更新' : '';
    return (
      <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}>
        <label className="se-workflow-node-field">
          <span>{ACTION_PRESET_LABELS[node.kind]}</span>
          <ui.ComboBox
            value={node.presetId}
            options={presetOptions(choices)}
            onChange={(presetId) => {
              const preset = choices.find((item) => item.id === presetId);
              onChange({ ...node, presetId, presetRevision: preset?.revision ?? 1 });
            }}
            disabled={disabled || choices.length === 0}
          />
        </label>
        {issue && <div className="se-workflow-node-issue"><span>{issue}</span>{stale && selected && <ui.Button className="se-icon-btn" icon={<IconUpdate size={13} />} title="同步预设" onClick={() => onChange({ ...node, presetRevision: selected.revision ?? 1 })} />}</div>}
      </div>
    );
  }
  if (node.type === 'filter') {
    return (
      <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}>
        <label className="se-workflow-node-field"><span>媒体类型</span><ui.ComboBox value={node.filter.mediaKind} options={[{ label: '全部媒体', value: 'all' }, { label: '仅视频', value: 'video' }, { label: '仅音频', value: 'audio' }]} onChange={(mediaKind) => onChange({ ...node, filter: { ...node.filter, mediaKind: mediaKind as any } })} disabled={disabled} /></label>
        <label className="se-workflow-node-field"><span>名称包含</span><ui.DropInput value={node.filter.nameIncludes} placeholder="留空表示不过滤" onChange={(nameIncludes) => onChange({ ...node, filter: { ...node.filter, nameIncludes } })} disabled={disabled} /></label>
      </div>
    );
  }
  if (node.type === 'probe') {
    return <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}><label className="se-workflow-node-field"><span>检测值</span><ui.ComboBox value={node.metric} options={Object.entries(PROBE_LABELS).map(([value, label]) => ({ value, label }))} onChange={(metric) => onChange({ ...node, metric: metric as WorkflowGraphProbeMetric })} disabled={disabled} /></label></div>;
  }
  if (node.type === 'logic') {
    const logic = node.logic;
    return (
      <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}>
        {logic.kind === 'math' && <label className="se-workflow-node-field"><span>运算</span><ui.ComboBox value={logic.mathOperator} options={[{ label: '加', value: 'add' }, { label: '减', value: 'subtract' }, { label: '乘', value: 'multiply' }, { label: '除', value: 'divide' }, { label: '取余', value: 'modulo' }]} onChange={(mathOperator) => onChange({ ...node, logic: { ...logic, mathOperator: mathOperator as any } })} disabled={disabled} /></label>}
        {logic.kind === 'compare' && <label className="se-workflow-node-field"><span>比较</span><ui.ComboBox value={logic.compareOperator} options={[{ label: '大于', value: 'gt' }, { label: '大于等于', value: 'gte' }, { label: '小于', value: 'lt' }, { label: '小于等于', value: 'lte' }, { label: '等于', value: 'eq' }, { label: '不等于', value: 'ne' }]} onChange={(compareOperator) => onChange({ ...node, logic: { ...logic, compareOperator: compareOperator as any } })} disabled={disabled} /></label>}
        {logic.kind === 'boolean' && <label className="se-workflow-node-field"><span>运算</span><ui.ComboBox value={logic.booleanOperator} options={[{ label: '且', value: 'and' }, { label: '或', value: 'or' }, { label: '异或', value: 'xor' }, { label: '非', value: 'not' }]} onChange={(booleanOperator) => onChange({ ...node, logic: { ...logic, booleanOperator: booleanOperator as any } })} disabled={disabled} /></label>}
        {(logic.kind === 'math' || logic.kind === 'compare') && <label className="se-workflow-node-field"><span>常量</span><ui.NumberField value={logic.value} min={-1000000} max={1000000} step={1} decimals={0} onChange={(value) => onChange({ ...node, logic: { ...logic, value } })} disabled={disabled} /></label>}
      </div>
    );
  }
  if (node.type === 'output') {
    const needsDirectory = node.output.mode === 'copy' || node.output.mode === 'move' || node.output.writeLog;
    return (
      <div className="se-workflow-node-editor nodrag nopan" onPointerDown={stopDrag}>
        <label className="se-workflow-node-field"><span>输出操作</span><ui.ComboBox value={node.output.mode} options={[{ label: '仅收集结果', value: 'collect' }, { label: '复制到目录', value: 'copy' }, { label: '移动到目录', value: 'move' }, { label: '移动回原素材目录', value: 'restore' }]} onChange={(mode) => onChange({ ...node, output: { ...node.output, mode: mode as any } })} disabled={disabled} /></label>
        <ui.AnimatedCollapse open={needsDirectory}>
          <label className="se-workflow-node-field"><span>{node.output.mode === 'collect' || node.output.mode === 'restore' ? '日志目录' : '输出目录'}</span><div className="se-workflow-output-path"><ui.DropInput value={node.output.directory} placeholder="选择目录" onChange={(directory) => onChange({ ...node, output: { ...node.output, directory } })} disabled={disabled} /><ui.Button onClick={async () => { const directory = await pickPath('dir'); if (directory) onChange({ ...node, output: { ...node.output, directory } }); }} disabled={disabled}>选择</ui.Button></div></label>
        </ui.AnimatedCollapse>
        <ui.Checkbox checked={node.output.writeLog} onChange={(writeLog) => onChange({ ...node, output: { ...node.output, writeLog } })} disabled={disabled}>输出流程日志</ui.Checkbox>
      </div>
    );
  }
  return <div className="se-workflow-node-note">媒体与布尔信号在此汇合，并分别从满足和不满足端口输出。</div>;
}

const WorkflowFlowNode = memo(function WorkflowFlowNode({ id, data, selected }: NodeProps<FlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [data.expanded, id, selected, updateNodeInternals]);
  if (data.start) {
    return (
      <div className={`se-workflow-flow-node is-start${selected ? ' selected' : ''}`}>
        <div className="se-workflow-node-header"><div><span>来源</span><strong>输入素材</strong></div><ui.Button className="se-icon-btn nodrag" icon={<IconTrash size={13} />} title="删除输入节点" onClick={() => data.onDeleteNode(id)} disabled={data.disabled} /></div>
        <div className="se-workflow-port-stack is-output">{workflowStartPorts().outputs.map((port) => <PortHandle key={port.id} nodeId={id} port={port} kind="source" activeConnection={data.activeConnection} isValidConnection={data.isValidConnection} />)}</div>
      </div>
    );
  }
  const node = data.graphNode!;
  const ports = workflowNodePorts(node);
  return (
    <div className={`se-workflow-flow-node is-${node.type}${selected ? ' selected' : ''}`}>
      <div className="se-workflow-node-header">
        <div><span>{nodeCategory(node)}</span><strong>{nodeTitle(node)}</strong></div>
        <ui.Button className="se-icon-btn nodrag" icon={<IconTrash size={13} />} title="删除节点" onClick={() => data.onDeleteNode(node.id)} disabled={data.disabled} />
      </div>
      <div className="se-workflow-port-grid">
        <div className="se-workflow-port-stack is-input">{ports.inputs.map((port) => <PortHandle key={port.id} nodeId={id} port={port} kind="target" activeConnection={data.activeConnection} isValidConnection={data.isValidConnection} />)}</div>
        <div className="se-workflow-port-stack is-output">{ports.outputs.map((port) => <PortHandle key={port.id} nodeId={id} port={port} kind="source" activeConnection={data.activeConnection} isValidConnection={data.isValidConnection} />)}</div>
      </div>
      <ui.AnimatedCollapse open={data.expanded} className="se-workflow-node-collapse">
        <WorkflowNodeEditor node={node} presets={data.presets} removableTrigger={data.removableTrigger} disabled={data.disabled} onChange={data.onChangeNode} />
      </ui.AnimatedCollapse>
    </div>
  );
});

const nodeTypes = { workflow: WorkflowFlowNode };

function WorkflowGraphCanvas({ graph, issue, onChange, disabled, presets, removableTrigger, focusNodeId, onFocusHandled, onCreate, canUndo, canRedo, onUndo, onRedo }: {
  graph: WorkflowGraph;
  issue?: string;
  onChange: (graph: WorkflowGraph) => void;
  disabled: boolean;
  presets: WorkflowPresetSets;
  removableTrigger: boolean;
  focusNodeId: string;
  onFocusHandled: () => void;
  onCreate: (kind: WorkflowNodeCreateKind, position: { x: number; y: number }) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const flow = useReactFlow<FlowNode, Edge>();
  const helpDialogRef = useRef<HTMLDialogElement>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [expandedId, setExpandedId] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const drop = (event: Event) => {
      const { path, x, y } = (event as CustomEvent<MaterialDrop>).detail;
      if (disabled || !path || path.includes('\0') || !viewportRef.current
        || document.elementFromPoint(x, y)?.closest('.se-workflow-graph-viewport') !== viewportRef.current) return;
      const node = createWorkflowGraphMaterial(path, flow.screenToFlowPosition({ x, y }));
      onChange({ ...graph, nodes: [...graph.nodes, node] });
      setExpandedId(node.id);
    };
    window.addEventListener(MATERIAL_DROP_EVENT, drop);
    return () => window.removeEventListener(MATERIAL_DROP_EVENT, drop);
  }, [disabled, flow, graph, onChange]);
  const [activeConnection, setActiveConnection] = useState<ActiveConnection>(null);
  const updateNode = useCallback((next: WorkflowGraphNode) => onChange({ ...graph, nodes: graph.nodes.map((node) => node.id === next.id ? next : node) }), [graph, onChange]);
  const deleteNode = useCallback((id: string) => {
    setExpandedId((current) => current === id ? '' : current);
    onChange(removeWorkflowGraphNode(graph, id));
  }, [graph, onChange]);
  const isValidConnection = useCallback<IsValidConnection<Edge>>((connection) => {
    const sourcePort = connection.sourceHandle?.replace(/^out:/, '') ?? '';
    const targetPort = connection.targetHandle?.replace(/^in:/, '') ?? '';
    return connectWorkflowGraph(graph, connection.source, sourcePort, connection.target, targetPort) !== graph;
  }, [graph]);
  const graphNodes = useMemo<FlowNode[]>(() => [
    ...(graph.startEnabled === false ? [] : [{ id: WORKFLOW_GRAPH_START_ID, type: 'workflow' as const, position: graph.startPosition, deletable: !disabled, draggable: !disabled, data: { start: true, expanded: false, disabled, presets, removableTrigger, activeConnection, isValidConnection, onChangeNode: updateNode, onDeleteNode: deleteNode } }]),
    ...graph.nodes.map((node): FlowNode => ({ id: node.id, type: 'workflow', position: node.position, draggable: !disabled, deletable: !disabled, data: { graphNode: node, expanded: expandedId === node.id, disabled, presets, removableTrigger, activeConnection, isValidConnection, onChangeNode: updateNode, onDeleteNode: deleteNode } })),
  ], [activeConnection, deleteNode, disabled, expandedId, graph.nodes, graph.startPosition, graph.startEnabled, isValidConnection, presets, removableTrigger, updateNode]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(graphNodes);
  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => ({ id: edge.id, source: edge.source, sourceHandle: `out:${edge.sourcePort}`, target: edge.target, targetHandle: `in:${edge.targetPort}`, className: `se-workflow-edge is-${workflowNodePorts(graph.nodes.find((node) => node.id === edge.target)!).inputs.find((port) => port.id === edge.targetPort)?.type ?? 'media'}`, interactionWidth: 28 })), [graph.edges, graph.nodes]);

  useEffect(() => {
    setNodes((current) => {
      const selectedIds = new Set(current.filter((node) => node.selected).map((node) => node.id));
      return graphNodes.map((node) => ({ ...node, selected: selectedIds.has(node.id) }));
    });
  }, [graphNodes, setNodes]);

  useEffect(() => {
    if (!focusNodeId) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      void flow.fitView({ nodes: [{ id: focusNodeId }], duration: reduced ? 0 : 320, padding: 0.45, maxZoom: 1.05 });
      onFocusHandled();
    });
  }, [flow, focusNodeId, onFocusHandled]);

  const connect = useCallback((connection: Connection) => {
    const sourcePort = connection.sourceHandle?.replace(/^out:/, '') ?? '';
    const targetPort = connection.targetHandle?.replace(/^in:/, '') ?? '';
    onChange(connectWorkflowGraph(graph, connection.source, sourcePort, connection.target, targetPort));
  }, [graph, onChange]);
  const startConnection = useCallback((_: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (params.nodeId && params.handleId && (params.handleType === 'source' || params.handleType === 'target')) {
      setActiveConnection({ nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType });
    }
  }, []);
  const createAtMenu = (kind: WorkflowNodeCreateKind) => menu && onCreate(kind, { x: menu.graphX, y: menu.graphY });
  const onHistoryKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || disabled) return;
    const key = event.key.toLowerCase();
    const undo = key === 'z' && !event.shiftKey;
    const redo = key === 'y' || (key === 'z' && event.shiftKey);
    if ((undo && canUndo) || (redo && canRedo)) {
      event.preventDefault();
      if (undo) onUndo();
      else onRedo();
    }
  }, [canRedo, canUndo, disabled, onRedo, onUndo]);
  const contextItems: ui.ContextMenuItem[] = menu?.nodeId ? [
    { label: '聚焦节点', onSelect: () => void flow.fitView({ nodes: [{ id: menu.nodeId! }], duration: 280, padding: 0.45, maxZoom: 1.05 }) },
    { label: '删除节点', danger: true, separatorBefore: true, disabled, onSelect: () => deleteNode(menu.nodeId!) },
  ] : menu?.edgeId ? [{ label: '删除连线', danger: true, disabled, onSelect: () => onChange(removeWorkflowGraphEdge(graph, menu.edgeId!)) }] : [
    { label: '输入素材', groupLabel: '来源', disabled: disabled || graph.startEnabled !== false, onSelect: () => onChange({ ...graph, startEnabled: true, startPosition: { x: menu!.graphX, y: menu!.graphY } }) },
    { label: '高级自定义', groupLabel: '脚本', disabled, onSelect: () => createAtMenu('script') },
    ...(['backup', 'transcode', 'mix', 'check'] as WorkflowActionKind[]).map((kind, index) => ({ label: WORKFLOW_ACTION_LABELS[kind].split(' · ').pop() ?? WORKFLOW_ACTION_LABELS[kind], groupLabel: index === 0 ? '执行' : undefined, disabled, onSelect: () => createAtMenu(kind) })),
    { label: '长边', groupLabel: '检测', disabled, onSelect: () => createAtMenu('long_edge') },
    { label: '帧率', disabled, onSelect: () => createAtMenu('frame_rate') },
    { label: '列表序号', disabled, onSelect: () => createAtMenu('list_index') },
    { label: '倒序序号', disabled, onSelect: () => createAtMenu('reverse_index') },
    { label: '数值比较', groupLabel: '逻辑', disabled, onSelect: () => createAtMenu('compare') },
    { label: '数值运算', disabled, onSelect: () => createAtMenu('math') },
    { label: '布尔运算', disabled, onSelect: () => createAtMenu('boolean') },
    { label: '素材计数', disabled, onSelect: () => createAtMenu('count') },
    { label: '条件分流', groupLabel: '路由', disabled, onSelect: () => createAtMenu('gate') },
    { label: '素材筛选', disabled, onSelect: () => createAtMenu('filter') },
    { label: '输出设置覆盖', groupLabel: '输出', disabled, onSelect: () => createAtMenu('outputOverride') },
    { label: '文件输出', disabled, onSelect: () => createAtMenu('output') },
    { label: '适应全部节点', groupLabel: '画布', onSelect: () => void flow.fitView({ duration: 280, padding: 0.18 }) },
  ];

  return (
    <div ref={viewportRef} className="se-workflow-graph-viewport" onContextMenu={(event) => event.stopPropagation()} onKeyDown={onHistoryKeyDown}>
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={connect}
        onConnectStart={startConnection}
        onConnectEnd={() => setActiveConnection(null)}
        isValidConnection={isValidConnection}
        onNodeDoubleClick={(_, node) => {
          if (node.id !== WORKFLOW_GRAPH_START_ID) setExpandedId((current) => current === node.id ? '' : node.id);
        }}
        onNodeDragStop={(_, _node, draggedNodes) => {
          const positions = new Map(draggedNodes.map((node) => [node.id, node.position]));
          onChange({
            ...graph,
            startPosition: positions.get(WORKFLOW_GRAPH_START_ID) ?? graph.startPosition,
            nodes: graph.nodes.map((item) => {
              const position = positions.get(item.id);
              return position ? { ...item, position } : item;
            }),
          });
        }}
        onDelete={({ nodes: deleted, edges: deletedEdges }) => {
          let next = graph;
          for (const node of deleted) next = removeWorkflowGraphNode(next, node.id);
          onChange({ ...next, edges: next.edges.filter((edge) => !deletedEdges.some((item) => item.id === edge.id)) });
        }}
        onPaneContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); setMenu({ x: event.clientX, y: event.clientY, graphX: point.x, graphY: point.y }); }}
        onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, graphX: node.position.x, graphY: node.position.y, nodeId: node.id }); }}
        onEdgeContextMenu={(event, edge) => { event.preventDefault(); event.stopPropagation(); const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); setMenu({ x: event.clientX, y: event.clientY, graphX: point.x, graphY: point.y, edgeId: edge.id }); }}
        minZoom={0.35}
        maxZoom={1.8}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnScroll={false}
        panOnDrag={[1]}
        panActivationKeyCode="Alt"
        selectionOnDrag
        selectionKeyCode={null}
        connectionRadius={30}
        deleteKeyCode={disabled ? null : ['Backspace', 'Delete']}
        nodesConnectable={!disabled}
        connectOnClick={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-right">
          <ControlButton aria-label="撤销" title="撤销" disabled={disabled || !canUndo} onClick={onUndo}><IconUndo size={15} /></ControlButton>
          <ControlButton aria-label="重做" title="重做" disabled={disabled || !canRedo} onClick={onRedo}><IconRedo size={15} /></ControlButton>
          <ControlButton aria-label="画布操作说明" title="画布操作说明" onClick={() => helpDialogRef.current?.showModal()}><IconHelp size={15} /></ControlButton>
        </Controls>
      </ReactFlow>
      {issue && <div className="se-workflow-validation" role="status">{issue}</div>}
      <ui.ContextMenu open={Boolean(menu)} x={menu?.x ?? 0} y={menu?.y ?? 0} items={contextItems} onClose={() => setMenu(null)} />
      <dialog ref={helpDialogRef} className="se-workflow-help-dialog" aria-labelledby="workflow-help-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="se-workflow-help-content">
          <header><strong id="workflow-help-title">画布操作</strong></header>
          <dl>
            <div><dt>选择</dt><dd>单击节点或连线；左键拖动画框选</dd></div>
            <div><dt>参数</dt><dd>双击节点展开，再次双击收起</dd></div>
            <div><dt>移动</dt><dd>拖动节点；中键或 Alt + 左键拖动画布</dd></div>
            <div><dt>连线</dt><dd>从输出连接点拖至兼容的输入连接点</dd></div>
            <div><dt>缩放</dt><dd>滚动鼠标滚轮</dd></div>
            <div><dt>菜单</dt><dd>右击画布、节点或连线</dd></div>
            <div><dt>删除</dt><dd>选中后按 Delete</dd></div>
          </dl>
          <ui.Button onClick={() => helpDialogRef.current?.close()}>关闭</ui.Button>
        </div>
      </dialog>
    </div>
  );
}

function WorkflowGraphCanvasProvider(props: React.ComponentProps<typeof WorkflowGraphCanvas>) {
  return <ReactFlowProvider><WorkflowGraphCanvas {...props} /></ReactFlowProvider>;
}

export function WorkflowEditor({ value, onChange, disabled, issue }: {
  value: WorkflowDefinition;
  onChange: React.Dispatch<React.SetStateAction<WorkflowDefinition>>;
  disabled: boolean;
  issue?: string;
}) {
  const presets = useWorkflowPresetSets();
  const graph = useMemo(() => workflowGraphForDefinition(value), [value]);
  const [focusNodeId, setFocusNodeId] = useState('');
  const [pastGraphs, setPastGraphs] = useState<WorkflowGraph[]>([]);
  const [futureGraphs, setFutureGraphs] = useState<WorkflowGraph[]>([]);
  const graphIssues = useMemo(() => workflowGraphIssues(graph), [graph]);
  const updateGraph = useCallback((next: WorkflowGraph) => onChange((current) => ({ ...current, graph: next })), [onChange]);
  const commitGraph = useCallback((next: WorkflowGraph) => {
    if (next === graph) return;
    setPastGraphs((current) => [...current.slice(-49), graph]);
    setFutureGraphs([]);
    updateGraph(next);
  }, [graph, updateGraph]);
  const undoGraph = useCallback(() => {
    const previous = pastGraphs[pastGraphs.length - 1];
    if (!previous) return;
    setPastGraphs((current) => current.slice(0, -1));
    setFutureGraphs((current) => [graph, ...current].slice(0, 50));
    updateGraph(previous);
  }, [graph, pastGraphs, updateGraph]);
  const redoGraph = useCallback(() => {
    const next = futureGraphs[0];
    if (!next) return;
    setFutureGraphs((current) => current.slice(1));
    setPastGraphs((current) => [...current.slice(-49), graph]);
    updateGraph(next);
  }, [futureGraphs, graph, updateGraph]);
  const createNode = useCallback((kind: WorkflowNodeCreateKind, position: { x: number; y: number }) => {
    const node = kind === 'outputOverride' ? createWorkflowGraphOutputOverride(position)
      : kind === 'script' ? createWorkflowGraphScript(position)
      : kind === 'filter' ? createWorkflowGraphFilter(position)
      : kind === 'gate' ? createWorkflowGraphGate(position)
        : kind === 'output' ? createWorkflowGraphOutput(position)
          : kind === 'long_edge' || kind === 'frame_rate' || kind === 'list_index' || kind === 'reverse_index' ? createWorkflowGraphProbe(kind, position)
            : kind === 'count' || kind === 'math' || kind === 'compare' || kind === 'boolean' ? createWorkflowGraphLogic(kind, position)
              : createWorkflowGraphAction(kind, presets[kind][0]?.id ?? '', presets[kind][0]?.revision ?? 1, position);
    commitGraph({ ...graph, nodes: [...graph.nodes, node] });
    setFocusNodeId(node.id);
  }, [commitGraph, graph, presets]);

  const triggerRows: ui.AnimatedFieldRow[] = [{ id: 'trigger-kind', content: <><ui.FieldLabel>启动方式</ui.FieldLabel><ui.ComboBox value={value.trigger.kind} options={[{ label: '手动立即执行', value: 'manual' }, { label: '等待新接入磁盘', value: 'removable' }]} onChange={(kind) => onChange((current) => ({ ...current, trigger: { ...current.trigger, kind: kind as any } }))} disabled={disabled} /></> }];
  if (value.trigger.kind === 'removable') triggerRows.push(
    { id: 'volume-kind', content: <><ui.FieldLabel>磁盘范围</ui.FieldLabel><ui.ComboBox value={value.trigger.volumeKind} options={[{ label: '可移动磁盘', value: 'removable' }, { label: '任意新接入卷', value: 'any' }]} onChange={(volumeKind) => onChange((current) => ({ ...current, trigger: { ...current.trigger, volumeKind: volumeKind as any } }))} disabled={disabled} /></> },
    { id: 'volume-label', content: <><ui.FieldLabel>卷标包含</ui.FieldLabel><ui.DropInput value={value.trigger.labelContains} placeholder="留空表示不过滤" onChange={(labelContains) => onChange((current) => ({ ...current, trigger: { ...current.trigger, labelContains } }))} disabled={disabled} /></> },
    { id: 'settle-seconds', content: <><ui.FieldLabel>稳定等待</ui.FieldLabel><ui.NumberField value={value.trigger.settleSeconds} min={1} max={30} step={1} decimals={0} suffix="秒" onChange={(settleSeconds) => onChange((current) => ({ ...current, trigger: { ...current.trigger, settleSeconds } }))} disabled={disabled} /></> },
  );

  return (
    <>
      <ui.ParamGroup title="触发条件"><ui.AnimatedFieldGrid rows={triggerRows} /></ui.ParamGroup>
      <ui.ParamGroup title="流程画布"><WorkflowGraphCanvasProvider graph={graph} issue={graphIssues[0] ?? issue} onChange={commitGraph} disabled={disabled} presets={presets} removableTrigger={value.trigger.kind === 'removable'} focusNodeId={focusNodeId} onFocusHandled={() => setFocusNodeId('')} onCreate={createNode} canUndo={pastGraphs.length > 0} canRedo={futureGraphs.length > 0} onUndo={undoGraph} onRedo={redoGraph} /></ui.ParamGroup>
    </>
  );
}

export function WorkflowPresetBuilder({ ctx, initial }: { ctx: PresetBuilderCtx; initial: WorkflowDefinition }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => normalizeWorkflowDefinition(initial));
  const [editorKey, setEditorKey] = useState(0);
  const reset = () => { setEditingId(null); setName(''); setDefinition(normalizeWorkflowDefinition(initial)); setEditorKey((current) => current + 1); };
  const select = (id: string) => { const preset = ctx.presets.find((item) => item.id === id); if (preset) { setEditingId(id); setName(preset.name); setDefinition(normalizeWorkflowDefinition(preset.params)); setEditorKey((current) => current + 1); } };
  useEffect(() => { if (ctx.isOpen) reset(); }, [ctx.isOpen]);
  if (!ctx.isMounted) return null;
  const graphIssues = workflowGraphIssues(definition.graph);
  return (
    <PresetManageDialog title="管理流程预设" scrollEditor presets={ctx.presets} editingId={editingId} onSelect={select} onNew={reset} onCopy={() => { if (editingId) { setEditingId(null); setName((current) => `${current || '流程'} 副本`); setDefinition((current) => cloneWorkflowDefinition(current)); setEditorKey((current) => current + 1); } }} onDelete={() => { if (editingId) { ctx.onRemove(editingId); reset(); } }} onImport={ctx.onImport} onExport={ctx.onExport} onReorder={ctx.onReorder} onClose={ctx.onClose} onExited={ctx.onExited} closing={ctx.closing} onSave={() => { const data = { ...cloneWorkflowDefinition(definition), name }; if (editingId) ctx.onUpdate(editingId, data); else ctx.onSaveNew(data); }} saveLabel={editingId ? '保存修改' : '保存预设'} canSave={Boolean(name.trim() && workflowDefinitionNodeCounts(definition).actions > 0 && graphIssues.length === 0)}>
      <div className="se-preset-name"><ui.FieldLabel>预设名称</ui.FieldLabel><input className="se-drop-input" value={name} placeholder="例如：插卡双盘备份与代理" onChange={(event) => setName(event.target.value)} /></div>
      <div className="se-workflow-preset-editor"><WorkflowEditor key={editorKey} value={definition} onChange={setDefinition} disabled={false} /></div>
    </PresetManageDialog>
  );
}
