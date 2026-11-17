import type { UserAiBudgetResponse } from '@simple-agent-manager/shared';
import { Body, Button, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Settings2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { fetchUserAiBudget, updateUserAiBudget } from '../../lib/api';
import { formatCost, formatTokens } from './format';

// ---------------------------------------------------------------------------
// Budget Utilization Bar
// ---------------------------------------------------------------------------

function BudgetBar({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  unit: string;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const format = unit === '$' ? formatCost : formatTokens;
  const barColor = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent-emphasis';

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap justify-between gap-x-2 text-sm">
        <span className="text-fg-muted min-w-0 break-words">{label}</span>
        <span className="tabular-nums font-medium">
          {format(used)} / {format(limit)}
        </span>
      </div>
      <div
        className="w-full h-2 bg-surface-hover rounded-full overflow-hidden"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        aria-valuetext={`${format(used)} of ${format(limit)} (${Math.round(pct)}%)`}
      >
        <div
          className={`h-full ${barColor} rounded-full transition-all`}
          style={{ width: `${Math.max(pct > 0 ? 1 : 0, pct)}%` }}
        />
      </div>
      <div className="text-right">
        <span className="sam-type-caption text-fg-muted tabular-nums">{Math.round(pct)}%</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget Settings Section
// ---------------------------------------------------------------------------

export function BudgetSettingsSection() {
  const [budget, setBudget] = useState<UserAiBudgetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [editing, setEditing] = useState(false);

  // Form state
  const [dailyInput, setDailyInput] = useState('');
  const [dailyOutput, setDailyOutput] = useState('');
  const [monthlyCap, setMonthlyCap] = useState('');
  const [alertThreshold, setAlertThreshold] = useState('80');

  const loadBudget = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchUserAiBudget();
      setBudget(res);
      // Populate form with current settings
      setDailyInput(res.settings.dailyInputTokenLimit?.toString() ?? '');
      setDailyOutput(res.settings.dailyOutputTokenLimit?.toString() ?? '');
      setMonthlyCap(res.settings.monthlyCostCapUsd?.toString() ?? '');
      setAlertThreshold(res.settings.alertThresholdPercent.toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load budget');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBudget();
  }, [loadBudget]);

  async function handleSave() {
    // Where caps cannot be priced the field is hidden and any saved cap is not enforced, so it is
    // cleared rather than sent (the API refuses a cap there).
    const monthlyCostCapUsd =
      budget?.monthlyCostCap.available !== false && monthlyCap ? parseFloat(monthlyCap) : null;
    const ceiling = budget?.monthlyCostCap.ceilingUsd ?? null;
    if (monthlyCostCapUsd !== null && ceiling !== null && monthlyCostCapUsd > ceiling) {
      setError(
        `Your monthly cap can't be above your administrator's limit of ${formatCost(ceiling)}.`
      );
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await updateUserAiBudget({
        dailyInputTokenLimit: dailyInput ? parseInt(dailyInput, 10) : null,
        dailyOutputTokenLimit: dailyOutput ? parseInt(dailyOutput, 10) : null,
        monthlyCostCapUsd,
        alertThresholdPercent: parseInt(alertThreshold, 10) || 80,
      });
      setSuccess(true);
      setEditing(false);
      // Reload to get updated utilization
      await loadBudget();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save budget');
    } finally {
      setSaving(false);
    }
  }

  const cap = budget?.monthlyCostCap;
  const ceilingUsd = cap?.ceilingUsd ?? null;
  // Equal caps remain administrator-bound: removing the personal cap cannot raise the limit.
  const savedCapUsd = budget?.settings.monthlyCostCapUsd ?? null;
  const capFromCeiling = ceilingUsd !== null && (savedCapUsd === null || savedCapUsd >= ceilingUsd);
  const monthlyExceeded = (budget?.utilization.monthlyCostPercent ?? 0) >= 100;

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0 overflow-hidden" data-testid="budget-settings-section">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <SectionHeading>Budget Controls</SectionHeading>
          <Body className="text-fg-muted text-sm">
            Set personal spending limits for AI proxy usage
          </Body>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-md text-sm font-medium min-h-[44px] bg-surface text-fg-muted hover:bg-surface-hover border border-border-default transition-colors"
          >
            <Settings2 className="w-4 h-4" aria-hidden="true" />
            Configure
          </button>
        )}
      </div>

      {error && (
        <Card className="p-4">
          <Body className="text-danger-fg text-sm m-0">{error}</Body>
        </Card>
      )}

      {success && (
        <Card className="p-4 border-success/30 bg-success/5">
          <Body className="text-success text-sm m-0">Budget settings saved.</Body>
        </Card>
      )}

      {/* Utilization bars (always visible when budget data is available) */}
      {budget && (
        <Card className="p-4 space-y-3">
          <CardTitle className="mb-1">Current Utilization</CardTitle>
          <BudgetBar
            label="Daily Input Tokens"
            used={budget.dailyUsage.inputTokens}
            limit={budget.effectiveLimits.dailyInputTokenLimit}
            unit="tokens"
          />
          <BudgetBar
            label="Daily Output Tokens"
            used={budget.dailyUsage.outputTokens}
            limit={budget.effectiveLimits.dailyOutputTokenLimit}
            unit="tokens"
          />
          {cap?.effectiveCapUsd != null && (
            <BudgetBar
              label={capFromCeiling ? 'Monthly Cost Cap (administrator limit)' : 'Monthly Cost Cap'}
              used={budget.monthCostUsd}
              limit={cap.effectiveCapUsd}
              unit="$"
            />
          )}
          {cap && !cap.available && (
            <p className="text-fg-muted text-xs m-0" data-testid="monthly-cap-unavailable">
              Monthly cost caps are turned off because AI spend can&apos;t be priced on this server.
              Daily token limits still apply.
            </p>
          )}
          {budget.exceeded && (
            <div
              className="flex items-start gap-2 p-3 bg-danger-tint rounded-md border border-danger/30"
              role="alert"
              aria-live="assertive"
            >
              <ShieldAlert
                className="w-4 h-4 text-danger flex-shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div>
                <Body className="text-danger text-sm font-medium m-0">Budget Exceeded</Body>
                <Body className="text-fg-muted text-sm mt-1 m-0">
                  {monthlyExceeded
                    ? `You reached the monthly cost limit${capFromCeiling ? ' set by your administrator' : ''}. AI requests are paused until it resets on the 1st (UTC).`
                    : 'AI requests are paused until the limit resets. Daily limits reset at midnight UTC.'}
                </Body>
              </div>
            </div>
          )}
          {!budget.isCustom && !budget.exceeded && (
            <Body className="text-fg-muted text-xs m-0">
              Using platform defaults. Configure custom limits below.
            </Body>
          )}
        </Card>
      )}

      {/* Settings form (visible when editing) */}
      {editing && (
        <Card className="p-4 space-y-4">
          <CardTitle>Budget Settings</CardTitle>
          <Body className="text-fg-muted text-sm m-0">
            Leave fields empty to use platform defaults.
            {cap?.available !== false &&
              (ceilingUsd === null
                ? ' Clear the monthly cap to remove it.'
                : ' The monthly cap can be lowered, not removed.')}
          </Body>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="dailyInput" className="block text-sm font-medium mb-1">
                Daily Input Token Limit
              </label>
              <input
                id="dailyInput"
                type="number"
                min="1000"
                step="1000"
                value={dailyInput}
                onChange={(e) => setDailyInput(e.target.value)}
                placeholder={
                  budget?.effectiveLimits.dailyInputTokenLimit.toLocaleString() ?? '500,000'
                }
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
              />
            </div>

            <div>
              <label htmlFor="dailyOutput" className="block text-sm font-medium mb-1">
                Daily Output Token Limit
              </label>
              <input
                id="dailyOutput"
                type="number"
                min="1000"
                step="1000"
                value={dailyOutput}
                onChange={(e) => setDailyOutput(e.target.value)}
                placeholder={
                  budget?.effectiveLimits.dailyOutputTokenLimit.toLocaleString() ?? '200,000'
                }
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
              />
            </div>

            {cap?.available !== false && (
              <div>
                <label htmlFor="monthlyCap" className="block text-sm font-medium mb-1">
                  Monthly Cost Cap (USD)
                </label>
                <input
                  id="monthlyCap"
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={ceilingUsd ?? undefined}
                  value={monthlyCap}
                  onChange={(e) => setMonthlyCap(e.target.value)}
                  placeholder={ceilingUsd !== null ? 'Administrator limit' : 'No limit'}
                  aria-describedby={ceilingUsd !== null ? 'monthlyCapCeiling' : undefined}
                  className="w-full px-3 py-2.5 min-h-[44px] rounded-md text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
                />
                {ceilingUsd !== null && (
                  <p id="monthlyCapCeiling" className="text-fg-muted text-xs mt-1 mb-0">
                    Your administrator limits everyone to {formatCost(ceilingUsd)} a month. You can
                    set a lower cap; leaving it empty uses that limit.
                    {savedCapUsd !== null && savedCapUsd > ceilingUsd && (
                      <>
                        {' '}
                        Your saved cap of {formatCost(savedCapUsd)} is above it, so the limit
                        applies.
                      </>
                    )}
                  </p>
                )}
              </div>
            )}

            <div>
              <label htmlFor="alertThreshold" className="block text-sm font-medium mb-1">
                Alert Threshold (%)
              </label>
              <input
                id="alertThreshold"
                type="number"
                min="1"
                max="100"
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(e.target.value)}
                placeholder="80"
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
              />
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="raised" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {/* Shared Button: the old local `bg-accent-emphasis` is not a defined token, so Save
                had no background and was unreadable in the light theme. */}
            <Button type="button" variant="accent" onClick={handleSave} loading={saving}>
              Save
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
