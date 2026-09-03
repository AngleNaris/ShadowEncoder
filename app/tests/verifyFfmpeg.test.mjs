import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REQUIRED_FFMPEG_MAJOR, verifyFfmpegDirectory } from '../scripts/verify-ffmpeg.mjs';

test('打包输入要求 FFmpeg 9.x', async () => {
  assert.equal(REQUIRED_FFMPEG_MAJOR, 9);
  const directory = await mkdtemp(join(tmpdir(), 'shadowencoder-ffmpeg-'));
  try {
    await writeFile(join(directory, 'ffmpeg.exe'), 'not an executable');
    await writeFile(join(directory, 'ffprobe.exe'), 'not an executable');
    assert.throws(() => verifyFfmpegDirectory(directory), /无法读取 ffmpeg 版本/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
