import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Windows 媒体子进程统一隐藏控制台窗口', async () => {
  const source = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');

  assert.match(source, /fn media_command\(program: &str\)[\s\S]*creation_flags\(CREATE_NO_WINDOW\)/);
  assert.doesNotMatch(source, /Command::new\("ffmpeg"\)/);
  assert.doesNotMatch(source, /Command::new\("ffprobe"\)/);
  assert.ok((source.match(/media_command\("ffmpeg"\)/g) ?? []).length >= 4);
  assert.ok((source.match(/media_command\("ffprobe"\)/g) ?? []).length >= 4);
});
