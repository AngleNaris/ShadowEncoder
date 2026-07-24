// 三列布局列宽状态（素材 | 参数 | 结果）
import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export type ColumnLayoutValue = {
  wFiles: number;
  wParams: number;
  setWFiles: (fn: number | ((n: number) => number)) => void;
  setWParams: (fn: number | ((n: number) => number)) => void;
  resizeFiles: (dx: number) => void;
  resizeParams: (dx: number) => void;
};

const ColumnLayoutContext = createContext<ColumnLayoutValue | null>(null);

const FILES_MIN = 200;
const FILES_MAX = 520;
const PARAMS_MIN = 260;
const PARAMS_MAX = 720;

export function ColumnLayoutProvider({ children }: { children: ReactNode }) {
  const [wFiles, setWFiles] = useState(280);
  const [wParams, setWParams] = useState(400);

  const resizeFiles = useCallback((dx: number) => {
    setWFiles((w) => clamp(w + dx, FILES_MIN, FILES_MAX));
  }, []);

  const resizeParams = useCallback((dx: number) => {
    setWParams((w) => clamp(w + dx, PARAMS_MIN, PARAMS_MAX));
  }, []);

  const value = useMemo(
    () => ({ wFiles, wParams, setWFiles, setWParams, resizeFiles, resizeParams }),
    [wFiles, wParams, resizeFiles, resizeParams],
  );

  return (
    <ColumnLayoutContext.Provider value={value}>{children}</ColumnLayoutContext.Provider>
  );
}

export function useColumnLayout(): ColumnLayoutValue {
  const ctx = useContext(ColumnLayoutContext);
  if (!ctx) throw new Error('useColumnLayout must be used within ColumnLayoutProvider');
  return ctx;
}
