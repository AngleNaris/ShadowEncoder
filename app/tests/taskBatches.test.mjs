import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// vm 里创建的数组原型与本域不同，统一转成普通 JSON 结构再断言。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadTaskBatches() {
  const source = readFileSync(new URL('../src/lib/taskBatches.ts', import.meta.url), 'utf8');
  const exports = {};
  const filePathKey = (path) => {
    const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    require: () => ({ filePathKey }),
  });
  return {
    buildTaskInputUnits: (...args) => plain(exports.buildTaskInputUnits(...args)),
    groupSelectionStates: (...args) => plain(exports.groupSelectionStates(...args)),
    moveWithinList: exports.moveWithinList,
    UNGROUPED_LABEL: exports.UNGROUPED_LABEL,
  };
}

const { buildTaskInputUnits, groupSelectionStates, moveWithinList, UNGROUPED_LABEL } = loadTaskBatches();

test('no groups keeps the legacy single batch', () => {
  const plan = buildTaskInputUnits([], ['C:/a/1.mp4'], ['C:/a/1.mp4', 'C:/a/2.mp4']);
  assert.deepEqual(plan.units, []);
  assert.deepEqual(plan.skippedGroups, []);
});

test('groups run first in creation order and ungrouped files go last', () => {
  const plan = buildTaskInputUnits(
    [
      { id: 'g1', label: '组 1', paths: ['C:/a/1.mp4', 'C:/a/2.mp4'] },
      { id: 'g2', label: '组 2', paths: ['C:/b/'] },
    ],
    ['C:/a/1.mp4', 'C:/a/2.mp4', 'C:/b/'],
    ['C:/a/1.mp4', 'C:/a/2.mp4', 'C:/b/x.mp4', 'C:/c/3.mp4'],
  );
  assert.deepEqual(plan.units, [
    { label: '组 1', paths: ['C:/a/1.mp4', 'C:/a/2.mp4'] },
    { label: '组 2', paths: ['C:/b/'] },
    { label: UNGROUPED_LABEL, paths: ['C:/c/3.mp4'] },
  ]);
  assert.deepEqual(plan.skippedGroups, []);
});

test('deselected member is excluded from its group and stays out of the ungrouped batch', () => {
  const plan = buildTaskInputUnits(
    [{ id: 'g1', label: '组 1', paths: ['C:/a/1.mp4', 'C:/a/2.mp4'] }],
    ['C:/a/1.mp4'],
    ['C:/a/1.mp4'],
  );
  assert.deepEqual(plan.units, [{ label: '组 1', paths: ['C:/a/1.mp4'] }]);
  assert.deepEqual(plan.skippedGroups, []);
});

test('group with no selected member is skipped and reported', () => {
  const plan = buildTaskInputUnits(
    [
      { id: 'g1', label: '组 1', paths: ['C:/a/1.mp4'] },
      { id: 'g2', label: '组 2', paths: ['C:/b/2.mp4'] },
    ],
    [],
    ['C:/b/2.mp4'],
  );
  assert.deepEqual(plan.units, [{ label: '组 2', paths: ['C:/b/2.mp4'] }]);
  assert.deepEqual(plan.skippedGroups, ['组 1']);
});

test('member matching normalizes Windows separators and drive case', () => {
  const plan = buildTaskInputUnits(
    [{ id: 'g1', label: '组 1', paths: ['c:\\A\\1.mp4'] }],
    ['C:/a/1.mp4'],
    ['C:/a/1.mp4'],
  );
  assert.deepEqual(plan.units, [{ label: '组 1', paths: ['C:/a/1.mp4'] }]);
});

test('fully selected directory member does not duplicate its leaves', () => {
  const plan = buildTaskInputUnits(
    [{ id: 'g1', label: '组 1', paths: ['C:/a/'] }],
    ['C:/a/'],
    ['C:/a/1.mp4', 'C:/a/2.mp4'],
  );
  assert.deepEqual(plan.units, [{ label: '组 1', paths: ['C:/a/'] }]);
});

test('group selection state derives from member selection', () => {
  const groups = [
    { id: 'g1', label: '组 1', paths: ['C:/a/1.mp4', 'C:/a/2.mp4'] },
    { id: 'g2', label: '组 2', paths: ['C:/b/'] },
    { id: 'g3', label: '组 3', paths: ['C:/c/1.mp4'] },
  ];
  const states = groupSelectionStates(groups, ['C:/a/1.mp4', 'C:/a/2.mp4'], [
    'C:/a/1.mp4', 'C:/a/2.mp4', 'C:/b/x.mp4',
  ]);
  assert.deepEqual(states.map((state) => state.state), ['checked', 'partial', 'unchecked']);
  assert.deepEqual(states.map((state) => state.selectedCount), [2, 1, 0]);
});

test('group member under a fully selected ancestor counts as checked', () => {
  const groups = [
    { id: 'g1', label: '组 1', paths: ['C:/root/a.mp4', 'C:/root/sub'] },
  ];
  const states = groupSelectionStates(groups, ['C:/root'], []);
  assert.deepEqual(states.map((state) => state.state), ['checked']);
  assert.deepEqual(states.map((state) => state.selectedCount), [2]);
});

test('reordered group members drive the batch input order', () => {
  const plan = buildTaskInputUnits(
    [{ id: 'g1', label: '组 1', paths: ['C:/a/2.mp4', 'C:/a/1.mp4'] }],
    ['C:/a/1.mp4', 'C:/a/2.mp4'],
    ['C:/a/1.mp4', 'C:/a/2.mp4'],
  );
  assert.deepEqual(plan.units, [{ label: '组 1', paths: ['C:/a/2.mp4', 'C:/a/1.mp4'] }]);
});

test('group rows expose per-member selection in member order', () => {
  const states = groupSelectionStates(
    [{ id: 'g1', label: '组 1', paths: ['C:/a/2.mp4', 'C:/a/1.mp4'] }],
    ['C:/a/1.mp4'],
    ['C:/a/1.mp4'],
  );
  assert.deepEqual(plain(states[0].members), [
    { path: 'C:/a/2.mp4', name: '2.mp4', isDirectory: false, selected: false },
    { path: 'C:/a/1.mp4', name: '1.mp4', isDirectory: false, selected: true },
  ]);
  assert.deepEqual(states[0].state, 'partial');
});

test('moveWithinList moves before or after without disturbing the rest', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(plain(moveWithinList(list, 0, 2, false)), ['b', 'a', 'c', 'd']);
  assert.deepEqual(plain(moveWithinList(list, 0, 2, true)), ['b', 'c', 'a', 'd']);
  assert.deepEqual(plain(moveWithinList(list, 3, 1, false)), ['a', 'd', 'b', 'c']);
  assert.deepEqual(plain(moveWithinList(list, 1, 1, true)), list);
  assert.deepEqual(plain(moveWithinList(list, -1, 2, true)), list);
});

