import { type FC } from 'react';

import type {
  AnalyticsDauResponse,
  AnalyticsEventsResponse,
  AnalyticsFunnelResponse,
} from '../../lib/api';

interface Props {
  dau: AnalyticsDauResponse | null;
  funnel: AnalyticsFunnelResponse | null;
  events: AnalyticsEventsResponse | null;
}

interface KpiCard {
  label: string;
  value: string;
  sub?: string;
}

export const KpiSummary: FC<Props> = ({ dau, funnel, events }) => {
  const cards: KpiCard[] = [];

  // DAU today (last data point)
  if (dau?.dau?.length) {
    const latest = dau.dau[dau.dau.length - 1]!;
    const prev = dau.dau.length > 1 ? dau.dau[dau.dau.length - 2]! : null;
    const delta = prev ? latest.unique_users - prev.unique_users : 0;
    const sign = delta > 0 ? '+' : '';
    cards.push({
      label: 'DAU (latest)',
      value: latest.unique_users.toLocaleString(),
      sub: prev ? `${sign}${delta} vs prev day` : undefined,
    });
  }

  // MAU (sum unique across period if available, or approximate)
  if (dau?.dau?.length) {
    const peak = Math.max(...dau.dau.map((d) => d.unique_users));
    const avg = Math.round(dau.dau.reduce((s, d) => s + d.unique_users, 0) / dau.dau.length);
    cards.push({
      label: `Avg DAU (${dau.periodDays}d)`,
      value: avg.toLocaleString(),
      sub: `Peak: ${peak.toLocaleString()}`,
    });
  }

  // Funnel: top conversion (only show when there's meaningful data)
  if (funnel?.funnel?.length && funnel.funnel.length >= 2) {
    const first = funnel.funnel[0]!;
    const last = funnel.funnel[funnel.funnel.length - 1]!;
    if (first.unique_users > 0) {
      const rate = Math.round((last.unique_users / first.unique_users) * 100);
      cards.push({
        label: 'Funnel Conversion',
        value: `${rate}%`,
        sub: `${first.unique_users.toLocaleString()} \u2192 ${last.unique_users.toLocaleString()}`,
      });
    }
  }

  // Total events
  if (events?.events?.length) {
    const total = events.events.reduce((s, e) => s + e.count, 0);
    const avgMs = events.events.reduce((s, e) => s + e.avg_response_ms, 0) / events.events.length;
    cards.push({
      label: `Events (${events.period})`,
      value: total.toLocaleString(),
      sub: `Avg ${Math.round(avgMs)}ms response`,
    });
  }

  if (!cards.length) return null;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg border border-border-default bg-surface-primary p-4"
        >
          <div className="text-xs font-medium text-fg-muted uppercase tracking-wide">
            {card.label}
          </div>
          <div className="mt-1 text-2xl font-bold text-fg-primary tabular-nums">
            {card.value}
          </div>
          {card.sub && (
            <div className="mt-0.5 text-xs text-fg-muted">{card.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
};
