/**
 * PROTOTYPE Take A page column. The project outlet forces `max-width: 100%` on its direct
 * children, so the readable width lives on an inner element instead.
 */
import type { ReactNode } from 'react';

export function Column({ children }: { children: ReactNode }) {
  return (
    <div className="w-full min-w-0">
      <div className="mx-auto flex w-full min-w-0 max-w-[880px] flex-col gap-6 pb-16">{children}</div>
    </div>
  );
}
