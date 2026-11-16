import { type FC } from 'react';

import type { AnalyticsDauResponse, AnalyticsEventsResponse } from '../../lib/api';

interface Props {
  dau: AnalyticsDauResponse | null;
  events: AnalyticsEventsResponse | null;
}

interface KpiCard {
  label: string;
  value: string;
  sub?: string;
}

export const KpiSummary: FC<Props> = ({ dau, events }) => {
  const cards: KpiCard[] = [];

  // DAU today (last data point)
  if (dau?.dau?.length) {
    const latest = dau.dau.at(-1);
    const prev = dau.dau.length > 1 ? dau.dau.at(-2) : undefined;
    if (latest) {
      const delta = prev ? latest.unique_users - prev.unique_users : 0;
      const sign = delta > 0 ? '+' : '';
      cards.push({
        label: 'DAU (latest)',
        value: latest.unique_users.toLocaleString(),
        sub: prev ? `${sign}${delta} vs prev day` : undefined,
      });
    }
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
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {cards.map((card, index) => (
        <div
          key={card.label}
          className={`rounded-lg border border-border-default bg-surface-secondary p-4${
            // An odd last card fills the two-column phone row instead of leaving a hole.
            cards.length % 2 === 1 && index === cards.length - 1 ? ' col-span-2 lg:col-span-1' : ''
          }`}
        >
          <div className="text-xs font-medium text-fg-muted uppercase tracking-wide">
            {card.label}
          </div>
          <div className="mt-1 text-2xl font-bold text-fg-primary tabular-nums">{card.value}</div>
          {card.sub && <div className="mt-0.5 text-xs text-fg-muted">{card.sub}</div>}
        </div>
      ))}
    </div>
  );
};
