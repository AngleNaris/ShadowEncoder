// MUI theme mirrors the active CSS token set while preserving the existing geometry.
import { createTheme } from '@mui/material/styles';
import { increaseColorContrast } from './colorContrast';
import { DEFAULT_THEME_ACCENT, deriveAccentPalette, deriveThemeChromePalette } from './themeAccent';
import type { AppColorScheme } from './themePreference';

const PALETTES = {
  dark: {
    success: '#35c37c',
    warning: '#e5b04e',
    error: '#e05a4f',
  },
  light: {
    success: '#237a50',
    warning: '#956511',
    error: '#b23d36',
  },
} as const;

export function createMuiTheme(
  mode: AppColorScheme,
  highContrast = false,
  accentColor = DEFAULT_THEME_ACCENT,
) {
  const base = PALETTES[mode];
  const accent = deriveAccentPalette(accentColor, mode);
  const chrome = deriveThemeChromePalette(accentColor, mode);
  const backgrounds = [chrome.bg, chrome.surface, chrome.surface2];
  const text = highContrast ? {
    primary: increaseColorContrast(chrome.text, backgrounds, 9, mode),
    secondary: increaseColorContrast(chrome.textMuted, backgrounds, 7, mode),
    disabled: increaseColorContrast(chrome.textFaint, backgrounds, 4.5, mode),
  } : {
    primary: chrome.text,
    secondary: chrome.textMuted,
    disabled: chrome.textFaint,
  };
  const semantic = highContrast ? {
    success: increaseColorContrast(base.success, backgrounds, 4.5, mode),
    warning: increaseColorContrast(base.warning, backgrounds, 4.5, mode),
    error: increaseColorContrast(base.error, backgrounds, 4.5, mode),
  } : {
    success: base.success,
    warning: base.warning,
    error: base.error,
  };
  return createTheme({
    palette: {
      mode,
      primary: {
        main: accent.main,
        light: accent.bright,
        dark: accent.active,
        contrastText: accent.on,
      },
      background: {
        default: chrome.bg,
        paper: mode === 'dark' ? chrome.surface2 : chrome.surface,
      },
      text,
      divider: chrome.border,
      success: { main: semantic.success },
      warning: { main: semantic.warning },
      error: { main: semantic.error },
    },
    shape: { borderRadius: 0 },
    typography: {
      fontFamily: '"PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif',
      fontSize: 13,
    },
    components: {
      MuiSelect: {
        defaultProps: { size: 'small' },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            boxSizing: 'border-box',
            backgroundColor: 'var(--ctrl-bg, #1b1921)',
            color: 'var(--text, #ece8f2)',
            fontSize: 13,
            height: 'var(--ctrl-h)',
            borderRadius: 0,
            transition: 'background 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)',
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: "var(--ctrl-border, #3d3946)",
              transition: 'border-color 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)',
            },
            "&:hover:not(.Mui-focused) .MuiOutlinedInput-notchedOutline": { borderColor: "var(--ctrl-border-hover, #605870)" },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: "var(--ctrl-focus-border, #6d5da5)",
              borderWidth: 1,
              boxShadow: "none",
            },
            "&.Mui-focused": {
              backgroundColor: "var(--ctrl-focus-bg, #15131a)",
              boxShadow: "var(--ctrl-focus-shadow, 0 0 12px -2px rgba(109, 93, 165, 0.4))",
              outline: "none",
            },
            "& .MuiSelect-select:focus-visible": { outline: "none" },
            '&.Mui-disabled': { backgroundColor: 'var(--ctrl-disabled-bg, #15131a)' },
            '&.Mui-disabled .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ctrl-disabled-border, #2a2731)' },
            "& .MuiSelect-select": {
              boxSizing: "border-box",
              height: "var(--ctrl-h)",
              minWidth: 0,
              lineHeight: "calc(var(--ctrl-h) - 2px)",
              overflow: "hidden",
              paddingTop: 0,
              paddingBottom: 0,
              paddingRight: 32,
              display: 'flex',
              alignItems: 'center',
            },
          },
          input: {
            boxSizing: 'border-box',
            padding: '0 10px',
            height: 'var(--ctrl-h)',
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundColor: 'var(--surface-2, #1b1921)',
            color: 'var(--text, #ece8f2)',
            backgroundImage: 'none',
            border: '1px solid var(--border-strong, #3d3946)',
            borderRadius: 0,
            boxShadow: 'var(--menu-shadow, 0 16px 44px -12px rgba(0, 0, 0, 0.85))',
            marginTop: 2,
            transition: 'border-color 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)',
            '&:hover': { borderColor: 'var(--ctrl-border-hover, #605870)' },
          },
          list: { padding: '3px 0' },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            fontSize: 13,
            minHeight: 30,
            padding: '5px 12px',
            borderLeft: '2px solid transparent',
            paddingLeft: 10,
            color: 'var(--text-dim, #c6bfd1)',
            transition: 'background 140ms cubic-bezier(0.2,0.7,0.3,1), color 140ms cubic-bezier(0.2,0.7,0.3,1), border-color 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)',
            '&:hover': {
              backgroundColor: 'var(--surface-3, #232029)',
              color: 'var(--text, #ece8f2)',
              borderColor: 'var(--ctrl-border-hover, #605870)',
              boxShadow: 'inset 0 0 0 1px var(--ctrl-border-hover, #605870)',
            },
            '&.Mui-selected': {
              backgroundColor: 'var(--primary-soft, rgba(109, 93, 165, 0.16))',
              color: 'var(--primary-bright, #a89ccf)',
              borderLeft: '2px solid var(--primary, #6d5da5)',
            },
            '&.Mui-selected:hover': { backgroundColor: 'var(--primary-soft-hover, rgba(109, 93, 165, 0.24))' },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: 'var(--surface-3, #232029)',
            color: 'var(--tooltip-text, #ffffff)',
            border: '1px solid var(--border-strong, #3d3946)',
            borderRadius: 0,
            fontSize: 12,
          },
        },
      },
    },
  });
}

// Kept for callers that need the unchanged default theme without application state.
export const muiTheme = createMuiTheme('dark');
