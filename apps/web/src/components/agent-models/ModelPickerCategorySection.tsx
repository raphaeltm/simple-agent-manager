import { AGENT_MODEL_CATEGORY_LABELS } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ChevronRight } from 'lucide-react';

import type { ModelCategoryGroup } from './model-picker-utils';
import { ModelPickerRow } from './ModelPickerRow';

interface ModelPickerCategorySectionProps {
  group: ModelCategoryGroup;
  selected: ReadonlySet<string>;
  defaultModelIds: ReadonlySet<string>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleModel: (id: string) => void;
  /** Turns every currently-visible (search/filter-matched) row in this category on or off at once. */
  onBulkToggle: (ids: readonly string[], turnOn: boolean) => void;
  disabled?: boolean;
}

/**
 * One category's models, collapsible, with an "N of M on" count and per-
 * category bulk toggle. Bulk toggle operates on `visibleModels` (what the
 * active search/filter actually shows) rather than the whole category — a
 * user who searched "speech" and clicked "All off" would not expect unrelated
 * un-searched models in the same category to also turn off.
 */
export function ModelPickerCategorySection({
  group,
  selected,
  defaultModelIds,
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
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls={headingId}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`shrink-0 text-fg-muted transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
          />
          <span className="min-w-0 break-words text-sm font-semibold text-fg-primary">
            {AGENT_MODEL_CATEGORY_LABELS[category]}
          </span>
          <span className="shrink-0 text-xs text-fg-muted">
            {onCount} of {totalCount} on
          </span>
        </button>
        {!collapsed && visibleIds.length > 1 && (
          <div className="flex shrink-0 gap-1">
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
              recommended={defaultModelIds.has(model.id)}
              onToggle={onToggleModel}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
