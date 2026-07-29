import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ComboBox 共用标签结构，但仅菜单项使用固定标签列', async () => {
  const [ui, theme, muiTheme] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/muiTheme.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(ui, /export type ComboBoxOption = \{[\s\S]*tags\?: readonly \(string \| number\)\[\]/);
  assert.match(ui, /selected \? <ComboBoxOptionContent option=\{selected\} \/> : s/);
  assert.match(ui, /<MenuItem[\s\S]*<ComboBoxOptionContent option=\{o\} tagAreaWidth=\{menuTagAreaWidth\} \/>/);
  assert.match(theme, /\.se-combo-option-label[\s\S]*text-overflow: ellipsis/);
  assert.match(theme, /\.se-combo-option-tags[\s\S]*flex: 0 0 auto/);
  assert.doesNotMatch(theme, /\.MuiMenuItem-root > \.se-combo-option \{ padding-right:/);
  assert.match(theme, /\.se-combo-option-tag[\s\S]*background: var\(--surface-3\)/);
  assert.match(muiTheme, /"& \.MuiSelect-select": \{[\s\S]*minWidth: 0,[\s\S]*overflow: "hidden"/);
});

test('编码与导出选项不再把附加说明拼进主文字', async () => {
  const [tabs, presets] = await Promise.all([
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(tabs, /label: 'H\.264', value: 'libx264', tags: \['libx264'\]/);
  assert.match(tabs, /label: 'medium', value: 'medium', tags: \['默认'\]/);
  assert.match(tabs, /label: 'yuv420p', value: 'yuv420p', tags: \['最兼容'\]/);
  assert.match(tabs, /label: '1920 × 1080', value: '1920x1080', tags: \['1080p'\]/);
  assert.doesNotMatch(tabs, /H\.264 · libx264|medium \(默认\)|yuv420p \(最兼容\)|质量优先 · CRF/);
  assert.match(presets, /label: '智能压缩', value: 'optimized', tags: \['推荐'\]/);
  assert.match(presets, /label: p\.name,[\s\S]*tags: p\.params\.container \? \[String\(p\.params\.container\)\.toUpperCase\(\)\]/);
});

test('DIT 与流程选项把动作和分类放入标签', async () => {
  const [dit, workflow] = await Promise.all([
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(dit, /label: '复制', value: 'copy', tags: \['保留源文件'\]/);
  assert.match(dit, /label: '移动', value: 'move', tags: \['成功后删除源文件'\]/);
  assert.match(workflow, /tags: \['执行', \.\.\.option\.tags\]/);
  assert.match(workflow, /label: '条件判断', value: 'condition', tags: \['逻辑'\]/);
  assert.match(workflow, /options=\{addOptions\}[\s\S]*menuTagAreaWidth=\{68\}/);
  assert.doesNotMatch(workflow, /label: `执行 ·|label: '逻辑 · 条件判断'/);
});
