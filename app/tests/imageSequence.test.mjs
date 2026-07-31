import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('工具栏提供序列帧并贯通前端参数与 Tauri 命令', async () => {
  const [app, tabs, bridge, presets, storage, rust] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/presetStorage.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /key: "sequence", label: "序列帧"[\s\S]*<ExportTab format="sequence" \/>/);
  assert.match(tabs, /format: 'gif' \| 'webp' \| 'sequence' \| 'clip'/);
  assert.match(tabs, /exportImageSequence\(file, exportStart, exportDuration, fps, w, h, imageFormat, quality, pngCompression/);
  assert.match(tabs, /type=\{[\s\S]*format === 'sequence' \? 'sequence'/);
  assert.match(bridge, /invoke<string>\('export_image_sequence'/);
  assert.match(rust, /fn export_image_sequence_blocking\(/);
  assert.match(rust, /async fn export_image_sequence\(/);
  assert.match(rust, /"frame_%06d\.\{extension\}"/);
  assert.match(rust, /export_image_sequence,[\s\S]*export_segment/);
  assert.match(storage, /'webp', 'sequence', 'backup'/);
  assert.match(presets, /sequence: '序列帧'/);
});

test('序列帧图片格式不包含 GIF 且后端拒绝非视频输入', async () => {
  const [presets, rust] = await Promise.all([
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);
  const formats = presets.slice(
    presets.indexOf('export const IMAGE_SEQUENCE_FORMAT_OPTIONS'),
    presets.indexOf('export const DEFAULT_BACKUP_PRESET_PARAMS'),
  );

  assert.match(formats, /value: 'jpg'/);
  assert.match(formats, /value: 'png'/);
  assert.match(formats, /value: 'webp'/);
  assert.match(formats, /value: 'tiff'/);
  assert.match(formats, /value: 'bmp'/);
  assert.doesNotMatch(formats, /value: 'gif'/);
  assert.match(rust, /fn ensure_video_input\([\s\S]*当前功能不支持该素材类型/);
  assert.match(rust, /fn export_image_sequence_blocking\([\s\S]*ensure_video_input\(&input\)\?/);
});

test('指定目录并重命名贯通输出表单、类型、后端与 Agent schema', async () => {
  const [outputSettings, bridge, rust, schema] = await Promise.all([
    readFile(new URL('../src/components/OutputSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
    readFile(new URL('../agent-core/src/schema.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(bridge, /OutputMode = 'source' \| 'rename' \| 'subdir' \| 'fixed' \| 'fixedRename'/);
  assert.match(outputSettings, /label: '指定目录并重命名', value: 'fixedRename'/);
  assert.match(outputSettings, /outputMode === 'rename' \|\| output\.outputMode === 'fixedRename'/);
  assert.match(outputSettings, /outputMode === 'fixed' \|\| output\.outputMode === 'fixedRename'/);
  assert.match(rust, /mode @ \("rename" \| "fixedRename"\)[\s\S]*mode == "fixedRename"/);
  assert.match(schema, /"outputMode" => Some\(&\["source", "rename", "subdir", "fixed", "fixedRename"\]\)/);
});

test('完整素材序列帧逐文件读取时长并始终使用独立输出目录', async () => {
  const [tabs, presets, rules, rust] = await Promise.all([
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/presetUiRules.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(tabs, /format === 'sequence' && fullDuration/);
  assert.match(tabs, /完整素材长度/);
  assert.match(tabs, /if \(fullMaterialRange\)[\s\S]*await getVideoInfo\(file\)[\s\S]*exportDuration = fileInfo\.duration/);
  assert.match(presets, /key: 'fullDuration', label: '完整素材长度', kind: 'checkbox'/);
  assert.match(rust, /unique_output_directory\(marker\.with_extension\(""\)\)\?/);
  assert.match(rust, /output_directory\.join\(format!\("frame_%06d\.\{extension\}"\)\)/);
  assert.match(tabs, /<ui\.AnimatedFieldGrid tight rows=/);
  assert.match(tabs, /format === 'sequence' && imageFormat === 'png'/);
  assert.match(rules, /type === 'screenshot' \|\| type === 'sequence'[\s\S]*key === 'quality'[\s\S]*state\.imageFormat === 'jpg' \|\| state\.imageFormat === 'webp'/);
  assert.match(rules, /key === 'pngCompression'[\s\S]*state\.imageFormat === 'png'/);
  assert.match(rust, /"png" => args\.extend\(\[[\s\S]*"-compression_level"/);
});

test('截图支持选择图片格式并复用 PNG 压缩参数', async () => {
  const [app, tabs, bridge, presets, rust, schema] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
    readFile(new URL('../agent-core/src/schema.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /key: "shot"[\s\S]*按时间点与裁剪区域导出图片/);
  assert.match(tabs, /type="screenshot"[\s\S]*imageFormat, quality, pngCompression/);
  assert.match(tabs, /screenshotFrame\(file, ts, w, h, imageFormat, quality, pngCompression/);
  assert.match(tabs, /title="输出参数 \(截图\)"[\s\S]*IMAGE_SEQUENCE_FORMAT_OPTIONS/);
  assert.match(bridge, /invoke<string>\('screenshot', \{ input, timeSec, width, height, imageFormat, quality, pngCompression/);
  assert.match(presets, /screenshot: \[[\s\S]*key: 'imageFormat'[\s\S]*key: 'pngCompression'/);
  assert.match(rust, /fn screenshot_blocking\([\s\S]*image_format: String,[\s\S]*png_compression: i32/);
  assert.match(schema, /"screenshot" => \{[\s\S]*"imageFormat"[\s\S]*"pngCompression"/);
});
