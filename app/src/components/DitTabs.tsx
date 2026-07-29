import React, { useEffect, useMemo, useState } from 'react';
import * as ui from './ui';
import VideoPlayer from './VideoPlayer';
import {
  IconFolder,
  IconPlayAll,
  IconPlus,
  IconStop,
  IconTrash,
} from './icons';
import {
  checkVideos,
  mixAudio,
  pickPath,
  runDitBackup,
  transcode,
  type DitBackupRequest,
  type DitBackupSummary,
} from '../lib/ffmpeg';
import { useFileList } from '../lib/fileListContext';
import {
  DEFAULT_OUTPUT_FORM,
  TemplateEditor,
  toOutputSettings,
  type TemplateTokenOption,
} from './OutputSettings';
import {
  DEFAULT_BACKUP_PRESET_PARAMS,
  PresetManageDialog,
  PresetManager,
  usePresets,
  type Preset,
  type PresetBuilderCtx,
} from './presetSystem';
import { WorkflowEditor, WorkflowPresetBuilder } from './WorkflowEditor';
import {
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_CONDITION_LABELS,
  normalizeWorkflowDefinition,
  workflowNodeCounts,
  type WorkflowActionKind,
  type WorkflowActionNode,
  type WorkflowConditionNode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../lib/workflow';
import {
  collectWorkflowSourceFiles,
  evaluateBackupCapacity,
  formatWorkflowBytes,
  sourceContainsMedia,
  waitForNewStorageVolume,
} from '../lib/workflowRuntime';
import {
  registerAgentTaskHandler,
  type AgentTaskExecutionResult,
} from '../lib/agentTaskBridge';
import {
  DEFAULT_ENCODE_FORM,
  ResultViewContent,
  ResultViewProgress,
  ResultViewTitle,
  ToolWorkspace,
  useActiveMedia,
  useResultView,
  useTaskRunner,
} from './tabs';

type BackupDestination = { id: string; path: string };

type BackupForm = {
  destinations: BackupDestination[];
  extensions: string[];
  minSizeMb: number;
  mediaOnly: boolean;
  recursive: boolean;
  operation: 'copy' | 'move';
  verifyMd5: boolean;
  destinationNameMode: 'original' | 'template';
  destinationNameTemplate: string;
  directoryStructure: 'preserve' | 'flatten';
  renameMode: 'original' | 'template';
  renameTemplate: string;
  conflictStrategy: 'rename' | 'subdirectory';
  conflictRenameTemplate: string;
  conflictSubdirectory: string;
};

let backupDestinationSequence = 0;
function createBackupDestination(path = ''): BackupDestination {
  backupDestinationSequence += 1;
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `backup-destination-${backupDestinationSequence}`,
    path,
  };
}

const DEFAULT_BACKUP_FORM: BackupForm = {
  ...DEFAULT_BACKUP_PRESET_PARAMS,
  destinations: DEFAULT_BACKUP_PRESET_PARAMS.destinations.map(createBackupDestination),
  extensions: [...DEFAULT_BACKUP_PRESET_PARAMS.extensions],
};

const DATE_TIME_TEMPLATE_TOKENS: TemplateTokenOption[] = [
  { token: '{date}', label: '日期', title: '插入任务开始日期，例如 20260728' },
  { token: '{time}', label: '时间', title: '插入任务开始时间，例如 143025' },
];

const DIRECTORY_TEMPLATE_TOKENS: TemplateTokenOption[] = [
  { token: '{name}', label: '目录名', title: '插入原素材目录名称' },
  { token: '{index}', label: '序号', title: '插入四位来源序号，例如 0001' },
  ...DATE_TIME_TEMPLATE_TOKENS,
];

const FILE_TEMPLATE_TOKENS: TemplateTokenOption[] = [
  { token: '{name}', label: '素材名', title: '插入原素材名称' },
  { token: '{index}', label: '序号', title: '插入四位队列序号，例如 0001' },
  ...DATE_TIME_TEMPLATE_TOKENS,
];

const CONFLICT_TEMPLATE_TOKENS: TemplateTokenOption[] = [
  { token: '{name}', label: '文件名', title: '插入冲突文件原名称' },
  { token: '{index}', label: '冲突序号', title: '插入可用冲突序号，例如 2' },
];

function withoutLegacyExtensionToken(template: string): string {
  return template
    .replace(/\.\s*\{ext\}/gi, '')
    .replace(/\{ext\}/gi, '')
    .replace(/\.+$/, '');
}

function normalizeBackupForm(params: Record<string, any> = {}): BackupForm {
  const merged: Record<string, any> = { ...DEFAULT_BACKUP_PRESET_PARAMS, ...params };
  const destinations = Array.isArray(merged.destinations)
    ? merged.destinations.map((value: unknown) => createBackupDestination(
      typeof value === 'object' && value !== null && 'path' in value
        ? String((value as { path: unknown }).path ?? '')
        : String(value ?? ''),
    ))
    : [createBackupDestination()];
  const extensions = Array.isArray(merged.extensions)
    ? merged.extensions.map((value: unknown) => normalizeExtensionTag(String(value ?? ''))).filter(Boolean)
    : String(merged.extensions || '').split(/[\s,;]+/).map(normalizeExtensionTag).filter(Boolean);
  return {
    destinations: destinations.length > 0 ? destinations : [createBackupDestination()],
    extensions,
    minSizeMb: Number.isFinite(Number(merged.minSizeMb)) ? Math.max(0, Number(merged.minSizeMb)) : 0,
    mediaOnly: merged.mediaOnly !== false,
    recursive: merged.recursive !== false,
    operation: merged.operation === 'move' ? 'move' : 'copy',
    verifyMd5: merged.verifyMd5 !== false,
    destinationNameMode: merged.destinationNameMode === 'template' ? 'template' : 'original',
    destinationNameTemplate: String(merged.destinationNameTemplate || merged.destinationSubdirectory || ''),
    directoryStructure: merged.directoryStructure === 'flatten' ? 'flatten' : 'preserve',
    renameMode: merged.renameMode === 'template' || merged.renameTemplate ? 'template' : 'original',
    renameTemplate: withoutLegacyExtensionToken(String(merged.renameTemplate || '')),
    conflictStrategy: merged.conflictStrategy === 'subdirectory' ? 'subdirectory' : 'rename',
    conflictRenameTemplate: withoutLegacyExtensionToken(String(merged.conflictRenameTemplate || '{name}_{index}')),
    conflictSubdirectory: String(merged.conflictSubdirectory || 'Conflicts'),
  };
}

