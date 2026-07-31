import { contrastRatio, increaseColorContrast, parseCssColor } from './colorContrast.ts';
import type { AppColorScheme } from './themePreference';

export const DEFAULT_THEME_ACCENT = '#6d5da5';

export type ThemeChromePalette = {
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  surface4: string;
  text: string;
  textDim: string;
  textMuted: string;
  textFaint: string;
  border: string;
  borderStrong: string;
  controlHover: string;
  terminal: string;
  backdropRgb: string;
  menuShadowRgb: string;
  footerShadowRgb: string;
  checkerDark: string;
  checkerLight: string;
};

const DEFAULT_CHROME_PALETTES: Record<AppColorScheme, ThemeChromePalette> = {
  dark: {
    bg: '#0d0b11',
    surface: '#15131a',
    surface2: '#1b1921',
    surface3: '#232029',
    surface4: '#2c2834',
    text: '#ece8f2',
    textDim: '#c6bfd1',
    textMuted: '#8d8498',
    textFaint: '#605870',
    border: '#2a2731',
    borderStrong: '#3d3946',
    controlHover: '#605870',
    terminal: '#0a090d',
    backdropRgb: '7, 5, 11',
    menuShadowRgb: '0, 0, 0',
    footerShadowRgb: '0, 0, 0',
    checkerDark: '#1a1820',
    checkerLight: '#2a2730',
  },
  light: {
    bg: '#f3f2f6',
    surface: '#ffffff',
    surface2: '#f7f5f9',
    surface3: '#ece9f0',
    surface4: '#ded9e4',
    text: '#211d28',
    textDim: '#4f4858',
    textMuted: '#696171',
    textFaint: '#99919f',
    border: '#ddd8e3',
    borderStrong: '#c9c2d1',
    controlHover: '#93899f',
    terminal: '#0a090d',
    backdropRgb: '7, 5, 11',
    menuShadowRgb: '41, 32, 52',
    footerShadowRgb: '216, 208, 229',
    checkerDark: '#1a1820',
    checkerLight: '#2a2730',
  },
};

export type AccentPalette = {
  main: string;
  hover: string;
  active: string;
  bright: string;
  on: string;
  hoverOn: string;
  indicator: string;
  deep: string;
  rgb: string;
  brightRgb: string;
  raySoftRgb: string;
  rayCoreRgb: string;
  rayTailRgb: string;
  preparingRgb: string;
  cropFillRgb: string;
};

const DEFAULT_ACCENT_PALETTES: Record<AppColorScheme, AccentPalette> = {
  dark: {
    main: '#6d5da5',
    hover: '#7e6fb6',
    active: '#5c4e8d',
    bright: '#a89ccf',
    on: '#f2f0f8',
    hoverOn: '#ffffff',
    indicator: '#ffffff',
    deep: '#4b3f78',
    rgb: '109, 93, 165',
    brightRgb: '155, 137, 224',
    raySoftRgb: '205, 195, 248',
    rayCoreRgb: '178, 162, 237',
    rayTailRgb: '126, 105, 211',
    preparingRgb: '126, 111, 182',
    cropFillRgb: '150, 138, 200',
  },
  light: {
    main: '#6d5da5',
    hover: '#5f5094',
    active: '#51447e',
    bright: '#554785',
    on: '#ffffff',
    hoverOn: '#ffffff',
    indicator: '#ffffff',
    deep: '#4b3f78',
    rgb: '109, 93, 165',
    brightRgb: '85, 71, 133',
    raySoftRgb: '205, 195, 248',
    rayCoreRgb: '178, 162, 237',
    rayTailRgb: '126, 105, 211',
    preparingRgb: '126, 111, 182',
    cropFillRgb: '150, 138, 200',
  },
};

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: clampChannel(from.r + (to.r - from.r) * amount),
    g: clampChannel(from.g + (to.g - from.g) * amount),
    b: clampChannel(from.b + (to.b - from.b) * amount),
  };
}

