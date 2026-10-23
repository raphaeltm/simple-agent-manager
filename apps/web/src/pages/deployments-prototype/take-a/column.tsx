/**
 * PROTOTYPE Take A page column. The project outlet forces `max-width: 100%` on its direct
 * children, so the readable width lives on an inner element instead.
 *
 * On wide screens an optional aside holds "On this page": every section with a live
 * summary, so the long single scroll can be read at a glance and jumped through.
 */
import type { ReactNode } from 'react';

import { type Tone, TONE_COLOR } from '../model';

export function Column({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="w-full min-w-0">
      <div
        className={`mx-auto grid w-full min-w-0 grid-cols-1 gap-8 pb-16 ${
          aside ? 'max-w-[1120px] lg:grid-cols-[minmax(0,1fr)_208px]' : 'max-w-[880px]'
        }`}
      >
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
        {aside && <div className="hidden lg:block">{aside}</div>}
      </div>
    </div>
  );
}

export interface IndexEntry {
  id: string;
  label: string;
  value?: string;
  tone?: Tone;
}

export function OnThisPage({ entries }: { entries: IndexEntry[] }) {
  return (
    <nav aria-label="On this page" className="sticky top-4 flex flex-col gap-1 pt-[52px]">
      <span className="px-3 pb-2 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">On this page</span>
      {entries.map((entry) => (
        <a
          key={entry.id}
          href={`#${entry.id}`}
          onClick={(event) => {
            event.preventDefault();
            document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="flex min-h-10 items-center justify-between gap-3 rounded-lg px-3 text-[13px] text-fg-muted no-underline hover:bg-surface-hover hover:text-fg-primary"
        >
          <span>{entry.label}</span>
          {entry.value && (
            <span
              className="shrink-0 font-semibold tabular-nums"
              style={{ color: entry.tone ? TONE_COLOR[entry.tone] : 'var(--sam-color-fg-primary)' }}
            >
              {entry.value}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
