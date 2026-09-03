import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cloneWorkflowDefinition, normalizeWorkflowDefinition } from '../src/lib/workflow.ts';
import {
  WORKFLOW_GRAPH_START_ID,
  WORKFLOW_GRAPH_START_PORT,
  connectWorkflowGraph,
  createWorkflowGraph,
  createWorkflowGraphAction,
  createWorkflowGraphGate,
  createWorkflowGraphLogic,
  createWorkflowGraphOutput,
  createWorkflowGraphProbe,
  executeWorkflowGraphDAG,
  workflowGraphIssues,
} from '../src/lib/workflowGraph.ts';

const media = (assets) => ({ type: 'media', assets });
const assets = (...paths) => paths.map((path, index) => ({ id: String(index), path, sourcePath: path, index }));
const actionResult = (items) => ({ media: media(items), failed: media([]), success: { type: 'bool', values: new Map(items.map((item) => [item.id, true])) } });
const hooks = (overrides = {}) => ({
  runAction: async (_node, items) => actionResult(items),
  runProbe: async (_node, items) => ({ media: media(items), value: { type: 'number', values: new Map(items.map((item) => [item.id, 0])) } }),
  ...overrides,
});

test('旧流程结构不会迁移，图只接受显式类型端口', () => {
  const normalized = normalizeWorkflowDefinition({ steps: [{ id: 'legacy', type: 'action' }] });
  assert.deepEqual(normalized.graph.nodes, []);
  const action = createWorkflowGraphAction('transcode');
  const compare = createWorkflowGraphLogic('compare');
  const graph = { ...createWorkflowGraph(), nodes: [action, compare] };
  assert.equal(connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, WORKFLOW_GRAPH_START_PORT, compare.id, 'value'), graph);
  const definition = normalizeWorkflowDefinition({ graph: { ...graph, edges: [{ id: 'bad', source: WORKFLOW_GRAPH_START_ID, sourcePort: 'media', target: compare.id, targetPort: 'value' }] } });
  assert.deepEqual(definition.graph.edges, []);
  const copy = cloneWorkflowDefinition(definition);
  copy.graph.startPosition.x = 99;
  assert.notEqual(copy.graph.startPosition.x, definition.graph.startPosition.x);
});

test('输入素材可同时连接多个编码节点并并行执行', async () => {
  const first = createWorkflowGraphAction('transcode');
  const second = createWorkflowGraphAction('transcode');
  let graph = { ...createWorkflowGraph(), nodes: [first, second] };
  graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', first.id, 'media');
  graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', second.id, 'media');
  assert.deepEqual(workflowGraphIssues(graph), []);
  let active = 0;
  let maxActive = 0;
  const result = await executeWorkflowGraphDAG(graph, ['camera.mov'], hooks({
    runAction: async (node, items) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return actionResult(items.map((item) => ({ ...item, path: `${node.id}.mp4` })));
    },
  }));
  assert.equal(maxActive, 2);
  assert.deepEqual(result.executed, [first.id, second.id]);
});

test('长边检测通过数值比较和 Gate 将素材分流到不同预设', async () => {
  const probe = createWorkflowGraphProbe('long_edge');
  const compare = createWorkflowGraphLogic('compare');
  compare.logic.compareOperator = 'gt';
  compare.logic.value = 3000;
  const gate = createWorkflowGraphGate();
  const large = createWorkflowGraphAction('transcode');
  const small = createWorkflowGraphAction('transcode');
  let graph = { ...createWorkflowGraph(), nodes: [probe, compare, gate, large, small] };
  graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', probe.id, 'media');
  graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', gate.id, 'media');
  graph = connectWorkflowGraph(graph, probe.id, 'value', compare.id, 'value');
  graph = connectWorkflowGraph(graph, compare.id, 'result', gate.id, 'condition');
  graph = connectWorkflowGraph(graph, gate.id, 'matched', large.id, 'media');
  graph = connectWorkflowGraph(graph, gate.id, 'unmatched', small.id, 'media');
  const seen = new Map();
  await executeWorkflowGraphDAG(graph, ['4k.mov', 'hd.mov'], hooks({
    runProbe: async (_node, items) => ({ media: media(items), value: { type: 'number', values: new Map([[items[0].id, 4096], [items[1].id, 1920]]) } }),
    runAction: async (node, items) => { seen.set(node.id, items.map((item) => item.path)); return actionResult(items); },
  }));
  assert.deepEqual(seen.get(large.id), ['4k.mov']);
  assert.deepEqual(seen.get(small.id), ['hd.mov']);
});

