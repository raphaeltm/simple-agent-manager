/** Pane heading and the "could not be read" line shared by the Admin Health & cost panes. */
import type { ReactNode } from 'react';

export function PaneHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-4">
      <h2 className="m-0 text-[15px] font-semibold text-fg-primary">{title}</h2>
      {right && <span className="text-xs text-fg-muted">{right}</span>}
    </div>
  );
}

export function Unavailable({ what }: { what: string }) {
  return (
    <p className="m-0 px-4 pb-4 pt-2 text-sm text-fg-muted">{what} could not be read just now.</p>
  );
}
