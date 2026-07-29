import React, { useEffect, useMemo, useState } from 'react';
import * as ui from './ui';
import {
  IconCaretDown,
  IconCaretUp,
  IconPlus,
  IconTrash,
  IconUpdate,
} from './icons';
import {
  PresetManageDialog,
  usePresets,
  type Preset,
  type PresetBuilderCtx,
} from './presetSystem';
import {
  MAX_WORKFLOW_CONDITION_DEPTH,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_CONDITION_LABELS,
  cloneWorkflowDefinition,
  createWorkflowAction,
  createWorkflowCondition,
  normalizeWorkflowDefinition,
  type WorkflowActionKind,
  type WorkflowConditionKind,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../lib/workflow';

type WorkflowPresetSets = Record<WorkflowActionKind, Preset[]>;

const ACTION_OPTIONS = Object.entries(WORKFLOW_ACTION_LABELS).map(([value, sourceLabel]) => {
  const [category, label] = sourceLabel.split(' · ');
  return label
    ? { label, value, tags: [category] }
    : { label: sourceLabel, value, tags: [] };
});
const CONDITION_OPTIONS = Object.entries(WORKFLOW_CONDITION_LABELS).map(([value, label]) => ({ label, value }));

function useWorkflowPresetSets(): WorkflowPresetSets {
  const backup = usePresets('backup').presets;
  const transcode = usePresets('encode').presets;
  const mix = usePresets('mix').presets;
  const check = usePresets('check').presets;
  return useMemo(() => ({ backup, transcode, mix, check }), [backup, check, mix, transcode]);
}

function presetOptions(presets: Preset[]) {
  return presets.length > 0
    ? presets.map((preset) => ({ label: preset.name, value: preset.id }))
    : [{ label: '没有可用预设', value: '' }];
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

function moveAt<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function WorkflowNodeList({
  nodes,
  onChange,
  depth,
  disabled,
  removableTrigger,
  presets,
  emptyText = '添加至少一个执行步骤',
}: {
  nodes: WorkflowNode[];
  onChange: (nodes: WorkflowNode[]) => void;
  depth: number;
  disabled: boolean;
  removableTrigger: boolean;
  presets: WorkflowPresetSets;
  emptyText?: string;
}) {
  const [nextType, setNextType] = useState('action:backup');
  const addOptions = [
    ...ACTION_OPTIONS.map((option) => ({
      label: option.label,
      value: `action:${option.value}`,
      tags: ['执行', ...option.tags],
    })),
    ...(depth < MAX_WORKFLOW_CONDITION_DEPTH
      ? [{ label: '条件判断', value: 'condition', tags: ['逻辑'] }]
      : []),
  ];
  useEffect(() => {
    if (!addOptions.some((option) => option.value === nextType)) setNextType('action:backup');
  }, [depth, nextType]);

  const addNode = () => {
    if (nextType === 'condition') {
      onChange([...nodes, createWorkflowCondition()]);
      return;
    }
    const kind = nextType.replace('action:', '') as WorkflowActionKind;
    const preset = presets[kind][0];
    onChange([...nodes, createWorkflowAction(kind, preset?.id ?? '', preset?.revision ?? 1)]);
  };

  return (
    <div className={`se-workflow-node-list depth-${depth}`}>
      <div className="se-workflow-add">
        <ui.ComboBox
          value={nextType}
          options={addOptions}
          menuTagAreaWidth={68}
          onChange={setNextType}
          disabled={disabled}
        />
        <ui.Button icon={<IconPlus size={14} />} onClick={addNode} disabled={disabled}>添加</ui.Button>
      </div>
      <ui.AnimatedList
        items={nodes}
        getKey={(node) => node.id}
        className="se-workflow-nodes"
        itemClassName="se-workflow-node-motion"
        empty={<ui.EmptyState text={emptyText} />}
        renderItem={(node, index) => {
          const replace = (next: WorkflowNode) => onChange(replaceAt(nodes, index, next));
          const controls = (
            <div className="se-workflow-node-actions">
              <ui.Button className="se-icon-btn" icon={<IconCaretUp size={13} />} title="上移" onClick={() => onChange(moveAt(nodes, index, -1))} disabled={disabled || index === 0} />
              <ui.Button className="se-icon-btn" icon={<IconCaretDown size={13} />} title="下移" onClick={() => onChange(moveAt(nodes, index, 1))} disabled={disabled || index === nodes.length - 1} />
              <ui.Button className="se-icon-btn se-btn-danger" icon={<IconTrash size={13} />} title="删除" onClick={() => onChange(nodes.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled} />
            </div>
          );

          if (node.type === 'condition') {
            const condition = node.condition;
            const backupOptions = presetOptions(presets.backup);
            const conditionRows: ui.AnimatedFieldRow[] = condition.kind === 'backup_destinations_fit'
              ? [
                {
                  id: 'backup-preset',
                  content: (
                    <>
                      <ui.FieldLabel>检查预设</ui.FieldLabel>
                      <ui.ComboBox
                        value={condition.backupPresetId}
                        options={backupOptions}
                        onChange={(backupPresetId) => replace({
                          ...node,
                          condition: { ...condition, backupPresetId },
                        })}
                        disabled={disabled || presets.backup.length === 0}
                      />
                    </>
                  ),
                },
                {
                  id: 'reserve-percent',
                  content: (
                    <>
                      <ui.FieldLabel>安全余量</ui.FieldLabel>
                      <ui.NumberField
                        value={condition.reservePercent}
                        min={0}
                        max={100}
                        step={1}
                        decimals={0}
                        suffix="%"
                        onChange={(reservePercent) => replace({
                          ...node,
                          condition: { ...condition, reservePercent },
                        })}
                        disabled={disabled}
                      />
                    </>
                  ),
                },
              ]
              : [];
            return (
              <div className="se-workflow-node se-workflow-condition">
                <div className="se-workflow-node-head">
                  <span className="se-workflow-node-index">{index + 1}</span>
                  <ui.ComboBox
                    value={condition.kind}
                    options={CONDITION_OPTIONS}
                    onChange={(kind: WorkflowConditionKind) => replace({
                      ...node,
                      condition: { ...condition, kind },
                    })}
                    disabled={disabled}
                  />
                  {controls}
                </div>
                {conditionRows.length > 0 && (
                  <div className="se-workflow-node-fields">
                    <ui.AnimatedFieldGrid rows={conditionRows} />
                  </div>
                )}
                <div className="se-workflow-branches">
                  <section className="se-workflow-branch is-then">
                    <div className="se-workflow-branch-title">满足</div>
                    <WorkflowNodeList
                      nodes={node.thenSteps}
                      onChange={(thenSteps) => replace({ ...node, thenSteps })}
                      depth={depth + 1}
                      disabled={disabled}
                      removableTrigger={removableTrigger}
                      presets={presets}
                      emptyText="满足时不执行额外步骤"
                    />
                  </section>
                  <section className="se-workflow-branch is-else">
                    <div className="se-workflow-branch-title">否则</div>
                    <WorkflowNodeList
                      nodes={node.elseSteps}
                      onChange={(elseSteps) => replace({ ...node, elseSteps })}
                      depth={depth + 1}
                      disabled={disabled}
                      removableTrigger={removableTrigger}
                      presets={presets}
                      emptyText="否则不执行额外步骤"
                    />
                  </section>
                </div>
              </div>
            );
          }

          const actionPresets = presets[node.kind];
          const selectedPreset = actionPresets.find((preset) => preset.id === node.presetId);
          const stale = selectedPreset && (selectedPreset.revision ?? 1) !== node.presetRevision;
          const automatedMove = removableTrigger && node.kind === 'backup' && selectedPreset?.params.operation === 'move';
          const issue = !selectedPreset
            ? '引用的预设不存在'
            : automatedMove
              ? '磁盘触发流程禁止自动移动源文件'
              : stale
                ? '预设已更新，需要同步后再启动流程'
                : '';
          const actionRows: ui.AnimatedFieldRow[] = [
            {
              id: 'preset',
              content: (
                <>
                  <ui.FieldLabel>功能预设</ui.FieldLabel>
                  <ui.ComboBox
                    value={node.presetId}
                    options={presetOptions(actionPresets)}
                    onChange={(presetId) => {
                      const preset = actionPresets.find((item) => item.id === presetId);
                      replace({ ...node, presetId, presetRevision: preset?.revision ?? 1 });
                    }}
                    disabled={disabled || actionPresets.length === 0}
                  />
                </>
              ),
            },
            {
              id: 'failure-mode',
              content: (
                <>
                  <ui.FieldLabel>失败后</ui.FieldLabel>
                  <ui.ComboBox
                    value={node.failureMode}
                    options={[
                      { label: '停止流程', value: 'stop' },
                      { label: '继续判断下一步', value: 'continue' },
                    ]}
                    onChange={(failureMode) => replace({ ...node, failureMode })}
                    disabled={disabled}
                  />
                </>
              ),
            },
          ];
          return (
            <div className={`se-workflow-node se-workflow-action${issue ? ' has-issue' : ''}`}>
              <div className="se-workflow-node-head">
                <span className="se-workflow-node-index">{index + 1}</span>
                <ui.ComboBox
                  value={node.kind}
                  options={ACTION_OPTIONS}
                  onChange={(kind: WorkflowActionKind) => {
                    const first = presets[kind][0];
                    replace({
                      ...node,
                      kind,
                      presetId: first?.id ?? '',
                      presetRevision: first?.revision ?? 1,
                    });
                  }}
                  disabled={disabled}
                />
                {controls}
              </div>
              <div className="se-workflow-node-fields">
                <ui.AnimatedFieldGrid rows={actionRows} />
              </div>
              {issue && (
                <div className="se-workflow-node-issue">
                  <span>{issue}</span>
                  {stale && selectedPreset && (
                    <ui.Button
                      className="se-icon-btn"
                      icon={<IconUpdate size={13} />}
                      title="同步预设版本"
                      onClick={() => replace({ ...node, presetRevision: selectedPreset.revision ?? 1 })}
                      disabled={disabled}
                    />
                  )}
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

export function WorkflowEditor({ value, onChange, disabled }: {
  value: WorkflowDefinition;
  onChange: React.Dispatch<React.SetStateAction<WorkflowDefinition>>;
  disabled: boolean;
}) {
  const presets = useWorkflowPresetSets();
  const triggerRows: ui.AnimatedFieldRow[] = [
    {
      id: 'trigger-kind',
      content: (
        <>
          <ui.FieldLabel>启动方式</ui.FieldLabel>
          <ui.ComboBox
            value={value.trigger.kind}
            options={[
              { label: '手动立即执行', value: 'manual' },
              { label: '等待新接入磁盘', value: 'removable' },
            ]}
            onChange={(kind) => onChange((current) => ({
              ...current,
              trigger: { ...current.trigger, kind },
            }))}
            disabled={disabled}
          />
        </>
      ),
    },
  ];
  if (value.trigger.kind === 'removable') {
    triggerRows.push(
      {
        id: 'volume-kind',
        content: (
          <>
            <ui.FieldLabel>磁盘范围</ui.FieldLabel>
            <ui.ComboBox
              value={value.trigger.volumeKind}
              options={[
                { label: '可移动磁盘', value: 'removable' },
                { label: '任意新接入卷', value: 'any' },
              ]}
              onChange={(volumeKind) => onChange((current) => ({
                ...current,
                trigger: { ...current.trigger, volumeKind },
              }))}
              disabled={disabled}
            />
          </>
        ),
      },
      {
        id: 'volume-label',
        content: (
          <>
            <ui.FieldLabel>卷标包含</ui.FieldLabel>
            <ui.DropInput
              value={value.trigger.labelContains}
              placeholder="留空表示不过滤"
              onChange={(labelContains) => onChange((current) => ({
                ...current,
                trigger: { ...current.trigger, labelContains },
              }))}
              disabled={disabled}
            />
          </>
        ),
      },
      {
        id: 'settle-seconds',
        content: (
          <>
            <ui.FieldLabel>稳定等待</ui.FieldLabel>
            <ui.NumberField
              value={value.trigger.settleSeconds}
              min={1}
              max={30}
              step={1}
              decimals={0}
              suffix="秒"
              onChange={(settleSeconds) => onChange((current) => ({
                ...current,
                trigger: { ...current.trigger, settleSeconds },
              }))}
              disabled={disabled}
            />
          </>
        ),
      },
    );
  }

  return (
    <>
      <ui.ParamGroup title="触发条件">
        <ui.AnimatedFieldGrid rows={triggerRows} />
      </ui.ParamGroup>
      <ui.ParamGroup title="流程步骤">
        <WorkflowNodeList
          nodes={value.steps}
          onChange={(steps) => onChange((current) => ({ ...current, steps }))}
          depth={0}
          disabled={disabled}
          removableTrigger={value.trigger.kind === 'removable'}
          presets={presets}
        />
      </ui.ParamGroup>
    </>
  );
}

export function WorkflowPresetBuilder({ ctx, initial }: {
  ctx: PresetBuilderCtx;
  initial: WorkflowDefinition;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => normalizeWorkflowDefinition(initial));
  const reset = () => {
    setEditingId(null);
    setName('');
    setDefinition(normalizeWorkflowDefinition(initial));
  };
  const select = (id: string) => {
    const preset = ctx.presets.find((item) => item.id === id);
    if (!preset) return;
    setEditingId(id);
    setName(preset.name);
    setDefinition(normalizeWorkflowDefinition(preset.params));
  };

  useEffect(() => {
    if (ctx.isOpen) reset();
  }, [ctx.isOpen]);

  if (!ctx.isMounted) return null;
  return (
    <PresetManageDialog
      title="管理流程预设"
      scrollEditor
      presets={ctx.presets}
      editingId={editingId}
      onSelect={select}
      onNew={reset}
      onCopy={() => {
        if (!editingId) return;
        setEditingId(null);
        setName((current) => current ? `${current} 副本` : '副本');
        setDefinition((current) => cloneWorkflowDefinition(current));
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
        const data = { ...cloneWorkflowDefinition(definition), name };
        if (editingId) ctx.onUpdate(editingId, data);
        else ctx.onSaveNew(data);
      }}
      saveLabel={editingId ? '保存修改' : '保存预设'}
      canSave={Boolean(name.trim() && definition.steps.length > 0)}
    >
      <div className="se-preset-name">
        <ui.FieldLabel>预设名称</ui.FieldLabel>
        <input className="se-drop-input" value={name} placeholder="例如：插卡双盘备份与代理" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="se-workflow-preset-editor">
        <WorkflowEditor value={definition} onChange={setDefinition} disabled={false} />
      </div>
    </PresetManageDialog>
  );
}
