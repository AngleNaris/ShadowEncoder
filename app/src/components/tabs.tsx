// ShadowEncoder 8 个功能标签页 —— 共享素材列表 + 处理选中 / 批量处理
import React, { useRef, useState, useEffect, useCallback, ReactNode } from 'react';
import * as ui from './ui';
import { ResizeHandle } from './ResizeHandle';
import VideoPlayer, { VideoPlayerHandle, CropRectResult } from './VideoPlayer';
import {
  getVideoInfo, composeAlpha, screenshotFrame, exportGif, exportWebp, exportSegment,
  transcode, mixAudio, checkVideos, subscribeProgress, subscribeLog, mediaPreviewUrl,
  formatTime, parseTime,
  type VideoInfo, type CropRect,
} from '../lib/ffmpeg';
import { PresetManager, PresetManageDialog, usePresets, type PresetBuilderCtx, CROP_ASPECT_OPTIONS, aspectToRatio, parseCustomRatioParts, linkAspectHeight, linkAspectWidth } from './presetSystem';

// 预设构建器 —— 流程图式一次性展示可配置项
// 设计参考 Shutter Encoder 的"函数 = 输出格式"（高自由度），但改用分组卡片避免其信息过载；
// 每个视频/音频编码器都带兼容性约束（封装白名单）与编码器专属"规格/Profile"（如 ProRes 的 Proxy/422HQ/4444）。
const CONTAINER_OPTIONS = [
  { label: 'MP4 (mp4)', value: 'mp4' },
  { label: 'MKV (mkv)', value: 'mkv' },
  { label: 'MOV (QuickTime, mov)', value: 'mov' },
  { label: 'WebM (webm)', value: 'webm' },
  { label: 'AVI (avi)', value: 'avi' },
  { label: 'FLV (flv)', value: 'flv' },
  { label: 'MPEG-TS (ts)', value: 'ts' },
  { label: 'MPEG-PS (mpeg)', value: 'mpeg' },
  { label: 'WMV (wmv)', value: 'wmv' },
  { label: 'OGV (ogv)', value: 'ogv' },
  { label: '3GP (3gp)', value: '3gp' },
  { label: 'ASF (asf)', value: 'asf' },
  { label: 'M4V (m4v)', value: 'm4v' },
  { label: 'GIF (gif)', value: 'gif' },
];

const VIDEO_CODEC_OPTIONS = [
  { label: '复制视频流 · copy（仅换封装 / 改音频）', value: 'copy' },
  { label: 'H.264 · libx264', value: 'libx264' },
  { label: 'H.265/HEVC · libx265', value: 'libx265' },
  { label: 'H.264 · h264_nvenc (NVIDIA)', value: 'h264_nvenc' },
  { label: 'H.265/HEVC · hevc_nvenc (NVIDIA)', value: 'hevc_nvenc' },
  { label: 'H.264 · h264_amf (AMD)', value: 'h264_amf' },
  { label: 'H.265/HEVC · hevc_amf (AMD)', value: 'hevc_amf' },
  { label: 'H.264 · h264_qsv (Intel)', value: 'h264_qsv' },
  { label: 'H.265/HEVC · hevc_qsv (Intel)', value: 'hevc_qsv' },
  { label: 'AV1 · libsvtav1', value: 'libsvtav1' },
  { label: 'AV1 · libaom-av1', value: 'libaom-av1' },
  { label: 'AV1 · av1_nvenc (NVIDIA)', value: 'av1_nvenc' },
  { label: 'AV1 · av1_amf (AMD)', value: 'av1_amf' },
  { label: 'AV1 · av1_qsv (Intel)', value: 'av1_qsv' },
  { label: 'VP8 · libvpx', value: 'libvpx' },
  { label: 'VP9 · libvpx-vp9', value: 'libvpx-vp9' },
  { label: 'MPEG-4 Part2 · mpeg4', value: 'mpeg4' },
  { label: 'MPEG-2 · mpeg2video', value: 'mpeg2video' },
  { label: 'Apple ProRes · prores', value: 'prores' },
  { label: 'Avid DNxHR · dnxhd', value: 'dnxhd' },
  { label: 'JPEG · mjpeg', value: 'mjpeg' },
  { label: '无损 · ffv1', value: 'ffv1' },
  { label: 'GIF (动图)', value: 'gif' },
];

const X264_PRESET_OPTIONS = [
  { label: 'ultrafast', value: 'ultrafast' },
  { label: 'superfast', value: 'superfast' },
  { label: 'veryfast', value: 'veryfast' },
  { label: 'faster', value: 'faster' },
  { label: 'fast', value: 'fast' },
  { label: 'medium (默认)', value: 'medium' },
  { label: 'slow', value: 'slow' },
  { label: 'slower', value: 'slower' },
  { label: 'veryslow', value: 'veryslow' },
];

const TUNE_OPTIONS_FULL = [
  { label: '无 (none)', value: 'none' },
  { label: 'film · 实拍电影', value: 'film' },
  { label: 'animation · 动画', value: 'animation' },
  { label: 'grain · 胶片颗粒', value: 'grain' },
  { label: 'stillimage · 静帧', value: 'stillimage' },
  { label: 'fastdecode · 快速解码', value: 'fastdecode' },
  { label: 'zerolatency · 零延迟', value: 'zerolatency' },
];

const PIXEL_FORMAT_OPTIONS = [
  { label: 'yuv420p (最兼容)', value: 'yuv420p' },
  { label: 'yuv422p', value: 'yuv422p' },
  { label: 'yuv444p', value: 'yuv444p' },
  { label: 'yuv420p10le (10-bit)', value: 'yuv420p10le' },
  { label: 'yuv422p10le (10-bit)', value: 'yuv422p10le' },
  { label: 'yuv444p10le (10-bit)', value: 'yuv444p10le' },
  { label: 'nv12', value: 'nv12' },
  { label: 'rgb24', value: 'rgb24' },
  { label: 'gbrp', value: 'gbrp' },
];

const AUDIO_CODEC_OPTIONS = [
  { label: '复制音频流 · copy', value: 'copy' },
  { label: 'AAC · aac', value: 'aac' },
  { label: 'MP3 · libmp3lame', value: 'libmp3lame' },
  { label: 'Opus · libopus', value: 'libopus' },
  { label: 'Vorbis · libvorbis', value: 'libvorbis' },
  { label: 'FLAC · flac', value: 'flac' },
  { label: 'WAV 16-bit · pcm_s16le', value: 'pcm_s16le' },
  { label: 'WAV 24-bit · pcm_s24le', value: 'pcm_s24le' },
  { label: 'ALAC · alac', value: 'alac' },
  { label: 'AC-3 · ac3', value: 'ac3' },
  { label: 'E-AC-3 · eac3', value: 'eac3' },
  { label: 'WMA · wmav2', value: 'wmav2' },
];

const AUDIO_PROFILE_OPTIONS = [
  { label: 'LC', value: 'lc' },
  { label: 'HE-AAC', value: 'he-aac' },
  { label: 'HE-AAC v2', value: 'hev2-aac' },
];

const SAMPLE_RATE_OPTIONS = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000].map((r) => ({ label: `${r} Hz`, value: r }));

const CHANNEL_OPTIONS = [
  { label: '单声道 (1)', value: 1 },
  { label: '立体声 (2)', value: 2 },
  { label: '5.1 (6)', value: 6 },
];

const RATE_MODE_OPTIONS = [
  { label: '质量优先 · CRF', value: 'crf' },
  { label: '目标码率', value: 'bitrate' },
  { label: '目标文件体积', value: 'filesize' },
];

