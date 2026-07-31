import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isAudioPath,
  isAudioVisualPath,
  isMediaPath,
  isVideoPath,
  mediaExtension,
  partitionMediaPaths,
} from '../src/lib/mediaExtensions.ts';

test('媒体分类严格按扩展名识别并区分视频能力', () => {
  assert.equal(mediaExtension('E:\\CARD\\CLIP.MOV'), 'mov');
  assert.equal(mediaExtension('/card/metadata.XML'), 'xml');
  assert.equal(mediaExtension('/card/no-extension'), '');
  assert.equal(mediaExtension('/card/fake.mp4.log'), 'log');

  assert.equal(isMediaPath('clip.mov'), true);
  assert.equal(isMediaPath('sound.WAV'), true);
  assert.equal(isMediaPath('frame.EXR'), true);
  assert.equal(isMediaPath('camera.log'), false);
  assert.equal(isMediaPath('metadata.xml'), false);
  assert.equal(isMediaPath('fake.mp4x'), false);

  assert.equal(isVideoPath('clip.MOV'), true);
  assert.equal(isVideoPath('sound.wav'), false);
  assert.equal(isAudioPath('sound.wav'), true);
  assert.equal(isAudioVisualPath('sound.wav'), true);
  assert.equal(isAudioVisualPath('frame.exr'), false);
  assert.equal(isVideoPath('metadata.xml'), false);
});

test('任务队列保留支持项并单独返回被跳过项', () => {
  const paths = ['A.mov', 'camera.log', 'B.MP4', 'metadata.xml'];
  assert.deepEqual(partitionMediaPaths(paths, isVideoPath), {
    files: ['A.mov', 'B.MP4'],
    skipped: ['camera.log', 'metadata.xml'],
  });
});

test('素材列表和弹窗沿用统一的非媒体与按钮样式', async () => {
  const [ui, tabs, theme] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(ui, /const nonMedia = !item\.isDirectory && !isMediaPath\(item\.path\)/);
  assert.match(ui, /\$\{nonMedia \? ' is-non-media' : ''\}/);
  assert.match(ui, /const unsupported = !item\.isDirectory && !!acceptsFile && !acceptsFile\(item\.path\)/);
  assert.match(ui, /\$\{unsupported \? ' is-unsupported' : ''\}/);
  assert.match(ui, /disabled=\{disabled \|\| unsupported\}/);
  assert.match(theme, /\.se-filelist li\.is-unsupported[\s\S]*cursor: not-allowed/);

  assert.match(tabs, /\[SKIP\] 已跳过 \$\{skipped\.length\} 个不支持的文件/);
  assert.match(tabs, /<ui\.Button primary icon=\{<IconClose size=\{14\} \/>\} onClick=\{onClose\}>关闭<\/ui\.Button>/);
  assert.match(theme, /\.se-task-error-dialog \.se-dialog-foot > button\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/);
  assert.match(theme, /\.se-update-dialog \.se-dialog-foot > button > span\s*\{[^}]*align-items:\s*center;[^}]*line-height:\s*1;/);
  assert.match(theme, /\.se-update-dialog \.se-dialog-foot > button > svg\s*\{\s*top:\s*0;/);
});
