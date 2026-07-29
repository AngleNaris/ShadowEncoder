import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('截取功能只提供真实编码预设，不再暴露含糊默认项', async () => {
  const tabs = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');
  const presets = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(tabs, /默认（MOV·ProRes4444 \/ 其他·H\.264）/);
  assert.doesNotMatch(presets, /默认（MOV·ProRes4444 \/ 其他·H\.264）/);
  assert.match(presets, /key:\s*'clipPresetId'[\s\S]{0,120}default:\s*''/);
  assert.match(tabs, /disabled=\{!rangeValid \|\| clipPresetMissing\}/);
});

test('截取任务将预设中的像素格式和音频设置传递给后端', async () => {
  const source = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8');

  assert.match(source, /segPixFmt, segAc, segAbr\)/);
  assert.match(bridge, /pixelFormat/);
  assert.match(bridge, /audioCodec/);
  assert.match(bridge, /audioBitrate/);
});
