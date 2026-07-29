import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MAX_WORKFLOW_CONDITION_DEPTH,
  cloneWorkflowDefinition,
  createWorkflowAction,
  createWorkflowCondition,
  normalizeWorkflowDefinition,
  workflowDepth,
  workflowNodeCounts,
} from '../src/lib/workflow.ts';

test('流程模型保持线性步骤和最多三层条件分支', () => {
  const first = createWorkflowCondition();
  const second = createWorkflowCondition();
  const third = createWorkflowCondition();
  const fourth = createWorkflowCondition();
  first.thenSteps = [second];
  second.thenSteps = [third];
  third.thenSteps = [fourth];
  fourth.thenSteps = [createWorkflowAction('check')];

  const normalized = normalizeWorkflowDefinition({
    trigger: { kind: 'manual' },
    steps: [first],
  });
  assert.equal(MAX_WORKFLOW_CONDITION_DEPTH, 3);
  assert.equal(workflowDepth(normalized.steps), 3);
  assert.deepEqual(workflowNodeCounts(normalized.steps), { actions: 0, conditions: 3 });
});

test('流程深拷贝不会让预设编辑污染当前页面', () => {
  const original = normalizeWorkflowDefinition({});
  const copy = cloneWorkflowDefinition(original);
  copy.trigger.labelContains = 'CARD';
  copy.steps.push(createWorkflowAction('mix'));
  assert.equal(original.trigger.labelContains, '');
  assert.notEqual(copy.steps.length, original.steps.length);
});

test('流程页面接入共享预设管理器且动作只引用功能预设', async () => {
  const [ditTabs, editor, presets, presetStorage, workflowModel, app] = await Promise.all([
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/presetStorage.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/workflow.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);
  const workflowTab = ditTabs.slice(ditTabs.indexOf('export function DitWorkflowTab()'));

  assert.match(workflowTab, /<PresetManager[\s\S]*type="workflow"[\s\S]*builderTitle="流程预设"/);
  assert.match(workflowTab, /<WorkflowEditor value=\{workflow\}/);
  assert.match(workflowTab, /<WorkflowPresetBuilder ctx=\{ctx\}/);
  assert.doesNotMatch(workflowTab, /<BackupFields/);
  assert.match(editor, /usePresets\('backup'\)/);
  assert.match(editor, /usePresets\('encode'\)/);
  assert.match(editor, /usePresets\('mix'\)/);
  assert.match(editor, /usePresets\('check'\)/);
  assert.doesNotMatch(presets, /name: '点歌屏 1080p'|name: '备份并转码'/);
  assert.match(presetStorage, /shadowencoder\.presets\.v2/);
  assert.match(workflowModel, /steps:\s*\[\]/);
  assert.doesNotMatch(workflowModel, /presetId = DEFAULT_PRESET_IDS|backupPresetId: 'backup-default-1'/);
  assert.match(app, /<PresetStoreProvider>/);
});

test('新磁盘监听只在用户启动流程后建立并支持停止等待', async () => {
  const [ditTabs, runtime, app] = await Promise.all([
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/workflowRuntime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);
  const runBody = ditTabs.slice(ditTabs.indexOf('const run = () => task.start(async () => {'));

  assert.match(runBody, /waitForNewStorageVolume\([\s\S]*task\.isCancelled/);
  assert.match(runtime, /let previous = new Map\([\s\S]*await listStorageVolumes\(\)/);
  assert.match(runtime, /while \(!isCancelled\(\)\)/);
  assert.match(runtime, /cancellableDelay\(1000, isCancelled\)/);
  assert.doesNotMatch(app, /listStorageVolumes|waitForNewStorageVolume/);
});

test('自动流程检查全部备份目标容量并禁止移动磁盘源文件', async () => {
  const [ditTabs, runtime, runtimeCore, bridge, backend] = await Promise.all([
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/workflowRuntime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/workflowRuntimeCore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(ditTabs, /磁盘触发流程禁止自动移动源文件/);
  assert.match(ditTabs, /evaluateBackupCapacity\([\s\S]*condition\.reservePercent/);
  assert.match(runtime, /evaluateBackupCapacityForVolumes\(files, volumes, reservePercent\)/);
  assert.match(runtimeCore, /sourceBytes \* destinationCount/);
  assert.match(runtimeCore, /availableBytes >= requiredBytes \+ reserveBytes/);
  assert.match(runtime, /getStorageVolume\(destination\)/);
  assert.match(bridge, /rootSizeBytes: number \| null/);
  assert.match(backend, /root_size_bytes: Option<u64>/);
  assert.match(backend, /metadata\.is_file\(\)\.then_some\(metadata\.len\(\)\)/);
});