function templateTimeParts(now: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  };
}

function resolveTemplateTime(template: string, now: Date): string {
  const parts = templateTimeParts(now);
  return template
    .split('{date}').join(parts.date)
    .split('{time}').join(parts.time);
}

function previewDirectoryTemplate(template: string): string {
  return resolveTemplateTime(template.trim() || '{name}', new Date())
    .split('{name}').join('素材目录')
    .split('{index}').join('0001');
}

function appendPreviewNumber(filename: string, number: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex > 0
    ? `${filename.slice(0, dotIndex)}_${number}${filename.slice(dotIndex)}`
    : `${filename}_${number}`;
}

function previewFileTemplate(
  template: string,
  index = '0001',
  fallback = '{name}',
  ensureIndex = false,
): string {
  const sourceExtension = 'mov';
  const activeTemplate = template.trim() || fallback;
  let rendered = resolveTemplateTime(activeTemplate, new Date())
    .split('{name}').join('素材名称')
    .split('{index}').join(index)
    .split('{ext}').join(sourceExtension);
  rendered = `${rendered.replace(/\.[^./\\]+$/, '').replace(/\.+$/, '')}.${sourceExtension}`;
  if (ensureIndex && !activeTemplate.includes('{index}')) rendered = appendPreviewNumber(rendered, index);
  return rendered;
}

function normalizeExtensionTag(value: string): string {
  const extension = value.trim().replace(/^\.+/, '').toLocaleLowerCase();
  return extension;
}

function toBackupPresetParams(form: BackupForm): Record<string, any> {
  return {
    ...form,
    destinations: form.destinations.map((destination) => destination.path),
    extensions: [...form.extensions],
  };
}

function toBytes(megabytes: number): number | null {
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : null;
}

function buildBackupRequest(form: BackupForm, sourcePaths: string[], now = new Date()): DitBackupRequest {
  return {
    sourcePaths,
    extensions: form.extensions,
    minSizeBytes: toBytes(form.minSizeMb),
    mediaOnly: form.mediaOnly,
    recursive: form.recursive,
    operation: form.operation,
    destinations: form.destinations.map((destination) => destination.path.trim()).filter(Boolean),
    verifyMd5: form.verifyMd5,
    renameTemplate: form.renameMode === 'template'
      ? resolveTemplateTime(withoutLegacyExtensionToken(form.renameTemplate.trim()), now)
      : '',
    directoryNameTemplate: form.destinationNameMode === 'template'
      ? resolveTemplateTime(form.destinationNameTemplate.trim(), now)
      : '',
    flattenSubdirectories: form.directoryStructure === 'flatten',
    conflictStrategy: form.conflictStrategy,
    conflictRenameTemplate: resolveTemplateTime(withoutLegacyExtensionToken(form.conflictRenameTemplate.trim()), now),
    conflictSubdirectory: form.conflictSubdirectory.trim(),
    reuseIdentical: true,
  };
}

function hasInvalidBackupOptions(form: BackupForm, request: DitBackupRequest): boolean {
  return request.destinations.length === 0
    || (form.destinationNameMode === 'template' && !form.destinationNameTemplate.trim())
    || (form.renameMode === 'template' && !form.renameTemplate.trim())
    || (form.conflictStrategy === 'rename' && !form.conflictRenameTemplate.trim())
    || (form.conflictStrategy === 'subdirectory' && !form.conflictSubdirectory.trim());
}

function successfulBackupPaths(summary: DitBackupSummary, destinationIndex = 0): string[] {
  return summary.results
    .filter((result) => result.success && result.outputPaths[destinationIndex])
    .map((result) => result.outputPaths[destinationIndex]);
}

function successfulBackupOutputs(summary: DitBackupSummary): string[] {
  return summary.results
    .filter((result) => result.success)
    .flatMap((result) => result.outputPaths);
}

