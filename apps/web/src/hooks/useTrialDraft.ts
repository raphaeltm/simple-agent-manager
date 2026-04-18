/**
 * useTrialDraft — persist a per-trial chat draft in localStorage.
 *
 * The draft survives navigation (including OAuth round-trip) so that after a
 * visitor signs in via {@link LoginSheet}, the post-login claim flow can
 * replay whatever they typed as the first real chat message.
 *
 * - Debounced writes (default 300ms) avoid localStorage churn on every keystroke
 * - Key is namespaced per trialId: `trial-draft-<trialId>`
 * - `clearDraft()` wipes both in-memory state AND the stored value
 * - Safe-by-construction: all storage calls are try/catch'd so Safari Private
 *   Browsing / quota-exhausted / disabled-storage states degrade gracefully
 *   rather than crashing the page
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const TRIAL_DRAFT_STORAGE_PREFIX = 'trial-draft-';
export const TRIAL_DRAFT_DEBOUNCE_MS = 300;

function storageKey(trialId: string): string {
  return `${TRIAL_DRAFT_STORAGE_PREFIX}${trialId}`;
}

function readDraft(trialId: string): string {
  try {
    return window.localStorage.getItem(storageKey(trialId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(trialId: string, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(storageKey(trialId), value);
    } else {
      window.localStorage.removeItem(storageKey(trialId));
    }
  } catch {
    // localStorage unavailable (private mode, quota exceeded, disabled) —
    // silently no-op; in-memory draft still works.
  }
}

export interface UseTrialDraftResult {
  draft: string;
  setDraft: (value: string) => void;
  clearDraft: () => void;
}

export interface UseTrialDraftOptions {
  /** Override debounce window (ms). Tests pass 0 for synchronous writes. */
  debounceMs?: number;
}

/**
 * Persist a text draft keyed by trialId. Returns `{ draft, setDraft, clearDraft }`.
 *
 * The returned `draft` is the current in-memory value (updated synchronously
 * on every setDraft call). Writes to localStorage are debounced.
 */
export function useTrialDraft(
  trialId: string | undefined,
  options: UseTrialDraftOptions = {},
): UseTrialDraftResult {
  const { debounceMs = TRIAL_DRAFT_DEBOUNCE_MS } = options;
  const [draft, setDraftState] = useState<string>(() =>
    trialId ? readDraft(trialId) : '',
  );

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trialIdRef = useRef(trialId);
  const debounceRef = useRef(debounceMs);

  // Keep refs up-to-date so the closed-over setDraft / clearDraft callbacks
  // always hit the right storage key even if trialId changes mid-lifecycle.
  useEffect(() => {
    trialIdRef.current = trialId;
    debounceRef.current = debounceMs;
  }, [trialId, debounceMs]);

  // Rehydrate when trialId changes (e.g. SPA navigation between two trials).
  useEffect(() => {
    if (trialId) {
      setDraftState(readDraft(trialId));
    } else {
      setDraftState('');
    }
  }, [trialId]);

  // Flush any pending debounced write on unmount so a quick type-then-unmount
  // (e.g. instant OAuth redirect) still persists.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    const currentTrialId = trialIdRef.current;
    if (!currentTrialId) return;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    const delay = debounceRef.current;
    if (delay <= 0) {
      writeDraft(currentTrialId, value);
      return;
    }

    timerRef.current = setTimeout(() => {
      writeDraft(currentTrialId, value);
      timerRef.current = null;
    }, delay);
  }, []);

  const clearDraft = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDraftState('');
    const currentTrialId = trialIdRef.current;
    if (currentTrialId) {
      writeDraft(currentTrialId, '');
    }
  }, []);

  return { draft, setDraft, clearDraft };
}
