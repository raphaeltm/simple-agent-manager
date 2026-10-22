import type { AgentModelCategory } from '@simple-agent-manager/shared';
import { Alert, Button, Input, Skeleton, useModalInteraction } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useQueryScope } from '../../hooks/useQueryScope';
import { agentModelCatalogQueryOptions } from '../../lib/query-options';
import {
  findStaleModelIds,
  groupModelsByCategory,
  indexCatalog,
  setsHaveSameMembers,
  summarizeModelSelection,
  toggleSetMember,
} from './model-picker-utils';
import { ModelPickerCategorySection } from './ModelPickerCategorySection';

export interface ModelPickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Seeded into the draft every time the picker transitions from closed to open. */
  initialSelection: readonly string[];
  onSave: (modelIds: string[]) => Promise<void> | void;
  saving?: boolean;
  title?: string;
}

function filterButtonClass(active: boolean): string {
  return `px-3 py-1.5 text-xs font-medium transition-colors ${
    active ? 'bg-accent-tint text-accent' : 'bg-transparent text-fg-muted hover:text-fg-primary'
  }`;
}

/**
 * The one canonical model picker, reused by the project Agents settings tab
 * and the profile/skill "Custom" override field
 * (`.claude/rules/24-no-duplicate-ui-controls.md`). Fetches the catalog
 * itself so every caller gets the same loading skeleton, error+retry, and
 * stale-id handling for free.
 *
 * Renders as a full-height sheet on mobile and a centered 85vh panel on
 * larger screens, with a sticky search/filter header and a sticky
 * save/discard footer so a long scrolled list never hides the primary
 * actions (`.claude/rules/04`: avoid ad-hoc visual languages — reuses the
 * same glass/overlay tokens as `packages/ui`'s `Dialog`, which this cannot
 * be built from because it has no sticky-footer slot and this task's scope
 * does not include editing `packages/ui`).
 */
