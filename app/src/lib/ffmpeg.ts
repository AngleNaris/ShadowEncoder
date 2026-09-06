// ShadowEncoder 前端调用层 —— 封装 Tauri 命令、元数据解析、进度订阅
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { buildEncodeNameLabels } from './outputNaming';
import { applyOutputOverride, type WorkflowOutputOverride } from './workflowOutput';
import type { ScriptPlan } from './workflowScript';

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  has_audio: boolean;
  has_alpha: boolean;
  pix_fmt: string;
  codec_name: string;
}

export interface MediaDimensions {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GifCompression = 'optimized' | 'compact' | 'aggressive';

export type OutputMode = 'source' | 'rename' | 'subdir' | 'fixed' | 'fixedRename' | 'subdirRename';

export interface OutputSettings {
  mode: OutputMode;
  nameTemplate: string;
  subdirectory: string;
  directory: string;
  presetName: string;
  /** 输出分辨率标签，如 1920x1080 */
  resolution?: string;
  /** 输出帧率标签，如 25fps */
  fpsLabel?: string;
  /** 编码器标签，如 H264 */
  codecLabel?: string;
  /** 码率/质量标签，如 5Mbps / CRF23 */
  bitrateLabel?: string;
  /** Agent 任务必须新建输出；同名时自动追加序号。 */
  uniqueName?: boolean;
}

export interface DitBackupRequest {
  sourcePaths: string[];
  extensions: string[];
  minSizeBytes: number | null;
  mediaOnly: boolean;
  recursive: boolean;
  operation: 'copy' | 'move';
  destinations: string[];
  verifyMd5: boolean;
  renameTemplate: string;
  directoryNameTemplate: string;
  flattenSubdirectories: boolean;
  conflictStrategy: 'rename' | 'subdirectory';
  conflictRenameTemplate: string;
  conflictSubdirectory: string;
  /** GUI 默认复用 MD5 相同的既有文件；Agent 任务关闭复用以保证可撤回。 */
  reuseIdentical?: boolean;
}

export interface DitBackupFileResult {
  sourcePath: string;
  outputPaths: string[];
  success: boolean;
  error?: string | null;
}

export interface DitBackupSummary {
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  skippedFiles: number;
  cancelled: boolean;
  results: DitBackupFileResult[];
}

export interface MediaBrowserEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedTimeMs: number | null;
}

export interface MediaBrowserRoot {
  path: string;
  label: string;
}

export interface MediaBrowserListing {
  currentPath: string;
  parentPath: string | null;
  roots: MediaBrowserRoot[];
  entries: MediaBrowserEntry[];
}

export interface MediaTreeEntry {
  name: string;
  path: string;
  parentPath: string;
  isDirectory: boolean;
  depth: number;
  sizeBytes: number | null;
}

export interface MediaTreeListing {
  rootPath: string;
  rootIsDirectory: boolean;
  rootSizeBytes: number | null;
  entries: MediaTreeEntry[];
  errors: string[];
}

export interface StorageVolume {
  id: string;
  rootPath: string;
  label: string;
  serial: number | null;
  driveType: 'removable' | 'fixed' | 'network' | 'optical' | 'ramdisk' | 'unavailable' | 'unknown';
  totalBytes: number | null;
  availableBytes: number | null;
}

export interface ProgressEvent {
  percent: number;
  file_percent?: number;
  file_index?: number;
  file_count?: number;
  fps: number;
  detail: string;
  source_path?: string;
  time_seconds?: number;
}

export type TaskLogTone = 'normal' | 'pass' | 'warn' | 'fail' | 'muted';

export interface TaskLogEvent {
  kind: 'line' | 'file_start' | 'file_end' | 'summary';
  queueIndex?: number;
  queueTotal?: number;
  filename?: string;
  sourcePath?: string;
  stage?: string;
  tone?: TaskLogTone;
  message: string;
}

export function normalizeTaskLogEvent(value: string | TaskLogEvent): TaskLogEvent {
  return typeof value === 'string' ? { kind: 'line', message: value } : value;
}

