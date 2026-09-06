import { useRef } from 'react';
import * as ui from './ui';
import { IconFolder } from './icons';
import { pickPath, type OutputSettings } from '../lib/ffmpeg';
import { buildEncodeNameLabels, type EncodeNameLabels } from '../lib/outputNaming';
export { buildEncodeNameLabels, type EncodeNameLabels } from '../lib/outputNaming';

export type OutputFormState = {
  outputMode: OutputSettings['mode'];
  outputNameTemplate: string;
  outputSubdirectory: string;
  outputDirectory: string;
};

/** 编码任务默认重命名：原始文件名_分辨率_帧率_编码_码率.扩展名 */
export const DEFAULT_ENCODE_NAME_TEMPLATE = '{name}_{res}_{fps}_{codec}_{bitrate}';

export const DEFAULT_OUTPUT_FORM: OutputFormState = {
  outputMode: 'source',
  // 非编码功能默认：原名 + 功能后缀；编码页会覆盖为 DEFAULT_ENCODE_NAME_TEMPLATE
  outputNameTemplate: '{name}{suffix}',
  outputSubdirectory: 'ShadowEncoder',
  outputDirectory: '',
};


export const OUTPUT_MODE_OPTIONS = [
  { label: '原文件旁边', value: 'source' },
  { label: '原文件旁边并重命名', value: 'rename' },
  { label: '原文件目录的子目录', value: 'subdir' },
  { label: '指定目录', value: 'fixed' },
  { label: '指定目录并重命名', value: 'fixedRename' },
];

export const OUTPUT_PRESET_FIELDS = [
  { key: 'outputMode', label: '存储位置', kind: 'select' as const, options: OUTPUT_MODE_OPTIONS, default: DEFAULT_OUTPUT_FORM.outputMode },
  { key: 'outputNameTemplate', label: '文件名模板', kind: 'text' as const, default: DEFAULT_OUTPUT_FORM.outputNameTemplate },
  { key: 'outputSubdirectory', label: '子目录名称', kind: 'text' as const, default: DEFAULT_OUTPUT_FORM.outputSubdirectory },
  { key: 'outputDirectory', label: '指定目录', kind: 'text' as const, default: DEFAULT_OUTPUT_FORM.outputDirectory },
];

export const OUTPUT_PRESET_KEYS = new Set(OUTPUT_PRESET_FIELDS.map((field) => field.key));

export function normalizeOutputForm(value?: Partial<OutputFormState> | null): OutputFormState {
  return {
    ...DEFAULT_OUTPUT_FORM,
    ...(value || {}),
  };
}

export function toOutputSettings(
  value: Partial<OutputFormState>,
  presetName = '',
  encodeLabels?: EncodeNameLabels,
): OutputSettings {
  const normalized = normalizeOutputForm(value);
  return {
    mode: normalized.outputMode,
    nameTemplate: normalized.outputNameTemplate,
    subdirectory: normalized.outputSubdirectory,
    directory: normalized.outputDirectory,
    presetName,
    resolution: encodeLabels?.resolution || '',
    fpsLabel: encodeLabels?.fpsLabel || '',
    codecLabel: encodeLabels?.codecLabel || '',
    bitrateLabel: encodeLabels?.bitrateLabel || '',
  };
}

export function describeOutputSettings(value: Partial<OutputFormState>): string {
  const output = normalizeOutputForm(value);
  if (output.outputMode === 'rename') {
    return `原文件旁 · ${output.outputNameTemplate || '{name}{suffix}'}`;
  }
  if (output.outputMode === 'subdir') return `原目录 / ${output.outputSubdirectory || 'ShadowEncoder'}`;
  if (output.outputMode === 'fixedRename') {
    return `${output.outputDirectory || '未选择目录'} · ${output.outputNameTemplate || '{name}{suffix}'}`;
  }
  if (output.outputMode === 'fixed') return output.outputDirectory || '未选择目录';
  return '原文件旁边';
}

type OutputFieldsProps = {
  value: Partial<OutputFormState>;
  onChange: (key: keyof OutputFormState, value: string) => void;
  disabled?: boolean;
  presetName?: string;
  extension?: string;
  defaultSuffix?: string;
  /** 编码命名标签，用于 source 预览与 rename 模板预览 */
  encodeLabels?: EncodeNameLabels;
};

