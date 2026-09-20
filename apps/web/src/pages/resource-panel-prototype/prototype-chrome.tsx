/**
 * Shared prototype chrome: the viewport-height scroll wrapper every prototype
 * page needs (the app shell does not scroll at html/body level — see
 * `apps/web/.claude/rules/37-prototype-development.md`) and the toolbar that
 * switches datasets.
 *
 * The toolbar is in normal flow rather than absolutely positioned. A floating
 * control would have to be measured against the tool rail and the open panel at
 * every viewport to prove it never overlaps either; in flow that is true by
 * construction.
 */
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { DATASET_IDS, DATASET_LABEL, type PrototypeDatasetId } from './mock-data';

export const PROTOTYPE_INDEX_PATH = '/prototype/resource-panel';

/** Outermost element of every prototype page. */
export function PrototypeFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div style={{ height: '100dvh', overflow: 'auto' }} className="bg-canvas text-fg-primary">
      {children}
    </div>
  );
}

export function PrototypeToolbar({
  variantLabel,
  dataset,
  onDatasetChange,
}: Readonly<{
  variantLabel: string;
  dataset: PrototypeDatasetId;
  onDatasetChange: (id: PrototypeDatasetId) => void;
}>) {
  return (
    <div
      data-testid="prototype-toolbar"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-default bg-inset px-2 py-1.5"
    >
      <Link
        to={PROTOTYPE_INDEX_PATH}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-fg-muted no-underline transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Variants
      </Link>
      <span className="shrink-0 text-xs font-semibold text-fg-primary">
        <span className="sm:hidden">{variantLabel.split(' ')[0]}</span>
        <span className="hidden sm:inline">{variantLabel}</span>
      </span>
      <div
        role="group"
        aria-label="Mock dataset"
        className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-border-default p-0.5"
      >
        {DATASET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={dataset === id}
            onClick={() => onDatasetChange(id)}
            data-testid={`prototype-dataset-${id}`}
            className={`h-10 min-w-11 cursor-pointer rounded-md border-none px-2 text-[11px] font-medium transition-colors sm:px-2.5 sm:text-xs ${
              dataset === id
                ? 'bg-accent text-fg-on-accent'
                : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
            }`}
          >
            {DATASET_LABEL[id]}
          </button>
        ))}
      </div>
    </div>
  );
}