function toHex(color: Rgb): string {
  const channel = (value: number) => clampChannel(value).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function toRgbChannels(color: Rgb): string {
  return `${color.r}, ${color.g}, ${color.b}`;
}

function rgbToHsl(color: Rgb): Hsl {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = maximum === red
    ? ((green - blue) / delta) % 6
    : maximum === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { h: hue, s: saturation, l: lightness };
}

function hslToRgb(color: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const section = color.h / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, secondary, 0]
    : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
        : section < 4 ? [0, secondary, chroma]
          : section < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const offset = color.l - chroma / 2;
  return {
    r: clampChannel((red + offset) * 255),
    g: clampChannel((green + offset) * 255),
    b: clampChannel((blue + offset) * 255),
  };
}

function recolorReference(reference: string, accent: Rgb): Rgb {
  const source = parseCssColor(reference) as Rgb;
  const sourceHsl = rgbToHsl(source);
  const accentHsl = rgbToHsl(accent);
  if (sourceHsl.s === 0 || accentHsl.s === 0) {
    return hslToRgb({ h: accentHsl.h, s: 0, l: sourceHsl.l });
  }
  const saturationScale = Math.max(0.35, Math.min(1.15, accentHsl.s / 0.44));
  return hslToRgb({
    h: accentHsl.h,
    s: Math.min(0.38, sourceHsl.s * saturationScale),
    l: sourceHsl.l,
  });
}

export function deriveThemeChromePalette(
  value: string,
  scheme: AppColorScheme,
): ThemeChromePalette {
  const normalized = normalizeThemeAccent(value) ?? DEFAULT_THEME_ACCENT;
  const references = DEFAULT_CHROME_PALETTES[scheme];
  if (normalized === DEFAULT_THEME_ACCENT) return references;
  const accent = parseCssColor(normalized) as Rgb;
  const color = (reference: string) => toHex(recolorReference(reference, accent));
  const channels = (reference: string) => toRgbChannels(recolorReference(reference, accent));
  return {
    bg: color(references.bg),
    surface: color(references.surface),
    surface2: color(references.surface2),
    surface3: color(references.surface3),
    surface4: color(references.surface4),
    text: color(references.text),
    textDim: color(references.textDim),
    textMuted: color(references.textMuted),
    textFaint: color(references.textFaint),
    border: color(references.border),
    borderStrong: color(references.borderStrong),
    controlHover: color(references.controlHover),
    terminal: color(references.terminal),
    backdropRgb: channels(`rgb(${references.backdropRgb})`),
    menuShadowRgb: channels(`rgb(${references.menuShadowRgb})`),
    footerShadowRgb: channels(`rgb(${references.footerShadowRgb})`),
    checkerDark: color(references.checkerDark),
    checkerLight: color(references.checkerLight),
  };
}

export function normalizeThemeAccent(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(input);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[\da-f]{6}$/i.test(input) ? input.toLowerCase() : null;
}

export function deriveAccentPalette(
  value: string,
  scheme: AppColorScheme,
): AccentPalette {
  const normalized = normalizeThemeAccent(value) ?? DEFAULT_THEME_ACCENT;
  if (normalized === DEFAULT_THEME_ACCENT) return DEFAULT_ACCENT_PALETTES[scheme];

  const main = parseCssColor(normalized) as Rgb;
  const white = { r: 255, g: 255, b: 255 };
  const nearBlack = { r: 13, g: 11, b: 17 };
  const hover = mix(main, scheme === 'dark' ? white : nearBlack, scheme === 'dark' ? 0.14 : 0.12);
  const active = mix(main, nearBlack, scheme === 'dark' ? 0.16 : 0.22);
  const deep = mix(main, nearBlack, 0.34);
  const chrome = deriveThemeChromePalette(normalized, scheme);
  const backgrounds = [chrome.bg, chrome.surface, chrome.surface2, chrome.surface3];
  const brightValue = increaseColorContrast(normalized, backgrounds, 4.5, scheme);
  const bright = parseCssColor(brightValue) as Rgb;
  const on = contrastRatio(white, main) >= contrastRatio(nearBlack, main) ? white : nearBlack;

  return {
    main: normalized,
    hover: toHex(hover),
    active: toHex(active),
    bright: toHex(bright),
    on: toHex(on),
    hoverOn: toHex(on),
    indicator: toHex(on),
    deep: toHex(deep),
    rgb: toRgbChannels(main),
    brightRgb: toRgbChannels(bright),
    raySoftRgb: toRgbChannels(mix(bright, white, 0.42)),
    rayCoreRgb: toRgbChannels(mix(bright, white, 0.18)),
    rayTailRgb: toRgbChannels(mix(main, white, 0.12)),
    preparingRgb: toRgbChannels(hover),
    cropFillRgb: toRgbChannels(mix(main, white, 0.25)),
  };
}

