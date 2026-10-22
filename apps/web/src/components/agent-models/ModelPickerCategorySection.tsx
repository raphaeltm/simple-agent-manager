import type { AgentModelCategory } from '@simple-agent-manager/shared';
import { AGENT_MODEL_CATEGORY_LABELS } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ChevronRight } from 'lucide-react';
import { memo } from 'react';

import type { ModelCategoryGroup } from './model-picker-utils';
import { ModelPickerRow } from './ModelPickerRow';

interface ModelPickerCategorySectionProps {
  group: ModelCategoryGroup;
  selected: ReadonlySet<string>;
  /** Whether this category is one of SAM's recommended-by-default categories (shown once, on the header). */
  isRecommended: boolean;
  collapsed: boolean;
  onToggleCollapsed: (category: AgentModelCategory) => void;
  onToggleModel: (id: string) => void;
  /** Turns every currently-visible (search/filter-matched) row in this category on or off at once. */
  onBulkToggle: (ids: readonly string[], turnOn: boolean) => void;
  disabled?: boolean;
}

/**
 * One category's models, collapsible, with an "N of M on" count, a single
 * "Recommended" label for default categories (not repeated per row — that's
 * category-level information, not model-specific), and a per-category bulk
 * toggle. Bulk toggle operates on `visibleModels` (what the active
 * search/filter actually shows) rather than the whole category — a user who
 * searched "speech" and clicked "All off" would not expect unrelated
 * un-searched models in the same category to also turn off.
 *
 * Memoized alongside `ModelPickerRow`; `onToggleCollapsed` takes the category
 * as a parameter so the caller can pass a single stable function instead of
 * constructing a new closure per section per render.
 */
function ModelPickerCategorySectionImpl({
  group,
  selected,
  isRecommended,
  collapsed,
  onToggleCollapsed,
  onToggleModel,
  onBulkToggle,
  disabled,
}: ModelPickerCategorySectionProps) {
  const { category, visibleModels, onCount, totalCount } = group;
  const visibleIds = visibleModels.map((model) => model.id);
  const visibleOnCount = visibleModels.filter((model) => selected.has(model.id)).length;
  const headingId = `agent-model-category-${category}`;

  return (
    <section className="grid min-w-0 gap-2 rounded-md border border-border-default bg-inset">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => onToggleCollapsed(category)}
          aria-expanded={!collapsed}
          aria-controls={headingId}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`shrink-0 text-fg-muted transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
          />
          {/* No `min-w-0` here (unlike most labels in this feature): this is a
              short, unbreakable category name (`Decision`, `Text generation`,
              ...), not arbitrary user content, so it must never be squeezed
              below its own min-content width. With `min-w-0` present, the
              sibling "N of M on" / "Recommended" / bulk-toggle buttons on the
              same unwrapped line could compress this span to near zero,
              forcing `break-words` to split the word itself mid-syllable
              (e.g. "Dec/isio/n") instead of wrapping the row. `flex-wrap` on
              the button (above) and the outer row (below) give the count,
              "Recommended", and bulk buttons somewhere to go instead. */}
          <span className="break-words text-sm font-semibold text-fg-primary">
            {AGENT_MODEL_CATEGORY_LABELS[category]}
          </span>
          <span className="shrink-0 text-xs text-fg-muted">
            {onCount} of {totalCount} on
          </span>
          {isRecommended && <span className="shrink-0 text-xs text-accent">Recommended</span>}
        </button>
        {!collapsed && visibleIds.length > 1 && (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="px-2 text-xs"
              disabled={disabled || visibleOnCount === visibleIds.length}
              onClick={() => onBulkToggle(visibleIds, true)}
            >
              All on
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="px-2 text-xs"
              disabled={disabled || visibleOnCount === 0}
              onClick={() => onBulkToggle(visibleIds, false)}
            >
              All off
            </Button>
          </div>
        )}
      </div>
      {!collapsed && (
        <ul
          id={headingId}
          className="m-0 grid min-w-0 list-none divide-y divide-border-default p-0"
        >
          {visibleModels.map((model) => (
            <ModelPickerRow
              key={model.id}
              model={model}
              checked={selected.has(model.id)}
              onToggle={onToggleModel}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export const ModelPickerCategorySection = memo(ModelPickerCategorySectionImpl);
