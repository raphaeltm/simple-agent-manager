import { useEffect, useState } from 'react';

/** Longest delay `setTimeout` accepts; a later deadline is re-checked when this one fires. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * True once `deadline` (ISO) has passed, and flips on time while the component stays mounted, so
 * an expiry is shown without waiting for a reload or a refetch. Null or unparseable: false.
 */
export function useDeadlinePassed(deadline: string | null): boolean {
  const deadlineMs = deadline ? Date.parse(deadline) : Number.NaN;
  const [passed, setPassed] = useState(() => deadlineMs <= Date.now());
  useEffect(() => {
    if (!Number.isFinite(deadlineMs)) {
      setPassed(false);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const remaining = deadlineMs - Date.now();
      setPassed(remaining <= 0);
      if (remaining > 0) timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    check();
    return () => clearTimeout(timer);
  }, [deadlineMs]);
  return passed;
}
