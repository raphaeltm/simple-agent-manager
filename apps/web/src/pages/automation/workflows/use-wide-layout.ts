import { useSyncExternalStore } from 'react';

/** The width at which the run page puts step details beside the steps (Tailwind `lg`). */
const WIDE_QUERY = '(min-width: 1024px)';

function subscribe(callback: () => void) {
  if (typeof window === 'undefined') return () => undefined;
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

const snapshot = () => typeof window !== 'undefined' && window.matchMedia(WIDE_QUERY).matches;

/** True when the run page has room for a side column. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