function BackupFields({ value, onChange, disabled }: {
  value: BackupForm;
  onChange: React.Dispatch<React.SetStateAction<BackupForm>>;
  disabled: boolean;
}) {
  const set = <K extends keyof BackupForm>(key: K, next: BackupForm[K]) => {
    onChange((current) => ({ ...current, [key]: next }));
  };
  const chooseDestination = async (id: string) => {
    const path = await pickPath('dir');
    if (!path) return;
    onChange((current) => ({
      ...current,
      destinations: current.destinations.map((item) => item.id === id ? { ...item, path } : item),
    }));
  };
  const updateDestination = (id: string, path: string) => {
    onChange((current) => ({
      ...current,
      destinations: current.destinations.map((item) => item.id === id ? { ...item, path } : item),
    }));
  };
  const removeDestination = (id: string) => {
    onChange((current) => ({
      ...current,
      destinations: current.destinations.filter((item) => item.id !== id),
    }));
  };

  const executionRows: ui.AnimatedFieldRow[] = [
    {
      id: 'operation',
      content: (
        <>
          <ui.FieldLabel>操作方式</ui.FieldLabel>
          <ui.ComboBox
            value={value.operation}
            options={[
              { label: '复制', value: 'copy', tags: ['保留源文件'] },
              { label: '移动', value: 'move', tags: ['成功后删除源文件'] },
            ]}
            onChange={(next) => set('operation', next)}
            disabled={disabled}
          />
        </>
      ),
    },
    {
      id: 'destination-name-mode',
      content: (
        <>
          <ui.FieldLabel>备份目录名称</ui.FieldLabel>
          <ui.ComboBox
            value={value.destinationNameMode}
            options={[
              { label: '原名称', value: 'original', tags: ['文件 / 目录'] },
              { label: '使用名称模板', value: 'template' },
            ]}
            onChange={(next) => set('destinationNameMode', next)}
            disabled={disabled}
          />
        </>
      ),
    },
  ];
  if (value.destinationNameMode === 'template') {
    executionRows.push({
      id: 'destination-name-template',
      content: (
        <>
          <ui.FieldLabel>名称编辑器</ui.FieldLabel>
          <TemplateEditor
            value={value.destinationNameTemplate}
            tokens={DIRECTORY_TEMPLATE_TOKENS}
            preview={previewDirectoryTemplate(value.destinationNameTemplate)}
            placeholder="例如：{date}_{name}"
            ariaLabel="备份目录名称模板"
            disabled={disabled}
            onChange={(next) => set('destinationNameTemplate', next)}
          />
        </>
      ),
    });
  }
  executionRows.push(
    {
      id: 'directory-structure',
      content: (
        <>
          <ui.FieldLabel>目录结构</ui.FieldLabel>
          <ui.ComboBox
            value={value.directoryStructure}
            options={[{ label: '保留子目录结构', value: 'preserve' }, { label: '塌陷子目录', value: 'flatten' }]}
            onChange={(next) => set('directoryStructure', next)}
            disabled={disabled}
          />
        </>
      ),
    },
    {
      id: 'rename-mode',
      content: (
        <>
          <ui.FieldLabel>文件重命名</ui.FieldLabel>
          <ui.ComboBox
            value={value.renameMode}
            options={[{ label: '保留原文件名', value: 'original' }, { label: '使用名称模板', value: 'template' }]}
            onChange={(next) => set('renameMode', next)}
            disabled={disabled}
          />
        </>
      ),
    },
  );
  if (value.renameMode === 'template') {
    executionRows.push({
      id: 'rename-template',
      content: (
        <>
          <ui.FieldLabel>名称编辑器</ui.FieldLabel>
          <TemplateEditor
            value={value.renameTemplate}
            tokens={FILE_TEMPLATE_TOKENS}
            preview={previewFileTemplate(value.renameTemplate)}
            placeholder="例如：A001_{index}_{name}"
            ariaLabel="备份文件名称模板"
            disabled={disabled}
            onChange={(next) => set('renameTemplate', withoutLegacyExtensionToken(next))}
          />
        </>
      ),
    });
  }

  const conflictRows: ui.AnimatedFieldRow[] = [
    {
      id: 'conflict-strategy',
      content: (
        <>
          <ui.FieldLabel>处理方式</ui.FieldLabel>
          <ui.ComboBox
            value={value.conflictStrategy}
            options={[{ label: '自动重命名', value: 'rename' }, { label: '保存到子目录', value: 'subdirectory' }]}
            onChange={(next) => set('conflictStrategy', next)}
            disabled={disabled}
          />
        </>
      ),
    },
  ];
  if (value.conflictStrategy === 'rename') {
    conflictRows.push({
      id: 'conflict-rename-template',
      content: (
        <>
          <ui.FieldLabel>重命名规则</ui.FieldLabel>
          <TemplateEditor
            value={value.conflictRenameTemplate}
            tokens={CONFLICT_TEMPLATE_TOKENS}
            preview={previewFileTemplate(value.conflictRenameTemplate, '2', '{name}_{index}', true)}
            placeholder="例如：{name}_{index}"
            ariaLabel="冲突文件重命名规则"
            disabled={disabled}
            onChange={(next) => set('conflictRenameTemplate', withoutLegacyExtensionToken(next))}
          />
        </>
      ),
    });
  } else {
    conflictRows.push({
      id: 'conflict-subdirectory',
      content: (
        <>
          <ui.FieldLabel>子目录名称</ui.FieldLabel>
          <ui.DropInput
            value={value.conflictSubdirectory}
            placeholder="例如：Conflicts"
            onChange={(next) => set('conflictSubdirectory', next)}
            disabled={disabled}
          />
        </>
      ),
    });
  }

  const addDestination = () => {
    set('destinations', [...value.destinations, createBackupDestination()]);
  };
  const destinationList = (
    <ui.AnimatedList
      items={value.destinations}
      getKey={(destination) => destination.id}
      className="se-dit-destinations"
      itemClassName="se-dit-destination-motion"
      layout="flow"
      renderItem={(destination, index) => (
        <div className="se-dit-destination">
          <span className="se-dit-destination-index">{index + 1}</span>
          <ui.DropInput
            value={destination.path}
            placeholder={`目标目录 ${index + 1}`}
            onChange={(path) => updateDestination(destination.id, path)}
            onDrop={(path) => updateDestination(destination.id, path)}
            disabled={disabled}
          />
          <ui.Button className="se-icon-btn" icon={<IconFolder size={14} />} title="选择目标目录" onClick={() => chooseDestination(destination.id)} disabled={disabled} />
          <ui.Button
            className="se-icon-btn se-btn-danger"
            icon={<IconTrash size={14} />}
            title="移除目标目录"
            onClick={() => removeDestination(destination.id)}
            disabled={disabled || value.destinations.length === 1}
          />
        </div>
      )}
    />
  );

  return (
    <>
      <ui.ParamGroup title="备份来源">
        <ui.FieldGrid>
          <ui.FieldLabel>文件扩展名</ui.FieldLabel>
          <ui.TagInput
            values={value.extensions}
            placeholder="输入扩展名后按空格，例如 mp4"
            normalize={normalizeExtensionTag}
            onChange={(next) => set('extensions', next)}
            disabled={disabled}
          />
          <ui.FieldLabel>最小体积</ui.FieldLabel>
          <ui.NumberField value={value.minSizeMb} min={0} max={8_000_000} step={10} decimals={0} suffix="MB · 0 不限制" onChange={(next) => set('minSizeMb', next)} disabled={disabled} />
        </ui.FieldGrid>
        <ui.Checkbox checked={value.mediaOnly} onChange={(next) => set('mediaOnly', next)} disabled={disabled}>排除非媒体文件</ui.Checkbox>
        <ui.Checkbox checked={value.recursive} onChange={(next) => set('recursive', next)} disabled={disabled}>递归扫描子目录</ui.Checkbox>
      </ui.ParamGroup>

      <ui.ParamGroup title="备份目标" aside={(
        <ui.Button
          className="se-icon-btn"
          icon={<IconPlus size={14} />}
          title="添加目标目录"
          disabled={disabled}
          onClick={addDestination}
        />
      )}>
        {destinationList}
      </ui.ParamGroup>

      <ui.ParamGroup title="执行与校验">
        <ui.AnimatedFieldGrid rows={executionRows} />
        <ui.Checkbox checked={value.verifyMd5} onChange={(next) => set('verifyMd5', next)} disabled={disabled}>完成后执行 MD5 完整性校验</ui.Checkbox>
      </ui.ParamGroup>

      <ui.ParamGroup title="冲突解决">
        <ui.AnimatedFieldGrid rows={conflictRows} />
      </ui.ParamGroup>
    </>
  );
}

