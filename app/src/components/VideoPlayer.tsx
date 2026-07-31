// ShadowEncoder 统一播放器 —— 复刻原 CvPlayer 交互（性能：按需绘制，不整文件进内存）
import React, {
  forwardRef, useImperativeHandle, useRef, useState, useEffect, useLayoutEffect, useCallback,
} from 'react';
import {
  isTauriRuntime,
  mediaBlobUrl,
  playerDestroy,
  playerInit,
  playerLoad,
  playerPause,
  playerPlay,
  previewFrame,
  playerSeek,
  playerStep,
  playerFrame,
  playerSetSurface,
  playerStatus,
  subscribePlayerSelection,
  type PlayerFrame,
  type PlayerFrameDirection,
  type PlayerSelectionEvent,
  type PlayerStatus,
} from '../lib/ffmpeg';
import { clearOutputCropSelection } from '../lib/outputDimensions';
import {
  isModalLayerOpen,
  subscribeModalLayerPreparation,
  useModalLayerOpen,
} from '../lib/modalLayer';
import { useAppTheme } from '../lib/AppThemeProvider';
import { deriveAccentPalette, deriveThemeChromePalette } from '../lib/themeAccent';

export interface CropRectResult {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoPlayerHandle {
  loadVideo: (src: string) => void;
  getCurrentTime: () => number;
  getCropRect: () => CropRectResult;
  getMediaDimensions: () => { width: number; height: number } | null;
  setCropAspect: (w: number, h: number) => void;
  clearCrop: () => void;
  setLoopRange: (start: number, end: number) => void;
}

interface Props {
  src?: string;
  /** 原始本地路径：供原生播放器使用，非 Windows 平台也可用于 Blob 回退。 */
  filePath?: string;
  onFrame?: (timeSec: number) => void;
  onCropChange?: (rect: CropRectResult) => void;
  compact?: boolean;
  /** 需要透明棋盘格时 true；普通预览 false 直接用 video 更省 */
  alphaPreview?: boolean;
  /** 是否允许在播放器上绘制/编辑裁剪选区；不支持选取截取输出的页面传 false */
  cropEnabled?: boolean;
  /** 锁定选区：禁止绘制、移动、缩放（仅用于展示） */
  cropLocked?: boolean;
  /** 只读进度监视模式：播放器暂停并跟随外部时间。 */
  monitorMode?: boolean;
  /** 保留控制栏外观，但禁止播放、拖动、区间与裁剪交互。 */
  controlsDisabled?: boolean;
  followTime?: number;
  emptyText?: string;
  /** Optional export range rendered over the seek bar. */
  rangeStart?: number | null;
  rangeEnd?: number | null;
  onRangeStartChange?: (timeSec: number) => void;
  onRangeEndChange?: (timeSec: number) => void;
  rangeLooping?: boolean;
  onRangeLoopingChange?: (enabled: boolean) => void;
}

type Crop = { x: number; y: number; w: number; h: number };
type VideoBounds = { x: number; y: number; w: number; h: number };
type PlayerBackend = 'webview' | 'mpv';
type PlaybackSnapshot = { time: number; playing: boolean };
type DragState = {
  startX: number;
  startY: number;
  mode: 'new' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se';
  offX?: number;
  offY?: number;
};

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const HANDLE_HIT = 12;
const MIN_CROP_SIZE = 4;
const MPV_FIRST_FRAME_TIMEOUT_MS = 20000;
const MPV_DESTROY_GRACE_MS = 750;
const SHARED_NATIVE_PLAYER_ID = 'shadowencoder-main-preview';
const WEBVIEW_FRAME_STEP_SECONDS = 1 / 30;
const activeNativePlayerLeases = new Map<string, symbol>();
const pendingNativePlayerHideTimers = new Map<string, number>();
const pendingNativePlayerDestroyTimers = new Map<string, number>();
const nativePlayerInitPromises = new Map<string, Promise<PlayerStatus>>();
const nativePlayerSurfaceChains = new Map<string, Promise<void>>();

type NativeSurfaceConfig = Parameters<typeof playerSetSurface>[1];

function enqueueNativePlayerOperation<T>(playerId: string, operation: () => Promise<T>): Promise<T> {
  const previous = nativePlayerSurfaceChains.get(playerId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  nativePlayerSurfaceChains.set(playerId, settled);
  void settled.then(() => {
    if (nativePlayerSurfaceChains.get(playerId) === settled) {
      nativePlayerSurfaceChains.delete(playerId);
    }
  });
  return result;
}

function ensureNativePlayerInitialized(playerId: string): Promise<PlayerStatus> {
  const existing = nativePlayerInitPromises.get(playerId);
  if (existing) return existing;
  const initialization = playerInit(playerId);
  nativePlayerInitPromises.set(playerId, initialization);
  void initialization.catch(() => {
    if (nativePlayerInitPromises.get(playerId) === initialization) {
      nativePlayerInitPromises.delete(playerId);
    }
  });
  return initialization;
}

function scheduleNativePlayerHide(playerId: string) {
  if (activeNativePlayerLeases.has(playerId)) return;
  const pendingTimer = pendingNativePlayerHideTimers.get(playerId);
  if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
  const timer = window.setTimeout(() => {
    pendingNativePlayerHideTimers.delete(playerId);
    if (activeNativePlayerLeases.has(playerId)) return;
    void enqueueNativePlayerOperation(playerId, () => {
      if (activeNativePlayerLeases.has(playerId)) return Promise.resolve(false);
      return playerSetSurface(playerId, { x: 0, y: 0, width: 1, height: 1, visible: false });
    }).catch(() => undefined);
  }, 0);
  pendingNativePlayerHideTimers.set(playerId, timer);
}

function scheduleNativePlayerDestroy(playerId: string) {
  if (activeNativePlayerLeases.has(playerId)) return;
  const pendingTimer = pendingNativePlayerDestroyTimers.get(playerId);
  if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
  const timer = window.setTimeout(() => {
    pendingNativePlayerDestroyTimers.delete(playerId);
    if (activeNativePlayerLeases.has(playerId)) return;
    void enqueueNativePlayerOperation(playerId, async () => {
      if (activeNativePlayerLeases.has(playerId)) return;
      nativePlayerInitPromises.delete(playerId);
      await playerDestroy(playerId);
    }).catch(() => undefined);
  }, MPV_DESTROY_GRACE_MS);
  pendingNativePlayerDestroyTimers.set(playerId, timer);
}

function acquireNativePlayerLease(playerId: string) {
  const lease = Symbol(playerId);
  activeNativePlayerLeases.set(playerId, lease);
  const pendingHideTimer = pendingNativePlayerHideTimers.get(playerId);
  if (pendingHideTimer !== undefined) {
    window.clearTimeout(pendingHideTimer);
    pendingNativePlayerHideTimers.delete(playerId);
  }
  const pendingDestroyTimer = pendingNativePlayerDestroyTimers.get(playerId);
  if (pendingDestroyTimer !== undefined) {
    window.clearTimeout(pendingDestroyTimer);
    pendingNativePlayerDestroyTimers.delete(playerId);
  }
  return lease;
}

function releaseNativePlayerLease(playerId: string, lease: symbol) {
  if (activeNativePlayerLeases.get(playerId) !== lease) return;
  activeNativePlayerLeases.delete(playerId);
  scheduleNativePlayerHide(playerId);
  scheduleNativePlayerDestroy(playerId);
}

function requiresNativeGpuPreview() {
  return isTauriRuntime()
    && typeof navigator !== 'undefined'
    && /Windows/i.test(navigator.userAgent);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function cropFromNewDrag(
  startX: number,
  startY: number,
  point: { x: number; y: number },
  bounds: VideoBounds,
  aspect: number | null,
): Crop {
  const left = Math.min(startX, point.x);
  const top = Math.min(startY, point.y);
  const maxWidth = bounds.x + bounds.w - left;
  const maxHeight = bounds.y + bounds.h - top;
  let w = Math.min(Math.abs(point.x - startX), maxWidth);
  let h = Math.min(Math.abs(point.y - startY), maxHeight);
  if (aspect && aspect > 0) {
    w = Math.min(w, maxWidth);
    h = w / aspect;
    if (h > maxHeight) {
      h = maxHeight;
      w = h * aspect;
    }
  }
  return { x: left, y: top, w, h };
}

function cropFromResize(
  current: Crop,
  point: { x: number; y: number },
  bounds: VideoBounds,
  mode: DragState['mode'],
  aspect: number | null,
): Crop {
  const rightBound = bounds.x + bounds.w;
  const bottomBound = bounds.y + bounds.h;
  const hasWest = mode.includes('w');
  const hasNorth = mode.includes('n');
  const anchorX = hasWest ? current.x + current.w : current.x;
  const anchorY = hasNorth ? current.y + current.h : current.y;
  const maxWidth = hasWest ? anchorX - bounds.x : rightBound - anchorX;
  const maxHeight = hasNorth ? anchorY - bounds.y : bottomBound - anchorY;

  const pointerWidth = hasWest
    ? anchorX - clamp(point.x, bounds.x, anchorX)
    : clamp(point.x, anchorX, rightBound) - anchorX;
  const pointerHeight = hasNorth
    ? anchorY - clamp(point.y, bounds.y, anchorY)
    : clamp(point.y, anchorY, bottomBound) - anchorY;

  let w: number;
  let h: number;
  if (aspect && aspect > 0) {
    const maxAspectWidth = Math.min(maxWidth, maxHeight * aspect);
    const minAspectWidth = Math.min(maxAspectWidth, Math.max(MIN_CROP_SIZE, MIN_CROP_SIZE * aspect));
    w = clamp(Math.max(pointerWidth, pointerHeight * aspect), minAspectWidth, maxAspectWidth);
    h = w / aspect;
  } else {
    w = Math.max(MIN_CROP_SIZE, Math.min(pointerWidth, maxWidth));
    h = Math.max(MIN_CROP_SIZE, Math.min(pointerHeight, maxHeight));
  }

  const left = hasWest ? anchorX - w : anchorX;
  const top = hasNorth ? anchorY - h : anchorY;
  return { x: left, y: top, w, h };
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>((props, ref) => {
  const [mpvPlayerId] = useState(() => SHARED_NATIVE_PLAYER_ID);
  const modalLayerOpen = useModalLayerOpen();
  const { accentColor, colorScheme } = useAppTheme();
  const nativeSelectionAccent = deriveAccentPalette(accentColor, colorScheme).bright;
  const themeChrome = deriveThemeChromePalette(accentColor, colorScheme);
  const checkerThemeKey = `${themeChrome.checkerDark}/${themeChrome.checkerLight}`;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mpvFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const backendRef = useRef<PlayerBackend>('webview');
  const mpvActiveRef = useRef(false);
  const mpvInitPromiseRef = useRef<Promise<PlayerStatus> | null>(null);
  const mpvFirstFrameTimerRef = useRef<number | null>(null);
  const mpvFirstFrameSeenRef = useRef(false);
  const componentMountedRef = useRef(false);
  const mpvLoadTokenRef = useRef(0);
  const mpvLoadChainRef = useRef<Promise<void>>(Promise.resolve());
  const surfaceGenerationRef = useRef(0);
  const modalFrameTokenRef = useRef(0);
  const modalWasOpenRef = useRef(false);
  const [nativeSurfaceRevealReady, setNativeSurfaceRevealReady] = useState(true);
  const [modalPreviewHidden, setModalPreviewHidden] = useState(false);
  const [modalSnapshotStatus, setModalSnapshotStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const mpvStatusRef = useRef<PlayerStatus | null>(null);
  const mediaSizeRef = useRef({ width: 0, height: 0 });
  const timeRef = useRef(0);
  const durationRef = useRef(0);
  const rafRef = useRef(0);
  const checkerTileRef = useRef<HTMLCanvasElement | null>(null);
  const checkerScaleRef = useRef(0);
  const checkerThemeRef = useRef('');
  const loopSeekingRef = useRef(false);
  const lastUiUpdateRef = useRef(0);
  const pendingFollowTimeRef = useRef(0);
  const onFrameRef = useRef(props.onFrame);
  const onCropChangeRef = useRef(props.onCropChange);
  onFrameRef.current = props.onFrame;
  onCropChangeRef.current = props.onCropChange;

  const alpha = props.alphaPreview === true;
  const cropEnabled = props.cropEnabled === true;
  const monitorMode = props.monitorMode === true;
  const controlsDisabled = props.controlsDisabled === true || monitorMode;
  const cropLocked = props.cropLocked === true || controlsDisabled;

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [cropCursor, setCropCursor] = useState<React.CSSProperties['cursor']>('default');
  const [nativeCropAspect, setNativeCropAspect] = useState<number | null>(null);
  const [mpvActive, setMpvActive] = useState(false);
  const [mpvPending, setMpvPending] = useState(() => (
    isTauriRuntime() && Boolean(props.filePath?.trim())
  ));
  const [mpvAvailable, setMpvAvailable] = useState(false);
  const [mpvRenderer, setMpvRenderer] = useState<PlayerStatus['renderer']>('none');
  const [mediaLayoutRevision, setMediaLayoutRevision] = useState(0);
  const cropRef = useRef<Crop | null>(null);
  const aspectRef = useRef<number | null>(null);
  const loopRef = useRef<{ s: number; e: number }>({ s: 0, e: 0 });
  const dragRef = useRef<DragState | null>(null);
  const needPaintRef = useRef(true);
  /** 当前生效的 object URL（Blob 回退），卸载时 revoke */
  const blobUrlRef = useRef<string | null>(null);
  /** 是否已尝试过 Blob 回退，避免死循环 */
  const blobTriedRef = useRef(false);
  const webErrorRef = useRef(false);
  const webViewRestoreRef = useRef<PlaybackSnapshot | null>(null);
  const playingRef = useRef(false);
  const filePathRef = useRef(props.filePath ?? '');
  filePathRef.current = props.filePath ?? '';
  const loadTokenRef = useRef(0);

  const setMediaDimensions = useCallback((width: number, height: number) => {
    const nextWidth = Number.isFinite(width) && width > 0 ? width : 0;
    const nextHeight = Number.isFinite(height) && height > 0 ? height : 0;
    const current = mediaSizeRef.current;
    if (current.width === nextWidth && current.height === nextHeight) return;
    mediaSizeRef.current = { width: nextWidth, height: nextHeight };
    setMediaLayoutRevision((revision) => revision + 1);
  }, []);

  const setCropState = useCallback((next: Crop | null) => {
    cropRef.current = next;
    setCrop(next);
  }, []);

  const queueSurfaceUpdate = useCallback((
    surface: NativeSurfaceConfig,
    generation = surfaceGenerationRef.current,
  ) => enqueueNativePlayerOperation(mpvPlayerId, () => {
    // Native surfaces live outside the WebView stacking context. A stale
    // layout request must never make one visible over an active dialog.
    if (surface.visible && (generation !== surfaceGenerationRef.current || isModalLayerOpen())) {
      return Promise.resolve(false);
    }
    return playerSetSurface(mpvPlayerId, surface);
  }), [mpvPlayerId]);

  useLayoutEffect(() => subscribeModalLayerPreparation(() => {
    const generation = ++surfaceGenerationRef.current;
    return queueSurfaceUpdate({ x: 0, y: 0, width: 1, height: 1, visible: false }, generation)
      .then(() => undefined)
      .catch((surfaceError) => console.error('[ShadowEncoder] hide native preview before modal failed', surfaceError));
  }), [queueSurfaceUpdate]);

  const queuePlayerLoad = useCallback((path: string, token: number) => {
    let result: PlayerStatus | null = null;
    const operation = mpvLoadChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (token !== mpvLoadTokenRef.current) return;
        result = await playerLoad(mpvPlayerId, path);
      });
    mpvLoadChainRef.current = operation.then(() => undefined, () => undefined);
    return operation.then(() => result);
  }, [mpvPlayerId]);

  const setCropAspect = useCallback((w: number, h: number) => {
    const next = h > 0 && w > 0 ? w / h : null;
    aspectRef.current = next;
    setNativeCropAspect(next);
  }, []);

  const setMpvMode = useCallback((active: boolean) => {
    mpvActiveRef.current = active;
    backendRef.current = active ? 'mpv' : 'webview';
    if (!active) {
      setMpvRenderer('none');
    }
    setMpvActive(active);
  }, []);

  const clearMpvFirstFrameTimer = useCallback(() => {
    if (mpvFirstFrameTimerRef.current !== null) {
      window.clearTimeout(mpvFirstFrameTimerRef.current);
      mpvFirstFrameTimerRef.current = null;
    }
  }, []);

  const getMediaDimensions = useCallback((video = videoRef.current) => {
    if (backendRef.current === 'mpv') return mediaSizeRef.current;
    return {
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
    };
  }, []);

  const getVideoBounds = useCallback((video = videoRef.current): VideoBounds | null => {
    const stage = stageRef.current;
    const dimensions = getMediaDimensions(video);
    if (!stage || dimensions.width <= 0 || dimensions.height <= 0) return null;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (stageWidth <= 0 || stageHeight <= 0) return null;
    const scale = Math.min(stageWidth / dimensions.width, stageHeight / dimensions.height);
    const w = dimensions.width * scale;
    const h = dimensions.height * scale;
    return { x: (stageWidth - w) / 2, y: (stageHeight - h) / 2, w, h };
  }, [getMediaDimensions]);

  const paintOnce = useCallback(() => {
    if (!alpha) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const bounds = getVideoBounds(video);
    if (!video || !canvas || !stage || !bounds) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(stage.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(stage.clientHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tileUnit = Math.max(1, Math.round(16 * pixelRatio));
    if (!checkerTileRef.current || checkerScaleRef.current !== tileUnit || checkerThemeRef.current !== checkerThemeKey) {
      const tile = document.createElement('canvas');
      tile.width = tileUnit * 2;
      tile.height = tileUnit * 2;
      const tileCtx = tile.getContext('2d');
      if (tileCtx) {
        tileCtx.fillStyle = themeChrome.checkerDark;
        tileCtx.fillRect(0, 0, tile.width, tile.height);
        tileCtx.fillStyle = themeChrome.checkerLight;
        tileCtx.fillRect(0, 0, tileUnit, tileUnit);
        tileCtx.fillRect(tileUnit, tileUnit, tileUnit, tileUnit);
      }
      checkerTileRef.current = tile;
      checkerScaleRef.current = tileUnit;
      checkerThemeRef.current = checkerThemeKey;
    }

    const x = Math.round(bounds.x * pixelRatio);
    const y = Math.round(bounds.y * pixelRatio);
    const drawWidth = Math.round(bounds.w * pixelRatio);
    const drawHeight = Math.round(bounds.h * pixelRatio);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const pattern = ctx.createPattern(checkerTileRef.current, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(x, y, drawWidth, drawHeight);
    }
    try {
      ctx.drawImage(video, x, y, drawWidth, drawHeight);
    } catch {
      // 浏览器在切换资源或解码尚未开始时可能拒绝当前帧；下一帧会重新绘制。
    }
  }, [alpha, checkerThemeKey, getVideoBounds, themeChrome.checkerDark, themeChrome.checkerLight]);

  const paintMpvFrame = useCallback((frame: PlayerFrame): boolean => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || frame.width <= 0 || frame.height <= 0) return false;

    if (frame.sourceWidth > 0 && frame.sourceHeight > 0) {
      setMediaDimensions(frame.sourceWidth, frame.sourceHeight);
    }

    const bounds = getVideoBounds();
    if (!bounds) return false;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(stage.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(stage.clientHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const frameCanvas = mpvFrameCanvasRef.current ?? document.createElement('canvas');
    mpvFrameCanvasRef.current = frameCanvas;
    if (frameCanvas.width !== frame.width || frameCanvas.height !== frame.height) {
      frameCanvas.width = frame.width;
      frameCanvas.height = frame.height;
    }
    const frameCtx = frameCanvas.getContext('2d');
    const ctx = canvas.getContext('2d');
    if (!frameCtx || !ctx) return false;

    const expectedLength = frame.width * frame.height * 4;
    if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) return false;
    let source: Uint8Array;
    try {
      source = decodeBase64(frame.data);
    } catch {
      return false;
    }
    if (source.length !== expectedLength) return false;

    const rgba = new Uint8ClampedArray(expectedLength);
    // screenshot-raw 已经是 RGBA；alpha 预览需要保留透明度，不能强制设为 255。
    rgba.set(source);
    const image = frameCtx.createImageData(frame.width, frame.height);
    image.data.set(rgba);
    frameCtx.putImageData(image, 0, 0);

    const x = Math.round(bounds.x * pixelRatio);
    const y = Math.round(bounds.y * pixelRatio);
    const drawWidth = Math.round(bounds.w * pixelRatio);
    const drawHeight = Math.round(bounds.h * pixelRatio);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    if (alpha) {
      const tileUnit = Math.max(1, Math.round(16 * pixelRatio));
      if (!checkerTileRef.current || checkerScaleRef.current !== tileUnit || checkerThemeRef.current !== checkerThemeKey) {
        const tile = document.createElement('canvas');
        tile.width = tileUnit * 2;
        tile.height = tileUnit * 2;
        const tileCtx = tile.getContext('2d');
        if (tileCtx) {
          tileCtx.fillStyle = themeChrome.checkerDark;
          tileCtx.fillRect(0, 0, tile.width, tile.height);
          tileCtx.fillStyle = themeChrome.checkerLight;
          tileCtx.fillRect(0, 0, tileUnit, tileUnit);
          tileCtx.fillRect(tileUnit, tileUnit, tileUnit, tileUnit);
        }
        checkerTileRef.current = tile;
        checkerScaleRef.current = tileUnit;
        checkerThemeRef.current = checkerThemeKey;
      }
      const pattern = ctx.createPattern(checkerTileRef.current, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(x, y, drawWidth, drawHeight);
      }
    }
    ctx.drawImage(frameCanvas, x, y, drawWidth, drawHeight);
    return true;
  }, [alpha, checkerThemeKey, getVideoBounds, setMediaDimensions, themeChrome.checkerDark, themeChrome.checkerLight]);

  const paintPreviewFrame = useCallback(async (bytes: Uint8Array): Promise<boolean> => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const bounds = getVideoBounds();
    if (!canvas || !stage || !bounds || bytes.byteLength === 0) return false;

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([copy.buffer], { type: 'image/jpeg' }));
    } catch {
      return false;
    }

    try {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(stage.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(stage.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      const x = Math.round(bounds.x * pixelRatio);
      const y = Math.round(bounds.y * pixelRatio);
      const drawWidth = Math.round(bounds.w * pixelRatio);
      const drawHeight = Math.round(bounds.h * pixelRatio);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, x, y, drawWidth, drawHeight);
      return true;
    } finally {
      bitmap.close();
    }
  }, [getVideoBounds]);

  useLayoutEffect(() => {
    if (!modalLayerOpen) return undefined;
    const token = ++modalFrameTokenRef.current;

    modalWasOpenRef.current = true;
    setModalPreviewHidden(true);
    setModalSnapshotStatus('loading');

    if (!mpvActiveRef.current || mpvRenderer !== 'gpu') {
      setModalSnapshotStatus('ready');
      return undefined;
    }

    void (async () => {
      let painted = false;
      try {
        const frame = await playerFrame(mpvPlayerId, 960);
        if (token !== modalFrameTokenRef.current) return;
        if (frame) painted = paintMpvFrame(frame);
      } catch {
        // Native GPU snapshots are optional; FFmpeg below is the reliable fallback.
      }
      if (!painted && filePathRef.current) {
        try {
          const bytes = await previewFrame(filePathRef.current, timeRef.current, 960);
          if (token !== modalFrameTokenRef.current) return;
          painted = await paintPreviewFrame(bytes);
        } catch {
          painted = false;
        }
      }
      if (token === modalFrameTokenRef.current) {
        setModalSnapshotStatus(painted ? 'ready' : 'failed');
      }
    })();

    return undefined;
  }, [modalLayerOpen, mpvPlayerId, mpvRenderer, paintMpvFrame, paintPreviewFrame]);

  useLayoutEffect(() => {
    if (modalLayerOpen) {
      setNativeSurfaceRevealReady(false);
      setModalPreviewHidden(true);
      return undefined;
    }
    if (!modalWasOpenRef.current) return undefined;
    if (modalSnapshotStatus === 'idle' || modalSnapshotStatus === 'loading') return undefined;
    if (modalSnapshotStatus === 'failed') {
      modalWasOpenRef.current = false;
      setModalPreviewHidden(false);
      setNativeSurfaceRevealReady(true);
      return undefined;
    }

    setModalPreviewHidden(false);
    const timer = window.setTimeout(() => {
      modalWasOpenRef.current = false;
      setNativeSurfaceRevealReady(true);
      setModalSnapshotStatus('idle');
    }, 160);
    return () => window.clearTimeout(timer);
  }, [modalLayerOpen, modalSnapshotStatus]);

  const reportTime = useCallback((nextTime: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastUiUpdateRef.current < 66) return;
    lastUiUpdateRef.current = now;
    timeRef.current = nextTime;
    setTime(nextTime);
    onFrameRef.current?.(nextTime);
  }, []);

  playingRef.current = playing;

  const capturePlaybackSnapshot = useCallback((): PlaybackSnapshot => {
    if (mpvActiveRef.current) {
      const status = mpvStatusRef.current;
      const statusTime = status && Number.isFinite(status.timePos) ? status.timePos : timeRef.current;
      return {
        time: Math.max(0, statusTime),
        playing: status
          ? !monitorMode && !status.pause && !status.eof
          : playingRef.current,
      };
    }
    const video = videoRef.current;
    return {
      time: video && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : timeRef.current,
      playing: Boolean(video && !video.paused && !video.ended),
    };
  }, [monitorMode]);

  const restoreWebViewPlayback = useCallback((video: HTMLVideoElement): boolean => {
    const snapshot = webViewRestoreRef.current;
    if (!snapshot || video.readyState < HTMLMediaElement.HAVE_METADATA) return false;
    webViewRestoreRef.current = null;
    const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : snapshot.time;
    const nextTime = clamp(snapshot.time, 0, maxTime);
    if (Math.abs(video.currentTime - nextTime) >= 0.05) {
      video.currentTime = nextTime;
      needPaintRef.current = true;
    }
    reportTime(nextTime, true);
    const shouldPlay = snapshot.playing && !monitorMode;
    if (!shouldPlay) {
      video.pause();
      playingRef.current = false;
      setPlaying(false);
      return true;
    }
    void video.play()
      .then(() => {
        playingRef.current = true;
        setPlaying(true);
      })
      .catch(() => {
        playingRef.current = false;
        setPlaying(false);
        setError('浏览器无法继续播放该媒体');
      });
    return true;
  }, [monitorMode, reportTime]);

  const applyLoop = useCallback((video: HTMLVideoElement, currentTime: number) => {
    const range = loopRef.current;
    if (!video.paused && range.e > range.s
      && (currentTime < range.s || currentTime >= range.e) && !loopSeekingRef.current) {
      loopSeekingRef.current = true;
      video.currentTime = range.s;
    }
  }, []);

  // 透明预览只在播放期间持续绘制；暂停、首次加载与拖动后仅绘制一帧。
  useEffect(() => {
    // libmpv 的 RGBA 帧也直接画在同一 Canvas 上。不能让 WebView 的
    // 透明预览绘制循环覆盖它，否则播放时会再次变成黑屏。
    if (!alpha || mpvActive) return;
    if (!playing) {
      if (needPaintRef.current) {
        paintOnce();
        needPaintRef.current = false;
      }
      return;
    }

    let alive = true;
    const loop = () => {
      if (!alive) return;
      const video = videoRef.current;
      if (video) {
        paintOnce();
        needPaintRef.current = false;
        const currentTime = video.currentTime;
        reportTime(currentTime);
        applyLoop(video, currentTime);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [alpha, mpvActive, playing, ready, paintOnce, reportTime, applyLoop]);

  // 非 alpha 预览不经过 Canvas，保持低频状态同步即可。
  useEffect(() => {
    if (alpha || mpvActive) return;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const currentTime = video.currentTime;
      reportTime(currentTime, true);
      applyLoop(video, currentTime);
    }, 100);
    return () => clearInterval(id);
  }, [alpha, mpvActive, reportTime, applyLoop]);

  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const loadSource = useCallback((src: string) => {
    const video = videoRef.current;
    if (!video) return;
    setMpvMode(false);
    mpvStatusRef.current = null;
    mpvFirstFrameSeenRef.current = false;
    clearMpvFirstFrameTimer();
    setMediaDimensions(0, 0);
    webViewRestoreRef.current = null;
    loadTokenRef.current += 1;
    blobTriedRef.current = false;
    webErrorRef.current = false;
    revokeBlobUrl();
    video.pause();
    video.removeAttribute('src');
    video.load();
    loopSeekingRef.current = false;
    lastUiUpdateRef.current = 0;
    needPaintRef.current = true;
    setCropState(null);
    setReady(false);
    playingRef.current = false;
    setPlaying(false);
    timeRef.current = 0;
    durationRef.current = 0;
    setTime(0);
    setDuration(0);
    setError(null);
    // For local desktop previews, let libmpv own the initial load. Starting
    // WebView on the same HEVC/ProRes file first can emit an unsupported-codec
    // error before the native worker produces its first frame, incorrectly
    // sending a decodable file down the Blob fallback path.
    const shouldDeferToMpv = isTauriRuntime() && Boolean(filePathRef.current.trim());
    if (src && !shouldDeferToMpv) {
      video.src = src;
      video.load();
    }
  }, [clearMpvFirstFrameTimer, setCropState, revokeBlobUrl, setMediaDimensions, setMpvMode]);

  /** asset 协议失败时，读本地文件为 Blob 再播（Linux WebKit 上更稳） */
  const fallbackToBlob = useCallback(async () => {
    const path = filePathRef.current;
    const video = videoRef.current;
    if (!path || !video || blobTriedRef.current) return false;
    if (requiresNativeGpuPreview()) {
      setMpvMode(false);
      setMpvPending(false);
      setReady(false);
      setError('Windows 原生 GPU 预览不可用，已阻止低性能 WebView/Blob 回退');
      return false;
    }
    if (!webViewRestoreRef.current) {
      webViewRestoreRef.current = capturePlaybackSnapshot();
    }
    blobTriedRef.current = true;
    const token = loadTokenRef.current;
    setError('正在切换预览方式...');
    try {
      const blobUrl = await mediaBlobUrl(path);
      if (token !== loadTokenRef.current) {
        URL.revokeObjectURL(blobUrl);
        return false;
      }
      revokeBlobUrl();
      blobUrlRef.current = blobUrl;
      setMpvMode(false);
      backendRef.current = 'webview';
      webErrorRef.current = false;
      video.pause();
      playingRef.current = false;
      setPlaying(false);
      setReady(false);
      durationRef.current = 0;
      setDuration(0);
      video.src = blobUrl;
      video.load();
      setError(null);
      return true;
    } catch (err) {
      if (token !== loadTokenRef.current) return false;
      const message = err instanceof Error ? err.message : String(err || '读取失败');
      setError(`无法预览：${message}`);
      return false;
    }
  }, [capturePlaybackSnapshot, revokeBlobUrl, setMpvMode]);

  useEffect(() => {
    loadSource(props.src ?? '');
    return () => {
      // Invalidate an in-flight Blob fallback before the component or source is replaced.
      loadTokenRef.current += 1;
      videoRef.current?.pause();
      revokeBlobUrl();
    };
  }, [props.src, props.filePath, alpha, loadSource, revokeBlobUrl]);

  // Keep the native player alive while switching feature tabs. The shared
  // initialization promise prevents overlapping remounts from recreating the HWND.
  useEffect(() => {
    if (!isTauriRuntime() || !props.filePath?.trim()) {
      setMpvPending(false);
      return undefined;
    }
    const playerLease = acquireNativePlayerLease(mpvPlayerId);
    componentMountedRef.current = true;
    setMpvPending(true);
    if (!mpvInitPromiseRef.current) {
      const initPromise = ensureNativePlayerInitialized(mpvPlayerId);
      mpvInitPromiseRef.current = initPromise;
      void initPromise.then((status) => {
        if (!componentMountedRef.current) {
          scheduleNativePlayerDestroy(mpvPlayerId);
          return;
        }
        setMpvAvailable(status.available);
        if (!status.available) {
          if (mpvInitPromiseRef.current === initPromise) mpvInitPromiseRef.current = null;
          nativePlayerInitPromises.delete(mpvPlayerId);
          setMpvPending(false);
          // Local desktop sources are intentionally not assigned to <video>
          // before mpv finishes initializing. A normal unavailable result must
          // therefore start the fallback too, not only an exception or web error.
          if (!blobTriedRef.current) void fallbackToBlob();
          void playerDestroy(mpvPlayerId);
        }
      }).catch(() => {
        if (mpvInitPromiseRef.current === initPromise) {
          mpvInitPromiseRef.current = null;
          setMpvAvailable(false);
        }
        if (componentMountedRef.current) {
          setMpvPending(false);
          // A local source is intentionally deferred to libmpv. If the native
          // GPU surface cannot initialize, start the documented WebView/Blob
          // fallback immediately instead of leaving the stage loading forever.
          if (!blobTriedRef.current) void fallbackToBlob();
        }
      });
    }
    return () => {
      componentMountedRef.current = false;
      releaseNativePlayerLease(mpvPlayerId, playerLease);
    };
  }, [alpha, fallbackToBlob, mpvPlayerId, props.filePath]);

  const switchToWebView = useCallback(async (): Promise<boolean> => {
    if (!webViewRestoreRef.current) {
      webViewRestoreRef.current = capturePlaybackSnapshot();
    }
    setMpvMode(false);
    setMpvPending(false);
    mpvFirstFrameSeenRef.current = false;
    clearMpvFirstFrameTimer();
    mpvStatusRef.current = null;
    setMediaDimensions(0, 0);
    playingRef.current = false;
    setPlaying(false);
    setReady(false);
    durationRef.current = 0;
    setDuration(0);
    const video = videoRef.current;
    const source = props.src?.trim() ?? '';
    if (webErrorRef.current && !blobTriedRef.current) {
      return fallbackToBlob();
    }
    // If asset conversion returned an empty URL, mpv can still fail before the
    // <video> element emits an error. Start the documented Blob fallback here
    // so the player does not remain in an empty WebView state.
    if (!source && filePathRef.current && !blobTriedRef.current) {
      return fallbackToBlob();
    }
    if (video && source && !blobUrlRef.current && video.currentSrc !== source) {
      video.src = source;
      video.load();
    }
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      durationRef.current = nextDuration;
      setMediaDimensions(video.videoWidth, video.videoHeight);
      setDuration(nextDuration);
      setReady(true);
      setError(null);
      restoreWebViewPlayback(video);
    }
    return true;
  }, [capturePlaybackSnapshot, clearMpvFirstFrameTimer, fallbackToBlob, props.src, restoreWebViewPlayback, setMediaDimensions, setMpvMode]);

  const applyMpvLoop = useCallback((currentTime: number) => {
    const range = loopRef.current;
    if (monitorMode || !playingRef.current || range.e <= range.s
      || (currentTime >= range.s && currentTime < range.e) || loopSeekingRef.current) return;
    loopSeekingRef.current = true;
    void playerSeek(mpvPlayerId, range.s).finally(() => {
      loopSeekingRef.current = false;
    });
  }, [monitorMode, mpvPlayerId]);

  const syncMpvStatus = useCallback((status: PlayerStatus) => {
    mpvStatusRef.current = status;
    const renderer = status.renderer || 'cpu-bridge';
    setMpvRenderer(renderer);
    // screenshot-raw applies display rotation while mpv's width/height report
    // encoded dimensions. Once a Canvas frame is available, keep its display
    // dimensions as the crop coordinate system.
    if (!mpvFirstFrameSeenRef.current && status.width > 0 && status.height > 0) {
      setMediaDimensions(status.width, status.height);
    }
    const nextDuration = Number.isFinite(status.duration) && status.duration > 0
      ? status.duration
      : durationRef.current;
    durationRef.current = nextDuration;
    setDuration(nextDuration);
    // The native renderer draws directly into a GTK GL framebuffer, so a
    // decodable video with display dimensions is already its first frame. Do
    // not wait for the obsolete screenshot/Base64 bridge in that path.
    if (renderer === 'gpu' && status.ready) {
      mpvFirstFrameSeenRef.current = true;
      clearMpvFirstFrameTimer();
    }
    setReady(mpvFirstFrameSeenRef.current);
    setMpvPending(!mpvFirstFrameSeenRef.current);
    const nextPlaying = !monitorMode && !status.pause && !status.eof;
    playingRef.current = nextPlaying;
    setPlaying(nextPlaying);
    reportTime(Number.isFinite(status.timePos) ? Math.max(0, status.timePos) : 0, true);
    applyMpvLoop(Number.isFinite(status.timePos) ? Math.max(0, status.timePos) : 0);
  }, [applyMpvLoop, clearMpvFirstFrameTimer, monitorMode, reportTime, setMediaDimensions]);

  // Load every local preview into mpv after the native worker is ready. The
  // RGBA path below also preserves alpha previews on the checkerboard Canvas.
  useEffect(() => {
    const path = props.filePath?.trim() ?? '';
    const shouldUseMpv = Boolean(path && mpvAvailable);
    const token = ++mpvLoadTokenRef.current;
    let cancelled = false;
    if (!shouldUseMpv) {
      setMpvMode(false);
      if (!path) setMpvPending(false);
      return () => {
        cancelled = true;
      };
    }

    setMpvPending(true);
    setMpvMode(false);
    setCropState(null);
    onCropChangeRef.current?.({ x: 0, y: 0, w: 0, h: 0 });
    mpvFirstFrameSeenRef.current = false;
    clearMpvFirstFrameTimer();
    mpvStatusRef.current = null;
    setMediaDimensions(0, 0);
    const load = async () => {
      try {
        if (cancelled || token !== mpvLoadTokenRef.current) return;
        mpvFirstFrameTimerRef.current = window.setTimeout(() => {
          if (cancelled || token !== mpvLoadTokenRef.current || mpvFirstFrameSeenRef.current) return;
          cancelled = true;
          if (token === mpvLoadTokenRef.current) mpvLoadTokenRef.current += 1;
          setMpvMode(false);
          setMpvPending(false);
          setReady(false);
          setError('原生 GPU 预览加载超时，请检查该视频的编码格式与硬件解码支持');
        }, MPV_FIRST_FRAME_TIMEOUT_MS);
        const status = await queuePlayerLoad(path, token);
        if (!status) return;
        if (cancelled || token !== mpvLoadTokenRef.current) return;
        setMpvMode(true);
        setMpvPending(true);
        setError(null);
        syncMpvStatus(status);
      } catch (err) {
        if (cancelled || token !== mpvLoadTokenRef.current) return;
        clearMpvFirstFrameTimer();
        setMpvMode(false);
        setMpvPending(false);
        setReady(false);
        const message = err instanceof Error ? err.message : String(err || '未知错误');
        setError(`原生 GPU 预览失败：${message}`);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearMpvFirstFrameTimer();
      if (token === mpvLoadTokenRef.current) mpvLoadTokenRef.current += 1;
    };
  }, [alpha, clearMpvFirstFrameTimer, mpvAvailable, mpvPlayerId, props.filePath, props.src, queuePlayerLoad, setCropState, setMediaDimensions, setMpvMode, syncMpvStatus]);

  // libmpv has no Tauri event bridge in this project, so keep UI state fresh
  // with a bounded poll instead of coupling the crop layer to HTMLMediaElement.
  useEffect(() => {
    if (!mpvActive) return undefined;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await playerStatus(mpvPlayerId);
        if (!alive || !mpvActiveRef.current) return;
        syncMpvStatus(status);
        timer = window.setTimeout(poll, 100);
      } catch {
        if (!alive) return;
        await switchToWebView();
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [mpvActive, mpvPlayerId, switchToWebView, syncMpvStatus]);

  // CPU bridge only: a native GPU player renders into the GTK GL surface and
  // must never be polled for Base64 screenshots.
  useEffect(() => {
    if (!mpvActive || mpvRenderer === 'gpu') return undefined;
    let frame = 0;
    let alive = true;
    let inFlight = false;
    const poll = async () => {
      if (!alive || !mpvActiveRef.current || inFlight) return;
      inFlight = true;
      try {
        const nextFrame = await playerFrame(mpvPlayerId, 960);
        if (!alive || !mpvActiveRef.current) return;
        if (nextFrame && paintMpvFrame(nextFrame)) {
          mpvFirstFrameSeenRef.current = true;
          clearMpvFirstFrameTimer();
          setMpvPending(false);
          setReady(true);
          setError(null);
        }
      } catch {
        if (alive && mpvActiveRef.current) await switchToWebView();
      } finally {
        inFlight = false;
        if (alive && mpvActiveRef.current) {
          frame = window.setTimeout(poll, playingRef.current ? 34 : 100);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      if (frame) window.clearTimeout(frame);
    };
  }, [clearMpvFirstFrameTimer, mpvActive, mpvPlayerId, mpvRenderer, paintMpvFrame, switchToWebView]);

  // Native GPU surfaces own the hot selection path; React only supplies layout
  // and receives one committed selection when a drag finishes.
  useLayoutEffect(() => {
    const generation = ++surfaceGenerationRef.current;
    if (!mpvActive || mpvRenderer !== 'gpu' || !ready || modalLayerOpen
      || !nativeSurfaceRevealReady) {
      if (mpvAvailable && (modalLayerOpen || !mpvPending || !nativeSurfaceRevealReady)) {
        void queueSurfaceUpdate({ x: 0, y: 0, width: 1, height: 1, visible: false }, generation)
          .catch((surfaceError) => console.error('[ShadowEncoder] hide native preview failed', surfaceError));
      }
      return () => {
        if (surfaceGenerationRef.current === generation) surfaceGenerationRef.current += 1;
      };
    }
    let alive = true;
    let frame = 0;
    const updateSurface = () => {
      if (!alive || generation !== surfaceGenerationRef.current || isModalLayerOpen()) return;
      const stage = stageRef.current;
      const bounds = getVideoBounds();
      if (!stage || !bounds || bounds.w <= 0 || bounds.h <= 0) {
        void queueSurfaceUpdate({
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          visible: false,
        }, generation).catch((surfaceError) => console.error('[ShadowEncoder] hide invalid native preview failed', surfaceError));
        return;
      }
      const stageRect = stage.getBoundingClientRect();
      const selected = cropRef.current;
      const nativeCrop = selected && cropEnabled && selected.w > 0 && selected.h > 0
        ? {
          x: selected.x - bounds.x,
          y: selected.y - bounds.y,
          width: selected.w,
          height: selected.h,
        }
        : undefined;
      void queueSurfaceUpdate({
        x: stageRect.left + bounds.x,
        y: stageRect.top + bounds.y,
        width: bounds.w,
        height: bounds.h,
        visible: true,
        crop: nativeCrop,
        selectionEnabled: cropEnabled,
        selectionLocked: cropLocked,
        aspectRatio: nativeCropAspect ?? undefined,
        accentColor: nativeSelectionAccent,
      }, generation).catch((surfaceError) => console.error('[ShadowEncoder] update native preview failed', surfaceError));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateSurface);
    };
    const observer = new ResizeObserver(schedule);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    schedule();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      if (surfaceGenerationRef.current === generation) surfaceGenerationRef.current += 1;
    };
  }, [crop, cropEnabled, cropLocked, getVideoBounds, mediaLayoutRevision, modalLayerOpen, mpvActive, mpvAvailable, mpvPending, mpvRenderer, nativeCropAspect, nativeSelectionAccent, nativeSurfaceRevealReady, queueSurfaceUpdate, ready]);

  const applyFollowTime = useCallback((target: number) => {
    const safeTarget = Number.isFinite(target) ? Math.max(0, target) : 0;
    pendingFollowTimeRef.current = safeTarget;
    if (mpvActiveRef.current) {
      const maxTime = durationRef.current > 0 ? durationRef.current : safeTarget;
      const nextTime = clamp(safeTarget, 0, maxTime);
      const loadToken = mpvLoadTokenRef.current;
      void playerPause(mpvPlayerId)
        .then(() => {
          if (!mpvActiveRef.current || loadToken !== mpvLoadTokenRef.current) return;
          return playerSeek(mpvPlayerId, nextTime);
        })
        .then(() => {
          if (mpvActiveRef.current && loadToken === mpvLoadTokenRef.current) {
            reportTime(nextTime, true);
          }
        })
        .catch(() => undefined);
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    video.pause();
    const maxTime = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : safeTarget;
    const nextTime = clamp(safeTarget, 0, maxTime);
    if (Math.abs(video.currentTime - nextTime) >= 0.2) {
      video.currentTime = nextTime;
      needPaintRef.current = true;
    }
    playingRef.current = false;
    reportTime(nextTime, true);
    setPlaying(false);
  }, [mpvPlayerId, reportTime]);

  useEffect(() => {
    if (!monitorMode) return;
    applyFollowTime(props.followTime ?? 0);
  }, [monitorMode, mpvActive, props.followTime, props.src, applyFollowTime]);

  const getCropRect = useCallback((): CropRectResult => {
    const video = videoRef.current;
    const bounds = getVideoBounds(video);
    const selected = cropRef.current;
    const dimensions = getMediaDimensions(video);
    if (!bounds || !selected || selected.w <= 0 || selected.h <= 0
      || dimensions.width <= 0 || dimensions.height <= 0) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
    const x = clamp(Math.round(((selected.x - bounds.x) / bounds.w) * dimensions.width), 0, dimensions.width);
    const y = clamp(Math.round(((selected.y - bounds.y) / bounds.h) * dimensions.height), 0, dimensions.height);
    const w = Math.max(0, Math.min(dimensions.width - x, Math.round((selected.w / bounds.w) * dimensions.width)));
    const h = Math.max(0, Math.min(dimensions.height - y, Math.round((selected.h / bounds.h) * dimensions.height)));
    return { x, y, w, h };
  }, [getMediaDimensions, getVideoBounds]);

  useImperativeHandle(ref, () => ({
    loadVideo: loadSource,
    getCurrentTime: () => mpvActiveRef.current ? timeRef.current : (videoRef.current?.currentTime ?? 0),
    getCropRect,
    getMediaDimensions: () => {
      const dimensions = getMediaDimensions();
      return dimensions.width > 0 && dimensions.height > 0 ? { ...dimensions } : null;
    },
    setCropAspect,
    clearCrop: () => clearOutputCropSelection(setCropState, onCropChangeRef.current),
    setLoopRange: (s: number, e: number) => {
      loopRef.current = { s: Math.max(0, s), e: Math.max(0, e) };
    },
  }), [getCropRect, loadSource, setCropAspect, setCropState]);

  const cropPoint = (event: React.PointerEvent, bounds: VideoBounds, clampOutside = false) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    if (!clampOutside && (
      rawX < bounds.x || rawX > bounds.x + bounds.w
      || rawY < bounds.y || rawY > bounds.y + bounds.h
    )) return null;
    return {
      x: clamp(rawX, bounds.x, bounds.x + bounds.w),
      y: clamp(rawY, bounds.y, bounds.y + bounds.h),
    };
  };

  const updateCropCursor = (event: React.PointerEvent, bounds: VideoBounds | null) => {
    if (!bounds || !cropEnabled || cropLocked || monitorMode) {
      setCropCursor('default');
      return;
    }
    const point = cropPoint(event, bounds, dragRef.current !== null);
    if (!point) {
      setCropCursor('default');
      return;
    }
    const dragMode = dragRef.current?.mode;
    if (dragMode === 'move') {
      setCropCursor('move');
      return;
    }
    if (dragMode?.startsWith('resize')) {
      setCropCursor(dragMode === 'resize-ne' || dragMode === 'resize-sw' ? 'nesw-resize' : 'nwse-resize');
      return;
    }
    const currentCrop = cropRef.current;
    if (currentCrop && currentCrop.w > 0 && currentCrop.h > 0) {
      const nearLeft = Math.abs(point.x - currentCrop.x) <= HANDLE_HIT;
      const nearRight = Math.abs(point.x - currentCrop.x - currentCrop.w) <= HANDLE_HIT;
      const nearTop = Math.abs(point.y - currentCrop.y) <= HANDLE_HIT;
      const nearBottom = Math.abs(point.y - currentCrop.y - currentCrop.h) <= HANDLE_HIT;
      if ((nearLeft && nearTop) || (nearRight && nearBottom)) {
        setCropCursor('nwse-resize');
        return;
      }
      if ((nearRight && nearTop) || (nearLeft && nearBottom)) {
        setCropCursor('nesw-resize');
        return;
      }
      if (point.x >= currentCrop.x && point.x <= currentCrop.x + currentCrop.w
        && point.y >= currentCrop.y && point.y <= currentCrop.y + currentCrop.h) {
        setCropCursor('move');
        return;
      }
    }
    setCropCursor('crosshair');
  };

  const beginCropAt = useCallback((point: { x: number; y: number }, bounds: VideoBounds) => {
    if (!cropEnabled || cropLocked) return;
    const currentCrop = cropRef.current;
    if (currentCrop && currentCrop.w > 0 && currentCrop.h > 0) {
      const corners: Record<string, [number, number]> = {
        nw: [currentCrop.x, currentCrop.y],
        ne: [currentCrop.x + currentCrop.w, currentCrop.y],
        sw: [currentCrop.x, currentCrop.y + currentCrop.h],
        se: [currentCrop.x + currentCrop.w, currentCrop.y + currentCrop.h],
      };
      for (const key of Object.keys(corners)) {
        const [x, y] = corners[key];
        if (Math.abs(point.x - x) <= HANDLE_HIT && Math.abs(point.y - y) <= HANDLE_HIT) {
          dragRef.current = { startX: point.x, startY: point.y, mode: `resize-${key}` as DragState['mode'] };
          return;
        }
      }
      const inside = point.x >= currentCrop.x && point.x <= currentCrop.x + currentCrop.w
        && point.y >= currentCrop.y && point.y <= currentCrop.y + currentCrop.h;
      if (inside) {
        dragRef.current = {
          startX: point.x,
          startY: point.y,
          mode: 'move',
          offX: point.x - currentCrop.x,
          offY: point.y - currentCrop.y,
        };
        return;
      }
    }
    dragRef.current = { startX: point.x, startY: point.y, mode: 'new' };
    setCropState({ x: point.x, y: point.y, w: 0, h: 0 });
  }, [cropEnabled, cropLocked, setCropState]);

  const moveCropAt = useCallback((point: { x: number; y: number }, bounds: VideoBounds) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rightBound = bounds.x + bounds.w;
    const bottomBound = bounds.y + bounds.h;

    if (drag.mode === 'new') {
      setCropState(cropFromNewDrag(drag.startX, drag.startY, point, bounds, aspectRef.current));
      return;
    }

    const currentCrop = cropRef.current;
    if (drag.mode === 'move' && currentCrop) {
      const x = clamp(point.x - (drag.offX ?? 0), bounds.x, rightBound - currentCrop.w);
      const y = clamp(point.y - (drag.offY ?? 0), bounds.y, bottomBound - currentCrop.h);
      setCropState({ ...currentCrop, x, y });
      return;
    }

    if (!currentCrop) return;
    setCropState(cropFromResize(currentCrop, point, bounds, drag.mode, aspectRef.current));
  }, [setCropState]);

  const finishCrop = useCallback(() => {
    const currentCrop = cropRef.current;
    if (dragRef.current && currentCrop) {
      if (currentCrop.w < MIN_CROP_SIZE || currentCrop.h < MIN_CROP_SIZE) {
        setCropState(null);
        onCropChangeRef.current?.({ x: 0, y: 0, w: 0, h: 0 });
      } else {
        onCropChangeRef.current?.(getCropRect());
      }
    }
    dragRef.current = null;
  }, [getCropRect, setCropState]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (mpvActiveRef.current && mpvRenderer === 'gpu') return;
    const bounds = getVideoBounds();
    const point = bounds && cropPoint(event, bounds);
    if (!bounds || !point || !cropEnabled || cropLocked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginCropAt(point, bounds);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (mpvActiveRef.current && mpvRenderer === 'gpu') return;
    const bounds = getVideoBounds();
    updateCropCursor(event, bounds);
    const point = bounds && cropPoint(event, bounds, dragRef.current !== null);
    if (bounds && point) moveCropAt(point, bounds);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (mpvActiveRef.current && mpvRenderer === 'gpu') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishCrop();
  };

  useEffect(() => {
    if (!mpvActive || mpvRenderer !== 'gpu') return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handleNativeSelection = (event: PlayerSelectionEvent) => {
      const bounds = getVideoBounds();
      if (!bounds || event.surfaceWidth <= 0 || event.surfaceHeight <= 0) return;
      if (event.width <= 0 || event.height <= 0) {
        setCropState(null);
        onCropChangeRef.current?.({ x: 0, y: 0, w: 0, h: 0 });
        return;
      }
      const selected = {
        x: bounds.x + (event.x / event.surfaceWidth) * bounds.w,
        y: bounds.y + (event.y / event.surfaceHeight) * bounds.h,
        w: (event.width / event.surfaceWidth) * bounds.w,
        h: (event.height / event.surfaceHeight) * bounds.h,
      };
      setCropState(selected);
      const dimensions = getMediaDimensions();
      if (dimensions.width > 0 && dimensions.height > 0) {
        const x = clamp(Math.round((event.x / event.surfaceWidth) * dimensions.width), 0, dimensions.width);
        const y = clamp(Math.round((event.y / event.surfaceHeight) * dimensions.height), 0, dimensions.height);
        const w = Math.max(0, Math.min(dimensions.width - x, Math.round((event.width / event.surfaceWidth) * dimensions.width)));
        const h = Math.max(0, Math.min(dimensions.height - y, Math.round((event.height / event.surfaceHeight) * dimensions.height)));
        onCropChangeRef.current?.({ x, y, w, h });
      }
    };
    void subscribePlayerSelection(mpvPlayerId, handleNativeSelection).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [getMediaDimensions, getVideoBounds, mpvActive, mpvPlayerId, mpvRenderer, setCropState]);

  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (mpvActiveRef.current) return;
    const nextDuration = event.currentTarget.duration;
    setMediaDimensions(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
    durationRef.current = Number.isFinite(nextDuration) ? nextDuration : 0;
    setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
    setError(null);
    webErrorRef.current = false;
    needPaintRef.current = true;
    restoreWebViewPlayback(event.currentTarget);
    if (monitorMode) applyFollowTime(pendingFollowTimeRef.current);
  };

  const handleLoadedData = () => {
    if (mpvActiveRef.current) return;
    setReady(true);
    setError(null);
  };

  const handleSeeked = () => {
    if (mpvActiveRef.current) return;
    loopSeekingRef.current = false;
    needPaintRef.current = true;
    if (!playingRef.current) paintOnce();
  };

  const handleError = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!event.currentTarget.currentSrc) return;
    webErrorRef.current = true;
    if (mpvActiveRef.current || (mpvPending && filePathRef.current)) return;
    setReady(false);
    playingRef.current = false;
    setPlaying(false);
    // 优先尝试 Blob 回退（asset 协议 / 范围请求失败时）
    if (!blobTriedRef.current && filePathRef.current) {
      const token = loadTokenRef.current;
      void fallbackToBlob().then((ok) => {
        if (!ok && token === loadTokenRef.current) {
          setError('无法预览该媒体（解码失败或格式不被 WebView 支持）');
        }
      });
      return;
    }
    setError('无法预览该媒体（解码失败或格式不被 WebView 支持）');
  };

  const togglePlay = () => {
    if (controlsDisabled) return;
    const loopRange = loopRef.current;
    const restartLoop = props.rangeLooping === true && loopRange.e > loopRange.s;
    if (mpvActiveRef.current) {
      const shouldPause = playingRef.current;
      const operation = shouldPause
        ? playerPause(mpvPlayerId)
        : (restartLoop ? playerSeek(mpvPlayerId, loopRange.s) : Promise.resolve())
          .then(() => playerPlay(mpvPlayerId));
      void operation
        .then(() => {
          if (!shouldPause && restartLoop) reportTime(loopRange.s, true);
          playingRef.current = !shouldPause;
          setPlaying(!shouldPause);
        })
        .catch(() => { void switchToWebView(); });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (restartLoop) {
        video.currentTime = loopRange.s;
        reportTime(loopRange.s, true);
        needPaintRef.current = true;
      }
      void video.play().catch(() => {
        playingRef.current = false;
        setPlaying(false);
        setError('浏览器无法开始播放该媒体');
      });
    } else {
      video.pause();
      playingRef.current = false;
      needPaintRef.current = true;
    }
  };

  const stepFrame = (direction: PlayerFrameDirection) => {
    if (!ready || controlsDisabled) return;
    playingRef.current = false;
    setPlaying(false);
    if (mpvActiveRef.current) {
      void playerStep(mpvPlayerId, direction)
        .then(() => playerStatus(mpvPlayerId))
        .then(syncMpvStatus)
        .catch(() => { void switchToWebView(); });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const delta = direction === 'forward' ? WEBVIEW_FRAME_STEP_SECONDS : -WEBVIEW_FRAME_STEP_SECONDS;
    const maxTime = Number.isFinite(video.duration) ? Math.max(0, video.duration) : Number.MAX_SAFE_INTEGER;
    const nextTime = clamp(video.currentTime + delta, 0, maxTime);
    video.currentTime = nextTime;
    reportTime(nextTime, true);
    needPaintRef.current = true;
  };

  const onSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (controlsDisabled) return;
    const nextTime = parseFloat(event.target.value);
    if (!Number.isFinite(nextTime)) return;
    if (mpvActiveRef.current) {
      void playerSeek(mpvPlayerId, nextTime)
        .then(() => reportTime(nextTime, true))
        .catch(() => { void switchToWebView(); });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = nextTime;
    reportTime(nextTime, true);
    needPaintRef.current = true;
  };

  const updateRangeFromPointer = (
    event: React.PointerEvent<HTMLButtonElement>,
    onChange: ((timeSec: number) => void) | undefined,
  ) => {
    const timeline = timelineRef.current;
    if (!timeline || !onChange || duration <= 0) return;
    const rect = timeline.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onChange(ratio * duration);
  };

  const beginRangeDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    onChange: ((timeSec: number) => void) | undefined,
  ) => {
    if (!ready || controlsDisabled || !onChange) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateRangeFromPointer(event, onChange);
  };

  const moveRangeDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    onChange: ((timeSec: number) => void) | undefined,
  ) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    updateRangeFromPointer(event, onChange);
  };

  const rangeStart = props.rangeStart != null && Number.isFinite(props.rangeStart)
    ? clamp(props.rangeStart, 0, Math.max(0, duration))
    : null;
  const rangeEnd = props.rangeEnd != null && Number.isFinite(props.rangeEnd)
    ? clamp(props.rangeEnd, 0, Math.max(0, duration))
    : null;
  const rangeStartPercent = duration > 0 && rangeStart != null ? (rangeStart / duration) * 100 : 0;
  const rangeEndPercent = duration > 0 && rangeEnd != null ? (rangeEnd / duration) * 100 : 0;
  const hasRange = rangeStart != null && rangeEnd != null && rangeEnd > rangeStart;

  const hasSource = Boolean(props.src || props.filePath);
  const overlayText = error
    ?? (mpvPending && hasSource ? '正在初始化原生预览...' : (hasSource ? '正在加载预览...' : (props.emptyText ?? '在左侧单击素材以预览')));

  return (
    <div className="se-player">
      <div
        ref={stageRef}
        className={`se-player-stage${mpvActive ? ' se-player-mpv' : ''}${!ready ? ' se-player-stage-idle' : ''}${modalPreviewHidden ? ' se-player-modal-hidden' : ''}`}
        style={{
          cursor: monitorMode ? 'default' : cropCursor,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (!dragRef.current) setCropCursor('default');
        }}
      >
        {(alpha || mpvActive) && (
          <canvas ref={canvasRef} className="se-player-canvas" aria-hidden="true" />
        )}
        {!alpha && (
          <video
            ref={videoRef}
            className="se-player-video"
            playsInline
            preload={monitorMode ? 'auto' : 'metadata'}
            onLoadedMetadata={handleLoadedMetadata}
            onLoadedData={handleLoadedData}
            onSeeked={handleSeeked}
            onPlay={() => {
              if (!mpvActiveRef.current) {
                playingRef.current = true;
                setPlaying(true);
                setError(null);
              }
            }}
            onPause={() => {
              if (!mpvActiveRef.current) {
                playingRef.current = false;
                setPlaying(false);
              }
            }}
            onEnded={() => {
              if (!mpvActiveRef.current) {
                playingRef.current = false;
                setPlaying(false);
              }
            }}
            onError={handleError}
          />
        )}
        {alpha && (
          <video
            ref={videoRef}
            aria-hidden="true"
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
            }}
            preload={monitorMode ? 'auto' : 'metadata'}
            onLoadedMetadata={handleLoadedMetadata}
            onLoadedData={handleLoadedData}
            onSeeked={handleSeeked}
            onPlay={() => {
              if (!mpvActiveRef.current) {
                playingRef.current = true;
                setPlaying(true);
                setError(null);
              }
            }}
            onPause={() => {
              if (!mpvActiveRef.current) {
                playingRef.current = false;
                setPlaying(false);
              }
            }}
            onEnded={() => {
              if (!mpvActiveRef.current) {
                playingRef.current = false;
                setPlaying(false);
              }
            }}
            onError={handleError}
          />
        )}
        {crop && crop.w > 0 && crop.h > 0 && cropEnabled && mpvRenderer !== 'gpu' && (
          <div className={`se-crop-box${cropLocked ? ' locked' : ''}`} style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h }}>
            <span className="se-crop-label">{Math.round(crop.w)}x{Math.round(crop.h)}</span>
            {!cropLocked && (
              <>
                <span className="se-crop-handle nw" />
                <span className="se-crop-handle ne" />
                <span className="se-crop-handle sw" />
                <span className="se-crop-handle se" />
              </>
            )}
          </div>
        )}
        {!ready && (
          <div className="se-player-overlay" aria-live="polite">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" />
              <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
            </svg>
            <span className="se-player-hint">{overlayText}</span>
          </div>
        )}
      </div>
      <div className="se-player-controls">
        <button
          type="button"
          className="se-icon-btn"
          onClick={() => stepFrame('backward')}
          disabled={!ready || controlsDisabled || time <= 0}
          title={monitorMode ? '编码进度跟随模式' : '上一帧'}
          aria-label="上一帧"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 5v14" />
            <path d="M18 5l-9 7 9 7V5z" />
          </svg>
        </button>
        <button type="button" className="se-icon-btn" onClick={togglePlay} disabled={!ready || controlsDisabled} title={monitorMode ? '编码进度跟随模式' : (playing ? '暂停' : '播放')}>
          {playing ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="4" width="5" height="16" /><rect x="14" y="4" width="5" height="16" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 4l12 8-12 8V4z" /></svg>
          )}
        </button>
        <button
          type="button"
          className="se-icon-btn"
          onClick={() => stepFrame('forward')}
          disabled={!ready || controlsDisabled || (duration > 0 && time >= duration)}
          title={monitorMode ? '编码进度跟随模式' : '下一帧'}
          aria-label="下一帧"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 5v14" />
            <path d="M6 5l9 7-9 7V5z" />
          </svg>
        </button>
        {props.onRangeLoopingChange && (
          <button
            type="button"
            className={`se-icon-btn se-loop-toggle${props.rangeLooping ? ' active' : ''}`}
            onClick={() => props.onRangeLoopingChange?.(!props.rangeLooping)}
            disabled={!ready || !hasRange || controlsDisabled}
            aria-pressed={props.rangeLooping === true}
            title={hasRange ? (props.rangeLooping ? '关闭区间循环' : '开启区间循环') : '设置入点和出点后可循环播放'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M17 2l4 4-4 4" />
              <path d="M3 11V9a3 3 0 013-3h15" />
              <path d="M7 22l-4-4 4-4" />
              <path d="M21 13v2a3 3 0 01-3 3H3" />
            </svg>
          </button>
        )}
        <span className="se-time">{time.toFixed(2)}s</span>
        <div ref={timelineRef} className={`se-timeline${hasRange ? ' has-range' : ''}`}>
          {hasRange && (
            <span
              className="se-export-range"
              style={{ left: `${rangeStartPercent}%`, width: `${rangeEndPercent - rangeStartPercent}%` }}
              aria-hidden="true"
            />
          )}
          <input
            className="se-seek"
            type="range"
            min={0}
            max={duration || 0}
            step={0.001}
            value={time}
            onChange={onSeek}
            disabled={!ready || controlsDisabled}
            style={{
              background: duration > 0
                ? `linear-gradient(90deg, var(--primary) ${(time / duration) * 100}%, var(--surface-4) ${(time / duration) * 100}%)`
                : undefined,
            }}
          />
          {rangeStart != null && duration > 0 && (
            <button
              type="button"
              className="se-range-marker in"
              style={{ left: `${rangeStartPercent}%` }}
              aria-label="调整入点"
              title="拖动调整入点"
              disabled={!ready || controlsDisabled || !props.onRangeStartChange}
              onPointerDown={(event) => beginRangeDrag(event, props.onRangeStartChange)}
              onPointerMove={(event) => moveRangeDrag(event, props.onRangeStartChange)}
            >
              <span>IN</span>
            </button>
          )}
          {rangeEnd != null && duration > 0 && (
            <button
              type="button"
              className="se-range-marker out"
              style={{ left: `${rangeEndPercent}%` }}
              aria-label="调整出点"
              title={props.onRangeEndChange ? '拖动调整出点' : '固定时长已锁定出点'}
              disabled={!ready || controlsDisabled || !props.onRangeEndChange}
              onPointerDown={(event) => beginRangeDrag(event, props.onRangeEndChange)}
              onPointerMove={(event) => moveRangeDrag(event, props.onRangeEndChange)}
            >
              <span>OUT</span>
            </button>
          )}
        </div>
        <span className="se-time">{duration.toFixed(2)}s</span>
      </div>
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';
export default VideoPlayer;
