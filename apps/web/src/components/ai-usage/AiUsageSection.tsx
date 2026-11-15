import type { UserAiUsageResponse } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Bot } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { fetchUserAiUsage } from '../../lib/api';
import { formatCost, formatTokens, truncateModel } from './format';

// ---------------------------------------------------------------------------
// AI Usage Section
// ---------------------------------------------------------------------------

const AI_PERIODS = [
  { value: 'current-month', label: 'This Month' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
] as const;

export function AiUsageSection() {
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
          <Body className="text-fg-muted text-sm">SAM-managed AI Gateway traffic only</Body>
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
            Usage from SAM-managed AI Gateway requests will appear here. Direct BYOK or non-Gateway
            usage is not tracked.
          </Body>
        </Card>
      )}

      {data && data.totalRequests > 0 && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">
                {formatCost(data.totalCostUsd)}
              </p>
              <p className="sam-type-caption text-fg-muted m-0">Total Cost</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">
                {data.totalRequests.toLocaleString()}
              </p>
              <p className="sam-type-caption text-fg-muted m-0">Requests</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">
                {formatTokens(data.totalInputTokens)}
              </p>
              <p className="sam-type-caption text-fg-muted m-0">Input Tokens</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="sam-type-body font-semibold text-lg tabular-nums m-0">
                {formatTokens(data.totalOutputTokens)}
              </p>
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
                      {m.cachedRequests > 0 && (
                        <span className="text-accent-fg">{m.cachedRequests} cached</span>
                      )}
                      {m.errorRequests > 0 && (
                        <span
                          className="text-danger-fg"
                          title={`${m.errorRequests} error requests`}
                        >
                          {m.errorRequests} err
                        </span>
                      )}
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
                      <div
                        className="flex-1 min-w-0 h-4 bg-surface-hover rounded overflow-hidden"
                        role="presentation"
                      >
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