function BackupPresetBuilder({ ctx, initial }: { ctx: PresetBuilderCtx; initial: BackupForm }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [form, setForm] = useState<BackupForm>(() => normalizeBackupForm(initial));
  const reset = () => {
    setEditingId(null);
    setName('');
    setForm(normalizeBackupForm(initial));
  };
  const select = (id: string) => {
    const preset = ctx.presets.find((item) => item.id === id);
    if (!preset) return;
    setEditingId(id);
    setName(preset.name);
    setForm(normalizeBackupForm(preset.params));
  };

  useEffect(() => {
    if (ctx.isOpen) reset();
  }, [ctx.isOpen]);

  if (!ctx.isMounted) return null;
  return (
    <PresetManageDialog
      title="管理备份预设"
      compact
      scrollEditor
      presets={ctx.presets}
      editingId={editingId}
      onSelect={select}
      onNew={reset}
      onCopy={() => {
        if (!editingId) return;
        setEditingId(null);
        setName((current) => current ? `${current} 副本` : '副本');
      }}
      onDelete={() => {
        if (!editingId) return;
        ctx.onRemove(editingId);
        reset();
      }}
      onImport={ctx.onImport}
      onExport={ctx.onExport}
      onReorder={ctx.onReorder}
      onClose={ctx.onClose}
      onExited={ctx.onExited}
      closing={ctx.closing}
      onSave={() => {
        const data = { ...toBackupPresetParams(form), name };
        if (editingId) ctx.onUpdate(editingId, data);
        else ctx.onSaveNew(data);
      }}
      saveLabel={editingId ? '保存修改' : '保存预设'}
      canSave={Boolean(name.trim())}
    >
      <div className="se-preset-name">
        <ui.FieldLabel>预设名称</ui.FieldLabel>
        <input className="se-drop-input" value={name} placeholder="例如：双盘校验备份" onChange={(event) => setName(event.target.value)} />
      </div>
      <BackupFields value={form} onChange={setForm} disabled={false} />
    </PresetManageDialog>
  );
}

function DitActionBar({ running, disabled, label, onStart, onStop, onOpenOutput }: {
  running: boolean;
  disabled: boolean;
  label: string;
  onStart: () => void;
  onStop: () => void | Promise<void>;
  onOpenOutput?: () => void | Promise<void>;
}) {
  return (
    <div className="se-process-btns">
      <ui.Button
        primary
        className="se-process-main se-process-primary-full"
        icon={<IconPlayAll size={15} />}
        onClick={onStart}
        disabled={running || disabled}
      >
        {label}
      </ui.Button>
      {running ? (
        <ui.Button className="se-process-stop" icon={<IconStop size={15} />} onClick={onStop}>停止</ui.Button>
      ) : onOpenOutput ? (
        <ui.Button className="se-process-stop" icon={<IconFolder size={15} />} onClick={onOpenOutput}>打开输出目录</ui.Button>
      ) : (
        <ui.Button className="se-process-stop" icon={<IconStop size={15} />} disabled>停止</ui.Button>
      )}
    </div>
  );
}

