import { Body } from '@simple-agent-manager/ui';
import { type FC, useMemo } from 'react';
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

import type { AnalyticsAiUsageResponse } from '../../lib/api';

const BAR_COLORS = [
  'var(--sam-color-accent-primary, #16a34a)',
  '#60a5fa',
  '#a78bfa',
  'var(--sam-color-warning, #f59e0b)',
  '#ec4899',
  '#14b8a6',
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Short model label — strip @cf/ prefix and vendor path. */
function shortModel(model: string): string {
  return model
    .replace(/^@cf\/[^/]+\//, '')
    .replace(/^claude-/, 'claude ')
    .slice(0, 30);
}

interface Props {
  data: AnalyticsAiUsageResponse | null;
}

export const AIUsageChart: FC<Props> = ({ data }) => {
  const modelData = useMemo(
    () => (data?.byModel ?? []).map((m) => ({ ...m, label: shortModel(m.model) })),
    [data?.byModel],
  );

  if (!data || data.totalRequests === 0) {
    return <Body className="text-fg-muted">No AI usage data available yet.</Body>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Requests" value={data.totalRequests.toLocaleString()} />
        <KpiCard label="Total Tokens" value={formatTokens(data.totalInputTokens + data.totalOutputTokens)} subtitle={`${formatTokens(data.totalInputTokens)} in / ${formatTokens(data.totalOutputTokens)} out`} />
        <KpiCard label="Est. Cost" value={formatCost(data.totalCostUsd)} subtitle={data.trialRequests > 0 ? `${formatCost(data.trialCostUsd)} from trials` : undefined} />
        <KpiCard label="Trials" value={data.trialRequests.toLocaleString()} subtitle={data.cachedRequests > 0 ? `${data.cachedRequests} cached` : undefined} />
      </div>

      {/* Tokens by model — horizontal bar chart */}
      {modelData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-fg-secondary mb-2">Tokens by Model</h4>
          <div className="w-full" style={{ height: Math.max(120, modelData.length * 50) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={modelData} layout="vertical" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--sam-color-border-default)" strokeOpacity={0.3} />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }} tickFormatter={formatTokens} />
                <YAxis type="category" dataKey="label" width={140} tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }} />
                <Tooltip
                  formatter={(value) => [formatTokens(Number(value)), '']}
                  contentStyle={{ background: 'var(--sam-color-surface-primary)', border: '1px solid var(--sam-color-border-default)', borderRadius: 6, fontSize: 12 }}
                />
                <Bar dataKey="inputTokens" stackId="tokens" fill={BAR_COLORS[0]} name="Input" />
                <Bar dataKey="outputTokens" stackId="tokens" fill={BAR_COLORS[1]} name="Output" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Daily usage trend — area chart */}
      {data.byDay.length > 1 && (
        <div>
          <h4 className="text-sm font-medium text-fg-secondary mb-2">Daily Usage</h4>
          <div className="w-full" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.byDay} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--sam-color-border-default)" strokeOpacity={0.3} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }}
                  tickFormatter={(d: string) => d.slice(5)} // MM-DD
                />
                <YAxis tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted)' }} />
                <Tooltip
                  formatter={(value) => [Number(value).toLocaleString(), 'Requests']}
                  contentStyle={{ background: 'var(--sam-color-surface-primary)', border: '1px solid var(--sam-color-border-default)', borderRadius: 6, fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey="requests"
                  stroke="var(--sam-color-accent-primary, #16a34a)"
                  fill="var(--sam-color-accent-primary, #16a34a)"
                  fillOpacity={0.15}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Model breakdown table */}
      {modelData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-fg-secondary mb-2">Model Breakdown</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-default text-fg-muted text-xs">
                  <th className="text-left py-2 pr-4">Model</th>
                  <th className="text-right py-2 px-2">Requests</th>
                  <th className="text-right py-2 px-2">Input</th>
                  <th className="text-right py-2 px-2">Output</th>
                  <th className="text-right py-2 pl-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelData.map((m, i) => (
                  <tr key={m.model} className="border-b border-border-default last:border-0">
                    <td className="py-2 pr-4">
                      <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }} />
                      <span className="text-fg-primary">{m.label}</span>
                      <span className="text-fg-muted ml-1 text-xs">({m.provider})</span>
                    </td>
                    <td className="text-right py-2 px-2 text-fg-secondary">{m.requests}</td>
                    <td className="text-right py-2 px-2 text-fg-secondary">{formatTokens(m.inputTokens)}</td>
                    <td className="text-right py-2 px-2 text-fg-secondary">{formatTokens(m.outputTokens)}</td>
                    <td className="text-right py-2 pl-2 text-fg-primary font-medium">{formatCost(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

/** Simple KPI card matching the existing analytics design. */
const KpiCard: FC<{ label: string; value: string; subtitle?: string }> = ({ label, value, subtitle }) => (
  <div className="border border-border-default rounded-md bg-surface-secondary p-3">
    <div className="text-xs text-fg-muted uppercase tracking-wide">{label}</div>
    <div className="text-xl font-bold text-fg-primary mt-1">{value}</div>
    {subtitle && <div className="text-xs text-fg-muted mt-0.5">{subtitle}</div>}
  </div>
);
