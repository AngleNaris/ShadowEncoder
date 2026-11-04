// 全局共享素材树：顶层来源用于 DIT，叶子文件用于批量媒体任务。
import React, {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isTauriRuntime, listMediaTree } from './ffmpeg';
import {
  getAgentSnapshot,
  isAgentRevisionConflict,
  replaceAgentSources,
  subscribeAgentStateChanged,
  type AgentSnapshot,
  type AgentSourceGroup,
} from './agentApi';
import {
  buildTaskInputUnits,
  groupSelectionStates,
  moveWithinList,
  type GroupSelectionState,
  type TaskBatchPlan,
} from './taskBatches';
import {
  allProcessPaths,
  buildFileTreeIndex,
  collectSubtreeNodes,
  computeTreeSelectionStates,
  filePathKey,
  filePathName,
  looksLikeDirectory,
  normalizeTreeSelection,
  selectedProcessPaths,
  selectedSourcePaths as selectedSourcePathsForTree,
  setTreeSelection,
  toggleTreeSelection,
  type FileTreeIndex,
  type FileTreeNode,
} from './fileTree';

export type FileListItem = FileTreeNode & {
  checked: boolean;
  indeterminate: boolean;
  expanded: boolean;
  loading: boolean;
  error: string;
  removable: boolean;
};

/** 会话态素材分组：每个分组是一次独立运行批次，随素材列表清空。 */
export type FileGroup = AgentSourceGroup;

export type FileGroupState = GroupSelectionState;

export type FileListContextValue = {
  /** 用户显式添加的顶层文件或目录。 */
  paths: string[];
  /** 当前可见的树行。 */
  items: FileListItem[];
  /** 实际批量处理输入；未完成枚举的目录暂以目录路径占位。 */
  allPaths: string[];
  /** 已勾选的实际文件；未完成枚举的整目录暂以目录路径占位。 */
  selectedPaths: string[];
  /** DIT 输入；完整选择的目录会保留为目录根，部分选择则展开。 */
  selectedSourcePaths: string[];
  totalCount: number;
  selectedCount: number;
  hasSelection: boolean;
  activePath: string | null;
  /** 会话态分组，按创建顺序即运行批次顺序。 */
  groups: FileGroup[];
  /** 各组勾选态，由成员勾选推导。 */
  groupStates: FileGroupState[];
  /** 已选素材按分组派生的运行批次；无分组时为空并沿用单批次运行。 */
  taskInputPlan: TaskBatchPlan;
  /** 当前勾选是否覆盖全部素材，用于「全选 / 全不选」开关。 */
  allSelected: boolean;
  addPaths: (paths: string[]) => void;
  clear: () => void;
  removePath: (path: string) => void;
  toggleSelect: (path: string) => void;
  toggleExpanded: (path: string) => void;
  setSelected: (paths: string[]) => void;
  selectAll: () => void;
  toggleSelectAll: () => void;
  clearSelection: () => void;
  setActivePath: (path: string | null) => void;
  resolveLeafPaths: (paths: string[]) => Promise<string[]>;
  createGroup: (label?: string) => string | null;
  renameGroup: (id: string, label: string) => void;
  removeGroup: (id: string) => void;
  addSelectionToGroup: (id: string) => void;
  removeSelectionFromGroup: (id: string) => void;
  setGroupChecked: (id: string, checked: boolean) => void;
  toggleGroupChecked: (id: string) => void;
  /** 把某个成员移出分组（成员行右键用，不依赖当前勾选）。 */
  removeGroupMember: (groupId: string, path: string) => void;
  /** 顶层素材排序（同时是未分组批次与脚本输入顺序）。 */
  reorderRoots: (fromPath: string, toPath: string, placeAfter: boolean) => void;
  /** 目录内同层素材排序。 */
  reorderSiblings: (parentPath: string, fromPath: string, toPath: string, placeAfter: boolean) => void;
  /** 分组顺序（= 运行批次顺序）。 */
  reorderGroups: (fromId: string, toId: string, placeAfter: boolean) => void;
  /** 组内成员顺序（= 该批次内素材与脚本输入顺序）。 */
  reorderGroupMember: (groupId: string, fromPath: string, toPath: string, placeAfter: boolean) => void;
};

