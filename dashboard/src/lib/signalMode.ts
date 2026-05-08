import { useEffect, useState } from 'preact/hooks';

const STORAGE_KEY = 'memesh.signalMode';
const EVENT = 'memesh:signal-mode-changed';

/**
 * Default-ON: a fresh install has 91% of memories as `session_keypoint`
 * + `commit` (auto-captured noise). Showing them by default buries the
 * 9% high-signal content the dashboard exists to surface.
 */
const DEFAULT_ON = true;

function readStored(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* private mode — fall through to default */
  }
  return DEFAULT_ON;
}

function writeStored(value: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* private mode */ }
}

/**
 * Single source of truth for the global Signal Mode toggle. Returns
 * `[value, setValue]` like useState. Subscribes to a custom event so
 * components mounted in different tabs / panels stay in sync without
 * prop-drilling: when one component flips the mode, every consumer
 * re-renders on the next microtask.
 */
export function useSignalMode(): [boolean, (next: boolean) => void] {
  const [value, setValueLocal] = useState<boolean>(readStored);

  useEffect(() => {
    function handler(e: Event) {
      // Re-read storage on the off-chance two tabs of the dashboard
      // are open and one wrote — the `storage` event fires only for
      // OTHER tabs, so we listen for our same-tab custom event AND
      // the cross-tab storage event together.
      const detail = (e as CustomEvent<{ value: boolean }>).detail;
      if (detail && typeof detail.value === 'boolean') {
        setValueLocal(detail.value);
      } else {
        setValueLocal(readStored());
      }
    }
    function storageHandler(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setValueLocal(readStored());
    }
    window.addEventListener(EVENT, handler);
    window.addEventListener('storage', storageHandler);
    return () => {
      window.removeEventListener(EVENT, handler);
      window.removeEventListener('storage', storageHandler);
    };
  }, []);

  function setValue(next: boolean) {
    writeStored(next);
    setValueLocal(next);
    // Notify all other consumers in this tab.
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { value: next } }));
  }

  return [value, setValue];
}
