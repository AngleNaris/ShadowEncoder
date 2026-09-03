import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  APP_HIGH_CONTRAST_STORAGE_KEY,
  APP_THEME_ACCENT_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
  readHighContrast,
  readThemeAccent,
  readThemePreference,
  resolveThemePreference,
  saveHighContrast,
  saveThemeAccent,
  saveThemePreference,
} from '../src/lib/themePreference.ts';
import {
  contrastRatio,
  increaseColorContrast,
  parseCssColor,
} from '../src/lib/colorContrast.ts';
import {
  DEFAULT_THEME_ACCENT,
  deriveAccentPalette,
  deriveThemeChromePalette,
  normalizeThemeAccent,
} from '../src/lib/themeAccent.ts';

test('主题偏好默认保持现有深色外观并解析系统主题', () => {
  const emptyStorage = { getItem: () => null };
  assert.equal(readThemePreference(emptyStorage), 'dark');
  assert.equal(resolveThemePreference('dark', false), 'dark');
  assert.equal(resolveThemePreference('light', true), 'light');
  assert.equal(resolveThemePreference('system', true), 'dark');
  assert.equal(resolveThemePreference('system', false), 'light');
});

test('主题偏好只接受已知值并可持久化', () => {
  assert.equal(readThemePreference({ getItem: () => 'light' }), 'light');
  assert.equal(readThemePreference({ getItem: () => 'unknown' }), 'dark');
  assert.equal(readHighContrast({ getItem: () => 'true' }), true);
  assert.equal(readHighContrast({ getItem: () => 'false' }), false);
  assert.equal(readThemeAccent({ getItem: () => '#23858C' }), '#23858c');
  assert.equal(readThemeAccent({ getItem: () => 'invalid' }), DEFAULT_THEME_ACCENT);

  const writes = [];
  const storage = { setItem: (key, value) => writes.push([key, value]) };
  saveThemePreference('system', storage);
  saveHighContrast(true, storage);
  saveThemeAccent('#23858C', storage);
  assert.deepEqual(writes, [
    [APP_THEME_STORAGE_KEY, 'system'],
    [APP_HIGH_CONTRAST_STORAGE_KEY, 'true'],
    [APP_THEME_ACCENT_STORAGE_KEY, '#23858c'],
  ]);
});

test('自定义主题色规范化并为深浅模式派生可读色阶', () => {
  assert.equal(normalizeThemeAccent('#38a'), '#3388aa');
  assert.equal(normalizeThemeAccent('#23858C'), '#23858c');
  assert.equal(normalizeThemeAccent('23858c'), null);

  const dark = deriveAccentPalette('#f1c40f', 'dark');
  const light = deriveAccentPalette('#23858c', 'light');
  const darkMain = parseCssColor(dark.main);
  const darkOn = parseCssColor(dark.on);
  const lightBright = parseCssColor(light.bright);
  const lightSurface = parseCssColor('#ffffff');
  assert.ok(darkMain && darkOn && lightBright && lightSurface);
  assert.ok(contrastRatio(darkOn, darkMain) >= 4.5);
  assert.ok(contrastRatio(lightBright, lightSurface) >= 4.5);
  assert.notEqual(dark.hover, dark.active);
  assert.notEqual(dark.cropFillRgb, '150, 138, 200');
  assert.notEqual(light.preparingRgb, '126, 111, 182');

  const greenChrome = deriveThemeChromePalette('#3f7f5f', 'dark');
  const amberChrome = deriveThemeChromePalette('#9b6a2f', 'light');
  assert.notEqual(greenChrome.bg, '#0d0b11');
  assert.notEqual(greenChrome.surface3, '#232029');
  assert.notEqual(greenChrome.controlHover, '#605870');
  assert.notEqual(greenChrome.checkerDark, '#1a1820');
  assert.notEqual(amberChrome.surface2, '#f7f5f9');
  assert.notEqual(amberChrome.borderStrong, '#c9c2d1');
  assert.equal(deriveThemeChromePalette(DEFAULT_THEME_ACCENT, 'dark').bg, '#0d0b11');

  assert.deepEqual(deriveAccentPalette(DEFAULT_THEME_ACCENT, 'dark'), {
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
  });
});

