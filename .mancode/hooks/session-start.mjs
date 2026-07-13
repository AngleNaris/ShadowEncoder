#!/usr/bin/env node
// .mancode/hooks/session-start.mjs
// mancode SessionStart hook - cross-platform project context
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const state = readJson(path.join(projectRoot, '.mancode', 'state.json'));
const profile =
  readJson(path.join(projectRoot, '.mancode', 'project-profile.json')) || {};

if (!state) {
  console.log('ℹ️ mancode 未初始化。运行 mancode init 开始。');
  process.exit(0);
}

const storedMode = text(state.currentMode) || 'solo';
const mode = storedMode === 'mamba' ? 'manba' : storedMode;
const techStack = sanitize(state.techStack);
const uiLibrary = sanitize(state.uiLibrary);
const output = [
  'mancode_mode: ' + mode,
  'project_type: ' + techStack,
  'ui_library: ' + uiLibrary,
  '',
  '## mancode · ' + mode + ' mode',
  '',
  '你正在使用 mancode ' + mode + ' 模式。',
  '',
  '### 核心原则',
  '1. **优先复用项目已有代码**',
  '   - 检查已检测到的源码目录和已有类似实现',
  '   - 复用现有组件、函数、样式',
  '',
];

if (profile.uiAssets === 'detected') {
  output.push(
    '2. **应用项目审美 token**（仅在项目 profile 确认有 UI 资产且任务涉及 UI 时）',
    '   - UI library: ' + uiLibrary,
    '   - 使用项目已有的设计 token',
  );
} else {
  output.push(
    '2. **按项目能力工作**',
    '   - 不假定存在 UI、浏览器或特定技术栈',
    '   - 先读取 project-profile 与项目现有验证方式',
  );
}

output.push(
  '',
  '3. **最小改动**',
  '   - 只改用户要求的部分',
  '   - 不重构无关代码',
);

if (state.teamModeAutoDetected === true && mode === 'solo') {
  output.push(
    '',
    '### 团队协作提醒',
    '检测到团队项目（contributors: ' +
      (Number.isFinite(state.contributors) ? state.contributors : 2) +
      '）。',
    '- 涉及多人协作、交接、PR、共享模块时，优先使用 /manteam <task>。',
    '- 只做个人小改动时，可以继续 solo；需要退出流程用 /mansolo。',
  );
}

console.log(output.join('\n'));

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function sanitize(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
}