// 视频编码器元信息：支持的封装白名单、编码器专属"规格/Profile"、以及是否支持 质量/速度/调优
type VideoMeta = {
  label: string;
  containers: string[];
  profiles: { value: string; label: string }[];
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
      { value: 'high', label: 'High (高，最通用)' },
      { value: 'main', label: 'Main' },
      { value: 'baseline', label: 'Baseline (老旧设备)' },
      { value: 'high10', label: 'High 10 (10-bit)' },
      { value: 'high422', label: 'High 4:2:2' },
      { value: 'high444', label: 'High 4:4:4' },
    ],
    quality: 'crf', speed: true, tune: true, defaultPixFmt: 'yuv420p',
  },
  libx265: {
    label: 'H.265/HEVC', containers: ['mp4', 'mkv', 'mov', 'ts', 'm4v', 'avi'],
    profiles: [
      { value: 'main', label: 'Main' },
      { value: 'main10', label: 'Main 10 (10-bit, 最通用)' },
      { value: 'main422-10', label: 'Main 4:2:2 10-bit' },
      { value: 'main444-10', label: 'Main 4:4:4 10-bit' },
      { value: 'main12', label: 'Main 12 (12-bit)' },
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
      { value: 'proxy', label: 'Proxy (代理, 最低码率)' },
      { value: 'lt', label: 'LT (长GOP 轻量)' },
      { value: '422', label: '422 (标准)' },
      { value: '422hq', label: '422 HQ (高质量)' },
      { value: '4444', label: '4444 (含 Alpha 通道)' },
      { value: '4444xq', label: '4444 XQ (极致质量)' },
    ],
    quality: null, speed: false, tune: false, defaultPixFmt: 'yuv422p10le',
  },
  dnxhd: {
    label: 'Avid DNxHR', containers: ['mov', 'mkv'],
    profiles: [
      { value: 'dnxhr_lb', label: 'LB (低码率)' },
      { value: 'dnxhr_sq', label: 'SQ (标准质量)' },
      { value: 'dnxhr_hq', label: 'HQ (高质量)' },
      { value: 'dnxhr_hqx', label: 'HQX (超高质 10/12-bit)' },
    ],
    quality: null, speed: false, tune: false, defaultPixFmt: 'yuv422p',
  },
  mjpeg: { label: 'MJPEG', containers: ['mov', 'avi', 'mkv'], profiles: [], quality: null, speed: false, tune: false, defaultPixFmt: 'yuvj420p' },
  ffv1: { label: 'FFV1 (无损)', containers: ['mkv', 'avi', 'mov'], profiles: [], quality: null, speed: false, tune: false, defaultPixFmt: 'yuv420p10le' },
  gif: { label: 'GIF', containers: ['gif'], profiles: [], quality: null, speed: false, tune: false, defaultPixFmt: null },
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
interface PresetBuilderProps { ctx: PresetBuilderCtx; }

// 根据视频编码器筛选可用封装（级联：前面选了编码器，后面只列兼容封装）
function compatibleContainers(videoCodec: string) {
  const m = VIDEO_META[videoCodec];
  if (!m || !m.containers) return CONTAINER_OPTIONS;
  return CONTAINER_OPTIONS.filter((o) => m.containers.includes(o.value));
}
// 根据封装筛选可用音频编码器（copy 不限制，始终可选）
function compatibleAudioCodecs(container: string) {
  return AUDIO_CODEC_OPTIONS.filter((o) => {
    const a = AUDIO_META[o.value];
    return !a || !a.containers || a.containers.includes(container);
  });
}

const DEFAULT_ENCODE_FORM = {
  name: '',
  container: 'mp4',
  videoCodec: 'libx264',
  videoProfile: 'high',
  crf: 23,
  preset: 'medium',
  tune: 'none',
  pixelFormat: 'yuv420p',
  scaleW: 0,
  scaleH: 0,
  fps: 25,
  keepRes: true,
  loudnorm: true,
  audioOnly: false,
  audioCodec: 'aac',
  audioProfile: 'lc',
  audioBitrate: 192,
  videoBitrate: 0,
  audioSampleRate: 48000,
  audioChannels: 2,
  unsharp: 2,
  denoise: 1,
  style: 2,
  rateMode: 'crf' as 'crf' | 'bitrate' | 'filesize',
  targetFileSizeMb: 0,
};

// 预设创建的初始表单：全部空白（不预选任何项）；空白项在套用预设时被忽略、保留运行时默认值
const BLANK_ENCODE_FORM = {
  name: '',
  container: '',
  videoCodec: '',
  videoProfile: '',
  crf: 23,
  preset: '',
  tune: '',
  pixelFormat: '',
  scaleW: 0,
  scaleH: 0,
  fps: 0,
  keepRes: false,
  loudnorm: false,
  audioOnly: false,
  audioCodec: '',
  audioProfile: '',
  audioBitrate: 0,
  videoBitrate: 0,
  audioSampleRate: '' as any,
  audioChannels: '' as any,
  unsharp: '' as any,
  denoise: '' as any,
  style: '' as any,
  rateMode: '' as any,
  targetFileSizeMb: 0,
};

// 把当前表单整理成分组（按标签页）的「标签 / 值」列表，供右侧常驻汇总面板展示
type SumGroup = { title: string; items: [string, string][] };
function summarizeEncode(f: any): SumGroup[] {
  const dash = '—';
  const isCopy = f.videoCodec === 'copy';
  const vLabel = f.videoCodec
    ? (VIDEO_CODEC_OPTIONS.find((o) => o.value === f.videoCodec)?.label ?? f.videoCodec)
    : dash;
  const aLabel = f.audioCodec
    ? (AUDIO_CODEC_OPTIONS.find((o) => o.value === f.audioCodec)?.label ?? f.audioCodec)
    : dash;
  const unsharpLabel = UNSHARP_OPTIONS.find((o) => o.value === f.unsharp)?.label ?? dash;
  const denoiseLabel = DENOISE_OPTIONS.find((o) => o.value === f.denoise)?.label ?? dash;
  const styleLabel = TUNE_OPTIONS.find((o) => o.value === f.style)?.label ?? dash;
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
  } else {
    quality = meta?.quality
      ? `${meta.quality === 'cq' ? 'CQ' : 'CRF'} ${f.crf}`
      : dash;
    vbr = f.videoBitrate > 0 ? `${f.videoBitrate / 1000} Mbps` : (meta?.quality ? 'CRF / 默认' : dash);
  }
  const res = isCopy
    ? '跟随源（视频流复制）'
    : f.keepRes
      ? '原始分辨率'
      : (f.scaleW > 0 && f.scaleH > 0 ? `${f.scaleW} × ${f.scaleH}` : dash);
  const fpsText = isCopy ? '跟随源' : (f.fps > 0 ? `${f.fps} fps` : '原始帧率');
  const chMap: Record<number, string> = { 1: '单声道', 2: '立体声', 6: '5.1' };
  let audio: string;
  if (f.videoCodec === 'gif') audio = 'GIF（无音频轨）';
  else if (f.audioOnly) audio = '仅音频（视频流复制）';
  else if (!f.audioCodec) audio = dash;
  else if (f.audioCodec === 'copy') audio = '复制音频流';
  else {
    const parts = [aLabel];
    if (f.audioBitrate > 0) parts.push(`${f.audioBitrate}k`);
    if (f.audioSampleRate) parts.push(`${f.audioSampleRate}Hz`);
    if (f.audioChannels) parts.push(`${chMap[f.audioChannels] ?? f.audioChannels}声道`);
    audio = parts.join(' · ');
  }
  const videoItems: [string, string][] = isCopy
    ? [['视频编码器', '复制视频流 (copy)'], ['说明', '不重新编码，仅换封装 / 改音频']]
    : [
        ['视频编码器', vLabel],
        ['Profile', f.videoProfile || dash],
        ['质量', quality],
        ['编码速度', f.preset || dash],
        ['调优', f.tune ? (f.tune === 'none' ? '无' : f.tune) : dash],
        ['像素格式', f.pixelFormat || dash],
        ['视频码率', vbr],
      ];
  return [
    { title: '视频编码', items: videoItems },
    {
      title: '封装格式',
      items: [['封装格式', f.container ? String(f.container).toUpperCase() : dash]],
    },
    {
      title: '分辨率与帧率',
      items: [['分辨率', res], ['帧率', fpsText]],
    },
    {
      title: '音频',
      items: [['音频', audio]],
    },
    {
      title: '后期处理',
      items: [
        ['锐化', isCopy ? '不适用（视频流复制）' : unsharpLabel],
        ['降噪', isCopy ? '不适用（视频流复制）' : denoiseLabel],
        ['风格', isCopy ? '不适用（视频流复制）' : styleLabel],
        ['音频标准化', f.loudnorm ? '开启' : '关闭'],
      ],
    },
  ];
}