const FileListContext = createContext<FileListContextValue | null>(null);

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = filePathKey(path);
    if (!path || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function memberCovers(memberKey: string, pathKey: string): boolean {
  return pathKey === memberKey || pathKey.startsWith(`${memberKey}/`);
}

function normalizeGroupMembers(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const members: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const key = filePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(path);
  }
  return members;
}

function normalizeGroups(groups: readonly FileGroup[]): FileGroup[] {
  const result: FileGroup[] = [];
  for (const group of groups) {
    if (!group.id) continue;
    const paths = normalizeGroupMembers(group.paths ?? []);
    if (paths.length === 0) continue;
    result.push({ id: group.id, label: group.label?.trim() || '分组', paths });
  }
  return result;
}


/** 素材来源被移除后同步清理分组：成员必须仍位于某个顶层来源之下。 */
function pruneGroups(groups: readonly FileGroup[], rootPaths: readonly string[]): FileGroup[] {
  if (groups.length === 0) return [];
  const rootKeys = rootPaths.map(filePathKey);
  const result: FileGroup[] = [];
  for (const group of groups) {
    const paths = group.paths.filter((member) => (
      rootKeys.some((rootKey) => memberCovers(rootKey, filePathKey(member)))
    ));
    if (paths.length === 0) continue;
    result.push({ ...group, paths });
  }
  return result;
}

type AgentSourceStatePayload = {
  paths: string[];
  selectedPaths: string[];
  selectedSourcePaths: string[];
  activePath: string | null;
  groups: FileGroup[];
};

function sourceStateFromSnapshot(snapshot: AgentSnapshot): AgentSourceStatePayload {
  return {
    paths: snapshot.sources.map((source) => source.path),
    selectedPaths: snapshot.selectedPaths ?? [],
    selectedSourcePaths: snapshot.selectedSourcePaths ?? snapshot.selectedPaths ?? [],
    activePath: snapshot.activePath ?? null,
    groups: normalizeGroups(snapshot.groups ?? []),
  };
}

function sourceStateFingerprint(state: AgentSourceStatePayload): string {
  return JSON.stringify(state);
}

