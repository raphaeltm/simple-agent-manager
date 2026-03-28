import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { AnalyticsWebsiteTrafficResponse } from '../../lib/api';

const TOP_PAGES_DISPLAY_LIMIT = 10;

interface Props {
  data: AnalyticsWebsiteTrafficResponse | null;
}

const SECTION_LABELS: Record<string, string> = {
  landing: 'Landing Page',
  blog: 'Blog',
  docs: 'Documentation',
  presentations: 'Presentations',
  other: 'Other Pages',
};

const SECTION_COLORS: Record<string, string> = {
  landing: 'var(--sam-color-accent-primary, #16a34a)',
  blog: '#60a5fa',
  docs: '#a78bfa',
  presentations: 'var(--sam-color-warning, #f59e0b)',
  other: 'var(--sam-color-fg-muted, #9fb7ae)',
};

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Custom tooltip for website traffic chart. */
function TrafficTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { label: string; views: number; visitors: number } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  return (
    <div className="rounded-md border border-border-default bg-surface-primary px-3 py-2 shadow-lg text-sm">
      <div className="text-fg-primary font-medium">{d.label}</div>
      <div className="text-fg-secondary tabular-nums">{formatNumber(d.views)} views</div>
      <div className="text-fg-muted text-xs tabular-nums">{formatNumber(d.visitors)} visitors</div>
    </div>
  );
}

export const WebsiteTraffic: FC<Props> = ({ data }) => {
  if (!data?.hosts?.length) {
    return <Body className="text-fg-muted">No website traffic data available yet.</Body>;
  }

  return (
    <div className="flex flex-col gap-6">
      {data.hosts.map((host) => {
        // Build chart data from sections
        const chartData = host.sections.map((section) => ({
          label: SECTION_LABELS[section.name] ?? section.name,
          name: section.name,
          views: section.views,
          visitors: section.unique_visitors,
        }));

        return (
          <div key={host.host} className="flex flex-col gap-3">
            {/* Host summary header */}
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-semibold text-fg-primary">{host.host}</span>
              <div className="flex items-center gap-3 text-xs text-fg-muted">
                <span className="tabular-nums">{formatNumber(host.totalViews)} views</span>
                <span className="tabular-nums">{formatNumber(host.uniqueVisitors)} visitors</span>
                <span className="tabular-nums">{formatNumber(host.uniqueSessions)} sessions</span>
              </div>
            </div>

            {/* Section bar chart */}
            {chartData.length > 0 ? (
              <div className="w-full" style={{ height: Math.max(140, chartData.length * 36) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--sam-color-border-default, #29423b)" strokeOpacity={0.3} horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted, #9fb7ae)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      dataKey="label"
                      type="category"
                      width={110}
                      tick={{ fontSize: 12, fill: 'var(--sam-color-fg-secondary, #c5d6cf)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<TrafficTooltip />} cursor={{ fill: 'var(--sam-color-bg-surface-hover, #1a2e29)', opacity: 0.5 }} />
                    <Bar dataKey="views" radius={[0, 4, 4, 0]} maxBarSize={24}>
                      {chartData.map((entry) => (
                        <Cell key={entry.name} fill={SECTION_COLORS[entry.name] ?? SECTION_COLORS.other} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Body className="text-fg-muted text-xs">No section data</Body>
            )}

            {/* Top pages table */}
            {host.sections.some((s) => s.topPages.length > 0) && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-left text-fg-muted">
                      <th scope="col" className="py-1.5 pr-3 font-medium">Page</th>
                      <th scope="col" className="py-1.5 pr-3 font-medium text-right">Views</th>
                      <th scope="col" className="py-1.5 font-medium text-right">Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {host.sections.flatMap((s) =>
                      s.topPages.slice(0, TOP_PAGES_DISPLAY_LIMIT).map((p) => (
                        <tr key={`${s.name}-${p.page}`} className="border-b border-border-muted">
                          <td className="py-1.5 pr-3 truncate max-w-[250px]" title={p.page}>
                            <span
                              className="inline-block w-2 h-2 rounded-full mr-2 flex-shrink-0"
                              style={{ backgroundColor: SECTION_COLORS[s.name] ?? SECTION_COLORS.other }}
                            />
                            {p.page}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-fg-secondary">{formatNumber(p.views)}</td>
                          <td className="py-1.5 text-right tabular-nums text-fg-muted">{formatNumber(p.unique_visitors)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
