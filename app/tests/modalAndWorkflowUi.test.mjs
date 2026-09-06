import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isModalLayerOpen,
  prepareModalLayer,
  registerModalLayer,
  subscribeModalLayerPreparation,
} from '../src/lib/modalLayer.ts';

test('模态层使用引用计数并允许幂等释放', () => {
  assert.equal(isModalLayerOpen(), false);
  const releaseFirst = registerModalLayer();
  const releaseSecond = registerModalLayer();
  assert.equal(isModalLayerOpen(), true);
  releaseFirst();
  assert.equal(isModalLayerOpen(), true);
  releaseFirst();
  assert.equal(isModalLayerOpen(), true);
  releaseSecond();
  assert.equal(isModalLayerOpen(), false);
});

test('模态层等待原生 surface 隐藏完成后再解除显示阻塞', async () => {
  let finishPreparation;
  let settled = false;
  const unsubscribe = subscribeModalLayerPreparation(() => new Promise((resolve) => {
    finishPreparation = resolve;
  }));

  const preparation = prepareModalLayer().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finishPreparation();
  await preparation;
  assert.equal(settled, true);
  unsubscribe();
});

test('预设弹窗会遮挡原生播放器 surface', async () => {
  const [presetSource, playerSource] = await Promise.all([
    readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(presetSource, /function PresetManageDialog[\s\S]*useModalLayerRegistration\(!closing\)/);
  assert.match(playerSource, /const modalLayerOpen = useModalLayerOpen\(\)/);
  assert.match(playerSource, /!mpvActive \|\| mpvRenderer !== 'gpu' \|\| !ready \|\| modalLayerOpen/);
});

test('原生播放器画面从播放器边框内侧开始定位', async () => {
  const source = await readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8');

  assert.match(source, /x:\s*stageRect\.left \+ stage\.clientLeft \+ bounds\.x/);
  assert.match(source, /y:\s*stageRect\.top \+ stage\.clientTop \+ bounds\.y/);
});

test('预设拖拽在 WebView 原生拖放循环中同步保留源索引', async () => {
  const source = await readFile(new URL('../src/components/presetSystem.tsx', import.meta.url), 'utf8');

  assert.match(source, /const dragIndexRef = useRef<number \| null>\(null\)/);
  assert.match(source, /dragIndexRef\.current = i;\s*setDragIndex\(i\)/);
  assert.match(source, /e\.dataTransfer\.getData\('text\/plain'\)/);
  assert.match(source, /const from = dragIndexRef\.current \?\?/);
  assert.match(source, /dragIndexRef\.current = null;/);
});

test('全部弹窗注册共享模态层且播放器保留帧与弹窗同速淡出', async () => {
  const [appSource, pickerSource, tabsSource, playerSource, theme] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/MediaPickerDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tabs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /function UpdateDialog[\s\S]*useModalLayerRegistration\(\)/);
  assert.match(appSource, /function AppSettingsDialog[\s\S]*useModalLayerRegistration\(\)/);
  assert.match(pickerSource, /function MediaPickerDialog[\s\S]*useModalLayerRegistration\(open\)/);
  assert.match(tabsSource, /function TaskFailureDialog[\s\S]*useModalLayerRegistration\(\)/);
  assert.match(playerSource, /playerFrame\(mpvPlayerId, 960\)/);
  assert.match(playerSource, /surfaceGenerationRef/);
  assert.match(playerSource, /surface\.visible && \(generation !== surfaceGenerationRef\.current \|\| isModalLayerOpen\(\)\)/);
  assert.match(playerSource, /modalPreviewHidden \? ' se-player-modal-hidden' : ''/);
  assert.match(playerSource, /se-player-modal-hidden/);
  assert.match(playerSource, /previewFrame\(filePathRef\.current, timeRef\.current, 960\)/);
  assert.match(playerSource, /setModalPreviewHidden\(false\)[\s\S]*setTimeout\(\(\) => \{/);
  assert.match(playerSource, /useLayoutEffect\(\(\) => subscribeModalLayerPreparation\(\(\) => \{/);
  assert.match(playerSource, /return queueSurfaceUpdate\(\{ x: 0, y: 0, width: 1, height: 1, visible: false \}, generation\)/);
  assert.match(playerSource, /hide native preview before modal failed/);
  assert.match(theme, /html\.se-modal-layer-pending \.se-dialog-backdrop \{[\s\S]*visibility: hidden/);
  assert.match(playerSource, /useLayoutEffect\(\(\) => \{\s*if \(!modalLayerOpen\)/);
  assert.match(playerSource, /useLayoutEffect\(\(\) => \{\s*if \(modalLayerOpen\)/);
  assert.match(playerSource, /!ready \|\| modalLayerOpen[\s\S]*!nativeSurfaceRevealReady/);
  assert.doesNotMatch(playerSource, /nativeFirstFrameRevealReady|se-player-content-hidden/);
  assert.match(appSource, /<ui\.AnimatedHeight>[\s\S]*se-update-message[\s\S]*<\/ui\.AnimatedHeight>/);
  assert.match(theme, /\.se-dialog\s*\{[\s\S]*animation:\s*se-dialog-in 160ms/);
  assert.match(theme, /\.se-player-canvas, \.se-player-video\s*\{[\s\S]*transition:\s*opacity 160ms/);
});

test('更新检查读取 GitHub Release 且仓库链接调用受限系统浏览器命令', async () => {
  const [appSource, bridgeSource, rustSource] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /openUrl\(repositoryUrl\)/);
  assert.match(bridgeSource, /invoke<void>\('open_url', \{ url \}\)/);
  assert.match(rustSource, /api\.github\.com\/repos\/AngleNaris\/shadowencoder\/releases\/latest/);
  assert.match(rustSource, /async fn update_check\(\)[\s\S]*run_blocking\(update_check_blocking\)\.await/);
  assert.match(rustSource, /fn is_allowed_project_url/);
});

test('流程画布保留可移动输入节点、收缩参数和易命中的方形连接点', async () => {
  const [theme, editor, dit] = await Promise.all([
    readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/WorkflowEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(theme, /\.se-workflow-graph-viewport\s*\{[^}]*height:\s*clamp\(420px, 58vh, 640px\);[^}]*overflow:\s*hidden;/);
  assert.match(theme, /\.se-workflow-flow-node\s*\{[^}]*width:\s*268px;[^}]*background:\s*var\(--surface-2\);[^}]*cursor:\s*grab;/);
  assert.match(theme, /\.se-workflow-handle\.react-flow__handle\s*\{[^}]*width:\s*9px;[^}]*min-width:\s*9px;[^}]*height:\s*9px;[^}]*min-height:\s*9px;[^}]*border-radius:\s*0;[^}]*transform:\s*translateY\(-50%\);/);
  assert.match(theme, /\.se-workflow-handle\.react-flow__handle::before\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
  assert.match(theme, /\.se-workflow-handle\.react-flow__handle-left\s*\{[^}]*left:\s*0;[^}]*translate\(-50%, -50%\)/);
  assert.match(editor, /interactionWidth:\s*28/);
  assert.match(editor, /<Handle[\s\S]*className=\{`se-workflow-handle is-\$\{port\.type\}\$\{connectionState\}`\}/);
  assert.match(editor, /sourceHandle:\s*`out:\$\{edge\.sourcePort\}`[\s\S]*targetHandle:\s*`in:\$\{edge\.targetPort\}`/);
  assert.match(editor, /deletable:\s*!disabled, draggable:\s*!disabled/);
  assert.match(editor, /useNodesState<FlowNode>\(graphNodes\)/);
  assert.match(editor, /const selectedIds = new Set\(current\.filter\(\(node\) => node\.selected\)\.map\(\(node\) => node\.id\)\)/);
  assert.match(editor, /graphNodes\.map\(\(node\) => \(\{ \.\.\.node, selected: selectedIds\.has\(node\.id\) \}\)\)/);
  assert.match(editor, /onNodesChange=\{onNodesChange\}/);
  assert.match(editor, /onNodeDragStop=\{\(_, _node, draggedNodes\) =>[\s\S]*new Map\(draggedNodes\.map\(\(node\) => \[node\.id, node\.position\]\)\)[\s\S]*startPosition: positions\.get\(WORKFLOW_GRAPH_START_ID\) \?\? graph\.startPosition[\s\S]*const position = positions\.get\(item\.id\)/);
  assert.doesNotMatch(editor, /onNodeDragStop=\{\(_, node\) =>/);
  assert.match(editor, /<ui\.AnimatedCollapse open=\{data\.expanded\}/);
  assert.ok((editor.match(/className="se-workflow-node-editor nodrag nopan"/g) ?? []).length >= 5);
  assert.match(editor, /onNodeDoubleClick=\{\(_, node\) =>/);
  assert.match(editor, /setExpandedId\(\(current\) => current === node\.id \? '' : node\.id\)/);
  assert.match(editor, /<ControlButton aria-label="画布操作说明"/);
  assert.match(editor, /<ControlButton aria-label="撤销"[\s\S]*<ControlButton aria-label="重做"/);
  assert.match(editor, /const \[pastGraphs, setPastGraphs\] = useState<WorkflowGraph\[\]>\(\[\]\)/);
  assert.match(editor, /const \[futureGraphs, setFutureGraphs\] = useState<WorkflowGraph\[\]>\(\[\]\)/);
  assert.match(editor, /const commitGraph = useCallback[\s\S]*setPastGraphs[\s\S]*setFutureGraphs\(\[\]\)/);
  assert.match(editor, /event\.key\.toLowerCase\(\)[\s\S]*key === 'z'[\s\S]*key === 'y'/);
  assert.match(editor, /<dialog ref=\{helpDialogRef\}/);
  assert.doesNotMatch(editor, /const \[selectedId, setSelectedId\]|selected:\s*selectedId\b/);
  assert.match(editor, /panOnScroll=\{false\}[\s\S]*panOnDrag=\{\[1\]\}[\s\S]*panActivationKeyCode="Alt"[\s\S]*selectionOnDrag/);
  assert.doesNotMatch(editor, /panOnDrag=\{\[[^\]]*2/);
  assert.match(editor, /onConnectStart=\{startConnection\}[\s\S]*onConnectEnd=\{\(\) => setActiveConnection\(null\)\}[\s\S]*isValidConnection=\{isValidConnection\}/);
  assert.match(editor, /connectWorkflowGraph\(graph, connection\.source, sourcePort, connection\.target, targetPort\) !== graph/);
  assert.match(editor, /is-connectable-target[\s\S]*is-incompatible-target/);
  assert.match(editor, /groupLabel: index === 0 \? '执行'[\s\S]*groupLabel: '检测'[\s\S]*groupLabel: '逻辑'/);
  assert.match(editor, /issue && <div className="se-workflow-validation" role="status">\{issue\}<\/div>/);
  assert.match(dit, /setWorkflowEditorKey\(\(current\) => current \+ 1\)/);
  assert.match(dit, /<WorkflowEditor key=\{workflowEditorKey\} value=\{workflow\} onChange=\{setWorkflow\} disabled=\{task\.running\} issue=\{workflowCanvasIssue\} \/>/);
  assert.doesNotMatch(dit, /<div className="se-workflow-validation">/);
  assert.match(theme, /\.se-workflow-validation\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*12px;[^}]*left:\s*12px;/);
  assert.match(editor, /fitView\(\{ nodes: \[\{ id: focusNodeId \}\], duration: reduced \? 0 : 320/);
  assert.match(editor, /screenToFlowPosition/);
  assert.equal((editor.match(/event\.stopPropagation\(\)/g) ?? []).length >= 3, true);
  assert.match(editor, /className="se-workflow-graph-viewport" onContextMenu=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(editor, /<ui\.ContextMenu/);
  assert.doesNotMatch(editor, /se-workflow-graph-toolbar/);
  assert.match(editor, /function WorkflowNodeEditor/);
  assert.match(theme, /\.se-workflow-flow-node\.selected\s*\{[^}]*background:\s*var\(--surface-3\);/);
  assert.match(theme, /\.se-collapse\s*\{[^}]*transition:[^}]*height 160ms/);
  assert.match(theme, /\.se-workflow-help-dialog\s*\{[^}]*border-radius:\s*0;/);
  const nodeEditor = editor.slice(editor.indexOf('function WorkflowNodeEditor'), editor.indexOf('export function WorkflowEditor'));
  assert.doesNotMatch(nodeEditor, /<span>动作<\/span>/);
  assert.match(nodeEditor, /ACTION_PRESET_LABELS\[node\.kind\]/);
  assert.doesNotMatch(editor, /se-workflow-graph-node-id|node\.id\.slice\(-6\)|ACTION_EXPANDED_HEIGHT|height:\s*nodeHeight/);
  assert.doesNotMatch(theme, /\.se-workflow-node-list/);
});
