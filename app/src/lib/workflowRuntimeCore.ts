import type { MediaTreeListing, StorageVolume } from './ffmpeg';
import type { WorkflowTrigger } from './workflow';
import { isMediaPath, mediaExtension } from './mediaExtensions.ts';

export type WorkflowSourceFilter = {
  extensions: string[];
  minSizeMb: number;
  mediaOnly: boolean;
  recursive: boolean;
};

export type WorkflowSourceFile = {
  path: string;
  sizeBytes: number;
};

export type WorkflowCapacityCheck = {
  volume: StorageVolume;
  destinationCount: number;
  requiredBytes: number;
  reserveBytes: number;
  fits: boolean;
};

export type WorkflowCapacityResult = {
  fits: boolean;
  sourceBytes: number;
  fileCount: number;
  checks: WorkflowCapacityCheck[];
};

type NormalizedWorkflowSourceFilter = {
  extensions: Set<string>;
  minimumBytes: number;
  mediaOnly: boolean;
  recursive: boolean;
};

function filePathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:(?:\/|$)/i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

function normalizeSourceFilter(filter: WorkflowSourceFilter): NormalizedWorkflowSourceFilter {
  return {
    extensions: new Set(
      filter.extensions
        .map((value) => value.trim().replace(/^\.+/, '').toLocaleLowerCase())
        .filter(Boolean),
    ),
    minimumBytes: Number.isFinite(filter.minSizeMb) && filter.minSizeMb > 0
      ? filter.minSizeMb * 1024 * 1024
      : 0,
    mediaOnly: filter.mediaOnly,
    recursive: filter.recursive,
  };
}

function matchesSourceFilter(
  path: string,
  sizeBytes: number,
  filter: NormalizedWorkflowSourceFilter,
): boolean {
  const extension = mediaExtension(path);
  return (!filter.mediaOnly || isMediaPath(path))
    && (filter.extensions.size === 0 || filter.extensions.has(extension))
    && sizeBytes >= filter.minimumBytes;
}

export function collectWorkflowSourceFilesFromListings(
  listings: MediaTreeListing[],
  filter: WorkflowSourceFilter,
): WorkflowSourceFile[] {
  const files = new Map<string, WorkflowSourceFile>();
  const normalizedFilter = normalizeSourceFilter(filter);
  for (const listing of listings) {
    if (listing.errors.length > 0) {
      throw new Error(`无法完整读取素材目录：${listing.errors[0]}`);
    }
    if (!listing.rootIsDirectory) {
      const sizeBytes = listing.rootSizeBytes ?? 0;
      if (matchesSourceFilter(listing.rootPath, sizeBytes, normalizedFilter)) {
        files.set(filePathKey(listing.rootPath), { path: listing.rootPath, sizeBytes });
      }
      continue;
    }
    for (const entry of listing.entries) {
      if (entry.isDirectory || (!normalizedFilter.recursive && entry.depth > 1)) continue;
      const sizeBytes = entry.sizeBytes ?? 0;
      if (!matchesSourceFilter(entry.path, sizeBytes, normalizedFilter)) continue;
      files.set(filePathKey(entry.path), { path: entry.path, sizeBytes });
    }
  }
  return [...files.values()];
}

export function evaluateBackupCapacityForVolumes(
  files: WorkflowSourceFile[],
  destinationVolumes: StorageVolume[],
  reservePercent: number,
): WorkflowCapacityResult {
  const sourceBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  const grouped = new Map<string, { volume: StorageVolume; destinationCount: number }>();
  for (const volume of destinationVolumes) {
    const key = storageVolumeKey(volume);
    const current = grouped.get(key);
    if (current) current.destinationCount += 1;
    else grouped.set(key, { volume, destinationCount: 1 });
  }
  const safeReserve = Math.min(100, Math.max(0, Number(reservePercent) || 0));
  const checks = [...grouped.values()].map(({ volume, destinationCount }) => {
    const requiredBytes = sourceBytes * destinationCount;
    const reserveBytes = volume.totalBytes == null
      ? 0
      : Math.ceil(volume.totalBytes * (safeReserve / 100));
    return {
      volume,
      destinationCount,
      requiredBytes,
      reserveBytes,
      fits: volume.availableBytes != null
        && volume.totalBytes != null
        && volume.availableBytes >= requiredBytes + reserveBytes,
    };
  });
  return {
    fits: destinationVolumes.length > 0 && checks.length > 0 && checks.every((check) => check.fits),
    sourceBytes,
    fileCount: files.length,
    checks,
  };
}

export function storageVolumeKey(volume: StorageVolume): string {
  return `${volume.id}|${filePathKey(volume.rootPath)}`;
}

export function matchesWorkflowVolume(volume: StorageVolume, trigger: WorkflowTrigger): boolean {
  if (trigger.volumeKind === 'removable' && volume.driveType !== 'removable') return false;
  const expectedLabel = trigger.labelContains.trim().toLocaleLowerCase();
  return !expectedLabel || volume.label.toLocaleLowerCase().includes(expectedLabel);
}

export function formatWorkflowBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** exponent);
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}
