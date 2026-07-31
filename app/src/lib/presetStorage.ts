export const PRESET_TYPES = [
  'encode', 'mix', 'check', 'alpha', 'screenshot', 'segment', 'gif', 'webp', 'sequence', 'backup', 'workflow',
] as const;

export type PresetType = typeof PRESET_TYPES[number];

export interface Preset {
  id: string;
  name: string;
  type: PresetType;
  params: Record<string, any>;
  revision?: number;
}

export type PresetStore = Record<PresetType, Preset[]>;

export const PRESET_STORAGE_VERSION = 2;
export const PRESET_STORAGE_KEY = 'shadowencoder.presets.v2';
export const LEGACY_PRESET_STORAGE_KEY = 'shadowencoder.presets.v1';

const LEGACY_BUILT_IN_PRESET_IDS = new Set([
  'enc-default-1',
  'enc-default-2',
  'mix-default-1',
  'check-default-1',
  'alpha-default-1',
  'shot-default-1',
  'seg-default-1',
  'gif-default-1',
  'webp-default-1',
  'backup-default-1',
  'workflow-default-1',
]);

type StoredPresetPayload = {
  version?: number;
  presets?: Partial<Record<PresetType, unknown>>;
};

type PresetStorageReader = {
  getItem: (key: string) => string | null;
};

export function createPresetId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function clonePresets(list: Preset[]): Preset[] {
  return list.map((preset) => ({
    ...preset,
    revision: Math.max(1, Math.trunc(Number(preset.revision) || 1)),
    params: JSON.parse(JSON.stringify(preset.params || {})),
  }));
}

export function emptyPresetStore(): PresetStore {
  return {
    encode: [],
    mix: [],
    check: [],
    alpha: [],
    screenshot: [],
    segment: [],
    gif: [],
    webp: [],
    sequence: [],
    backup: [],
    workflow: [],
  };
}

function decodePresetStore(
  serialized: string | null,
  expectedVersion: number,
  removeLegacyBuiltIns: boolean,
): PresetStore | null {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as StoredPresetPayload;
    if (parsed.version !== expectedVersion || !parsed.presets || typeof parsed.presets !== 'object') {
      return null;
    }
    const result = emptyPresetStore();
    for (const type of PRESET_TYPES) {
      const list = parsed.presets[type];
      if (!Array.isArray(list)) continue;
      result[type] = clonePresets(list
        .filter((item): item is Preset => Boolean(item && typeof item === 'object'))
        .map((item) => ({
          id: String(item.id || createPresetId()),
          name: String(item.name || '未命名预设'),
          type,
          params: item.params && typeof item.params === 'object' ? item.params : {},
          revision: item.revision,
        }))
        .filter((preset) => !removeLegacyBuiltIns || !LEGACY_BUILT_IN_PRESET_IDS.has(preset.id)));
    }
    return result;
  } catch {
    return null;
  }
}

export function loadPresetStore(storage?: PresetStorageReader | null): PresetStore {
  if (!storage) return emptyPresetStore();
  const current = decodePresetStore(
    storage.getItem(PRESET_STORAGE_KEY),
    PRESET_STORAGE_VERSION,
    false,
  );
  if (current) return current;

  return decodePresetStore(storage.getItem(LEGACY_PRESET_STORAGE_KEY), 1, true)
    ?? emptyPresetStore();
}

export function serializePresetStore(presets: PresetStore): string {
  return JSON.stringify({ version: PRESET_STORAGE_VERSION, presets });
}
