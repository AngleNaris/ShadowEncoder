#!/usr/bin/env node
// .mancode/hooks/user-prompt-submit.mjs
// mancode UserPromptSubmit hook - cross-platform prompt and style context
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const mancodeDir = path.join(projectRoot, '.mancode');
const state = readJson(path.join(mancodeDir, 'state.json')) || {};
const profile = readJson(path.join(mancodeDir, 'project-profile.json')) || {};
const mode = typeof state.currentMode === 'string' ? state.currentMode : '';
const output = [];

if (mode === 'solo') {
  output.push(
    '## 动手前，先想六个问题：',
    '',
    '1. **为什么做？**',
    '   - 这个改动解决什么问题？',
    '',
    '2. **已经有什么？**',
    '   - 项目里有没有类似的实现可以复用？',
    '',
    '3. **最少改多少？**',
    '   - 能用一行解决吗？能复用现有代码吗？',
    '',
    '4. **能不能不拆新系统？**',
    '   - 不新建文件或模块能完成吗？',
    '',
    '5. **非平凡逻辑怎样最小运行验证？**',
    '',
    '6. **有什么没把握的？**',
    '   - 先自行查代码或文档，最多 2 次工具调用；仍不确定再问用户。',
    '',
  );
}

const rawInput = readFileSync(0, 'utf8');
const userPrompt = readPrompt(rawInput);
const planningPattern = /先(?:别|不要|看|看看|调研|分析|评估)|给.*方案|给.*计划|怎么.*做|如何.*做|怎么.*实现|如何.*实现|应该怎么|怎么.*拆|拆分|只给.*计划|不要.*改代码|别.*改代码|不要.*动代码|别.*动代码|评估.*风险|风险.*评估|设计.*方案|架构|迁移|集成|\b(?:plan|planning|research|investigate|approach|proposal|architecture|risk|migration|integration)\b|how (?:should|would|to)|do not (?:edit|modify|change)|don.t (?:edit|modify|change)|no code changes|without changing code/iu;

if (mode === 'solo' && planningPattern.test(userPrompt)) {
  output.push(
    '## mancode 自动路由',
    '',
    '这个请求是规划/调研类任务。不要直接进入 solo 实施。',
    "必须先调用 Skill tool，skill='man'，把用户原始请求作为 task，执行 Scout 调研、澄清和 Plan Coach plan。",
    '用户只要计划时，在 Step 4 选择“只要计划”；不要切到另一个命令。',
    '',
  );
}

const uiPattern = /\b(?:button|component|page|style|ui|design|layout|css|color|font|theme|card|input|modal|dialog|header|footer|sidebar|dropdown|tooltip|toast|avatar|badge)\b|界面|页面|按钮|样式|颜色|字体|布局|组件|弹窗|导航|卡片|输入框|主题|美化|优化.*界面|调整.*样式/iu;

if (profile.uiAssets === 'detected' && uiPattern.test(userPrompt)) {
  appendAestheticSummary(
    output,
    readJson(path.join(mancodeDir, 'aesthetics', 'style-tokens.json')),
  );
}

if (output.length > 0) console.log(output.join('\n'));

function appendAestheticSummary(lines, tokens) {
  if (!tokens || tokens.matchLevel !== 'high') return;

  const colors = safeEntries(tokens.colors, 8).map(
    ([key, value]) => key + '=' + String(value),
  );
  const fonts = safeEntries(tokens.fonts, 4)
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([key, value]) => key + '=' + String(value[0]));
  const components = Array.isArray(tokens.components)
    ? tokens.components
        .filter(
          (value) =>
            typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,79}$/.test(value),
        )
        .slice(0, 8)
    : [];
  const cssVariables = safeEntries(tokens.cssVariables, 8).map(
    ([key, value]) => '--' + key + '=' + String(value),
  );

  lines.push('## 审美 token 摘要');
  appendValue(lines, 'UI', tokens.uiLibrary);
  appendValue(lines, 'Dark', tokens.darkMode);
  appendValue(lines, 'Match', tokens.matchLevel);
  appendValue(lines, 'Colors (前 8)', colors.join(', '));
  appendValue(lines, 'Fonts (前 4)', fonts.join(', '));
  appendValue(lines, 'Components (前 8)', components.join(', '));
  appendValue(lines, 'CSS variables (前 8)', cssVariables.join(', '));
  lines.push('完整 token: .mancode/aesthetics/style-tokens.json', '');
}

function safeEntries(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([key]) => /^[A-Za-z0-9_-]{1,80}$/.test(key))
    .slice(0, limit);
}

function appendValue(lines, label, value) {
  const clean = sanitize(value);
  if (clean) lines.push(label + ': ' + clean);
}

function readPrompt(input) {
  try {
    const parsed = JSON.parse(input);
    return typeof parsed.prompt === 'string' && parsed.prompt
      ? parsed.prompt
      : input;
  } catch {
    return input;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sanitize(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
}
