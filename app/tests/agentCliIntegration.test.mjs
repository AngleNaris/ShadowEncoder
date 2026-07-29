import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  registerAgentTaskHandler,
  waitForAgentTaskHandler,
} from '../src/lib/agentTaskBridge.ts';

test('Agent 任务桥等待当前功能页挂载并在卸载后释放执行器', async () => {
  const pending = waitForAgentTaskHandler('encode', 100);
  const handler = async () => ({ status: 'canceled' });
  const unregister = registerAgentTaskHandler('encode', handler);
  assert.equal(await pending, handler);
  unregister();
  await assert.rejects(waitForAgentTaskHandler('encode', 5), /执行器超时/);
});

test('六类 Agent 任务都复用 GUI 执行链并应用非破坏约束', async () => {
  const [app, tabs, ditTabs] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
  ]);

  for (const taskFunction of ['encode', 'mix', 'check', 'alpha']) {
    assert.match(tabs, new RegExp(`registerAgentTaskHandler\\('${taskFunction}'`));
  }
  for (const taskFunction of ['backup', 'workflow']) {
    assert.match(ditTabs, new RegExp(`registerAgentTaskHandler\\('${taskFunction}'`));
  }
  assert.match(tabs, /uniqueName:\s*true/);
  assert.match(ditTabs, /operation:\s*'copy',\s*reuseIdentical:\s*false/);
  assert.match(ditTabs, /uniqueName:\s*environment\.agentMode/);
  assert.match(app, /waitForAgentTaskHandler\(current\.function\)/);
  assert.match(app, /status:\s*'completed'/);
  assert.match(app, /status:\s*'failed'/);
  assert.match(app, /status:\s*'canceled'/);
});

test('Agent 执行只消费冻结预设快照并串行回写取消与进度', async () => {
  const [app, tabs, ditTabs] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
  ]);

  assert.ok((tabs.match(/agentTask\.presetSnapshots/g) ?? []).length >= 5);
  assert.doesNotMatch(tabs, /requireAgentPreset\(agentPresets/);
  assert.match(ditTabs, /findPreset\(agentTask\.presetSnapshots, agentTask\.presetId, '备份', 'backup'\)/);
  assert.match(ditTabs, /findPreset\(agentTask\.presetSnapshots, agentTask\.presetId, '流程', 'workflow'\)/);
  assert.match(ditTabs, /agentPresetSets:\s*WorkflowPresetSets/);

  assert.match(app, /cancelAgentTask\(taskId\)/);
  assert.match(app, /progressWriteQueueRef\.current = progressWriteQueueRef\.current\.then/);
  assert.match(app, /await progressWriteQueueRef\.current/);
  assert.match(app, /Math\.max\(previous, update\.progress\)/);
});
