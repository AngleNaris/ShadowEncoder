export const MATERIAL_DROP_EVENT = 'shadowencoder:material-drop';
export type MaterialDrop = { path: string; x: number; y: number };

// Windows native file drop intercepts HTML5 drags; keep internal drags on pointers.
export function startMaterialDrag(event: PointerEvent, path: string): () => void {
  const badge = document.createElement('div');
  badge.className = 'se-material-drag-preview';
  badge.textContent = path.split(/[/\\]/).pop() || path;
  let moved = false;
  const cleanup = () => {
    badge.remove();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', drop);
    window.removeEventListener('pointercancel', cleanup);
    window.removeEventListener('blur', cleanup);
    window.removeEventListener('keydown', key);
  };
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    if (!moved && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 6) return;
    moved = true;
    if (!badge.isConnected) document.body.append(badge);
    badge.style.left = `${Math.min(next.clientX + 12, window.innerWidth - badge.offsetWidth)}px`;
    badge.style.top = `${Math.min(next.clientY + 12, window.innerHeight - badge.offsetHeight)}px`;
  };
  const drop = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    cleanup();
    if (moved) window.dispatchEvent(new CustomEvent<MaterialDrop>(MATERIAL_DROP_EVENT, {
      detail: { path, x: next.clientX, y: next.clientY },
    }));
  };
  const key = (next: KeyboardEvent) => { if (next.key === 'Escape') cleanup(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', drop);
  window.addEventListener('pointercancel', cleanup);
  window.addEventListener('blur', cleanup);
  window.addEventListener('keydown', key);
  return cleanup;
}
