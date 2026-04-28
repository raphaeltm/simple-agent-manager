import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { CostSummaryResponse } from '../lib/api';
import { fetchAdminCosts } from '../lib/api';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function shortModel(model: string): string {
  return model
    .replace(/^@cf\/[^/]+\//, '')
    .replace(/^claude-/, 'claude ')
    .slice(0, 30);
}

// ---------------------------------------------------------------------------
// Period selector
// ---------------------------------------------------------------------------

const PERIODS = [
  { value: 'current-month', label: 'This Month' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
] as const;

function PeriodSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Cost period">
      {PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={value === p.value}
          onClick={() => onChange(p.value)}
          className={`px-3 py-1.5 text-xs rounded-md transition-colors min-h-[36px] ${
            value === p.value
              ? 'bg-accent-muted text-accent-fg font-medium'
              : 'bg-surface-secondary text-fg-muted hover:text-fg-primary'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------

const BAR_COLORS = [
  'var(--sam-color-accent-primary, #16a34a)',
  '#60a5fa',
  '#a78bfa',
  'var(--sam-color-warning, #f59e0b)',
  '#ec4899',
  '#14b8a6',
];

function KpiCard({
  label,
  value,
  subtitle,
  accent,
}: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`border rounded-md p-3 ${
        accent
          ? 'border-accent-primary bg-accent-muted/10'
          : 'border-border-default bg-surface-secondary'
      }`}
    >
      <div className="text-xs text-fg-muted uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold mt-1 ${accent ? 'text-accent-fg' : 'text-fg-primary'}`}>
        {value}
      </div>
      {subtitle && <div className="text-xs text-fg-muted mt-0.5">{subtitle}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AdminCosts() {
  const [data, setData] = useState<CostSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState('current-month');
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(
    async (showLoading = true) => {
      try {
        if (showLoading && !hasLoadedRef.current) setLoading(true);
        setError(null);
        const res = await fetchAdminCosts(period);
        setData(res);
        hasLoadedRef.current = true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load cost data');
      } finally {
        setLoading(false);
      }
    },
    [period],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card>
        <div className="p-4 flex flex-col items-center gap-3">
          <Body className="text-danger-fg">{error}</Body>
          <Button size="sm" variant="secondary" onClick={() => loadData()}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  if (!data) return null;

  const { llm, projection, compute } = data;
  const combinedCost = llm.totalCostUsd + compute.estimatedCostUsd;

  return (
    <div className="flex flex-col gap-4 min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-fg-primary m-0">Cost Monitor</h2>
          <p className="text-sm text-fg-muted m-0 mt-0.5">{data.periodLabel}</p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="LLM Cost"
          value={formatCost(llm.totalCostUsd)}
          subtitle={llm.trialCostUsd > 0 ? `${formatCost(llm.trialCostUsd)} trials` : undefined}
          accent
        />
        <KpiCard
          label="Monthly Projection"
          value={formatCost(projection.projectedMonthlyCostUsd)}
          subtitle={`${formatCost(projection.dailyAverageCostUsd)}/day avg`}
        />
        <KpiCard
          label="Compute Est."
          value={formatCost(compute.estimatedCostUsd)}
          subtitle={`${compute.totalVcpuHours.toFixed(1)} vCPU-hrs @ ${formatCost(compute.vcpuHourCostUsd)}/hr`}
        />
        <KpiCard
          label="Combined"
          value={formatCost(combinedCost)}
          subtitle={`${llm.totalRequests.toLocaleString()} LLM reqs, ${compute.activeNodes} active nodes`}
        />
      </div>

      {/* Daily cost trend */}
      {llm.byDay.length > 1 && (
        <Card>
          <div className="p-4">
            <h3 className="text-sm font-semibold text-fg-primary mb-3">Daily LLM Cost</h3>
            <div className="w-full" style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={llm.byDay}
                  margin={{ top: 4, right: 4, left: -10, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--sam-color-border-default)"
                    strokeOpacity={0.3}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }}
                    tickFormatter={(d: string) => d.slice(5)}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }}
                    tickFormatter={(v: number) => formatCost(v)}
                  />
                  <Tooltip
                    formatter={(value: number) => [formatCost(value), 'Cost']}
                    labelFormatter={(label: string) => label}
                    contentStyle={{
                      background: 'var(--sam-color-surface-primary)',
                      border: '1px solid var(--sam-color-border-default)',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="costUsd"
                    stroke="var(--sam-color-accent-primary, #16a34a)"
                    fill="var(--sam-color-accent-primary, #16a34a)"
                    fillOpacity={0.15}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Card>
      )}

      {/* Two-column: Cost by Model + Cost by User */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cost by Model */}
        {llm.byModel.length > 0 && (
          <Card>
            <div className="p-4">
              <h3 className="text-sm font-semibold text-fg-primary mb-3">Cost by Model</h3>
              {/* Bar chart */}
              <div className="w-full mb-3" style={{ height: Math.max(100, llm.byModel.length * 40) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={llm.byModel.map((m) => ({ ...m, label: shortModel(m.model) }))}
                    layout="vertical"
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--sam-color-border-default)"
                      strokeOpacity={0.3}
                    />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }}
                      tickFormatter={(v: number) => formatCost(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={120}
                      tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }}
                    />
                    <Tooltip
                      formatter={(value: number) => [formatCost(value), 'Cost']}
                      contentStyle={{
                        background: 'var(--sam-color-surface-primary)',
                        border: '1px solid var(--sam-color-border-default)',
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="costUsd" fill={BAR_COLORS[0]} name="Cost" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Table */}
              <div className="overflow-x-auto -mx-4 px-4">
                <table className="w-full text-sm min-w-[320px]">
                  <thead>
                    <tr className="border-b border-border-default text-fg-muted text-xs">
                      <th className="text-left py-2 pr-3">Model</th>
                      <th className="text-right py-2 px-2">Reqs</th>
                      <th className="text-right py-2 px-2">Tokens</th>
                      <th className="text-right py-2 pl-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llm.byModel.map((m, i) => (
                      <tr key={m.model} className="border-b border-border-default last:border-0">
                        <td className="py-2 pr-3">
                          <span
                            className="inline-block w-2 h-2 rounded-full mr-2"
                            style={{ backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }}
                          />
                          <span className="text-fg-primary text-xs">{shortModel(m.model)}</span>
                          <span className="text-fg-muted ml-1 text-xs">({m.provider})</span>
                        </td>
                        <td className="text-right py-2 px-2 text-fg-secondary tabular-nums">
                          {m.requests}
                        </td>
                        <td className="text-right py-2 px-2 text-fg-secondary tabular-nums">
                          {formatTokens(m.inputTokens + m.outputTokens)}
                        </td>
                        <td className="text-right py-2 pl-2 text-fg-primary font-medium tabular-nums">
                          {formatCost(m.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        )}

        {/* Cost by User */}
        {llm.byUser.length > 0 && (
          <Card>
            <div className="p-4">
              <h3 className="text-sm font-semibold text-fg-primary mb-3">LLM Cost by User</h3>
              <div className="overflow-x-auto -mx-4 px-4">
                <table className="w-full text-sm min-w-[320px]">
                  <thead>
                    <tr className="border-b border-border-default text-fg-muted text-xs">
                      <th className="text-left py-2 pr-3">User</th>
                      <th className="text-right py-2 px-2">Reqs</th>
                      <th className="text-right py-2 px-2">Input</th>
                      <th className="text-right py-2 px-2">Output</th>
                      <th className="text-right py-2 pl-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llm.byUser.slice(0, 20).map((u) => (
                      <tr key={u.userId} className="border-b border-border-default last:border-0">
                        <td className="py-2 pr-3">
                          <span
                            className="text-fg-primary font-mono text-xs truncate inline-block max-w-[120px]"
                            title={u.userId}
                          >
                            {u.userId.slice(0, 12)}...
                          </span>
                        </td>
                        <td className="text-right py-2 px-2 text-fg-secondary tabular-nums">
                          {u.requests}
                        </td>
                        <td className="text-right py-2 px-2 text-fg-secondary tabular-nums">
                          {formatTokens(u.inputTokens)}
                        </td>
                        <td className="text-right py-2 px-2 text-fg-secondary tabular-nums">
                          {formatTokens(u.outputTokens)}
                        </td>
                        <td className="text-right py-2 pl-2 text-fg-primary font-medium tabular-nums">
                          {formatCost(u.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Empty state */}
      {llm.totalRequests === 0 && compute.totalNodeHours === 0 && (
        <Card>
          <div className="p-6 text-center">
            <Body className="text-fg-muted">
              No cost data available yet. AI Gateway logs and node usage will appear here once activity begins.
            </Body>
          </div>
        </Card>
      )}
    </div>
  );
}
