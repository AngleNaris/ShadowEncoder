import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('素材浏览器仅通过勾选改变选择，单击行只聚焦', async () => {
  const picker = await readFile(new URL('../src/components/MediaPickerDialog.tsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(picker, /onClick=\{\(event\) => \{\s*setFocusedPath\(entry\.path\)/);
  assert.doesNotMatch(picker, /onClick=\{\(\) => toggle\(entry\)\}/);
  assert.match(picker, /type="checkbox"[\s\S]*onChange=\{\(event\) => setEntrySelected\(entry, event\.target\.checked\)\}/);
  assert.doesNotMatch(picker, /选择当前目录|se-media-picker-selection/);
  assert.doesNotMatch(ui, /onClearSelection|IconDeselect/);
  assert.doesNotMatch(app, /onClearSelection=/);
});

test('素材浏览器提供卷标、修改日期和四列排序契约', async () => {
  const picker = await readFile(new URL('../src/components/MediaPickerDialog.tsx', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/lib/ffmpeg.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');

  for (const [column, label] of [
    ['name', '名称'],
    ['modified', '修改日期'],
    ['size', '大小'],
    ['type', '类型'],
  ]) {
    assert.match(picker, new RegExp(`column="${column}" label="${label}"`));
  }
  assert.match(picker, /sortedEntries[\s\S]*compareEntries/);
  assert.match(picker, /root\.label[\s\S]*navigate\(root\.path\)/);
  assert.match(bridge, /modifiedTimeMs: number \| null/);
  assert.match(bridge, /interface MediaBrowserRoot[\s\S]*path: string;[\s\S]*label: string;/);
  assert.match(backend, /struct MediaBrowserRoot[\s\S]*path: String,[\s\S]*label: String/);
  assert.match(backend, /modified_time_ms: Option<u64>/);
  assert.match(backend, /GetVolumeInformationW/);
  assert.match(cargo, /"Win32_Storage_FileSystem"/);
});

test('素材面板按钮按添加一行、全选与清除并排行布局', async () => {
  const picker = await readFile(new URL('../src/components/MediaPickerDialog.tsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

  assert.match(ui, /className="se-btn-span2">添加素材<\/Button>/);
  assert.match(ui, /onSelectAll[\s\S]*title="全选">全选<\/Button>/);
  assert.doesNotMatch(ui, /onSelectAll[\s\S]*className="se-btn-span2">全选<\/Button>/);
  assert.match(ui, /IconTrash[\s\S]*className="se-btn-danger">清除列表<\/Button>/);
  assert.match(picker, /se-media-picker-title-group[\s\S]*se-dialog-title[\s\S]*se-count-chip[\s\S]*selected\.size/);
  assert.doesNotMatch(picker, /添加 \$\{selected\.size\} 项/);
  assert.match(picker, /se-media-picker-list-viewport[\s\S]*se-media-picker-list-head[\s\S]*se-media-picker-list/);
  assert.match(picker, /se-foot-actions[\s\S]*IconClose[\s\S]*IconPlus/);
  assert.match(css, /\.se-foot-actions\s*\{[^}]*gap:\s*12px;[^}]*width:\s*100%/);
  assert.match(css, /\.se-btn-grid\s*\{[^}]*gap:\s*8px;/);
  assert.match(css, /\.se-process-btns\s*\{[^}]*gap:\s*8px;/);
  assert.match(css, /\.se-media-picker \.se-dialog-foot,\s*\.se-preset-dialog \.se-dialog-foot\s*\{\s*padding:\s*12px;/);
  assert.match(css, /\.se-media-picker-sort:focus-visible/);
  assert.match(css, /\.se-media-picker-list-viewport\s*\{[\s\S]*overflow:\s*auto;[\s\S]*scrollbar-gutter:\s*stable;/);
  assert.match(css, /\.se-media-picker-list-head\s*\{[\s\S]*position:\s*sticky;/);
  assert.match(css, /\.se-media-picker-modified,[\s\S]*\.se-media-picker-size\s*\{[\s\S]*padding:\s*0 4px;/);
  assert.doesNotMatch(css, /\.se-media-picker-sort:nth-child\(3\)[^}]*justify-content:\s*flex-end|\.se-media-picker-size\s*\{[^}]*text-align:\s*right/);
  assert.match(css, /button\.se-btn-with-icon > svg,[\s\S]*\.se-media-picker-roots button > svg,[\s\S]*\.se-media-picker-sort-icon > svg\s*\{[\s\S]*top:\s*-1px;/);
});

test('DIT 素材选择回退逻辑保留但不显示冗余说明', async () => {
  const tabs = await readFile(new URL('../src/components/DitTabs.tsx', import.meta.url), 'utf8');

  assert.match(tabs, /fl\.hasSelection \? fl\.selectedSourcePaths : fl\.paths/);
  assert.doesNotMatch(tabs, /使用素材列表中已勾选|未勾选时(?:使用|处理)列表中的全部素材|title="流程输入"/);
});

test('共享素材列表提供紧凑目录树和部分选中状态', async () => {
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
  const context = await readFile(new URL('../src/lib/fileListContext.tsx', import.meta.url), 'utf8');

  assert.match(ui, /<ul role="tree">/);
  assert.match(ui, /role="treeitem"[\s\S]*aria-expanded=/);
  assert.match(ui, /onToggleExpanded\(item\.path\)/);
  assert.match(ui, /item\.indeterminate \? 'mixed' : item\.checked/);
  assert.doesNotMatch(ui, /se-filelist-expand(?:-spacer)?/);
  assert.doesNotMatch(css, /\.se-filelist-expand(?:-spacer)?/);
  assert.match(context, /setSelectedKeys\(\(current\) => setTreeSelection\(current, path, currentIndex, shouldSelect\)\)/);
  assert.match(context, /ensureTree\(node\.rootPath\)[\s\S]*setTreeSelection\(current, path, loadedIndex, shouldSelect\)/);
  assert.match(ui, /export function FileList\(\{[\s\S]*items = \[\]/);
  assert.match(ui, /export function SharedFilePanel\(\{[\s\S]*items = \[\],[\s\S]*totalCount = 0/);
  assert.match(css, /\.se-filelist li\s*\{[^}]*height:\s*40px;/);
  assert.match(css, /\.se-filelist li\s*\{[^}]*font-size:\s*13px;/);
  assert.match(css, /\.se-filelist \.se-check-sm\s*\{[\s\S]*width:\s*24px;[\s\S]*height:\s*100%;/);
  assert.match(css, /\.se-filelist \.se-check-sm \.se-check-box\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/);
  assert.match(css, /\.se-filelist-remove\.se-icon-btn\s*\{[\s\S]*width:\s*28px;[\s\S]*height:\s*28px;/);
  assert.match(ui, /<IconFolder size=\{16\} \/>[\s\S]*<IconFile size=\{16\} \/>/);
  assert.match(ui, /className="se-filelist-remove se-icon-btn"[\s\S]*<IconClose size=\{15\} \/>/);
  assert.match(ui, /fileListBranchRows[\s\S]*animateFileListRowsOut/);
  assert.match(ui, /data-tree-depth=\{item\.depth\}/);
  assert.match(css, /@keyframes se-filelist-row-in/);
  assert.match(css, /\.se-filelist-remove\.se-icon-btn\s*\{[\s\S]*position:\s*absolute;[\s\S]*background:\s*var\(--surface-2\);/);
  assert.match(ui, /text\.scrollWidth - viewport\.clientWidth/);
  assert.match(ui, /onMouseEnter=\{\(event\) => updateFileNameMarquee\(event\.currentTarget, true\)\}/);
  assert.match(ui, /className="se-filelist-name-text"/);
  assert.match(css, /\.se-filelist-name\.is-overflowing \.se-filelist-name-text\s*\{[\s\S]*animation:\s*se-file-name-pan/);
  assert.match(css, /@keyframes se-file-name-pan/);
  assert.match(css, /--tree-depth[\s\S]*13px/);
  assert.match(css, /\.se-check\.is-indeterminate \.se-check-box::after/);
});