/** 解析 ffprobe JSON 为统一结构（对应原 get_video_info） */
export function parseVideoInfo(json: any): VideoInfo {
  const streams: any[] = json?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video') ?? streams[0] ?? {};
  const audio = streams.find((s) => s.codec_type === 'audio');
  const fr = (video.r_frame_rate || '0/1').split('/');
  const fps = fr.length === 2 ? parseFloat(fr[0]) / (parseFloat(fr[1]) || 1) : 0;
  const fmt = json?.format ?? {};
  const pix = video.pix_fmt || '';
  const has_alpha = /a$/.test(pix) || /rgba|argb|ya?8|yuva/.test(pix) || (video.codec_name || '').includes('prores');
  const encodedWidth = Number(video.width) || 0;
  const encodedHeight = Number(video.height) || 0;
  const sideRotation = (video.side_data_list ?? []).find((entry: any) => Number.isFinite(Number(entry?.rotation)))?.rotation;
  const rotation = Number(sideRotation ?? video.tags?.rotate ?? 0) || 0;
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return {
    width: quarterTurn ? encodedHeight : encodedWidth,
    height: quarterTurn ? encodedWidth : encodedHeight,
    fps,
    duration: parseFloat(fmt.duration || '0') || 0,
    has_audio: !!audio,
    has_alpha,
    pix_fmt: pix,
    codec_name: video.codec_name || '',
  };
}

const videoInfoCache = new Map<string, Promise<VideoInfo>>();

function videoInfoKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

export function getVideoInfo(path: string): Promise<VideoInfo> {
  const key = videoInfoKey(path);
  const cached = videoInfoCache.get(key);
  if (cached) return cached;
  const pending = invoke<any>('get_video_info', { path })
    .then(parseVideoInfo)
    .catch((error) => {
      videoInfoCache.delete(key);
      throw error;
    });
  videoInfoCache.set(key, pending);
  return pending;
}

/** Map a display-space crop between media with different display dimensions. */
export function remapCrop(
  crop: CropRect | null,
  from: MediaDimensions | null,
  to: MediaDimensions | null,
): CropRect | null {
  if (!crop || !from || !to || crop.w <= 0 || crop.h <= 0
    || from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return null;
  const left = Math.max(0, Math.min(to.width - 1, Math.round((crop.x / from.width) * to.width)));
  const top = Math.max(0, Math.min(to.height - 1, Math.round((crop.y / from.height) * to.height)));
  const right = Math.max(left + 1, Math.min(to.width, Math.round(((crop.x + crop.w) / from.width) * to.width)));
  const bottom = Math.max(top + 1, Math.min(to.height, Math.round(((crop.y + crop.h) / from.height) * to.height)));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 是否在 Tauri 运行时（浏览器直开 Vite 时为 false） */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
}

/** 订阅 ffmpeg 进度事件；返回取消函数 */
export function subscribeProgress(cb: (p: ProgressEvent) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  return getCurrentWebview().listen<ProgressEvent>('ffmpeg-progress', (e) => cb(e.payload));
}

/** 订阅 ffmpeg 日志行事件（对应原 ActivityLog），返回取消函数 */
export function subscribeLog(cb: (line: TaskLogEvent) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  return getCurrentWebview().listen<string | TaskLogEvent>('ffmpeg-log', (e) => cb(normalizeTaskLogEvent(e.payload)));
}

export interface PlayerSelectionEvent {
  playerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

/** Subscribe to low-frequency selections committed by a native GPU surface. */
export function subscribePlayerSelection(
  playerId: string,
  cb: (event: PlayerSelectionEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  return getCurrentWebview().listen<PlayerSelectionEvent>('mpv-selection-committed', (event) => {
    if (event.payload.playerId === playerId) cb(event.payload);
  });
}

/** 请求取消当前窗口正在执行的 FFmpeg 任务。 */
export function cancelFfmpeg(): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(false);
  return invoke<boolean>('cancel_ffmpeg');
}

/* 前端原生选择对话框（Rust 调用系统对话框，返回真实路径） */
export function pickPath(kind: 'file' | 'dir'): Promise<string | null> {
  return invoke<string | null>('pick_path', { kind });
}

/** 枚举内置素材浏览器中的目录，支持在一个窗口内混选文件和目录。 */
export function listMediaDirectory(path?: string | null): Promise<MediaBrowserListing> {
  return invoke<MediaBrowserListing>('list_media_directory', { path: path || null });
}

/** 递归枚举共享素材列表中的目录，返回稳定排序的扁平树。 */
export function listMediaTree(path: string): Promise<MediaTreeListing> {
  return invoke<MediaTreeListing>('list_media_tree', { path });
}

export interface PathProbe {
  exists: boolean;
  is_directory: boolean;
}

/** 轻量探测路径是否存在及其目录类型（拖放路径归一化用，不递归扫描）。 */
export function probePath(path: string): Promise<PathProbe> {
  return invoke<PathProbe>('probe_path', { path });
}

/** 获取当前可访问卷的快照，流程启用后用快照差异检测新接入磁盘。 */
export function listStorageVolumes(): Promise<StorageVolume[]> {
  return invoke<StorageVolume[]>('list_storage_volumes');
}

/** 查询任意文件或目录所在卷的容量与身份信息。 */
export function getStorageVolume(path: string): Promise<StorageVolume> {
  return invoke<StorageVolume>('get_storage_volume', { path });
}

/** 使用操作系统为该格式绑定的默认应用打开文件。 */
export function openPath(path: string): Promise<void> {
  return invoke<void>('open_path', { path });
}

/** 打开文件所在目录，目录路径则直接打开。 */
export function openOutputDirectory(path: string): Promise<void> {
  return invoke<void>('open_output_directory', { path });
}

/** 读取媒体文件原始字节（用于 Blob URL 预览） */
export function readMediaFile(path: string): Promise<Uint8Array> {
  return invoke<number[] | Uint8Array>('read_media_file', { path })
    .then((bytes) => (bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)));
}

/** 根据扩展名推断 MIME，用于 Blob 预览 */
export function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mov': return 'video/quicktime';
    case 'mkv': return 'video/x-matroska';
    case 'webm': return 'video/webm';
    case 'avi': return 'video/x-msvideo';
    case 'm4v': return 'video/mp4';
    default: return 'video/mp4';
  }
}