test('长边检测按三个区间送入对应编码预设', async () => {
  const probe = createWorkflowGraphProbe('long_edge');
  const over3000 = createWorkflowGraphLogic('compare');
  const atLeast2000 = createWorkflowGraphLogic('compare');
  over3000.logic.compareOperator = 'gt';
  over3000.logic.value = 3000;
  atLeast2000.logic.compareOperator = 'gte';
  atLeast2000.logic.value = 2000;
  const highGate = createWorkflowGraphGate();
  const lowerGate = createWorkflowGraphGate();
  const presetA = createWorkflowGraphAction('transcode');
  const presetB = createWorkflowGraphAction('transcode');
  const presetC = createWorkflowGraphAction('transcode');
  let graph = { ...createWorkflowGraph(), nodes: [probe, over3000, atLeast2000, highGate, lowerGate, presetA, presetB, presetC] };
  for (const node of [probe, highGate]) graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', node.id, 'media');
  graph = connectWorkflowGraph(graph, probe.id, 'value', over3000.id, 'value');
  graph = connectWorkflowGraph(graph, probe.id, 'value', atLeast2000.id, 'value');
  graph = connectWorkflowGraph(graph, over3000.id, 'result', highGate.id, 'condition');
  graph = connectWorkflowGraph(graph, highGate.id, 'unmatched', lowerGate.id, 'media');
  graph = connectWorkflowGraph(graph, atLeast2000.id, 'result', lowerGate.id, 'condition');
  graph = connectWorkflowGraph(graph, highGate.id, 'matched', presetA.id, 'media');
  graph = connectWorkflowGraph(graph, lowerGate.id, 'matched', presetB.id, 'media');
  graph = connectWorkflowGraph(graph, lowerGate.id, 'unmatched', presetC.id, 'media');
  const seen = new Map();
  const dimensions = [4096, 3001, 3000, 2000, 1999];
  await executeWorkflowGraphDAG(graph, dimensions.map((edge) => `${edge}.mov`), hooks({
    runProbe: async (_node, items) => ({ media: media(items), value: { type: 'number', values: new Map(items.map((item, index) => [item.id, dimensions[index]])) } }),
    runAction: async (node, items) => { seen.set(node.id, items.map((item) => item.path)); return actionResult(items); },
  }));
  assert.deepEqual(seen.get(presetA.id), ['4096.mov', '3001.mov']);
  assert.deepEqual(seen.get(presetB.id), ['3000.mov', '2000.mov']);
  assert.deepEqual(seen.get(presetC.id), ['1999.mov']);
});

test('正序和倒序检测可分别取得前五个与后五个素材', async () => {
  const firstProbe = createWorkflowGraphProbe('list_index');
  const lastProbe = createWorkflowGraphProbe('reverse_index');
  const firstCompare = createWorkflowGraphLogic('compare');
  const lastCompare = createWorkflowGraphLogic('compare');
  firstCompare.logic.compareOperator = 'lte';
  firstCompare.logic.value = 5;
  lastCompare.logic.compareOperator = 'lte';
  lastCompare.logic.value = 5;
  const firstGate = createWorkflowGraphGate();
  const lastGate = createWorkflowGraphGate();
  const firstPreset = createWorkflowGraphAction('transcode');
  const lastPreset = createWorkflowGraphAction('transcode');
  let graph = { ...createWorkflowGraph(), nodes: [firstProbe, lastProbe, firstCompare, lastCompare, firstGate, lastGate, firstPreset, lastPreset] };
  for (const node of [firstProbe, lastProbe, firstGate, lastGate]) graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', node.id, 'media');
  graph = connectWorkflowGraph(graph, firstProbe.id, 'value', firstCompare.id, 'value');
  graph = connectWorkflowGraph(graph, lastProbe.id, 'value', lastCompare.id, 'value');
  graph = connectWorkflowGraph(graph, firstCompare.id, 'result', firstGate.id, 'condition');
  graph = connectWorkflowGraph(graph, lastCompare.id, 'result', lastGate.id, 'condition');
  graph = connectWorkflowGraph(graph, firstGate.id, 'matched', firstPreset.id, 'media');
  graph = connectWorkflowGraph(graph, lastGate.id, 'matched', lastPreset.id, 'media');
  const seen = new Map();
  const paths = Array.from({ length: 12 }, (_, index) => `${index + 1}.mov`);
  await executeWorkflowGraphDAG(graph, paths, hooks({
    runProbe: async (node, items) => ({ media: media(items), value: { type: 'number', values: new Map(items.map((item, index) => [item.id, node.metric === 'reverse_index' ? items.length - index : index + 1])) } }),
    runAction: async (node, items) => { seen.set(node.id, items.map((item) => item.path)); return actionResult(items); },
  }));
  assert.deepEqual(seen.get(firstPreset.id), paths.slice(0, 5));
  assert.deepEqual(seen.get(lastPreset.id), paths.slice(-5));
});

test('单个素材失败不会中止同批其他素材，失败端口可继续补救', async () => {
  const encode = createWorkflowGraphAction('transcode');
  const recover = createWorkflowGraphAction('backup');
  const output = createWorkflowGraphOutput();
  let graph = { ...createWorkflowGraph(), nodes: [encode, recover, output] };
  graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', encode.id, 'media');
  graph = connectWorkflowGraph(graph, encode.id, 'media', output.id, 'media');
  graph = connectWorkflowGraph(graph, encode.id, 'failed', recover.id, 'media');
  const seen = new Map();
  const result = await executeWorkflowGraphDAG(graph, ['good.mov', 'bad.mov', 'other.mov'], hooks({
    runAction: async (node, items) => {
      seen.set(node.id, items.map((item) => item.path));
      if (node.id !== encode.id) return actionResult(items);
      const passed = items.filter((item) => item.path !== 'bad.mov').map((item) => ({ ...item, path: `${item.path}.mp4` }));
      const failed = items.filter((item) => item.path === 'bad.mov');
      return { media: media(passed), failed: media(failed), success: { type: 'bool', values: new Map(items.map((item) => [item.id, item.path !== 'bad.mov'])) }, error: { type: 'error', values: new Map(failed.map((item) => [item.id, 'encode failed'])) } };
    },
  }));
  assert.deepEqual(seen.get(recover.id), ['bad.mov']);
  assert.equal(result.errors.values.size, 1);
  assert.equal(result.executed.includes(output.id), true);
});

