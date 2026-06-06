import { Body } from '@simple-agent-manager/ui';
import { type FC, useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { adminChartSeries, chartAxisStroke, chartGridStroke, chartTick, chartTooltipStyle } from './chartTokens';

/** Format date for X-axis ticks — "Mar 5" style. */
function formatDateTick(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Custom tooltip for DAU chart. */
function DauTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md px-3 py-2 shadow-lg text-sm" style={chartTooltipStyle}>
      <div className="text-fg-muted text-xs">{label ? formatDateTick(label) : ''}</div>
      <div className="text-fg-primary font-semibold tabular-nums">
        {payload[0]!.value.toLocaleString()} users
      </div>
    </div>
  );
}

export const DauChart: FC<{ data: Array<{ date: string; unique_users: number }> }> = ({ data }) => {
  const gradientId = useId();
  const safeGradientId = `dauGradient-${gradientId.replace(/:/g, '')}`;

  if (!data.length) {
    return <Body className="text-fg-muted">No DAU data available yet. Data will appear after users sign in.</Body>;
  }

  return (
    <div className="w-full" style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id={safeGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={adminChartSeries[0]} stopOpacity={0.3} />
              <stop offset="95%" stopColor={adminChartSeries[0]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} strokeOpacity={0.5} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateTick}
            tick={chartTick}
            axisLine={{ stroke: chartAxisStroke }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={50}
          />
          <YAxis
            tick={chartTick}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip content={<DauTooltip />} />
          <Area
            type="monotone"
            dataKey="unique_users"
            stroke={adminChartSeries[0]}
            strokeWidth={2}
            fill={`url(#${safeGradientId})`}
            dot={false}
            activeDot={{ r: 4, stroke: adminChartSeries[0], strokeWidth: 2, fill: 'var(--sam-color-bg-surface)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};
