import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_PRESET_STORAGE_KEY,
  PRESET_STORAGE_KEY,
  PRESET_STORAGE_VERSION,
  PRESET_TYPES,
  emptyPresetStore,
  loadPresetStore,
  serializePresetStore,
} from '../src/lib/presetStorage.ts';

function storageWith(entries) {
  const values = new Map(entries);
  return { getItem: (key) => values.get(key) ?? null };
}

test('全新安装的全部预设类型均为空', () => {
  const store = loadPresetStore(storageWith([]));
  assert.deepEqual(store, emptyPresetStore());
  for (const type of PRESET_TYPES) assert.deepEqual(store[type], []);
});

test('当前版本保留用户预设与显式空列表', () => {
  const custom = {
    version: PRESET_STORAGE_VERSION,
    presets: {
      encode: [{ id: 'user-encode', name: '用户编码', type: 'encode', params: { crf: 18 } }],
      mix: [],
    },
  };
  const store = loadPresetStore(storageWith([[PRESET_STORAGE_KEY, JSON.stringify(custom)]]));
  assert.equal(store.encode[0].id, 'user-encode');
  assert.equal(store.encode[0].revision, 1);
  assert.deepEqual(store.mix, []);
  assert.deepEqual(store.workflow, []);
});

test('旧版本迁移移除应用内置预设但保留用户自建预设', () => {
  const legacy = {
    version: 1,
    presets: {
      encode: [
        { id: 'enc-default-1', name: '旧内置', type: 'encode', params: {} },
        { id: 'user-encode', name: '用户编码', type: 'encode', params: { crf: 20 } },
      ],
      workflow: [
        { id: 'workflow-default-1', name: '旧内置流程', type: 'workflow', params: {} },
        { id: 'user-workflow', name: '用户流程', type: 'workflow', params: { steps: [] } },
      ],
    },
  };
  const store = loadPresetStore(storageWith([[LEGACY_PRESET_STORAGE_KEY, JSON.stringify(legacy)]]));
  assert.deepEqual(store.encode.map((preset) => preset.id), ['user-encode']);
  assert.deepEqual(store.workflow.map((preset) => preset.id), ['user-workflow']);
});

test('序列化只写入当前版本且不生成预设', () => {
  const serialized = JSON.parse(serializePresetStore(emptyPresetStore()));
  assert.equal(serialized.version, PRESET_STORAGE_VERSION);
  assert.deepEqual(serialized.presets, emptyPresetStore());
});
