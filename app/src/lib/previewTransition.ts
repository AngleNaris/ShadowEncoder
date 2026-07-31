export const PREVIEW_FADE_MS = 160;

type PreviewTransitionListener = () => void | Promise<unknown>;

const listeners = new Set<PreviewTransitionListener>();

export function subscribePreviewTransition(listener: PreviewTransitionListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function preparePreviewTransition() {
  const preparations = Array.from(listeners, (listener) => {
    try {
      return Promise.resolve(listener());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  await Promise.allSettled(preparations);
}
