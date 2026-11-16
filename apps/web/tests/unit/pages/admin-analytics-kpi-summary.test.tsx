import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AnalyticsDauResponse, AnalyticsEventsResponse } from '../../../src/lib/api';
import { KpiSummary } from '../../../src/pages/admin-analytics/KpiSummary';

const DAU: AnalyticsDauResponse = {
  dau: [
    { date: '2026-11-14', unique_users: 4 },
    { date: '2026-11-15', unique_users: 6 },
  ],
  periodDays: 30,
};
const EVENTS: AnalyticsEventsResponse = {
  events: [{ event_name: 'task_submitted', count: 10, unique_users: 5, avg_response_ms: 40 }],
  period: '7d',
};

function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).parentElement;
  if (!card) throw new Error(`no card for ${label}`);
  return card;
}

describe('KpiSummary', () => {
  it('renders DAU, average DAU and events cards and no funnel card', () => {
    render(<KpiSummary dau={DAU} events={EVENTS} />);

    expect(screen.getByText('DAU (latest)')).toBeTruthy();
    expect(screen.getByText('Avg DAU (30d)')).toBeTruthy();
    expect(screen.getByText('Events (7d)')).toBeTruthy();
    expect(screen.queryByText('Funnel Conversion')).toBeNull();
  });

  it('lets an odd last card span the two-column phone row', () => {
    render(<KpiSummary dau={DAU} events={EVENTS} />);

    expect(cardFor('Events (7d)').className).toContain('col-span-2');
    expect(cardFor('Events (7d)').className).toContain('lg:col-span-1');
    expect(cardFor('DAU (latest)').className).not.toContain('col-span-2');
  });

  it('sizes the desktop grid to the cards present, so a partial load leaves no hole', () => {
    const { container, rerender } = render(<KpiSummary dau={DAU} events={EVENTS} />);
    expect((container.firstChild as HTMLElement).className).toContain('lg:grid-cols-3');

    rerender(<KpiSummary dau={DAU} events={null} />);
    expect((container.firstChild as HTMLElement).className).toContain('lg:grid-cols-2');

    rerender(<KpiSummary dau={null} events={EVENTS} />);
    expect((container.firstChild as HTMLElement).className).toContain('lg:grid-cols-1');
  });

  it('does not span a card when the count is even', () => {
    render(<KpiSummary dau={DAU} events={null} />);

    expect(cardFor('DAU (latest)').className).not.toContain('col-span-2');
    expect(cardFor('Avg DAU (30d)').className).not.toContain('col-span-2');
  });

  it('renders nothing without data', () => {
    const { container } = render(<KpiSummary dau={null} events={null} />);
    expect(container.firstChild).toBeNull();
  });
});