/**
 * 本地媒体预览 URL。
 * 优先走 asset 协议（流式、不整文件进内存）；失败时回退读字节为 Blob。
 */
export function mediaPreviewUrl(path: string): string {
  if (!path) return '';
  if (!isTauriRuntime()) return '';
  try {
    return convertFileSrc(path);
  } catch {
    return '';
  }
}

/**
 * 将本地文件读入内存并生成 Blob URL。
 * 仅作 asset 协议失败时的回退（大文件会占内存）。
 */
export async function mediaBlobUrl(path: string): Promise<string> {
  if (!path) return '';
  const bytes = await readMediaFile(path);
  // 复制到独立 ArrayBuffer，避免 SharedArrayBuffer 类型不兼容 BlobPart
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeFor(path) });
  return URL.createObjectURL(blob);
}

/** 提取低分辨率单帧，编码监看不依赖 WebView 对源封装/编码器的支持。 */
export async function previewFrame(path: string, timeSec: number, maxWidth = 640): Promise<Uint8Array> {
  const bytes = await invoke<number[] | Uint8Array>('preview_frame', { path, timeSec, maxWidth });
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}

// ── libmpv 原生播放层（跨平台解码 HEVC/ProRes 等） ──────────────
export interface PlayerStatus {
  ready: boolean;
  available: boolean;
  path: string;
  pause: boolean;
  timePos: number;
  duration: number;
  width: number;
  height: number;
  /** Encoded dimensions before display-matrix rotation. */
  sourceWidth: number;
  sourceHeight: number;
  eof: boolean;
  /** `gpu` is libmpv rendering directly to the native Linux GL surface. */
  renderer: 'gpu' | 'cpu-bridge' | 'none' | string;
  /** Runtime libmpv decoder, e.g. `vaapi`; empty while probing/fallback. */
  hwdec: string;
}

