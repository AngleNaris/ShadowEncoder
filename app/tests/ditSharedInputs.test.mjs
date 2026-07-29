import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('素材列表使用单一入口在同一窗口混选文件和目录', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const picker = await readFile(new URL('../src/components/MediaPickerDialog.tsx', import.meta.url), 'utf8');

  assert.match(app, /<MediaPickerDialog[\s\S]*onConfirm=\{fl\.addPaths\}/);
  assert.match(ui, /onClick=\{onPick\}[\s\S]*>添加素材<\/Button>/);
  assert.doesNotMatch(ui, /onPickFile|onPickDir/);
  assert.match(picker, /aria-multiselectable="true"/);
  assert.match(picker, /entry\.isDirectory \? <IconFolder[\s\S]*: <IconFile/);
  assert.match(picker, /selected\.values\(\)/);
});

test('DIT 备份与流程都从共享素材列表传递混合 sourcePaths', async () => {
  const tabs = await readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');

  assert.doesNotMatch(tabs, /sourceDir|chooseSource/);
  assert.match(tabs, /fl\.hasSelection \? fl\.selectedSourcePaths : fl\.paths/);
  assert.match(tabs, /buildBackupRequest\(form, inputPaths\)/);
  assert.match(tabs, /let sourcePaths = \[\.\.\.inputPaths\]/);
  assert.match(tabs, /buildBackupRequest\(form, state\.paths, new Date\(\)\)/);
  assert.match(bridge, /sourcePaths: string\[\]/);
  assert.match(backend, /source_paths: Vec<String>/);
  assert.match(backend, /metadata\.is_dir\(\)[\s\S]*metadata\.is_file\(\)/);
});

test('DIT 目标与预设列表共用稳定标识的列表动画', async () => {
  const tabs = await readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8');
  const presets = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const theme = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

  assert.match(tabs, /type BackupDestination = \{ id: string; path: string \}/);
  assert.match(tabs, /<ui\.AnimatedList[\s\S]*getKey=\{\(destination\) => destination\.id\}/);
  assert.match(workflow, /<ui\.AnimatedList[\s\S]*items=\{nodes\}[\s\S]*getKey=\{\(node\) => node\.id\}/);
  assert.match(presets, /<ui\.AnimatedList[\s\S]*getKey=\{\(preset\) => preset\.id\}/);
  assert.match(ui, /export function AnimatedList<T>/);
  assert.match(ui, /node\.offsetTop/);
  assert.match(ui, /const pureReorder = orderChanged/);
  assert.match(ui, /exitTimers\.current/);
  assert.match(theme, /grid-template-rows: 0fr/);
  assert.match(theme, /--se-animated-list-gap/);
});

test('动态行不再使用旧的独立入场动画', async () => {
  const tabs = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const theme = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

  assert.match(tabs, /<ui\.AnimatedList[\s\S]*items=\{g\.items\}[\s\S]*className="se-sum-list"/);
  assert.doesNotMatch(`${tabs}\n${ui}\n${theme}`, /se-dynamic-item|@keyframes se-item-enter/);
  assert.doesNotMatch(theme, /@keyframes se-filelist-row-in\s*\{[\s\S]{0,180}translateX/);
  assert.match(ui, /ROW_MOTION_DURATION_MS/);
  assert.match(ui, /layout\?: 'stack' \| 'flow'/);
  assert.match(ui, /enterTimers\.current/);
});

test('DIT 文件模板不暴露扩展名并由后端强制继承源扩展名', async () => {
  const tabs = await readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8');
  const presets = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');

  assert.doesNotMatch(tabs, /token: '\{ext\}'/);
  assert.match(tabs, /placeholder="例如：A001_\{index\}_\{name\}"/);
  assert.match(tabs, /placeholder="例如：\{name\}_\{index\}"/);
  assert.match(presets, /conflictRenameTemplate: '\{name\}_\{index\}'/);
  assert.match(backend, /render_dit_filename[\s\S]*value\.set_extension\(extension\)/);
  assert.match(backend, /render_dit_conflict_filename[\s\S]*value\.set_extension\(extension\)/);
});
