import {
  getStorageVolume,
  listMediaTree,
  listStorageVolumes,
  type MediaTreeListing,
  type StorageVolume,
} from './ffmpeg';
import type { WorkflowTrigger } from './workflow';
import {
  collectWorkflowSourceFilesFromListings,
  evaluateBackupCapacityForVolumes,
  formatWorkflowBytes,
  matchesWorkflowVolume,
  storageVolumeKey,
  type WorkflowCapacityResult,
  type WorkflowSourceFile,
  type WorkflowSourceFilter,
} from './workflowRuntimeCore';

export {
  formatWorkflowBytes,
  matchesWorkflowVolume,
  storageVolumeKey,
};
export type {
  WorkflowCapacityCheck,
  WorkflowCapacityResult,
  WorkflowSourceFile,
  WorkflowSourceFilter,
} from './workflowRuntimeCore';

export async function collectWorkflowSourceFiles(
  sourcePaths: string[],
  filter: WorkflowSourceFilter,
): Promise<WorkflowSourceFile[]> {
  const listings: MediaTreeListing[] = [];
  for (const sourcePath of sourcePaths) {
    listings.push(await listMediaTree(sourcePath));
  }
  return collectWorkflowSourceFilesFromListings(listings, filter);
}

export async function sourceContainsMedia(sourcePaths: string[]): Promise<boolean> {
  const files = await collectWorkflowSourceFiles(sourcePaths, {
    extensions: [],
    minSizeMb: 0,
    mediaOnly: true,
    recursive: true,
  });
  return files.length > 0;
}

export async function evaluateBackupCapacity(
  sourcePaths: string[],
  filter: WorkflowSourceFilter,
  destinations: string[],
  reservePercent: number,
): Promise<WorkflowCapacityResult> {
  const files = await collectWorkflowSourceFiles(sourcePaths, filter);
  const requestedDestinations = destinations.map((value) => value.trim()).filter(Boolean);
  const volumes = await Promise.all(requestedDestinations.map((destination) => getStorageVolume(destination)));
  return evaluateBackupCapacityForVolumes(files, volumes, reservePercent);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function cancellableDelay(ms: number, isCancelled: () => boolean): Promise<boolean> {
  let remaining = ms;
  while (remaining > 0) {
    if (isCancelled()) return false;
    const slice = Math.min(250, remaining);
    await delay(slice);
    remaining -= slice;
  }
  return !isCancelled();
}

export async function waitForNewStorageVolume(
  trigger: WorkflowTrigger,
  isCancelled: () => boolean,
  onStatus: (message: string) => void,
): Promise<StorageVolume | null> {
  let previous = new Map(
    (await listStorageVolumes()).map((volume) => [storageVolumeKey(volume), volume]),
  );
  onStatus('等待新接入磁盘...');
  while (!isCancelled()) {
    if (!await cancellableDelay(1000, isCancelled)) return null;
    const volumes = await listStorageVolumes();
    const current = new Map(volumes.map((volume) => [storageVolumeKey(volume), volume]));
    const match = volumes.find((volume) => (
      !previous.has(storageVolumeKey(volume)) && matchesWorkflowVolume(volume, trigger)
    ));
    previous = current;
    if (!match) continue;
    const name = match.label.trim() || '未命名卷';
    onStatus(`已检测到 ${name} (${match.rootPath})，等待磁盘稳定...`);
    if (!await cancellableDelay(trigger.settleSeconds * 1000, isCancelled)) return null;
    const stableVolumes = await listStorageVolumes();
    const stable = stableVolumes.find((volume) => storageVolumeKey(volume) === storageVolumeKey(match));
    if (stable) return stable;
    previous = new Map(stableVolumes.map((volume) => [storageVolumeKey(volume), volume]));
    onStatus('磁盘已断开，继续等待新接入磁盘...');
  }
  return null;
}