function PresetBuilder({ ctx }: PresetBuilderProps) {
  // 初始全部空白：不预选任何项（空白项在套用时忽略，走运行时默认）
  const [form, setForm] = useState(() => ({ ...BLANK_ENCODE_FORM }));
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const [editingId, setEditingId] = useState<string | null>(null);

  const vMeta = VIDEO_META[form.videoCodec];
  const isGif = form.videoCodec === 'gif';
  const isCopy = form.videoCodec === 'copy';
  const isAudioCopy = form.audioCodec === 'copy';
  const summary = summarizeEncode(form);

  // 后续下拉框只列出与前面选择兼容的选项（级联筛选，不再展示"不兼容"）
  const containerOptions = compatibleContainers(form.videoCodec);
  const audioOptions = compatibleAudioCodecs(form.container);

  // 选了视频编码器 → 已选封装若不兼容则回退（未选封装保持空白，不强行预选）
  const onVideoCodecChange = (vc: string) => {
    const m = VIDEO_META[vc];
    setForm((f) => {
      const stillOk = f.container && compatibleContainers(vc).some((o) => o.value === f.container);
      return {
        ...f,
        videoCodec: vc,
        container: f.container ? (stillOk ? f.container : compatibleContainers(vc)[0]?.value ?? '') : '',
        videoProfile: m && m.profiles.length ? m.profiles[0].value : '',
        pixelFormat: m && m.defaultPixFmt ? m.defaultPixFmt : f.pixelFormat,
      };
    });
  };

  // 改了封装 → 已选音频编码器若不兼容则清空（保持空白语义，不替用户预选）
  const onContainerChange = (c: string) => {
    setForm((f) => {
      const ok = !f.audioCodec || compatibleAudioCodecs(c).some((o) => o.value === f.audioCodec);
      return { ...f, container: c, audioCodec: ok ? f.audioCodec : '' };
    });
  };

  const qualityLabel = vMeta?.quality === 'cq' ? '质量 (CQ)' : '质量 (CRF)';

  // 常用分辨率 / 帧率 / 视频码率 / 音频码率 预设：
  // 统一排序 —— 第一项为「原始 / 复制」，最后一项为「自定义」；中间为常用数值。
  const RESOLUTION_PRESETS = [
    { label: '原始分辨率', value: 'orig' },
    { label: '1920 × 1080 (1080p)', value: '1920x1080' },
    { label: '1280 × 720 (720p)', value: '1280x720' },
    { label: '3840 × 2160 (4K)', value: '3840x2160' },
    { label: '2560 × 1440 (2K)', value: '2560x1440' },
    { label: '1080 × 1920 (竖屏 1080p)', value: '1080x1920' },
    { label: '720 × 1280 (竖屏 720p)', value: '720x1280' },
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
    if (raw === 'orig') { set('scaleW', 0); set('scaleH', 0); set('keepRes', true); }
    else if (raw === '__custom__') { set('keepRes', false); }
    else { const [w, h] = raw.split('x').map(Number); set('scaleW', w); set('scaleH', h); set('keepRes', false); }
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
  const TABS = ['视频编码', '封装格式', '分辨率与帧率', '音频', '后期处理'];

  // 预设增删改查（配合最左侧列表）
  const resetSels = () => { setResSel(''); setFpsSel(''); setVbrSel(''); setAbrSel(''); };
  const onNew = () => { setEditingId(null); setForm({ ...BLANK_ENCODE_FORM }); resetSels(); setTab(0); };
  const onSelectPreset = (id: string) => {
    const p = ctx.presets.find((x) => x.id === id);
    if (!p) return;
    setEditingId(id);
    setForm({ ...BLANK_ENCODE_FORM, ...p.params, name: p.name });
    // 编辑已有预设：以「自定义」模式载入实际数值，右侧手动输入可编辑
    setResSel(p.params.keepRes ? 'orig' : '__custom__');
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

  if (!ctx.isOpen) return null;
  return (
    <PresetManageDialog
      title="管理转码预设"
      compact={false}
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
              <>
                <ui.FieldGrid>
                  <ui.FieldLabel>视频编码器</ui.FieldLabel>
                  <ui.ComboBox value={form.videoCodec} options={VIDEO_CODEC_OPTIONS} onChange={onVideoCodecChange} />
                  {vMeta && vMeta.profiles.length > 0 && (
                    <>
                      <ui.FieldLabel>编码规格 / Profile</ui.FieldLabel>
                      <ui.ComboBox value={form.videoProfile} options={vMeta.profiles} onChange={(v) => set('videoProfile', v)} />
                    </>
                  )}
                  {!isCopy && (
                    <>
                      <ui.FieldLabel>码率控制</ui.FieldLabel>
                      <ui.ComboBox value={form.rateMode || 'crf'} options={RATE_MODE_OPTIONS} onChange={(v) => set('rateMode', v)} />
                      {(form.rateMode === 'crf' || !form.rateMode) && vMeta && vMeta.quality && (
                        <>
                          <ui.FieldLabel>{qualityLabel}</ui.FieldLabel>
                          <ui.NumberField value={form.crf} min={0} max={51} step={1} onChange={(v) => set('crf', v)} />
                        </>
                      )}
                      {form.rateMode === 'bitrate' && (
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
                      )}
                      {form.rateMode === 'filesize' && (
                        <>
                          <ui.FieldLabel>目标文件体积</ui.FieldLabel>
                          <ui.NumberField value={form.targetFileSizeMb || 0} min={0} max={99999} step={1} decimals={0} suffix="MB" onChange={(v) => set('targetFileSizeMb', v)} />
                        </>
                      )}
                    </>
                  )}
                  {vMeta && vMeta.speed && (
                    <>
                      <ui.FieldLabel>编码速度</ui.FieldLabel>
                      <ui.ComboBox value={form.preset} options={X264_PRESET_OPTIONS} onChange={(v) => set('preset', v)} />
                    </>
                  )}
                  {vMeta && vMeta.tune && (
                    <>
                      <ui.FieldLabel>调优 (tune)</ui.FieldLabel>
                      <ui.ComboBox value={form.tune} options={TUNE_OPTIONS_FULL} onChange={(v) => set('tune', v)} />
                    </>
                  )}
                  {!isCopy && (
                    <>
                      <ui.FieldLabel>像素格式</ui.FieldLabel>
                      <ui.ComboBox value={form.pixelFormat} options={PIXEL_FORMAT_OPTIONS} onChange={(v) => set('pixelFormat', v)} />
                    </>
                  )}
                </ui.FieldGrid>
                {isCopy && <ui.HintLabel>视频流将直接复制、不重新编码；仅可更改封装格式与音频参数。</ui.HintLabel>}
              </>
            )}

            {tab === 1 && (
              <ui.FieldGrid>
                <ui.FieldLabel>封装格式</ui.FieldLabel>
                <ui.ComboBox value={form.container} options={containerOptions} onChange={onContainerChange} />
              </ui.FieldGrid>
            )}

            {tab === 2 && (
              isCopy ? (
                <ui.HintLabel>视频流复制模式下无法缩放或更改帧率，输出跟随源视频。</ui.HintLabel>
              ) : (
                <ui.FieldGrid>
                  <ui.FieldLabel>分辨率</ui.FieldLabel>
                  <ui.ComboBox value={resSel} options={RESOLUTION_PRESETS} onChange={onResSel} />
                  <ui.FieldLabel>自定义分辨率</ui.FieldLabel>
                  <div className="se-res-row">
                    <ui.IntField value={form.scaleW} min={0} max={8192} suffix="px" disabled={resManualDisabled} onChange={(v) => set('scaleW', v)} />
                    <span className="se-x">×</span>
                    <ui.IntField value={form.scaleH} min={0} max={8192} suffix="px" disabled={resManualDisabled} onChange={(v) => set('scaleH', v)} />
                  </div>
                  <ui.FieldLabel>帧率</ui.FieldLabel>
                  <div className="se-combo-num">
                    <ui.ComboBox value={fpsSel} options={FPS_PRESETS} onChange={onFpsSel} />
                    <ui.NumberField value={form.fps} min={0} max={120} step={1} decimals={0} suffix="fps" disabled={fpsManualDisabled} onChange={(v) => set('fps', v)} />
                  </div>
                </ui.FieldGrid>
              )
            )}

            {tab === 3 && (
              isGif ? (
                <ui.HintLabel>GIF 不含音频轨，音频设置将被忽略。</ui.HintLabel>
              ) : (
                <ui.FieldGrid>
                  <ui.FieldLabel>音频编码器</ui.FieldLabel>
                  <ui.ComboBox value={form.audioCodec} options={audioOptions} onChange={(v) => set('audioCodec', v)} />
                  {form.audioCodec === 'aac' && (
                    <>
                      <ui.FieldLabel>AAC 规格</ui.FieldLabel>
                      <ui.ComboBox value={form.audioProfile} options={AUDIO_PROFILE_OPTIONS} onChange={(v) => set('audioProfile', v)} />
                    </>
                  )}
                  <ui.FieldLabel>音频码率</ui.FieldLabel>
                  <div className="se-combo-num">
                    <ui.ComboBox value={abrSel} options={AUDIO_BITRATE_PRESETS} onChange={onAbrSel} disabled={isAudioCopy} />
                    <ui.NumberField value={form.audioBitrate} min={0} max={640} step={8} decimals={0} suffix="kbps" disabled={isAudioCopy || abrManualDisabled} onChange={(v) => set('audioBitrate', v)} />
                  </div>
                  <ui.FieldLabel>采样率</ui.FieldLabel>
                  <ui.ComboBox value={form.audioSampleRate} options={SAMPLE_RATE_OPTIONS} onChange={(v) => set('audioSampleRate', v)} disabled={isAudioCopy} />
                  <ui.FieldLabel>声道</ui.FieldLabel>
                  <ui.ComboBox value={form.audioChannels} options={CHANNEL_OPTIONS} onChange={(v) => set('audioChannels', v)} disabled={isAudioCopy} />
                </ui.FieldGrid>
              )
            )}

            {tab === 4 && (
              <>
                {!isCopy && (
                  <ui.FieldGrid>
                    <ui.FieldLabel>锐化</ui.FieldLabel>
                    <ui.ComboBox value={form.unsharp} options={UNSHARP_OPTIONS} onChange={(v) => set('unsharp', v)} />
                    <ui.FieldLabel>降噪</ui.FieldLabel>
                    <ui.ComboBox value={form.denoise} options={DENOISE_OPTIONS} onChange={(v) => set('denoise', v)} />
                    <ui.FieldLabel>风格</ui.FieldLabel>
                    <ui.ComboBox value={form.style} options={TUNE_OPTIONS} onChange={(v) => set('style', v)} />
                  </ui.FieldGrid>
                )}
                {isCopy && <ui.HintLabel>视频流复制模式下滤镜（锐化 / 降噪 / 风格）不可用。</ui.HintLabel>}
                <ui.Checkbox checked={form.loudnorm} onChange={(v) => set('loudnorm', v)}>启用音频标准化</ui.Checkbox>
              </>
            )}
            </div>
            <aside className="se-preset-summary">
              <div className="se-preset-summary-head">已选参数</div>
              {summary.map((g) => (
                <div className="se-sum-group" key={g.title}>
                  <div className="se-sum-group-title">{g.title}</div>
                  <div className="se-sum-list">
                    {g.items.map(([label, val]) => (
                      <div className="se-sum-item" key={label}>
                        <span className="se-sum-label">{label}</span>
                        <span className={`se-sum-val${val && val !== '—' ? '' : ' is-empty'}`}>{val}</span>
                      </div>
                    ))}
                  </div>
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
  const isCopy = form.videoCodec === 'copy';
  const isGif = form.videoCodec === 'gif';
  const isAudioCopy = form.audioCodec === 'copy';
  const containerOptions = compatibleContainers(form.videoCodec);
  const audioOptions = compatibleAudioCodecs(form.container);
  const qualityLabel = vMeta?.quality === 'cq' ? '质量 (CQ)' : '质量 (CRF)';

  const onVideoCodecChange = (vc: string) => {
    const m = VIDEO_META[vc];
    const stillOk = form.container && compatibleContainers(vc).some((o) => o.value === form.container);
    set('videoCodec', vc);
    set('container', form.container ? (stillOk ? form.container : compatibleContainers(vc)[0]?.value ?? '') : '');
    set('videoProfile', m && m.profiles.length ? m.profiles[0].value : '');
    set('pixelFormat', m && m.defaultPixFmt ? m.defaultPixFmt : form.pixelFormat);
  };
  const onContainerChange = (c: string) => {
    const ok = !form.audioCodec || compatibleAudioCodecs(c).some((o) => o.value === form.audioCodec);
    set('container', c);
    set('audioCodec', ok ? form.audioCodec : '');
  };

  return (
    <>
      <ui.ParamGroup title="视频编码">
        <ui.FieldGrid>
          <ui.FieldLabel>视频编码器</ui.FieldLabel>
          <ui.ComboBox value={form.videoCodec} options={VIDEO_CODEC_OPTIONS} onChange={onVideoCodecChange} />
          {vMeta && vMeta.profiles.length > 0 && (
            <>
              <ui.FieldLabel>编码规格 / Profile</ui.FieldLabel>
              <ui.ComboBox value={form.videoProfile} options={vMeta.profiles} onChange={(v) => set('videoProfile', v)} />
            </>
          )}
          {!isCopy && (
            <>
              <ui.FieldLabel>码率控制</ui.FieldLabel>
              <ui.ComboBox value={form.rateMode || 'crf'} options={RATE_MODE_OPTIONS} onChange={(v) => set('rateMode', v)} />
              {(form.rateMode === 'crf' || !form.rateMode) && vMeta && vMeta.quality && (
                <>
                  <ui.FieldLabel>{qualityLabel}</ui.FieldLabel>
                  <ui.NumberField value={form.crf} min={0} max={51} step={1} onChange={(v) => set('crf', v)} />
                </>
              )}
              {form.rateMode === 'bitrate' && (
                <>
                  <ui.FieldLabel>视频码率</ui.FieldLabel>
                  <ui.NumberField value={form.videoBitrate / 1000} min={0} max={100} step={0.5} decimals={1} suffix="Mbps" onChange={(v) => set('videoBitrate', Math.round(v * 1000))} />
                </>
              )}
              {form.rateMode === 'filesize' && (
                <>
                  <ui.FieldLabel>目标文件体积</ui.FieldLabel>
                  <ui.NumberField value={form.targetFileSizeMb || 0} min={0} max={99999} step={1} decimals={0} suffix="MB" onChange={(v) => set('targetFileSizeMb', v)} />
                </>
              )}
            </>
          )}
          {vMeta && vMeta.speed && (
            <>
              <ui.FieldLabel>编码速度</ui.FieldLabel>
              <ui.ComboBox value={form.preset} options={X264_PRESET_OPTIONS} onChange={(v) => set('preset', v)} />
            </>
          )}
          {vMeta && vMeta.tune && (
            <>
              <ui.FieldLabel>调优 (tune)</ui.FieldLabel>
              <ui.ComboBox value={form.tune} options={TUNE_OPTIONS_FULL} onChange={(v) => set('tune', v)} />
            </>
          )}
          {!isCopy && (
            <>
              <ui.FieldLabel>像素格式</ui.FieldLabel>
              <ui.ComboBox value={form.pixelFormat} options={PIXEL_FORMAT_OPTIONS} onChange={(v) => set('pixelFormat', v)} />
            </>
          )}
        </ui.FieldGrid>
        {isCopy && <ui.HintLabel>视频流将直接复制、不重新编码；仅可更改封装格式与音频参数。</ui.HintLabel>}
      </ui.ParamGroup>

      <ui.ParamGroup title="封装格式">
        <ui.FieldGrid>
          <ui.FieldLabel>封装格式</ui.FieldLabel>
          <ui.ComboBox value={form.container} options={containerOptions} onChange={onContainerChange} />
        </ui.FieldGrid>
      </ui.ParamGroup>

      <ui.ParamGroup title="分辨率与帧率">
        {isCopy ? (
          <ui.HintLabel>视频流复制模式下无法缩放或更改帧率，输出跟随源视频。</ui.HintLabel>
        ) : (
          <ui.FieldGrid>
            <ui.FieldLabel>分辨率 (宽×高)</ui.FieldLabel>
            <div className="se-res-row">
              <ui.IntField value={form.scaleW} min={0} max={8192} suffix="px" onChange={(v) => set('scaleW', v)} />
              <span className="se-x">×</span>
              <ui.IntField value={form.scaleH} min={0} max={8192} suffix="px" onChange={(v) => set('scaleH', v)} />
            </div>
            <ui.FieldLabel>帧率</ui.FieldLabel>
            <ui.NumberField value={form.fps} min={0} max={120} step={1} decimals={0} suffix="fps" onChange={(v) => set('fps', v)} />
          </ui.FieldGrid>
        )}
      </ui.ParamGroup>

      <ui.ParamGroup title="音频">
        {isGif ? (
          <ui.HintLabel>GIF 不含音频轨，音频设置将被忽略。</ui.HintLabel>
        ) : (
          <ui.FieldGrid>
            <ui.FieldLabel>音频编码器</ui.FieldLabel>
            <ui.ComboBox value={form.audioCodec} options={audioOptions} onChange={(v) => set('audioCodec', v)} />
            {form.audioCodec === 'aac' && (
              <>
                <ui.FieldLabel>AAC 规格</ui.FieldLabel>
                <ui.ComboBox value={form.audioProfile} options={AUDIO_PROFILE_OPTIONS} onChange={(v) => set('audioProfile', v)} />
              </>
            )}
            <ui.FieldLabel>音频码率</ui.FieldLabel>
            <ui.NumberField value={form.audioBitrate} min={0} max={640} step={8} decimals={0} suffix="kbps" disabled={isAudioCopy} onChange={(v) => set('audioBitrate', v)} />
            <ui.FieldLabel>采样率</ui.FieldLabel>
            <ui.ComboBox value={form.audioSampleRate} options={SAMPLE_RATE_OPTIONS} onChange={(v) => set('audioSampleRate', v)} disabled={isAudioCopy} />
            <ui.FieldLabel>声道</ui.FieldLabel>
            <ui.ComboBox value={form.audioChannels} options={CHANNEL_OPTIONS} onChange={(v) => set('audioChannels', v)} disabled={isAudioCopy} />
          </ui.FieldGrid>
        )}
      </ui.ParamGroup>

      <ui.ParamGroup title="后期处理">
        {!isCopy && (
          <ui.FieldGrid>
            <ui.FieldLabel>锐化</ui.FieldLabel>
            <ui.ComboBox value={form.unsharp} options={UNSHARP_OPTIONS} onChange={(v) => set('unsharp', v)} />
            <ui.FieldLabel>降噪</ui.FieldLabel>
            <ui.ComboBox value={form.denoise} options={DENOISE_OPTIONS} onChange={(v) => set('denoise', v)} />
            <ui.FieldLabel>风格</ui.FieldLabel>
            <ui.ComboBox value={form.style} options={TUNE_OPTIONS} onChange={(v) => set('style', v)} />
          </ui.FieldGrid>
        )}
        {isCopy && <ui.HintLabel>视频流复制模式下滤镜（锐化 / 降噪 / 风格）不可用。</ui.HintLabel>}
        <ui.Checkbox checked={form.loudnorm} onChange={(v) => set('loudnorm', v)}>启用音频标准化</ui.Checkbox>
      </ui.ParamGroup>
    </>
  );
}

import { useFileList } from '../lib/fileListContext';
import { useColumnLayout } from '../lib/columnLayoutContext';
import { IconClose, IconCheckShield, IconCropClear, IconPlayAll, IconPlaySelected, IconStop } from './icons';

/* 共享：活动任务进度路由（单任务模型） */
let activeTaskId = 0;

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

function useTaskRunner() {
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [detail, setDetail] = useState('尚未开始任务');
  const [eta, setEta] = useState('—');
  const [pass, setPass] = useState(0);
  const [fail, setFail] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const taskId = useRef(0);
  const startedAt = useRef(0);

  useEffect(() => {
    let un1: (() => void) | null = null;
    let un2: (() => void) | null = null;
    Promise.all([
      subscribeProgress((p) => {
        if (!runningRef.current) return;
        setProgress(p.percent);
        setDetail(p.detail);
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
    ]).then(([a, b]) => { un1 = a; un2 = b; });
    return () => { un1?.(); un2?.(); };
  }, []);

  const start = useCallback(async (fn: () => Promise<void>) => {
    const id = ++activeTaskId;
    taskId.current = id;
    runningRef.current = true;
    startedAt.current = Date.now();
    setRunning(true);
    setLogs([]);
    setProgress(0);
    setDetail('正在准备...');
    setEta('—');
    setPass(0);
    setFail(0);
    try {
      await fn();
      if (taskId.current === id) {
        setProgress(100);
        setDetail('任务结束');
        setEta('0s');
      }
    } catch (e: any) {
      if (taskId.current === id) {
        setDetail(`任务失败: ${String(e?.message || e)}`);
        setEta('—');
      }
    } finally {
      if (taskId.current === id) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  }, []);

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-400), line]);
  }, []);

  return {
    logs, progress, detail, eta, pass, fail, running,
    start, appendLog, setPass, setFail, setDetail, setProgress, setEta,
  };
}

/** 工具工作区：参数列（滚动区 + 固定操作底栏）+ 可拖拽分隔 + 结果列（固定进度头 + 滚动内容） */
function ToolWorkspace({ params, actions, result, resultHeader, resultTitle }: {
  params: ReactNode;
  /** 参数列底部固定的操作区（处理按钮），不随滚动消失 */
  actions?: ReactNode;
  result: ReactNode;
  /** 结果列顶部状态区（进度条等），与标题一起置于滚动内容顶部 */
  resultHeader?: ReactNode;
  /** 结果列标题，与左列顶部标题同高同位、无分隔线 */
  resultTitle?: ReactNode;
}) {
  const { wParams, resizeParams } = useColumnLayout();
  return (
    <div className="se-tab-workspace">
      <div className="se-left" style={{ flex: `0 0 ${wParams}px`, width: wParams, minWidth: wParams }}>
        <div className="se-params-scroll">{params}</div>
        {actions && <div className="se-params-foot">{actions}</div>}
      </div>
      <ResizeHandle onDelta={resizeParams} />
      <div className="se-right">
        <div className="se-result-scroll">
          {(resultTitle || resultHeader) && (
            <div className="se-result-head">
              {resultTitle ? <div className="se-result-title">{resultTitle}</div> : null}
              {resultHeader}
            </div>
          )}
          {result}
        </div>
      </div>
    </div>
  );
}

/** 处理选中 / 批量处理 —— 两行整齐布局 + 图标 */
function ProcessButtons({
  running,
  selectedCount,
  totalCount,
  onSelected,
  onAll,
  onStop,
}: {
  running: boolean;
  selectedCount: number;
  totalCount: number;
  onSelected: () => void;
  onAll: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="se-process-btns">
      <ui.Button
        primary
        className="se-process-main"
        disabled={running || selectedCount === 0}
        onClick={onSelected}
        icon={<IconPlaySelected size={15} />}
      >
        处理选中
      </ui.Button>
      <ui.Button
        primary
        className="se-process-main"
        disabled={running || totalCount === 0}
        onClick={onAll}
        icon={<IconPlayAll size={15} />}
      >
        批量全部
      </ui.Button>
      {onStop && (
        <ui.Button
          className="se-process-stop"
          disabled={!running}
          onClick={onStop}
          icon={<IconStop size={15} />}
        >
          停止
        </ui.Button>
      )}
    </div>
  );
}

/** 预览路径：同步 media URL + 可选 probe（防抖、可取消） */
function useActiveMedia(activePath: string | null, probe = true) {
  const [src, setSrc] = useState('');
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [path, setPath] = useState('');
  const [warn, setWarn] = useState('');

  useEffect(() => {
    const p = activePath;
    if (!p || p.endsWith('/') || p.endsWith('\\')) {
      setSrc('');
      setInfo(null);
      setPath('');
      setWarn('');
      return;
    }
    setPath(p);
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

/* ========================= 转码 ========================= */

const UNSHARP_OPTIONS = [
  { label: '强度0', value: 0 },
  { label: '强度0.5', value: 1 },
  { label: '强度0.8 (默认)', value: 2 },
  { label: '强度1.2', value: 3 },
  { label: '强度1.5', value: 4 },
];

const DENOISE_OPTIONS = [
  { label: '无降噪', value: 0 },
  { label: '轻度降噪 (默认)', value: 1 },
  { label: '中度降噪+去块', value: 2 },
  { label: '强力降噪+去块', value: 3 },
];

const TUNE_OPTIONS = [
  { label: '无风格', value: 0 },
  { label: '实拍视频', value: 1 },
  { label: '动画类 (默认)', value: 2 },
];

export function EncodeTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const [form, setForm] = useState(() => ({ ...DEFAULT_ENCODE_FORM }));

  // 面板内联控件直接改 form（无需先建预设）
  const setField = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  // 套用预设时，把其参数写入当前表单；空白项（预设里未选择的）跳过，保留运行时默认值
  const applyEncode = (params: any) => {
    setForm((prev) => {
      const merged: any = { ...prev };
      for (const [k, v] of Object.entries(params)) {
        if (v === '' || v === null || v === undefined) continue;
        merged[k] = v;
      }
      return merged;
    });
  };

  const runPaths = (targets: string[]) => t.start(async () => {
    try {
      await transcode({
        paths: targets,
        videoCodec: form.videoCodec,
        videoProfile: form.videoProfile,
        crf: form.crf,
        speedPreset: form.preset,
        tune: form.tune,
        style: form.style,
        pixelFormat: form.pixelFormat,
        container: form.container,
        scaleW: form.scaleW,
        scaleH: form.scaleH,
        fps: form.fps,
        videoBitrate: form.videoBitrate,
        audioCodec: form.audioCodec,
        audioProfile: form.audioProfile,
        audioBitrate: form.audioBitrate,
        audioSampleRate: form.audioSampleRate,
        audioChannels: form.audioChannels,
        unsharp: form.unsharp,
        denoise: form.denoise,
        loudnorm: form.loudnorm,
        audioOnly: form.audioOnly,
        keepRes: form.keepRes,
        rateMode: form.rateMode || 'crf',
        targetFileSizeMb: form.targetFileSizeMb || 0,
      });
      t.setPass(targets.length);
      t.setFail(0);
    } catch (e) {
      t.setFail(targets.length);
      throw e;
    }
  });

  return (
    <ToolWorkspace
      params={
        <>
          <PresetManager type="encode" onApply={applyEncode} currentParams={form} renderBuilder={(ctx) => <PresetBuilder ctx={ctx} />} />
          <EncodeInlineForm form={form} set={setField} />
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedPaths.length}
          totalCount={fl.paths.length}
          onSelected={() => runPaths(fl.selectedPaths)}
          onAll={() => runPaths(fl.paths)}
          onStop={() => t.setDetail('已取消')}
        />
      }
      resultHeader={<ui.ProgressBar value={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} />}
      resultTitle={<ui.SectionTitle>实时日志</ui.SectionTitle>}
      result={<ui.LogView lines={t.logs} />}
    />
  );
}

/* ========================= 混音 ========================= */

export function MixTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const [lnOn, setLnOn] = useState(true);
  const [tpOn, setTpOn] = useState(true);
  const [lnI, setLnI] = useState(-24.0);
  const [lnTp, setLnTp] = useState(-2.0);
  const [lnLra, setLnLra] = useState(7.0);
  const [cpTh, setCpTh] = useState(-27.0);
  const [cpGain, setCpGain] = useState(5.0);

  const applyMix = (params: any) => {
    if (params.lnOn != null) setLnOn(params.lnOn);
    if (params.lnI != null) setLnI(params.lnI);
    if (params.lnTp != null) setLnTp(params.lnTp);
    if (params.lnLra != null) setLnLra(params.lnLra);
    if (params.tpOn != null) setTpOn(params.tpOn);
    if (params.cpTh != null) setCpTh(params.cpTh);
    if (params.cpGain != null) setCpGain(params.cpGain);
  };

  const runPaths = (targets: string[]) => t.start(async () => {
    try {
      await mixAudio(targets, lnI, lnTp, lnLra, cpTh, cpGain, lnOn, tpOn);
      t.setPass(targets.length);
      t.setFail(0);
    } catch (e) {
      t.setFail(targets.length);
      throw e;
    }
  });

  return (
    <ToolWorkspace
      params={
        <>
          <PresetManager type="mix" onApply={applyMix} initialValues={{ lnOn, lnI, lnTp, lnLra, tpOn, cpTh, cpGain }} currentParams={{ lnOn, lnI, lnTp, lnLra, tpOn, cpTh, cpGain }} />
          <ui.ParamGroup
            title="响度标准化 (EBU R128)"
            aside={<ui.Checkbox checked={lnOn} onChange={setLnOn} disabled={t.running}>{''}</ui.Checkbox>}
          >
            <ui.FieldGrid>
              <ui.FieldLabel>目标响度 (I)</ui.FieldLabel>
              <ui.NumberField value={lnI} min={-70} max={-5} step={1} suffix="LUFS" disabled={!lnOn || t.running} onChange={setLnI} />
              <ui.FieldLabel>真峰限制 (TP)</ui.FieldLabel>
              <ui.NumberField value={lnTp} min={-9} max={0} step={0.5} suffix="dBTP" disabled={!lnOn || t.running} onChange={setLnTp} />
              <ui.FieldLabel>响度范围 (LRA)</ui.FieldLabel>
              <ui.NumberField value={lnLra} min={1} max={50} step={1} suffix="LU" disabled={!lnOn || t.running} onChange={setLnLra} />
            </ui.FieldGrid>
          </ui.ParamGroup>
          <ui.ParamGroup
            title="动态压缩 (Compand)"
            aside={<ui.Checkbox checked={tpOn} onChange={setTpOn} disabled={t.running}>{''}</ui.Checkbox>}
          >
            <ui.FieldGrid>
              <ui.FieldLabel>压缩阈值</ui.FieldLabel>
              <ui.NumberField value={cpTh} min={-80} max={0} step={1} suffix="dB" disabled={!tpOn || t.running} onChange={setCpTh} />
              <ui.FieldLabel>补偿增益</ui.FieldLabel>
              <ui.NumberField value={cpGain} min={-20} max={40} step={1} suffix="dB" disabled={!tpOn || t.running} onChange={setCpGain} />
            </ui.FieldGrid>
          </ui.ParamGroup>
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedPaths.length}
          totalCount={fl.paths.length}
          onSelected={() => runPaths(fl.selectedPaths)}
          onAll={() => runPaths(fl.paths)}
        />
      }
      resultHeader={<ui.ProgressBar value={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} />}
      resultTitle={<ui.SectionTitle>实时日志</ui.SectionTitle>}
      result={<ui.LogView lines={t.logs} />}
    />
  );
}

/* ========================= 检测 ========================= */

export function CheckTab() {
  const fl = useFileList();
  const t = useTaskRunner();
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
  const hasRef = !!refEnc;

  const runPaths = (targets: string[]) => t.start(async () => {
    const expW = refEnc?.params?.scaleW || 0;
    const expH = refEnc?.params?.scaleH || 0;
    const expFps = refEnc?.params?.fps || 0;
    const expCodec = refEnc?.params?.videoCodec || '';
    const r = await checkVideos(targets, fpsTol, recursive, blackDetect, expW, expH, expFps, expCodec);
    t.setPass(r.pass + r.pass_with_warnings);
    t.setFail(r.fail);
    t.setDetail(`通过 ${r.pass}，警告 ${r.pass_with_warnings}，失败 ${r.fail}`);
  });

  return (
    <ToolWorkspace
      params={
        <>
          <PresetManager type="check" onApply={applyCheck} initialValues={{ fpsTol, recursive, blackDetect }} currentParams={{ fpsTol, recursive, blackDetect, ...encRef }} />
          <ui.ParamGroup title="编码规范参照">
            <ui.FieldGrid>
              <ui.FieldLabel>对照预设</ui.FieldLabel>
              <ui.ComboBox
                value={refEncId ?? ''}
                options={encPresets.presets.length
                  ? [{ label: '(不指定编码规范)', value: '' }, ...encPresets.presets.map((p) => ({ label: `${p.name}`, value: p.id }))]
                  : [{ label: '(无转码预设)', value: '' }]}
                onChange={(v) => setRefEncId(v || null)}
              />
            </ui.FieldGrid>
          </ui.ParamGroup>
          <ui.ParamGroup title="检测规则">
            <ui.FieldGrid>
              <ui.FieldLabel>帧率容差</ui.FieldLabel>
              <ui.NumberField value={fpsTol} min={0} max={10} step={0.1} disabled={!hasRef || t.running} onChange={setFpsTol} />
            </ui.FieldGrid>
            <ui.Checkbox checked={recursive} onChange={setRecursive} disabled={t.running}>目录递归扫描</ui.Checkbox>
            <ui.Checkbox checked={blackDetect} onChange={setBlackDetect} disabled={t.running}>启用中间黑帧检测</ui.Checkbox>
          </ui.ParamGroup>
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={fl.selectedPaths.length}
          totalCount={fl.paths.length}
          onSelected={() => runPaths(fl.selectedPaths)}
          onAll={() => runPaths(fl.paths)}
        />
      }
      resultHeader={<ui.ProgressBar value={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} />}
      resultTitle={<ui.SectionTitle>检测日志</ui.SectionTitle>}
      result={<ui.LogView lines={t.logs} />}
    />
  );
}

/* ========================= 合成透明通道 ========================= */

export function AlphaTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const [fpsOriginal, setFpsOriginal] = useState(true);
  const [fps, setFps] = useState(25.0);
  const media = useActiveMedia(fl.activePath, true);

  const runBatch = (targets: string[]) => {
    const files = onlyFiles(targets);
    t.start(async () => {
      let ok = 0;
      let bad = 0;
      for (let i = 0; i < files.length; i++) {
        const input = files[i];
        const output = input.replace(/\.[^.]+$/, '') + '_合成.mov';
        t.setDetail(`(${i + 1}/${files.length}) ${input.split(/[/\\]/).pop()}`);
        t.setProgress(Math.round((i / files.length) * 100));
        try {
          await composeAlpha(input, output, fpsOriginal ? null : fps);
          ok++;
          t.setPass(ok);
          t.appendLog(`[PASS] ${output}`);
        } catch (e: any) {
          bad++;
          t.setFail(bad);
          t.appendLog(`[FAIL] ${input}: ${e?.message || e}`);
        }
      }
      t.setProgress(100);
      if (bad > 0 && ok === 0) throw new Error(`全部失败 (${bad})`);
    });
  };

  return (
    <ToolWorkspace
      params={
        <>
          {media.name && <ui.HintLabel>预览: {media.name}</ui.HintLabel>}
          <ui.ParamGroup title="帧率设置">
            <ui.Radio checked={fpsOriginal} onToggle={() => setFpsOriginal(true)}>保持原始帧率</ui.Radio>
            <div className="se-btn-row">
              <ui.Radio checked={!fpsOriginal} onToggle={() => setFpsOriginal(false)}>自定义帧率</ui.Radio>
              <ui.NumberField value={fps} min={1} max={120} step={0.1} disabled={fpsOriginal} onChange={setFps} width={110} />
            </div>
          </ui.ParamGroup>
          {media.warn && <ui.WarnLabel>{media.warn}</ui.WarnLabel>}
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={onlyFiles(fl.selectedPaths).length}
          totalCount={onlyFiles(fl.paths).length}
          onSelected={() => runBatch(fl.selectedPaths)}
          onAll={() => runBatch(fl.paths)}
          onStop={() => t.setDetail('已取消')}
        />
      }
      resultHeader={<ui.ProgressBar value={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} />}
      resultTitle={<ui.SectionTitle>实时预览</ui.SectionTitle>}
      result={
        <>
          <VideoPlayer src={media.src} alphaPreview cropEnabled={false} />
          {t.logs.length > 0 && (
            <>
              <ui.SectionTitle>日志</ui.SectionTitle>
              <ui.LogView lines={t.logs} />
            </>
          )}
        </>
      }
    />
  );
}

