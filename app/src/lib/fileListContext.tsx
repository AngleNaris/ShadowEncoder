// 全局共享素材列表 —— 所有标签页共用导入/勾选状态
import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';

export type FileListContextValue = {
  paths: string[];
  selected: Set<string>;
  /** 当前预览/焦点文件（单击文件名） */
  activePath: string | null;
  addPaths: (p: string[]) => void;
  clear: () => void;
  removePath: (p: string) => void;
  toggleSelect: (p: string) => void;
  setSelected: (paths: string[]) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setActivePath: (p: string | null) => void;
  selectedPaths: string[];
};

const FileListContext = createContext<FileListContextValue | null>(null);

export function FileListProvider({ children }: { children: ReactNode }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelectedState] = useState<Set<string>>(() => new Set());
  const [activePath, setActivePath] = useState<string | null>(null);

  const addPaths = useCallback((incoming: string[]) => {
    setPaths((prev) => {
      const next = Array.from(new Set([...prev, ...incoming.filter(Boolean)]));
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setPaths([]);
    setSelectedState(new Set());
    setActivePath(null);
  }, []);

  const removePath = useCallback((p: string) => {
    setPaths((prev) => prev.filter((x) => x !== p));
    setSelectedState((prev) => {
      const n = new Set(prev);
      n.delete(p);
      return n;
    });
    setActivePath((cur) => (cur === p ? null : cur));
  }, []);

  const toggleSelect = useCallback((p: string) => {
    setSelectedState((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  }, []);

  const setSelected = useCallback((list: string[]) => {
    setSelectedState(new Set(list));
  }, []);

  const selectAll = useCallback(() => {
    setSelectedState(new Set(paths));
  }, [paths]);

  const clearSelection = useCallback(() => {
    setSelectedState(new Set());
  }, []);

  const selectedPaths = useMemo(
    () => paths.filter((p) => selected.has(p)),
    [paths, selected],
  );

  const value = useMemo<FileListContextValue>(
    () => ({
      paths,
      selected,
      activePath,
      addPaths,
      clear,
      removePath,
      toggleSelect,
      setSelected,
      selectAll,
      clearSelection,
      setActivePath,
      selectedPaths,
    }),
    [
      paths, selected, activePath, addPaths, clear, removePath,
      toggleSelect, setSelected, selectAll, clearSelection, selectedPaths,
    ],
  );

  return <FileListContext.Provider value={value}>{children}</FileListContext.Provider>;
}

export function useFileList(): FileListContextValue {
  const ctx = useContext(FileListContext);
  if (!ctx) throw new Error('useFileList must be used within FileListProvider');
  return ctx;
}
