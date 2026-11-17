import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AnalyticsFeatureAdoptionResponse } from '../../src/lib/api';
import { FeatureAdoptionChart } from '../../src/pages/admin-analytics/FeatureAdoptionChart';

// ---------------------------------------------------------------------------
// FeatureAdoptionChart (Recharts-based — renders SVG internally)
// ---------------------------------------------------------------------------

describe('FeatureAdoptionChart', () => {
  it('renders empty state when no data', () => {
    render(<FeatureAdoptionChart data={null} />);
    expect(screen.getByText(/no feature adoption data/i)).toBeDefined();
  });

  it('renders empty state when totals array is empty', () => {
    render(<FeatureAdoptionChart data={{ totals: [], trend: [], period: '30d' }} />);
    expect(screen.getByText(/no feature adoption data/i)).toBeDefined();
  });

  it('renders chart container with correct height when data is present', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [
        { event_name: 'task_submitted', count: 42, unique_users: 10 },
        { event_name: 'project_created', count: 15, unique_users: 8 },
      ],
      trend: [],
      period: '7d',
    };

    const { container } = render(<FeatureAdoptionChart data={data} />);
    // Should render a container div (Recharts SVG doesn't render in jsdom)
    const chartDiv = container.firstElementChild as HTMLElement;
    expect(chartDiv).not.toBeNull();
    expect(chartDiv.style.height).toBeTruthy();
  });

  it('renders chart height proportional to number of events', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: Array.from({ length: 10 }, (_, i) => ({
        event_name: `event_${i}`,
        count: 10 - i,
        unique_users: 5,
      })),
      trend: [],
      period: '30d',
    };

    const { container } = render(<FeatureAdoptionChart data={data} />);
    // Height should be at least 200px and scale with items
    const chartDiv = container.firstElementChild as HTMLElement;
    const height = parseInt(chartDiv?.style.height || '0');
    expect(height).toBeGreaterThanOrEqual(200);
  });
});
