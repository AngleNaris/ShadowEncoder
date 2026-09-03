import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('编码 UI 在同一格式选单中提供音频输出并隐藏独立输出类型', async () => {
  const source = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');

  assert.match(source, /<ui\.FieldLabel>编码级别<\/ui\.FieldLabel>/);
  assert.match(source, /受限可变码率/);
  assert.match(source, /<ui\.FieldLabel>最大码率<\/ui\.FieldLabel>/);
  assert.match(source, /<ui\.FieldLabel>码率缓冲<\/ui\.FieldLabel>/);
  assert.match(source, /const AUDIO_OUTPUT_OPTIONS = \[/);
  assert.match(source, /function formatOptions\(videoCodec: string\) \{[\s\S]*AUDIO_OUTPUT_OPTIONS/);
  assert.match(source, /function outputKindForContainer\(container: string\)/);
  assert.match(source, /isAudioOutputFormat\(form\.container, form\.outputKind\)/);
  assert.match(source, /const outputKind = outputKindForContainer\(c\);/);
  assert.match(source, /Ogg Opus/);
  assert.doesNotMatch(source, /OUTPUT_KIND_OPTIONS/);
  assert.doesNotMatch(source, /<ui\.FieldLabel>输出类型<\/ui\.FieldLabel>/);
  assert.doesNotMatch(source, />只输出音频</);
  assert.match(source, /不输出音轨/);
  assert.match(source, /指定长边/);
  assert.match(source, /指定短边/);
  assert.doesNotMatch(source, /<ui\.FieldLabel>风格<\/ui\.FieldLabel>/);
});

test('编码器只展示兼容码控和像素格式并移除图片与 GIF 输出', async () => {
  const source = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');
  const codecOptions = source.slice(
    source.indexOf('const VIDEO_CODEC_OPTIONS'),
    source.indexOf('const X264_PRESET_OPTIONS'),
  );

  assert.doesNotMatch(codecOptions, /value: '(?:gif|mjpeg)'/);
  assert.match(source, /NO_RATE_CONTROL_CODECS = new Set\(\['copy', 'prores', 'dnxhd', 'ffv1'\]\)/);
  assert.match(source, /BITRATE_ONLY_CODECS = new Set\(\['mpeg4', 'mpeg2video'\]\)/);
  assert.match(source, /compatibleRateModes\(form\.videoCodec\)/);
  assert.match(source, /compatiblePixelFormats\(form\.videoCodec\)/);
  assert.match(source, /if \(rateModeOptions\.length > 0\)/);
  assert.match(source, /if \(pixelFormatOptions\.length > 0\)/);
  assert.doesNotMatch(source, /编码规格 \/ Profile|编码级别 \/ Level|最大码率 \(maxrate\)|缓冲区 \(bufsize\)|调优 \(tune\)/);
});

test('音频格式会让参数摘要移除视频专属项', async () => {
  const source = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');

  assert.match(source, /const isAudioOutput = p\.outputKind === 'audio' \|\| p\.audioOnly;/);
  assert.match(source, /rows = isAudioOutput[\s\S]*?\{ k: '音频格式'/);
  assert.match(source, /\{ k: '封装'[\s\S]*?\{ k: '视频'/);
});

test('预设分辨率首次切换保持自定义输入可用且旧音频选项会迁移', async () => {
  const [source, uiSource] = await Promise.all([
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /setResSel\(scaleMode === 'dimensions' \? '__custom__' : ''\)/);
  assert.match(source, /<PresetManageDialog[\s\S]*?title="管理转码预设"[\s\S]*?scrollEditor/);
  assert.match(source, /className="se-resolution-config"[\s\S]*?resSel === '__custom__'[\s\S]*?className="se-res-row"/);
  assert.match(source, /customResolutionRef\.current\?\.scrollIntoView\(\{ block: 'nearest', behavior: 'smooth' \}\)/);
  assert.match(uiSource, /new ResizeObserver\(\(\) => \{[\s\S]*?inner\.scrollHeight[\s\S]*?outer\.style\.height/);

  const presetAudioStart = source.indexOf('{tab === 3 && (');
  const presetPostStart = source.indexOf('{tab === 4 && (', presetAudioStart);
  const presetAudio = source.slice(presetAudioStart, presetPostStart);
  assert.ok(presetAudio.indexOf('audioFieldRows') < presetAudio.indexOf('启用音频标准化'));
  assert.doesNotMatch(presetAudio, /只输出音频/);

  const inlineAudioStart = source.indexOf('<ui.ParamGroup title="音频">');
  const inlinePostStart = source.indexOf('<ui.ParamGroup title="后期处理">', inlineAudioStart);
  const inlineAudio = source.slice(inlineAudioStart, inlinePostStart);
  assert.ok(inlineAudio.indexOf('audioFieldRows') < inlineAudio.indexOf('启用音频标准化'));
  assert.doesNotMatch(inlineAudio, /只输出音频/);
  assert.match(source, /const \{ audioOnly: legacyAudioOnly, \.\.\.rest \} = source;/);
  assert.match(source, /isAudioOutputFormat\([\s\S]*source\.outputKind === 'audio' \|\| legacyAudioOnly/);
  assert.match(source, /const outputKind = isAudioOutputFormat\(form\.container, form\.outputKind\) \? 'audio' : 'video';/);

  const postProcessing = source.slice(inlinePostStart, source.indexOf('<ui.ParamGroup title="任务设置">', inlinePostStart));
  assert.doesNotMatch(postProcessing, /音频标准化/);
});

test('编码后端使用真实参数并允许降噪与去块组合', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');

  assert.match(source, /if audio_only \{[\s\S]*"-vn"\.into\(\)/);
  assert.match(source, /if no_audio \{[\s\S]*output_args\.push\("-an"\.into\(\)\)/);
  assert.match(source, /"-level:v"\.into\(\)/);
  assert.match(source, /"-maxrate"\.into\(\)/);
  assert.match(source, /"-bufsize"\.into\(\)/);
  assert.match(source, /unsharp=5:5:\{unsharp:\.2\}/);
  assert.match(source, /hqdn3d=\{denoise:\.2\}/);
  assert.match(source, /deblock=filter=strong/);
});

test('转码默认命名移除 _se 后缀并继续自动避开同名文件', async () => {
  const [app, tabs, rust] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /按预设参数批量转码，自动避开同名文件/);
  assert.doesNotMatch(app, /输出 _se\.mp4/);
  assert.doesNotMatch(tabs, /defaultSuffix="_se"/);
  assert.match(rust, /resolve_output_path\(p, output_options\.as_ref\(\), "", ext\)/);
  assert.match(rust, /fn transcode_without_a_preset_uses_a_unique_plain_filename\(\)/);
});
