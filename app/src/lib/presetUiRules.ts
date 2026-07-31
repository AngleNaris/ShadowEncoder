export type SharedPresetUiType =
  | 'mix'
  | 'check'
  | 'alpha'
  | 'screenshot'
  | 'segment'
  | 'gif'
  | 'webp'
  | 'sequence';

type FieldState = Record<string, unknown>;

const RATIO_TYPES = new Set<SharedPresetUiType>(['screenshot', 'segment', 'gif', 'webp', 'sequence']);

export function isPresetUiFieldVisible(
  type: SharedPresetUiType,
  key: string,
  state: FieldState,
): boolean {
  if (RATIO_TYPES.has(type) && key === 'customRatio') {
    return state.aspect === 'custom';
  }
  if ((type === 'screenshot' || type === 'sequence') && key === 'quality') {
    return state.imageFormat === 'jpg' || state.imageFormat === 'webp';
  }
  if ((type === 'screenshot' || type === 'sequence') && key === 'pngCompression') {
    return state.imageFormat === 'png';
  }
  if (type === 'segment' && key === 'fps') {
    return false;
  }
  return true;
}

export function isPresetUiFieldDisabled(
  type: SharedPresetUiType,
  key: string,
  state: FieldState,
): boolean {
  if (type === 'mix' && ['lnI', 'lnTp', 'lnLra'].includes(key)) {
    return state.lnOn !== true;
  }
  if (type === 'mix' && ['cpTh', 'cpGain'].includes(key)) {
    return state.tpOn !== true;
  }
  if (type === 'check' && key === 'fpsTol') {
    return !String(state.refEncPresetId ?? '').trim();
  }
  if (type === 'alpha' && key === 'fps') {
    return state.fpsOriginal !== false;
  }
  if (RATIO_TYPES.has(type) && (key === 'w' || key === 'h')) {
    return state.aspect === 'free' || state.aspect === 'match';
  }
  if ((type === 'segment' || type === 'gif' || type === 'webp' || type === 'sequence') && key === 'fixedVal') {
    return state.fixedDur !== true || (type === 'sequence' && state.fullDuration === true);
  }
  return false;
}
