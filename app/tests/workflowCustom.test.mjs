import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildEncodeNameLabels } from '../src/lib/outputNaming.ts';
import {
  createWorkflowGraph, createWorkflowGraphMaterial, createWorkflowGraphScript, createWorkflowGraphOutput, createWorkflowGraphAction, createWorkflowGraphOutputOverride,
  connectWorkflowGraph, removeWorkflowGraphNode, normalizeWorkflowGraph, workflowGraphIssues,
  executeWorkflowGraphDAG, WORKFLOW_GRAPH_START_ID, DEFAULT_WORKFLOW_SCRIPT,
} from '../src/lib/workflowGraph.ts';
import { applyOutputOverride, mergeOutputOverride } from '../src/lib/workflowOutput.ts';

test('custom material graph persists without default input and merges in connection order', async () => {
  const a = createWorkflowGraphMaterial('a.mov');
  const b = createWorkflowGraphMaterial('b.mov');
  const script = createWorkflowGraphScript();
  const output = createWorkflowGraphOutput();
  const encode = createWorkflowGraphAction('transcode');
  let graph = { ...createWorkflowGraph(), nodes: [a, b, script, encode, output] };
  graph = removeWorkflowGraphNode(graph, WORKFLOW_GRAPH_START_ID);
  graph = connectWorkflowGraph(graph, b.id, 'media', script.id, 'media');
  graph = connectWorkflowGraph(graph, a.id, 'media', script.id, 'media');
  graph = connectWorkflowGraph(graph, script.id, 'media', encode.id, 'media');
  graph = connectWorkflowGraph(graph, encode.id, 'media', output.id, 'media');
  graph = normalizeWorkflowGraph(JSON.parse(JSON.stringify(graph)));
  assert.equal(graph.startEnabled, false);
  assert.deepEqual(workflowGraphIssues(graph), []);
  assert.equal(connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', script.id, 'media'), graph);
  let received;
  const result = await executeWorkflowGraphDAG(graph, ['unrelated.mov'], {
    runAction: async (_node, assets) => ({ media: { type: 'media', assets: assets.map(asset => ({ ...asset, path: 'result.mp4' })) } }),
    runProbe: async () => { throw new Error('unexpected probe'); },
    runScript: async (_node, assets) => {
      received = assets.map(asset => asset.path);
      return { media: { type: 'media', assets: [{ ...assets[0], path: 'result.mp4' }] } };
    },
  });
  assert.deepEqual(received, ['b.mov', 'a.mov']);
  assert.equal(result.outputs.get(output.id).media.assets[0].path, 'result.mp4');
  assert.equal(result.errors.values.size, 0);
  const failed = await executeWorkflowGraphDAG(graph, [], {
    runAction: async () => ({}), runProbe: async () => ({}),
    runScript: async () => { throw new Error('invalid script'); },
  });
  assert.equal(failed.errors.values.size, 2);
  assert.ok([...failed.errors.values.values()].every(message => message === 'invalid script'));
  assert.equal(failed.outputs.has(output.id), false);
  assert.ok(workflowGraphIssues(removeWorkflowGraphNode(graph, output.id)).some(issue => issue.includes('文件输出')));
  assert.ok(workflowGraphIssues({ ...graph, edges: [] }).some(issue => issue.includes('缺少')));
  const plan = vm.runInNewContext('(function(inputs){' + DEFAULT_WORKFLOW_SCRIPT + '})(inputs)', { inputs: [{}, {}] }, { timeout: 1000 });
  assert.match(plan.filterComplex, /\[0:v\].*\[1:v\].*hstack=inputs=2\[out\]/s);
  assert.equal(plan.format, undefined);
  const withoutEncode = connectWorkflowGraph(removeWorkflowGraphNode(graph, encode.id), script.id, 'media', output.id, 'media');
  assert.ok(workflowGraphIssues(withoutEncode).some(issue => issue.includes('编码节点')));
});

test('output overrides remain branch local, inherit independently and survive serialization', async () => {
  const left = createWorkflowGraphOutputOverride();
  left.override = { ...left.override, location: 'fixed', directory: 'D:/left' };
  const right = createWorkflowGraphOutputOverride();
  right.override = { ...right.override, naming: 'template', nameTemplate: 'right.{name}' };
  const output = createWorkflowGraphOutput();
  let graph = { ...createWorkflowGraph(), nodes: [left, right, output] };
  for (const node of [left, right]) {
    graph = connectWorkflowGraph(graph, WORKFLOW_GRAPH_START_ID, 'media', node.id, 'media');
    graph = connectWorkflowGraph(graph, node.id, 'media', output.id, 'media');
  }
  graph = normalizeWorkflowGraph(JSON.parse(JSON.stringify(graph)));
  const result = await executeWorkflowGraphDAG(graph, ['a.mov'], { runAction: async () => ({}), runProbe: async () => ({}) });
  const assets = result.outputs.get(output.id).media.assets;
  assert.equal(assets.length, 2);
  assert.equal(assets[0].outputOverride.directory, 'D:/left');
  assert.equal(assets[1].outputOverride.location, 'inherit');
  const merged = mergeOutputOverride(left.override, right.override);
  const preset = { mode: 'rename', nameTemplate: '{name}_A', directory: '', subdirectory: 'base', presetName: 'A' };
  assert.equal(applyOutputOverride(preset, left.override).nameTemplate, '{name}_A');
  assert.deepEqual(applyOutputOverride(preset, merged), { ...preset, mode: 'fixedRename', directory: 'D:/left', subdirectory: 'ShadowEncoder', nameTemplate: 'right.{name}' });
  assert.equal(preset.mode, 'rename');
  assert.equal(applyOutputOverride({ ...preset, mode: 'subdir' }, right.override).mode, 'subdirRename');
});

test('encode naming follows active scaling, audio and lossless/copy settings', () => {
  const base = { scaleW: 1920, scaleH: 1080, scaleMode: 'dimensions', keepRes: false, fps: 25, videoCodec: 'libx264', crf: 23 };
  assert.deepEqual(buildEncodeNameLabels(base), { resolution: '1920x1080', fpsLabel: '25fps', codecLabel: 'H264', bitrateLabel: 'CRF23' });
  assert.equal(buildEncodeNameLabels({ ...base, scaleMode: 'original', keepRes: true }).resolution, 'orig');
  assert.equal(buildEncodeNameLabels({ ...base, keepRes: true }).resolution, '1920x1080');
  assert.equal(buildEncodeNameLabels({ ...base, scaleMode: 'longEdge', scaleEdge: 1280 }).resolution, 'long1280');
  assert.equal(buildEncodeNameLabels({ ...base, crf: 0 }).bitrateLabel, 'CRF0');
  assert.equal(buildEncodeNameLabels({ ...base, videoCodec: 'copy' }).bitrateLabel, 'copy');
  assert.equal(buildEncodeNameLabels({ ...base, outputKind: 'audio', audioCodec: 'aac', audioBitrate: 192 }).codecLabel, 'aac');
});
