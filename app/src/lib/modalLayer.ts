import { useLayoutEffect, useSyncExternalStore } from 'react';

type ModalLayerListener = () => void;
type ModalLayerPreparationListener = () => void | Promise<unknown>;

let mountedModalLayers = 0;
let pendingModalLayerPreparations = 0;
const listeners = new Set<ModalLayerListener>();
const preparationListeners = new Set<ModalLayerPreparationListener>();

function syncPendingModalLayerClass() {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(
    'se-modal-layer-pending',
    pendingModalLayerPreparations > 0,
  );
}

function emitModalLayerChange() {
  listeners.forEach((listener) => listener());
}

export function subscribeModalLayer(listener: ModalLayerListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeModalLayerPreparation(listener: ModalLayerPreparationListener) {
  preparationListeners.add(listener);
  return () => {
    preparationListeners.delete(listener);
  };
}

export async function prepareModalLayer() {
  pendingModalLayerPreparations += 1;
  syncPendingModalLayerClass();
  const preparations = Array.from(preparationListeners, (listener) => {
    try {
      return Promise.resolve(listener());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  try {
    await Promise.allSettled(preparations);
  } finally {
    pendingModalLayerPreparations = Math.max(0, pendingModalLayerPreparations - 1);
    syncPendingModalLayerClass();
  }
}

export function isModalLayerOpen() {
  return mountedModalLayers > 0;
}

export function registerModalLayer() {
  mountedModalLayers += 1;
  emitModalLayerChange();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedModalLayers = Math.max(0, mountedModalLayers - 1);
    emitModalLayerChange();
  };
}

export function useModalLayerRegistration(active = true) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const release = registerModalLayer();
    void prepareModalLayer();
    return release;
  }, [active]);
}

export function useModalLayerOpen() {
  return useSyncExternalStore(subscribeModalLayer, isModalLayerOpen, () => false);
}