export type TemplateTokenOption = {
  token: string;
  label: string;
  title: string;
};

export const TEMPLATE_TOKENS: TemplateTokenOption[] = [
  { token: '{name}', label: '素材名', title: '插入原素材名称（空格会自动移除）' },
  { token: '{res}', label: '分辨率', title: '插入输出分辨率，如 1920x1080' },
  { token: '{fps}', label: '帧率', title: '插入输出帧率，如 25fps' },
  { token: '{codec}', label: '编码', title: '插入编码器短名，如 H264' },
  { token: '{bitrate}', label: '码率', title: '插入码率/质量标签，如 CRF23 / 5Mbps' },
  { token: '{preset}', label: '预设名', title: '插入当前预设名称' },
  { token: '{suffix}', label: '功能后缀', title: '插入当前功能的默认后缀' },
  { token: '{ext}', label: '扩展名', title: '插入输出格式扩展名' },
];

function safePreviewPart(value: string, fallback: string) {
  return value
    .trim()
    .replace(/\s+/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '') || fallback;
}

function withExtension(value: string, extension: string) {
  const ext = extension.replace(/^\.+/, '') || 'mp4';
  const trimmed = value.trim().replace(/\s+/g, '') || '素材名称';
  const suffix = `.${ext}`;
  if (trimmed.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())) return trimmed;
  return `${trimmed}${suffix}`;
}

function previewTemplate(
  template: string,
  presetName: string,
  extension: string,
  defaultSuffix: string,
  encodeLabels?: EncodeNameLabels,
) {
  const ext = extension.replace(/^\.+/, '') || 'mp4';
  const res = safePreviewPart(encodeLabels?.resolution || '', 'orig');
  const fps = safePreviewPart(encodeLabels?.fpsLabel || '', 'orig');
  const codec = safePreviewPart(encodeLabels?.codecLabel || '', 'enc');
  const bitrate = safePreviewPart(encodeLabels?.bitrateLabel || '', 'default');
  const replacements: [string, string][] = [
    ['{name}', '素材名称'],
    ['{preset}', safePreviewPart(presetName, '')],
    ['{suffix}', defaultSuffix],
    ['{res}', res],
    ['{resolution}', res],
    ['{fps}', fps],
    ['{codec}', codec],
    ['{bitrate}', bitrate],
    ['{ext}', ext],
  ];
  const fallback = '{name}{suffix}';
  const rendered = replacements.reduce(
    (current, [token, replacement]) => current.split(token).join(replacement),
    template.trim() || fallback,
  );
  return withExtension(safePreviewPart(rendered, '素材名称'), ext);
}

function sourceFilenamePreview(
  presetName: string,
  extension: string,
  defaultSuffix: string,
  encodeLabels?: EncodeNameLabels,
) {
  const ext = extension.replace(/^\.+/, '') || 'mp4';
  if (encodeLabels?.resolution || encodeLabels?.fpsLabel || encodeLabels?.codecLabel || encodeLabels?.bitrateLabel) {
    const res = safePreviewPart(encodeLabels.resolution || '', 'orig');
    const fps = safePreviewPart(encodeLabels.fpsLabel || '', 'orig');
    const codec = safePreviewPart(encodeLabels.codecLabel || '', 'enc');
    const bitrate = safePreviewPart(encodeLabels.bitrateLabel || '', 'default');
    return `素材名称_${res}_${fps}_${codec}_${bitrate}.${ext}`;
  }
  const preset = presetName.trim() ? `_${safePreviewPart(presetName, '预设名称')}` : defaultSuffix;
  return `素材名称${preset}.${ext}`;
}