export function playerInit(playerId: string): Promise<PlayerStatus> {
  return invoke<PlayerStatus>('player_init', { playerId });
}
export function playerDestroy(playerId: string): Promise<void> {
  return invoke('player_destroy', { playerId });
}
export function playerLoad(playerId: string, path: string): Promise<PlayerStatus> {
  return invoke<PlayerStatus>('player_load', { playerId, path });
}
export function playerPlay(playerId: string): Promise<void> {
  return invoke('player_play', { playerId });
}
export function playerPause(playerId: string): Promise<void> {
  return invoke('player_pause', { playerId });
}
export function playerToggle(playerId: string): Promise<boolean> {
  return invoke<boolean>('player_toggle', { playerId });
}
export function playerSeek(playerId: string, timeSec: number): Promise<void> {
  return invoke('player_seek', { playerId, timeSec });
}
export type PlayerFrameDirection = 'backward' | 'forward';
export function playerStep(playerId: string, direction: PlayerFrameDirection): Promise<void> {
  return invoke('player_step', { playerId, direction });
}
export function playerSetVolume(playerId: string, volume: number): Promise<void> {
  return invoke('player_set_volume', { playerId, volume });
}
export function playerStatus(playerId: string): Promise<PlayerStatus> {
  return invoke<PlayerStatus>('player_status', { playerId });
}
export interface PlayerFrame {
  width: number;
  height: number;
  /** 源视频尺寸；width/height 是为 JSON bridge 限制而缩放后的帧尺寸。 */
  sourceWidth: number;
  sourceHeight: number;
  /** libmpv software renderer 返回的 packed rgb0 base64 数据。 */
  data: string;
}
export function playerFrame(playerId: string, maxWidth = 960): Promise<PlayerFrame | null> {
  return invoke<PlayerFrame | null>('player_frame', { playerId, maxWidth });
}

export interface PlayerSurfaceCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerSurface {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  crop?: PlayerSurfaceCrop;
  selectionEnabled?: boolean;
  selectionLocked?: boolean;
  aspectRatio?: number;
  accentColor?: string;
}

/** Position the platform-native GPU surface over the matching WebView video bounds. */
export function playerSetSurface(playerId: string, surface: PlayerSurface): Promise<boolean> {
  return invoke<boolean>('player_set_surface', { playerId, surface });
}

/** @deprecated 大文件会卡顿；请优先 mediaPreviewUrl / mediaBlobUrl */
export async function toBlobUrl(path: string): Promise<string> {
  const url = mediaPreviewUrl(path);
  if (url) return url;
  return mediaBlobUrl(path);
}

// ── Alpha 工具命令 ───────────────────────────────────────────
export function composeAlpha(input: string, fps: number | null, outputOptions: OutputSettings) {
  return invoke<string>('compose_alpha', { input, fps, outputOptions });
}
export function screenshotFrame(input: string, timeSec: number, width: number, height: number, imageFormat: string, quality: number, pngCompression: number, crop: CropRect | null, outputOptions: OutputSettings) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<string>('screenshot', { input, timeSec, width, height, imageFormat, quality, pngCompression, crop: c, outputOptions });
}
export function exportGif(input: string, start: number, duration: number, fps: number, width: number, height: number, compression: GifCompression, crop: CropRect | null, outputOptions: OutputSettings) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<string>('export_gif', { input, start, duration, fps, width, height, compression, crop: c, outputOptions });
}
export function exportWebp(input: string, start: number, duration: number, fps: number, width: number, height: number, quality: number, crop: CropRect | null, outputOptions: OutputSettings) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<string>('export_webp', { input, start, duration, fps, width, height, quality, crop: c, outputOptions });
}
export function exportImageSequence(input: string, start: number, duration: number, fps: number, width: number, height: number, imageFormat: string, quality: number, pngCompression: number, crop: CropRect | null, outputOptions: OutputSettings) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<string>('export_image_sequence', { input, start, duration, fps, width, height, imageFormat, quality, pngCompression, crop: c, outputOptions });
}
export function writeWorkflowLog(directory: string, name: string, content: string): Promise<string> {
  return invoke<string>('write_workflow_log', { directory, name, content });
}
export function exportSegment(input: string, start: number, duration: number, fps: number, width: number, height: number, outFormat: string, crop: CropRect | null, outputOptions: OutputSettings, videoCodec = '', videoProfile = '', crf = 0, videoBitrate = 0, pixelFormat = '', audioCodec = '', audioBitrate = 0) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<string>('export_segment', { input, start, duration, fps, width, height, outFormat, crop: c, videoCodec, videoProfile, pixelFormat, crf, videoBitrate, audioCodec, audioBitrate, outputOptions });
}

