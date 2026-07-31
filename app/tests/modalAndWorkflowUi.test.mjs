import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isModalLayerOpen,
  prepareModalLayer,
  registerModalLayer,
  subscribeModalLayerPreparation,
} from '../src/lib/modalLayer.ts';

test('模态层使用引用计数并允许幂等释放', () => {
  assert.equal(isModalLayerOpen(), false);
  const releaseFirst = registerModalLayer();
  const releaseSecond = registerModalLayer();
  assert.equal(isModalLayerOpen(), true);
  releaseFirst();
  assert.equal(isModalLayerOpen(), true);
  releaseFirst();
  assert.equal(isModalLayerOpen(), true);
  releaseSecond();
  assert.equal(isModalLayerOpen(), false);
});

test('模态层等待原生 surface 隐藏完成后再解除显示阻塞', async () => {
  let finishPreparation;
  let settled = false;
  const unsubscribe = subscribeModalLayerPreparation(() => new Promise((resolve) => {
    finishPreparation = resolve;
  }));

  const preparation = prepareModalLayer().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finishPreparation();
  await preparation;
  assert.equal(settled, true);
  unsubscribe();
});

test('预设弹窗会遮挡原生播放器 surface', async () => {
  const [presetSource, playerSource] = await Promise.all([
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(presetSource, /function PresetManageDialog[\s\S]*useModalLayerRegistration\(!closing\)/);
  assert.match(playerSource, /const modalLayerOpen = useModalLayerOpen\(\)/);
  assert.match(playerSource, /!mpvActive \|\| mpvRenderer !== 'gpu' \|\| !ready \|\| modalLayerOpen/);
});

test('全部弹窗注册共享模态层且播放器保留帧与弹窗同速淡出', async () => {
  const [appSource, pickerSource, tabsSource, playerSource, theme] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/MediaPickerDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /function UpdateDialog[\s\S]*useModalLayerRegistration\(\)/);
  assert.match(appSource, /function AppSettingsDialog[\s\S]*useModalLayerRegistration\(\)/);
  assert.match(pickerSource, /function MediaPickerDialog[\s\S]*useModalLayerRegistration\(open\)/);
  assert.match(tabsSource, /function TaskFailureDialog[\s\S]*useModalLayerRegistration\(\)/);
  assert.match(playerSource, /playerFrame\(mpvPlayerId, 960\)/);
  assert.match(playerSource, /surfaceGenerationRef/);
  assert.match(playerSource, /surface\.visible && \(generation !== surfaceGenerationRef\.current \|\| isModalLayerOpen\(\)\)/);
  assert.match(playerSource, /modalPreviewHidden \? ' se-player-modal-hidden' : ''/);
  assert.match(playerSource, /se-player-modal-hidden/);
  assert.match(playerSource, /previewFrame\(filePathRef\.current, timeRef\.current, 960\)/);
  assert.match(playerSource, /setModalPreviewHidden\(false\)[\s\S]*setTimeout\(\(\) => \{/);
  assert.match(playerSource, /useLayoutEffect\(\(\) => subscribeModalLayerPreparation\(\(\) => \{/);
  assert.match(playerSource, /return queueSurfaceUpdate\(\{ x: 0, y: 0, width: 1, height: 1, visible: false \}, generation\)/);
  assert.match(playerSource, /hide native preview before modal failed/);
  assert.match(theme, /html\.se-modal-layer-pending \.se-dialog-backdrop \{[\s\S]*visibility: hidden/);
  assert.match(playerSource, /useLayoutEffect\(\(\) => \{\s*if \(!modalLayerOpen\)/);
  assert.match(playerSource, /useLayoutEffect\(\(\) => \{\s*if \(modalLayerOpen\)/);
  assert.match(playerSource, /!ready \|\| modalLayerOpen[\s\S]*!nativeSurfaceRevealReady/);
  assert.doesNotMatch(playerSource, /nativeFirstFrameRevealReady|se-player-content-hidden/);
  assert.match(appSource, /<ui\.AnimatedHeight>[\s\S]*se-update-message[\s\S]*<\/ui\.AnimatedHeight>/);
  assert.match(theme, /\.se-dialog\s*\{[\s\S]*animation:\s*se-dialog-in 160ms/);
  assert.match(theme, /\.se-player-canvas, \.se-player-video\s*\{[\s\S]*transition:\s*opacity 160ms/);
});

test('更新检查读取 GitHub Release 且仓库链接调用受限系统浏览器命令', async () => {
  const [appSource, bridgeSource, rustSource] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /openUrl\(repositoryUrl\)/);
  assert.match(bridgeSource, /invoke<void>\('open_url', \{ url \}\)/);
  assert.match(rustSource, /api\.github\.com\/repos\/AngleNaris\/shadowencoder\/releases\/latest/);
  assert.match(rustSource, /async fn update_check\(\)[\s\S]*run_blocking\(update_check_blocking\)\.await/);
  assert.match(rustSource, /fn is_allowed_project_url/);
});

test('流程最后一步删除时空态同步过渡且节点保留右间距', async () => {
  const [uiSource, theme] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(uiSource, /const showEmpty = items\.length === 0 && empty != null/);
  assert.match(uiSource, /se-animated-list-empty\$\{entries\.length > 0 \? ' is-entering' : ''\}/);
  assert.match(theme, /\.se-workflow-node\s*\{[^}]*padding:\s*8px 8px 8px 9px;/);
  assert.match(theme, /@keyframes se-list-empty-enter[\s\S]*grid-template-rows:\s*0fr[\s\S]*grid-template-rows:\s*1fr/);
});
