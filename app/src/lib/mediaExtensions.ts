export const MEDIA_EXTENSIONS = new Set([
  '3g2', '3gp', 'aac', 'ac3', 'aif', 'aiff', 'alac', 'amr', 'ape', 'ari', 'arw',
  'asf', 'avi', 'avif', 'bmp', 'braw', 'caf', 'cin', 'cr2', 'cr3', 'crm', 'dng',
  'dpx', 'dts', 'eac3', 'exr', 'flac', 'flv', 'gif', 'heic', 'heif', 'ico', 'jpeg',
  'jpg', 'm2ts', 'm4a', 'm4v', 'mka', 'mkv', 'mov', 'mp2', 'mp3', 'mp4', 'mpeg',
  'mpg', 'mts', 'mxf', 'nef', 'ogg', 'ogv', 'opus', 'orf', 'pcm', 'png', 'r3d',
  'raf', 'raw', 'rm', 'rmvb', 'rw2', 'tga', 'tif', 'tiff', 'ts', 'vob', 'wav',
  'webm', 'webp', 'wma', 'wmv',
]);

export const AUDIO_EXTENSIONS = new Set([
  'aac', 'ac3', 'aif', 'aiff', 'alac', 'amr', 'ape', 'caf', 'dts', 'eac3', 'flac',
  'm4a', 'mka', 'mp2', 'mp3', 'ogg', 'opus', 'pcm', 'wav', 'wma',
]);

export const VIDEO_EXTENSIONS = new Set([
  '3g2', '3gp', 'asf', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg',
  'mpg', 'mts', 'mxf', 'ogv', 'rm', 'rmvb', 'ts', 'vob', 'webm', 'wmv',
]);

export function mediaExtension(path: string): string {
  const filename = path.trim().split(/[/\\]/).pop() ?? '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1
    ? filename.slice(dot + 1).toLocaleLowerCase()
    : '';
}

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(mediaExtension(path));
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.has(mediaExtension(path));
}

export function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.has(mediaExtension(path));
}

export function isAudioVisualPath(path: string): boolean {
  return isVideoPath(path) || isAudioPath(path);
}

export function partitionMediaPaths(
  paths: string[],
  accepts: (path: string) => boolean,
): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    (accepts(path) ? files : skipped).push(path);
  }
  return { files, skipped };
}