test('混音节点的产物成为下游编码输入', async () => {
  const mix = createWorkflowGraphAction('mix');
  const encode = createWorkflowGraphAction('transcode');
  let graph = { ...createWorkflowGraph(), nodes: [mix, encode] };
  graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', mix.id, 'media');
  graph = connectWorkflowGraph(graph, mix.id, 'media', encode.id, 'media');
  let encodedInput = '';
  await executeWorkflowGraphDAG(graph, ['camera.mov'], hooks({
    runAction: async (node, items) => {
      if (node.id === mix.id) return actionResult(items.map((item) => ({ ...item, path: 'camera_mix.mov' })));
      encodedInput = items[0].path;
      return actionResult(items);
    },
  }));
  assert.equal(encodedInput, 'camera_mix.mov');
});

test('检测失败分支汇合后可备份、转码并移动回原素材目录', async () => {
  const checks = [createWorkflowGraphAction('check'), createWorkflowGraphAction('check'), createWorkflowGraphAction('check')];
  const backup = createWorkflowGraphAction('backup');
  const encode = createWorkflowGraphAction('transcode');
  const restore = createWorkflowGraphOutput();
  restore.output.mode = 'restore';
  let graph = { ...createWorkflowGraph(), nodes: [...checks, backup, encode, restore] };
  for (const check of checks) {
    graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', check.id, 'media');
    graph = connectWorkflowGraph(graph, check.id, 'failed', backup.id, 'media');
  }
  graph = connectWorkflowGraph(graph, backup.id, 'media', encode.id, 'media');
  graph = connectWorkflowGraph(graph, encode.id, 'media', restore.id, 'media');
  const originalPaths = ['D:/CARD/A.mov', 'D:/CARD/B.mov', 'D:/CARD/C.mov'];
  let restored = [];
  await executeWorkflowGraphDAG(graph, originalPaths, hooks({
    runAction: async (node, items) => {
      if (checks.some((check) => check.id === node.id)) {
        const failed = items.filter((item) => item.index === checks.findIndex((check) => check.id === node.id));
        return { media: media(items), failed: media(failed), success: { type: 'bool', values: new Map(items.map((item) => [item.id, !failed.includes(item)])) } };
      }
      if (node.id === backup.id) return actionResult(items.map((item) => ({ ...item, path: `E:/BACKUP/${item.path.split('/').pop()}` })));
      return actionResult(items.map((item) => ({ ...item, path: `F:/PROXY/${item.path.split('/').pop()}.mp4` })));
    },
    runOutput: async (_node, items) => { restored = items; return { media: media(items) }; },
  }));
  assert.deepEqual(restored.map((item) => item.sourcePath), originalPaths);
  assert.deepEqual(restored.map((item) => item.path), ['F:/PROXY/A.mov.mp4', 'F:/PROXY/B.mov.mp4', 'F:/PROXY/C.mov.mp4']);
});

test('流程页面使用 XYFlow、类型端口、节点内参数和原子日志输出', async () => {
  const [editor, graph, dit, bridge, backend] = await Promise.all([
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/workflowGraph.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(editor, /from '@xyflow\/react'/);
  assert.match(editor, /<Handle[\s\S]*sourcePort[\s\S]*targetPort/);
  assert.match(editor, /screenToFlowPosition/);
  assert.match(editor, /fitView\(\{ nodes:[\s\S]*duration/);
  assert.match(editor, /<WorkflowNodeEditor node=\{node\}/);
  assert.match(editor, /reverse_index: '倒序序号'/);
  assert.match(graph, /WorkflowPortType = 'media' \| 'bool' \| 'number' \| 'report' \| 'error'/);
  assert.match(dit, /node\.metric === 'reverse_index' \? assets\.length - index/);
  assert.match(dit, /node\.output\.mode === 'restore'[\s\S]*transfer\(\[asset\], directory, 'move'\)/);
  assert.match(dit, /node\.output\.mode === 'copy' \|\| node\.output\.mode === 'move' \|\| node\.output\.writeLog/);
  assert.match(graph, /sourcePort: string;[\s\S]*targetPort: string/);
  assert.match(dit, /result\.items[\s\S]*item\.status === 'failed'/);
  assert.match(bridge, /invoke<TranscodeBatchResult>\('transcode'/);
  assert.match(backend, /struct TranscodeBatchResult[\s\S]*write_workflow_log_blocking/);
});
