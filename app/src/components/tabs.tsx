// ShadowEncoder 8 个功能标签页 —— 共享素材列表 + 处理选中 / 批量处理
import React, { useRef, useState, useEffect, useLayoutEffect, useCallback, ReactNode } from 'react';
import * as ui from './ui';
import { ResizeHandle } from './ResizeHandle';
import VideoPlayer, { VideoPlayerHandle, CropRectResult } from './VideoPlayer';
import {
  getVideoInfo, remapCrop, composeAlpha, screenshotFrame, exportGif, exportWebp, exportImageSequence, exportSegment,
  transcode, mixAudio, checkVideos, subscribeProgress, subscribeLog, mediaPreviewUrl, cancelFfmpeg,
  formatTime, parseTime, openOutputDirectory,
  normalizeTaskLogEvent,
  type VideoInfo, type CropRect, type MediaDimensions, type GifCompression, type TaskLogEvent,
} from '../lib/ffmpeg';
import { PresetManager, PresetManageDialog, usePresets, type Preset, type PresetBuilderCtx, CROP_ASPECT_OPTIONS, GIF_COMPRESSION_OPTIONS, IMAGE_SEQUENCE_FORMAT_OPTIONS, aspectToRatio, parseCustomRatioParts, linkAspectHeight, linkAspectWidth } from './presetSystem';
import {
  DEFAULT_OUTPUT_FORM,
  DEFAULT_ENCODE_NAME_TEMPLATE,
  OutputLocationFields,
  OutputLocationGroup,
  buildEncodeNameLabels,
  describeOutputSettings,
  normalizeOutputForm,
  toOutputSettings,
  type OutputFormState,
} from './OutputSettings';
import { DEFAULT_EXPORT_DIMENSIONS, dimensionsForCropAspect } from '../lib/outputDimensions';
import { isPresetUiFieldDisabled } from '../lib/presetUiRules';
import { isAudioVisualPath, isVideoPath, partitionMediaPaths } from '../lib/mediaExtensions';
import { useModalLayerRegistration } from '../lib/modalLayer';
import {
  registerAgentTaskHandler,
  type AgentTaskExecutionResult,
  type TaskRunOutcome,
} from '../lib/agentTaskBridge';

// 预设构建器 —— 流程图式一次性展示可配置项
// 设计参考 Shutter Encoder 的"函数 = 输出格式"（高自由度），但改用分组卡片避免其信息过载；
// 每个视频/音频编码器都带兼容性约束（封装白名单）与编码器专属"规格/Profile"（如 ProRes 的 Proxy/422HQ/4444）。
const CONTAINER_OPTIONS = [
  { label: 'MP4', value: 'mp4' },
  { label: 'MKV', value: 'mkv' },
  { label: 'MOV', value: 'mov', tags: ['QuickTime'] },
  { label: 'WebM', value: 'webm' },
  { label: 'AVI', value: 'avi' },
  { label: 'FLV', value: 'flv' },
  { label: 'MPEG-TS', value: 'ts' },
  { label: 'MPEG-PS', value: 'mpeg' },
  { label: 'WMV', value: 'wmv' },
  { label: 'OGV', value: 'ogv' },
  { label: '3GP', value: '3gp' },
  { label: 'ASF', value: 'asf' },
  { label: 'M4V', value: 'm4v' },
];

const AUDIO_OUTPUT_OPTIONS = [
  { label: 'MP3', value: 'mp3' },
  { label: 'M4A', value: 'm4a', tags: ['AAC'] },
  { label: 'WAV', value: 'wav', tags: ['PCM'] },
  { label: 'FLAC', value: 'flac', tags: ['无损'] },
  { label: 'Ogg Vorbis', value: 'ogg' },
  { label: 'Ogg Opus', value: 'opus' },
];

const VIDEO_CODEC_OPTIONS = [
  { label: '复制视频流', value: 'copy', tags: ['无重编码'], group: '通用' },
  { label: 'H.264', value: 'libx264', tags: ['CPU'], group: '软件编码' },
  { label: 'H.265/HEVC', value: 'libx265', tags: ['CPU'], group: '软件编码' },
  { label: 'AV1', value: 'libsvtav1', tags: ['SVT'], group: '软件编码' },
  { label: 'AV1', value: 'libaom-av1', tags: ['AOM'], group: '软件编码' },
  { label: 'VP8', value: 'libvpx', group: '软件编码' },
  { label: 'VP9', value: 'libvpx-vp9', group: '软件编码' },
  { label: 'MPEG-4 Part 2', value: 'mpeg4', group: '软件编码' },
  { label: 'MPEG-2', value: 'mpeg2video', group: '软件编码' },
  { label: 'Apple ProRes', value: 'prores', group: '中间格式与无损' },
  { label: 'Avid DNxHR', value: 'dnxhd', group: '中间格式与无损' },
  { label: 'FFV1', value: 'ffv1', tags: ['无损'], group: '中间格式与无损' },
  { label: 'H.264', value: 'h264_nvenc', tags: ['NVIDIA'], group: 'NVIDIA GPU' },
  { label: 'H.265/HEVC', value: 'hevc_nvenc', tags: ['NVIDIA'], group: 'NVIDIA GPU' },
  { label: 'AV1', value: 'av1_nvenc', tags: ['NVIDIA'], group: 'NVIDIA GPU' },
  { label: 'H.264', value: 'h264_amf', tags: ['AMD'], group: 'AMD GPU' },
  { label: 'H.265/HEVC', value: 'hevc_amf', tags: ['AMD'], group: 'AMD GPU' },
  { label: 'AV1', value: 'av1_amf', tags: ['AMD'], group: 'AMD GPU' },
  { label: 'H.264', value: 'h264_qsv', tags: ['Intel'], group: 'Intel GPU' },
  { label: 'H.265/HEVC', value: 'hevc_qsv', tags: ['Intel'], group: 'Intel GPU' },
  { label: 'AV1', value: 'av1_qsv', tags: ['Intel'], group: 'Intel GPU' },
];

const X264_PRESET_OPTIONS = [
  { label: 'ultrafast', value: 'ultrafast' },
  { label: 'superfast', value: 'superfast' },
  { label: 'veryfast', value: 'veryfast' },
  { label: 'faster', value: 'faster' },
  { label: 'fast', value: 'fast' },
  { label: 'medium', value: 'medium', tags: ['默认'] },
  { label: 'slow', value: 'slow' },
  { label: 'slower', value: 'slower' },
  { label: 'veryslow', value: 'veryslow' },
];

const TUNE_OPTIONS_FULL = [
  { label: '无', value: 'none' },
  { label: '实拍电影', value: 'film' },
  { label: '动画', value: 'animation' },
  { label: '保留颗粒', value: 'grain' },
  { label: '静态画面', value: 'stillimage' },
  { label: '快速解码', value: 'fastdecode' },
  { label: '低延迟', value: 'zerolatency' },
];

const PIXEL_FORMAT_OPTIONS = [
  { label: 'yuv420p', value: 'yuv420p', tags: ['最兼容'] },
  { label: 'yuv422p', value: 'yuv422p' },
  { label: 'yuv444p', value: 'yuv444p' },
  { label: 'yuv420p10le', value: 'yuv420p10le', tags: ['10-bit'] },
  { label: 'yuv422p10le', value: 'yuv422p10le', tags: ['10-bit'] },
  { label: 'yuv444p10le', value: 'yuv444p10le', tags: ['10-bit'] },
  { label: 'yuva444p10le', value: 'yuva444p10le', tags: ['10-bit', 'Alpha'] },
  { label: 'nv12', value: 'nv12', tags: ['GPU'] },
  { label: 'p010le', value: 'p010le', tags: ['GPU', '10-bit'] },
  { label: 'rgb24', value: 'rgb24' },
  { label: 'gbrp', value: 'gbrp' },
];

const AUDIO_CODEC_OPTIONS = [
  { label: '复制音频流', value: 'copy', tags: ['无重编码'] },
  { label: 'AAC', value: 'aac' },
  { label: 'MP3', value: 'libmp3lame' },
  { label: 'Opus', value: 'libopus' },
  { label: 'Vorbis', value: 'libvorbis' },
  { label: 'FLAC', value: 'flac', tags: ['无损'] },
  { label: 'PCM 16-bit', value: 'pcm_s16le', tags: ['无损'] },
  { label: 'PCM 24-bit', value: 'pcm_s24le', tags: ['无损'] },
  { label: 'ALAC', value: 'alac', tags: ['无损'] },
  { label: 'AC-3', value: 'ac3' },
  { label: 'E-AC-3', value: 'eac3' },
  { label: 'WMA', value: 'wmav2' },
];

const AUDIO_PROFILE_OPTIONS = [
  { label: 'LC', value: 'lc' },
  { label: 'HE-AAC', value: 'he-aac' },
  { label: 'HE-AAC v2', value: 'hev2-aac' },
];

const SAMPLE_RATE_OPTIONS = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000].map((r) => ({ label: `${r} Hz`, value: r }));

const CHANNEL_OPTIONS = [
  { label: '单声道', value: 1, tags: ['1 声道'] },
  { label: '立体声', value: 2, tags: ['2 声道'] },
  { label: '5.1', value: 6, tags: ['6 声道'] },
];

const RATE_MODE_OPTIONS = [
  { label: '恒定质量', value: 'crf' },
  { label: '受限可变码率', value: 'capped' },
  { label: '平均码率', value: 'bitrate' },
  { label: '目标文件体积', value: 'filesize' },
];