export function DitBackupTab() {
  const fl = useFileList();
  const task = useTaskRunner();
  const [form, setForm] = useState<BackupForm>(DEFAULT_BACKUP_FORM);
  const [resultView, setResultView] = useResultView(task.running);
  const media = useActiveMedia(fl.activePath, false);
  const inputPaths = fl.hasSelection ? fl.selectedSourcePaths : fl.paths;
  const request = useMemo(() => buildBackupRequest(form, inputPaths), [form, inputPaths]);
  const invalid = request.sourcePaths.length === 0 || hasInvalidBackupOptions(form, request);

  const run = () => task.start(async () => {
    const summary = await runDitBackup(buildBackupRequest(form, inputPaths, new Date()));
    task.setPass(summary.completedFiles);
    task.setFail(summary.failedFiles);
    task.setOutputPaths(summary.cancelled ? [] : successfulBackupOutputs(summary));
    task.setDetail(summary.cancelled
      ? '备份已取消'
      : `备份完成 ${summary.completedFiles}，失败 ${summary.failedFiles}，过滤 ${summary.skippedFiles}`);
    if (!summary.cancelled && summary.failedFiles > 0) {
      throw new Error(summary.completedFiles > 0
        ? `部分备份失败：完成 ${summary.completedFiles}，失败 ${summary.failedFiles}`
        : `全部备份失败 (${summary.failedFiles})`);
    }
  });

  useEffect(() => registerAgentTaskHandler('backup', (agentTask) => task.start(async (): Promise<AgentTaskExecutionResult> => {
    const preset = findPreset(agentTask.presetSnapshots, agentTask.presetId, '备份', 'backup');
    if (agentTask.presetRevision > 0 && (preset.revision ?? 1) !== agentTask.presetRevision) {
      throw new Error('备份任务的预设快照版本不一致，请重新发起任务');
    }
    const agentForm = normalizeBackupForm(preset.params);
    const request: DitBackupRequest = {
      ...buildBackupRequest(agentForm, agentTask.inputPaths, new Date()),
      operation: 'copy',
      reuseIdentical: false,
    };
    if (request.sourcePaths.length === 0) throw new Error('没有可备份的素材');
    if (hasInvalidBackupOptions(agentForm, request)) throw new Error('备份目标或命名设置不完整');
    const summary = await runDitBackup(request);
    const outputPaths = summary.cancelled ? [] : successfulBackupOutputs(summary);
    task.setPass(summary.completedFiles);
    task.setFail(summary.failedFiles);
    task.setOutputPaths(outputPaths);
    const detail = summary.cancelled
      ? '备份已取消'
      : `备份完成 ${summary.completedFiles}，失败 ${summary.failedFiles}，过滤 ${summary.skippedFiles}`;
    task.setDetail(detail);
    if (!summary.cancelled && summary.failedFiles > 0) {
      throw new Error(summary.completedFiles > 0
        ? `部分备份失败：完成 ${summary.completedFiles}，失败 ${summary.failedFiles}`
        : `全部备份失败 (${summary.failedFiles})`);
    }
    return { outputPaths, detail };
  })), [
    task.setDetail,
    task.setFail,
    task.setOutputPaths,
    task.setPass,
    task.start,
  ]);

  return (
    <ToolWorkspace
      taskFailure={task.error ? { message: task.error, logs: task.logs, onClose: task.clearError } : undefined}
      params={(
        <>
          <PresetManager
            type="backup"
            onApply={(params) => setForm(normalizeBackupForm(params))}
            initialValues={toBackupPresetParams(form)}
            currentParams={toBackupPresetParams(form)}
            renderBuilder={(ctx) => <BackupPresetBuilder ctx={ctx} initial={form} />}
          />
          <BackupFields value={form} onChange={setForm} disabled={task.running} />
        </>
      )}
      actions={(
        <DitActionBar
          running={task.running}
          disabled={invalid}
          label="开始备份"
          onStart={run}
          onStop={task.cancel}
          onOpenOutput={task.outputPaths.length > 0 ? task.openOutputs : undefined}
        />
      )}
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={task.progress} detail={task.detail} eta={task.eta} pass={task.pass} fail={task.fail} running={task.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={task.logs.length} running={task.running} />}
      result={<ResultViewContent value={resultView} logs={task.logs} preview={<VideoPlayer src={media.src} filePath={media.path} cropEnabled={false} controlsDisabled={task.running} />} />}
    />
  );
}

type WorkflowPresetSets = Record<WorkflowActionKind, Preset[]>;
type WorkflowTaskRunner = ReturnType<typeof useTaskRunner>;

type WorkflowExecutionState = {
  paths: string[];
  pathsAreFiles: boolean;
  outputPaths: string[];
  pass: number;
  fail: number;
  lastStepSucceeded: boolean;
  lastBackupVerified: boolean;
};

type WorkflowExecutionEnvironment = {
  task: WorkflowTaskRunner;
  presets: WorkflowPresetSets;
  triggerKind: WorkflowDefinition['trigger']['kind'];
  agentMode: boolean;
  totalActions: number;
  completedActions: number;
  resolveMediaPaths: (paths: string[]) => Promise<string[]>;
};

function findPreset(
  presets: Preset[],
  id: string,
  label: string,
  expectedType?: Preset['type'],
): Preset {
  const preset = presets.find((item) => item.id === id);
  if (!preset) throw new Error(`${label}步骤未选择可用预设`);
  if (expectedType && preset.type !== expectedType) {
    throw new Error(`${label}任务收到错误类型的预设快照`);
  }
  return preset;
}

async function transcodePreset(paths: string[], preset: Preset, uniqueName = false): Promise<string[]> {
  const form: any = { ...DEFAULT_ENCODE_FORM, ...preset.params };
  return transcode({
    paths,
    videoCodec: form.videoCodec,
    videoProfile: form.videoProfile,
    crf: form.crf,
    speedPreset: form.preset,
    tune: form.tune,
    style: form.style,
    pixelFormat: form.pixelFormat,
    container: form.container,
    scaleW: form.scaleW,
    scaleH: form.scaleH,
    fps: form.fps,
    videoBitrate: form.videoBitrate,
    audioCodec: form.audioCodec,
    audioProfile: form.audioProfile,
    audioBitrate: form.audioBitrate,
    audioSampleRate: form.audioSampleRate,
    audioChannels: form.audioChannels,
    unsharp: form.unsharp,
    denoise: form.denoise,
    loudnorm: form.loudnorm,
    audioOnly: form.audioOnly,
    keepRes: form.keepRes,
    rateMode: form.rateMode || 'crf',
    targetFileSizeMb: form.targetFileSizeMb || 0,
    twoPass: !!form.twoPass,
    outputOptions: { ...toOutputSettings(form, preset.name), uniqueName },
  });
}

