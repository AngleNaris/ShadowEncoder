import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { createMuiTheme } from './muiTheme';
import { applyHighContrastTokens } from './colorContrast';
import { applyThemeAccent, normalizeThemeAccent } from './themeAccent';
import {
  applyColorScheme,
  readHighContrast,
  readThemeAccent,
  readThemePreference,
  resolveThemePreference,
  saveHighContrast,
  saveThemeAccent,
  saveThemePreference,
  systemPrefersDark,
  type AppColorScheme,
  type ThemePreference,
} from './themePreference';

type AppThemeContextValue = {
  preference: ThemePreference;
  colorScheme: AppColorScheme;
  highContrast: boolean;
  accentColor: string;
  setPreference: (preference: ThemePreference) => void;
  setHighContrast: (enabled: boolean) => void;
  setAccentColor: (accent: string) => void;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function useAppTheme(): AppThemeContextValue {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return value;
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const [highContrast, setHighContrastState] = useState(readHighContrast);
  const [accentColor, setAccentColorState] = useState(readThemeAccent);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const colorScheme = resolveThemePreference(preference, prefersDark);
  const muiTheme = useMemo(
    () => createMuiTheme(colorScheme, highContrast, accentColor),
    [accentColor, colorScheme, highContrast],
  );

  useLayoutEffect(() => {
    applyColorScheme(colorScheme);
    applyThemeAccent(accentColor, colorScheme);
    applyHighContrastTokens(highContrast, colorScheme);
  }, [accentColor, colorScheme, highContrast]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setPrefersDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    saveThemePreference(next);
    setPreferenceState(next);
  }, []);

  const setHighContrast = useCallback((enabled: boolean) => {
    saveHighContrast(enabled);
    setHighContrastState(enabled);
  }, []);

  const setAccentColor = useCallback((accent: string) => {
    const normalized = normalizeThemeAccent(accent);
    if (!normalized) return;
    saveThemeAccent(normalized);
    setAccentColorState(normalized);
  }, []);

  const value = useMemo(() => ({
    preference,
    colorScheme,
    highContrast,
    accentColor,
    setPreference,
    setHighContrast,
    setAccentColor,
  }), [accentColor, colorScheme, highContrast, preference, setAccentColor, setHighContrast, setPreference]);

  return (
    <AppThemeContext.Provider value={value}>
      <ThemeProvider theme={muiTheme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppThemeContext.Provider>
  );
}
