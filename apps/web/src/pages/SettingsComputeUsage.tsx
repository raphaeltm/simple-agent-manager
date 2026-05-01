import type {
  ComputeUsageResponse,
  UserAiBudgetResponse,
  UserAiUsageResponse,
  UserQuotaStatusResponse,
} from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Bot, Clock, Cpu, Gauge, Key, Server, Settings2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { fetchComputeUsage, fetchUserAiBudget, fetchUserAiUsage, fetchUserQuotaStatus, updateUserAiBudget } from '../lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVcpuHours(hours: number): string {
  if (hours < 0.01) return '< 0.01';
  return hours.toFixed(2);
}

function formatDuration(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const hours = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '< $0.01';
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function truncateModel(model: string, max = 32): string {
  if (model.length <= max) return model;
  return model.slice(0, max - 1) + '\u2026';
}

// ---------------------------------------------------------------------------
// AI Usage Section
// ---------------------------------------------------------------------------

const AI_PERIODS = [
  { value: 'current-month', label: 'This Month' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
] as const;

function AiUsageSection() {
  const [data, setData] = useState<UserAiUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState('current-month');

  const loadAiUsage = useCallback(async (p: string) => {
    try {
      setError(null);
      setLoading(true);
      const res = await fetchUserAiUsage(p);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAiUsage(period);
  }, [loadAiUsage, period]);

  function handlePeriodChange(p: string) {
    setPeriod(p);
  }

  return (
    <div className="space-y-4 min-w-0 overflow-hidden">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <SectionHeading>LLM Usage</SectionHeading>
          <Body className="text-fg-muted text-sm">
            SAM-managed AI Gateway traffic only
          </Body>
        </div>
        <div className="flex gap-1 flex-wrap">
          {AI_PERIODS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={period === opt.value}
              onClick={() => handlePeriodChange(opt.value)}
              className={`px-3 py-2.5 rounded-md text-sm font-medium transition-colors min-h-[44px] ${
                period === opt.value
                  ? 'bg-accent-emphasis text-fg-on-accent'
                  : 'bg-surface text-fg-muted hover:bg-surface-hover border border-border-default'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}

      {error && (
        <Card className="p-4">
          <Body className="text-danger-fg text-sm m-0">{error}</Body>
        </Card>
      )}

      {data && !loading && data.totalRequests === 0 && (
        <Card className="p-8 text-center">
          <Bot className="w-10 h-10 mx-auto mb-3 text-fg-muted" aria-hidden="true" />
          <Body className="text-fg-muted font-medium">No LLM usage yet</Body>
          <Body className="text-fg-muted text-sm mt-1">
            Usage from SAM-managed AI Gateway requests will appear here.
            Direct BYOK or non-Gateway usage is not tracked.
          </Body>
        </Card>
      )}

      {data && data.totalRequests > 0 && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatCost(data.totalCostUsd)}</p>
              <p className="sam-type-caption text-fg-muted m-0">Total Cost</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{data.totalRequests.toLocaleString()}</p>
              <p className="sam-type-caption text-fg-muted m-0">Requests</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatTokens(data.totalInputTokens)}</p>
              <p className="sam-type-caption text-fg-muted m-0">Input Tokens</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatTokens(data.totalOutputTokens)}</p>
              <p className="sam-type-caption text-fg-muted m-0">Output Tokens</p>
            </Card>
          </div>

          {/* Model Breakdown */}
          {data.byModel.length > 0 && (
            <Card className="p-4 overflow-hidden min-w-0">
              <CardTitle className="mb-3">By Model</CardTitle>
              <div>
                {data.byModel.map((m) => (
                  <div
                    key={m.model}
                    className="flex flex-col gap-1 py-2.5 border-b border-border-default last:border-0 min-w-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="font-mono text-sm truncate min-w-0 flex-1" title={m.model}>
                      {truncateModel(m.model)}
                    </span>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums text-fg-muted">
                      <span>{formatCost(m.costUsd)}</span>
                      <span>{m.requests.toLocaleString()} req</span>
                      <span>{formatTokens(m.inputTokens)} in</span>
                      <span>{formatTokens(m.outputTokens)} out</span>
                      {m.cachedRequests > 0 && <span className="text-accent-fg">{m.cachedRequests} cached</span>}
                      {m.errorRequests > 0 && <span className="text-danger-fg" title={`${m.errorRequests} error requests`}>{m.errorRequests} err</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Daily Trend */}
          {data.byDay.length > 0 && (
            <Card className="p-4 overflow-hidden min-w-0">
              <CardTitle className="mb-3">Daily Trend</CardTitle>
              <div className="space-y-1">
                {(() => {
                  const maxCost = Math.max(...data.byDay.map((d) => d.costUsd), 0.01);
                  return data.byDay.map((d) => (
                    <div key={d.date} className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-fg-muted tabular-nums w-20 flex-shrink-0">
                        {d.date.slice(5)}
                      </span>
                      <div className="flex-1 min-w-0 h-4 bg-surface-hover rounded overflow-hidden" role="presentation">
                        <div
                          className="h-full bg-accent-emphasis rounded"
                          style={{ width: `${Math.max(1, (d.costUsd / maxCost) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-fg-muted tabular-nums w-16 text-right flex-shrink-0">
                        {formatCost(d.costUsd)}
                      </span>
                    </div>
                  ));
                })()}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget Utilization Bar
// ---------------------------------------------------------------------------

function BudgetBar({ label, used, limit, unit }: { label: string; used: number; limit: number; unit: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const barColor = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent-emphasis';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums font-medium">
          {unit === '$' ? formatCost(used) : formatTokens(used)} / {unit === '$' ? formatCost(limit) : formatTokens(limit)}
        </span>
      </div>
      <div className="w-full h-2 bg-surface-hover rounded-full overflow-hidden" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
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

function BudgetSettingsSection() {
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
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await updateUserAiBudget({
        dailyInputTokenLimit: dailyInput ? parseInt(dailyInput, 10) : null,
        dailyOutputTokenLimit: dailyOutput ? parseInt(dailyOutput, 10) : null,
        monthlyCostCapUsd: monthlyCap ? parseFloat(monthlyCap) : null,
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
          {budget.settings.monthlyCostCapUsd !== null && (
            <BudgetBar
              label="Monthly Cost Cap"
              used={budget.monthCostUsd}
              limit={budget.settings.monthlyCostCapUsd}
              unit="$"
            />
          )}
          {budget.exceeded && (
            <div className="flex items-start gap-2 p-3 bg-danger-tint rounded-md border border-danger/30" role="alert" aria-live="assertive">
              <ShieldAlert className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <Body className="text-danger text-sm font-medium m-0">Budget Exceeded</Body>
                <Body className="text-fg-muted text-sm mt-1 m-0">
                  AI proxy requests will be rejected (429) until the limit resets. Daily limits reset at midnight UTC.
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
                placeholder={budget?.effectiveLimits.dailyInputTokenLimit.toLocaleString() ?? '500,000'}
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md border border-border-default bg-surface text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
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
                placeholder={budget?.effectiveLimits.dailyOutputTokenLimit.toLocaleString() ?? '200,000'}
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md border border-border-default bg-surface text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
              />
            </div>

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
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md border border-border-default bg-surface text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
              />
            </div>

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
                className="w-full px-3 py-2.5 min-h-[44px] rounded-md border border-border-default bg-surface text-fg-primary text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-primary"
              />
            </div>
          </div>

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

// ---------------------------------------------------------------------------
// Quota Section
// ---------------------------------------------------------------------------

function QuotaProgressBar({ quota }: { quota: UserQuotaStatusResponse }) {
  // BYOC users are exempt from quotas
  if (quota.byocExempt) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Key className="w-4 h-4 text-fg-muted" aria-hidden="true" />
          <span className="sam-type-body font-medium">BYOC — No Quota</span>
        </div>
        <Body className="text-fg-muted text-sm">
          You&apos;re using your own cloud provider credentials. Compute quotas don&apos;t apply.
        </Body>
      </Card>
    );
  }

  // No quota configured
  if (quota.monthlyVcpuHoursLimit === null) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Gauge className="w-4 h-4 text-fg-muted" aria-hidden="true" />
          <span className="sam-type-body font-medium">Unlimited</span>
        </div>
        <Body className="text-fg-muted text-sm">
          No compute quota is configured for your account.
        </Body>
      </Card>
    );
  }

  const limit = quota.monthlyVcpuHoursLimit;
  const used = quota.currentUsage;
  const pct = Math.min(100, limit > 0 ? (used / limit) * 100 : 0);
  const exceeded = pct >= 100;
  const barColor = exceeded ? 'bg-error' : pct >= 90 ? 'bg-error' : pct >= 75 ? 'bg-warning' : 'bg-success';

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-fg-muted" aria-hidden="true" />
          <span className="sam-type-body font-medium">Monthly Quota</span>
        </div>
        <span className="sam-type-body tabular-nums font-medium">
          {used.toFixed(2)} / {limit.toFixed(0)} vCPU-hrs
        </span>
      </div>
      <div className="w-full h-3 bg-surface rounded-full overflow-hidden border border-border-default">
        <div
          className={`h-full ${barColor} rounded-full transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="sam-type-caption text-fg-muted">
          {quota.remaining !== null ? `${quota.remaining.toFixed(2)} hrs remaining` : ''}
        </span>
        <span className="sam-type-caption text-fg-muted tabular-nums">{Math.round(pct)}%</span>
      </div>
      {exceeded && (
        <div className="mt-3 p-3 bg-error/10 rounded-md border border-error/20">
          <Body className="text-error text-sm font-medium">Quota Exceeded</Body>
          <Body className="text-fg-muted text-sm mt-1">
            You&apos;ve used all your allocated compute for this month. New tasks using platform
            compute will be rejected. To continue, add your own cloud provider credentials in
            Settings or contact your admin.
          </Body>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function SettingsComputeUsage() {
  const [data, setData] = useState<ComputeUsageResponse | null>(null);
  const [quota, setQuota] = useState<UserQuotaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      setError(null);
      const [usageRes, quotaRes] = await Promise.all([
        fetchComputeUsage(),
        fetchUserQuotaStatus(),
      ]);
      setData(usageRes);
      setQuota(quotaRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-4">
        <p className="sam-type-body text-danger-fg m-0">{error}</p>
      </Card>
    );
  }

  if (!data) return null;

  const period = data.currentPeriod;
  const periodStart = new Date(period.start).toLocaleDateString();
  const periodEnd = new Date(period.end).toLocaleDateString();

  return (
    <div className="space-y-8 min-w-0 overflow-hidden">
      {/* LLM Usage (AI Gateway) */}
      <AiUsageSection />

      {/* Budget Controls */}
      <BudgetSettingsSection />

      {/* Compute Usage */}
      <div className="space-y-4 min-w-0 overflow-hidden">
        <div>
          <SectionHeading>Compute Usage</SectionHeading>
          <Body className="text-fg-muted text-sm">
            Current billing period: {periodStart} &ndash; {periodEnd}
          </Body>
        </div>

        {quota && <QuotaProgressBar quota={quota} />}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-3 text-center">
            <Cpu className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
            <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(period.totalVcpuHours)}</p>
            <p className="sam-type-caption text-fg-muted m-0">Total vCPU-hrs</p>
          </Card>
          <Card className="p-3 text-center">
            <Server className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
            <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(period.platformVcpuHours)}</p>
            <p className="sam-type-caption text-fg-muted m-0">Platform</p>
          </Card>
          <Card className="p-3 text-center">
            <Key className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
            <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(period.userVcpuHours)}</p>
            <p className="sam-type-caption text-fg-muted m-0">Your Keys (BYOC)</p>
          </Card>
          <Card className="p-3 text-center">
            <span className="block w-5 h-5 mx-auto mb-1" aria-hidden="true">
              <span className="w-2 h-2 rounded-full bg-success block mx-auto mt-1.5" />
            </span>
            <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{period.activeWorkspaces}</p>
            <p className="sam-type-caption text-fg-muted m-0">Active Now</p>
          </Card>
        </div>

        {data.activeSessions.length > 0 ? (
          <Card className="p-4 overflow-hidden w-full min-w-0">
            <CardTitle className="mb-3">Active Workspaces</CardTitle>
            <div className="space-y-0">
              {data.activeSessions.map((session) => (
                <div
                  key={session.workspaceId}
                  className="flex flex-col gap-1 py-3 border-b border-border-default last:border-0 min-w-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-success flex-shrink-0" aria-label="Running" />
                    <span className="font-mono sam-type-caption text-fg-primary truncate min-w-0 flex-1">
                      {session.workspaceId}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 sm:pl-0">
                    <span className="sam-type-caption text-fg-muted">{session.serverType} ({session.vcpuCount} vCPU)</span>
                    <span className="sam-type-caption text-fg-muted capitalize">{session.credentialSource}</span>
                    <span className="flex items-center gap-1 sam-type-caption text-fg-muted">
                      <Clock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                      <span className="tabular-nums">{formatDuration(session.startedAt)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card className="p-6 text-center">
            <Body className="text-fg-muted">No active workspaces right now.</Body>
          </Card>
        )}
      </div>
    </div>
  );
}
