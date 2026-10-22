import { formatUsd } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { updateProjectAgentModelSettings } from '../../lib/api';
import {
  agentModelCatalogQueryOptions,
  agentModelQueryKeys,
  projectAgentModelSettingsQueryOptions,
} from '../../lib/query-options';
import { indexCatalog, summarizeModelSelection } from '../agent-models/model-picker-utils';
import { ModelPicker } from '../agent-models/ModelPicker';

/** Fraction of the effective budget at which the bar turns cautionary, before it is fully used. */
const NEARLY_USED_FRACTION = 0.9;

function formatResetDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function SectionShell({ headingId, children }: { headingId: string; children: ReactNode }) {
  return (
    <section className="glass-surface grid min-w-0 gap-3 rounded-lg p-4" aria-labelledby={headingId}>
      <div>
        <h2 id={headingId} className="sam-type-section-heading m-0 text-fg-primary">
          AI Model Calls
        </h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Extra Cloudflare-hosted models agents can call as tools with <code>run_ai_model</code> —
          separate from each agent&rsquo;s own chat model above. Say when to use them in your
          project instructions.
        </p>
      </div>
      {children}
    </section>
  );
}

export function ProjectAgentModelsSection({ projectId }: { projectId: string }) {
  const headingId = useId();
  const queryScope = useQueryScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enabled = Boolean(queryScope && projectId);

  const settingsQuery = useQuery({
    ...projectAgentModelSettingsQueryOptions(queryScope, projectId),
    enabled,
  });
  const catalogQuery = useQuery({ ...agentModelCatalogQueryOptions(queryScope), enabled });
  const catalogById = useMemo(() => indexCatalog(catalogQuery.data?.models ?? []), [catalogQuery.data]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');
  const budgetDirtyRef = useRef(false);
  const budgetInputRef = useRef<HTMLInputElement>(null);

  const settings = settingsQuery.data;
  const queryKey = agentModelQueryKeys.projectSettings(queryScope, projectId);
  const effectiveBudgetDefault = settings?.monthlyBudgetUsd ?? settings?.effectiveMonthlyBudgetUsd ?? 0;

  useEffect(() => {
    if (!budgetDirtyRef.current) setBudgetInput(String(effectiveBudgetDefault));
  }, [effectiveBudgetDefault]);

  const saveMutation = useMutation({
    mutationFn: (body: Parameters<typeof updateProjectAgentModelSettings>[1]) =>
      updateProjectAgentModelSettings(projectId, body),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next);
      budgetDirtyRef.current = false;
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  });

  if (!settings) {
    if (settingsQuery.isError) {
      return (
        <SectionShell headingId={headingId}>
          <Alert variant="error">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Couldn&rsquo;t load agent model settings.</span>
              <Button size="sm" variant="secondary" onClick={() => void settingsQuery.refetch()}>
                Retry
              </Button>
            </div>
          </Alert>
        </SectionShell>
      );
    }
    return (
      <SectionShell headingId={headingId}>
        <p className="m-0 text-sm text-fg-muted" role="status">
          Loading…
        </p>
      </SectionShell>
    );
  }

  // Captured as plain `number`/`string` locals (not accessed via `settings.` from inside the
  // closures below) so the handlers don't need a non-null assertion: TS does not carry the
  // `if (!settings) return` narrowing above into a nested function's closure over `settings`.
  const maxMonthlyBudgetUsd = settings.maxMonthlyBudgetUsd;
  const spent = settings.usage.spentUsd + settings.usage.reservedUsd;
  const usedFraction = settings.effectiveMonthlyBudgetUsd > 0 ? spent / settings.effectiveMonthlyBudgetUsd : spent > 0 ? 1 : 0;
  const isFullyUsed = usedFraction >= 1;
  const isNearlyUsed = usedFraction >= NEARLY_USED_FRACTION && !isFullyUsed;
  const barClass = isFullyUsed ? 'bg-danger' : isNearlyUsed ? 'bg-warning' : 'bg-accent';

  function handleSaveBudget() {
    const parsed = Number(budgetInput);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxMonthlyBudgetUsd) {
      toast.error(`Enter an amount between $0 and ${formatUsd(maxMonthlyBudgetUsd)}.`);
      return;
    }
    saveMutation.mutate(
      { monthlyBudgetUsd: parsed },
      { onSuccess: () => toast.success('Monthly limit saved') }
    );
  }

  function focusBudgetInput() {
    budgetInputRef.current?.focus();
    budgetInputRef.current?.select();
  }

  const modelsSource = settings.models === null ? "SAM's recommended defaults" : 'a custom selection';
  const usedModels = settings.usage.byModel.slice(0, 5);
  // A platform-level feature toggle outranks the per-project role check: when
  // an administrator has turned agent model calls off, every control is
  // disabled regardless of whether this caller is an owner/admin.
  const controlsEnabled = settings.canEdit && settings.featureEnabled;

  return (
    <SectionShell headingId={headingId}>
      {!settings.featureEnabled && (
        <Alert variant="info">Turned off by your SAM administrator.</Alert>
      )}

      <div className="grid min-w-0 gap-2">
        {isFullyUsed && (
          <Alert variant="warning">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                This month&rsquo;s {formatUsd(settings.effectiveMonthlyBudgetUsd)} limit is used up.
              </span>
              {controlsEnabled && (
                <Button size="sm" variant="secondary" onClick={focusBudgetInput}>
                  Raise limit
                </Button>
              )}
            </div>
          </Alert>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="text-fg-primary">
            {formatUsd(spent)} of {formatUsd(settings.effectiveMonthlyBudgetUsd)} used this month
            {isNearlyUsed && ` (${Math.round(usedFraction * 100)}%)`}
          </span>
          <span className="shrink-0 text-xs text-fg-muted">
            resets {formatResetDate(settings.usage.resetsAt)}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--sam-form-border)]">
          <div
            className={`h-full rounded-full transition-[width] ${barClass}`}
            style={{ width: `${Math.min(100, Math.max(0, usedFraction * 100))}%` }}
          />
        </div>
        {controlsEnabled ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1">
              <span className="text-xs text-fg-muted">Monthly limit (USD)</span>
              <Input
                ref={budgetInputRef}
                type="number"
                inputMode="decimal"
                min={0}
                max={settings.maxMonthlyBudgetUsd}
                step="0.01"
                value={budgetInput}
                disabled={saveMutation.isPending}
                onChange={(event) => {
                  budgetDirtyRef.current = true;
                  setBudgetInput(event.currentTarget.value);
                }}
                className="w-32"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              loading={saveMutation.isPending}
              disabled={
                saveMutation.isPending ||
                budgetInput.trim() === '' ||
                Number(budgetInput) === effectiveBudgetDefault
              }
              onClick={handleSaveBudget}
            >
              Save
            </Button>
            {settings.monthlyBudgetUsd !== null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={saveMutation.isPending}
                onClick={() =>
                  saveMutation.mutate(
                    { monthlyBudgetUsd: null },
                    { onSuccess: () => toast.success('Using the installation default limit') }
                  )
                }
              >
                Use installation default
              </Button>
            )}
          </div>
        ) : (
          settings.featureEnabled && (
            <p className="m-0 text-xs text-fg-muted">
              Only project owners and admins can change the limit.
            </p>
          )
        )}
      </div>

      <div className="grid min-w-0 gap-1">
        <h3 className="m-0 text-sm font-medium text-fg-primary">Used this month</h3>
        {usedModels.length === 0 ? (
          <p className="m-0 text-xs text-fg-muted">No model calls yet this month.</p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {usedModels.map((item) => (
              <li
                key={item.modelId}
                className="flex min-w-0 items-center justify-between gap-2 text-xs"
              >
                <span className="min-w-0 break-words text-fg-primary">
                  {catalogById.get(item.modelId)?.name ?? item.modelId}
                </span>
                <span className="shrink-0 tabular-nums text-fg-muted">
                  {item.callCount} call{item.callCount === 1 ? '' : 's'} · {formatUsd(item.spentUsd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid min-w-0 gap-2 border-t border-border-default pt-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words text-sm text-fg-primary">
            Using {modelsSource} — {summarizeModelSelection(settings.effectiveModelIds, catalogById)}
          </span>
          {controlsEnabled && (
            <div className="flex shrink-0 gap-2">
              {settings.models !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saveMutation.isPending}
                  onClick={() =>
                    saveMutation.mutate(
                      { models: null },
                      { onSuccess: () => toast.success('Reset to recommended models') }
                    )
                  }
                >
                  Reset to recommended
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={saveMutation.isPending}
                onClick={() => setPickerOpen(true)}
              >
                Change
              </Button>
            </div>
          )}
        </div>
        {!controlsEnabled && settings.featureEnabled && (
          <p className="m-0 text-xs text-fg-muted">
            Only project owners and admins can change which models agents may call.
          </p>
        )}
      </div>

      <ModelPicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        initialSelection={settings.effectiveModelIds}
        saving={saveMutation.isPending}
        onSave={async (ids) => {
          await saveMutation.mutateAsync({ models: ids });
        }}
      />
    </SectionShell>
  );
}
