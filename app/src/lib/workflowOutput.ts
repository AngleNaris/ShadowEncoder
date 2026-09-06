import type { OutputSettings } from './ffmpeg';

export type WorkflowOutputOverride = {
  location: 'inherit' | 'source' | 'subdir' | 'fixed';
  naming: 'inherit' | 'default' | 'template';
  directory: string;
  subdirectory: string;
  nameTemplate: string;
};

export function mergeOutputOverride(previous: WorkflowOutputOverride | undefined, next?: WorkflowOutputOverride): WorkflowOutputOverride {
  const result: WorkflowOutputOverride = { location: 'inherit', naming: 'inherit', directory: '', subdirectory: 'ShadowEncoder', nameTemplate: '{name}{suffix}', ...previous };
  if (next && ['source', 'subdir', 'fixed'].includes(next.location)) {
    result.location = next.location;
    result.directory = typeof next.directory === 'string' ? next.directory : '';
    result.subdirectory = typeof next.subdirectory === 'string' ? next.subdirectory : '';
  }
  if (next && ['default', 'template'].includes(next.naming)) {
    result.naming = next.naming;
    result.nameTemplate = typeof next.nameTemplate === 'string' ? next.nameTemplate : '';
  }
  return result;
}

export function applyOutputOverride(settings: OutputSettings, override?: WorkflowOutputOverride): OutputSettings {
  if (!override || (override.location === 'inherit' && override.naming === 'inherit')) return settings;
  const location = override.location === 'inherit'
    ? settings.mode.startsWith('fixed') ? 'fixed' : settings.mode.startsWith('subdir') ? 'subdir' : 'source'
    : override.location;
  const nameTemplate = override.naming === 'template' ? override.nameTemplate
    : override.naming === 'default' ? '{name}{suffix}'
    : ['rename', 'fixedRename', 'subdirRename'].includes(settings.mode) ? settings.nameTemplate
    : settings.mode === 'source' ? (settings.codecLabel ? '{name}_{res}_{fps}_{codec}_{bitrate}' : settings.presetName ? '{name}_{preset}' : '{name}{suffix}')
    : '{name}{suffix}';
  return { ...settings, mode: location === 'fixed' ? 'fixedRename' : location === 'subdir' ? 'subdirRename' : 'rename', nameTemplate,
    ...(override.location === 'inherit' ? {} : { directory: override.directory, subdirectory: override.subdirectory }) };
}
