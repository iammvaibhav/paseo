type PrefillListener = (payload: { draftKey: string; text: string }) => void;
const prefillListeners = new Set<PrefillListener>();

export function emitComposerPrefill(payload: { draftKey: string; text: string }): void {
  for (const listener of prefillListeners) {
    try {
      listener(payload);
    } catch {
      // ignore
    }
  }
}

export function subscribeComposerPrefill(listener: PrefillListener): () => void {
  prefillListeners.add(listener);
  return () => {
    prefillListeners.delete(listener);
  };
}
