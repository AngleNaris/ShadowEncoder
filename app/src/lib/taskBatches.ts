// 批次派生：每个分组是一次独立运行批次，未分组素材最后合成一批。
import { filePathKey } from './fileTree';

export type SourceGroupLike = {
  id: string;
  label: string;
  paths: string[];
};

export type TaskInputUnit = {
  label: string;
  paths: string[];
};

export type TaskBatchPlan = {
  /** 依次执行的批次；无分组时为空，调用方保持单批次旧行为。 */
  units: TaskInputUnit[];
  /** 选中素材为空而被跳过的分组名，用于日志提示。 */
  skippedGroups: string[];
};

export type GroupMemberState = {
  path: string;
  name: string;
  isDirectory: boolean;
  selected: boolean;
};

export type GroupSelectionState = {
  id: string;
  label: string;
  memberCount: number;
  /** 至少有一项仍被勾选的成员数。 */
  selectedCount: number;
  state: 'checked' | 'partial' | 'unchecked';
  /** 组成员逐项明细，供列表直接渲染组内行。 */
  members: GroupMemberState[];
};

export const UNGROUPED_LABEL = '未分组';

/** 成员覆盖判定：路径就是成员本身，或位于成员目录之下。 */
function memberCovers(memberKey: string, pathKey: string): boolean {
  return pathKey === memberKey || pathKey.startsWith(`${memberKey}/`);
}

/** 已选素材条目；完整勾选的目录保留目录根，其余为叶子文件。 */
function selectedEntries(
  selectedSourcePaths: readonly string[],
  selectedPaths: readonly string[],
): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  const sourceKeys: string[] = [];
  for (const path of selectedSourcePaths) {
    const key = filePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    sourceKeys.push(key);
    entries.push(path);
  }
  for (const path of selectedPaths) {
    const key = filePathKey(path);
    if (seen.has(key)) continue;
    // 已完整勾选的目录根已经覆盖其子树，避免同一批重复输入。
    if (sourceKeys.some((sourceKey) => memberCovers(sourceKey, key))) continue;
    seen.add(key);
    entries.push(path);
  }
  return entries;
}

/**
 * 按分组派生运行批次：分组按创建顺序依次成批，未分组素材合成最后一批。
 * 无分组时返回空 units，调用方沿用单批次运行。
 */
export function buildTaskInputUnits(
  groups: readonly SourceGroupLike[],
  selectedSourcePaths: readonly string[],
  selectedPaths: readonly string[],
): TaskBatchPlan {
  if (groups.length === 0) return { units: [], skippedGroups: [] };

  const entries = selectedEntries(selectedSourcePaths, selectedPaths);
  const entryKeys = entries.map(filePathKey);
  const claimed = new Array<boolean>(entries.length).fill(false);
  const units: TaskInputUnit[] = [];
  const skippedGroups: string[] = [];

  for (const group of groups) {
    const memberKeys = group.paths.map(filePathKey);
    const paths: string[] = [];
    // 组内顺序以分组自己的成员顺序为准（拖拽可调），决定该批次内的脚本输入顺序。
    for (const memberKey of memberKeys) {
      entries.forEach((entry, index) => {
        if (claimed[index]) return;
        if (!memberCovers(memberKey, entryKeys[index])) return;
        claimed[index] = true;
        paths.push(entry);
      });
    }
    if (paths.length === 0) skippedGroups.push(group.label);
    else units.push({ label: group.label, paths });
  }

  const rest = entries.filter((_, index) => !claimed[index]);
  if (rest.length > 0) units.push({ label: UNGROUPED_LABEL, paths: rest });
  return { units, skippedGroups };
}

/** 分组勾选态由成员推导：全部勾选 / 部分勾选 / 全未勾选。 */
export function groupSelectionStates(
  groups: readonly SourceGroupLike[],
  selectedSourcePaths: readonly string[],
  selectedPaths: readonly string[],
): GroupSelectionState[] {
  const sourceKeys = selectedSourcePaths.map(filePathKey);
  const selectedKeys = [...sourceKeys, ...selectedPaths.map(filePathKey)];

  return groups.map((group) => {
    let full = 0;
    let touched = 0;
    const members: GroupMemberState[] = group.paths.map((member) => {
      const memberKey = filePathKey(member);
      // 祖先目录被完整勾选时，成员也随整棵子树进入本批次。
      const ancestorSelected = sourceKeys.some((key) => memberCovers(key, memberKey));
      const insideSelected = selectedKeys.some((key) => memberCovers(memberKey, key));
      const selected = ancestorSelected || insideSelected;
      if (selected) {
        touched += 1;
        if (ancestorSelected) full += 1;
      }
      return {
        path: member,
        name: member.split(/[/\\]/).filter(Boolean).pop() || member,
        isDirectory: /[/\\]$/.test(member),
        selected,
      };
    });
    const state = full === group.paths.length && group.paths.length > 0
      ? 'checked'
      : touched === 0 ? 'unchecked' : 'partial';
    return {
      id: group.id,
      label: group.label,
      memberCount: group.paths.length,
      selectedCount: touched,
      state,
      members,
    };
  });
}

/** 把 from 移到 to 之前或之后；其余项相对位置不变。拖拽排序与列表重排共用。 */
export function moveWithinList<T>(list: readonly T[], from: number, to: number, placeAfter: boolean): T[] {
  if (from < 0 || to < 0 || from === to) return [...list];
  const moving = list[from];
  const without = list.filter((_, index) => index !== from);
  const target = list[to];
  const targetIndex = without.findIndex((item) => item === target);
  if (targetIndex < 0) return [...list];
  const next = [...without];
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, moving);
  return next;
}