const ACCENT_STYLE_TOKENS = [
  '--accent-primary',
  '--accent-primary-hover',
  '--accent-primary-active',
  '--accent-primary-bright',
  '--accent-primary-on',
  '--accent-primary-hover-on',
  '--accent-primary-indicator',
  '--accent-primary-deep',
  '--accent-primary-rgb',
  '--accent-primary-bright-rgb',
  '--accent-primary-ray-soft-rgb',
  '--accent-primary-ray-core-rgb',
  '--accent-primary-ray-tail-rgb',
  '--accent-primary-preparing-rgb',
  '--accent-primary-crop-fill-rgb',
  '--accent-bg',
  '--accent-surface',
  '--accent-surface-2',
  '--accent-surface-3',
  '--accent-surface-4',
  '--accent-text',
  '--accent-text-dim',
  '--accent-text-muted',
  '--accent-text-faint',
  '--accent-border',
  '--accent-border-strong',
  '--accent-control-hover',
  '--accent-terminal',
  '--accent-backdrop-rgb',
  '--accent-menu-shadow-rgb',
  '--accent-footer-shadow-rgb',
] as const;

export function applyThemeAccent(
  value: string,
  scheme: AppColorScheme,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
) {
  if (!root) return;
  for (const token of ACCENT_STYLE_TOKENS) root.style.removeProperty(token);
  const palette = deriveAccentPalette(value, scheme);
  const chrome = deriveThemeChromePalette(value, scheme);
  root.style.setProperty('--accent-primary', palette.main);
  root.style.setProperty('--accent-primary-hover', palette.hover);
  root.style.setProperty('--accent-primary-active', palette.active);
  root.style.setProperty('--accent-primary-bright', palette.bright);
  root.style.setProperty('--accent-primary-on', palette.on);
  root.style.setProperty('--accent-primary-hover-on', palette.hoverOn);
  root.style.setProperty('--accent-primary-indicator', palette.indicator);
  root.style.setProperty('--accent-primary-deep', palette.deep);
  root.style.setProperty('--accent-primary-rgb', palette.rgb);
  root.style.setProperty('--accent-primary-bright-rgb', palette.brightRgb);
  root.style.setProperty('--accent-primary-ray-soft-rgb', palette.raySoftRgb);
  root.style.setProperty('--accent-primary-ray-core-rgb', palette.rayCoreRgb);
  root.style.setProperty('--accent-primary-ray-tail-rgb', palette.rayTailRgb);
  root.style.setProperty('--accent-primary-preparing-rgb', palette.preparingRgb);
  root.style.setProperty('--accent-primary-crop-fill-rgb', palette.cropFillRgb);
  root.style.setProperty('--accent-bg', chrome.bg);
  root.style.setProperty('--accent-surface', chrome.surface);
  root.style.setProperty('--accent-surface-2', chrome.surface2);
  root.style.setProperty('--accent-surface-3', chrome.surface3);
  root.style.setProperty('--accent-surface-4', chrome.surface4);
  root.style.setProperty('--accent-text', chrome.text);
  root.style.setProperty('--accent-text-dim', chrome.textDim);
  root.style.setProperty('--accent-text-muted', chrome.textMuted);
  root.style.setProperty('--accent-text-faint', chrome.textFaint);
  root.style.setProperty('--accent-border', chrome.border);
  root.style.setProperty('--accent-border-strong', chrome.borderStrong);
  root.style.setProperty('--accent-control-hover', chrome.controlHover);
  root.style.setProperty('--accent-terminal', chrome.terminal);
  root.style.setProperty('--accent-backdrop-rgb', chrome.backdropRgb);
  root.style.setProperty('--accent-menu-shadow-rgb', chrome.menuShadowRgb);
  root.style.setProperty('--accent-footer-shadow-rgb', chrome.footerShadowRgb);
}