test('主题色贯通 Windows 原生播放器选区', async () => {
  const [videoPlayer, bridge, windowsPlayer, mpvPlayer] = await Promise.all([
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/mpv_windows.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/mpv_player.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(videoPlayer, /deriveThemeChromePalette\(accentColor, colorScheme\)/);
  assert.match(videoPlayer, /themeChrome\.checkerDark/);
  assert.match(videoPlayer, /accentColor: nativeSelectionAccent/);
  assert.match(bridge, /accentColor\?: string/);
  assert.match(windowsPlayer, /pub accent_color: Option<String>/);
  assert.match(windowsPlayer, /interaction\.accent_bgr = accent_bgr/);
  assert.match(mpvPlayer, /\\1c&H\{accent_bgr:06X\}&/);
});

test('高对比度通过亮度算法提升文字对比度而不是使用固定覆盖色', () => {
  const darkBackgrounds = ['#0d0b11', '#15131a', '#1b1921'];
  const adjustedDark = increaseColorContrast('#605870', darkBackgrounds, 4.5, 'dark');
  const darkForeground = parseCssColor(adjustedDark);
  const darkBackground = parseCssColor('#1b1921');
  assert.ok(darkForeground && darkBackground);
  assert.ok(contrastRatio(darkForeground, darkBackground) >= 4.5);

  const lightBackgrounds = ['#f3f2f6', '#ffffff', '#f7f5f9'];
  const adjustedLight = increaseColorContrast('#99919f', lightBackgrounds, 4.5, 'light');
  const lightForeground = parseCssColor(adjustedLight);
  const lightBackground = parseCssColor('#ffffff');
  assert.ok(lightForeground && lightBackground);
  assert.ok(contrastRatio(lightForeground, lightBackground) >= 4.5);
  assert.notEqual(adjustedDark, adjustedLight);
});

test('Logo 打开应用设置，主题基础设施不改变默认暗色 token', async () => {
  const [app, main, provider, css, muiTheme, ui] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/AppThemeProvider.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/muiTheme.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /className="se-rail-brand"[\s\S]*onClick=\{openSettings\}/);
  assert.match(app, /Array\.from\(\{ length: 14 \}, \(_, index\) => <i key=\{index\} \/>\)/);
  assert.match(app, /const openSettings = useCallback\(\(\) => setSettingsOpen\(true\), \[\]\)/);
  assert.doesNotMatch(app, /settingsModalReleaseRef|registerModalLayer\(\)/);
  assert.match(app, /<span className="se-dialog-title">应用设置<\/span>/);
  assert.match(app, /value: 'system', label: '跟随系统'/);
  assert.match(app, /value: 'dark', label: '深色'/);
  assert.match(app, /value: 'light', label: '浅色'/);
  assert.match(app, /<ui\.Checkbox checked=\{highContrast\} onChange=\{onHighContrastChange\}>[\s\S]*高对比度/);
  assert.match(app, /className="se-settings-swatches"[\s\S]*type="color"[\s\S]*se-settings-hex-input/);
  assert.match(app, /role="radiogroup"[\s\S]*role="radio"[\s\S]*aria-checked/);
  assert.doesNotMatch(app, /<span>(?:显示|可读性)<\/span>|se-settings-accent-value/);
  assert.match(app, /<div className="se-dialog-foot">\s*<ui\.Button icon=\{<IconClose size=\{14\} \/>\} onClick=\{onClose\}>关闭<\/ui\.Button>/);
  assert.match(main, /initializeAppTheme\(\);[\s\S]*applyThemeAccent\([\s\S]*applyHighContrastTokens\(/);
  assert.match(provider, /applyThemeAccent\(accentColor, colorScheme\);[\s\S]*applyHighContrastTokens\(highContrast, colorScheme\)/);
  assert.match(provider, /query\.addEventListener\('change', update\)/);
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*--bg: var\(--accent-bg, #0d0b11\);[\s\S]*--primary: var\(--accent-primary, #6d5da5\);[\s\S]*--tooltip-text: #ffffff;\s*\}/);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--bg: var\(--accent-bg, #f3f2f6\);[\s\S]*--tooltip-text: #211d28;\s*\}/);
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let braceDepth = 0;
  for (const character of cssWithoutComments) {
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth -= 1;
    assert.ok(braceDepth >= 0, 'CSS contains an unmatched closing brace');
  }
  assert.equal(braceDepth, 0, 'CSS contains an unclosed rule');
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*--params-foot-shadow: 0 -8px 18px -10px rgba\(var\(--accent-footer-shadow-rgb, 0, 0, 0\), 0\.7\);[\s\S]*--progress-label-shadow: 0 0 4px rgba\(0, 0, 0, 0\.85\)/);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--params-foot-shadow: 0 -8px 18px -10px rgba\(var\(--accent-footer-shadow-rgb, 216, 208, 229\), 0\.9\);[\s\S]*--progress-label-shadow: 0 0 4px rgba\(255, 255, 255, 0\.95\)/);
  assert.match(css, /\.se-range-marker::after[\s\S]*color-mix\(in srgb, var\(--bg\) 65%, transparent\)/);
  assert.match(css, /--ctrl-border-hover: var\(--accent-control-hover/);
  assert.match(css, /background: var\(--terminal-bg\)/);
  assert.match(css, /background: rgba\(var\(--backdrop-rgb\), 0\.72\)/);
  assert.match(css, /rgba\(var\(--primary-ray-core-rgb\), 0\.78\)/);
  assert.match(css, /rgba\(var\(--primary-preparing-rgb\), 0\.16\)/);
  assert.match(css, /rgba\(var\(--primary-crop-fill-rgb\), 0\.15\)/);
  assert.doesNotMatch(css, /rgba\((?:178, 162, 237|126, 111, 182|150, 138, 200),/);
  assert.doesNotMatch(css, /data-contrast="high"/);
  assert.match(css, /\.se-rail \{[\s\S]*border-right: 0;[\s\S]*box-shadow: inset -1px 0 0 var\(--border\);/);
  assert.match(css, /\.se-rail-brand \{\s*height: 69px;[\s\S]*button\.se-rail-brand \{[\s\S]*min-height: 69px;/);
  assert.match(css, /\.se-rail-brand-icon \{\s*width: 32px;\s*height: 32px;/);
  assert.match(css, /\.se-brand-rays > i::before,[\s\S]*\.se-brand-rays > i::after[\s\S]*se-brand-ray-shoot/);
  assert.match(css, /@keyframes se-brand-ray-core-blur[\s\S]*var\(--se-ray-start-blur\)[\s\S]*var\(--se-ray-end-blur\)/);
  assert.match(css, /@keyframes se-brand-ray-haze[\s\S]*var\(--se-ray-haze-end\)/);
  assert.match(css, /se-brand-ray-shoot var\(--se-ray-duration\) linear var\(--se-ray-delay\) infinite/);
  assert.match(css, /--se-ray-core-width: 0\.6px;[\s\S]*--se-ray-core-width: 3px;/);
  assert.match(css, /--se-ray-haze-width: 2\.4px;[\s\S]*--se-ray-haze-width: 7\.6px;/);
  assert.match(css, /100% \{ opacity: 0; transform: translateX\(-50%\) translateY\(var\(--se-ray-end\)\); \}/);
  const rayCss = css.slice(css.indexOf('.se-brand-rays > i'), css.indexOf('.se-rail-nav'));
  assert.doesNotMatch(rayCss, /cubic-bezier|scaleX/);
  assert.doesNotMatch(css, /\.se-brand-rays::before|se-brand-glow-breathe/);
  assert.match(css, /button\.se-rail-brand[\s\S]*background: transparent;[\s\S]*border-color: var\(--border\);/);
  assert.match(css, /\.se-settings-swatch:hover:not\(:disabled\) \{ background: var\(--swatch-color\); \}/);
  assert.match(css, /\.se-settings-dialog \.se-dialog-foot > button \{[\s\S]*width: 100%;[\s\S]*justify-content: center;/);
  assert.match(css, /\.se-settings-dialog \.se-dialog-foot > button > svg \{ top: 0; \}/);
  assert.match(css, /\.se-context-menu button\s*\{[^}]*justify-content:\s*flex-start;[^}]*text-align:\s*left;/);
  assert.match(css, /\.se-context-menu-group-label\s*\{[^}]*text-align:\s*left;/);
  assert.match(css, /\.se-group-head-toggle\s*\{[^}]*justify-content:\s*flex-start;[^}]*text-align:\s*left;/);
  assert.match(css, /\.se-context-menu\s*\{[^}]*animation:\s*se-context-menu-in 140ms/);
  assert.match(css, /\.se-context-menu\.is-closing\s*\{[^}]*animation:\s*se-context-menu-out 120ms/);
  assert.match(ui, /className=\{`se-context-menu\$\{open \? '' : ' is-closing'\}`\}/);
  assert.match(ui, /onAnimationEnd=\{\(event\) => \{[\s\S]*setMounted\(false\)/);
  assert.match(muiTheme, /export function createMuiTheme\([\s\S]*accentColor = DEFAULT_THEME_ACCENT/);
});
