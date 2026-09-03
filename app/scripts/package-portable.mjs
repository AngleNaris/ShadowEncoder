import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFfmpegDirectory } from './verify-ffmpeg.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(appRoot, '..');
const packageJson = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'));
const cargoTargetDirectory = process.env.CARGO_TARGET_DIR
  ? resolve(appRoot, process.env.CARGO_TARGET_DIR)
  : resolve(appRoot, 'src-tauri', 'target');
const releaseRoot = resolve(cargoTargetDirectory, 'release');
const outputDirectory = resolve(releaseRoot, 'bundle', 'portable');
const output = resolve(
  outputDirectory,
  `ShadowEncoder_${packageJson.version}_x64-portable.exe`,
);

const inputs = {
  APP_EXE: resolve(releaseRoot, 'shadowencoder.exe'),
  CLI_EXE: resolve(releaseRoot, 'shadowencoder-cli.exe'),
  FFMPEG_EXE: resolve(releaseRoot, 'ffmpeg.exe'),
  FFPROBE_EXE: resolve(releaseRoot, 'ffprobe.exe'),
  LIBMPV_DLL: resolve(releaseRoot, 'libmpv-2.dll'),
  APP_ICON: resolve(appRoot, 'src-tauri', 'icons', 'icon.ico'),
  LICENSE_FILE: resolve(repositoryRoot, 'LICENSE'),
  THIRD_PARTY_FILE: resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
};

for (const [name, path] of Object.entries(inputs)) {
  if (!existsSync(path)) {
    throw new Error(`Portable package input is missing (${name}): ${path}`);
  }
}

verifyFfmpegDirectory(releaseRoot, '便携版打包输入');

function findMakensis() {
  const executable = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
  const candidates = [
    process.env.MAKENSIS,
    process.env.LOCALAPPDATA
      ? resolve(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'Bin', executable)
      : undefined,
    ...String(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => resolve(entry, executable)),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

if (process.platform !== 'win32') {
  throw new Error('The portable single-file package is currently available on Windows only.');
}

const makensis = findMakensis();
if (!makensis) {
  throw new Error(
    'makensis.exe was not found. Build a Tauri NSIS bundle once or set MAKENSIS explicitly.',
  );
}

mkdirSync(outputDirectory, { recursive: true });
const definitions = {
  ...inputs,
  APP_VERSION: packageJson.version,
  OUTPUT_EXE: output,
};
const args = [
  '/V2',
  ...Object.entries(definitions).map(([name, value]) => `/D${name}=${value}`),
  resolve(appRoot, 'scripts', 'portable.nsi'),
];
const build = spawnSync(makensis, args, {
  cwd: appRoot,
  stdio: 'inherit',
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(`Built portable package: ${output}`);

const verify = spawnSync(output, ['--portable-verify'], {
  cwd: outputDirectory,
  stdio: 'inherit',
});

if (verify.error) throw verify.error;
if (verify.status !== 0) {
  throw new Error(`Portable package verification failed with exit code ${verify.status ?? 1}.`);
}
console.log(`Verified portable package: ${output}`);
