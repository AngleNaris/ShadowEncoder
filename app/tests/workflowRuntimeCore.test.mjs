import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectWorkflowSourceFilesFromListings,
  evaluateBackupCapacityForVolumes,
  formatWorkflowBytes,
  matchesWorkflowVolume,
  storageVolumeKey,
} from '../src/lib/workflowRuntimeCore.ts';

const filter = (overrides = {}) => ({
  extensions: [],
  minSizeMb: 0,
  mediaOnly: false,
  recursive: true,
  ...overrides,
});

const directoryListing = (entries, overrides = {}) => ({
  rootPath: 'C:\\CARD',
  rootIsDirectory: true,
  rootSizeBytes: null,
  entries,
  errors: [],
  ...overrides,
});

const entry = (path, sizeBytes, depth = 1, isDirectory = false) => ({
  name: path.split(/[/\\]/).pop() ?? path,
  path,
  parentPath: 'C:\\CARD',
  isDirectory,
  depth,
  sizeBytes,
});

const volume = (overrides = {}) => ({
  id: 'vol-a',
  rootPath: 'D:\\',
  label: 'DIT CARD',
  serial: 1,
  driveType: 'removable',
  totalBytes: 10_000,
  availableBytes: 8_000,
  ...overrides,
});

test('流程来源过滤规范化扩展名、大小和媒体类型', () => {
  const oneMb = 1024 * 1024;
  const files = collectWorkflowSourceFilesFromListings([
    directoryListing([
      entry('C:\\CARD\\A.MP4', oneMb),
      entry('C:\\CARD\\B.mov', oneMb - 1),
      entry('C:\\CARD\\notes.txt', oneMb * 2),
    ]),
  ], filter({ extensions: [' .MP4 ', '..mov', ''], minSizeMb: 1, mediaOnly: true }));

  assert.deepEqual(files, [{ path: 'C:\\CARD\\A.MP4', sizeBytes: oneMb }]);
});

test('流程来源递归开关、目录排除和单文件根行为正确', () => {
  const listing = directoryListing([
    entry('C:\\CARD\\top.mov', 12, 1),
    entry('C:\\CARD\\nested', null, 1, true),
    entry('C:\\CARD\\nested\\deep.mov', 24, 2),
  ]);
  assert.deepEqual(
    collectWorkflowSourceFilesFromListings([listing], filter({ recursive: false })).map((file) => file.path),
    ['C:\\CARD\\top.mov'],
  );
  assert.deepEqual(
    collectWorkflowSourceFilesFromListings([listing], filter({ recursive: true })).map((file) => file.path),
    ['C:\\CARD\\top.mov', 'C:\\CARD\\nested\\deep.mov'],
  );
  assert.deepEqual(collectWorkflowSourceFilesFromListings([{
    rootPath: 'E:\\clip.MOV',
    rootIsDirectory: false,
    rootSizeBytes: 42,
    entries: [],
    errors: [],
  }], filter({ mediaOnly: true })), [{ path: 'E:\\clip.MOV', sizeBytes: 42 }]);
});

test('流程来源按 Windows 路径语义去重并报告目录读取错误', () => {
  const files = collectWorkflowSourceFilesFromListings([
    directoryListing([entry('C:\\CARD\\A.MP4', 10)]),
    directoryListing([entry('c:/card/a.mp4/', 20)]),
  ], filter());
  assert.deepEqual(files, [{ path: 'c:/card/a.mp4/', sizeBytes: 20 }]);
  assert.throws(
    () => collectWorkflowSourceFilesFromListings([
      directoryListing([], { errors: ['拒绝访问'] }),
    ], filter()),
    /无法完整读取素材目录：拒绝访问/,
  );
});

test('同一卷的多个备份目标按份数计算容量和安全余量', () => {
  const files = [{ path: 'A.mov', sizeBytes: 1_000 }, { path: 'B.mov', sizeBytes: 2_000 }];
  const result = evaluateBackupCapacityForVolumes(
    files,
    [volume(), volume({ rootPath: 'd:\\' })],
    10,
  );
  assert.equal(result.sourceBytes, 3_000);
  assert.equal(result.fileCount, 2);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].destinationCount, 2);
  assert.equal(result.checks[0].requiredBytes, 6_000);
  assert.equal(result.checks[0].reserveBytes, 1_000);
  assert.equal(result.fits, true);
});

test('容量未知、目标为空和安全余量越界均采取保守结果', () => {
  const files = [{ path: 'A.mov', sizeBytes: 100 }];
  assert.equal(evaluateBackupCapacityForVolumes(files, [], 0).fits, false);
  const unknown = evaluateBackupCapacityForVolumes(
    files,
    [volume({ totalBytes: null, availableBytes: null })],
    Number.NaN,
  );
  assert.equal(unknown.fits, false);
  assert.equal(unknown.checks[0].reserveBytes, 0);
  const clamped = evaluateBackupCapacityForVolumes(files, [volume()], 150);
  assert.equal(clamped.checks[0].reserveBytes, 10_000);
  assert.equal(clamped.fits, false);
});

test('磁盘触发匹配卷类型和卷标且不区分大小写', () => {
  const trigger = { kind: 'removable', volumeKind: 'removable', labelContains: ' card ', settleSeconds: 2 };
  assert.equal(matchesWorkflowVolume(volume(), trigger), true);
  assert.equal(matchesWorkflowVolume(volume({ driveType: 'fixed' }), trigger), false);
  assert.equal(matchesWorkflowVolume(volume({ label: 'CAMERA' }), trigger), false);
  assert.equal(storageVolumeKey(volume({ rootPath: 'D:\\\\' })), 'vol-a|d:');
});

test('流程容量文本使用稳定的二进制单位格式', () => {
  assert.equal(formatWorkflowBytes(0), '0 B');
  assert.equal(formatWorkflowBytes(Number.NaN), '0 B');
  assert.equal(formatWorkflowBytes(1024), '1.0 KB');
  assert.equal(formatWorkflowBytes(1536), '1.5 KB');
  assert.equal(formatWorkflowBytes(100 * 1024 * 1024), '100 MB');
});