const VIDEO_LEVEL_OPTIONS = [
  { label: '自动', value: '' },
  ...['3.0', '3.1', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2', '6.0', '6.1', '6.2']
    .map((value) => ({ label: `Level ${value}`, value })),
];

const SCALE_MODE_OPTIONS = [
  { label: '保持原始分辨率', value: 'original' },
  { label: '指定分辨率', value: 'dimensions' },
  { label: '指定长边', value: 'longEdge' },
  { label: '指定短边', value: 'shortEdge' },
];

function supportsVideoLevel(videoCodec: string): boolean {
  return /^(libx26[45]|h264_|hevc_)/.test(videoCodec);
}

const TWO_PASS_CODECS = new Set(['libx264', 'libx265', 'libvpx', 'libvpx-vp9']);
function canUseTwoPass(videoCodec: string, rateMode: string): boolean {
  return TWO_PASS_CODECS.has(videoCodec) && (rateMode === 'bitrate' || rateMode === 'filesize');
}

const NO_RATE_CONTROL_CODECS = new Set(['copy', 'prores', 'dnxhd', 'ffv1']);
const BITRATE_ONLY_CODECS = new Set(['mpeg4', 'mpeg2video']);

function compatibleRateModes(videoCodec: string) {
  if (!videoCodec || NO_RATE_CONTROL_CODECS.has(videoCodec)) return [];
  const allowed = BITRATE_ONLY_CODECS.has(videoCodec)
    ? new Set(['bitrate', 'filesize'])
    : new Set(['crf', 'capped', 'bitrate', 'filesize']);
  return RATE_MODE_OPTIONS.filter((option) => allowed.has(option.value));
}

const PIXEL_FORMAT_SUPPORT: Record<string, string[]> = {
  copy: [],
  libx264: ['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'],
  libx265: ['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'],
  h264_nvenc: ['yuv420p', 'nv12'],
  h264_amf: ['yuv420p', 'nv12'],
  h264_qsv: ['yuv420p', 'nv12'],
  hevc_nvenc: ['yuv420p', 'nv12', 'p010le'],
  hevc_amf: ['yuv420p', 'nv12', 'p010le'],
  hevc_qsv: ['yuv420p', 'nv12', 'p010le'],
  av1_nvenc: ['yuv420p', 'nv12', 'p010le'],
  av1_amf: ['yuv420p', 'nv12', 'p010le'],
  av1_qsv: ['yuv420p', 'nv12', 'p010le'],
  libsvtav1: ['yuv420p', 'yuv420p10le'],
  'libaom-av1': ['yuv420p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'],
  libvpx: ['yuv420p'],
  'libvpx-vp9': ['yuv420p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'],
  mpeg4: ['yuv420p'],
  mpeg2video: ['yuv420p', 'yuv422p'],
  prores: ['yuv422p10le', 'yuva444p10le'],
  dnxhd: ['yuv422p', 'yuv422p10le'],
  ffv1: ['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le', 'rgb24', 'gbrp'],
};

function compatiblePixelFormats(videoCodec: string) {
  const allowed = new Set(PIXEL_FORMAT_SUPPORT[videoCodec] ?? ['yuv420p']);
  return PIXEL_FORMAT_OPTIONS.filter((option) => allowed.has(option.value));
}

// 视频编码器元信息：支持的封装白名单、编码器专属"规格/Profile"、以及是否支持 质量/速度/调优
type VideoMeta = {
  label: string;
  containers: string[];
  profiles: ui.ComboBoxOption[];
  quality: 'crf' | 'cq' | null;
  speed: boolean;
  tune: boolean;
  defaultPixFmt: string | null;
};
const VIDEO_META: Record<string, VideoMeta> = {
  copy: {
    label: '复制视频流',
    containers: CONTAINER_OPTIONS.map((o) => o.value), // 不重新编码，封装不受限（能否封装由 ffmpeg 决定）
    profiles: [], quality: null, speed: false, tune: false, defaultPixFmt: null,
  },
  libx264: {
    label: 'H.264', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi', 'flv', '3gp', 'mpeg'],
    profiles: [
      { value: 'high', label: 'High', tags: ['最通用'] },
      { value: 'main', label: 'Main' },
      { value: 'baseline', label: 'Baseline', tags: ['老旧设备'] },
      { value: 'high10', label: 'High 10', tags: ['10-bit'] },
      { value: 'high422', label: 'High 4:2:2' },
      { value: 'high444', label: 'High 4:4:4' },
    ],
    quality: 'crf', speed: true, tune: true, defaultPixFmt: 'yuv420p',
  },
  libx265: {
    label: 'H.265/HEVC', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'],
    profiles: [
      { value: 'main', label: 'Main' },
      { value: 'main10', label: 'Main 10', tags: ['10-bit', '最通用'] },
      { value: 'main422-10', label: 'Main 4:2:2 10-bit' },
      { value: 'main444-10', label: 'Main 4:4:4 10-bit' },
      { value: 'main12', label: 'Main 12', tags: ['12-bit'] },
    ],
    quality: 'crf', speed: true, tune: true, defaultPixFmt: 'yuv420p',
  },
  h264_nvenc: { label: 'H.264 (NVENC)', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  hevc_nvenc: { label: 'H.265 (NVENC)', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  h264_amf: { label: 'H.264 (AMF)', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  hevc_amf: { label: 'H.265 (AMF)', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  h264_qsv: { label: 'H.264 (QSV)', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  hevc_qsv: { label: 'H.265 (QSV)', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  libsvtav1: { label: 'AV1 (SVT)', containers: ['mp4', 'mkv', 'mov', 'webm', 'm4v'], profiles: [], quality: 'crf', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  'libaom-av1': { label: 'AV1 (aom)', containers: ['mp4', 'mkv', 'mov', 'webm', 'm4v'], profiles: [], quality: 'crf', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  av1_nvenc: { label: 'AV1 (NVENC)', containers: ['mp4', 'mkv', 'mov', 'webm', 'm4v'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  av1_amf: { label: 'AV1 (AMF)', containers: ['mp4', 'mkv', 'mov', 'webm', 'm4v'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  av1_qsv: { label: 'AV1 (QSV)', containers: ['mp4', 'mkv', 'mov', 'webm', 'm4v'], profiles: [], quality: 'cq', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  'libvpx': { label: 'VP8', containers: ['webm', 'mkv'], profiles: [], quality: 'crf', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  'libvpx-vp9': { label: 'VP9', containers: ['webm', 'mkv'], profiles: [], quality: 'crf', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  mpeg4: { label: 'MPEG-4 Part2', containers: ['mp4', 'mkv', 'avi', 'mov', '3gp', 'mpeg', 'flv', 'ts'], profiles: [], quality: 'crf', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  mpeg2video: { label: 'MPEG-2', containers: ['mpeg', 'ts', 'mkv', 'avi', 'mp4', 'mov'], profiles: [], quality: 'crf', speed: false, tune: false, defaultPixFmt: 'yuv420p' },
  prores: {
    label: 'Apple ProRes', containers: ['mov', 'mkv'],
    profiles: [
      { value: 'proxy', label: 'Proxy', tags: ['代理', '最低码率'] },
      { value: 'lt', label: 'LT', tags: ['轻量'] },
      { value: '422', label: '422', tags: ['标准'] },
      { value: '422hq', label: '422 HQ', tags: ['高质量'] },
      { value: '4444', label: '4444', tags: ['Alpha'] },
      { value: '4444xq', label: '4444 XQ', tags: ['极致质量'] },
    ],
    quality: null, speed: false, tune: false, defaultPixFmt: 'yuv422p10le',
  },
  dnxhd: {
    label: 'Avid DNxHR', containers: ['mov', 'mkv'],
    profiles: [
      { value: 'dnxhr_lb', label: 'LB', tags: ['低码率'] },
      { value: 'dnxhr_sq', label: 'SQ', tags: ['标准质量'] },
      { value: 'dnxhr_hq', label: 'HQ', tags: ['高质量'] },
      { value: 'dnxhr_hqx', label: 'HQX', tags: ['超高质量', '10/12-bit'] },
    ],
    quality: null, speed: false, tune: false, defaultPixFmt: 'yuv422p',
  },
  ffv1: { label: 'FFV1 (无损)', containers: ['mkv', 'avi', 'mov'], profiles: [], quality: null, speed: false, tune: false, defaultPixFmt: 'yuv420p10le' },
};

// 音频编码器元信息：支持的封装白名单（null = 不限制，如 copy 跟随源流）
type AudioMeta = { containers: string[] | null };
const AUDIO_META: Record<string, AudioMeta> = {
  aac: { containers: ['mp4', 'm4v', 'mov', 'mkv', 'ts', '3gp', 'flv'] },
  'libmp3lame': { containers: ['mp4', 'mkv', 'mov', 'avi', 'ts', 'flv'] },
  'libopus': { containers: ['webm', 'mkv', 'ogv'] },
  'libvorbis': { containers: ['ogv', 'mkv', 'webm'] },
  flac: { containers: ['mkv', 'mov', 'ogv'] },
  'pcm_s16le': { containers: ['mov', 'mkv', 'avi'] },
  'pcm_s24le': { containers: ['mov', 'mkv', 'avi'] },
  alac: { containers: ['mov', 'm4v', 'mp4'] },
  ac3: { containers: ['mp4', 'mkv', 'mov', 'ts', 'wmv', 'asf', 'avi'] },
  eac3: { containers: ['mp4', 'mkv', 'mov', 'ts', 'wmv', 'asf'] },
  wmav2: { containers: ['wmv', 'asf'] },
  copy: { containers: null },
};

const AUDIO_OUTPUT_CODECS: Record<string, string[]> = {
  mp3: ['libmp3lame'],
  m4a: ['aac', 'alac'],
  wav: ['pcm_s16le', 'pcm_s24le'],
  flac: ['flac'],
  ogg: ['libvorbis'],
  opus: ['libopus'],
};

function isAudioContainer(container: string): boolean {
  return AUDIO_OUTPUT_OPTIONS.some((option) => option.value === container);
}

function isAudioOutputFormat(container: string, outputKind = ''): boolean {
  return isAudioContainer(container) || outputKind === 'audio';
}

function outputKindForContainer(container: string): 'video' | 'audio' {
  return isAudioContainer(container) ? 'audio' : 'video';
}

function audioOutputContainer(container: string, audioCodec: string): string {
  if (isAudioContainer(container)) return container;
  if (audioCodec === 'libmp3lame') return 'mp3';
  if (audioCodec === 'flac') return 'flac';
  if (audioCodec === 'pcm_s16le' || audioCodec === 'pcm_s24le') return 'wav';
  if (audioCodec === 'libvorbis') return 'ogg';
  if (audioCodec === 'libopus') return 'opus';
  return 'm4a';
}

function formatOptions(videoCodec: string) {
  return [...compatibleContainers(videoCodec), ...AUDIO_OUTPUT_OPTIONS];
}
interface PresetBuilderProps { ctx: PresetBuilderCtx; }

// 根据视频编码器筛选可用封装（级联：前面选了编码器，后面只列兼容封装）
function compatibleContainers(videoCodec: string) {
  const m = VIDEO_META[videoCodec];
  if (!m || !m.containers) return CONTAINER_OPTIONS;
  return CONTAINER_OPTIONS.filter((o) => m.containers.includes(o.value));
}
// 根据封装筛选可用音频编码器（copy 不限制，始终可选）
function compatibleAudioCodecs(container: string, outputKind = outputKindForContainer(container)) {
  if (isAudioOutputFormat(container, outputKind)) {
    const allowed = new Set(AUDIO_OUTPUT_CODECS[container] ?? []);
    return AUDIO_CODEC_OPTIONS.filter((option) => allowed.has(option.value));
  }
  return AUDIO_CODEC_OPTIONS.filter((o) => {
    const a = AUDIO_META[o.value];
    return !a || !a.containers || a.containers.includes(container);
  });
}

function preferredAudioCodec(container: string, outputKind = outputKindForContainer(container), fallback = ''): string {
  const options = compatibleAudioCodecs(container, outputKind);
  return options.some((option) => option.value === fallback)
    ? fallback
    : options[0]?.value ?? '';
}

export const DEFAULT_ENCODE_FORM = {
  name: '',
  outputKind: 'video' as 'video' | 'audio',
  container: 'mp4',
  videoCodec: 'libx264',
  videoProfile: 'high',
  crf: 23,
  preset: 'medium',
  tune: 'animation',
  videoLevel: '',
  pixelFormat: 'yuv420p',
  scaleMode: 'original' as 'original' | 'dimensions' | 'longEdge' | 'shortEdge',
  scaleEdge: 0,
  scaleW: 0,
  scaleH: 0,
  fps: 25,
  keepRes: true,
  loudnorm: true,
  noAudio: false,
  audioCodec: 'aac',
  audioProfile: 'lc',
  audioBitrate: 192,
  videoBitrate: 0,
  maxrate: 0,
  bufsize: 0,
  audioSampleRate: 48000,
  audioChannels: 2,
  unsharp: 0.8,
  denoise: 1,
  deblock: 0,
  rateMode: 'crf' as 'crf' | 'capped' | 'bitrate' | 'filesize',
  targetFileSizeMb: 0,
  twoPass: false,
  previewDuringEncode: true,
  ...DEFAULT_OUTPUT_FORM,
  // 编码默认重命名：原始文件名_分辨率_帧率_编码_码率.扩展名
  outputNameTemplate: DEFAULT_ENCODE_NAME_TEMPLATE,
};

// 预设创建的初始表单：全部空白（不预选任何项）；空白项在套用预设时被忽略、保留运行时默认值
const BLANK_ENCODE_FORM = {
  name: '',
  outputKind: 'video' as 'video' | 'audio',
  container: '',
  videoCodec: '',
  videoProfile: '',
  crf: 23,
  preset: '',
  tune: '',
  videoLevel: '',
  pixelFormat: '',
  scaleMode: '' as any,
  scaleEdge: 0,
  scaleW: 0,
  scaleH: 0,
  fps: 0,
  keepRes: false,
  loudnorm: false,
  noAudio: false,
  audioCodec: '',
  audioProfile: '',
  audioBitrate: 0,
  videoBitrate: 0,
  maxrate: 0,
  bufsize: 0,
  audioSampleRate: '' as any,
  audioChannels: '' as any,
  unsharp: '' as any,
  denoise: '' as any,
  deblock: '' as any,
  rateMode: '' as any,
  targetFileSizeMb: 0,
  twoPass: false,
  previewDuringEncode: false,
  ...DEFAULT_OUTPUT_FORM,
  outputNameTemplate: DEFAULT_ENCODE_NAME_TEMPLATE,
};

export function normalizeEncodeParams(params: any): any {
  const source = params && typeof params === 'object' ? params : {};
  const { audioOnly: legacyAudioOnly, ...rest } = source;
  const legacyPost = source.deblock == null && source.style != null;
  const legacyUnsharp = [0, 0.5, 0.8, 1.2, 1.5];
  const legacyDenoise = [0, 1, 3, 6];
  const tune = (!source.tune || source.tune === 'none') && source.style === 1
    ? 'film'
    : (!source.tune || source.tune === 'none') && source.style === 2
      ? 'animation'
      : source.tune;
  const scaleMode = source.scaleMode || (source.keepRes
    ? 'original'
    : (Number(source.scaleW) > 0 && Number(source.scaleH) > 0 ? 'dimensions' : 'original'));
  const removedVideoCodec = source.videoCodec === 'gif' || source.videoCodec === 'mjpeg';
  const container = source.container === 'gif' ? 'mp4' : source.container;
  const outputKind = isAudioOutputFormat(
    container,
    source.outputKind === 'audio' || legacyAudioOnly ? 'audio' : 'video',
  ) ? 'audio' : 'video';
  const normalizedContainer = outputKind === 'audio'
    ? audioOutputContainer(container, source.audioCodec)
    : container;
  const normalized = {
    ...rest,
    outputKind,
    videoCodec: removedVideoCodec ? 'libx264' : source.videoCodec,
    container: normalizedContainer,
    audioCodec: preferredAudioCodec(normalizedContainer, outputKind, source.audioCodec),
    pixelFormat: removedVideoCodec ? 'yuv420p' : source.pixelFormat,
    tune,
    scaleMode,
    scaleEdge: Number(source.scaleEdge) || 0,
    videoLevel: source.videoLevel || '',
    maxrate: Number(source.maxrate) || 0,
    bufsize: Number(source.bufsize) || 0,
    noAudio: outputKind === 'audio' ? false : !!source.noAudio,
    unsharp: legacyPost ? (legacyUnsharp[Number(source.unsharp)] ?? 0) : source.unsharp,
    denoise: legacyPost ? (legacyDenoise[Number(source.denoise)] ?? 0) : source.denoise,
    deblock: source.deblock ?? (legacyPost && Number(source.denoise) >= 2 ? 0.2 : 0),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

// 把当前表单整理成分组（按标签页）的「标签 / 值」列表，供右侧常驻汇总面板展示
type SumGroup = { title: string; items: [string, string][] };
function summarizeEncode(f: any): SumGroup[] {
  const dash = '—';
  const isAudioOutput = isAudioOutputFormat(f.container, f.outputKind);
  const isCopy = f.videoCodec === 'copy';
  const vLabel = f.videoCodec
    ? (VIDEO_CODEC_OPTIONS.find((o) => o.value === f.videoCodec)?.label ?? f.videoCodec)
    : dash;
  const aLabel = f.audioCodec
    ? (AUDIO_CODEC_OPTIONS.find((o) => o.value === f.audioCodec)?.label ?? f.audioCodec)
    : dash;
  const unsharpLabel = Number(f.unsharp) > 0 ? `强度 ${f.unsharp}` : '关闭';
  const denoiseLabel = Number(f.denoise) > 0 ? `强度 ${f.denoise}` : '关闭';
  const deblockLabel = Number(f.deblock) > 0 ? `强度 ${f.deblock}` : '关闭';
  const meta = VIDEO_META[f.videoCodec];
  const mode = f.rateMode || 'crf';
  let quality: string;
  let vbr: string;
  if (isCopy) {
    quality = dash;
    vbr = dash;
  } else if (mode === 'filesize') {
    quality = `目标体积 ${f.targetFileSizeMb ?? 0} MB`;
    vbr = '自动（按体积计算）';
  } else if (mode === 'bitrate') {
    quality = '码率优先';
    vbr = f.videoBitrate > 0 ? `${f.videoBitrate / 1000} Mbps` : dash;
  } else if (mode === 'capped') {
    quality = meta?.quality ? `${meta.quality === 'cq' ? 'CQ' : 'CRF'} ${f.crf}` : dash;
    vbr = `上限 ${Number(f.maxrate) > 0 ? `${f.maxrate / 1000} Mbps` : dash} · 缓冲 ${Number(f.bufsize) > 0 ? `${f.bufsize / 1000} Mbps` : dash}`;
  } else {
    quality = meta?.quality
      ? `${meta.quality === 'cq' ? 'CQ' : 'CRF'} ${f.crf}`
      : dash;
    vbr = f.videoBitrate > 0 ? `${f.videoBitrate / 1000} Mbps` : (meta?.quality ? 'CRF / 默认' : dash);
  }
  const scaleMode = f.scaleMode || (f.keepRes ? 'original' : 'dimensions');
  const res = isCopy
    ? '跟随源（视频流复制）'
    : scaleMode === 'original'
      ? '原始分辨率'
      : scaleMode === 'longEdge'
        ? (f.scaleEdge > 0 ? `长边 ${f.scaleEdge}px` : dash)
        : scaleMode === 'shortEdge'
          ? (f.scaleEdge > 0 ? `短边 ${f.scaleEdge}px` : dash)
          : (f.scaleW > 0 && f.scaleH > 0 ? `${f.scaleW} × ${f.scaleH}` : dash);
  const fpsText = isCopy ? '跟随源' : (f.fps > 0 ? `${f.fps} fps` : '原始帧率');
  const chMap: Record<number, string> = { 1: '单声道', 2: '立体声', 6: '5.1' };
  let audio: string;
  if (isAudioOutput) audio = `输出 ${String(f.container || '').toUpperCase() || dash}`;
  else if (f.noAudio) audio = '不输出音轨';
  else if (!f.audioCodec) audio = dash;
  else if (f.audioCodec === 'copy') audio = '复制音频流';
  else {
    const parts = [aLabel];
    if (f.audioBitrate > 0) parts.push(`${f.audioBitrate}k`);
    if (f.audioSampleRate) parts.push(`${f.audioSampleRate}Hz`);
    if (f.audioChannels) parts.push(`${chMap[f.audioChannels] ?? f.audioChannels}声道`);
    audio = parts.join(' · ');
  }
  const videoItems: [string, string][] = isAudioOutput
    ? [['视频流', '不输出']]
    : isCopy
    ? [['视频编码器', '复制视频流 (copy)'], ['说明', '不重新编码，仅换封装 / 改音频']]
    : [
        ['视频编码器', vLabel],
        ['Profile', f.videoProfile || dash],
        ['Level', f.videoLevel || '自动'],
        ['质量', quality],
        ['编码速度', f.preset || dash],
        ['调优', f.tune ? (f.tune === 'none' ? '无' : f.tune) : dash],
        ['像素格式', f.pixelFormat || dash],
        ['视频码率', vbr],
      ];
  return [
    { title: '视频编码', items: videoItems },
    {
      title: '输出格式',
      items: [
        ['格式', f.container ? String(f.container).toUpperCase() : dash],
      ],
    },
    {
      title: '分辨率与帧率',
      items: [['分辨率', res], ['帧率', fpsText]],
    },
    {
      title: '音频',
      items: [
        ['音频', audio],
        ['音频标准化', f.loudnorm ? '开启' : '关闭'],
      ],
    },
    {
      title: '后期处理',
      items: [
        ['锐化', isCopy ? '不适用（视频流复制）' : unsharpLabel],
        ['降噪', isCopy ? '不适用（视频流复制）' : denoiseLabel],
        ['去块', isCopy ? '不适用（视频流复制）' : deblockLabel],
      ],
    },
    {
      title: '任务设置',
      items: [
        ['2-pass 编码', f.twoPass ? '开启' : '关闭'],
        ['进度预览', f.previewDuringEncode ? '开启' : '关闭'],
      ],
    },
    {
      title: '输出位置',
      items: [['存储位置', describeOutputSettings(f)]],
    },
  ];
}

function PresetBuilder({ ctx }: PresetBuilderProps) {
  // 初始全部空白：不预选任何项（空白项在套用时忽略，走运行时默认）
  const [form, setForm] = useState(() => ({ ...BLANK_ENCODE_FORM }));
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const [editingId, setEditingId] = useState<string | null>(null);

  const vMeta = VIDEO_META[form.videoCodec];
  const isAudioOutput = isAudioOutputFormat(form.container, form.outputKind);
  const isCopy = form.videoCodec === 'copy';
  const isAudioCopy = form.audioCodec === 'copy';
  const audioDisabled = !isAudioOutput && form.noAudio;
  const rateModeOptions = compatibleRateModes(form.videoCodec);
  const pixelFormatOptions = compatiblePixelFormats(form.videoCodec);
  const summary = summarizeEncode(form);

  // 后续下拉框只列出与前面选择兼容的选项（级联筛选，不再展示"不兼容"）
  const containerOptions = formatOptions(form.videoCodec);
  const audioOptions = compatibleAudioCodecs(form.container, isAudioOutput ? 'audio' : 'video');

  // 选了视频编码器 → 已选封装若不兼容则回退（未选封装保持空白，不强行预选）
  const onVideoCodecChange = (vc: string) => {
    const m = VIDEO_META[vc];
    setForm((f) => {
      const nextContainers = formatOptions(vc);
      const stillOk = f.container && nextContainers.some((o) => o.value === f.container);
      const nextRateModes = compatibleRateModes(vc);
      const nextRateMode = nextRateModes.some((option) => option.value === f.rateMode)
        ? f.rateMode
        : nextRateModes[0]?.value ?? '';
      const nextPixelFormats = compatiblePixelFormats(vc);
      const nextPixelFormat = nextPixelFormats.some((option) => option.value === m?.defaultPixFmt)
        ? m?.defaultPixFmt ?? ''
        : nextPixelFormats[0]?.value ?? '';
      return {
        ...f,
        videoCodec: vc,
        container: f.container ? (stillOk ? f.container : nextContainers[0]?.value ?? '') : '',
        videoProfile: m && m.profiles.length ? m.profiles[0].value : '',
        pixelFormat: nextPixelFormat,
        rateMode: nextRateMode,
        twoPass: canUseTwoPass(vc, nextRateMode) ? f.twoPass : false,
      };
    });
  };

  const onRateModeChange = (rateMode: string) => {
    setForm((f) => ({
      ...f,
      rateMode,
      twoPass: canUseTwoPass(f.videoCodec, rateMode) ? f.twoPass : false,
    }));
  };

  const onNoAudioChange = (noAudio: boolean) => {
    setForm((f) => ({ ...f, noAudio, loudnorm: noAudio ? false : f.loudnorm }));
  };

  const onScaleModeChange = (scaleMode: string) => {
    setForm((f) => ({
      ...f,
      scaleMode,
      keepRes: scaleMode === 'original',
    }));
    setResSel(scaleMode === 'dimensions' ? '__custom__' : '');
  };

  // 改了封装 → 已选音频编码器若不兼容则清空（保持空白语义，不替用户预选）
  const onContainerChange = (c: string) => {
    setForm((f) => {
      const outputKind = outputKindForContainer(c);
      return {
        ...f,
        container: c,
        outputKind,
        audioCodec: preferredAudioCodec(c, outputKind, f.audioCodec),
        noAudio: outputKind === 'audio' ? false : f.noAudio,
      };
    });
  };

  const qualityLabel = '质量';

  // 常用分辨率 / 帧率 / 视频码率 / 音频码率 预设：
  // 统一排序 —— 第一项为「原始 / 复制」，最后一项为「自定义」；中间为常用数值。
  const RESOLUTION_PRESETS = [
    { label: '原始分辨率', value: 'orig' },
    { label: '1920 × 1080', value: '1920x1080', tags: ['1080p'] },
    { label: '1280 × 720', value: '1280x720', tags: ['720p'] },
    { label: '3840 × 2160', value: '3840x2160', tags: ['4K'] },
    { label: '2560 × 1440', value: '2560x1440', tags: ['2K'] },
    { label: '1080 × 1920', value: '1080x1920', tags: ['竖屏', '1080p'] },
    { label: '720 × 1280', value: '720x1280', tags: ['竖屏', '720p'] },
    { label: '自定义', value: '__custom__' },
  ];
  const FPS_PRESETS = [
    { label: '原始帧率', value: 'orig' },
    { label: '24 fps', value: '24' },
    { label: '25 fps', value: '25' },
    { label: '30 fps', value: '30' },
    { label: '50 fps', value: '50' },
    { label: '60 fps', value: '60' },
    { label: '自定义', value: '__custom__' },
  ];
  const VIDEO_BITRATE_PRESETS = [
    { label: '2 Mbps', value: '2000' },
    { label: '4 Mbps', value: '4000' },
    { label: '6 Mbps', value: '6000' },
    { label: '8 Mbps', value: '8000' },
    { label: '10 Mbps', value: '10000' },
    { label: '16 Mbps', value: '16000' },
    { label: '自定义', value: '__custom__' },
  ];
  const AUDIO_BITRATE_PRESETS = [
    { label: '64 kbps', value: '64' },
    { label: '96 kbps', value: '96' },
    { label: '128 kbps', value: '128' },
    { label: '192 kbps', value: '192' },
    { label: '256 kbps', value: '256' },
    { label: '320 kbps', value: '320' },
    { label: '自定义', value: '__custom__' },
  ];

  // 组合输入框（下拉选常用 / 自定义）：显式记录下拉选择，仅「自定义」时启用右侧手动输入
  const [resSel, setResSel] = useState('');
  const [fpsSel, setFpsSel] = useState('');
  const [vbrSel, setVbrSel] = useState('');
  const [abrSel, setAbrSel] = useState('');
  const onResSel = (raw: string) => {
    setResSel(raw);
    if (raw === 'orig') {
      setForm((f) => ({ ...f, scaleMode: 'original', scaleW: 0, scaleH: 0, keepRes: true }));
    } else if (raw === '__custom__') {
      setForm((f) => ({ ...f, scaleMode: 'dimensions', keepRes: false }));
    } else {
      const [w, h] = raw.split('x').map(Number);
      setForm((f) => ({ ...f, scaleMode: 'dimensions', scaleW: w, scaleH: h, keepRes: false }));
    }
  };
  const onFpsSel = (raw: string) => {
    setFpsSel(raw);
    if (raw === 'orig') set('fps', 0);
    else if (raw !== '__custom__') set('fps', Number(raw));
  };
  const onVbrSel = (raw: string) => {
    setVbrSel(raw);
    if (raw !== '__custom__') set('videoBitrate', Number(raw));
  };
  const onAbrSel = (raw: string) => {
    setAbrSel(raw);
    if (raw !== '__custom__') set('audioBitrate', Number(raw));
  };
  const resManualDisabled = resSel !== '__custom__';
  const fpsManualDisabled = fpsSel !== '__custom__';
  const vbrManualDisabled = vbrSel !== '__custom__';
  const abrManualDisabled = abrSel !== '__custom__';

  const [tab, setTab] = useState(0);
  const TABS = ['视频编码', '输出格式', '分辨率与帧率', '音频', '后期处理', '任务设置', '输出位置'];
  const customResolutionRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (tab !== 2 || form.scaleMode !== 'dimensions' || resSel !== '__custom__') return undefined;
    const frame = requestAnimationFrame(() => {
      customResolutionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [form.scaleMode, resSel, tab]);

  // 预设增删改查（配合最左侧列表）
  const resetSels = () => { setResSel(''); setFpsSel(''); setVbrSel(''); setAbrSel(''); };
  const onNew = () => { setEditingId(null); setForm({ ...BLANK_ENCODE_FORM }); resetSels(); setTab(0); };
  const onSelectPreset = (id: string) => {
    const p = ctx.presets.find((x) => x.id === id);
    if (!p) return;
    setEditingId(id);
    setForm({
      ...BLANK_ENCODE_FORM,
      ...normalizeEncodeParams(p.params),
      twoPass: !!p.params.twoPass && canUseTwoPass(p.params.videoCodec, p.params.rateMode),
      previewDuringEncode: p.params.previewDuringEncode ?? true,
      name: p.name,
    });
    // 编辑已有预设：以「自定义」模式载入实际数值，右侧手动输入可编辑
    const restoredScaleMode = p.params.scaleMode || (p.params.keepRes ? 'original' : 'dimensions');
    setResSel(restoredScaleMode === 'original' ? 'orig' : (restoredScaleMode === 'dimensions' ? '__custom__' : ''));
    setFpsSel(p.params.fps === 0 ? 'orig' : '__custom__');
    setVbrSel('__custom__');
    setAbrSel('__custom__');
  };
  const onCopyPreset = () => {
    if (!editingId) return;
    setEditingId(null);
    setForm((f) => ({ ...f, name: f.name ? `${f.name} 副本` : '副本' }));
  };
  const onDeletePreset = () => { if (editingId) { ctx.onRemove(editingId); onNew(); } };
  const onSavePreset = () => {
    if (editingId) ctx.onUpdate(editingId, form);
    else ctx.onSaveNew(form);
  };

  // 打开弹窗时重置为「新建」状态
  const prevOpen = useRef(false);
  useEffect(() => {
    if (ctx.isOpen && !prevOpen.current) onNew();
    prevOpen.current = ctx.isOpen;
  }, [ctx.isOpen]);

  const videoFieldRows: Array<{ id: string; content: ReactNode }> = [
    {
      id: 'video-codec',
      content: (
        <>
          <ui.FieldLabel>视频编码器</ui.FieldLabel>
          <ui.ComboBox value={form.videoCodec} options={VIDEO_CODEC_OPTIONS} onChange={onVideoCodecChange} />
        </>
      ),
    },
  ];
  if (vMeta?.profiles.length) {
    videoFieldRows.push({
      id: 'video-profile',
      content: (
        <>
          <ui.FieldLabel>编码规格</ui.FieldLabel>
          <ui.ComboBox value={form.videoProfile} options={vMeta.profiles} onChange={(v) => set('videoProfile', v)} />
        </>
      ),
    });
  }
  if (supportsVideoLevel(form.videoCodec)) {
    videoFieldRows.push({
      id: 'video-level',
      content: (
        <>
          <ui.FieldLabel>编码级别</ui.FieldLabel>
          <ui.ComboBox value={form.videoLevel || ''} options={VIDEO_LEVEL_OPTIONS} onChange={(v) => set('videoLevel', v)} />
        </>
      ),
    });
  }
  if (rateModeOptions.length > 0) {
    videoFieldRows.push({
      id: 'rate-mode',
      content: (
        <>
          <ui.FieldLabel>码率控制</ui.FieldLabel>
          <ui.ComboBox value={form.rateMode || rateModeOptions[0]?.value || ''} options={rateModeOptions} onChange={onRateModeChange} />
        </>
      ),
    });
  }

  const audioFieldRows: Array<{ id: string; content: ReactNode }> = [
    {
      id: 'audio-codec',
      content: (
        <>
          <ui.FieldLabel>音频编码器</ui.FieldLabel>
          <ui.ComboBox value={form.audioCodec} options={audioOptions} onChange={(v) => set('audioCodec', v)} />
        </>
      ),
    },
  ];
  if (form.audioCodec === 'aac') {
    audioFieldRows.push({
      id: 'audio-profile',
      content: (
        <>
          <ui.FieldLabel>AAC 规格</ui.FieldLabel>
          <ui.ComboBox value={form.audioProfile} options={AUDIO_PROFILE_OPTIONS} onChange={(v) => set('audioProfile', v)} />
        </>
      ),
    });
  }
  audioFieldRows.push(
    {
      id: 'audio-bitrate',
      content: (
        <>
          <ui.FieldLabel>音频码率</ui.FieldLabel>
          <div className="se-combo-num">
            <ui.ComboBox value={abrSel} options={AUDIO_BITRATE_PRESETS} onChange={onAbrSel} disabled={isAudioCopy} />
            <ui.NumberField value={form.audioBitrate} min={0} max={640} step={8} decimals={0} suffix="kbps" disabled={isAudioCopy || abrManualDisabled} onChange={(v) => set('audioBitrate', v)} />
          </div>
        </>
      ),
    },
    {
      id: 'audio-sample-rate',
      content: (
        <>
          <ui.FieldLabel>采样率</ui.FieldLabel>
          <ui.ComboBox value={form.audioSampleRate} options={SAMPLE_RATE_OPTIONS} onChange={(v) => set('audioSampleRate', v)} disabled={isAudioCopy} />
        </>
      ),
    },
    {
      id: 'audio-channels',
      content: (
        <>
          <ui.FieldLabel>声道</ui.FieldLabel>
          <ui.ComboBox value={form.audioChannels} options={CHANNEL_OPTIONS} onChange={(v) => set('audioChannels', v)} disabled={isAudioCopy} />
        </>
      ),
    },
  );
  if (!isCopy && (form.rateMode === 'crf' || form.rateMode === 'capped' || !form.rateMode) && vMeta?.quality) {
    videoFieldRows.push({
      id: 'quality',
      content: (
        <>
          <ui.FieldLabel>{qualityLabel}</ui.FieldLabel>
          <ui.NumberField value={form.crf} min={0} max={51} step={1} onChange={(v) => set('crf', v)} />
        </>
      ),
    });
  }
  if (!isCopy && form.rateMode === 'capped') {
    videoFieldRows.push(
      {
        id: 'maxrate',
        content: (
          <>
            <ui.FieldLabel>最大码率</ui.FieldLabel>
            <ui.NumberField value={(form.maxrate || 0) / 1000} min={0} max={1000} step={0.5} decimals={1} suffix="Mbps" onChange={(v) => set('maxrate', Math.round(v * 1000))} />
          </>
        ),
      },
      {
        id: 'bufsize',
        content: (
          <>
            <ui.FieldLabel>码率缓冲</ui.FieldLabel>
            <ui.NumberField value={(form.bufsize || 0) / 1000} min={0} max={2000} step={0.5} decimals={1} suffix="Mbps" onChange={(v) => set('bufsize', Math.round(v * 1000))} />
          </>
        ),
      },
    );
  }
  if (!isCopy && form.rateMode === 'bitrate') {
    videoFieldRows.push({
      id: 'video-bitrate',
      content: (
        <>
          <ui.FieldLabel>视频码率</ui.FieldLabel>
          <div className="se-combo-num">
            <ui.ComboBox value={vbrSel} options={VIDEO_BITRATE_PRESETS} onChange={onVbrSel} />
            <ui.NumberField
              value={form.videoBitrate / 1000}
              min={0} max={100} step={0.5} decimals={1} suffix="Mbps"
              disabled={vbrManualDisabled}
              onChange={(v) => set('videoBitrate', Math.round(v * 1000))}
            />
          </div>
        </>
      ),
    });
  }
  if (!isCopy && form.rateMode === 'filesize') {
    videoFieldRows.push({
      id: 'target-file-size',
      content: (
        <>
          <ui.FieldLabel>目标文件体积</ui.FieldLabel>
          <ui.NumberField value={form.targetFileSizeMb || 0} min={0} max={99999} step={1} decimals={0} suffix="MB" onChange={(v) => set('targetFileSizeMb', v)} />
        </>
      ),
    });
  }
  if (vMeta?.speed) {
    videoFieldRows.push({
      id: 'encode-speed',
      content: (
        <>
          <ui.FieldLabel>编码速度</ui.FieldLabel>
          <ui.ComboBox value={form.preset} options={X264_PRESET_OPTIONS} onChange={(v) => set('preset', v)} />
        </>
      ),
    });
  }
  if (vMeta?.tune) {
    videoFieldRows.push({
      id: 'tune',
      content: (
        <>
          <ui.FieldLabel>调优</ui.FieldLabel>
          <ui.ComboBox value={form.tune} options={TUNE_OPTIONS_FULL} onChange={(v) => set('tune', v)} />
        </>
      ),
    });
  }
  if (pixelFormatOptions.length > 0) {
    videoFieldRows.push({
      id: 'pixel-format',
      content: (
        <>
          <ui.FieldLabel>像素格式</ui.FieldLabel>
          <ui.ComboBox value={form.pixelFormat} options={pixelFormatOptions} onChange={(v) => set('pixelFormat', v)} />
        </>
      ),
    });
  }

  if (!ctx.isMounted) return null;
  return (
    <PresetManageDialog
      title="管理转码预设"
      compact={false}
      scrollEditor
      presets={ctx.presets}
      editingId={editingId}
      onSelect={onSelectPreset}
      onNew={onNew}
      onCopy={onCopyPreset}
      onDelete={onDeletePreset}
      onImport={ctx.onImport}
      onExport={ctx.onExport}
      onReorder={ctx.onReorder}
      onClose={ctx.onClose}
      onExited={ctx.onExited}
      closing={ctx.closing}
      onSave={onSavePreset}
      saveLabel={editingId ? '保存修改' : '保存预设'}
      canSave={!!String(form.name).trim()}
    >
          <div className="se-preset-name">
            <ui.FieldLabel>预设名称</ui.FieldLabel>
            <input className="se-drop-input" value={form.name} placeholder="例如：点歌屏 1080p" onChange={(e) => set('name', e.target.value)} />
          </div>

          <div className="se-preset-tabs">
            {TABS.map((t, i) => (
              <button
                key={t}
                type="button"
                className={`se-preset-tab${tab === i ? ' active' : ''}`}
                onClick={() => setTab(i)}
              >{t}</button>
            ))}
          </div>

          <div className="se-preset-cols">
            <div className="se-preset-col">
            {tab === 0 && (
              <div className="se-preset-tab-content">
                <ui.AnimatedCollapse open={!isAudioOutput} className="se-preset-content-collapse">
                  <ui.AnimatedFieldGrid rows={videoFieldRows} />
                  <ui.AnimatedCollapse open={isCopy} className="se-preset-content-collapse">
                    <ui.HintLabel>视频流将直接复制、不重新编码；仅可更改封装格式与音频参数。</ui.HintLabel>
                  </ui.AnimatedCollapse>
                </ui.AnimatedCollapse>
                <ui.AnimatedCollapse open={isAudioOutput} className="se-preset-content-collapse">
                  <ui.HintLabel>音频输出不使用视频编码设置。</ui.HintLabel>
                </ui.AnimatedCollapse>
              </div>
            )}

            {tab === 1 && (
              <ui.FieldGrid>
                <ui.FieldLabel>输出格式</ui.FieldLabel>
                <ui.ComboBox value={form.container} options={containerOptions} onChange={onContainerChange} />
              </ui.FieldGrid>
            )}

            {tab === 2 && (
              <div className="se-preset-tab-content">
                <ui.AnimatedCollapse open={isCopy || isAudioOutput} className="se-preset-content-collapse">
                  <ui.HintLabel>视频流复制模式下无法缩放或更改帧率，输出跟随源视频。</ui.HintLabel>
                </ui.AnimatedCollapse>
                <ui.AnimatedCollapse open={!isCopy && !isAudioOutput} className="se-preset-content-collapse">
                  <ui.FieldGrid>
                    <ui.FieldLabel>缩放方式</ui.FieldLabel>
                    <ui.ComboBox value={form.scaleMode || ''} options={SCALE_MODE_OPTIONS} onChange={onScaleModeChange} />
                    {form.scaleMode === 'dimensions' && <>
                      <ui.FieldLabel>分辨率</ui.FieldLabel>
                      <div className="se-resolution-config">
                        <ui.ComboBox value={resSel} options={RESOLUTION_PRESETS.filter((option) => option.value !== 'orig')} onChange={onResSel} />
                        {resSel === '__custom__' && (
                          <div ref={customResolutionRef} className="se-res-row">
                            <ui.IntField value={form.scaleW} min={0} max={8192} suffix="px" disabled={resManualDisabled} onChange={(v) => set('scaleW', v)} />
                            <span className="se-x">×</span>
                            <ui.IntField value={form.scaleH} min={0} max={8192} suffix="px" disabled={resManualDisabled} onChange={(v) => set('scaleH', v)} />
                          </div>
                        )}
                      </div>
                    </>}
                    {(form.scaleMode === 'longEdge' || form.scaleMode === 'shortEdge') && <>
                      <ui.FieldLabel>{form.scaleMode === 'longEdge' ? '长边尺寸' : '短边尺寸'}</ui.FieldLabel>
                      <ui.IntField value={form.scaleEdge || 0} min={2} max={16384} suffix="px" onChange={(v) => set('scaleEdge', v)} />
                    </>}
                    <ui.FieldLabel>帧率</ui.FieldLabel>
                    <div className="se-combo-num">
                      <ui.ComboBox value={fpsSel} options={FPS_PRESETS} onChange={onFpsSel} />
                      <ui.NumberField value={form.fps} min={0} max={120} step={1} decimals={0} suffix="fps" disabled={fpsManualDisabled} onChange={(v) => set('fps', v)} />
                    </div>
                  </ui.FieldGrid>
                </ui.AnimatedCollapse>
              </div>
            )}

            {tab === 3 && (
              <div className="se-preset-tab-content">
                <ui.AnimatedCollapse open={!audioDisabled} className="se-preset-content-collapse">
                  <ui.AnimatedFieldGrid rows={audioFieldRows} />
                </ui.AnimatedCollapse>
                <div className="se-option-stack">
                  <ui.Checkbox checked={form.loudnorm} disabled={audioDisabled || isAudioCopy} onChange={(v) => set('loudnorm', v)}>启用音频标准化</ui.Checkbox>
                  {!isAudioOutput && <ui.Checkbox checked={!!form.noAudio} onChange={onNoAudioChange}>不输出音轨</ui.Checkbox>}
                </div>
              </div>
            )}

            {tab === 4 && (
              <div className="se-preset-tab-content">
                <ui.AnimatedCollapse open={!isCopy && !isAudioOutput} className="se-preset-content-collapse">
                  <ui.FieldGrid>
                    <ui.FieldLabel>锐化</ui.FieldLabel>
                    <ui.NumberField value={Number(form.unsharp) || 0} min={0} max={1.5} step={0.1} decimals={1} onChange={(v) => set('unsharp', v)} />
                    <ui.FieldLabel>降噪</ui.FieldLabel>
                    <ui.NumberField value={Number(form.denoise) || 0} min={0} max={10} step={0.5} decimals={1} onChange={(v) => set('denoise', v)} />
                    <ui.FieldLabel>去块</ui.FieldLabel>
                    <ui.NumberField value={Number(form.deblock) || 0} min={0} max={1} step={0.05} decimals={2} onChange={(v) => set('deblock', v)} />
                  </ui.FieldGrid>
                </ui.AnimatedCollapse>
                <ui.AnimatedCollapse open={isCopy || isAudioOutput} className="se-preset-content-collapse">
                  <ui.HintLabel>视频流复制模式下滤镜（锐化 / 降噪 / 去块）不可用。</ui.HintLabel>
                </ui.AnimatedCollapse>
              </div>
            )}

            {tab === 5 && (
              <div className="se-preset-tab-content">
                {!isAudioOutput && <ui.Checkbox
                  checked={!!form.twoPass}
                  disabled={!canUseTwoPass(form.videoCodec, form.rateMode)}
                  onChange={(v) => set('twoPass', v)}
                >
                  启用 2-pass 编码（固定码率 / 目标体积）
                </ui.Checkbox>}
                <ui.Checkbox checked={form.previewDuringEncode} onChange={(v) => set('previewDuringEncode', v)}>
                  编码时跟随当前素材
                </ui.Checkbox>
              </div>
            )}
            {tab === 6 && (
              <OutputLocationFields
                value={form}
                presetName={form.name}
                extension={form.container || (isAudioOutput ? 'm4a' : 'mp4')}
                encodeLabels={buildEncodeNameLabels({
                  scaleW: form.scaleW,
                  scaleH: form.scaleH,
                  keepRes: form.keepRes,
                  fps: form.fps,
                  videoCodec: form.videoCodec,
                  rateMode: form.rateMode,
                  videoBitrate: form.videoBitrate,
                  crf: form.crf,
                  targetFileSizeMb: form.targetFileSizeMb,
                })}
                onChange={(key, value) => set(key, value)}
              />
            )}
            </div>
            <aside className="se-preset-summary">
              <div className="se-preset-summary-head">已选参数</div>
              {summary.map((g) => (
                <div className="se-sum-group" key={g.title}>
                  <div className="se-sum-group-title">{g.title}</div>
                  <ui.AnimatedList
                    items={g.items}
                    getKey={([label]) => label}
                    className="se-sum-list"
                    itemClassName="se-sum-item-motion"
                    renderItem={([label, val]) => (
                      <div className="se-sum-item">
                        <span className="se-sum-label">{label}</span>
                        <ui.AnimatedValue value={val} className={`se-sum-val${val && val !== '—' ? '' : ' is-empty'}`} />
                      </div>
                    )}
                  />
                </div>
              ))}
            </aside>
          </div>
    </PresetManageDialog>
  );
}

// 转码内联参数面板：直接在第二列展示可调整控件，让零散任务无需先建预设即可调参
// 复用模块级编码选项常量与级联筛选逻辑，与「管理预设」弹窗保持一致
function EncodeInlineForm({ form, set }: { form: any; set: (k: string, v: any) => void }) {
  const vMeta = VIDEO_META[form.videoCodec];
  const isAudioOutput = isAudioOutputFormat(form.container, form.outputKind);
  const isCopy = form.videoCodec === 'copy';
  const isAudioCopy = form.audioCodec === 'copy';
  const audioDisabled = !isAudioOutput && form.noAudio;
  const containerOptions = formatOptions(form.videoCodec);
  const audioOptions = compatibleAudioCodecs(form.container, isAudioOutput ? 'audio' : 'video');
  const rateModeOptions = compatibleRateModes(form.videoCodec);
  const pixelFormatOptions = compatiblePixelFormats(form.videoCodec);
  const qualityLabel = '质量';

  const onVideoCodecChange = (vc: string) => {
    const m = VIDEO_META[vc];
    const nextContainers = formatOptions(vc);
    const stillOk = form.container && nextContainers.some((o) => o.value === form.container);
    const nextRateModes = compatibleRateModes(vc);
    const nextRateMode = nextRateModes.some((option) => option.value === form.rateMode)
      ? form.rateMode
      : nextRateModes[0]?.value ?? '';
    const nextPixelFormats = compatiblePixelFormats(vc);
    const nextPixelFormat = nextPixelFormats.some((option) => option.value === m?.defaultPixFmt)
      ? m?.defaultPixFmt ?? ''
      : nextPixelFormats[0]?.value ?? '';
    set('videoCodec', vc);
    set('container', form.container ? (stillOk ? form.container : nextContainers[0]?.value ?? '') : '');
    set('videoProfile', m && m.profiles.length ? m.profiles[0].value : '');
    set('pixelFormat', nextPixelFormat);
    set('rateMode', nextRateMode);
    if (!canUseTwoPass(vc, nextRateMode)) set('twoPass', false);
  };
  const onRateModeChange = (rateMode: string) => {
    set('rateMode', rateMode);
    if (!canUseTwoPass(form.videoCodec, rateMode)) set('twoPass', false);
  };
  const onContainerChange = (c: string) => {
    const outputKind = outputKindForContainer(c);
    set('container', c);
    set('outputKind', outputKind);
    set('audioCodec', preferredAudioCodec(c, outputKind, form.audioCodec));
    if (outputKind === 'audio') set('noAudio', false);
  };
  const onNoAudioChange = (noAudio: boolean) => {
    set('noAudio', noAudio);
    if (noAudio) {
      set('loudnorm', false);
    }
  };
  const onScaleModeChange = (scaleMode: string) => {
    set('scaleMode', scaleMode);
    set('keepRes', scaleMode === 'original');
  };

  const videoFieldRows: Array<{ id: string; content: ReactNode }> = [
    {
      id: 'video-codec',
      content: (
        <>
          <ui.FieldLabel>视频编码器</ui.FieldLabel>
          <ui.ComboBox value={form.videoCodec} options={VIDEO_CODEC_OPTIONS} onChange={onVideoCodecChange} />
        </>
      ),
    },
  ];
  if (vMeta?.profiles.length) {
    videoFieldRows.push({
      id: 'video-profile',
      content: (
        <>
          <ui.FieldLabel>编码规格</ui.FieldLabel>
          <ui.ComboBox value={form.videoProfile} options={vMeta.profiles} onChange={(v) => set('videoProfile', v)} />
        </>
      ),
    });
  }
  if (supportsVideoLevel(form.videoCodec)) {
    videoFieldRows.push({
      id: 'video-level',
      content: (
        <>
          <ui.FieldLabel>编码级别</ui.FieldLabel>
          <ui.ComboBox value={form.videoLevel || ''} options={VIDEO_LEVEL_OPTIONS} onChange={(v) => set('videoLevel', v)} />
        </>
      ),
    });
  }
  if (rateModeOptions.length > 0) {
    videoFieldRows.push({
      id: 'rate-mode',
      content: (
        <>
          <ui.FieldLabel>码率控制</ui.FieldLabel>
          <ui.ComboBox value={form.rateMode || rateModeOptions[0]?.value || ''} options={rateModeOptions} onChange={onRateModeChange} />
        </>
      ),
    });
  }
  if (!isCopy && (form.rateMode === 'crf' || form.rateMode === 'capped' || !form.rateMode) && vMeta?.quality) {
    videoFieldRows.push({
      id: 'quality',
      content: (
        <>
          <ui.FieldLabel>{qualityLabel}</ui.FieldLabel>
          <ui.NumberField value={form.crf} min={0} max={51} step={1} onChange={(v) => set('crf', v)} />
        </>
      ),
    });
  }
  if (!isCopy && form.rateMode === 'capped') {
    videoFieldRows.push(
      {
        id: 'maxrate',
        content: (
          <>
            <ui.FieldLabel>最大码率</ui.FieldLabel>
            <ui.NumberField value={(form.maxrate || 0) / 1000} min={0} max={1000} step={0.5} decimals={1} suffix="Mbps" onChange={(v) => set('maxrate', Math.round(v * 1000))} />
          </>
        ),
      },
      {
        id: 'bufsize',
        content: (
          <>
            <ui.FieldLabel>码率缓冲</ui.FieldLabel>
            <ui.NumberField value={(form.bufsize || 0) / 1000} min={0} max={2000} step={0.5} decimals={1} suffix="Mbps" onChange={(v) => set('bufsize', Math.round(v * 1000))} />
          </>
        ),
      },
    );
  }
  if (!isCopy && form.rateMode === 'bitrate') {
    videoFieldRows.push({
      id: 'video-bitrate',
      content: (
        <>
          <ui.FieldLabel>视频码率</ui.FieldLabel>
          <ui.NumberField value={form.videoBitrate / 1000} min={0} max={100} step={0.5} decimals={1} suffix="Mbps" onChange={(v) => set('videoBitrate', Math.round(v * 1000))} />
        </>
      ),
    });
  }
  if (!isCopy && form.rateMode === 'filesize') {
    videoFieldRows.push({
      id: 'target-file-size',
      content: (
        <>
          <ui.FieldLabel>目标文件体积</ui.FieldLabel>
          <ui.NumberField value={form.targetFileSizeMb || 0} min={0} max={99999} step={1} decimals={0} suffix="MB" onChange={(v) => set('targetFileSizeMb', v)} />
        </>
      ),
    });
  }
  if (vMeta?.speed) {
    videoFieldRows.push({
      id: 'encode-speed',
      content: (
        <>
          <ui.FieldLabel>编码速度</ui.FieldLabel>
          <ui.ComboBox value={form.preset} options={X264_PRESET_OPTIONS} onChange={(v) => set('preset', v)} />
        </>
      ),
    });
  }
  if (vMeta?.tune) {
    videoFieldRows.push({
      id: 'tune',
      content: (
        <>
          <ui.FieldLabel>调优</ui.FieldLabel>
          <ui.ComboBox value={form.tune} options={TUNE_OPTIONS_FULL} onChange={(v) => set('tune', v)} />
        </>
      ),
    });
  }
  if (pixelFormatOptions.length > 0) {
    videoFieldRows.push({
      id: 'pixel-format',
      content: (
        <>
          <ui.FieldLabel>像素格式</ui.FieldLabel>
          <ui.ComboBox value={form.pixelFormat} options={pixelFormatOptions} onChange={(v) => set('pixelFormat', v)} />
        </>
      ),
    });
  }

  const audioFieldRows: Array<{ id: string; content: ReactNode }> = [
    {
      id: 'audio-codec',
      content: (
        <>
          <ui.FieldLabel>音频编码器</ui.FieldLabel>
          <ui.ComboBox value={form.audioCodec} options={audioOptions} onChange={(v) => set('audioCodec', v)} />
        </>
      ),
    },
  ];
  if (form.audioCodec === 'aac') {
    audioFieldRows.push({
      id: 'audio-profile',
      content: (
        <>
          <ui.FieldLabel>AAC 规格</ui.FieldLabel>
          <ui.ComboBox value={form.audioProfile} options={AUDIO_PROFILE_OPTIONS} onChange={(v) => set('audioProfile', v)} />
        </>
      ),
    });
  }
  audioFieldRows.push(
    {
      id: 'audio-bitrate',
      content: (
        <>
          <ui.FieldLabel>音频码率</ui.FieldLabel>
          <ui.NumberField value={form.audioBitrate} min={0} max={640} step={8} decimals={0} suffix="kbps" disabled={isAudioCopy} onChange={(v) => set('audioBitrate', v)} />
        </>
      ),
    },
    {
      id: 'audio-sample-rate',
      content: (
        <>
          <ui.FieldLabel>采样率</ui.FieldLabel>
          <ui.ComboBox value={form.audioSampleRate} options={SAMPLE_RATE_OPTIONS} onChange={(v) => set('audioSampleRate', v)} disabled={isAudioCopy} />
        </>
      ),
    },
    {
      id: 'audio-channels',
      content: (
        <>
          <ui.FieldLabel>声道</ui.FieldLabel>
          <ui.ComboBox value={form.audioChannels} options={CHANNEL_OPTIONS} onChange={(v) => set('audioChannels', v)} disabled={isAudioCopy} />
        </>
      ),
    },
  );

  return (
    <>
      {!isAudioOutput && <ui.ParamGroup title="视频编码">
        <ui.AnimatedFieldGrid rows={videoFieldRows} />
        <ui.AnimatedCollapse open={isCopy} className="se-panel-collapse">
          <ui.HintLabel>视频流将直接复制、不重新编码；仅可更改封装格式与音频参数。</ui.HintLabel>
        </ui.AnimatedCollapse>
      </ui.ParamGroup>}

      <ui.ParamGroup title="输出格式">
        <ui.FieldGrid>
          <ui.FieldLabel>格式</ui.FieldLabel>
          <ui.ComboBox value={form.container} options={containerOptions} onChange={onContainerChange} />
        </ui.FieldGrid>
      </ui.ParamGroup>

      {!isAudioOutput && <ui.ParamGroup title="分辨率与帧率">
        <ui.AnimatedCollapse open={!isCopy} className="se-panel-collapse">
          <ui.FieldGrid>
            <ui.FieldLabel>缩放方式</ui.FieldLabel>
            <ui.ComboBox value={form.scaleMode || 'original'} options={SCALE_MODE_OPTIONS} onChange={onScaleModeChange} />
            {form.scaleMode === 'dimensions' && <>
              <ui.FieldLabel>分辨率 (长×宽)</ui.FieldLabel>
              <div className="se-res-row">
                <ui.IntField value={form.scaleW} min={0} max={8192} suffix="px" onChange={(v) => set('scaleW', v)} />
                <span className="se-x">×</span>
                <ui.IntField value={form.scaleH} min={0} max={8192} suffix="px" onChange={(v) => set('scaleH', v)} />
              </div>
            </>}
            {(form.scaleMode === 'longEdge' || form.scaleMode === 'shortEdge') && <>
              <ui.FieldLabel>{form.scaleMode === 'longEdge' ? '长边尺寸' : '短边尺寸'}</ui.FieldLabel>
              <ui.IntField value={form.scaleEdge || 0} min={2} max={16384} suffix="px" onChange={(v) => set('scaleEdge', v)} />
            </>}
            <ui.FieldLabel>帧率</ui.FieldLabel>
            <ui.NumberField value={form.fps} min={0} max={120} step={1} decimals={0} suffix="fps" onChange={(v) => set('fps', v)} />
          </ui.FieldGrid>
        </ui.AnimatedCollapse>
        <ui.AnimatedCollapse open={isCopy} className="se-panel-collapse">
          <ui.HintLabel>视频流复制模式下无法缩放或更改帧率，输出跟随源视频。</ui.HintLabel>
        </ui.AnimatedCollapse>
      </ui.ParamGroup>}

      <ui.ParamGroup title="音频">
        <ui.AnimatedCollapse open={!audioDisabled} className="se-panel-collapse">
          <ui.AnimatedFieldGrid rows={audioFieldRows} />
        </ui.AnimatedCollapse>
        <div className="se-option-stack">
          <ui.Checkbox checked={form.loudnorm} disabled={audioDisabled || isAudioCopy} onChange={(v) => set('loudnorm', v)}>启用音频标准化</ui.Checkbox>
          {!isAudioOutput && <ui.Checkbox checked={!!form.noAudio} onChange={onNoAudioChange}>不输出音轨</ui.Checkbox>}
        </div>
      </ui.ParamGroup>

      {!isAudioOutput && <ui.ParamGroup title="后期处理">
        <ui.AnimatedCollapse open={!isCopy} className="se-panel-collapse">
          <ui.FieldGrid>
            <ui.FieldLabel>锐化</ui.FieldLabel>
            <ui.NumberField value={Number(form.unsharp) || 0} min={0} max={1.5} step={0.1} decimals={1} onChange={(v) => set('unsharp', v)} />
            <ui.FieldLabel>降噪</ui.FieldLabel>
            <ui.NumberField value={Number(form.denoise) || 0} min={0} max={10} step={0.5} decimals={1} onChange={(v) => set('denoise', v)} />
            <ui.FieldLabel>去块</ui.FieldLabel>
            <ui.NumberField value={Number(form.deblock) || 0} min={0} max={1} step={0.05} decimals={2} onChange={(v) => set('deblock', v)} />
          </ui.FieldGrid>
        </ui.AnimatedCollapse>
        <ui.AnimatedCollapse open={isCopy} className="se-panel-collapse">
          <ui.HintLabel>视频流复制模式下滤镜（锐化 / 降噪 / 去块）不可用。</ui.HintLabel>
        </ui.AnimatedCollapse>
      </ui.ParamGroup>}

      <ui.ParamGroup title="任务设置">
        {!isAudioOutput && <ui.Checkbox
          checked={!!form.twoPass}
          disabled={!canUseTwoPass(form.videoCodec, form.rateMode)}
          onChange={(v) => set('twoPass', v)}
        >
          启用 2-pass 编码（固定码率 / 目标体积）
        </ui.Checkbox>}
        <ui.Checkbox checked={form.previewDuringEncode} onChange={(v) => set('previewDuringEncode', v)}>
          编码时跟随当前素材
        </ui.Checkbox>
      </ui.ParamGroup>
    </>
  );
}

import { useFileList } from '../lib/fileListContext';
import { useColumnLayout } from '../lib/columnLayoutContext';
import { IconClose, IconCheckShield, IconCopy, IconCropClear, IconFolder, IconLock, IconPlayAll, IconPlaySelected, IconStop, IconTerminal, IconUnlock, IconVideo } from './icons';

/* 共享：活动任务进度路由（单任务模型） */
let activeTaskId = 0;

function TaskFailureDialog({ message, logs, onClose }: { message: string; logs: TaskLogEvent[]; onClose: () => void }) {
  useModalLayerRegistration();
  const [copied, setCopied] = useState(false);
  const report = [
    ...logs.map((event) => event.kind === 'file_start'
      ? `[${event.queueIndex ?? 1}/${event.queueTotal ?? 1}] ${event.filename || event.sourcePath || ''}`
      : event.message),
    message,
  ].filter(Boolean).join('\n');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = report;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="se-dialog-backdrop" onClick={onClose}>
      <div
        className="se-dialog se-task-error-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="se-task-error-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="se-dialog-head">
          <span className="se-dialog-title" id="se-task-error-title">任务失败</span>
          <button type="button" className="se-dialog-close" onClick={onClose} title="关闭">
            <IconClose size={14} />
          </button>
        </div>
        <div className="se-dialog-body">
          <pre className="se-task-error-log" tabIndex={0}>{report}</pre>
        </div>
        <div className="se-dialog-foot">
          <ui.Button icon={<IconCopy size={14} />} onClick={copyReport}>{copied ? '已复制' : '复制日志'}</ui.Button>
          <ui.Button primary icon={<IconClose size={14} />} onClick={onClose}>关闭</ui.Button>
        </div>
      </div>
    </div>
  );
}

function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function useTaskRunnerState() {
  const [logs, setLogs] = useState<TaskLogEvent[]>([]);
  const [progress, setProgress] = useState(0);
  const [detail, setDetail] = useState('尚未开始任务');
  const [eta, setEta] = useState('—');
  const [pass, setPass] = useState(0);
  const [fail, setFail] = useState(0);
  const [running, setRunning] = useState(false);
  const [progressSource, setProgressSource] = useState('');
  const [progressTime, setProgressTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outputPaths, setOutputPaths] = useState<string[]>([]);
  const runningRef = useRef(false);
  const taskId = useRef(0);
  const startedAt = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let un1: (() => void) | null = null;
    let un2: (() => void) | null = null;
    Promise.all([
      subscribeProgress((p) => {
        if (!runningRef.current) return;
        setProgress(p.percent);
        setDetail(p.detail);
        if (p.source_path) {
          setProgressSource(p.source_path);
          setProgressTime(p.time_seconds ?? 0);
        }
        if (p.percent > 1 && p.percent < 100 && startedAt.current > 0) {
          const elapsed = Date.now() - startedAt.current;
          const total = elapsed / (p.percent / 100);
          setEta(formatEta(total - elapsed));
        }
      }),
      subscribeLog((line) => {
        if (!runningRef.current) return;
        setLogs((prev) => [...prev.slice(-400), line]);
      }),
    ]).then(([a, b]) => {
      if (disposed) {
        a();
        b();
        return;
      }
      un1 = a;
      un2 = b;
    });
    return () => {
      disposed = true;
      un1?.();
      un2?.();
    };
  }, []);

  const start = useCallback(async <T,>(fn: () => Promise<T>): Promise<TaskRunOutcome<T>> => {
    if (runningRef.current) {
      return { status: 'failed', error: '当前已有任务正在执行' };
    }
    const id = ++activeTaskId;
    taskId.current = id;
    runningRef.current = true;
    cancelledRef.current = false;
    startedAt.current = Date.now();
    setRunning(true);
    setLogs([]);
    setProgress(0);
    setProgressSource('');
    setProgressTime(0);
    setDetail('正在准备...');
    setEta('—');
    setPass(0);
    setFail(0);
    setError(null);
    setOutputPaths([]);
    try {
      const value = await fn();
      if (taskId.current === id) {
        if (cancelledRef.current) {
          setDetail('任务已取消');
          setEta('—');
          return { status: 'canceled' };
        } else {
          setProgress(100);
          setDetail('任务结束');
          setEta('0s');
          return { status: 'completed', value };
        }
      }
      return { status: 'canceled' };
    } catch (e: any) {
      if (taskId.current === id) {
        if (cancelledRef.current) {
          setDetail('任务已取消');
          setEta('—');
          return { status: 'canceled' };
        } else {
          const message = String(e?.message || e);
          setDetail('任务失败');
          setEta('—');
          setError(message);
          setLogs((prev) => [...prev.slice(-400), normalizeTaskLogEvent(`[FAIL] ${message.split('\n')[0]}`)]);
          return { status: 'failed', error: message };
        }
      }
      return { status: 'failed', error: String(e?.message || e) };
    } finally {
      if (taskId.current === id) {
        setEta((current) => cancelledRef.current ? '—' : current);
        runningRef.current = false;
        setRunning(false);
      }
    }
  }, []);

  const appendLog = useCallback((line: string | TaskLogEvent) => {
    setLogs((prev) => [...prev.slice(-400), normalizeTaskLogEvent(line)]);
  }, []);

  const cancel = useCallback(async () => {
    if (!runningRef.current || cancelledRef.current) return;
    cancelledRef.current = true;
    setDetail('正在取消...');
    try {
      const cancelled = await cancelFfmpeg();
      if (!cancelled) setDetail('正在等待当前步骤结束...');
    } catch (e: any) {
      cancelledRef.current = false;
      const message = `取消失败: ${String(e?.message || e)}`;
      setDetail(message);
      setError(message);
      setLogs((prev) => [...prev.slice(-400), normalizeTaskLogEvent(`[FAIL] ${message}`)]);
    }
  }, []);

  const isCancelled = useCallback(() => cancelledRef.current, []);
  const openOutputs = useCallback(async () => {
    if (outputPaths.length === 0) return;
    await openOutputDirectory(outputPaths[0]);
  }, [outputPaths]);

  return {
    logs, progress, detail, eta, pass, fail, running, progressSource, progressTime, error, outputPaths,
    start, cancel, isCancelled, appendLog, setPass, setFail, setDetail, setProgress, setEta,
    setOutputPaths, openOutputs,
    clearError: () => setError(null),
  };
}

type TaskRunner = ReturnType<typeof useTaskRunnerState>;

const TaskRunnerContext = React.createContext<TaskRunner | null>(null);

export function TaskRunnerProvider({ children }: { children: ReactNode }) {
  const runner = useTaskRunnerState();
  return (
    <TaskRunnerContext.Provider value={runner}>
      {children}
    </TaskRunnerContext.Provider>
  );
}

export function useTaskRunner() {
  const runner = React.useContext(TaskRunnerContext);
  if (!runner) throw new Error('useTaskRunner 必须在 TaskRunnerProvider 内使用');
  return runner;
}

/** 工具工作区：参数列（滚动区 + 固定操作底栏）+ 可拖拽分隔 + 结果列（固定进度头 + 滚动内容） */
export function ToolWorkspace({ params, actions, result, resultHeader, resultTitle, taskFailure }: {
  params: ReactNode;
  /** 参数列底部固定的操作区（处理按钮），不随滚动消失 */
  actions?: ReactNode;
  result: ReactNode;
  /** 结果列顶部状态区（进度条等），与标题一起置于滚动内容顶部 */
  resultHeader?: ReactNode;
  /** 结果列标题，与左列顶部标题同高同位、无分隔线 */
  resultTitle?: ReactNode;
  taskFailure?: { message: string; logs: TaskLogEvent[]; onClose: () => void };
}) {
  const { wParams, setWParams } = useColumnLayout();
  const task = useTaskRunner();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizeParams = useCallback((dx: number) => {
    const maxWidth = Math.max(0, (workspaceRef.current?.clientWidth ?? 0) - 1);
    setWParams((width) => Math.max(0, Math.min(maxWidth, width + dx)));
  }, [setWParams]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (task.running) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }, [task.running]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const hasScrollbar = element.scrollHeight > element.clientHeight + 1;
      const scrollbarWidth = Math.max(0, Math.min(12, element.offsetWidth - element.clientWidth));
      element.classList.toggle('has-y-scrollbar', hasScrollbar && scrollbarWidth > 0);
      element.style.setProperty('--se-scrollbar-width', `${scrollbarWidth}px`);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(element);
    const mutationObserver = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.target !== element)) schedule();
    });
    mutationObserver.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    measure();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={workspaceRef} className="se-tab-workspace">
      <div className="se-left" style={{ flex: `0 0 ${wParams}px`, width: wParams, minWidth: wParams }}>
        <div ref={scrollRef} className="se-params-scroll">{params}</div>
        {actions && <div className="se-params-foot">{actions}</div>}
      </div>
      <ResizeHandle onDelta={resizeParams} />
      <div className="se-right">
        <div className="se-result-scroll">
          {(resultTitle || resultHeader) && (
            <div className="se-result-head">
              {resultTitle ? <div className="se-result-title se-panel-head">{resultTitle}</div> : null}
              {resultHeader}
            </div>
          )}
          {result}
        </div>
      </div>
      {taskFailure && <TaskFailureDialog {...taskFailure} />}
    </div>
  );
}

export type ResultView = 'preview' | 'logs';

export function useResultView(running: boolean, previewDuringTask = false): [ResultView, React.Dispatch<React.SetStateAction<ResultView>>] {
  const [view, setView] = useState<ResultView>('preview');
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) setView(previewDuringTask ? 'preview' : 'logs');
    wasRunning.current = running;
  }, [previewDuringTask, running]);
  return [view, setView];
}

export function ResultViewTitle({ value, logs, running }: {
  value: ResultView;
  logs: number;
  running: boolean;
}) {
  const title = value === 'preview'
    ? '播放器'
    : running
      ? '日志 · 运行中'
      : logs > 0
        ? `日志 · ${logs}`
        : '日志';

  return <span className="se-panel-title">{title}</span>;
}

function ResultViewSwitch({ value, onChange }: {
  value: ResultView;
  onChange: (view: ResultView) => void;
}) {
  return (
    <div className="se-result-view-actions" role="tablist" aria-label="结果视图">
      <button type="button" role="tab" title="播放器" aria-label="播放器" aria-selected={value === 'preview'} className={`se-result-view-tab${value === 'preview' ? ' active' : ''}`} onClick={() => onChange('preview')}>
        <IconVideo size={16} />
      </button>
      <button type="button" role="tab" title="日志" aria-label="日志" aria-selected={value === 'logs'} className={`se-result-view-tab${value === 'logs' ? ' active' : ''}`} onClick={() => onChange('logs')}>
        <IconTerminal size={16} />
      </button>
    </div>
  );
}

export function ResultViewProgress({ value, onChange, progress, detail, eta, pass, fail, running }: {
  value: ResultView;
  onChange: (view: ResultView) => void;
  progress: number;
  detail?: string;
  eta?: string;
  pass?: number;
  fail?: number;
  running: boolean;
}) {
  return (
    <div className="se-result-view-progress-row">
      <ResultViewSwitch value={value} onChange={onChange} />
      <ui.ProgressBar value={progress} detail={detail} eta={eta} pass={pass} fail={fail} running={running} />
    </div>
  );
}

export function ResultViewContent({ value, preview, logs }: {
  value: ResultView;
  preview: ReactNode;
  logs: TaskLogEvent[];
}) {
  return (
    <>
      <div className={`se-result-view-panel${value === 'preview' ? '' : ' is-hidden'}`}>{preview}</div>
      {value === 'logs' && <ui.LogView lines={logs} />}
    </>
  );
}

async function cropForTarget(
  path: string,
  crop: CropRect | null,
  sourceDimensions: MediaDimensions | null,
): Promise<CropRect | null> {
  if (!crop || !sourceDimensions) return null;
  const target = await getVideoInfo(path);
  return remapCrop(crop, sourceDimensions, target);
}

/** 处理选中 / 批量处理 —— 两行整齐布局 + 图标 */
function ProcessButtons({
  running,
  selectedCount,
  totalCount,
  onSelected,
  onAll,
  onStop,
  onOpenOutput,
  disabled = false,
  disabledTitle,
}: {
  running: boolean;
  selectedCount: number;
  totalCount: number;
  onSelected: () => void;
  onAll: () => void;
  onStop?: () => void | Promise<void>;
  onOpenOutput?: () => void | Promise<void>;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <div className="se-process-btns">
      <ui.Button
        primary
        className="se-process-main"
        disabled={running || disabled || selectedCount === 0}
        title={disabled ? disabledTitle : undefined}
        onClick={onSelected}
        icon={<IconPlaySelected size={15} />}
      >
        处理选中
      </ui.Button>
      <ui.Button
        primary
        className="se-process-main"
        disabled={running || disabled || totalCount === 0}
        title={disabled ? disabledTitle : undefined}
        onClick={onAll}
        icon={<IconPlayAll size={15} />}
      >
        批量全部
      </ui.Button>
      {onStop && running && (
        <ui.Button
          className="se-process-stop"
          disabled={!running}
          onClick={onStop}
          icon={<IconStop size={15} />}
        >
          停止
        </ui.Button>
      )}
      {onStop && !running && onOpenOutput && (
        <ui.Button
          className="se-process-stop"
          onClick={onOpenOutput}
          icon={<IconFolder size={15} />}
        >
          打开输出目录
        </ui.Button>
      )}
      {onStop && !running && !onOpenOutput && (
        <ui.Button className="se-process-stop" disabled icon={<IconStop size={15} />}>
          停止
        </ui.Button>
      )}
    </div>
  );
}

/** 预览路径：同步 media URL + 可选 probe（防抖、可取消） */
export function useActiveMedia(activePath: string | null, probe = true) {
  const initialPath = activePath && isVideoPath(activePath) && !activePath.endsWith('/') && !activePath.endsWith('\\')
    ? activePath
    : '';
  const [src, setSrc] = useState(() => initialPath ? mediaPreviewUrl(initialPath) : '');
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [path, setPath] = useState(initialPath);
  const [warn, setWarn] = useState('');

  useEffect(() => {
    const p = activePath && isVideoPath(activePath) ? activePath : null;
    if (!p || p.endsWith('/') || p.endsWith('\\')) {
      setSrc('');
      setInfo(null);
      setPath('');
      setWarn('');
      return;
    }
    setPath(p);
    setInfo(null);
    setWarn('');
    // 立即切换预览 URL（asset 协议，不读整文件）
    setSrc(mediaPreviewUrl(p));
    if (!probe) return;
    let cancelled = false;
    (async () => {
      try {
        const i = await getVideoInfo(p);
        if (cancelled) return;
        setInfo(i);
        if (i.height % 2 !== 0) {
          setWarn(`视频高度为奇数(${i.height}px)，合成时将忽略最底 1 行`);
        } else setWarn('');
      } catch {
        if (!cancelled) {
          setInfo(null);
          setWarn('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, probe]);

  return { src, info, path, warn, name: path ? path.split(/[/\\]/).filter(Boolean).pop()! : '' };
}

function onlyFiles(paths: string[]) {
  return paths.filter((p) => !p.endsWith('/') && !p.endsWith('\\'));
}

async function resolveTaskMediaFiles(
  resolveLeafPaths: (paths: string[]) => Promise<string[]>,
  targets: string[],
  accepts: (path: string) => boolean,
  appendLog: (line: string | TaskLogEvent) => void,
): Promise<string[]> {
  const leaves = onlyFiles(await resolveLeafPaths(targets));
  const { files, skipped } = partitionMediaPaths(leaves, accepts);
  if (skipped.length > 0) {
    const examples = skipped
      .slice(0, 3)
      .map((path) => path.split(/[/\\]/).filter(Boolean).pop() || path)
      .join('、');
    appendLog(`[SKIP] 已跳过 ${skipped.length} 个不支持的文件${examples ? `：${examples}${skipped.length > 3 ? ' 等' : ''}` : ''}`);
  }
  if (files.length === 0 && skipped.length > 0) {
    appendLog('[PASS] 没有需要执行的受支持媒体文件');
  }
  return files;
}

function requireAgentPreset(
  presets: Preset[],
  presetId: string,
  label: string,
  expectedRevision = 0,
  expectedType?: Preset['type'],
): Preset {
  const preset = presets.find((item) => item.id === presetId);
  if (!preset) throw new Error(`${label}预设不存在或已被删除`);
  if (expectedType && preset.type !== expectedType) {
    throw new Error(`${label}任务收到错误类型的预设快照`);
  }
  if (expectedRevision > 0 && (preset.revision ?? 1) !== expectedRevision) {
    throw new Error(`${label}任务的预设快照版本不一致，请重新发起任务`);
  }
  return preset;
}

function fileLogEvent(
  kind: 'file_start' | 'file_end',
  path: string,
  index: number,
  total: number,
  tone: TaskLogEvent['tone'],
  message: string,
): TaskLogEvent {
  return {
    kind,
    queueIndex: index + 1,
    queueTotal: total,
    filename: path.split(/[/\\]/).filter(Boolean).pop() || path,
    sourcePath: path,
    tone,
    message,
  };
}

function useOutputFormState() {
  const [output, setOutput] = useState<OutputFormState>(() => ({ ...DEFAULT_OUTPUT_FORM }));
  const [presetName, setPresetName] = useState('');
  const setOutputField = useCallback((key: keyof OutputFormState, value: string) => {
    setOutput((current) => ({ ...current, [key]: value }));
  }, []);
  const applyOutput = useCallback((params: Partial<OutputFormState>, nextPresetName = '') => {
    setPresetName(nextPresetName);
    const hasOutputSettings = ['outputMode', 'outputNameTemplate', 'outputSubdirectory', 'outputDirectory']
      .some((key) => Object.prototype.hasOwnProperty.call(params, key));
    if (nextPresetName || hasOutputSettings) setOutput(normalizeOutputForm(params));
  }, []);
  return { output, presetName, setOutputField, applyOutput };
}

/* ========================= 转码 ========================= */

export function EncodeTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const [form, setForm] = useState(() => ({ ...DEFAULT_ENCODE_FORM }));
  const [resultView, setResultView] = useResultView(t.running, form.previewDuringEncode);
  const [presetName, setPresetName] = useState('');
  const previewPath = t.progressSource;
  const previewName = previewPath.split(/[/\\]/).filter(Boolean).pop() ?? '';
  const media = useActiveMedia((t.running && form.previewDuringEncode && previewPath) || fl.activePath, false);

  // 面板内联控件直接改 form（无需先建预设）
  const setField = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  // 套用预设时，把其参数写入当前表单；空白项（预设里未选择的）跳过，保留运行时默认值
  const applyEncode = (params: any, nextPresetName = '') => {
    setPresetName(nextPresetName);
    setForm((prev) => {
      const merged: any = { ...prev };
      for (const [k, v] of Object.entries(normalizeEncodeParams(params))) {
        if (v === '' || v === null || v === undefined) continue;
        merged[k] = v;
      }
      return merged;
    });
  };

  const encodeLabels = buildEncodeNameLabels({
    ...form,
    scaleW: form.scaleW,
    scaleH: form.scaleH,
    keepRes: form.keepRes,
    fps: form.fps,
    videoCodec: form.videoCodec,
    rateMode: form.rateMode,
    videoBitrate: form.videoBitrate,
    crf: form.crf,
    targetFileSizeMb: form.targetFileSizeMb,
  });

  const runPaths = (targets: string[]) => t.start(async () => {
    let resolvedFileCount = targets.length;
    try {
      const outputKind = isAudioOutputFormat(form.container, form.outputKind) ? 'audio' : 'video';
      const files = await resolveTaskMediaFiles(
        fl.resolveLeafPaths,
        targets,
        outputKind === 'audio' ? isAudioVisualPath : isVideoPath,
        t.appendLog,
      );
      resolvedFileCount = files.length;
      if (files.length === 0) return;
      const result = await transcode({
        paths: files,
        videoCodec: form.videoCodec,
        videoProfile: form.videoProfile,
        crf: form.crf,
        speedPreset: form.preset,
        tune: form.tune,
        style: 0,
        videoLevel: form.videoLevel,
        pixelFormat: form.pixelFormat,
        container: form.container,
        scaleMode: form.scaleMode,
        scaleEdge: form.scaleEdge,
        scaleW: form.scaleW,
        scaleH: form.scaleH,
        fps: form.fps,
        videoBitrate: form.videoBitrate,
        maxrate: form.maxrate,
        bufsize: form.bufsize,
        audioCodec: form.audioCodec,
        audioProfile: form.audioProfile,
        audioBitrate: form.audioBitrate,
        audioSampleRate: form.audioSampleRate,
        audioChannels: form.audioChannels,
        unsharp: form.unsharp,
        denoise: form.denoise,
        deblock: form.deblock,
        loudnorm: form.loudnorm,
        outputKind,
        noAudio: form.noAudio,
        keepRes: form.keepRes,
        rateMode: form.rateMode || 'crf',
        targetFileSizeMb: form.targetFileSizeMb || 0,
        twoPass: !!form.twoPass,
        // Shared transcode entry supplies the same labels used by the preview.
        outputOptions: toOutputSettings(form, presetName),
      });
      t.setOutputPaths(result.outputPaths);
      t.setPass(result.completed);
      t.setFail(result.failed);
    } catch (e) {
      t.setFail(resolvedFileCount);
      throw e;
    }
  });

  useEffect(() => registerAgentTaskHandler('encode', (agentTask) => t.start(async (): Promise<AgentTaskExecutionResult> => {
    const preset = requireAgentPreset(
      agentTask.presetSnapshots,
      agentTask.presetId,
      '转码',
      agentTask.presetRevision,
      'encode',
    );
    const agentForm: any = { ...DEFAULT_ENCODE_FORM, ...normalizeEncodeParams(preset.params) };
    const outputKind = isAudioOutputFormat(agentForm.container, agentForm.outputKind) ? 'audio' : 'video';
    const files = await resolveTaskMediaFiles(
      fl.resolveLeafPaths,
      agentTask.inputPaths,
      outputKind === 'audio' ? isAudioVisualPath : isVideoPath,
      t.appendLog,
    );
    if (files.length === 0) return { outputPaths: [], detail: '没有需要转码的受支持媒体文件' };
    const result = await transcode({
      paths: files,
      videoCodec: agentForm.videoCodec,
      videoProfile: agentForm.videoProfile,
      crf: agentForm.crf,
      speedPreset: agentForm.preset,
      tune: agentForm.tune,
      style: 0,
      videoLevel: agentForm.videoLevel,
      pixelFormat: agentForm.pixelFormat,
      container: agentForm.container,
      scaleMode: agentForm.scaleMode,
      scaleEdge: agentForm.scaleEdge,
      scaleW: agentForm.scaleW,
      scaleH: agentForm.scaleH,
      fps: agentForm.fps,
      videoBitrate: agentForm.videoBitrate,
      maxrate: agentForm.maxrate,
      bufsize: agentForm.bufsize,
      audioCodec: agentForm.audioCodec,
      audioProfile: agentForm.audioProfile,
      audioBitrate: agentForm.audioBitrate,
      audioSampleRate: agentForm.audioSampleRate,
      audioChannels: agentForm.audioChannels,
      unsharp: agentForm.unsharp,
      denoise: agentForm.denoise,
      deblock: agentForm.deblock,
      loudnorm: agentForm.loudnorm,
      outputKind,
      noAudio: agentForm.noAudio,
      keepRes: agentForm.keepRes,
      rateMode: agentForm.rateMode || 'crf',
      targetFileSizeMb: agentForm.targetFileSizeMb || 0,
      twoPass: !!agentForm.twoPass,
      outputOptions: {
        ...toOutputSettings(agentForm, preset.name),
        uniqueName: true,
      },
    });
    t.setOutputPaths(result.outputPaths);
    t.setPass(result.completed);
    t.setFail(result.failed);
    return {
      outputPaths: result.outputPaths,
      detail: `转码完成 ${result.completed} 个文件${result.failed > 0 ? `，失败 ${result.failed} 个` : ''}`,
    };
  })), [fl.resolveLeafPaths, t.appendLog, t.setFail, t.setOutputPaths, t.setPass, t.start]);

  return (
    <ToolWorkspace
      taskFailure={t.error ? { message: t.error, logs: t.logs, onClose: t.clearError } : undefined}
      params={
        <>
          <PresetManager type="encode" onApply={applyEncode} currentParams={form} renderBuilder={(ctx) => <PresetBuilder ctx={ctx} />} />
          <EncodeInlineForm form={form} set={setField} />
          <OutputLocationGroup
            value={form}
            presetName={presetName}
            extension={form.container || (isAudioOutputFormat(form.container, form.outputKind) ? 'm4a' : 'mp4')}
            encodeLabels={encodeLabels}
            onChange={setField}
            disabled={t.running}
          />
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedCount}
          totalCount={fl.totalCount}
          onSelected={() => runPaths(fl.selectedPaths)}
          onAll={() => runPaths(fl.allPaths)}
          onStop={t.cancel}
          onOpenOutput={t.outputPaths.length > 0 ? t.openOutputs : undefined}
        />
      }
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} running={t.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={t.logs.length} running={t.running} />}
      result={(
        <ResultViewContent
          value={resultView}
          logs={t.logs}
          preview={(
            <div className="se-encode-preview">
              {previewName && (
                <div className="se-encode-preview-meta">
                  <span className="se-encode-preview-file" title={previewPath}>{previewName}</span>
                  <span className="se-encode-preview-time">{formatTime(t.progressTime)}</span>
                </div>
              )}
              <VideoPlayer
                src={media.src}
                filePath={media.path}
                cropEnabled={false}
                monitorMode={t.running && form.previewDuringEncode}
                controlsDisabled={t.running}
                followTime={t.progressTime}
              />
            </div>
          )}
        />
      )}
    />
  );
}

/* ========================= 混音 ========================= */

export function MixTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const media = useActiveMedia(fl.activePath, false);
  const [resultView, setResultView] = useResultView(t.running);
  const { output, presetName, setOutputField, applyOutput } = useOutputFormState();
  const [lnOn, setLnOn] = useState(true);
  const [tpOn, setTpOn] = useState(true);
  const [lnI, setLnI] = useState(-24.0);
  const [lnTp, setLnTp] = useState(-2.0);
  const [lnLra, setLnLra] = useState(7.0);
  const [cpTh, setCpTh] = useState(-27.0);
  const [cpGain, setCpGain] = useState(5.0);

  const applyMix = (params: any, nextPresetName = '') => {
    if (params.lnOn != null) setLnOn(params.lnOn);
    if (params.lnI != null) setLnI(params.lnI);
    if (params.lnTp != null) setLnTp(params.lnTp);
    if (params.lnLra != null) setLnLra(params.lnLra);
    if (params.tpOn != null) setTpOn(params.tpOn);
    if (params.cpTh != null) setCpTh(params.cpTh);
    if (params.cpGain != null) setCpGain(params.cpGain);
    applyOutput(params, nextPresetName);
  };

  const runPaths = (targets: string[]) => t.start(async () => {
    try {
      const files = await resolveTaskMediaFiles(fl.resolveLeafPaths, targets, isAudioVisualPath, t.appendLog);
      if (files.length === 0) return;
      const outputs = await mixAudio(files, lnI, lnTp, lnLra, cpTh, cpGain, lnOn, tpOn, toOutputSettings(output, presetName));
      t.setOutputPaths(outputs);
      t.setPass(files.length);
      t.setFail(0);
    } catch (e) {
      t.setFail(targets.length);
      throw e;
    }
  });

  useEffect(() => registerAgentTaskHandler('mix', (agentTask) => t.start(async (): Promise<AgentTaskExecutionResult> => {
    const preset = requireAgentPreset(
      agentTask.presetSnapshots,
      agentTask.presetId,
      '混音',
      agentTask.presetRevision,
      'mix',
    );
    const params: any = { ...DEFAULT_OUTPUT_FORM, ...preset.params };
    const files = await resolveTaskMediaFiles(
      fl.resolveLeafPaths,
      agentTask.inputPaths,
      isAudioVisualPath,
      t.appendLog,
    );
    if (files.length === 0) return { outputPaths: [], detail: '没有需要混音的受支持音视频文件' };
    const outputs = await mixAudio(
      files,
      params.lnI ?? -24,
      params.lnTp ?? -2,
      params.lnLra ?? 7,
      params.cpTh ?? -27,
      params.cpGain ?? 5,
      params.lnOn !== false,
      params.tpOn !== false,
      { ...toOutputSettings(params, preset.name), uniqueName: true },
    );
    t.setOutputPaths(outputs);
    t.setPass(files.length);
    t.setFail(0);
    return { outputPaths: outputs, detail: `混音完成 ${outputs.length} 个文件` };
  })), [fl.resolveLeafPaths, t.appendLog, t.setFail, t.setOutputPaths, t.setPass, t.start]);

  return (
    <ToolWorkspace
      taskFailure={t.error ? { message: t.error, logs: t.logs, onClose: t.clearError } : undefined}
      params={
        <>
          <PresetManager type="mix" onApply={applyMix} initialValues={{ lnOn, lnI, lnTp, lnLra, tpOn, cpTh, cpGain, ...output }} currentParams={{ lnOn, lnI, lnTp, lnLra, tpOn, cpTh, cpGain, ...output }} />
          <ui.ParamGroup
            title="响度标准化 (EBU R128)"
            aside={<ui.Checkbox checked={lnOn} onChange={setLnOn} disabled={t.running}>{''}</ui.Checkbox>}
          >
            <ui.FieldGrid>
              <ui.FieldLabel>目标响度 (I)</ui.FieldLabel>
              <ui.NumberField value={lnI} min={-70} max={-5} step={1} suffix="LUFS" disabled={t.running || isPresetUiFieldDisabled('mix', 'lnI', { lnOn, tpOn })} onChange={setLnI} />
              <ui.FieldLabel>真峰限制 (TP)</ui.FieldLabel>
              <ui.NumberField value={lnTp} min={-9} max={0} step={0.5} suffix="dBTP" disabled={t.running || isPresetUiFieldDisabled('mix', 'lnTp', { lnOn, tpOn })} onChange={setLnTp} />
              <ui.FieldLabel>响度范围 (LRA)</ui.FieldLabel>
              <ui.NumberField value={lnLra} min={1} max={50} step={1} suffix="LU" disabled={t.running || isPresetUiFieldDisabled('mix', 'lnLra', { lnOn, tpOn })} onChange={setLnLra} />
            </ui.FieldGrid>
          </ui.ParamGroup>
          <ui.ParamGroup
            title="动态压缩 (Compand)"
            aside={<ui.Checkbox checked={tpOn} onChange={setTpOn} disabled={t.running}>{''}</ui.Checkbox>}
          >
            <ui.FieldGrid>
              <ui.FieldLabel>压缩阈值</ui.FieldLabel>
              <ui.NumberField value={cpTh} min={-80} max={0} step={1} suffix="dB" disabled={t.running || isPresetUiFieldDisabled('mix', 'cpTh', { lnOn, tpOn })} onChange={setCpTh} />
              <ui.FieldLabel>补偿增益</ui.FieldLabel>
              <ui.NumberField value={cpGain} min={-20} max={40} step={1} suffix="dB" disabled={t.running || isPresetUiFieldDisabled('mix', 'cpGain', { lnOn, tpOn })} onChange={setCpGain} />
            </ui.FieldGrid>
          </ui.ParamGroup>
          <OutputLocationGroup value={output} presetName={presetName} extension="mp4" defaultSuffix="_mix" onChange={setOutputField} disabled={t.running} />
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedCount}
          totalCount={fl.totalCount}
          onSelected={() => runPaths(fl.selectedPaths)}
          onAll={() => runPaths(fl.allPaths)}
          onStop={t.cancel}
          onOpenOutput={t.outputPaths.length > 0 ? t.openOutputs : undefined}
        />
      }
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} running={t.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={t.logs.length} running={t.running} />}
      result={<ResultViewContent value={resultView} logs={t.logs} preview={<VideoPlayer src={media.src} filePath={media.path} cropEnabled={false} controlsDisabled={t.running} />} />}
    />
  );
}

/* ========================= 检测 ========================= */

export function CheckTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const media = useActiveMedia(fl.activePath, false);
  const [resultView, setResultView] = useResultView(t.running);
  const [fpsTol, setFpsTol] = useState(0.5);
  const [recursive, setRecursive] = useState(true);
  const [blackDetect, setBlackDetect] = useState(true);
  // 所选编码规范预设（对照用，来自转码预设列表）
  const encPresets = usePresets('encode');
  const [refEncId, setRefEncId] = useState<string | null>(null);
  const refEnc = encPresets.presets.find((p) => p.id === refEncId) ?? null;

  const applyCheck = (params: any) => {
    if (params.fpsTol != null) setFpsTol(params.fpsTol);
    if (params.recursive != null) setRecursive(params.recursive);
    if (params.blackDetect != null) setBlackDetect(params.blackDetect);
    if (params.refEncPresetId !== undefined) setRefEncId(params.refEncPresetId || null);
  };

  // 编码规范对照值（传入 PresetCard 展示）
  const encRef = refEnc ? {
    refEncName: refEnc.name || '',
    refEncCodec: refEnc.params?.videoCodec || '',
    refEncRes: (refEnc.params?.scaleW && refEnc.params?.scaleH) ? `${refEnc.params.scaleW}×${refEnc.params.scaleH}` : '',
    refEncFps: refEnc.params?.fps || 0,
  } : {};

  const runPaths = (targets: string[]) => t.start(async () => {
    const files = await resolveTaskMediaFiles(fl.resolveLeafPaths, targets, isVideoPath, t.appendLog);
    if (files.length === 0) return;
    const expW = refEnc?.params?.scaleW || 0;
    const expH = refEnc?.params?.scaleH || 0;
    const expFps = refEnc?.params?.fps || 0;
    const expCodec = refEnc?.params?.videoCodec || '';
    const r = await checkVideos(files, fpsTol, recursive, blackDetect, expW, expH, expFps, expCodec);
    t.setPass(r.pass + r.pass_with_warnings);
    t.setFail(r.fail);
    t.setDetail(`通过 ${r.pass}，警告 ${r.pass_with_warnings}，失败 ${r.fail}`);
  });

  useEffect(() => registerAgentTaskHandler('check', (agentTask) => t.start(async (): Promise<AgentTaskExecutionResult> => {
    const preset = requireAgentPreset(
      agentTask.presetSnapshots,
      agentTask.presetId,
      '检测',
      agentTask.presetRevision,
      'check',
    );
    const params: any = preset.params ?? {};
    const referenceId = String(params.refEncPresetId || '');
    const reference = referenceId
      ? requireAgentPreset(agentTask.presetSnapshots, referenceId, '检测引用的转码', 0, 'encode')
      : undefined;
    const files = await resolveTaskMediaFiles(
      fl.resolveLeafPaths,
      agentTask.inputPaths,
      isVideoPath,
      t.appendLog,
    );
    if (files.length === 0) return { outputPaths: [], detail: '没有需要检测的受支持视频文件' };
    const summary = await checkVideos(
      files,
      params.fpsTol ?? 0.5,
      params.recursive !== false,
      params.blackDetect !== false,
      reference?.params.scaleW || 0,
      reference?.params.scaleH || 0,
      reference?.params.fps || 0,
      reference?.params.videoCodec || '',
    );
    t.setPass(summary.pass + summary.pass_with_warnings);
    t.setFail(summary.fail);
    const detail = `通过 ${summary.pass}，警告 ${summary.pass_with_warnings}，失败 ${summary.fail}`;
    t.setDetail(detail);
    return { outputPaths: [], detail };
  })), [fl.resolveLeafPaths, t.appendLog, t.setDetail, t.setFail, t.setPass, t.start]);

  return (
    <ToolWorkspace
      taskFailure={t.error ? { message: t.error, logs: t.logs, onClose: t.clearError } : undefined}
      params={
        <>
          <PresetManager type="check" onApply={applyCheck} initialValues={{ fpsTol, recursive, blackDetect }} currentParams={{ fpsTol, recursive, blackDetect, ...encRef }} />
          <ui.ParamGroup title="编码规范参照">
            <ui.FieldGrid>
              <ui.FieldLabel>对照预设</ui.FieldLabel>
              <ui.ComboBox
                value={refEncId ?? ''}
                options={encPresets.presets.length
                  ? [{ label: '不指定编码规范', value: '' }, ...encPresets.presets.map((p) => ({ label: p.name, value: p.id }))]
                  : [{ label: '无转码预设', value: '' }]}
                onChange={(v) => setRefEncId(v || null)}
              />
            </ui.FieldGrid>
          </ui.ParamGroup>
          <ui.ParamGroup title="检测规则">
            <ui.FieldGrid>
              <ui.FieldLabel>帧率容差</ui.FieldLabel>
              <ui.NumberField value={fpsTol} min={0} max={10} step={0.1} disabled={t.running || isPresetUiFieldDisabled('check', 'fpsTol', { refEncPresetId: refEncId })} onChange={setFpsTol} />
            </ui.FieldGrid>
            <ui.Checkbox checked={recursive} onChange={setRecursive} disabled={t.running}>目录递归扫描</ui.Checkbox>
            <ui.Checkbox checked={blackDetect} onChange={setBlackDetect} disabled={t.running}>启用中间黑帧检测</ui.Checkbox>
          </ui.ParamGroup>
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedCount}
          totalCount={fl.totalCount}
          onSelected={() => runPaths(fl.selectedPaths)}
          onAll={() => runPaths(fl.allPaths)}
          onStop={t.cancel}
        />
      }
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} running={t.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={t.logs.length} running={t.running} />}
      result={<ResultViewContent value={resultView} logs={t.logs} preview={<VideoPlayer src={media.src} filePath={media.path} cropEnabled={false} controlsDisabled={t.running} />} />}
    />
  );
}

/* ========================= 合成透明通道 ========================= */

export function AlphaTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const [resultView, setResultView] = useResultView(t.running);
  const { output, presetName, setOutputField, applyOutput } = useOutputFormState();
  const [fpsOriginal, setFpsOriginal] = useState(true);
  const [fps, setFps] = useState(25.0);
  const media = useActiveMedia(fl.activePath, true);

  const applyAlpha = (params: any, nextPresetName = '') => {
    if (params.fpsOriginal != null) setFpsOriginal(params.fpsOriginal);
    if (params.fps != null) setFps(params.fps);
    applyOutput(params, nextPresetName);
  };

  const runBatch = (targets: string[]) => {
    t.start(async () => {
      const files = await resolveTaskMediaFiles(fl.resolveLeafPaths, targets, isVideoPath, t.appendLog);
      if (files.length === 0) return;
      let ok = 0;
      let bad = 0;
      const outputs: string[] = [];
      for (let i = 0; i < files.length; i++) {
        if (t.isCancelled()) break;
        const input = files[i];
        t.appendLog(fileLogEvent('file_start', input, i, files.length, 'normal', '等待合成'));
        t.setDetail(`(${i + 1}/${files.length}) ${input.split(/[/\\]/).pop()}`);
        t.setProgress(Math.round((i / files.length) * 100));
        try {
          const outputPath = await composeAlpha(input, fpsOriginal ? null : fps, toOutputSettings(output, presetName));
          ok++;
          t.setPass(ok);
          outputs.push(outputPath);
          t.appendLog(`[PASS] ${outputPath}`);
          t.appendLog(fileLogEvent('file_end', input, i, files.length, 'pass', '合成完成'));
        } catch (e: any) {
          bad++;
          t.setFail(bad);
          t.appendLog(`[FAIL] ${input}: ${e?.message || e}`);
          t.appendLog(fileLogEvent('file_end', input, i, files.length, 'fail', '合成失败'));
        }
        if (t.isCancelled()) break;
      }
      if (!t.isCancelled()) t.setProgress(100);
      t.setOutputPaths(outputs);
      if (bad > 0 && ok === 0) throw new Error(`全部失败 (${bad})`);
    });
  };

  useEffect(() => registerAgentTaskHandler('alpha', (agentTask) => t.start(async (): Promise<AgentTaskExecutionResult> => {
    const preset = requireAgentPreset(
      agentTask.presetSnapshots,
      agentTask.presetId,
      '透明通道',
      agentTask.presetRevision,
      'alpha',
    );
    const params: any = { ...DEFAULT_OUTPUT_FORM, ...preset.params };
    const files = await resolveTaskMediaFiles(
      fl.resolveLeafPaths,
      agentTask.inputPaths,
      isVideoPath,
      t.appendLog,
    );
    if (files.length === 0) return { outputPaths: [], detail: '没有需要合成的受支持视频文件' };
    let succeeded = 0;
    let failed = 0;
    const outputs: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      if (t.isCancelled()) break;
      const input = files[index];
      t.appendLog(fileLogEvent('file_start', input, index, files.length, 'normal', '等待合成'));
      t.setDetail(`(${index + 1}/${files.length}) ${input.split(/[/\\]/).pop()}`);
      t.setProgress(Math.round((index / files.length) * 100));
      try {
        const outputPath = await composeAlpha(
          input,
          params.fpsOriginal !== false ? null : (params.fps ?? 25),
          { ...toOutputSettings(params, preset.name), uniqueName: true },
        );
        succeeded += 1;
        outputs.push(outputPath);
        t.setPass(succeeded);
        t.appendLog(`[PASS] ${outputPath}`);
        t.appendLog(fileLogEvent('file_end', input, index, files.length, 'pass', '合成完成'));
      } catch (error: any) {
        if (t.isCancelled()) break;
        failed += 1;
        t.setFail(failed);
        t.appendLog(`[FAIL] ${input}: ${String(error?.message || error)}`);
        t.appendLog(fileLogEvent('file_end', input, index, files.length, 'fail', '合成失败'));
      }
    }
    t.setOutputPaths(t.isCancelled() ? [] : outputs);
    if (!t.isCancelled()) t.setProgress(100);
    if (failed > 0 && succeeded === 0) throw new Error(`全部失败 (${failed})`);
    return {
      outputPaths: outputs,
      detail: `透明通道完成 ${succeeded}，失败 ${failed}`,
    };
  })), [
    fl.resolveLeafPaths,
    t.appendLog,
    t.isCancelled,
    t.setDetail,
    t.setFail,
    t.setOutputPaths,
    t.setPass,
    t.setProgress,
    t.start,
  ]);

  return (
    <ToolWorkspace
      taskFailure={t.error ? { message: t.error, logs: t.logs, onClose: t.clearError } : undefined}
      params={
        <>
          <PresetManager
            type="alpha"
            onApply={applyAlpha}
            initialValues={{ fpsOriginal, fps, ...output }}
            currentParams={{ fpsOriginal, fps, ...output }}
          />
          <ui.ParamGroup title="帧率设置">
            <ui.Radio checked={fpsOriginal} onToggle={() => setFpsOriginal(true)}>保持原始帧率</ui.Radio>
            <div className="se-btn-row">
              <ui.Radio checked={!fpsOriginal} onToggle={() => setFpsOriginal(false)}>自定义帧率</ui.Radio>
              <ui.NumberField value={fps} min={1} max={120} step={0.1} disabled={isPresetUiFieldDisabled('alpha', 'fps', { fpsOriginal })} onChange={setFps} width={110} />
            </div>
          </ui.ParamGroup>
          <OutputLocationGroup value={output} presetName={presetName} extension="mov" defaultSuffix="_合成" onChange={setOutputField} disabled={t.running} />
          {media.warn && <ui.WarnLabel>{media.warn}</ui.WarnLabel>}
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedCount}
          totalCount={fl.totalCount}
          onSelected={() => runBatch(fl.selectedPaths)}
          onAll={() => runBatch(fl.allPaths)}
          onStop={t.cancel}
          onOpenOutput={t.outputPaths.length > 0 ? t.openOutputs : undefined}
        />
      }
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} running={t.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={t.logs.length} running={t.running} />}
      result={<ResultViewContent value={resultView} logs={t.logs} preview={<VideoPlayer src={media.src} filePath={media.path} alphaPreview cropEnabled={false} controlsDisabled={t.running} />} />}
    />
  );
}

/* ========================= 截图 ========================= */

export function ScreenshotTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const { output, presetName, setOutputField, applyOutput } = useOutputFormState();
  const playerRef = useRef<VideoPlayerHandle>(null);
  const media = useActiveMedia(fl.activePath, true);
  const [w, setW] = useState(DEFAULT_EXPORT_DIMENSIONS.width);
  const [h, setH] = useState(DEFAULT_EXPORT_DIMENSIONS.height);
  const [aspect, setAspect] = useState('free');
  const [customRatio, setCustomRatio] = useState('3:2');
  const [imageFormat, setImageFormat] = useState('png');
  const [quality, setQuality] = useState(90);
  const [pngCompression, setPngCompression] = useState(6);
  const [cropLocked, setCropLocked] = useState(false);
  const [time, setTime] = useState('00:00:00.000');
  const [resultView, setResultView] = useResultView(t.running);

  // 根据当前比例设置播放器选区约束（自定义比例实时解析）
  const applyAspect = () => {
    const p = playerRef.current;
    if (!p) return;
    if (aspect === 'free') p.setCropAspect(0, 0);
    else if (aspect === 'match') p.setCropAspect(w, h);
    else {
      const r = aspectToRatio(aspect, customRatio);
      if (r) p.setCropAspect(r.aw, r.ah);
    }
  };

  // 固定比例下：改宽自动算高、改高自动算宽；匹配模式则同步选区比例
  const onW = (v: number) => {
    setW(v);
    if (aspect === 'match') playerRef.current?.setCropAspect(v, h);
    else { const r = aspectToRatio(aspect, customRatio); if (r) setH(linkAspectHeight(v, r)); }
  };
  const onH = (v: number) => {
    setH(v);
    if (aspect === 'match') playerRef.current?.setCropAspect(w, v);
    else { const r = aspectToRatio(aspect, customRatio); if (r) setW(linkAspectWidth(v, r)); }
  };
  const onAspectChange = (v: string) => {
    setAspect(v);
    if (v === 'free') {
      playerRef.current?.setCropAspect(0, 0); // 自由：直接截取，输出尺寸由选区决定
      if (media.info) { setW(media.info.width); setH(media.info.height); }
    } else if (v === 'match') {
      const next = dimensionsForCropAspect(
        v,
        media.info,
        playerRef.current?.getCropRect() ?? null,
        { width: w, height: h },
      );
      setW(next.width);
      setH(next.height);
      playerRef.current?.setCropAspect(next.width, next.height);
    }
    else { const r = aspectToRatio(v, customRatio); if (r && w > 0) setH(linkAspectHeight(w, r)); } // 选比例后按当前宽重算高
  };
  const [crw, crh] = parseCustomRatioParts(customRatio);
  const onCustomRatioW = (v: number) => {
    const s = `${v}:${crh}`;
    setCustomRatio(s);
    const r = aspectToRatio('custom', s);
    if (r) playerRef.current?.setCropAspect(r.aw, r.ah);
  };
  const onCustomRatioH = (v: number) => {
    const s = `${crw}:${v}`;
    setCustomRatio(s);
    const r = aspectToRatio('custom', s);
    if (r) playerRef.current?.setCropAspect(r.aw, r.ah);
  };

  useEffect(() => {
    if (media.info) applyAspect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.info, aspect, customRatio]);
  useEffect(() => {
    if (aspect === 'match') playerRef.current?.setCropAspect(w, h);
  }, [w, h, aspect]);
  // 自由/匹配模式下，加载素材后把输出尺寸初始化为完整画面
  useEffect(() => {
    if (media.info && (aspect === 'free' || aspect === 'match')) {
      const next = dimensionsForCropAspect(aspect, media.info, null, { width: w, height: h });
      setW(next.width);
      setH(next.height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.info]);

  const applyShot = (params: any, nextPresetName = '') => {
    const nextAspect = params.aspect ?? aspect;
    const nextDimensions = dimensionsForCropAspect(
      nextAspect,
      media.info,
      playerRef.current?.getCropRect() ?? null,
      { width: params.w ?? w, height: params.h ?? h },
    );
    setW(nextDimensions.width);
    setH(nextDimensions.height);
    if (params.aspect != null) setAspect(nextAspect);
    if (params.customRatio != null) setCustomRatio(params.customRatio);
    if (params.imageFormat != null && IMAGE_SEQUENCE_FORMAT_OPTIONS.some((option) => option.value === params.imageFormat)) {
      setImageFormat(params.imageFormat);
    }
    if (params.quality != null) setQuality(params.quality);
    if (params.pngCompression != null) setPngCompression(params.pngCompression);
    applyOutput(params, nextPresetName);
  };

  const onCrop = (r: CropRectResult) => {
    if (r.w === 0 && r.h === 0) {
      // 自由/匹配模式：清除选区后输出尺寸回到完整画面
      if ((aspect === 'free' || aspect === 'match') && media.info) {
        const next = dimensionsForCropAspect(aspect, media.info, null, { width: w, height: h });
        setW(next.width);
        setH(next.height);
      }
    } else {
      // 自由/匹配模式：输出尺寸直接等于所截区域（native 分辨率）
      if (aspect === 'free' || aspect === 'match') {
        const next = dimensionsForCropAspect(aspect, media.info, r, { width: w, height: h });
        setW(next.width);
        setH(next.height);
      }
    }
  };

  const runBatch = (targets: string[]) => {
    t.start(async () => {
      const files = await resolveTaskMediaFiles(fl.resolveLeafPaths, targets, isVideoPath, t.appendLog);
      if (files.length === 0) return;
      let ok = 0;
      let bad = 0;
      const outputs: string[] = [];
      const ts = playerRef.current?.getCurrentTime() ?? 0;
      const crop = playerRef.current?.getCropRect() ?? null;
      const cropDimensions = playerRef.current?.getMediaDimensions() ?? null;
      for (let i = 0; i < files.length; i++) {
        if (t.isCancelled()) break;
        const file = files[i];
        t.appendLog(fileLogEvent('file_start', file, i, files.length, 'normal', '等待截图'));
        t.setDetail(`(${i + 1}/${files.length}) ${file.split(/[/\\]/).pop()}`);
        t.setProgress(Math.round((i / files.length) * 100));
        try {
          const targetCrop = await cropForTarget(file, crop, cropDimensions);
          const outputPath = await screenshotFrame(file, ts, w, h, imageFormat, quality, pngCompression, targetCrop, toOutputSettings(output, presetName));
          ok++;
          t.setPass(ok);
          outputs.push(outputPath);
          t.appendLog(`[PASS] ${outputPath}`);
          t.appendLog(fileLogEvent('file_end', file, i, files.length, 'pass', '截图完成'));
        } catch (e: any) {
          bad++;
          t.setFail(bad);
          t.appendLog(`[FAIL] ${file}: ${e?.message || e}`);
          t.appendLog(fileLogEvent('file_end', file, i, files.length, 'fail', '截图失败'));
        }
        if (t.isCancelled()) break;
      }
      if (!t.isCancelled()) t.setProgress(100);
      t.setOutputPaths(outputs);
      if (bad > 0 && ok === 0) throw new Error(`全部失败 (${bad})`);
    });
  };

  return (
    <ToolWorkspace
      taskFailure={t.error ? { message: t.error, logs: t.logs, onClose: t.clearError } : undefined}
      params={
        <>
          <PresetManager
            type="screenshot"
            onApply={applyShot}
            initialValues={{ w, h, aspect, customRatio, imageFormat, quality, pngCompression, ...output }}
            currentParams={{ w, h, aspect, customRatio, imageFormat, quality, pngCompression, ...output }}
          />
          {media.info && (
            <ui.VideoInfo>
              {media.info.width}×{media.info.height} · {media.info.fps.toFixed(2)}fps · {formatTime(media.info.duration)}
              {media.info.has_alpha ? ' · 透明' : ''}
            </ui.VideoInfo>
          )}
          <ui.ParamGroup title="选取比例">
            <ui.AnimatedFieldGrid rows={[
              {
                id: 'aspect',
                content: (
                  <>
                    <ui.FieldLabel>比例</ui.FieldLabel>
                    <ui.ComboBox value={aspect} options={CROP_ASPECT_OPTIONS} onChange={onAspectChange} />
                  </>
                ),
              },
              ...(aspect === 'custom' ? [{
                id: 'custom-ratio',
                content: (
                  <>
                    <ui.FieldLabel>宽比</ui.FieldLabel>
                    <ui.IntField value={crw} min={1} max={99} onChange={onCustomRatioW} />
                    <ui.FieldLabel>高比</ui.FieldLabel>
                    <ui.IntField value={crh} min={1} max={99} onChange={onCustomRatioH} />
                  </>
                ),
              }] : []),
            ]} />
            <div className="se-crop-actions">
              <ui.Button
                primary={cropLocked}
                icon={cropLocked ? <IconUnlock size={15} /> : <IconLock size={15} />}
                onClick={() => setCropLocked((locked) => !locked)}
              >
                {cropLocked ? '解锁选区' : '锁定选区'}
              </ui.Button>
              <ui.Button
                disabled={t.running}
                icon={<IconCropClear size={15} />}
                onClick={() => playerRef.current?.clearCrop()}
              >
                清除选区
              </ui.Button>
            </div>
          </ui.ParamGroup>
          <ui.ParamGroup title="输出参数 (截图)">
            <ui.AnimatedFieldGrid tight rows={[
              {
                id: 'resolution',
                content: (
                  <>
                    <ui.FieldLabel>分辨率 (长×宽)</ui.FieldLabel>
                    <div className="se-res-row">
                      <ui.IntField value={w} min={1} max={8192} suffix="px" disabled={isPresetUiFieldDisabled('screenshot', 'w', { aspect })} onChange={onW} />
                      <span className="se-x">×</span>
                      <ui.IntField value={h} min={1} max={8192} suffix="px" disabled={isPresetUiFieldDisabled('screenshot', 'h', { aspect })} onChange={onH} />
                    </div>
                  </>
                ),
              },
              {
                id: 'image-format',
                content: (
                  <>
                    <ui.FieldLabel>图片格式</ui.FieldLabel>
                    <ui.ComboBox value={imageFormat} options={IMAGE_SEQUENCE_FORMAT_OPTIONS} onChange={setImageFormat} />
                  </>
                ),
              },
              ...(['jpg', 'webp'].includes(imageFormat) ? [{
                id: 'quality',
                content: (
                  <>
                    <ui.FieldLabel>质量</ui.FieldLabel>
                    <ui.IntField value={quality} min={1} max={100} onChange={setQuality} />
                  </>
                ),
              }] : []),
              ...(imageFormat === 'png' ? [{
                id: 'png-compression',
                content: (
                  <>
                    <ui.FieldLabel>PNG 压缩级别</ui.FieldLabel>
                    <ui.IntField value={pngCompression} min={0} max={9} onChange={setPngCompression} />
                  </>
                ),
              }] : []),
            ]} />
          </ui.ParamGroup>
          <OutputLocationGroup value={output} presetName={presetName} extension={imageFormat} defaultSuffix="_screenshot" onChange={setOutputField} disabled={t.running} />
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedCount}
          totalCount={fl.totalCount}
          onSelected={() => runBatch(fl.selectedPaths)}
          onAll={() => runBatch(fl.allPaths)}
          onStop={t.cancel}
          onOpenOutput={t.outputPaths.length > 0 ? t.openOutputs : undefined}
        />
      }
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} running={t.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={t.logs.length} running={t.running} />}
      result={(
        <ResultViewContent
          value={resultView}
          logs={t.logs}
          preview={(
            <VideoPlayer
              ref={playerRef}
              src={media.src}
              filePath={media.path}
              alphaPreview={!!media.info?.has_alpha}
              cropEnabled
              cropLocked={cropLocked}
              controlsDisabled={t.running}
              onFrame={(tm) => setTime(formatTime(tm))}
              onCropChange={onCrop}
            />
          )}
        />
      )}
    />
  );
}

/* ========================= 导出 GIF / WebP / 序列帧 / 截取 ========================= */

export function ExportTab({ format }: { format: 'gif' | 'webp' | 'sequence' | 'clip' }) {
  const fl = useFileList();
  const t = useTaskRunner();
  const { output, presetName, setOutputField, applyOutput } = useOutputFormState();
  const playerRef = useRef<VideoPlayerHandle>(null);
  const media = useActiveMedia(fl.activePath, true);
  const [start, setStart] = useState('00:00:00.000');
  const [end, setEnd] = useState('00:00:05.000');
  const [hasStart, setHasStart] = useState(false);
  const [hasEnd, setHasEnd] = useState(false);
  const [fixedDur, setFixedDur] = useState(false);
  const [fixedVal, setFixedVal] = useState(2.0);
  const [fullDuration, setFullDuration] = useState(false);
  const [loopSelection, setLoopSelection] = useState(false);
  const encPresets = usePresets('encode');
  const [w, setW] = useState(DEFAULT_EXPORT_DIMENSIONS.width);
  const [h, setH] = useState(DEFAULT_EXPORT_DIMENSIONS.height);
  const [fps, setFps] = useState(format === 'clip' ? 25 : format === 'sequence' ? 25 : 15);
  const [quality, setQuality] = useState(format === 'sequence' ? 90 : 75);
  const [imageFormat, setImageFormat] = useState('jpg');
  const [pngCompression, setPngCompression] = useState(6);
  const [gifCompression, setGifCompression] = useState<GifCompression>('optimized');
  const [aspect, setAspect] = useState('free');
  const [customRatio, setCustomRatio] = useState('3:2');
  const [cropLocked, setCropLocked] = useState(false);
  const [clipPresetId, setClipPresetId] = useState('');
  const selectedClipPreset = encPresets.presets.find((preset) => preset.id === clipPresetId) ?? null;
  const [resultView, setResultView] = useResultView(t.running);
  const fullMaterialRange = format === 'sequence' && fullDuration;
  const manualStartSeconds = hasStart ? parseTime(start) : null;
  const manualEndSeconds = hasEnd ? parseTime(end) : null;
  const startSeconds = fullMaterialRange ? 0 : manualStartSeconds;
  const endSeconds = fullMaterialRange ? (media.info?.duration ?? null) : manualEndSeconds;
  const rangeValid = startSeconds != null && endSeconds != null && endSeconds > startSeconds;
  const rangeDuration = rangeValid ? endSeconds - startSeconds : 0;
  const rangeHint = fullMaterialRange
    ? (rangeValid
      ? `完整素材 · ${formatTime(rangeDuration)}`
      : '正在读取完整素材时长')
    : !hasStart
      ? '请先定位播放器并设置入点'
      : !hasEnd
        ? '入点已设置，请定位并设置出点'
        : rangeValid
          ? `导出区间 ${start} - ${end} · ${rangeDuration.toFixed(3)}s`
          : '出点必须晚于入点';

  const applyExport = (params: any, nextPresetName = '') => {
    const nextAspect = params.aspect ?? aspect;
    const nextDimensions = dimensionsForCropAspect(
      nextAspect,
      media.info,
      playerRef.current?.getCropRect() ?? null,
      { width: params.w ?? w, height: params.h ?? h },
    );
    setW(nextDimensions.width);
    setH(nextDimensions.height);
    if (params.aspect != null) setAspect(nextAspect);
    if (params.customRatio != null) setCustomRatio(params.customRatio);
    if (params.fps != null) setFps(params.fps);
    if (params.quality != null) setQuality(params.quality);
    if (params.imageFormat != null && IMAGE_SEQUENCE_FORMAT_OPTIONS.some((option) => option.value === params.imageFormat)) {
      setImageFormat(params.imageFormat);
    }
    if (params.pngCompression != null) setPngCompression(params.pngCompression);
    if (params.gifCompression != null) setGifCompression(params.gifCompression);
    const nextFullDuration = format === 'sequence' && params.fullDuration === true;
    if (params.fullDuration != null) setFullDuration(nextFullDuration);
    if (params.fixedDur != null) setFixedDur(nextFullDuration ? false : params.fixedDur);
    if (params.fixedVal != null) setFixedVal(params.fixedVal);
    if (params.clipPresetId != null) {
      const requested = String(params.clipPresetId);
      setClipPresetId(encPresets.presets.some((preset) => preset.id === requested)
        ? requested
        : '');
    }
    applyOutput(params, nextPresetName);
  };

  const onCrop = (r: CropRectResult) => {
    if (r.w === 0 && r.h === 0) {
      // 自由/匹配模式：清除选区后输出尺寸回到完整画面
      if ((aspect === 'free' || aspect === 'match') && media.info) {
        const next = dimensionsForCropAspect(aspect, media.info, null, { width: w, height: h });
        setW(next.width);
        setH(next.height);
      }
    } else {
      // 自由/匹配模式：输出尺寸直接等于所截区域（native 分辨率）
      if (aspect === 'free' || aspect === 'match') {
        const next = dimensionsForCropAspect(aspect, media.info, r, { width: w, height: h });
        setW(next.width);
        setH(next.height);
      }
    }
  };
  // 根据当前比例设置播放器选区约束（自定义比例实时解析）
  const applyAspect = () => {
    const p = playerRef.current;
    if (!p) return;
    if (aspect === 'free') p.setCropAspect(0, 0);
    else if (aspect === 'match') p.setCropAspect(w, h);
    else {
      const r = aspectToRatio(aspect, customRatio);
      if (r) p.setCropAspect(r.aw, r.ah);
    }
  };
  // 固定比例下：改宽自动算高、改高自动算宽；匹配模式则同步选区比例
  const onW = (v: number) => {
    setW(v);
    if (aspect === 'match') playerRef.current?.setCropAspect(v, h);
    else { const r = aspectToRatio(aspect, customRatio); if (r) setH(linkAspectHeight(v, r)); }
  };
  const onH = (v: number) => {
    setH(v);
    if (aspect === 'match') playerRef.current?.setCropAspect(w, v);
    else { const r = aspectToRatio(aspect, customRatio); if (r) setW(linkAspectWidth(v, r)); }
  };
  const onAspectChange = (v: string) => {
    setAspect(v);
    if (v === 'free') {
      playerRef.current?.setCropAspect(0, 0); // 自由：直接截取，输出尺寸由选区决定
      if (media.info) { setW(media.info.width); setH(media.info.height); }
    } else if (v === 'match') {
      const next = dimensionsForCropAspect(
        v,
        media.info,
        playerRef.current?.getCropRect() ?? null,
        { width: w, height: h },
      );
      setW(next.width);
      setH(next.height);
      playerRef.current?.setCropAspect(next.width, next.height);
    }
    else { const r = aspectToRatio(v, customRatio); if (r && w > 0) setH(linkAspectHeight(w, r)); } // 选比例后按当前宽重算高
  };
  const [crw, crh] = parseCustomRatioParts(customRatio);
  const onCustomRatioW = (v: number) => {
    const s = `${v}:${crh}`;
    setCustomRatio(s);
    const r = aspectToRatio('custom', s);
    if (r) playerRef.current?.setCropAspect(r.aw, r.ah);
  };
  const onCustomRatioH = (v: number) => {
    const s = `${crw}:${v}`;
    setCustomRatio(s);
    const r = aspectToRatio('custom', s);
    if (r) playerRef.current?.setCropAspect(r.aw, r.ah);
  };
  useEffect(() => {
    if (media.info) applyAspect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.info, aspect, customRatio]);
  useEffect(() => {
    if (aspect === 'match' && w > 0 && h > 0) playerRef.current?.setCropAspect(w, h);
  }, [w, h, aspect]);
  // 自由/匹配模式下，所有导出类型都从当前素材初始化输出尺寸
  useEffect(() => {
    if (media.info && (aspect === 'free' || aspect === 'match')) {
      const next = dimensionsForCropAspect(aspect, media.info, null, { width: w, height: h });
      setW(next.width);
      setH(next.height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.info]);

  useEffect(() => {
    setStart('00:00:00.000');
    setEnd('00:00:05.000');
    setHasStart(false);
    setHasEnd(false);
    setLoopSelection(false);
    playerRef.current?.setLoopRange(0, 0);
  }, [media.path]);

  useEffect(() => {
    if (fullMaterialRange || !fixedDur || !hasStart) return;
    const s = parseTime(start);
    if (s == null || fixedVal <= 0) {
      setHasEnd(false);
      return;
    }
    setEnd(formatTime(s + fixedVal));
    setHasEnd(true);
  }, [fixedDur, fixedVal, fullMaterialRange, hasStart, start]);

  useEffect(() => {
    if (loopSelection && rangeValid) {
      playerRef.current?.setLoopRange(startSeconds!, endSeconds!);
    } else {
      playerRef.current?.setLoopRange(0, 0);
    }
  }, [endSeconds, loopSelection, rangeValid, startSeconds]);

  const setStartNow = () => {
    if (fullMaterialRange) return;
    const tm = playerRef.current?.getCurrentTime() ?? 0;
    setStart(formatTime(tm));
    setHasStart(true);
    if (!fixedDur) {
      setHasEnd(false);
      setLoopSelection(false);
    }
  };
  const setEndNow = () => {
    if (fullMaterialRange || !hasStart || fixedDur) return;
    const tm = playerRef.current?.getCurrentTime() ?? 0;
    setEnd(formatTime(tm));
    setHasEnd(true);
  };
  const changeStartInput = (value: string) => {
    if (fullMaterialRange) return;
    setStart(value);
    const valid = parseTime(value) != null;
    setHasStart(valid);
    if (!valid) {
      setHasEnd(false);
      setLoopSelection(false);
    }
  };
  const changeEndInput = (value: string) => {
    if (fullMaterialRange || !hasStart || fixedDur) return;
    setEnd(value);
    setHasEnd(parseTime(value) != null);
  };
  const moveStartMarker = (timeSec: number) => {
    if (fullMaterialRange) return;
    const latestEnd = hasEnd ? parseTime(end) : null;
    const next = !fixedDur && latestEnd != null
      ? Math.min(timeSec, Math.max(0, latestEnd - 0.001))
      : timeSec;
    setStart(formatTime(next));
    setHasStart(true);
  };
  const moveEndMarker = (timeSec: number) => {
    if (fullMaterialRange) return;
    const latestStart = parseTime(start);
    if (fixedDur || latestStart == null) return;
    setEnd(formatTime(Math.max(timeSec, latestStart + 0.001)));
    setHasEnd(true);
  };
  const toggleFullDuration = (enabled: boolean) => {
    setFullDuration(enabled);
    if (enabled) {
      setFixedDur(false);
      setLoopSelection(false);
    }
  };

  const runBatch = (targets: string[]) => {
    if (format === 'clip' && !selectedClipPreset) {
      void t.start(async () => { throw new Error('请先选择一个编码预设'); });
      return;
    }
    if (!rangeValid) {
      void t.start(async () => { throw new Error(rangeHint); });
      return;
    }
    const s = startSeconds!;
    const dur = rangeDuration;
    const crop = playerRef.current?.getCropRect() ?? null;
    const cropDimensions = playerRef.current?.getMediaDimensions() ?? null;
    const clipParams = selectedClipPreset?.params ?? {};
    const segOutFmt = clipParams.container || 'mp4';
    const segVc = clipParams.videoCodec || '';
    const segVp = clipParams.videoProfile || '';
    const segPixFmt = clipParams.pixelFormat || '';
    const segCrf = clipParams.crf ?? 0;
    const segVbr = clipParams.videoBitrate ?? 0;
    const segAc = clipParams.audioCodec || '';
    const segAbr = clipParams.audioBitrate ?? 0;
    t.start(async () => {
      const files = await resolveTaskMediaFiles(fl.resolveLeafPaths, targets, isVideoPath, t.appendLog);
      if (files.length === 0) return;
      let ok = 0;
      let bad = 0;
      const outputs: string[] = [];
      for (let i = 0; i < files.length; i++) {
        if (t.isCancelled()) break;
        const file = files[i];
        t.appendLog(fileLogEvent('file_start', file, i, files.length, 'normal', `等待导出${name}`));
        t.setDetail(`(${i + 1}/${files.length}) ${file.split(/[/\\]/).pop()}`);
        t.setProgress(Math.round((i / files.length) * 100));
        try {
          let exportStart = s;
          let exportDuration = dur;
          if (fullMaterialRange) {
            const fileInfo = file === media.path && media.info
              ? media.info
              : await getVideoInfo(file);
            if (!Number.isFinite(fileInfo.duration) || fileInfo.duration <= 0) {
              throw new Error('无法读取完整素材时长');
            }
            exportStart = 0;
            exportDuration = fileInfo.duration;
          }
          const outputSettings = toOutputSettings(output, presetName);
          const targetCrop = await cropForTarget(file, crop, cropDimensions);
          const outputPath = format === 'gif'
            ? await exportGif(file, exportStart, exportDuration, fps, w, h, gifCompression, targetCrop, outputSettings)
            : format === 'webp'
              ? await exportWebp(file, exportStart, exportDuration, fps, w, h, quality, targetCrop, outputSettings)
              : format === 'sequence'
                ? await exportImageSequence(file, exportStart, exportDuration, fps, w, h, imageFormat, quality, pngCompression, targetCrop, outputSettings)
                : await exportSegment(file, exportStart, exportDuration, fps, w, h, segOutFmt, targetCrop, outputSettings, segVc, segVp, segCrf, segVbr, segPixFmt, segAc, segAbr);
          ok++;
          t.setPass(ok);
          outputs.push(outputPath);
          t.appendLog(`[PASS] ${outputPath}`);
          t.appendLog(fileLogEvent('file_end', file, i, files.length, 'pass', `${name}导出完成`));
        } catch (err: any) {
          bad++;
          t.setFail(bad);
          t.appendLog(`[FAIL] ${file}: ${err?.message || err}`);
          t.appendLog(fileLogEvent('file_end', file, i, files.length, 'fail', `${name}导出失败`));
        }
        if (t.isCancelled()) break;
      }
      if (!t.isCancelled()) t.setProgress(100);
      t.setOutputPaths(outputs);
      if (bad > 0 && ok === 0) throw new Error(`全部失败 (${bad})`);
    });
  };

  const name = format === 'gif' ? 'GIF' : format === 'webp' ? 'WebP' : format === 'sequence' ? '序列帧' : '片段';
  const outputExtension = format === 'clip' ? (selectedClipPreset?.params.container || 'mp4') : format === 'sequence' ? imageFormat : format;
  const clipIsMov = format === 'clip' && !!selectedClipPreset?.params.container?.match(/^mov$/i);
  const clipPresetMissing = format === 'clip' && !selectedClipPreset;
  return (
    <ToolWorkspace
      taskFailure={t.error ? { message: t.error, logs: t.logs, onClose: t.clearError } : undefined}
      params={
        <>
          <PresetManager
            type={format === 'gif' ? 'gif' : format === 'webp' ? 'webp' : format === 'sequence' ? 'sequence' : 'segment'}
            onApply={applyExport}
            initialValues={{ w, h, fps, quality, imageFormat, pngCompression, gifCompression, fullDuration, fixedDur, fixedVal, aspect, customRatio, clipPresetId, ...output }}
            currentParams={{ w, h, fps, quality, imageFormat, pngCompression, gifCompression, fullDuration, fixedDur, fixedVal, aspect, customRatio, clipPresetId, ...output }}
          />
          {media.info && (
            <ui.VideoInfo>
              {media.info.width}×{media.info.height} · {media.info.fps.toFixed(2)}fps · {formatTime(media.info.duration)}
              {media.info.has_alpha ? ' · 透明' : ''}
            </ui.VideoInfo>
          )}
          <ui.ParamGroup title="时间范围">
            {format === 'sequence' && (
              <ui.Checkbox checked={fullDuration} onChange={toggleFullDuration} disabled={t.running}>
                完整素材长度
              </ui.Checkbox>
            )}
            <ui.FieldGrid tight>
              <ui.FieldLabel>起始</ui.FieldLabel>
              <div className="se-time-input">
                <ui.DropInput value={fullMaterialRange ? formatTime(0) : start} ariaLabel="入点时间" disabled={fullMaterialRange} onChange={changeStartInput} />
                <button type="button" disabled={fullMaterialRange} onClick={setStartNow}>当前</button>
              </div>
              <ui.FieldLabel>结束</ui.FieldLabel>
              <div className="se-time-input">
                <ui.DropInput
                  value={fullMaterialRange ? formatTime(media.info?.duration ?? 0) : end}
                  ariaLabel="出点时间"
                  disabled={fullMaterialRange || !hasStart || fixedDur}
                  onChange={changeEndInput}
                />
                <button type="button" disabled={fullMaterialRange || !hasStart || fixedDur} onClick={setEndNow}>当前</button>
              </div>
              <ui.Checkbox checked={fixedDur} onChange={setFixedDur} disabled={fullMaterialRange}>固定时长</ui.Checkbox>
              <ui.NumberField value={fixedVal} min={0.1} max={9999} step={0.1} suffix="s" disabled={fullMaterialRange || isPresetUiFieldDisabled(format === 'clip' ? 'segment' : format, 'fixedVal', { fixedDur, fullDuration })} onChange={setFixedVal} />
            </ui.FieldGrid>
            <div className={`se-range-status${rangeValid ? ' valid' : ''}`}><ui.HintLabel>{rangeHint}</ui.HintLabel></div>
          </ui.ParamGroup>
          <ui.ParamGroup title="选取比例">
            <ui.AnimatedFieldGrid rows={[
              {
                id: 'aspect',
                content: (
                  <>
                    <ui.FieldLabel>比例</ui.FieldLabel>
                    <ui.ComboBox value={aspect} options={CROP_ASPECT_OPTIONS} onChange={onAspectChange} />
                  </>
                ),
              },
              ...(aspect === 'custom' ? [{
                id: 'custom-ratio',
                content: (
                  <>
                    <ui.FieldLabel>宽比</ui.FieldLabel>
                    <ui.IntField value={crw} min={1} max={99} onChange={onCustomRatioW} />
                    <ui.FieldLabel>高比</ui.FieldLabel>
                    <ui.IntField value={crh} min={1} max={99} onChange={onCustomRatioH} />
                  </>
                ),
              }] : []),
            ]} />
            <div className="se-crop-actions">
              <ui.Button
                primary={cropLocked}
                icon={cropLocked ? <IconUnlock size={15} /> : <IconLock size={15} />}
                onClick={() => setCropLocked((locked) => !locked)}
              >
                {cropLocked ? '解锁选区' : '锁定选区'}
              </ui.Button>
              <ui.Button
                disabled={t.running}
                icon={<IconCropClear size={15} />}
                onClick={() => playerRef.current?.clearCrop()}
              >
                清除选区
              </ui.Button>
            </div>
          </ui.ParamGroup>
          <ui.ParamGroup title={`输出参数 (${name})`}>
            <ui.AnimatedFieldGrid tight rows={[
              {
                id: 'resolution',
                content: (
                  <>
                    <ui.FieldLabel>分辨率 (长×宽)</ui.FieldLabel>
                    <div className="se-res-row">
                      <ui.IntField value={w} min={1} max={8192} suffix="px" disabled={isPresetUiFieldDisabled(format === 'clip' ? 'segment' : format, 'w', { aspect })} onChange={onW} />
                      <span className="se-x">×</span>
                      <ui.IntField value={h} min={1} max={8192} suffix="px" disabled={isPresetUiFieldDisabled(format === 'clip' ? 'segment' : format, 'h', { aspect })} onChange={onH} />
                    </div>
                  </>
                ),
              },
              ...(format !== 'clip' ? [{
                id: 'fps',
                content: (
                  <>
                    <ui.FieldLabel>帧率</ui.FieldLabel>
                    <ui.NumberField value={fps} min={format === 'sequence' ? 0.1 : 1} max={format === 'sequence' ? 120 : 60} step={0.1} onChange={setFps} />
                  </>
                ),
              }] : []),
              ...(format === 'gif' ? [{
                id: 'gif-compression',
                content: (
                  <>
                    <ui.FieldLabel>压缩方式</ui.FieldLabel>
                    <ui.ComboBox value={gifCompression} options={GIF_COMPRESSION_OPTIONS} onChange={(value) => setGifCompression(value as GifCompression)} />
                  </>
                ),
              }] : []),
              ...(format === 'webp' ? [{
                id: 'quality',
                content: (
                  <>
                    <ui.FieldLabel>质量</ui.FieldLabel>
                    <ui.IntField value={quality} min={1} max={100} onChange={setQuality} />
                  </>
                ),
              }] : []),
              ...(format === 'sequence' ? [{
                id: 'image-format',
                content: (
                  <>
                    <ui.FieldLabel>图片格式</ui.FieldLabel>
                    <ui.ComboBox value={imageFormat} options={IMAGE_SEQUENCE_FORMAT_OPTIONS} onChange={setImageFormat} />
                  </>
                ),
              }] : []),
              ...(format === 'sequence' && ['jpg', 'webp'].includes(imageFormat) ? [{
                id: 'quality',
                content: (
                  <>
                    <ui.FieldLabel>质量</ui.FieldLabel>
                    <ui.IntField value={quality} min={1} max={100} onChange={setQuality} />
                  </>
                ),
              }] : []),
              ...(format === 'sequence' && imageFormat === 'png' ? [{
                id: 'png-compression',
                content: (
                  <>
                    <ui.FieldLabel>PNG 压缩级别</ui.FieldLabel>
                    <ui.IntField value={pngCompression} min={0} max={9} onChange={setPngCompression} />
                  </>
                ),
              }] : []),
              ...(format === 'clip' ? [{
                id: 'clip-preset',
                content: (
                  <>
                    <ui.FieldLabel>编码预设</ui.FieldLabel>
                    <ui.ComboBox
                      value={clipPresetId}
                      options={encPresets.presets.map((p) => ({
                        label: p.name,
                        value: p.id,
                        tags: p.params.container ? [String(p.params.container).toUpperCase()] : undefined,
                      }))}
                      onChange={(v) => setClipPresetId(v)}
                      disabled={encPresets.presets.length === 0}
                      placeholder={encPresets.presets.length ? '请选择' : '没有可用的编码预设'}
                    />
                  </>
                ),
              }] : []),
            ]} />
          </ui.ParamGroup>
          <OutputLocationGroup
            value={output}
            presetName={presetName}
            extension={outputExtension}
            defaultSuffix={format === 'clip' ? '_clip' : format === 'sequence' ? '_frames' : ''}
            onChange={setOutputField}
            disabled={t.running}
          />
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedCount}
          totalCount={fl.totalCount}
          onSelected={() => runBatch(fl.selectedPaths)}
          onAll={() => runBatch(fl.allPaths)}
          onStop={t.cancel}
          onOpenOutput={t.outputPaths.length > 0 ? t.openOutputs : undefined}
          disabled={!rangeValid || clipPresetMissing}
          disabledTitle={clipPresetMissing ? '请先创建并选择编码预设' : rangeHint}
        />
      }
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} running={t.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={t.logs.length} running={t.running} />}
      result={(
        <ResultViewContent
          value={resultView}
          logs={t.logs}
          preview={(
            <VideoPlayer
              ref={playerRef}
              src={media.src}
              filePath={media.path}
              alphaPreview={clipIsMov}
              cropEnabled
              cropLocked={cropLocked}
              controlsDisabled={t.running}
              rangeStart={startSeconds}
              rangeEnd={endSeconds}
              onRangeStartChange={fullMaterialRange ? undefined : moveStartMarker}
              onRangeEndChange={fullMaterialRange || fixedDur ? undefined : moveEndMarker}
              rangeLooping={loopSelection}
              onRangeLoopingChange={setLoopSelection}
              onCropChange={onCrop}
            />
          )}
        />
      )}
    />
  );
}
