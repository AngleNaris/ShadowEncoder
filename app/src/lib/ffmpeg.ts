// ShadowEncoder 前端调用层 —— 封装 Tauri 命令、元数据解析、进度订阅
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';

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

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProgressEvent {
  percent: number;
  fps: number;
  detail: string;
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
  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    duration: parseFloat(fmt.duration || '0') || 0,
    has_audio: !!audio,
    has_alpha,
    pix_fmt: pix,
    codec_name: video.codec_name || '',
  };
}

export async function getVideoInfo(path: string): Promise<VideoInfo> {
  const json = await invoke<any>('get_video_info', { path });
  return parseVideoInfo(json);
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
export function subscribeLog(cb: (line: string) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  return getCurrentWebview().listen<string>('ffmpeg-log', (e) => cb(e.payload));
}

/* 前端原生选择对话框（Rust 调用系统对话框，返回真实路径） */
export function pickPath(kind: 'file' | 'dir'): Promise<string | null> {
  return invoke<string | null>('pick_path', { kind });
}

/** 读取媒体文件原始字节（用于 Blob URL 预览） */
export function readMediaFile(path: string): Promise<Uint8Array> {
  return invoke<Uint8Array>('read_media_file', { path });
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

/** @deprecated 大文件会卡顿；请优先 mediaPreviewUrl */
export async function toBlobUrl(path: string): Promise<string> {
  const url = mediaPreviewUrl(path);
  if (url) return url;
  const bytes = await readMediaFile(path);
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeFor(path) });
  return URL.createObjectURL(blob);
}

// ── Alpha 工具命令 ───────────────────────────────────────────
export function composeAlpha(input: string, output: string, fps: number | null) {
  return invoke<void>('compose_alpha', { input, output, fps });
}
export function screenshotFrame(input: string, output: string, timeSec: number, width: number, height: number, crop: CropRect | null) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<void>('screenshot', { input, output, timeSec, width, height, crop: c });
}
export function exportGif(input: string, output: string, start: number, duration: number, fps: number, width: number, height: number, crop: CropRect | null) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<void>('export_gif', { input, output, start, duration, fps, width, height, crop: c });
}
export function exportWebp(input: string, output: string, start: number, duration: number, fps: number, width: number, height: number, quality: number, crop: CropRect | null) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<void>('export_webp', { input, output, start, duration, fps, width, height, quality, crop: c });
}
export function exportSegment(input: string, output: string, start: number, duration: number, fps: number, width: number, height: number, outFormat: string, crop: CropRect | null, videoCodec = '', videoProfile = '', crf = 0, videoBitrate = 0) {
  const c = crop && crop.w > 0 && crop.h > 0 ? [crop.x, crop.y, crop.w, crop.h] : null;
  return invoke<void>('export_segment', { input, output, start, duration, fps, width, height, outFormat, crop: c, videoCodec, videoProfile, crf, videoBitrate });
}

// ── 原 ShadowEncoder 命令 ─────────────────────────────────────
export function transcode(opts: {
  paths: string[];
  videoCodec: string;
  videoProfile: string;
  crf: number;
  speedPreset: string;
  tune: string;
  style: number;
  pixelFormat: string;
  container: string;
  scaleW: number;
  scaleH: number;
  fps: number;
  videoBitrate: number;
  audioCodec: string;
  audioProfile: string;
  audioBitrate: number;
  audioSampleRate: number;
  audioChannels: number;
  unsharp: number;
  denoise: number;
  loudnorm: boolean;
  audioOnly: boolean;
  keepRes: boolean;
  rateMode: string;
  targetFileSizeMb: number;
}) {
  return invoke<void>('transcode', opts as any);
}
export function mixAudio(paths: string[], loudnormI: number, loudnormTp: number, loudnormLra: number, compandThreshold: number, compandGain: number, loudnormOn: boolean, compandOn: boolean) {
  return invoke<void>('mix', { paths, loudnormI, loudnormTp, loudnormLra, compandThreshold, compandGain, loudnormOn, compandOn });
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
export function updateCheck() {
  return invoke<any>('update_check');
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
