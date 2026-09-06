import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('script contract accepts preprocessing only and rejects encoding and output options', () => {
  const source = readFileSync(new URL('../src/lib/workflowScript.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: () => ({}) });
  const plan = { filterComplex: '[0:v]null[out]', duration: 1 };
  assert.equal(exports.validateScriptPlan(plan).filterComplex, plan.filterComplex);
  for (const field of ['format', 'codec', 'crf', 'presetId', 'outputPath']) {
    assert.throws(() => exports.validateScriptPlan({ ...plan, [field]: 'value' }), /编码、格式和输出设置/);
  }
  assert.throws(() => exports.validateScriptPlan({ ...plan, duration: Infinity }), /duration/);
});

test('sparse encoding presets preserve defaults and transcode accepts numeric form strings', async () => {
  const tabs = readFileSync(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');
  const start = tabs.indexOf('export function normalizeEncodeParams(');
  const source = tabs.slice(start, tabs.indexOf('\n}\n', start) + 3);
  const normalizedExports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: normalizedExports,
    isAudioOutputFormat: () => false,
    preferredAudioCodec: (_container, _kind, codec) => codec,
  });
  const params = normalizedExports.normalizeEncodeParams({ crf: 20 });
  const merged = { tune: 'none', videoCodec: 'libx264', ...params };
  assert.equal(merged.tune, 'none');
  assert.equal(merged.videoCodec, 'libx264');
  assert.equal(merged.crf, 20);

  const exports = {};
  let request;
  const ffmpeg = readFileSync(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(ffmpeg, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    require: () => ({
      invoke: (_command, args) => { request = args; return Promise.resolve({}); },
      buildEncodeNameLabels: () => ({}),
      applyOutputOverride: (options) => options,
    }),
  });
  await exports.transcode({ crf: '20', fps: '', outputOptions: {} });
  assert.equal(request.crf, 20);
  assert.equal(request.fps, 0);
  await assert.rejects(async () => exports.transcode({ fps: 'invalid', outputOptions: {} }), /fps/);
});
