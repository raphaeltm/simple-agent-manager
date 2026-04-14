import { useEffect } from 'react';

/**
 * Reference-counted scroll lock.
 *
 * Multiple components can independently request a scroll lock. The body scroll
 * is only restored when ALL active locks are released. This prevents one
 * component's cleanup from prematurely restoring scrolling while another
 * overlay is still visible.
 */
let lockCount = 0;

export function useScrollLock(isActive: boolean): void {
  useEffect(() => {
    if (!isActive) return;

    lockCount++;
    document.body.style.overflow = 'hidden';

    return () => {
      lockCount--;
      if (lockCount <= 0) {
        lockCount = 0;
        document.body.style.overflow = '';
      }
    };
  }, [isActive]);
}
