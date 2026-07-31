import type { AppColorScheme } from './themePreference';

type RgbColor = { r: number; g: number; b: number };

const HIGH_CONTRAST_TOKENS = [
  { token: '--text', minimum: 9 },
  { token: '--text-dim', minimum: 7 },
  { token: '--text-muted', minimum: 7 },
  { token: '--text-faint', minimum: 4.5 },
  { token: '--primary-bright', minimum: 4.5 },
  { token: '--success', minimum: 4.5 },
  { token: '--warning', minimum: 4.5 },
  { token: '--error', minimum: 4.5 },
  { token: '--info', minimum: 4.5 },
] as const;

const SURFACE_TOKENS = ['--bg', '--surface', '--surface-2', '--surface-3', '--surface-4'] as const;
const OVERRIDE_TOKENS = [...HIGH_CONTRAST_TOKENS.map(({ token }) => token), '--tooltip-text'] as const;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function parseCssColor(value: string): RgbColor | null {
  const input = value.trim();
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/i.exec(input);
  if (shortHex) {
    return {
      r: Number.parseInt(shortHex[1] + shortHex[1], 16),
      g: Number.parseInt(shortHex[2] + shortHex[2], 16),
      b: Number.parseInt(shortHex[3] + shortHex[3], 16),
    };
  }
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(input);
  if (hex) {
    return {
      r: Number.parseInt(hex[1], 16),
      g: Number.parseInt(hex[2], 16),
      b: Number.parseInt(hex[3], 16),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(input);
  if (!rgb) return null;
  return {
    r: clampChannel(Number(rgb[1])),
    g: clampChannel(Number(rgb[2])),
    b: clampChannel(Number(rgb[3])),
  };
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: RgbColor): number {
  return 0.2126 * channelLuminance(color.r)
    + 0.7152 * channelLuminance(color.g)
    + 0.0722 * channelLuminance(color.b);
}

export function contrastRatio(foreground: RgbColor, background: RgbColor): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function minimumContrast(color: RgbColor, backgrounds: readonly RgbColor[]): number {
  return Math.min(...backgrounds.map((background) => contrastRatio(color, background)));
}

function mixColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  return {
    r: clampChannel(from.r + (to.r - from.r) * amount),
    g: clampChannel(from.g + (to.g - from.g) * amount),
    b: clampChannel(from.b + (to.b - from.b) * amount),
  };
}

function formatColor(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function increaseColorContrast(
  foregroundValue: string,
  backgroundValues: readonly string[],
  minimumRatio: number,
  scheme: AppColorScheme,
): string {
  const foreground = parseCssColor(foregroundValue);
  const backgrounds = backgroundValues
    .map(parseCssColor)
    .filter((color): color is RgbColor => color != null);
  if (!foreground || backgrounds.length === 0) return foregroundValue.trim();
  if (minimumContrast(foreground, backgrounds) >= minimumRatio) return formatColor(foreground);

  const preferredTarget = scheme === 'dark'
    ? { r: 255, g: 255, b: 255 }
    : { r: 0, g: 0, b: 0 };
  const alternateTarget = scheme === 'dark'
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 };
  const target = minimumContrast(preferredTarget, backgrounds) >= minimumContrast(alternateTarget, backgrounds)
    ? preferredTarget
    : alternateTarget;

  let low = 0;
  let high = 1;
  for (let index = 0; index < 16; index += 1) {
    const amount = (low + high) / 2;
    if (minimumContrast(mixColor(foreground, target, amount), backgrounds) >= minimumRatio) high = amount;
    else low = amount;
  }
  return formatColor(mixColor(foreground, target, high));
}

export function applyHighContrastTokens(
  enabled: boolean,
  scheme: AppColorScheme,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
) {
  if (!root || typeof getComputedStyle !== 'function') return;
  for (const token of OVERRIDE_TOKENS) root.style.removeProperty(token);
  root.dataset.contrast = enabled ? 'high' : 'normal';
  if (!enabled) return;

  const computed = getComputedStyle(root);
  const backgrounds = SURFACE_TOKENS.map((token) => computed.getPropertyValue(token));
  for (const { token, minimum } of HIGH_CONTRAST_TOKENS) {
    const adjusted = increaseColorContrast(
      computed.getPropertyValue(token),
      backgrounds,
      minimum,
      scheme,
    );
    root.style.setProperty(token, adjusted);
  }
  root.style.setProperty(
    '--tooltip-text',
    increaseColorContrast(
      computed.getPropertyValue('--tooltip-text'),
      [computed.getPropertyValue('--surface-3')],
      7,
      scheme,
    ),
  );
}