export function ModelPicker({
  isOpen,
  onClose,
  initialSelection,
  onSave,
  saving = false,
  title = 'Choose callable models',
}: ModelPickerProps) {
  const queryScope = useQueryScope();
  const catalogQuery = useQuery({
    ...agentModelCatalogQueryOptions(queryScope),
    enabled: isOpen && Boolean(queryScope),
  });

  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(initialSelection));
  const [query, setQuery] = useState('');
  const [onlyOn, setOnlyOn] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<AgentModelCategory>>(new Set());
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reseed only on the closed -> open transition. `initialSelection` is read
  // through a ref so a background refetch of the settings query that seeded
  // it (while the picker is open) cannot silently revert in-progress edits —
  // the same hazard `ProfileFormDialog` documents for its populate effect.
  const initialSelectionRef = useRef(initialSelection);
  useEffect(() => {
    initialSelectionRef.current = initialSelection;
  }, [initialSelection]);
  useEffect(() => {
    if (!isOpen) return;
    setDraft(new Set(initialSelectionRef.current));
    setQuery('');
    setOnlyOn(false);
    setCollapsed(new Set());
    setConfirmingDiscard(false);
    setSaveError(null);
  }, [isOpen]);

  const isDirty = !setsHaveSameMembers(draft, new Set(initialSelectionRef.current));

  function requestClose() {
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
      return;
    }
    if (isDirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }

  useModalInteraction({ enabled: isOpen, modalRef: panelRef, onEscape: requestClose });

  // All hooks above this line run on every render regardless of `isOpen` —
  // the early return below must stay below every hook call (Rules of Hooks).
  // `models` is memoized so the `[]` fallback is a stable instance rather than
  // a fresh array every render while `catalogQuery.data` is still undefined.
  const models = useMemo(() => catalogQuery.data?.models ?? [], [catalogQuery.data]);
  const catalogById = useMemo(() => indexCatalog(models), [models]);
  const defaultModelIds = useMemo(
    () => new Set(catalogQuery.data?.defaultModelIds ?? []),
    [catalogQuery.data]
  );
  const staleIds = useMemo(() => findStaleModelIds([...draft], catalogById), [draft, catalogById]);
  const groups = useMemo(
    () => groupModelsByCategory(models, draft, query, onlyOn),
    [models, draft, query, onlyOn]
  );
  const renderableGroups = groups.filter((group) => group.visibleModels.length > 0);

  function handleToggleModel(id: string) {
    setDraft((prev) => toggleSetMember(prev, id));
  }

  function handleBulkToggle(ids: readonly string[], turnOn: boolean) {
    setDraft((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (turnOn) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function handleRemoveStale(id: string) {
    setDraft((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function handleToggleCollapsed(category: AgentModelCategory) {
    setCollapsed((prev) => toggleSetMember(prev, category));
  }

  async function handleSave() {
    setSaveError(null);
    try {
      await onSave([...draft]);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save models');
    }
  }

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={panelRef}
      tabIndex={-1}
      data-sam-modal-root=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-dialog-backdrop flex items-stretch justify-center sm:items-center sm:p-4"
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop overlay; keyboard dismiss handled by Escape via useModalInteraction */}
      <div
        className="fixed inset-0 bg-overlay glass-backdrop-dim transition-opacity duration-150 ease-in-out"
        onClick={requestClose}
      />
      <div
        className="glass-panel-container glass-composited relative z-10 flex h-full w-full min-w-0 flex-col overflow-hidden glass-modal shadow-overlay sm:h-[85vh] sm:max-w-2xl sm:rounded-lg"
      >
        <div className="flex-shrink-0 border-b border-border-default px-4 py-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={headingId} className="m-0 text-lg font-semibold text-fg-primary">
                {title}
              </h2>
              <p className="m-0 mt-0.5 text-xs text-fg-muted">
                Extra Cloudflare-hosted models agents can call as tools — not the agent&rsquo;s own
                chat model. Uses the <code>run_ai_model</code> tool.
              </p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close"
              className="shrink-0 rounded-md p-1.5 text-fg-muted hover:bg-[var(--sam-form-focus-inset)] hover:text-fg-primary"
            >
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
            <Input
              type="search"
              aria-label="Search models"
              placeholder="Search by name, author, or category"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="min-w-0 flex-1 [&::-webkit-search-cancel-button]:appearance-none"
            />
            <div
              role="group"
              aria-label="Filter"
              className="flex shrink-0 overflow-hidden rounded-md border border-border-default"
            >
              <button
                type="button"
                aria-pressed={!onlyOn}
                onClick={() => setOnlyOn(false)}
                className={filterButtonClass(!onlyOn)}
              >
                All
              </button>
              <button
                type="button"
                aria-pressed={onlyOn}
                onClick={() => setOnlyOn(true)}
                className={filterButtonClass(onlyOn)}
              >
                On only
              </button>
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain p-3">
          {confirmingDiscard && (
            <Alert variant="warning" className="mb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Discard unsaved changes?</span>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setConfirmingDiscard(false)}>
                    Keep editing
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirmingDiscard(false);
                      onClose();
                    }}
                  >
                    Discard
                  </Button>
                </div>
              </div>
            </Alert>
          )}
          {saveError && (
            <Alert variant="error" className="mb-3" onDismiss={() => setSaveError(null)}>
              {saveError}
            </Alert>
          )}

          {catalogQuery.isLoading && !catalogQuery.data ? (
            <div className="grid gap-2" role="status" aria-label="Loading models">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} height="4.5rem" borderRadius="var(--sam-radius-md)" />
              ))}
            </div>
          ) : catalogQuery.isError ? (
            <Alert variant="error">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Couldn&rsquo;t load the model list.</span>
                <Button size="sm" variant="secondary" onClick={() => void catalogQuery.refetch()}>
                  Retry
                </Button>
              </div>
            </Alert>
          ) : (
            <div className="grid min-w-0 gap-3">
              {staleIds.length > 0 && (
                <section className="grid gap-2 rounded-md border border-warning/40 bg-warning-tint p-3">
                  <h3 className="m-0 text-sm font-semibold text-fg-primary">No longer available</h3>
                  <p className="m-0 text-xs text-fg-muted">
                    These were selected but Cloudflare no longer offers them.
                  </p>
                  <ul className="m-0 grid list-none gap-1.5 p-0">
                    {staleIds.map((id) => (
                      <li
                        key={id}
                        className="flex min-w-0 items-center justify-between gap-2 text-sm text-fg-primary"
                      >
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{id}</span>
                        <Button size="sm" variant="ghost" onClick={() => handleRemoveStale(id)}>
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {renderableGroups.length === 0 ? (
                <p className="m-0 py-6 text-center text-sm text-fg-muted">
                  {query ? `No models match "${query}".` : 'No models are on.'}
                </p>
              ) : (
                renderableGroups.map((group) => (
                  <ModelPickerCategorySection
                    key={group.category}
                    group={group}
                    selected={draft}
                    defaultModelIds={defaultModelIds}
                    collapsed={collapsed.has(group.category)}
                    onToggleCollapsed={() => handleToggleCollapsed(group.category)}
                    onToggleModel={handleToggleModel}
                    onBulkToggle={handleBulkToggle}
                    disabled={saving}
                  />
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-border-default px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words text-sm text-fg-muted">
              {summarizeModelSelection([...draft], catalogById)}
            </span>
            {/*
             * The footer button bypasses `requestClose`'s confirm banner on
             * purpose: its own label ("Discard") already states the
             * consequence, so a second confirmation would just be friction.
             * The banner exists for the AMBIGUOUS dismiss gestures above (X,
             * Escape, backdrop click) that carry no such label. Both footer
             * actions are disabled while the banner is up so the page never
             * shows two differently-scoped "Discard" buttons at once.
             */}
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onClose}
                disabled={saving || confirmingDiscard}
              >
                {isDirty ? 'Discard' : 'Close'}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                loading={saving}
                disabled={saving || !isDirty || confirmingDiscard}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