function workflowValidationIssues(
  definition: WorkflowDefinition,
  presets: WorkflowPresetSets,
): string[] {
  const issues: string[] = [];
  const visit = (nodes: WorkflowNode[]) => {
    for (const node of nodes) {
      if (node.type === 'condition') {
        if (node.condition.kind === 'backup_destinations_fit'
          && !presets.backup.some((preset) => preset.id === node.condition.backupPresetId)) {
          issues.push('容量判断引用的备份预设不存在');
        }
        visit(node.thenSteps);
        visit(node.elseSteps);
        continue;
      }
      const preset = presets[node.kind].find((item) => item.id === node.presetId);
      if (!preset) {
        issues.push(`${WORKFLOW_ACTION_LABELS[node.kind]}引用的预设不存在`);
        continue;
      }
      if ((preset.revision ?? 1) !== node.presetRevision) {
        issues.push(`${WORKFLOW_ACTION_LABELS[node.kind]}引用的预设已更新`);
      }
      if (node.kind === 'backup') {
        const form = normalizeBackupForm(preset.params);
        if (hasInvalidBackupOptions(form, buildBackupRequest(form, ['workflow-source']))) {
          issues.push(`备份预设“${preset.name}”的目标或命名设置不完整`);
        }
        if (definition.trigger.kind === 'removable' && form.operation === 'move') {
          issues.push('磁盘触发流程不能使用“移动源文件”的备份预设');
        }
      }
      if (node.kind === 'check') {
        const referenceId = String(preset.params.refEncPresetId || '');
        if (referenceId && !presets.transcode.some((item) => item.id === referenceId)) {
          issues.push(`检测预设“${preset.name}”引用的转码规范不存在`);
        }
      }
    }
  };
  visit(definition.steps);
  if (workflowNodeCounts(definition.steps).actions === 0) issues.push('流程至少需要一个执行步骤');
  return [...new Set(issues)];
}

function workflowLog(
  task: WorkflowTaskRunner,
  message: string,
  tone: 'normal' | 'pass' | 'warn' | 'fail' | 'muted' = 'normal',
) {
  task.appendLog({ kind: 'summary', stage: 'workflow', tone, message });
}

async function resolveWorkflowActionInputs(
  state: WorkflowExecutionState,
  environment: WorkflowExecutionEnvironment,
): Promise<string[]> {
  if (!state.pathsAreFiles) {
    state.paths = await environment.resolveMediaPaths(state.paths);
    state.pathsAreFiles = true;
  }
  if (state.paths.length === 0) throw new Error('当前步骤没有可处理的媒体文件');
  return state.paths;
}

async function runWorkflowAction(
  node: WorkflowActionNode,
  state: WorkflowExecutionState,
  environment: WorkflowExecutionEnvironment,
) {
  const { task, presets } = environment;
  const label = WORKFLOW_ACTION_LABELS[node.kind];
  const preset = findPreset(presets[node.kind], node.presetId, label);
  if ((preset.revision ?? 1) !== node.presetRevision) {
    throw new Error(`${label}预设“${preset.name}”已更新，请先同步流程中的预设版本`);
  }
  environment.completedActions += 1;
  const actionIndex = environment.completedActions;
  const progressBefore = ((actionIndex - 1) / Math.max(1, environment.totalActions)) * 100;
  task.setProgress(progressBefore);
  task.setDetail(`流程 ${actionIndex}/${environment.totalActions} · ${label}`);
  workflowLog(task, `步骤 ${actionIndex}/${environment.totalActions} · ${label} · ${preset.name}`);
  const failBefore = state.fail;

  try {
    if (node.kind === 'backup') {
      const form = normalizeBackupForm(preset.params);
      const request: DitBackupRequest = {
        ...buildBackupRequest(form, state.paths, new Date()),
        ...(environment.agentMode ? { operation: 'copy', reuseIdentical: false } : {}),
      };
      if (hasInvalidBackupOptions(form, request)) throw new Error('备份目标或命名设置不完整');
      if (environment.triggerKind === 'removable' && form.operation === 'move') {
        throw new Error('磁盘触发流程禁止自动移动源文件');
      }
      const summary = await runDitBackup(request);
      state.pass += summary.completedFiles;
      state.fail += summary.failedFiles;
      state.outputPaths = successfulBackupOutputs(summary);
      state.paths = successfulBackupPaths(summary, 0);
      state.pathsAreFiles = true;
      state.lastBackupVerified = form.verifyMd5
        && !summary.cancelled
        && summary.failedFiles === 0
        && summary.completedFiles > 0;
      if (summary.cancelled || task.isCancelled()) return;
      if (summary.failedFiles > 0) {
        throw new Error(summary.completedFiles > 0
          ? `部分失败：完成 ${summary.completedFiles}，失败 ${summary.failedFiles}`
          : `全部失败 (${summary.failedFiles})`);
      }
      if (state.paths.length === 0) throw new Error('没有产生可供后续处理的文件');
    } else if (node.kind === 'transcode') {
      const inputs = await resolveWorkflowActionInputs(state, environment);
      const outputs = await transcodePreset(inputs, preset, environment.agentMode);
      if (outputs.length === 0) throw new Error('没有产生输出文件');
      state.paths = outputs;
      state.pathsAreFiles = true;
      state.outputPaths = outputs;
      state.pass += outputs.length;
    } else if (node.kind === 'mix') {
      const inputs = await resolveWorkflowActionInputs(state, environment);
      const params: any = { ...DEFAULT_OUTPUT_FORM, ...preset.params };
      const outputs = await mixAudio(
        inputs,
        params.lnI ?? -24,
        params.lnTp ?? -2,
        params.lnLra ?? 7,
        params.cpTh ?? -27,
        params.cpGain ?? 5,
        params.lnOn !== false,
        params.tpOn !== false,
        { ...toOutputSettings(params, preset.name), uniqueName: environment.agentMode },
      );
      if (outputs.length === 0) throw new Error('没有产生输出文件');
      state.paths = outputs;
      state.pathsAreFiles = true;
      state.outputPaths = outputs;
      state.pass += outputs.length;
    } else {
      const inputs = await resolveWorkflowActionInputs(state, environment);
      const params: any = preset.params;
      const reference = presets.transcode.find((item) => item.id === params.refEncPresetId);
      const summary = await checkVideos(
        inputs,
        params.fpsTol ?? 0.5,
        params.recursive !== false,
        params.blackDetect !== false,
        reference?.params.scaleW || 0,
        reference?.params.scaleH || 0,
        reference?.params.fps || 0,
        reference?.params.videoCodec || '',
      );
      state.pass += summary.pass + summary.pass_with_warnings;
      state.fail += summary.fail;
      if (summary.fail > 0) throw new Error(`检测到 ${summary.fail} 个失败项`);
    }
    if (task.isCancelled()) return;
    state.lastStepSucceeded = true;
    workflowLog(task, `${label}完成`, 'pass');
  } catch (error: any) {
    if (task.isCancelled()) return;
    state.lastStepSucceeded = false;
    if (node.kind === 'backup') state.lastBackupVerified = false;
    if (state.fail === failBefore) state.fail += Math.max(1, state.paths.length);
    const message = String(error?.message || error);
    workflowLog(task, `${label}失败：${message}`, node.failureMode === 'continue' ? 'warn' : 'fail');
    task.setPass(state.pass);
    task.setFail(state.fail);
    if (node.failureMode === 'stop') throw new Error(`${label}失败：${message}`);
  }

  task.setPass(state.pass);
  task.setFail(state.fail);
  task.setProgress((actionIndex / Math.max(1, environment.totalActions)) * 100);
}