/* ========================= 截图 ========================= */

export function ScreenshotTab() {
  const fl = useFileList();
  const t = useTaskRunner();
  const playerRef = useRef<VideoPlayerHandle>(null);
  const media = useActiveMedia(fl.activePath, true);
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [aspect, setAspect] = useState('free');
  const [customRatio, setCustomRatio] = useState('3:2');
  const [cropLocked, setCropLocked] = useState(false);
  const [time, setTime] = useState('00:00:00.000');
  const [cropInfo, setCropInfo] = useState('裁剪区域: 未选择 (将使用完整画面缩放)');

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
    } else if (v === 'match') playerRef.current?.setCropAspect(w, h);
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
  // 自由模式下，加载素材后把输出尺寸初始化为完整画面
  useEffect(() => {
    if (media.info && aspect === 'free') { setW(media.info.width); setH(media.info.height); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.info]);

  const applyShot = (params: any) => {
    if (params.w != null) setW(params.w);
    if (params.h != null) setH(params.h);
    if (params.aspect != null) setAspect(params.aspect);
    if (params.customRatio != null) setCustomRatio(params.customRatio);
  };

  const onCrop = (r: CropRectResult) => {
    if (r.w === 0 && r.h === 0) {
      setCropInfo('裁剪区域: 未选择 (将使用完整画面缩放)');
      // 自由模式：清除选区后输出尺寸回到完整画面
      if (aspect === 'free' && media.info) { setW(media.info.width); setH(media.info.height); }
    } else {
      setCropInfo(`裁剪区域: ${r.x},${r.y}  尺寸: ${r.w}×${r.h}`);
      // 自由模式：输出尺寸直接等于所截区域（native 分辨率）
      if (aspect === 'free') { setW(r.w); setH(r.h); }
    }
  };

  const runBatch = (targets: string[]) => {
    const files = onlyFiles(targets);
    t.start(async () => {
      let ok = 0;
      let bad = 0;
      const ts = playerRef.current?.getCurrentTime() ?? 0;
      const crop = playerRef.current?.getCropRect() ?? null;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const out = file.replace(/\.[^.]+$/, '') + `_screenshot_${ts.toFixed(2)}s.png`;
        t.setDetail(`(${i + 1}/${files.length}) ${file.split(/[/\\]/).pop()}`);
        t.setProgress(Math.round((i / files.length) * 100));
        try {
          await screenshotFrame(file, out, ts, w, h, crop as CropRect | null);
          ok++;
          t.setPass(ok);
          t.appendLog(`[PASS] ${out}`);
        } catch (e: any) {
          bad++;
          t.setFail(bad);
          t.appendLog(`[FAIL] ${file}: ${e?.message || e}`);
        }
      }
      t.setProgress(100);
      if (bad > 0 && ok === 0) throw new Error(`全部失败 (${bad})`);
    });
  };

  return (
    <ToolWorkspace
      params={
        <>
          <PresetManager type="screenshot" onApply={applyShot} initialValues={{ w, h, aspect, customRatio }} currentParams={{ w, h, aspect, customRatio }} />
          {media.name && <ui.HintLabel>预览: {media.name}</ui.HintLabel>}
          {media.info && (
            <ui.VideoInfo>
              {media.info.width}×{media.info.height} · {media.info.fps.toFixed(2)}fps · {formatTime(media.info.duration)}
              {media.info.has_alpha ? ' · 透明' : ''}
            </ui.VideoInfo>
          )}
          <ui.ParamGroup title="选取比例">
            <ui.FieldGrid>
              <ui.FieldLabel>比例</ui.FieldLabel>
              <ui.ComboBox value={aspect} options={CROP_ASPECT_OPTIONS} onChange={onAspectChange} />
              {aspect === 'custom' && (
                <React.Fragment>
                  <ui.FieldLabel>宽比</ui.FieldLabel>
                  <ui.IntField value={crw} min={1} max={99} onChange={onCustomRatioW} />
                  <ui.FieldLabel>高比</ui.FieldLabel>
                  <ui.IntField value={crh} min={1} max={99} onChange={onCustomRatioH} />
                </React.Fragment>
              )}
            </ui.FieldGrid>
            {aspect === 'free' && <ui.HintLabel>自由模式：直接在画面中框选区域，输出尺寸由选区决定（下方宽高不可编辑）</ui.HintLabel>}
          </ui.ParamGroup>
          <ui.ParamGroup title="输出尺寸">
            <ui.FieldGrid tight>
              <ui.FieldLabel>宽</ui.FieldLabel>
              <ui.IntField value={w} min={1} max={8192} disabled={aspect === 'free'} onChange={onW} />
              <ui.FieldLabel>高</ui.FieldLabel>
              <ui.IntField value={h} min={1} max={8192} disabled={aspect === 'free'} onChange={onH} />
            </ui.FieldGrid>
          </ui.ParamGroup>
          <ui.ParamGroup title="裁剪区域">
            <div className="se-btn-row">
              <ui.Checkbox checked={cropLocked} onChange={setCropLocked}>锁定选区</ui.Checkbox>
              <ui.Button
                disabled={t.running}
                icon={<IconCropClear size={15} />}
                onClick={() => { playerRef.current?.clearCrop(); setCropInfo('裁剪区域: 未选择 (将使用完整画面缩放)'); }}
              >
                清除选区
              </ui.Button>
            </div>
            <ui.HintLabel>{cropInfo}</ui.HintLabel>
          </ui.ParamGroup>
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={onlyFiles(fl.selectedPaths).length}
          totalCount={onlyFiles(fl.paths).length}
          onSelected={() => runBatch(fl.selectedPaths)}
          onAll={() => runBatch(fl.paths)}
        />
      }
      resultHeader={<ui.ProgressBar value={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} />}
      resultTitle={<ui.SectionTitle>实时预览</ui.SectionTitle>}
      result={
        <>
          <VideoPlayer
            ref={playerRef}
            src={media.src}
            alphaPreview={!!media.info?.has_alpha}
            cropEnabled
            cropLocked={cropLocked}
            onFrame={(tm) => setTime(formatTime(tm))}
            onCropChange={onCrop}
          />
          {t.logs.length > 0 && (
            <>
              <ui.SectionTitle>日志</ui.SectionTitle>
              <ui.LogView lines={t.logs} />
            </>
          )}
        </>
      }
    />
  );
}