export function FileListProvider({ children }: { children: ReactNode }) {
  const desktopRuntime = isTauriRuntime();
  const [paths, setPaths] = useState<string[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [trees, setTrees] = useState<Map<string, FileTreeNode[]>>(() => new Map());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());
  const [treeErrors, setTreeErrors] = useState<Map<string, string>>(() => new Map());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  /** 手动排序：父目录 key → 子项顺序（会话态，随素材列表清空）。 */
  const [childOrder, setChildOrder] = useState<Map<string, string[]>>(() => new Map());
  const pathsRef = useRef(paths);
  const treesRef = useRef(trees);
  const groupsRef = useRef(groups);
  const childOrderRef = useRef(childOrder);
  const groupSeqRef = useRef(0);
  const indexRef = useRef<FileTreeIndex>(buildFileTreeIndex([], new Map()));
  const pendingTrees = useRef<Map<string, Promise<FileTreeNode[]>>>(new Map());
  const sourceRevisionRef = useRef(0);
  const backendReadyRef = useRef(!desktopRuntime);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const localChangeVersionRef = useRef(0);
  const pendingBeforeReadyRef = useRef<AgentSourceStatePayload | null>(null);
  const lastServerStateRef = useRef<AgentSourceStatePayload>({
    paths: [], selectedPaths: [], selectedSourcePaths: [], activePath: null,
    groups: [],
  });
  const lastQueuedFingerprintRef = useRef(sourceStateFingerprint(lastServerStateRef.current));
  const skipNextSourceSyncRef = useRef(false);
  const mountedRef = useRef(true);

  const index = useMemo(() => buildFileTreeIndex(paths, trees, childOrder), [childOrder, paths, trees]);
  indexRef.current = index;
  childOrderRef.current = childOrder;

  const applySourceSnapshot = useCallback((snapshot: AgentSnapshot, expectedLocalVersion?: number) => {
    sourceRevisionRef.current = snapshot.sourceRevision;
    const remote = sourceStateFromSnapshot(snapshot);
    lastServerStateRef.current = remote;
    if (expectedLocalVersion != null && expectedLocalVersion !== localChangeVersionRef.current) return;
    if (!mountedRef.current) return;

    skipNextSourceSyncRef.current = true;
    const allowedRoots = new Set(remote.paths.map(filePathKey));
    const nextTrees = new Map(
      [...treesRef.current].filter(([rootKey]) => allowedRoots.has(rootKey)),
    );
    const nextIndex = buildFileTreeIndex(remote.paths, nextTrees, childOrderRef.current);
    let nextSelection = new Set(remote.selectedPaths.map(filePathKey));
    for (const selectedPath of remote.selectedSourcePaths) {
      const key = filePathKey(selectedPath);
      if (nextIndex.nodesByKey.has(key)) {
        nextSelection = setTreeSelection(nextSelection, selectedPath, nextIndex, true);
      } else {
        nextSelection.add(key);
      }
    }

    pathsRef.current = remote.paths;
    treesRef.current = nextTrees;
    indexRef.current = nextIndex;
    setPaths(remote.paths);
    setTrees(nextTrees);
    setSelectedKeys(normalizeTreeSelection(nextSelection, nextIndex));
    setExpandedKeys((current) => new Set([...current].filter((key) => {
      const node = nextIndex.nodesByKey.get(key);
      return Boolean(node && allowedRoots.has(filePathKey(node.rootPath)));
    })));
    setLoadingKeys((current) => new Set([...current].filter((key) => allowedRoots.has(key))));
    setTreeErrors((current) => new Map([...current].filter(([key]) => allowedRoots.has(key))));
    setActivePath(remote.activePath);
    const nextGroups = pruneGroups(remote.groups, remote.paths);
    // 本地裁剪出的分组与远端不一致时必须回推：否则 Agent 会一直保留已移除来源的成员。
    skipNextSourceSyncRef.current = JSON.stringify(nextGroups) === JSON.stringify(remote.groups);
    groupsRef.current = nextGroups;
    setGroups(nextGroups);
  }, []);

  const queueSourceCommit = useCallback((intended: AgentSourceStatePayload, localVersion: number) => {
    commandQueueRef.current = commandQueueRef.current.then(async () => {
      try {
        let snapshot: AgentSnapshot;
        try {
          snapshot = await replaceAgentSources(
            intended.paths,
            intended.selectedPaths,
            intended.selectedSourcePaths,
            intended.activePath,
            sourceRevisionRef.current,
            intended.groups,
          );
        } catch (error) {
          if (!isAgentRevisionConflict(error)) throw error;
          const latest = await getAgentSnapshot();
          const latestState = sourceStateFromSnapshot(latest);
          sourceRevisionRef.current = latest.sourceRevision;
          if (sourceStateFingerprint(latestState) !== sourceStateFingerprint(lastServerStateRef.current)) {
            applySourceSnapshot(latest, localVersion);
            console.error('素材列表已被其他操作修改，本次 GUI 修改未覆盖远程状态');
            return;
          }
          snapshot = await replaceAgentSources(
            intended.paths,
            intended.selectedPaths,
            intended.selectedSourcePaths,
            intended.activePath,
            latest.sourceRevision,
            intended.groups,
          );
        }
        sourceRevisionRef.current = snapshot.sourceRevision;
        lastServerStateRef.current = sourceStateFromSnapshot(snapshot);
        applySourceSnapshot(snapshot, localVersion);
      } catch (error) {
        console.error('无法同步素材列表到 Agent 状态服务', error);
        try {
          applySourceSnapshot(await getAgentSnapshot(), localVersion);
        } catch (refreshError) {
          console.error('无法刷新 Agent 素材快照', refreshError);
        }
      }
    });
  }, [applySourceSnapshot]);

  const rootIsPresent = useCallback((rootPath: string) => (
    pathsRef.current.some((path) => filePathKey(path) === filePathKey(rootPath))
  ), []);

  const ensureTree = useCallback((rootPath: string): Promise<FileTreeNode[]> => {
    const rootKey = filePathKey(rootPath);
    const cached = treesRef.current.get(rootKey);
    if (cached) return Promise.resolve(cached);
    const pending = pendingTrees.current.get(rootKey);
    if (pending) return pending;

    setLoadingKeys((current) => new Set(current).add(rootKey));
    setTreeErrors((current) => {
      if (!current.has(rootKey)) return current;
      const next = new Map(current);
      next.delete(rootKey);
      return next;
    });

    const request = listMediaTree(rootPath)
      .then((listing) => {
        if (!listing.rootIsDirectory) return [];
        const entries: FileTreeNode[] = listing.entries.map((entry) => ({
          ...entry,
          rootPath,
        }));
        if (rootIsPresent(rootPath)) {
          const nextTrees = new Map(treesRef.current);
          nextTrees.set(rootKey, entries);
          treesRef.current = nextTrees;
          setTrees(nextTrees);
          const nextIndex = buildFileTreeIndex(pathsRef.current, nextTrees);
          setSelectedKeys((current) => {
            const next = new Set(current);
            if (next.has(rootKey)) {
              for (const node of collectSubtreeNodes(nextIndex, rootPath)) {
                next.add(filePathKey(node.path));
              }
            }
            return normalizeTreeSelection(next, nextIndex);
          });
          if (listing.errors.length > 0) {
            setTreeErrors((current) => new Map(current).set(rootKey, listing.errors.join('\n')));
          }
        }
        return entries;
      })
      .catch((reason) => {
        const message = String(reason instanceof Error ? reason.message : reason);
        if (rootIsPresent(rootPath)) {
          setTreeErrors((current) => new Map(current).set(rootKey, message));
        }
        throw reason;
      })
      .finally(() => {
        pendingTrees.current.delete(rootKey);
        setLoadingKeys((current) => {
          const next = new Set(current);
          next.delete(rootKey);
          return next;
        });
      });
    pendingTrees.current.set(rootKey, request);
    return request;
  }, [rootIsPresent]);

  const addPaths = useCallback((incoming: string[]) => {
    startTransition(() => {
      setPaths((current) => {
        const next = dedupePaths([...current, ...incoming]);
        pathsRef.current = next;
        return next.length === current.length ? current : next;
      });
    });
  }, []);

  const commitGroups = useCallback((next: FileGroup[]) => {
    const normalized = normalizeGroups(next);
    groupsRef.current = normalized;
    setGroups(normalized);
  }, []);

  const clear = useCallback(() => {
    pathsRef.current = [];
    treesRef.current = new Map();
    setPaths([]);
    setTrees(new Map());
    setSelectedKeys(new Set());
    setExpandedKeys(new Set());
    setLoadingKeys(new Set());
    setTreeErrors(new Map());
    setActivePath(null);
    commitGroups([]);
    childOrderRef.current = new Map();
    setChildOrder(new Map());
  }, [commitGroups]);

  const removePath = useCallback((path: string) => {
    const rootKey = filePathKey(path);
    const removedKeys = new Set(
      collectSubtreeNodes(indexRef.current, path).map((node) => filePathKey(node.path)),
    );
    removedKeys.add(rootKey);

    const nextPaths = pathsRef.current.filter((item) => filePathKey(item) !== rootKey);
    pathsRef.current = nextPaths;
    setPaths(nextPaths);
    commitGroups(pruneGroups(groupsRef.current, nextPaths));
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of removedKeys) next.delete(key);
      return next;
    });
    const nextTrees = new Map(treesRef.current);
    nextTrees.delete(rootKey);
    treesRef.current = nextTrees;
    setTrees(nextTrees);
    setExpandedKeys((current) => {
      const next = new Set(current);
      for (const key of removedKeys) next.delete(key);
      return next;
    });
    setTreeErrors((current) => {
      const next = new Map(current);
      next.delete(rootKey);
      return next;
    });
    setActivePath((current) => (
      current && removedKeys.has(filePathKey(current)) ? null : current
    ));
  }, []);

  const toggleExpanded = useCallback((path: string) => {
    const node = indexRef.current.nodesByKey.get(filePathKey(path));
    if (!node?.isDirectory) return;
    const key = filePathKey(path);
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!indexRef.current.loadedRootKeys.has(filePathKey(node.rootPath))) {
      void ensureTree(node.rootPath).catch(() => undefined);
    }
  }, [ensureTree]);

  const toggleSelect = useCallback((path: string) => {
    const currentIndex = indexRef.current;
    const node = currentIndex.nodesByKey.get(filePathKey(path));
    if (!node) return;
    if (node.isDirectory && !currentIndex.loadedRootKeys.has(filePathKey(node.rootPath))) {
      const shouldSelect = !selectedKeys.has(filePathKey(path));
      setSelectedKeys((current) => setTreeSelection(current, path, currentIndex, shouldSelect));
      void ensureTree(node.rootPath)
        .then(() => {
          const loadedIndex = buildFileTreeIndex(pathsRef.current, treesRef.current);
          setSelectedKeys((current) => setTreeSelection(current, path, loadedIndex, shouldSelect));
        })
        .catch(() => undefined);
      return;
    }
    setSelectedKeys((current) => toggleTreeSelection(current, path, currentIndex));
  }, [ensureTree, selectedKeys]);

  const setSelected = useCallback((selectedPaths: string[]) => {
    const next = new Set(selectedPaths.map(filePathKey));
    setSelectedKeys(normalizeTreeSelection(next, indexRef.current));
  }, []);

  const selectAll = useCallback(() => {
    void (async () => {
      await Promise.allSettled(
        pathsRef.current.filter(looksLikeDirectory).map((path) => ensureTree(path)),
      );
      const currentIndex = buildFileTreeIndex(pathsRef.current, treesRef.current);
      setSelectedKeys(new Set(currentIndex.nodesByKey.keys()));
    })();
  }, [ensureTree]);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  const resolveLeafPaths = useCallback(async (targets: string[]): Promise<string[]> => {
    const resolved: string[] = [];
    for (const target of targets) {
      let currentIndex = buildFileTreeIndex(pathsRef.current, treesRef.current);
      const node = currentIndex.nodesByKey.get(filePathKey(target));
      const isDirectory = node?.isDirectory ?? looksLikeDirectory(target);
      if (!isDirectory) {
        resolved.push(target);
        continue;
      }
      const rootPath = node?.rootPath ?? target;
      await ensureTree(rootPath);
      currentIndex = buildFileTreeIndex(pathsRef.current, treesRef.current);
      for (const descendant of collectSubtreeNodes(currentIndex, target)) {
        if (!descendant.isDirectory) resolved.push(descendant.path);
      }
    }
    return dedupePaths(resolved);
  }, [ensureTree]);

  const selectionStates = useMemo(
    () => computeTreeSelectionStates(index, selectedKeys),
    [index, selectedKeys],
  );

  const items = useMemo(() => {
    const result: FileListItem[] = [];
    const visited = new Set<string>();
    const append = (node: FileTreeNode) => {
      const key = filePathKey(node.path);
      if (visited.has(key)) return;
      visited.add(key);
      const state = selectionStates.get(key) ?? 'unchecked';
      const rootKey = filePathKey(node.rootPath);
      result.push({
        ...node,
        checked: state === 'checked',
        indeterminate: state === 'partial',
        expanded: expandedKeys.has(key),
        loading: node.depth === 0 && loadingKeys.has(rootKey),
        error: node.depth === 0 ? treeErrors.get(rootKey) ?? '' : '',
        removable: node.depth === 0,
      });
      if (node.isDirectory && expandedKeys.has(key)) {
        for (const child of index.childrenByKey.get(key) ?? []) append(child);
      }
    };
    for (const root of index.roots) append(root);
    return result;
  }, [expandedKeys, index, loadingKeys, selectionStates, treeErrors]);

  const allPaths = useMemo(() => allProcessPaths(index), [index]);
  const selectedPaths = useMemo(
    () => selectedProcessPaths(index, selectedKeys),
    [index, selectedKeys],
  );
  const selectedSourcePaths = useMemo(
    () => selectedSourcePathsForTree(index, selectedKeys),
    [index, selectedKeys],
  );
  const allSelected = useMemo(
    () => allPaths.length > 0 && allPaths.every((path) => selectedKeys.has(filePathKey(path))),
    [allPaths, selectedKeys],
  );
  const groupStates = useMemo(
    () => groupSelectionStates(groups, selectedSourcePaths, selectedPaths).map((state) => ({
      ...state,
      // 目录判断用索引里的真实类型；成员可能位于未展开目录内，此时保留原名。
      members: state.members.map((member) => {
        const node = index.nodesByKey.get(filePathKey(member.path));
        return node ? { ...member, isDirectory: node.isDirectory } : member;
      }),
    })),
    [groups, index, selectedPaths, selectedSourcePaths],
  );
  const taskInputPlan = useMemo(
    () => buildTaskInputUnits(groups, selectedSourcePaths, selectedPaths),
    [groups, selectedPaths, selectedSourcePaths],
  );

  const toggleSelectAll = useCallback(() => {
    if (allSelected) clearSelection();
    else selectAll();
  }, [allSelected, clearSelection, selectAll]);

  const createGroup = useCallback((label?: string) => {
    const members = normalizeGroupMembers(selectedSourcePaths);
    if (members.length === 0) return null;
    let nextNumber = 1;
    for (const group of groupsRef.current) {
      const match = /分组\s*(\d+)/.exec(group.label ?? '');
      if (match) nextNumber = Math.max(nextNumber, Number(match[1]) + 1);
    }
    const id = `group_${Date.now().toString(36)}${(++groupSeqRef.current).toString(36)}`;
    commitGroups([
      ...groupsRef.current,
      { id, label: label?.trim() || `分组 ${nextNumber}`, paths: members },
    ]);
    return id;
  }, [commitGroups, selectedSourcePaths]);

  const renameGroup = useCallback((id: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    commitGroups(groupsRef.current.map((group) => (
      group.id === id ? { ...group, label: nextLabel } : group
    )));
  }, [commitGroups]);

  const removeGroup = useCallback((id: string) => {
    commitGroups(groupsRef.current.filter((group) => group.id !== id));
  }, [commitGroups]);

  /** 把当前勾选并入分组；被新条目覆盖的旧成员会被替换，避免同一批重复输入。 */
  const addSelectionToGroup = useCallback((id: string) => {
    const targets = normalizeGroupMembers(selectedSourcePaths);
    if (targets.length === 0) return;
    const targetKeys = targets.map(filePathKey);
    commitGroups(groupsRef.current.map((group) => {
      if (group.id !== id) return group;
      const kept = group.paths.filter((member) => {
        const memberKey = filePathKey(member);
        return !targetKeys.some((targetKey) => memberCovers(targetKey, memberKey));
      });
      const added = targets.filter((target) => {
        const targetKey = filePathKey(target);
        return !kept.some((member) => memberCovers(filePathKey(member), targetKey));
      });
      return { ...group, paths: [...kept, ...added] };
    }));
  }, [commitGroups, selectedSourcePaths]);

  /** 从分组移除当前勾选的成员（含被勾选目录覆盖的成员）。 */
  const removeSelectionFromGroup = useCallback((id: string) => {
    const selectionKeys = [...selectedSourcePaths, ...selectedPaths].map(filePathKey);
    if (selectionKeys.length === 0) return;
    commitGroups(groupsRef.current.map((group) => {
      if (group.id !== id) return group;
      return {
        ...group,
        paths: group.paths.filter((member) => {
          const memberKey = filePathKey(member);
          return !selectionKeys.some((key) => memberCovers(key, memberKey));
        }),
      };
    }));
  }, [commitGroups, selectedPaths, selectedSourcePaths]);

  const setGroupChecked = useCallback((id: string, checked: boolean) => {
    const group = groupsRef.current.find((item) => item.id === id);
    if (!group) return;
    setSelectedKeys((current) => {
      const currentIndex = buildFileTreeIndex(pathsRef.current, treesRef.current);
      let next = current;
      for (const member of group.paths) {
        next = setTreeSelection(next, member, currentIndex, checked);
      }
      return normalizeTreeSelection(next, currentIndex);
    });
  }, []);

  const toggleGroupChecked = useCallback((id: string) => {
    const state = groupStates.find((item) => item.id === id);
    setGroupChecked(id, state?.state !== 'checked');
  }, [groupStates, setGroupChecked]);

  /** 成员行右键移出分组：按路径精确移除，其余成员顺序不变。 */
  const removeGroupMember = useCallback((groupId: string, path: string) => {
    const targetKey = filePathKey(path);
    commitGroups(groupsRef.current.map((group) => {
      if (group.id !== groupId) return group;
      return {
        ...group,
        paths: group.paths.filter((member) => filePathKey(member) !== targetKey),
      };
    }));
  }, [commitGroups]);

  /** 顶层素材（来源行）排序：直接改 paths 顺序，Agent 侧同为批次顺序。 */
  const reorderRoots = useCallback((fromPath: string, toPath: string, placeAfter: boolean) => {
    const current = pathsRef.current;
    const fromKey = filePathKey(fromPath);
    const toKey = filePathKey(toPath);
    const from = current.findIndex((path) => filePathKey(path) === fromKey);
    const to = current.findIndex((path) => filePathKey(path) === toKey);
    if (from < 0 || to < 0 || from === to) return;
    const next = moveWithinList(current, from, to, placeAfter);
    pathsRef.current = next;
    setPaths(next);
  }, []);

  /** 目录内同层素材排序：写入手动顺序表，重建索引后显示、勾选与批次顺序一并跟随。 */
  const reorderSiblings = useCallback((parentPath: string, fromPath: string, toPath: string, placeAfter: boolean) => {
    const parentKey = filePathKey(parentPath);
    const siblings = indexRef.current.childrenByKey.get(parentKey) ?? [];
    const current = siblings.map((node) => filePathKey(node.path));
    const from = current.indexOf(filePathKey(fromPath));
    const to = current.indexOf(filePathKey(toPath));
    if (from < 0 || to < 0 || from === to) return;
    const next = new Map(childOrderRef.current);
    next.set(parentKey, moveWithinList(current, from, to, placeAfter));
    childOrderRef.current = next;
    setChildOrder(next);
  }, []);

  /** 分组顺序：分组数组顺序即运行批次顺序。 */
  const reorderGroups = useCallback((fromId: string, toId: string, placeAfter: boolean) => {
    const current = groupsRef.current;
    const from = current.findIndex((group) => group.id === fromId);
    const to = current.findIndex((group) => group.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    commitGroups(moveWithinList(current, from, to, placeAfter));
  }, [commitGroups]);

  /** 组内成员顺序：决定该批次内的素材与脚本输入顺序。 */
  const reorderGroupMember = useCallback((groupId: string, fromPath: string, toPath: string, placeAfter: boolean) => {
    commitGroups(groupsRef.current.map((group) => {
      if (group.id !== groupId) return group;
      const from = group.paths.findIndex((path) => filePathKey(path) === filePathKey(fromPath));
      const to = group.paths.findIndex((path) => filePathKey(path) === filePathKey(toPath));
      if (from < 0 || to < 0 || from === to) return group;
      return { ...group, paths: moveWithinList(group.paths, from, to, placeAfter) };
    }));
  }, [commitGroups]);

  useEffect(() => {
    if (!desktopRuntime) return undefined;
    mountedRef.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void subscribeAgentStateChanged((event) => {
      if (event.actor === 'gui' || !backendReadyRef.current) return;
      const localVersion = localChangeVersionRef.current;
      commandQueueRef.current = commandQueueRef.current.then(async () => {
        applySourceSnapshot(await getAgentSnapshot(), localVersion);
      }).catch((error) => console.error('无法接收 Agent 素材更新', error));
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    void getAgentSnapshot().then((snapshot) => {
      if (disposed) return;
      sourceRevisionRef.current = snapshot.sourceRevision;
      lastServerStateRef.current = sourceStateFromSnapshot(snapshot);
      backendReadyRef.current = true;
      const pending = pendingBeforeReadyRef.current;
      pendingBeforeReadyRef.current = null;
      if (pending) {
        queueSourceCommit(pending, localChangeVersionRef.current);
        return;
      }
      if (snapshot.sources.length > 0
        || snapshot.selectedPaths.length > 0
        || snapshot.selectedSourcePaths.length > 0
        || snapshot.activePath) {
        queueSourceCommit({
          paths: [], selectedPaths: [], selectedSourcePaths: [], activePath: null, groups: [],
        }, localChangeVersionRef.current);
        return;
      }
      applySourceSnapshot(snapshot);
    }).catch((error) => console.error('无法初始化 Agent 素材状态', error));

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, [applySourceSnapshot, desktopRuntime, queueSourceCommit]);

  useEffect(() => {
    if (!desktopRuntime) return;
    const intended: AgentSourceStatePayload = {
      paths,
      selectedPaths,
      selectedSourcePaths,
      activePath,
      // 发送前同样按素材来源裁剪，避免把已移除来源的成员推给 Agent 而被整体拒绝。
      groups: pruneGroups(groups, paths),
    };
    const fingerprint = sourceStateFingerprint(intended);
    if (skipNextSourceSyncRef.current) {
      skipNextSourceSyncRef.current = false;
      lastQueuedFingerprintRef.current = fingerprint;
      return;
    }
    if (fingerprint === lastQueuedFingerprintRef.current) return;
    lastQueuedFingerprintRef.current = fingerprint;
    const localVersion = ++localChangeVersionRef.current;
    if (!backendReadyRef.current) {
      pendingBeforeReadyRef.current = intended;
      return;
    }
    queueSourceCommit(intended, localVersion);
  }, [
    activePath,
    desktopRuntime,
    groups,
    paths,
    queueSourceCommit,
    selectedPaths,
    selectedSourcePaths,
  ]);

  const value = useMemo<FileListContextValue>(() => ({
    paths,
    items,
    allPaths,
    selectedPaths,
    selectedSourcePaths,
    totalCount: allPaths.length,
    selectedCount: selectedPaths.length,
    hasSelection: selectedKeys.size > 0,
    activePath,
    groups,
    groupStates,
    taskInputPlan,
    allSelected,
    addPaths,
    clear,
    removePath,
    toggleSelect,
    toggleExpanded,
    setSelected,
    selectAll,
    clearSelection,
    toggleSelectAll,
    setActivePath,
    resolveLeafPaths,
    createGroup,
    renameGroup,
    removeGroup,
    addSelectionToGroup,
    removeSelectionFromGroup,
    setGroupChecked,
    toggleGroupChecked,
    removeGroupMember,
    reorderRoots,
    reorderSiblings,
    reorderGroups,
    reorderGroupMember,
  }), [
    paths, items, allPaths, selectedPaths, selectedSourcePaths, selectedKeys,
    activePath, groups, groupStates, taskInputPlan, allSelected,
    addPaths, clear, removePath, toggleSelect, toggleExpanded,
    setSelected, selectAll, clearSelection, toggleSelectAll, resolveLeafPaths,
    createGroup, renameGroup, removeGroup, addSelectionToGroup,
    removeSelectionFromGroup, setGroupChecked, toggleGroupChecked, removeGroupMember,
    reorderRoots, reorderSiblings, reorderGroups, reorderGroupMember,
  ]);

  return <FileListContext.Provider value={value}>{children}</FileListContext.Provider>;
}

export function useFileList(): FileListContextValue {
  const context = useContext(FileListContext);
  if (!context) throw new Error('useFileList must be used within FileListProvider');
  return context;
}
