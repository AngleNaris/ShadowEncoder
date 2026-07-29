import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_EXPORT_DIMENSIONS,
  dimensionsForCropAspect,
} from '../src/lib/outputDimensions.ts';

test('匹配输出尺寸在没有选区时采用视频显示尺寸', () => {
  assert.deepEqual(
    dimensionsForCropAspect('match', { width: 1920, height: 1080 }, null, { width: 480, height: 270 }),
    { width: 1920, height: 1080 },
  );
});

test('匹配输出尺寸优先从当前选区反算输出宽高', () => {
  assert.deepEqual(
    dimensionsForCropAspect(
      'match',
      { width: 1920, height: 1080 },
      { x: 100, y: 50, w: 853, h: 480 },
      { width: 480, height: 270 },
    ),
    { width: 853, height: 480 },
  );
});

test('自由与匹配模式共享选区尺寸数据流，固定比例保留手工输出尺寸', () => {
  const media = { width: 3840, height: 2160 };
  const crop = { x: 10, y: 20, w: 1280, h: 720 };
  const current = { width: 640, height: 360 };

  assert.deepEqual(dimensionsForCropAspect('free', media, crop, current), { width: 1280, height: 720 });
  assert.deepEqual(dimensionsForCropAspect('16:9', media, crop, current), current);
});

test('截图/GIF/WebP/截取共用非零默认输出尺寸', () => {
  assert.deepEqual(DEFAULT_EXPORT_DIMENSIONS, { width: 480, height: 270 });
});

test('媒体尚未加载时匹配模式保留当前有效尺寸', () => {
  assert.deepEqual(
    dimensionsForCropAspect('match', null, null, { width: 800, height: 450 }),
    { width: 800, height: 450 },
  );
});

test('清除选区同时清空播放器状态并向尺寸状态发布 0×0 选区', async () => {
  const { clearOutputCropSelection } = await import('../src/lib/outputDimensions.ts');
  const calls = [];

  clearOutputCropSelection(
    (crop) => calls.push(['state', crop]),
    (crop) => calls.push(['change', crop]),
  );

  assert.deepEqual(calls, [
    ['state', null],
    ['change', { x: 0, y: 0, w: 0, h: 0 }],
  ]);
});

test('切换比例不会通过素材初始化 effect 覆盖选区或预设反算出的尺寸', async () => {
  const source = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('}, [media.info, aspect]);'), false);
  assert.equal(source.match(/}, \[media\.info\]\);/g)?.length, 2);
});

test('截图/GIF/WebP/截取的预设 schema 共用默认尺寸且不携带内置预设', async () => {
  const source = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');
  assert.equal(source.match(/default: DEFAULT_EXPORT_DIMENSIONS\.width/g)?.length, 4);
  assert.equal(source.match(/default: DEFAULT_EXPORT_DIMENSIONS\.height/g)?.length, 4);
  assert.doesNotMatch(source, /DEFAULT_PRESETS|shot-default-1|seg-default-1|gif-default-1|webp-default-1/);
});
