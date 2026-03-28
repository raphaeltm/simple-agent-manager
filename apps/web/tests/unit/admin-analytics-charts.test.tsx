import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FeatureAdoptionChart } from '../../src/pages/admin-analytics/FeatureAdoptionChart';
import { GeoDistribution } from '../../src/pages/admin-analytics/GeoDistribution';
import { RetentionCohorts } from '../../src/pages/admin-analytics/RetentionCohorts';
import type {
  AnalyticsFeatureAdoptionResponse,
  AnalyticsGeoResponse,
  AnalyticsRetentionResponse,
} from '../../src/lib/api';

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

// ---------------------------------------------------------------------------
// GeoDistribution (world map + data table)
// ---------------------------------------------------------------------------

describe('GeoDistribution', () => {
  it('renders empty state when no data', () => {
    render(<GeoDistribution data={null} />);
    expect(screen.getByText(/no geographic data/i)).toBeDefined();
  });

  it('renders empty state when geo array is empty', () => {
    render(<GeoDistribution data={{ geo: [], period: '30d' }} />);
    expect(screen.getByText(/no geographic data/i)).toBeDefined();
  });

  it('renders country table with data', () => {
    const data: AnalyticsGeoResponse = {
      geo: [
        { country: 'US', event_count: 100, unique_users: 20 },
        { country: 'DE', event_count: 50, unique_users: 10 },
        { country: 'CA', event_count: 30, unique_users: 5 },
      ],
      period: '7d',
    };

    const { container } = render(<GeoDistribution data={data} />);
    // Should have a table with country data
    const table = container.querySelector('table');
    expect(table).not.toBeNull();

    // Country names should appear (the component maps codes to full names)
    expect(container.textContent).toContain('United States');
    expect(container.textContent).toContain('Germany');
    expect(container.textContent).toContain('Canada');
  });

  it('renders a single country row correctly (no division-by-zero)', () => {
    const data: AnalyticsGeoResponse = {
      geo: [{ country: 'GB', event_count: 200, unique_users: 40 }],
      period: '30d',
    };

    const { container } = render(<GeoDistribution data={data} />);
    expect(container.textContent).toContain('United Kingdom');
  });

  it('percentages round to nearest integer and sum to ~100', () => {
    const data: AnalyticsGeoResponse = {
      geo: [
        { country: 'US', event_count: 100, unique_users: 10 },
        { country: 'DE', event_count: 100, unique_users: 10 },
        { country: 'FR', event_count: 100, unique_users: 10 },
      ],
      period: '30d',
    };

    render(<GeoDistribution data={data} />);
    // Each should be 33%
    const pctCells = screen.getAllByText('33%');
    expect(pctCells.length).toBe(3);
  });

  it('renders a large list with all rows present', () => {
    const geo = Array.from({ length: 50 }, (_, i) => ({
      country: `C${String(i).padStart(2, '0')}`,
      event_count: 100 - i,
      unique_users: 50 - i,
    }));

    const data: AnalyticsGeoResponse = { geo, period: '30d' };
    const { container } = render(<GeoDistribution data={data} />);

    // All 50 rows should be present in the table
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(50);
  });

  it('renders event counts with locale formatting for large numbers', () => {
    const data: AnalyticsGeoResponse = {
      geo: [{ country: 'US', event_count: 1_000_000, unique_users: 5_000 }],
      period: '30d',
    };

    const { container } = render(<GeoDistribution data={data} />);
    // toLocaleString() should produce formatted output
    expect(container.textContent).toMatch(/1[,.]000[,.]000/);
  });
});

// ---------------------------------------------------------------------------
// RetentionCohorts (inline styles instead of Tailwind classes)
// ---------------------------------------------------------------------------