// ── 原 ShadowEncoder 命令 ─────────────────────────────────────
export type TranscodeItemResult = {
  sourcePath: string;
  status: 'completed' | 'failed' | 'canceled';
  outputPath: string | null;
  error: string | null;
};

export type TranscodeBatchResult = {
  items: TranscodeItemResult[];
  outputPaths: string[];
  completed: number;
  failed: number;
  canceled: boolean;
};

export function transcode(opts: {
  preprocessing?: ScriptPlan;
  outputOverride?: WorkflowOutputOverride;
  paths: string[];
  videoCodec: string;
  videoProfile: string;
  crf: number;
  speedPreset: string;
  tune: string;
  style: number;
  videoLevel: string;
  pixelFormat: string;
  container: string;
  scaleMode: string;
  scaleEdge: number;
  scaleW: number;
  scaleH: number;
  fps: number;
  videoBitrate: number;
  maxrate: number;
  bufsize: number;
  audioCodec: string;
  audioProfile: string;
  audioBitrate: number;
  audioSampleRate: number;
  audioChannels: number;
  unsharp: number;
  denoise: number;
  deblock: number;
  loudnorm: boolean;
  outputKind: 'video' | 'audio';
  noAudio: boolean;
  keepRes: boolean;
  rateMode: string;
  targetFileSizeMb: number;
  twoPass: boolean;
  outputOptions: OutputSettings;
}) {
  const { outputKind, outputOverride, ...request } = opts;
  for (const field of ['crf', 'style', 'scaleEdge', 'scaleW', 'scaleH', 'fps', 'videoBitrate', 'maxrate', 'bufsize', 'audioBitrate', 'audioSampleRate', 'audioChannels', 'unsharp', 'denoise', 'deblock', 'targetFileSizeMb'] as const) {
    request[field] = Number(request[field] ?? 0);
    if (!Number.isFinite(request[field])) throw new Error(`编码参数 ${field} 必须是有效数字`);
  }
  return invoke<TranscodeBatchResult>('transcode', { ...request, outputOptions: applyOutputOverride({ ...request.outputOptions, ...buildEncodeNameLabels(opts) }, outputOverride), audioOnly: outputKind === 'audio' } as any);
}
export function mixAudio(paths: string[], loudnormI: number, loudnormTp: number, loudnormLra: number, compandThreshold: number, compandGain: number, loudnormOn: boolean, compandOn: boolean, outputOptions: OutputSettings) {
  return invoke<string[]>('mix', { paths, loudnormI, loudnormTp, loudnormLra, compandThreshold, compandGain, loudnormOn, compandOn, outputOptions });
}
export function checkVideos(
  paths: string[],
  fpsTolerance: number,
  recursive: boolean = true,
  blackDetect: boolean = true,
  expectedWidth: number = 0,
  expectedHeight: number = 0,
  expectedFps: number = 0,
  expectedCodec: string = '',
) {
  return invoke<{ pass: number; pass_with_warnings: number; fail: number }>('check', { paths, fpsTolerance, recursive, blackDetect, expectedWidth, expectedHeight, expectedFps, expectedCodec });
}
export function runDitBackup(request: DitBackupRequest) {
  return invoke<DitBackupSummary>('dit_backup', { request });
}
export function updateCheck() {
  return invoke<any>('update_check');
}
export function openUrl(url: string) {
  return invoke<void>('open_url', { url });
}

// ── 工具 ──────────────────────────────────────────────────────
export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(Math.floor(ss))}.${pad(ms, 3)}`;
}
export function parseTime(str: string): number | null {
  const m = str.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseFloat(m[3]);
  return h * 3600 + min * 60 + sec;
}