/* ========================= 导出 GIF / WebP / 截取 ========================= */

export function ExportTab({ format }: { format: 'gif' | 'webp' | 'clip' }) {
  const fl = useFileList();
  const t = useTaskRunner();
  const playerRef = useRef<VideoPlayerHandle>(null);
  const media = useActiveMedia(fl.activePath, true);
  const [start, setStart] = useState('00:00:00.000');
  const [end, setEnd] = useState('00:00:05.000');
  const [duration, setDuration] = useState('片段时长: 5.000s');
  const [fixedDur, setFixedDur] = useState(false);
  const [fixedVal, setFixedVal] = useState(2.0);
  const encPresets = usePresets('encode');
  const [w, setW] = useState(format === 'clip' ? 0 : 480);
  const [h, setH] = useState(format === 'clip' ? 0 : 270);
  const [fps, setFps] = useState(15.0);
  const [quality, setQuality] = useState(75);
  const [aspect, setAspect] = useState('free');
  const [customRatio, setCustomRatio] = useState('3:2');
  const [cropLocked, setCropLocked] = useState(false);
  const [cropInfo, setCropInfo] = useState('裁剪区域: 未选择 (将使用完整画面缩放)');
  const [clipPresetId, setClipPresetId] = useState('');

  const applyExport = (params: any) => {
    if (params.w != null) setW(params.w);
    if (params.h != null) setH(params.h);
    if (params.aspect != null) setAspect(params.aspect);
    if (params.customRatio != null) setCustomRatio(params.customRatio);
    if (params.fps != null) setFps(params.fps);
    if (params.quality != null) setQuality(params.quality);
    if (params.fixedDur != null) setFixedDur(params.fixedDur);
    if (params.fixedVal != null) setFixedVal(params.fixedVal);
  };

  const onCrop = (r: CropRectResult) => {
    if (r.w === 0 && r.h === 0) {
      setCropInfo('裁剪区域: 未选择 (将使用完整画面缩放)');
      // 自由模式：清除选区后输出尺寸回到完整画面
      if (aspect === 'free' && media.info) { setW(media.info.width); setH(media.info.height); }
    } else {
      setCropInfo(`裁剪区域: ${r.x},${r.y}  尺寸: ${r.w}×${r.h}`);
      // 自由模式：输出尺寸直接等于所截区域（native 分辨率）
      if (aspect === 'free') { setW(r.w); setH(r.h); }
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
    } else if (v === 'match') playerRef.current?.setCropAspect(w, h);
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
  // 自由模式下，加载素材后把输出尺寸初始化为完整画面
  useEffect(() => {
    if (media.info && aspect === 'free') { setW(media.info.width); setH(media.info.height); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.info]);
  const syncDur = () => {
    const s = parseTime(start); const e = parseTime(end);
    if (s != null && e != null) setDuration(`片段时长: ${(e - s).toFixed(3)}s`);
  };
  const setStartNow = () => { const tm = playerRef.current?.getCurrentTime() ?? 0; setStart(formatTime(tm)); syncDur(); };
  const setEndNow = () => { const tm = playerRef.current?.getCurrentTime() ?? 0; setEnd(formatTime(tm)); syncDur(); };

  const runBatch = (targets: string[]) => {
    const files = onlyFiles(targets);
    const s = parseTime(start) ?? 0;
    let e = parseTime(end) ?? 0;
    if (fixedDur) e = s + fixedVal;
    const dur = Math.max(0.01, e - s);
    const crop = playerRef.current?.getCropRect() ?? null;
    let segOutFmt = 'mp4';
    let segVc = '';
    let segVp = '';
    let segCrf = 0;
    let segVbr = 0;
    if (format === 'clip' && clipPresetId) {
      const ep = encPresets.presets.find((p) => p.id === clipPresetId);
      if (ep) {
        segOutFmt = ep.params.container || 'mp4';
        segVc = ep.params.videoCodec || '';
        segVp = ep.params.videoProfile || '';
        segCrf = ep.params.crf ?? 0;
        segVbr = ep.params.videoBitrate ?? 0;
      }
    }
    if (!segOutFmt) segOutFmt = 'mp4';
    t.start(async () => {
      let ok = 0;
      let bad = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const base = file.replace(/\.[^.]+$/, '');
        t.setDetail(`(${i + 1}/${files.length}) ${file.split(/[/\\]/).pop()}`);
        t.setProgress(Math.round((i / files.length) * 100));
        try {
          if (format === 'gif') await exportGif(file, `${base}.gif`, s, dur, fps, w, h, crop as CropRect | null);
          else if (format === 'webp') await exportWebp(file, `${base}.webp`, s, dur, fps, w, h, quality, crop as CropRect | null);
          else await exportSegment(file, `${base}.${segOutFmt}`, s, dur, fps, w, h, segOutFmt, crop as CropRect | null, segVc, segVp, segCrf, segVbr);
          ok++;
          t.setPass(ok);
          t.appendLog(`[PASS] ${base}`);
        } catch (err: any) {
          bad++;
          t.setFail(bad);
          t.appendLog(`[FAIL] ${file}: ${err?.message || err}`);
        }
      }
      t.setProgress(100);
      if (bad > 0 && ok === 0) throw new Error(`全部失败 (${bad})`);
    });
  };

  const name = format === 'gif' ? 'GIF' : format === 'webp' ? 'WebP' : '片段';
  const clipIsMov = format === 'clip' && !!encPresets.presets.find((p) => p.id === clipPresetId)?.params.container?.match(/^mov$/i);
  return (
    <ToolWorkspace
      params={
        <>
          <PresetManager
            type={format === 'gif' ? 'gif' : format === 'webp' ? 'webp' : 'segment'}
            onApply={applyExport}
            initialValues={{ w, h, fps, quality, fixedDur, fixedVal, aspect, customRatio }}
            currentParams={{ w, h, fps, quality, fixedDur, fixedVal, aspect, customRatio }}
          />
          {media.name && <ui.HintLabel>预览: {media.name}</ui.HintLabel>}
          {media.info && (
            <ui.VideoInfo>
              {media.info.width}×{media.info.height} · {media.info.fps.toFixed(2)}fps · {formatTime(media.info.duration)}
              {media.info.has_alpha ? ' · 透明' : ''}
            </ui.VideoInfo>
          )}
          <ui.ParamGroup title="时间范围">
            <div className="se-time-grid">
              <span className="se-detail-label">起始</span>
              <ui.DropInput value={start} readOnly />
              <button type="button" onClick={setStartNow}>当前</button>
              <span className="se-detail-label">结束</span>
              <ui.DropInput value={end} readOnly />
              <button type="button" onClick={setEndNow}>当前</button>
            </div>
            <ui.HintLabel>{duration}</ui.HintLabel>
            <div className="se-btn-row">
              <ui.Checkbox checked={fixedDur} onChange={setFixedDur}>固定时长</ui.Checkbox>
              <ui.NumberField value={fixedVal} min={0.1} max={9999} step={0.1} suffix="s" disabled={!fixedDur} onChange={setFixedVal} width={100} />
            </div>
          </ui.ParamGroup>
          <ui.ParamGroup title="选取比例">
            <ui.FieldGrid>
              <ui.FieldLabel>比例</ui.FieldLabel>
              <ui.ComboBox value={aspect} options={CROP_ASPECT_OPTIONS} onChange={onAspectChange} />
              {aspect === 'custom' && (
                <React.Fragment>
                  <ui.FieldLabel>宽比</ui.FieldLabel>
                  <ui.IntField value={crw} min={1} max={99} onChange={onCustomRatioW} />
                  <ui.FieldLabel>高比</ui.FieldLabel>
                  <ui.IntField value={crh} min={1} max={99} onChange={onCustomRatioH} />
                </React.Fragment>
              )}
            </ui.FieldGrid>
            {aspect === 'free' && <ui.HintLabel>自由模式：直接在画面中框选区域，输出尺寸由选区决定（下方宽高不可编辑）</ui.HintLabel>}
          </ui.ParamGroup>
          <ui.ParamGroup title={`输出参数 (${name})`}>
            {format !== 'clip' && (
              <ui.FieldGrid tight>
                <ui.FieldLabel>宽度</ui.FieldLabel><ui.IntField value={w} min={1} max={4096} disabled={aspect === 'free'} onChange={onW} />
                <ui.FieldLabel>高度</ui.FieldLabel><ui.IntField value={h} min={1} max={4096} disabled={aspect === 'free'} onChange={onH} />
                <ui.FieldLabel>帧率</ui.FieldLabel><ui.NumberField value={fps} min={1} max={60} step={0.1} onChange={setFps} />
                {format === 'webp' && (<><ui.FieldLabel>质量</ui.FieldLabel><ui.IntField value={quality} min={1} max={100} onChange={setQuality} /></>)}
              </ui.FieldGrid>
            )}
            {format === 'clip' && (
              <ui.FieldGrid>
                <ui.FieldLabel>编码预设</ui.FieldLabel>
                <ui.ComboBox
                  value={clipPresetId}
                  options={[
                    { label: '默认（MOV·ProRes4444 / 其他·H.264）', value: '' },
                    ...encPresets.presets.map((p) => ({ label: `${p.name} · ${(p.params.container || '').toUpperCase()}`, value: p.id })),
                  ]}
                  onChange={(v) => setClipPresetId(v)}
                />
              </ui.FieldGrid>
            )}
            <div className="se-btn-row">
              <ui.Checkbox checked={cropLocked} onChange={setCropLocked}>锁定选区</ui.Checkbox>
              <ui.Button
                disabled={t.running}
                icon={<IconCropClear size={15} />}
                onClick={() => { playerRef.current?.clearCrop(); setCropInfo('裁剪区域: 未选择 (将使用完整画面缩放)'); }}
              >
                清除选区
              </ui.Button>
            </div>
            <ui.HintLabel>{cropInfo}</ui.HintLabel>
          </ui.ParamGroup>
        </>
      }
      actions={
        <ProcessButtons
          running={t.running}
          selectedCount={onlyFiles(fl.selectedPaths).length}
          totalCount={onlyFiles(fl.paths).length}
          onSelected={() => runBatch(fl.selectedPaths)}
          onAll={() => runBatch(fl.paths)}
          onStop={() => t.setDetail('已取消')}
        />
      }
      resultHeader={<ui.ProgressBar value={t.progress} detail={t.detail} eta={t.eta} pass={t.pass} fail={t.fail} />}
      resultTitle={<ui.SectionTitle>实时预览</ui.SectionTitle>}
      result={
        <>
          <VideoPlayer
            ref={playerRef}
            src={media.src}
            alphaPreview={clipIsMov}
            cropEnabled
            cropLocked={cropLocked}
            onCropChange={onCrop}
          />
          {t.logs.length > 0 && (
            <>
              <ui.SectionTitle>日志</ui.SectionTitle>
              <ui.LogView lines={t.logs} />
            </>
          )}
        </>
      }
    />
  );
}