async function evaluateWorkflowCondition(
  node: WorkflowConditionNode,
  state: WorkflowExecutionState,
  environment: WorkflowExecutionEnvironment,
): Promise<boolean> {
  const { condition } = node;
  try {
    if (condition.kind === 'last_step_succeeded') return state.lastStepSucceeded;
    if (condition.kind === 'last_backup_verified') return state.lastBackupVerified;
    if (condition.kind === 'source_has_media') return sourceContainsMedia(state.paths);

    const preset = findPreset(environment.presets.backup, condition.backupPresetId, '容量判断');
    const form = normalizeBackupForm(preset.params);
    const destinations = form.destinations.map((destination) => destination.path.trim()).filter(Boolean);
    if (destinations.length === 0) return false;
    const capacity = await evaluateBackupCapacity(
      state.paths,
      form,
      destinations,
      condition.reservePercent,
    );
    const volumeSummary = capacity.checks.map((check) => {
      const name = check.volume.label.trim() || check.volume.rootPath;
      const needed = check.requiredBytes + check.reserveBytes;
      return `${name}: 需要 ${formatWorkflowBytes(needed)} / 可用 ${formatWorkflowBytes(check.volume.availableBytes ?? 0)}`;
    }).join('；');
    workflowLog(
      environment.task,
      `空间判断 · ${capacity.fileCount} 个文件，共 ${formatWorkflowBytes(capacity.sourceBytes)}${volumeSummary ? ` · ${volumeSummary}` : ''}`,
      capacity.fits ? 'pass' : 'warn',
    );
    return capacity.fits;
  } catch (error: any) {
    workflowLog(environment.task, `条件判断失败，按“不满足”处理：${String(error?.message || error)}`, 'warn');
    return false;
  }
}

async function executeWorkflowNodes(
  nodes: WorkflowNode[],
  state: WorkflowExecutionState,
  environment: WorkflowExecutionEnvironment,
): Promise<void> {
  for (const node of nodes) {
    if (environment.task.isCancelled()) return;
    if (node.type === 'action') {
      await runWorkflowAction(node, state, environment);
      continue;
    }
    const matched = await evaluateWorkflowCondition(node, state, environment);
    workflowLog(
      environment.task,
      `条件“${WORKFLOW_CONDITION_LABELS[node.condition.kind]}”${matched ? '满足' : '不满足'}`,
      matched ? 'pass' : 'muted',
    );
    await executeWorkflowNodes(matched ? node.thenSteps : node.elseSteps, state, environment);
  }
}

