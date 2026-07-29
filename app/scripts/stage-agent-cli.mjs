import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultTargetTriple() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : 'x86_64-pc-windows-msvc';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin';
  }
  return process.arch === 'arm64'
    ? 'aarch64-unknown-linux-gnu'
    : 'x86_64-unknown-linux-gnu';
}

const target = process.env.SHADOWENCODER_CLI_TARGET || defaultTargetTriple();
const executable = process.platform === 'win32' ? 'shadowencoder-cli.exe' : 'shadowencoder-cli';
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const targetDirectory = resolve(appRoot, 'agent-cli', 'target');
const build = spawnSync(cargo, [
  'build',
  '--release',
  '--manifest-path',
  resolve(appRoot, 'agent-cli', 'Cargo.toml'),
  '--target',
  target,
], {
  cwd: appRoot,
  env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
  stdio: 'inherit',
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const source = resolve(targetDirectory, target, 'release', executable);
const destination = resolve(
  appRoot,
  'src-tauri',
  'binaries',
  `shadowencoder-cli-${target}${process.platform === 'win32' ? '.exe' : ''}`,
);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Staged ${destination}`);
