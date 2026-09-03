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
} from './agentApi';
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
  addPaths: (paths: string[]) => void;
  clear: () => void;
  removePath: (path: string) => void;
  toggleSelect: (path: string) => void;
  toggleExpanded: (path: string) => void;
  setSelected: (paths: string[]) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setActivePath: (path: string | null) => void;
  resolveLeafPaths: (paths: string[]) => Promise<string[]>;
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

type AgentSourceStatePayload = {
  paths: string[];
  selectedPaths: string[];
  selectedSourcePaths: string[];
  activePath: string | null;
};

function sourceStateFromSnapshot(snapshot: AgentSnapshot): AgentSourceStatePayload {
  return {
    paths: snapshot.sources.map((source) => source.path),
    selectedPaths: snapshot.selectedPaths ?? [],
    selectedSourcePaths: snapshot.selectedSourcePaths ?? snapshot.selectedPaths ?? [],
    activePath: snapshot.activePath ?? null,
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
  const pathsRef = useRef(paths);
  const treesRef = useRef(trees);
  const indexRef = useRef<FileTreeIndex>(buildFileTreeIndex([], new Map()));
  const pendingTrees = useRef<Map<string, Promise<FileTreeNode[]>>>(new Map());
  const sourceRevisionRef = useRef(0);
  const backendReadyRef = useRef(!desktopRuntime);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const localChangeVersionRef = useRef(0);
  const pendingBeforeReadyRef = useRef<AgentSourceStatePayload | null>(null);
  const lastServerStateRef = useRef<AgentSourceStatePayload>({
    paths: [], selectedPaths: [], selectedSourcePaths: [], activePath: null,
  });
  const lastQueuedFingerprintRef = useRef(sourceStateFingerprint(lastServerStateRef.current));
  const skipNextSourceSyncRef = useRef(false);
  const mountedRef = useRef(true);

  const index = useMemo(() => buildFileTreeIndex(paths, trees), [paths, trees]);
  indexRef.current = index;

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
    const nextIndex = buildFileTreeIndex(remote.paths, nextTrees);
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
  }, []);

  const removePath = useCallback((path: string) => {
    const rootKey = filePathKey(path);
    const removedKeys = new Set(
      collectSubtreeNodes(indexRef.current, path).map((node) => filePathKey(node.path)),
    );
    removedKeys.add(rootKey);

    setPaths((current) => {
      const next = current.filter((item) => filePathKey(item) !== rootKey);
      pathsRef.current = next;
      return next;
    });
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
        queueSourceCommit({ paths: [], selectedPaths: [], selectedSourcePaths: [], activePath: null }, localChangeVersionRef.current);
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
    addPaths,
    clear,
    removePath,
    toggleSelect,
    toggleExpanded,
    setSelected,
    selectAll,
    clearSelection,
    setActivePath,
    resolveLeafPaths,
  }), [
    paths, items, allPaths, selectedPaths, selectedSourcePaths, selectedKeys,
    activePath, addPaths, clear, removePath, toggleSelect, toggleExpanded,
    setSelected, selectAll, clearSelection, resolveLeafPaths,
  ]);

  return <FileListContext.Provider value={value}>{children}</FileListContext.Provider>;
}

export function useFileList(): FileListContextValue {
  const context = useContext(FileListContext);
  if (!context) throw new Error('useFileList must be used within FileListProvider');
  return context;
}
