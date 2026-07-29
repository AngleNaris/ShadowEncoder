import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allProcessPaths,
  buildFileTreeIndex,
  computeTreeSelectionStates,
  filePathKey,
  selectedProcessPaths,
  selectedSourcePaths,
  setTreeSelection,
  toggleTreeSelection,
} from '../src/lib/fileTree.ts';

const root = 'C:\\media\\';
const shots = 'C:\\media\\shots';
const first = 'C:\\media\\shots\\a.mov';
const second = 'C:\\media\\shots\\b.mov';
const loose = 'C:\\media\\keep.wav';

function makeIndex() {
  return buildFileTreeIndex([root], new Map([[
    filePathKey(root),
    [
      { path: shots, name: 'shots', isDirectory: true, parentPath: 'C:\\media', depth: 1, rootPath: root },
      { path: first, name: 'a.mov', isDirectory: false, parentPath: shots, depth: 2, rootPath: root },
      { path: second, name: 'b.mov', isDirectory: false, parentPath: shots, depth: 2, rootPath: root },
      { path: loose, name: 'keep.wav', isDirectory: false, parentPath: 'C:\\media', depth: 1, rootPath: root },
    ],
  ]]));
}

test('勾选目录会选择全部后代，取消单个文件后目录变为部分选中', () => {
  const index = makeIndex();
  let selected = toggleTreeSelection(new Set(), root, index);
  assert.deepEqual(selectedProcessPaths(index, selected), [first, second, loose]);
  assert.equal(computeTreeSelectionStates(index, selected).get(filePathKey(root)), 'checked');
  assert.deepEqual(selectedSourcePaths(index, selected), [root]);

  selected = toggleTreeSelection(selected, first, index);
  const states = computeTreeSelectionStates(index, selected);
  assert.equal(states.get(filePathKey(root)), 'partial');
  assert.equal(states.get(filePathKey(shots)), 'partial');
  assert.deepEqual(selectedProcessPaths(index, selected), [second, loose]);
  assert.deepEqual(selectedSourcePaths(index, selected), [second, loose]);

  selected = toggleTreeSelection(selected, first, index);
  assert.equal(computeTreeSelectionStates(index, selected).get(filePathKey(root)), 'checked');
  assert.deepEqual(selectedSourcePaths(index, selected), [root]);
});

test('全部处理路径展开为稳定的叶子文件顺序', () => {
  assert.deepEqual(allProcessPaths(makeIndex()), [first, second, loose]);
});

test('未加载目录的勾选意图会在目录加载后应用到全部后代', () => {
  const unloadedIndex = buildFileTreeIndex([root], new Map());
  let selected = setTreeSelection(new Set(), root, unloadedIndex, true);
  assert.deepEqual([...selected], [filePathKey(root)]);

  const loadedIndex = makeIndex();
  selected = setTreeSelection(selected, root, loadedIndex, true);
  assert.deepEqual(selectedProcessPaths(loadedIndex, selected), [first, second, loose]);
  const states = computeTreeSelectionStates(loadedIndex, selected);
  assert.equal(states.size, loadedIndex.nodesByKey.size);
  for (const key of loadedIndex.nodesByKey.keys()) {
    assert.equal(states.get(key), 'checked');
  }

  selected = setTreeSelection(selected, root, loadedIndex, false);
  assert.equal(selected.size, 0);
});