export function DitWorkflowTab() {
  const fl = useFileList();
  const task = useTaskRunner();
  const media = useActiveMedia(fl.activePath, false);
  const [resultView, setResultView] = useResultView(task.running);
  const [workflow, setWorkflow] = useState<WorkflowDefinition>(() => normalizeWorkflowDefinition({}));
  const [workflowName, setWorkflowName] = useState('');
  const backupPresets = usePresets('backup').presets;
  const encodePresets = usePresets('encode').presets;
  const mixPresets = usePresets('mix').presets;
  const checkPresets = usePresets('check').presets;
  const presetSets = useMemo<WorkflowPresetSets>(() => ({
    backup: backupPresets,
    transcode: encodePresets,
    mix: mixPresets,
    check: checkPresets,
  }), [backupPresets, checkPresets, encodePresets, mixPresets]);
  const inputPaths = fl.hasSelection ? fl.selectedSourcePaths : fl.paths;
  const validationIssues = useMemo(
    () => workflowValidationIssues(workflow, presetSets),
    [presetSets, workflow],
  );
  const invalid = validationIssues.length > 0
    || (workflow.trigger.kind === 'manual' && inputPaths.length === 0);

  const run = () => task.start(async () => {
    const definition = normalizeWorkflowDefinition(workflow);
    const issues = workflowValidationIssues(definition, presetSets);
    if (issues.length > 0) throw new Error(issues[0]);
    workflowLog(task, `启动流程：${workflowName || '当前流程'}`);
    let sourcePaths = [...inputPaths];
    if (definition.trigger.kind === 'removable') {
      const volume = await waitForNewStorageVolume(
        definition.trigger,
        task.isCancelled,
        task.setDetail,
      );
      if (!volume || task.isCancelled()) return;
      sourcePaths = [volume.rootPath];
      workflowLog(task, `触发磁盘：${volume.label.trim() || '未命名卷'} (${volume.rootPath})`, 'pass');
    }
    if (sourcePaths.length === 0) throw new Error('没有可用于流程的素材');

    const counts = workflowNodeCounts(definition.steps);
    const state: WorkflowExecutionState = {
      paths: sourcePaths,
      pathsAreFiles: false,
      outputPaths: [],
      pass: 0,
      fail: 0,
      lastStepSucceeded: false,
      lastBackupVerified: false,
    };
    const environment: WorkflowExecutionEnvironment = {
      task,
      presets: presetSets,
      triggerKind: definition.trigger.kind,
      agentMode: false,
      totalActions: counts.actions,
      completedActions: 0,
      resolveMediaPaths: definition.trigger.kind === 'manual'
        ? fl.resolveLeafPaths
        : async (paths) => (await collectWorkflowSourceFiles(paths, {
          extensions: [],
          minSizeMb: 0,
          mediaOnly: true,
          recursive: true,
        })).map((file) => file.path),
    };
    await executeWorkflowNodes(definition.steps, state, environment);
    if (task.isCancelled()) {
      task.setOutputPaths([]);
    } else {
      task.setProgress(100);
      task.setOutputPaths(state.outputPaths);
      task.setDetail(`流程完成 · 执行 ${environment.completedActions} 个步骤`);
      workflowLog(task, `流程完成 · 通过 ${state.pass}，失败 ${state.fail}`, state.fail > 0 ? 'warn' : 'pass');
    }
  });

  useEffect(() => registerAgentTaskHandler('workflow', (agentTask) => task.start(async (): Promise<AgentTaskExecutionResult> => {
    const preset = findPreset(agentTask.presetSnapshots, agentTask.presetId, '流程', 'workflow');
    if (agentTask.presetRevision > 0 && (preset.revision ?? 1) !== agentTask.presetRevision) {
      throw new Error('流程任务的预设快照版本不一致，请重新发起任务');
    }
    const agentPresetSets: WorkflowPresetSets = {
      backup: agentTask.presetSnapshots.filter((item) => item.type === 'backup'),
      transcode: agentTask.presetSnapshots.filter((item) => item.type === 'encode'),
      mix: agentTask.presetSnapshots.filter((item) => item.type === 'mix'),
      check: agentTask.presetSnapshots.filter((item) => item.type === 'check'),
    };
    const definition = normalizeWorkflowDefinition(preset.params);
    if (definition.trigger.kind !== 'manual') {
      throw new Error('Agent 只能启动手动触发的流程');
    }
    const issues = workflowValidationIssues(definition, agentPresetSets);
    if (issues.length > 0) throw new Error(issues[0]);
    if (agentTask.inputPaths.length === 0) throw new Error('没有可用于流程的素材');
    workflowLog(task, `Agent 启动流程：${preset.name}`);

    const counts = workflowNodeCounts(definition.steps);
    const state: WorkflowExecutionState = {
      paths: [...agentTask.inputPaths],
      pathsAreFiles: false,
      outputPaths: [],
      pass: 0,
      fail: 0,
      lastStepSucceeded: false,
      lastBackupVerified: false,
    };
    const environment: WorkflowExecutionEnvironment = {
      task,
      presets: agentPresetSets,
      triggerKind: 'manual',
      agentMode: true,
      totalActions: counts.actions,
      completedActions: 0,
      resolveMediaPaths: fl.resolveLeafPaths,
    };
    await executeWorkflowNodes(definition.steps, state, environment);
    const outputPaths = task.isCancelled() ? [] : state.outputPaths;
    task.setOutputPaths(outputPaths);
    const detail = task.isCancelled()
      ? '流程已取消'
      : `流程完成 · 执行 ${environment.completedActions} 个步骤`;
    if (!task.isCancelled()) {
      task.setProgress(100);
      task.setDetail(detail);
      workflowLog(task, `流程完成 · 通过 ${state.pass}，失败 ${state.fail}`, state.fail > 0 ? 'warn' : 'pass');
    }
    return { outputPaths, detail };
  })), [
    fl.resolveLeafPaths,
    task,
  ]);

  return (
    <ToolWorkspace
      taskFailure={task.error ? { message: task.error, logs: task.logs, onClose: task.clearError } : undefined}
      params={(
        <>
          <PresetManager
            type="workflow"
            builderTitle="流程预设"
            onApply={(params, presetName) => {
              setWorkflow(normalizeWorkflowDefinition(params));
              setWorkflowName(presetName || '');
            }}
            initialValues={workflow}
            currentParams={workflow}
            renderBuilder={(ctx) => <WorkflowPresetBuilder ctx={ctx} initial={workflow} />}
          />
          <WorkflowEditor value={workflow} onChange={setWorkflow} disabled={task.running} />
          {(validationIssues[0] || (workflow.trigger.kind === 'manual' && inputPaths.length === 0)) && (
            <div className="se-workflow-validation">
              {validationIssues[0] || '素材列表中没有可执行的素材'}
            </div>
          )}
        </>
      )}
      actions={(
        <DitActionBar
          running={task.running}
          disabled={invalid}
          label={workflow.trigger.kind === 'removable' ? '启动流程' : '执行流程'}
          onStart={run}
          onStop={task.cancel}
          onOpenOutput={task.outputPaths.length > 0 ? task.openOutputs : undefined}
        />
      )}
      resultHeader={<ResultViewProgress value={resultView} onChange={setResultView} progress={task.progress} detail={task.detail} eta={task.eta} pass={task.pass} fail={task.fail} running={task.running} />}
      resultTitle={<ResultViewTitle value={resultView} logs={task.logs.length} running={task.running} />}
      result={<ResultViewContent value={resultView} logs={task.logs} preview={<VideoPlayer src={media.src} filePath={media.path} cropEnabled={false} controlsDisabled={task.running} />} />}
    />
  );
}
