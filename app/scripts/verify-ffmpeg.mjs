import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_FFMPEG_MAJOR = 9;

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(appRoot, '..');

function readVersion(executable, name) {
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(new RegExp(`^${name} version (\\d+)\\.([^\\s]+)`, 'm'));

  if (result.error || result.status !== 0 || !match) {
    const detail = result.error?.message ?? (output.trim() || `exit code ${result.status ?? 'unknown'}`);
    throw new Error(`无法读取 ${name} 版本 (${executable}): ${detail}`);
  }

  return {
    major: Number(match[1]),
    version: `${match[1]}.${match[2]}`,
    line: output.split(/\r?\n/, 1)[0],
  };
}

export function verifyFfmpegDirectory(directory, label = 'FFmpeg 输入') {
  const results = [];
  for (const name of ['ffmpeg', 'ffprobe']) {
    const executable = resolve(directory, `${name}.exe`);
    const result = readVersion(executable, name);
    if (result.major !== REQUIRED_FFMPEG_MAJOR) {
      throw new Error(
        `${label}要求 FFmpeg ${REQUIRED_FFMPEG_MAJOR}.x，但 ${executable} 是 ${result.version}`,
      );
    }
    results.push({ name, executable, ...result });
  }

  for (const result of results) {
    console.log(`[ffmpeg] ${result.line}`);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(repositoryRoot, 'ffmpeg', 'win');
  verifyFfmpegDirectory(directory);
}
