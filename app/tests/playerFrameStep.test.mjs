import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('播放器逐帧控制贯通强类型 bridge 与原生 mpv 命令', async () => {
  const [playerSource, bridgeSource, rustSource, gpuSource, mainSource] = await Promise.all([
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/mpv_player.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/mpv_gpu.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(bridgeSource, /PlayerFrameDirection = 'backward' \| 'forward'/);
  assert.match(bridgeSource, /invoke\('player_step', \{ playerId, direction \}\)/);
  assert.match(rustSource, /Backward => "frame-back-step"/);
  assert.match(rustSource, /Forward => "frame-step"/);
  assert.match(gpuSource, /Request::Step[\s\S]*direction\.mpv_command\(\)/);
  assert.match(mainSource, /mpv_player::player_step/);
  assert.match(playerSource, /aria-label="上一帧"/);
  assert.match(playerSource, /aria-label="下一帧"/);
  assert.match(playerSource, /if \(!ready \|\| controlsDisabled\) return/);
});

test('功能 Tab 立即反馈导航并延后重页面渲染', async () => {
  const [playerSource, appSource, tabsSource, rustSource] = await Promise.all([
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/mpv_player.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /const renderedTab = useDeferredValue\(tab\)/);
  assert.match(appSource, /const switchTab = useCallback[\s\S]*setTab\(\(currentTab\) => currentTab === targetTab \? currentTab : targetTab\)/);
  assert.match(appSource, /const Current = TABS\[renderedTab\]\.Comp/);
  assert.doesNotMatch(appSource, /preparePreviewTransition|PREVIEW_FADE_MS|setTimeout\(resolve|TabActivityProvider|mountedTabs/);
  assert.match(playerSource, /const SHARED_NATIVE_PLAYER_ID = 'shadowencoder-main-preview'/);
  assert.match(playerSource, /ensureNativePlayerInitialized\(mpvPlayerId\)/);
  assert.doesNotMatch(playerSource, /nativePlayerStatusCache|useTabActive|VideoPlayerImpl/);
  assert.match(playerSource, /scheduleNativePlayerHide\(playerId\)[\s\S]*scheduleNativePlayerDestroy\(playerId\)/);
  assert.match(playerSource, /mpvAvailable && \(modalLayerOpen \|\| !mpvPending \|\| !nativeSurfaceRevealReady\)/);
  assert.match(playerSource, /const \[mpvPending, setMpvPending\] = useState\(\(\) => \([\s\S]*Boolean\(props\.filePath\?\.trim\(\)\)/);
  assert.match(playerSource, /if \(!shouldUseMpv\)[\s\S]*if \(!path\) setMpvPending\(false\)/);
  assert.doesNotMatch(playerSource, /subscribePreviewTransition|se-player-content-hidden|nativeFirstFrameRevealReady/);
  assert.match(tabsSource, /const \[src, setSrc\] = useState\(\(\) => initialPath \? mediaPreviewUrl\(initialPath\) : ''\)/);
  assert.match(tabsSource, /const \[path, setPath\] = useState\(initialPath\)/);
  assert.match(rustSource, /media_paths_match\(path, &next_path\)[\s\S]*load reused current media/);
});

test('播放器跨 Tab 共享初始化、串行交接 surface 并延迟销毁实例', async () => {
  const playerSource = await readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8');

  assert.match(playerSource, /const MPV_DESTROY_GRACE_MS = 750/);
  assert.match(playerSource, /nativePlayerInitPromises = new Map<string, Promise<PlayerStatus>>\(\)/);
  assert.match(playerSource, /nativePlayerSurfaceChains = new Map<string, Promise<void>>\(\)/);
  assert.match(playerSource, /acquireNativePlayerLease\(mpvPlayerId\)/);
  assert.match(playerSource, /releaseNativePlayerLease\(mpvPlayerId, playerLease\)/);
  assert.match(playerSource, /pendingNativePlayerHideTimers/);
  assert.match(playerSource, /if \(activeNativePlayerLeases\.has\(playerId\)\) return Promise\.resolve\(false\)/);
  assert.doesNotMatch(playerSource, /createNativePlayerId|mpvDestroyTimerRef/);
});
