import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 手动顺序表：父目录 key → 子项 key 顺序
function loadFileTree() {
  const source = readFileSync(new URL('../src/lib/fileTree.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: () => ({}),
  });
  return exports;
}

const { buildFileTreeIndex, filePathKey } = loadFileTree();

// vm 里创建的数组原型与本域不同，统一转成普通 JSON 结构再断言。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function node(path, name, isDirectory, parentPath) {
  return { path, name, isDirectory, parentPath, depth: parentPath ? 1 : 0, rootPath: 'C:\\root' };
}

const tree = [
  node('C:\\root\\a.mp4', 'a.mp4', false, 'C:\\root'),
  node('C:\\root\\b.mp4', 'b.mp4', false, 'C:\\root'),
  node('C:\\root\\c.mp4', 'c.mp4', false, 'C:\\root'),
];

test('children fall back to name order without a manual order', () => {
  const index = buildFileTreeIndex(['C:\\root'], new Map([[filePathKey('C:\\root'), tree]]));
  assert.deepEqual(plain(index.childrenByKey.get(filePathKey('C:\\root')).map((child) => child.name)), ['a.mp4', 'b.mp4', 'c.mp4']);
});

test('manual child order wins and unlisted children keep name order after listed ones', () => {
  const order = new Map([[filePathKey('C:\\root'), ['c.mp4', 'a.mp4'].map((name) => filePathKey(`C:\\root\\${name}`))]]);
  const index = buildFileTreeIndex(['C:\\root'], new Map([[filePathKey('C:\\root'), tree]]), order);
  assert.deepEqual(plain(index.childrenByKey.get(filePathKey('C:\\root')).map((child) => child.name)), ['c.mp4', 'a.mp4', 'b.mp4']);
});
