import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPresetUiFieldDisabled,
  isPresetUiFieldVisible,
} from '../src/lib/presetUiRules.ts';

test('混音预设和主界面共享开关禁用规则', () => {
  assert.equal(isPresetUiFieldDisabled('mix', 'lnI', { lnOn: false }), true);
  assert.equal(isPresetUiFieldDisabled('mix', 'lnTp', { lnOn: true }), false);
  assert.equal(isPresetUiFieldDisabled('mix', 'cpTh', { tpOn: false }), true);
  assert.equal(isPresetUiFieldDisabled('mix', 'cpGain', { tpOn: true }), false);
});

test('检测和透明通道只在前置选择生效时启用数字输入', () => {
  assert.equal(isPresetUiFieldDisabled('check', 'fpsTol', { refEncPresetId: '' }), true);
  assert.equal(isPresetUiFieldDisabled('check', 'fpsTol', { refEncPresetId: 'enc-default-1' }), false);
  assert.equal(isPresetUiFieldDisabled('alpha', 'fps', { fpsOriginal: true }), true);
  assert.equal(isPresetUiFieldDisabled('alpha', 'fps', { fpsOriginal: false }), false);
});

test('比例、固定时长和截取帧率沿用主界面的显示与禁用逻辑', () => {
  for (const type of ['screenshot', 'segment', 'gif', 'webp']) {
    assert.equal(isPresetUiFieldVisible(type, 'customRatio', { aspect: 'custom' }), true);
    assert.equal(isPresetUiFieldVisible(type, 'customRatio', { aspect: '16:9' }), false);
    assert.equal(isPresetUiFieldDisabled(type, 'w', { aspect: 'free' }), true);
    assert.equal(isPresetUiFieldDisabled(type, 'h', { aspect: 'match' }), true);
    assert.equal(isPresetUiFieldDisabled(type, 'w', { aspect: '16:9' }), false);
  }
  assert.equal(isPresetUiFieldVisible('segment', 'fps', {}), false);
  assert.equal(isPresetUiFieldVisible('gif', 'fps', {}), true);
  assert.equal(isPresetUiFieldDisabled('segment', 'fixedVal', { fixedDur: false }), true);
  assert.equal(isPresetUiFieldDisabled('webp', 'fixedVal', { fixedDur: true }), false);
});