export function TemplateEditor({
  value,
  tokens,
  preview,
  placeholder,
  ariaLabel,
  disabled,
  onChange,
}: {
  value: string;
  tokens: TemplateTokenOption[];
  preview: string;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const insertToken = (token: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="se-filename-editor">
      <div
        className={`se-filename-token-row${tokens.length <= 2 ? ' is-compact' : ''}`}
        role="group"
        aria-label="插入文件名片段"
      >
        {tokens.map((item) => (
          <ui.Button
            key={item.token}
            className="se-filename-token"
            title={item.title}
            disabled={disabled}
            onClick={() => insertToken(item.token)}
          >
            {item.label}
          </ui.Button>
        ))}
      </div>
      <input
        ref={inputRef}
        className="se-drop-input se-filename-template-input"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="se-filename-preview" aria-live="polite">
        <span>预览</span>
        <code title={preview}>{preview}</code>
      </div>
    </div>
  );
}

function FilenameTemplateEditor({ value, presetName, extension, defaultSuffix, encodeLabels, disabled, onChange }: {
  value: string;
  presetName: string;
  extension: string;
  defaultSuffix: string;
  encodeLabels?: EncodeNameLabels;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <TemplateEditor
      value={value}
      tokens={TEMPLATE_TOKENS}
      preview={previewTemplate(value, presetName, extension, defaultSuffix, encodeLabels)}
      placeholder={`例如：${DEFAULT_ENCODE_NAME_TEMPLATE}`}
      ariaLabel="文件名模板"
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function OutputLocationFields({
  value,
  onChange,
  disabled,
  presetName = '',
  extension = 'mp4',
  defaultSuffix = '',
  encodeLabels,
}: OutputFieldsProps) {
  const output = normalizeOutputForm(value);
  const chooseDirectory = async () => {
    const path = await pickPath('dir');
    if (path) onChange('outputDirectory', path.replace(/[\\/]+$/, ''));
  };

  const rows: ui.AnimatedFieldRow[] = [
    {
      id: 'output-mode',
      content: (
        <>
          <ui.FieldLabel>存储位置</ui.FieldLabel>
          <ui.ComboBox
            value={output.outputMode}
            options={OUTPUT_MODE_OPTIONS}
            disabled={disabled}
            onChange={(next) => onChange('outputMode', next)}
          />
        </>
      ),
    },
  ];
  if (output.outputMode === 'source') {
    rows.push({
      id: 'source-filename',
      content: (
        <>
          <ui.FieldLabel>输出文件名</ui.FieldLabel>
          <div className="se-filename-preview se-filename-preview-source" aria-live="polite">
            <code>{sourceFilenamePreview(presetName, extension, defaultSuffix, encodeLabels)}</code>
          </div>
        </>
      ),
    });
  }
  if (output.outputMode === 'rename' || output.outputMode === 'fixedRename') {
    rows.push({
      id: 'filename-template',
      content: (
        <>
          <ui.FieldLabel>名称编辑器</ui.FieldLabel>
          <FilenameTemplateEditor
            value={output.outputNameTemplate}
            presetName={presetName}
            extension={extension}
            defaultSuffix={defaultSuffix}
            encodeLabels={encodeLabels}
            disabled={disabled}
            onChange={(next) => onChange('outputNameTemplate', next)}
          />
        </>
      ),
    });
  }
  if (output.outputMode === 'subdir') {
    rows.push({
      id: 'output-subdirectory',
      content: (
        <>
          <ui.FieldLabel>子目录名称</ui.FieldLabel>
          <input
            className="se-drop-input"
            value={output.outputSubdirectory}
            placeholder="ShadowEncoder"
            disabled={disabled}
            onChange={(event) => onChange('outputSubdirectory', event.target.value)}
          />
        </>
      ),
    });
  }
  if (output.outputMode === 'fixed' || output.outputMode === 'fixedRename') {
    rows.push({
      id: 'output-directory',
      content: (
        <>
          <ui.FieldLabel>指定目录</ui.FieldLabel>
          <div className="se-output-directory">
            <input className="se-drop-input" value={output.outputDirectory} readOnly placeholder="未选择目录" />
            <ui.Button
              className="se-output-directory-button"
              icon={<IconFolder size={15} />}
              title="选择输出目录"
              disabled={disabled}
              onClick={chooseDirectory}
            />
          </div>
        </>
      ),
    });
  }

  return <ui.AnimatedFieldGrid rows={rows} tight />;
}

export function OutputLocationGroup(props: OutputFieldsProps) {
  return (
    <ui.ParamGroup title="输出位置">
      <OutputLocationFields {...props} />
    </ui.ParamGroup>
  );
}
