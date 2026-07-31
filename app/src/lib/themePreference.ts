export const APP_THEME_STORAGE_KEY = 'shadowencoder.app-theme.v1';
export const APP_HIGH_CONTRAST_STORAGE_KEY = 'shadowencoder.high-contrast.v1';
export const APP_THEME_ACCENT_STORAGE_KEY = 'shadowencoder.theme-accent.v1';

export type ThemePreference = 'system' | 'dark' | 'light';
export type AppColorScheme = 'dark' | 'light';

const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light'];

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readThemePreference(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): ThemePreference {
  try {
    const value = storage?.getItem(APP_THEME_STORAGE_KEY);
    return THEME_PREFERENCES.includes(value as ThemePreference)
      ? value as ThemePreference
      : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  try {
    storage?.setItem(APP_THEME_STORAGE_KEY, preference);
  } catch {
    // Storage may be unavailable in browser preview or restricted environments.
  }
}

export function readHighContrast(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(APP_HIGH_CONTRAST_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveHighContrast(
  enabled: boolean,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  try {
    storage?.setItem(APP_HIGH_CONTRAST_STORAGE_KEY, String(enabled));
  } catch {
    // Storage may be unavailable in browser preview or restricted environments.
  }
}

export function readThemeAccent(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): string {
  try {
    const value = storage?.getItem(APP_THEME_ACCENT_STORAGE_KEY)?.trim().toLowerCase();
    return value && /^#[\da-f]{6}$/.test(value) ? value : '#6d5da5';
  } catch {
    return '#6d5da5';
  }
}

export function saveThemeAccent(
  accent: string,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  const normalized = accent.trim().toLowerCase();
  if (!/^#[\da-f]{6}$/.test(normalized)) return;
  try {
    storage?.setItem(APP_THEME_ACCENT_STORAGE_KEY, normalized);
  } catch {
    // Storage may be unavailable in browser preview or restricted environments.
  }
}

export function systemPrefersDark(): boolean {
  return typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
    || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): AppColorScheme {
  return preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;
}

export function applyColorScheme(
  scheme: AppColorScheme,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
) {
  if (!root) return;
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;
}

export function initializeAppTheme(): ThemePreference {
  const preference = readThemePreference();
  const scheme = resolveThemePreference(preference);
  applyColorScheme(scheme);
  return preference;
}
