export type OutputDimensions = {
  width: number;
  height: number;
};

export type OutputCrop = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/** 截图、GIF、WebP 与截取共用的初始输出尺寸。 */
export const DEFAULT_EXPORT_DIMENSIONS: OutputDimensions = {
  width: 480,
  height: 270,
};

function validDimensions(value: OutputDimensions | null | undefined): OutputDimensions | null {
  if (!value || value.width <= 0 || value.height <= 0) return null;
  return { width: Math.round(value.width), height: Math.round(value.height) };
}

function cropDimensions(crop: OutputCrop | null | undefined): OutputDimensions | null {
  if (!crop || crop.w <= 0 || crop.h <= 0) return null;
  return { width: Math.round(crop.w), height: Math.round(crop.h) };
}

/**
 * 自由/匹配模式的输出尺寸来自实际画面：有选区时采用选区原生尺寸，
 * 否则采用视频显示尺寸。固定比例模式继续使用用户输入的输出尺寸。
 */
export function dimensionsForCropAspect(
  aspect: string,
  media: OutputDimensions | null,
  crop: OutputCrop | null,
  current: OutputDimensions,
): OutputDimensions {
  if (aspect !== 'free' && aspect !== 'match') return current;
  return cropDimensions(crop)
    ?? validDimensions(media)
    ?? validDimensions(current)
    ?? DEFAULT_EXPORT_DIMENSIONS;
}

/** 清除播放器选区时，也向外发布空选区，驱动共享输出尺寸回到完整画面。 */
export function clearOutputCropSelection(
  setCrop: (crop: OutputCrop | null) => void,
  onCropChange?: (crop: OutputCrop) => void,
): void {
  setCrop(null);
  onCropChange?.({ x: 0, y: 0, w: 0, h: 0 });
}
