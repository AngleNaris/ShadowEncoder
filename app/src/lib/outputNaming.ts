/** 供预览/透传的编码命名标签 */
export type EncodeNameLabels = {
  resolution?: string;
  fpsLabel?: string;
  codecLabel?: string;
  bitrateLabel?: string;
};

/** 前端生成编码命名标签（与后端逻辑对齐，用于预览） */
export function buildEncodeNameLabels(params: {
  scaleMode?: string;
  scaleEdge?: number;
  outputKind?: string;
  audioCodec?: string;
  audioBitrate?: number;
  scaleW?: number;
  scaleH?: number;
  keepRes?: boolean;
  fps?: number;
  videoCodec?: string;
  rateMode?: string;
  videoBitrate?: number;
  crf?: number;
  targetFileSizeMb?: number;
  /** 源分辨率（keepRes 或未指定缩放时用于预览） */
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFps?: number;
}): EncodeNameLabels {
  const codecMap: Record<string, string> = {
    libx264: 'H264', h264_nvenc: 'H264', h264_amf: 'H264', h264_qsv: 'H264',
    libx265: 'H265', hevc_nvenc: 'H265', hevc_amf: 'H265', hevc_qsv: 'H265',
    libsvtav1: 'AV1', 'libaom-av1': 'AV1', av1_nvenc: 'AV1', av1_amf: 'AV1', av1_qsv: 'AV1',
    libvpx: 'VP8', 'libvpx-vp9': 'VP9',
    mpeg4: 'MPEG4', mpeg2video: 'MPEG2',
    prores_ks: 'ProRes', prores: 'ProRes',
    dnxhd: 'DNxHR', dnxhr: 'DNxHR',
    mjpeg: 'MJPEG', ffv1: 'FFV1', gif: 'GIF', copy: 'copy',
  };
  const sw = params.scaleW ?? 0;
  const sh = params.scaleH ?? 0;
  let resolution = 'orig';
  const scaleMode = params.scaleMode || (params.keepRes ? 'original' : 'dimensions');
  if ((scaleMode === 'longEdge' || scaleMode === 'shortEdge') && (params.scaleEdge ?? 0) > 0) resolution = `${scaleMode === 'longEdge' ? 'long' : 'short'}${params.scaleEdge}`;
  else if (scaleMode === 'dimensions' && sw > 0 && sh > 0) resolution = `${sw}x${sh}`;
  else if ((params.sourceWidth ?? 0) > 0 && (params.sourceHeight ?? 0) > 0) {
    resolution = `${params.sourceWidth}x${params.sourceHeight}`;
  }

  const fps = params.fps ?? 0;
  let fpsLabel = 'orig';
  const fpsVal = fps > 0 ? fps : (params.sourceFps ?? 0);
  if (fpsVal > 0) {
    fpsLabel = Math.abs(fpsVal - Math.round(fpsVal)) < 0.01
      ? `${Math.round(fpsVal)}fps`
      : `${parseFloat(fpsVal.toFixed(2))}fps`;
  }

  const codec = params.videoCodec || '';
  const codecLabel = codecMap[codec] || codec || 'enc';

  const rateMode = params.rateMode || 'crf';
  const vb = params.videoBitrate ?? 0;
  const crf = params.crf ?? 0;
  const sizeMb = params.targetFileSizeMb ?? 0;
  let bitrateLabel = 'default';
  if (rateMode === 'filesize' && sizeMb > 0) {
    bitrateLabel = Number.isInteger(sizeMb) ? `${sizeMb}MB` : `${sizeMb.toFixed(1)}MB`;
  } else if (rateMode === 'bitrate' && vb > 0) {
    if (vb >= 1000 && vb % 1000 === 0) bitrateLabel = `${vb / 1000}Mbps`;
    else if (vb >= 1000) bitrateLabel = `${(vb / 1000).toFixed(1)}Mbps`;
    else bitrateLabel = `${vb}k`;
  } else if (crf >= 0) {
    bitrateLabel = `CRF${crf}`;
  }

  if (params.outputKind === 'audio') return { resolution: 'audio', fpsLabel: 'audio', codecLabel: params.audioCodec || 'audio', bitrateLabel: params.audioBitrate ? `${params.audioBitrate}k` : 'default' };
  return { resolution, fpsLabel, codecLabel, bitrateLabel: codec === 'copy' ? 'copy' : bitrateLabel };
}
