import type { UserAiBudgetResponse } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Settings2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { fetchUserAiBudget, updateUserAiBudget } from '../../lib/api';
import { formatCost, formatTokens } from './format';
import { MonthlyCapUnavailableNote } from './MonthlyCapUnavailableNote';

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
  const barColor = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent-emphasis';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums font-medium">
          {unit === '$' ? formatCost(used) : formatTokens(used)} /{' '}
          {unit === '$' ? formatCost(limit) : formatTokens(limit)}
        </span>
      </div>
      <div
        className="w-full h-2 bg-surface-hover rounded-full overflow-hidden"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
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

export function AiBudgetSettingsSection() {
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
  // Until the budget loads, assume a cap is available (how the page behaved before the flag).
  const capAvailable = budget?.monthlyCostCapAvailable !== false;
  const savedCapUsd = budget?.settings.monthlyCostCapUsd ?? null;

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
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await updateUserAiBudget({
        dailyInputTokenLimit: dailyInput ? parseInt(dailyInput, 10) : null,
        dailyOutputTokenLimit: dailyOutput ? parseInt(dailyOutput, 10) : null,
        // A cap this installation cannot enforce is cleared, never sent (the API refuses it).
        monthlyCostCapUsd: capAvailable && monthlyCap ? parseFloat(monthlyCap) : null,
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

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0 overflow-hidden">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <SectionHeading>Budget Controls</SectionHeading>
          <Body className="text-fg-muted text-sm">
            {capAvailable
              ? 'Set personal spending limits for AI proxy usage'
              : 'Set personal token limits for AI proxy usage'}
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
          {capAvailable && budget.settings.monthlyCostCapUsd !== null && (
            <BudgetBar
              label="Monthly Cost Cap"
              used={budget.monthCostUsd}
              limit={budget.settings.monthlyCostCapUsd}
              unit="$"
            />
          )}
          {!capAvailable && (
            <MonthlyCapUnavailableNote
              audience="user"
              storedCapUsd={budget.settings.monthlyCostCapUsd}
              testId="monthly-cap-unavailable"
            />
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
                  AI proxy requests will be rejected (429) until the limit resets. Daily limits
                  reset at midnight UTC.
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
            Leave fields empty to use platform defaults. Set to 0 or clear to remove a limit.
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

            {capAvailable && (
              <div>
                <label htmlFor="monthlyCap" className="block text-sm font-medium mb-1">
                  Monthly Cost Cap (USD)
                </label>
                <input
                  id="monthlyCap"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={monthlyCap}
                  onChange={(e) => setMonthlyCap(e.target.value)}
                  placeholder="No limit"
                  className="w-full px-3 py-2.5 min-h-[44px] rounded-md text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
                />
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

          {!capAvailable && savedCapUsd !== null && savedCapUsd > 0 && (
            <p className="text-fg-muted text-xs m-0" data-testid="monthly-cap-cleared-on-save">
              Saving clears your saved monthly cap of {formatCost(savedCapUsd)}, which is not
              enforced on this installation.
            </p>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-4 py-2.5 min-h-[44px] rounded-md text-sm font-medium bg-surface text-fg-muted hover:bg-surface-hover border border-border-default transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2.5 min-h-[44px] rounded-md text-sm font-medium bg-accent-emphasis text-fg-on-accent hover:bg-accent-emphasis/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving\u2026' : 'Save'}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
