export type FileTreeNode = {
  path: string;
  name: string;
  isDirectory: boolean;
  parentPath: string | null;
  depth: number;
  rootPath: string;
};

export type FileTreeIndex = {
  roots: FileTreeNode[];
  nodesByKey: Map<string, FileTreeNode>;
  childrenByKey: Map<string, FileTreeNode[]>;
  loadedRootKeys: Set<string>;
};

export type TreeSelectionState = 'checked' | 'partial' | 'unchecked';

export function filePathKey(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

export function filePathName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

export function looksLikeDirectory(path: string): boolean {
  return path.endsWith('/') || path.endsWith('\\');
}

function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
    || left.path.localeCompare(right.path);
}

export function buildFileTreeIndex(
  rootPaths: string[],
  trees: ReadonlyMap<string, FileTreeNode[]>,
): FileTreeIndex {
  const roots: FileTreeNode[] = [];
  const nodesByKey = new Map<string, FileTreeNode>();
  const childrenByKey = new Map<string, FileTreeNode[]>();
  const loadedRootKeys = new Set<string>();

  for (const rootPath of rootPaths) {
    const rootKey = filePathKey(rootPath);
    const descendants = trees.get(rootKey);
    const root: FileTreeNode = {
      path: rootPath,
      name: filePathName(rootPath),
      isDirectory: looksLikeDirectory(rootPath) || descendants !== undefined,
      parentPath: null,
      depth: 0,
      rootPath,
    };
    roots.push(root);
    nodesByKey.set(rootKey, root);
    if (descendants !== undefined) loadedRootKeys.add(rootKey);

    for (const descendant of descendants ?? []) {
      const node = { ...descendant, rootPath };
      const nodeKey = filePathKey(node.path);
      nodesByKey.set(nodeKey, node);
      const parentKey = filePathKey(node.parentPath || rootPath);
      const children = childrenByKey.get(parentKey) ?? [];
      children.push(node);
      childrenByKey.set(parentKey, children);
    }
  }

  for (const children of childrenByKey.values()) children.sort(compareNodes);
  return { roots, nodesByKey, childrenByKey, loadedRootKeys };
}

export function collectSubtreeNodes(index: FileTreeIndex, path: string): FileTreeNode[] {
  const root = index.nodesByKey.get(filePathKey(path));
  if (!root) return [];
  const result: FileTreeNode[] = [];
  const visited = new Set<string>();
  const visit = (node: FileTreeNode) => {
    const key = filePathKey(node.path);
    if (visited.has(key)) return;
    visited.add(key);
    result.push(node);
    for (const child of index.childrenByKey.get(key) ?? []) visit(child);
  };
  visit(root);
  return result;
}

export function normalizeTreeSelection(
  selection: ReadonlySet<string>,
  index: FileTreeIndex,
): Set<string> {
  const next = new Set(selection);
  const directories = [...index.nodesByKey.values()]
    .filter((node) => node.isDirectory)
    .sort((left, right) => right.depth - left.depth);

  for (const directory of directories) {
    const directoryKey = filePathKey(directory.path);
    const children = index.childrenByKey.get(directoryKey) ?? [];
    if (children.length === 0) continue;
    if (children.every((child) => next.has(filePathKey(child.path)))) next.add(directoryKey);
    else next.delete(directoryKey);
  }
  return next;
}

export function toggleTreeSelection(
  selection: ReadonlySet<string>,
  path: string,
  index: FileTreeIndex,
): Set<string> {
  const node = index.nodesByKey.get(filePathKey(path));
  if (!node) return new Set(selection);
  const affected = node.isDirectory ? collectSubtreeNodes(index, path) : [node];
  const affectedKeys = affected.map((item) => filePathKey(item.path));
  const clear = affectedKeys.every((key) => selection.has(key));
  return setTreeSelection(selection, path, index, !clear);
}

export function setTreeSelection(
  selection: ReadonlySet<string>,
  path: string,
  index: FileTreeIndex,
  checked: boolean,
): Set<string> {
  const node = index.nodesByKey.get(filePathKey(path));
  if (!node) return new Set(selection);
  const affected = node.isDirectory ? collectSubtreeNodes(index, path) : [node];
  const next = new Set(selection);
  for (const item of affected) {
    const key = filePathKey(item.path);
    if (checked) next.add(key);
    else next.delete(key);
  }
  return normalizeTreeSelection(next, index);
}

export function computeTreeSelectionStates(
  index: FileTreeIndex,
  selection: ReadonlySet<string>,
): Map<string, TreeSelectionState> {
  const states = new Map<string, TreeSelectionState>();
  const visiting = new Set<string>();
  const visit = (node: FileTreeNode): TreeSelectionState => {
    const key = filePathKey(node.path);
    const cached = states.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return 'unchecked';
    visiting.add(key);

    const childStates = node.isDirectory
      ? (index.childrenByKey.get(key) ?? []).map(visit)
      : [];
    let state: TreeSelectionState;
    if (selection.has(key)) {
      state = 'checked';
    } else if (!node.isDirectory) {
      state = 'unchecked';
    } else {
      state = childStates.some((childState) => childState !== 'unchecked') ? 'partial' : 'unchecked';
    }
    visiting.delete(key);
    states.set(key, state);
    return state;
  };

  for (const root of index.roots) visit(root);
  return states;
}

function visitRoots(index: FileTreeIndex, visitor: (node: FileTreeNode) => boolean | void) {
  const visited = new Set<string>();
  const visit = (node: FileTreeNode) => {
    const key = filePathKey(node.path);
    if (visited.has(key)) return;
    visited.add(key);
    if (visitor(node) === false) return;
    for (const child of index.childrenByKey.get(key) ?? []) visit(child);
  };
  for (const root of index.roots) visit(root);
}

export function selectedProcessPaths(
  index: FileTreeIndex,
  selection: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  visitRoots(index, (node) => {
    const key = filePathKey(node.path);
    if (!node.isDirectory && selection.has(key)) result.push(node.path);
    if (node.isDirectory && node.depth === 0 && selection.has(key) && !index.loadedRootKeys.has(key)) {
      result.push(node.path);
      return false;
    }
    return true;
  });
  return result;
}

export function allProcessPaths(index: FileTreeIndex): string[] {
  const result: string[] = [];
  visitRoots(index, (node) => {
    const key = filePathKey(node.path);
    if (!node.isDirectory) result.push(node.path);
    if (node.isDirectory && node.depth === 0 && !index.loadedRootKeys.has(key)) {
      result.push(node.path);
      return false;
    }
    return true;
  });
  return result;
}

export function selectedSourcePaths(
  index: FileTreeIndex,
  selection: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  visitRoots(index, (node) => {
    const key = filePathKey(node.path);
    if (selection.has(key)) {
      result.push(node.path);
      return false;
    }
    return true;
  });
  return result;
}