describe('RetentionCohorts', () => {
  it('renders empty state when no data', () => {
    render(<RetentionCohorts data={null} />);
    expect(screen.getByText(/no retention data/i)).toBeDefined();
  });

  it('renders empty state when retention array is empty', () => {
    render(<RetentionCohorts data={{ retention: [], weeks: 12 }} />);
    expect(screen.getByText(/no retention data/i)).toBeDefined();
  });

  it('renders cohort table with retention percentages', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [
        {
          cohortWeek: '2026-03-10',
          cohortSize: 10,
          weeks: [
            { week: 0, users: 10, rate: 100 },
            { week: 1, users: 5, rate: 50 },
            { week: 2, users: 3, rate: 30 },
          ],
        },
        {
          cohortWeek: '2026-03-17',
          cohortSize: 8,
          weeks: [
            { week: 0, users: 8, rate: 100 },
            { week: 1, users: 4, rate: 50 },
          ],
        },
      ],
      weeks: 12,
    };

    render(<RetentionCohorts data={data} />);

    // Column headers
    expect(screen.getByText('Cohort')).toBeDefined();
    expect(screen.getByText('Size')).toBeDefined();
    expect(screen.getByText('W0')).toBeDefined();
    expect(screen.getByText('W1')).toBeDefined();
    expect(screen.getByText('W2')).toBeDefined();

    // Cohort sizes
    expect(screen.getByText('10')).toBeDefined();
    expect(screen.getByText('8')).toBeDefined();

    // Retention percentages
    expect(screen.getAllByText('100%').length).toBe(2); // Both cohorts have 100% W0
    expect(screen.getAllByText('50%').length).toBe(2); // Both have 50% W1
    expect(screen.getByText('30%')).toBeDefined(); // First cohort W2
  });

  it('renders formatted week labels', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 5,
        weeks: [{ week: 0, users: 5, rate: 100 }],
      }],
      weeks: 4,
    };

    render(<RetentionCohorts data={data} />);
    // "2026-03-10" should be formatted as "Mar 10"
    expect(screen.getByText('Mar 10')).toBeDefined();
  });

  it('renders empty cells for weeks with no activity data', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 4,
        weeks: [
          { week: 0, users: 4, rate: 100 },
          { week: 2, users: 2, rate: 50 }, // gap at W1
        ],
      }],
      weeks: 4,
    };

    const { container } = render(<RetentionCohorts data={data} />);
    const cells = container.querySelectorAll('td');

    // cells[0]=size, cells[1]=W0, cells[2]=W1 (empty), cells[3]=W2
    const w1Cell = cells[2];
    expect(w1Cell?.textContent).toBe('');
  });

  it('applies correct heat-map inline styles for different retention rates', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 100,
        weeks: [
          { week: 0, users: 100, rate: 100 }, // >= 80 -> accent-primary bg
          { week: 1, users: 70, rate: 70 },   // >= 60 -> success bg
          { week: 2, users: 50, rate: 50 },   // >= 40 -> green 50% opacity
          { week: 3, users: 25, rate: 25 },   // >= 20 -> green 25% opacity
          { week: 4, users: 10, rate: 10 },   // > 0  -> green 10% opacity
          { week: 5, users: 0, rate: 0 },     // = 0  -> inset bg
        ],
      }],
      weeks: 8,
    };

    const { container } = render(<RetentionCohorts data={data} />);
    const allTds = container.querySelectorAll('td');
    // allTds[0]=size, allTds[1]=W0, allTds[2]=W1, ...
    const weekCells = Array.from(allTds).slice(1);

    // High retention cells (>=80) should have inline background-color style
    expect(weekCells[0]?.getAttribute('style')).toContain('background-color');
    expect(weekCells[0]?.getAttribute('style')).toContain('color');
    // Zero retention cell should have inset bg
    expect(weekCells[5]?.getAttribute('style')).toContain('background-color');
    // High and zero cells should have different background colors
    expect(weekCells[0]?.getAttribute('style')).not.toBe(weekCells[5]?.getAttribute('style'));
  });

  it('renders aria-label attributes with user counts for accessibility', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 10,
        weeks: [{ week: 0, users: 10, rate: 100 }],
      }],
      weeks: 4,
    };

    const { container } = render(<RetentionCohorts data={data} />);
    const w0Cell = container.querySelector('td[aria-label*="Week 0"]');
    expect(w0Cell).not.toBeNull();
    expect(w0Cell?.getAttribute('aria-label')).toContain('10 users');
    expect(w0Cell?.getAttribute('aria-label')).toContain('100%');
  });

  it('column headers go from W0 up to max week offset in data', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 5,
        weeks: [
          { week: 0, users: 5, rate: 100 },
          { week: 1, users: 3, rate: 60 },
          { week: 2, users: 1, rate: 20 },
        ],
      }],
      weeks: 12,
    };

    render(<RetentionCohorts data={data} />);
    expect(screen.getByText('W0')).toBeDefined();
    expect(screen.getByText('W1')).toBeDefined();
    expect(screen.getByText('W2')).toBeDefined();
    expect(screen.queryByText('W3')).toBeNull();
  });

  it('handles a cohort date string that is not parseable', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: 'not-a-date',
        cohortSize: 5,
        weeks: [{ week: 0, users: 5, rate: 100 }],
      }],
      weeks: 4,
    };

    render(<RetentionCohorts data={data} />);
    expect(screen.getByText('not-a-date')).toBeDefined();
  });

  it('renders a single-cohort single-week table without crashing', () => {
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-24',
        cohortSize: 1,
        weeks: [{ week: 0, users: 1, rate: 100 }],
      }],
      weeks: 1,
    };

    const { container } = render(<RetentionCohorts data={data} />);
    expect(container.querySelector('table')).toBeDefined();
    expect(screen.getByText('100%')).toBeDefined();
  });
});
