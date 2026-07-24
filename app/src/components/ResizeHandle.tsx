// 列宽拖拽分隔条
import React, { useCallback, useEffect, useRef } from 'react';

export function ResizeHandle({
  onDelta,
}: {
  /** 水平拖动时的像素增量（向右为正） */
  onDelta: (dx: number) => void;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastX.current;
    lastX.current = e.clientX;
    if (dx !== 0) onDelta(dx);
  }, [onDelta]);

  const onUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onMove, onUp]);

  return (
    <div
      className="se-resize-handle"
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        lastX.current = e.clientX;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
    />
  );
}
