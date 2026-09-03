import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('任务运行器挂在功能页之外，切换 tab 不会销毁进度状态', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const tabsSource = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');

  assert.match(appSource, /<TaskRunnerProvider>\s*<AppShell\s*\/>\s*<\/TaskRunnerProvider>/);
  assert.match(tabsSource, /export function TaskRunnerProvider[\s\S]*useTaskRunnerState\(\)/);
  assert.match(tabsSource, /function useTaskRunner\(\)[\s\S]*useContext\(TaskRunnerContext\)/);
});

test('参数卡片复用共享网格行动画并保留值更新动画', async () => {
  const source = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');

  assert.match(source, /<ui\.AnimatedList[\s\S]*items=\{rows\}[\s\S]*getKey=\{\(row\) => row\.k\}[\s\S]*layout="flow"/);
  assert.doesNotMatch(source, /rowSignature|previousPositions|se-dynamic-item/);
  assert.match(source, /<ui\.AnimatedValue value=\{row\.v\}/);
  assert.doesNotMatch(source, /<ui\.AnimatedHeight>/);
});

test('任务运行时保留局部锁定和停止按钮，但不显示全局浮层', async () => {
  const [source, tabsSource, ditSource, theme] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(source, /setAttribute\('inert'/);
  assert.match(source, /<SharedFilesColumn disabled=\{task\.running\}/);
  assert.match(source, /className=\{`se-app\$\{task\.running \? ' is-task-running' : ''\}`\}/);
  assert.match(source, /className="se-rail-item"[\s\S]*disabled=\{task\.running\}/);
  assert.match(tabsSource, /onStop && running[\s\S]*className="se-process-stop"[\s\S]*onClick=\{onStop\}/);
  assert.match(ditSource, /running \?[\s\S]*className="se-process-stop"[\s\S]*onClick=\{onStop\}/);
  assert.doesNotMatch(source, /se-task-lock/);
  assert.doesNotMatch(theme, /\.se-task-lock/);
});

test('结果视图切换图标使用偶数像素尺寸避免半像素偏移', async () => {
  const [tabsSource, theme] = await Promise.all([
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(tabsSource, /className=\{`se-result-view-tab[\s\S]*<IconVideo size=\{16\} \/>/);
  assert.match(tabsSource, /className=\{`se-result-view-tab[\s\S]*<IconTerminal size=\{16\} \/>/);
  assert.match(theme, /\.se-result-view-tab\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/);
});

test('播放器结果列可以收缩到零宽', async () => {
  const [tabsSource, layoutSource, theme] = await Promise.all([
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/columnLayoutContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(tabsSource, /const workspaceRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(tabsSource, /const maxWidth = Math\.max\(0, \(workspaceRef\.current\?\.clientWidth \?\? 0\) - 1\)/);
  assert.match(tabsSource, /setWParams\(\(width\) => Math\.max\(0, Math\.min\(maxWidth, width \+ dx\)\)\)/);
  assert.match(tabsSource, /<div ref=\{workspaceRef\} className="se-tab-workspace">/);
  assert.doesNotMatch(layoutSource, /PARAMS_MAX|resizeParams/);
  assert.match(theme, /\.se-result-scroll\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/);
  assert.match(theme, /\.se-player-controls\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/);
});

test('参数卡片无文案勾选框不保留标签间距', async () => {
  const uiSource = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const tabsSource = await readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8');

  assert.match(uiSource, /const hasLabel = children !== '';/);
  assert.match(uiSource, /hasLabel \? <span className="se-detail-label">\{children\}<\/span> : null/);
  assert.match(tabsSource, /title="响度标准化 \(EBU R128\)"[\s\S]*aside=\{<ui\.Checkbox[\s\S]*>\{''\}<\/ui\.Checkbox>\}/);
  assert.match(tabsSource, /title="动态压缩 \(Compand\)"[\s\S]*aside=\{<ui\.Checkbox[\s\S]*>\{''\}<\/ui\.Checkbox>\}/);
});

test('流程节点保留明确的拖拽、端口和参数反馈', async () => {
  const [uiSource, theme, editor] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(uiSource, /se-check\$\{hasLabel \? ' has-label' : ''\}/);
  assert.match(uiSource, /se-radio has-label/);
  assert.match(theme, /\.se-workflow-flow-node\s*\{[^}]*width:\s*268px;[^}]*cursor:\s*grab;/);
  assert.match(theme, /\.se-workflow-node-header\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/);
  assert.match(theme, /\.se-workflow-handle\.react-flow__handle\s*\{[^}]*width:\s*9px;[^}]*min-height:\s*9px;[^}]*border-radius:\s*0;/);
  assert.match(theme, /\.se-workflow-handle\.react-flow__handle::before\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
  assert.match(editor, /<Handle[\s\S]*type=\{kind\}/);
  assert.doesNotMatch(theme, /\.se-workflow-node-index/);
  assert.match(theme, /\.se-check\.has-label > \.se-check-box,\s*\.se-radio\.has-label > \.se-radio-box\s*\{\s*transform:\s*translateY\(-1px\);\s*\}/);
});

test('所有条件参数行统一复用共享行补位动画', async () => {
  const [tabs, presets, outputSettings, ditTabs, workflowEditor, uiSource, theme] = await Promise.all([
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/OutputSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(uiSource, /export function AnimatedFieldGrid[\s\S]*<AnimatedList[\s\S]*itemClassName="se-field-row-motion"[\s\S]*layout="flow"/);
  assert.match(uiSource, /pendingFlowHeight\.current = layout !== 'stack'[\s\S]*getBoundingClientRect\(\)\.height/);
  assert.match(uiSource, /node\.animate\([\s\S]*height: `\$\{fromHeight\}px`[\s\S]*height: `\$\{targetHeight\}px`[\s\S]*ROW_MOTION_DURATION_MS/);
  assert.match(tabs, /const videoFieldRows:[\s\S]*<ui\.AnimatedFieldGrid rows=\{videoFieldRows\}/);
  assert.match(presets, /const fieldRows: ui\.AnimatedFieldRow\[\][\s\S]*<ui\.AnimatedFieldGrid rows=\{section\.rows\}/);
  assert.match(outputSettings, /const rows: ui\.AnimatedFieldRow\[\][\s\S]*<ui\.AnimatedFieldGrid rows=\{rows\} tight/);
  assert.match(ditTabs, /const executionRows: ui\.AnimatedFieldRow\[\][\s\S]*<ui\.AnimatedFieldGrid rows=\{executionRows\}/);
  assert.match(ditTabs, /className="se-dit-destinations"[\s\S]*itemClassName="se-dit-destination-motion"[\s\S]*layout="flow"/);
  assert.match(workflowEditor, /function WorkflowGraphCanvas[\s\S]*<ReactFlow[\s\S]*onNodeDragStop=/);
  assert.match(workflowEditor, /function WorkflowNodeEditor[\s\S]*<ui\.ComboBox/);
  assert.doesNotMatch(workflowEditor, /const conditionRows: ui\.AnimatedFieldRow\[\]/);
  assert.doesNotMatch(workflowEditor, /const actionRows: ui\.AnimatedFieldRow\[\]/);
  for (const source of [tabs, presets, outputSettings, ditTabs, workflowEditor]) {
    assert.doesNotMatch(source, /se-field-collapse/);
  }
  assert.match(theme, /\.se-field-grid\s*>\s*\.se-field-row-motion\s*\{\s*grid-column:\s*1\s*\/\s*-1;/);
  assert.match(theme, /\.se-field-row-motion\s*>\s*\.se-animated-list-item-inner\s*>\s*\.se-animated-list-item-content\s*\{[^}]*display:\s*grid;/);
  assert.doesNotMatch(theme, /\.se-field-row-motion\s+\.se-animated-list-item-content\s*\{/);
  assert.match(theme, /\.se-dit-destinations\s*\{[^}]*gap:\s*7px;[^}]*--se-animated-list-gap:\s*0px;/);
  assert.match(theme, /\.se-animated-list--flow\s*>\s*\.se-animated-list-item\s*\{/);
  assert.doesNotMatch(theme, /\.se-animated-list--flow\s+\.se-animated-list-item/);
  assert.match(theme, /\.se-field-grid\s*\{[\s\S]*--se-field-row-gap:\s*12px;[\s\S]*row-gap:\s*var\(--se-field-row-gap\)/);
  assert.doesNotMatch(theme, /se-field-collapse/);
});

test('所有输入型控件共用单层焦点描边', async () => {
  const [theme, muiTheme] = await Promise.all([
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/muiTheme.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(theme, /--primary:\s*var\(--accent-primary, #6d5da5\);/);
  assert.match(theme, /--ctrl-focus-border:\s*var\(--primary\);/);
  assert.match(theme, /--ctrl-focus-shadow:\s*0 0 12px -2px rgba\(var\(--primary-rgb\), 0\.4\);/);
  assert.doesNotMatch(theme, /--ctrl-focus-shadow:[^;]*(?:inset\s+)?0 0 0 1px/);
  assert.match(theme, /input:focus, select:focus, textarea:focus\s*\{[\s\S]*box-shadow:\s*var\(--ctrl-focus-shadow\)/);
  assert.match(theme, /\.se-num input:hover:not\(:disabled\):not\(:focus\)/);
  assert.match(theme, /\.se-drop-input:hover:not\(:disabled\):not\(:focus\)/);
  assert.match(theme, /\.se-media-picker-address input:hover:not\(:disabled\):not\(:focus\)/);
  assert.match(theme, /\.se-tag-input:hover:not\(\.is-disabled\):not\(:focus-within\)/);
  assert.match(theme, /\.se-tag-input:focus-within\s*\{[\s\S]*box-shadow:\s*var\(--ctrl-focus-shadow\)/);
  assert.match(theme, /\.se-tag-input\s*>\s*input:focus\s*\{\s*background:\s*transparent;\s*box-shadow:\s*none;/);
  assert.match(muiTheme, /Mui-focused \.MuiOutlinedInput-notchedOutline[\s\S]*borderColor:\s*"var\(--ctrl-focus-border[\s\S]*boxShadow:\s*"none"/);
  assert.match(muiTheme, /&:hover:not\(\.Mui-focused\) \.MuiOutlinedInput-notchedOutline/);
  assert.match(muiTheme, /"&\.Mui-focused"[\s\S]*boxShadow:\s*"var\(--ctrl-focus-shadow[\s\S]*outline:\s*"none"/);
  assert.match(muiTheme, /MuiSelect-select:focus-visible[\s\S]*outline:\s*"none"/);
  assert.match(theme, /\.se-animated-list-item:not\(\.is-entering\):not\(\.is-exiting\)\s*>\s*\.se-animated-list-item-inner\s*\{\s*overflow:\s*visible;/);
  assert.match(theme, /\.se-collapse\.is-open\s*>\s*\.se-collapse-inner\s*\{\s*overflow:\s*visible;/);
  assert.match(theme, /\.se-field-grid\.tight\s*\{\s*--se-field-row-gap:\s*8px;\s*--se-field-column-gap:\s*12px;/);
});

test('数字步进按钮的悬停状态使用可插值过渡', async () => {
  const theme = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

  assert.match(theme, /\.se-num-steps button\s*\{[^}]*background-color:\s*transparent;[^}]*box-shadow:\s*inset 0 0 0 1px transparent;[^}]*transition:\s*background-color var\(--transition\), color var\(--transition\), box-shadow var\(--transition\);/);
  assert.match(theme, /\.se-num-steps button:hover:not\(:disabled\)\s*\{[^}]*background-color:\s*var\(--primary-soft\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--ctrl-border-hover\);/);
});

test('数字输入框的单位按文字基线和 WebView 字形落点校正', async () => {
  const [ui, theme] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.equal((ui.match(/className="se-num-suffix-baseline"/g) ?? []).length, 2);
  assert.match(theme, /\.se-num-suffix-baseline\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*baseline;/);
  assert.match(theme, /\.se-num-suffix-text\s*\{[^}]*transform:\s*translateY\(1px\);/);
});

test('标签输入区只在剩余空间不足时换行', async () => {
  const [ui, theme] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(theme, /\.se-tag-input\s*>\s*input\s*\{[^}]*box-sizing:\s*border-box;[^}]*flex:\s*1 1 48px;[^}]*min-width:\s*36px;/);
  assert.match(theme, /\.se-tag-input\s*\{[^}]*align-content:\s*flex-start;[^}]*column-gap:\s*5px;[^}]*row-gap:\s*4px;/);
  assert.match(ui, /layout\?:\s*'stack'\s*\|\s*'flow'\s*\|\s*'wrap';/);
  assert.match(ui, /<AnimatedList[\s\S]*items=\{values\}[\s\S]*itemClassName="se-tag-input-motion-item"[\s\S]*layout="wrap"/);
  assert.match(theme, /\.se-animated-list--wrap\s*>\s*\.se-animated-list-item\.is-entering\s*\{[^}]*animation:\s*se-list-flow-enter/);
  assert.match(theme, /\.se-animated-list--wrap\s*>\s*\.se-animated-list-item\.is-exiting\s*\{[^}]*grid-template-rows:\s*1fr;/);
  assert.doesNotMatch(theme, /\.se-animated-list--wrap\s+\.se-animated-list-item/);
});

test('非编码预设管理器沿用主界面分组列表并共享单一滚动容器', async () => {
  const [ditTabs, workflowEditor, presetSystem, tabs, rules, theme] = await Promise.all([
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/presetUiRules.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(ditTabs, /title="管理备份预设"/);
  assert.doesNotMatch(ditTabs, /管理 DIT 备份预设/);
  assert.doesNotMatch(ditTabs, /presetEditor/);
  assert.match(ditTabs, /function BackupFields\([\s\S]*<ui\.ParamGroup title="备份来源">[\s\S]*<ui\.ParamGroup title="备份目标"[\s\S]*<ui\.ParamGroup title="执行与校验">[\s\S]*<ui\.ParamGroup title="冲突解决">/);
  assert.equal((ditTabs.match(/<BackupFields value=/g) ?? []).length, 2);
  assert.match(presetSystem, /const GENERIC_PRESET_GROUPS:[\s\S]*mix:[\s\S]*check:[\s\S]*alpha:[\s\S]*screenshot:[\s\S]*segment:[\s\S]*gif:[\s\S]*webp:/);
  assert.match(presetSystem, /\{sections\.map\(\(section\) => \([\s\S]*<ui\.ParamGroup[\s\S]*title=\{section\.title\}[\s\S]*<ui\.AnimatedFieldGrid rows=\{section\.rows\}/);
  assert.match(presetSystem, /toggleKey: 'lnOn'[\s\S]*toggleKey: 'tpOn'/);
  assert.match(presetSystem, /checkboxKeys: \['recursive', 'blackDetect'\]/);
  assert.match(presetSystem, /layout: 'alpha'/);
  assert.match(presetSystem, /section\.rows\.length > 0[\s\S]*section\.layout != null[\s\S]*section\.checkboxKeys\?\.length/);
  assert.match(presetSystem, /isPresetUiFieldDisabled\(uiType, 'fixedVal', form\)/);
  assert.match(tabs, /isPresetUiFieldDisabled\('mix', 'lnI'/);
  assert.match(tabs, /isPresetUiFieldDisabled\('check', 'fpsTol'/);
  assert.match(tabs, /isPresetUiFieldDisabled\('alpha', 'fps'/);
  assert.match(rules, /type === 'segment' && key === 'fps'/);
  assert.match(presetSystem, /<OutputLocationGroup[\s\S]*value=\{form\}/);
  assert.doesNotMatch(presetSystem, /editorWidth/);
  assert.match(theme, /\.se-preset-dialog\s*\{[^}]*--se-preset-editor-width:\s*760px;[^}]*width:\s*min\(calc\(244px \+ var\(--se-preset-editor-width\)\), 96vw\);/);
  assert.match(theme, /\.se-preset-dialog--compact\s*\{[^}]*--se-preset-editor-width:\s*380px;[^}]*width:\s*min\(calc\(244px \+ var\(--se-preset-editor-width\)\), 94vw\);/);
  assert.match(theme, /\.se-preset-dialog--scroll-edit \.se-preset-edit\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/);
  assert.match(theme, /\.se-preset-dialog--compact \.se-preset-name \.se-drop-input\s*\{[^}]*flex:\s*1 1 auto;[^}]*width:\s*auto;/);
  assert.match(workflowEditor, /title="管理流程预设"[\s\S]*scrollEditor/);
  assert.match(theme, /\.se-workflow-preset-editor\s*\{[^}]*flex:\s*0 0 auto;[^}]*display:\s*flex;/);
  assert.doesNotMatch(theme, /\.se-workflow-preset-editor\s*\{[^}]*overflow-y:\s*auto/);
});

test('参数面板使用紧凑标题栏折叠且预设管理默认展开', async () => {
  const [ui, presets, theme] = await Promise.all([
    readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(ui, /className="se-group-head-toggle"[\s\S]*aria-expanded=\{open\}[\s\S]*onClick=\{\(\) => setOpen/);
  assert.doesNotMatch(ui, /className="se-group-collapse"/);
  assert.doesNotMatch(presets, /title=\{builderTitle \?\? '预设管理'\}[\s\S]{0,160}defaultOpen=\{false\}/);
  assert.match(theme, /\.se-group-head\s*\{[^}]*padding:\s*0;[^}]*min-height:\s*30px;/);
  assert.match(theme, /\.se-group-head-toggle\s*\{[^}]*padding:\s*5px 10px;/);
});
