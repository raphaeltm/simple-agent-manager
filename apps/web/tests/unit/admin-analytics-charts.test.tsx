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
// FeatureAdoptionChart
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

  it('renders feature bars with counts and user labels', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [
        { event_name: 'task_submitted', count: 42, unique_users: 10 },
        { event_name: 'project_created', count: 15, unique_users: 8 },
      ],
      trend: [
        { event_name: 'task_submitted', date: '2026-03-25', count: 5 },
        { event_name: 'task_submitted', date: '2026-03-26', count: 8 },
      ],
      period: '7d',
    };

    render(<FeatureAdoptionChart data={data} />);

    // Check labels are rendered
    expect(screen.getByText('Submit Task')).toBeDefined();
    expect(screen.getByText('Create Project')).toBeDefined();

    // Check counts rendered
    expect(screen.getByText('42')).toBeDefined();
    expect(screen.getByText('15')).toBeDefined();

    // Check user counts
    expect(screen.getByText('10 users')).toBeDefined();
    expect(screen.getByText('8 users')).toBeDefined();
  });

  it('renders sparkline SVG when trend has multiple points', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [{ event_name: 'task_submitted', count: 10, unique_users: 5 }],
      trend: [
        { event_name: 'task_submitted', date: '2026-03-25', count: 3 },
        { event_name: 'task_submitted', date: '2026-03-26', count: 7 },
      ],
      period: '7d',
    };

    const { container } = render(<FeatureAdoptionChart data={data} />);
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBe(1);
  });

  it('does not render sparkline when trend has only one data point', () => {
    // A single-point sparkline would divide by zero in the x-axis calculation:
    // x = (i / (data.length - 1)) * width -> 0/0 = NaN
    // The component gates sparkline rendering on sparkData.length > 1.
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [{ event_name: 'task_submitted', count: 10, unique_users: 5 }],
      trend: [{ event_name: 'task_submitted', date: '2026-03-25', count: 3 }],
      period: '7d',
    };

    const { container } = render(<FeatureAdoptionChart data={data} />);
    expect(container.querySelectorAll('svg').length).toBe(0);
  });

  it('does not render sparkline when trend is empty', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [{ event_name: 'task_submitted', count: 10, unique_users: 5 }],
      trend: [],
      period: '7d',
    };

    const { container } = render(<FeatureAdoptionChart data={data} />);
    expect(container.querySelectorAll('svg').length).toBe(0);
  });

  it('renders one sparkline per event that has multiple trend points', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [
        { event_name: 'task_submitted', count: 10, unique_users: 5 },
        { event_name: 'project_created', count: 4, unique_users: 3 },
      ],
      trend: [
        { event_name: 'task_submitted', date: '2026-03-25', count: 3 },
        { event_name: 'task_submitted', date: '2026-03-26', count: 7 },
        { event_name: 'project_created', date: '2026-03-25', count: 2 },
        { event_name: 'project_created', date: '2026-03-26', count: 2 },
      ],
      period: '7d',
    };

    const { container } = render(<FeatureAdoptionChart data={data} />);
    // Both events have 2 trend points, so both should have sparklines
    expect(container.querySelectorAll('svg').length).toBe(2);
  });

  it('falls back to raw event_name when no label mapping exists', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [{ event_name: 'unknown_event_xyz', count: 1, unique_users: 1 }],
      trend: [],
      period: '30d',
    };

    render(<FeatureAdoptionChart data={data} />);
    // The raw event name should appear because EVENT_LABELS has no entry for it
    expect(screen.getByText('unknown_event_xyz')).toBeDefined();
  });

  it('renders all 13 known feature event labels when all are present', () => {
    const allEvents = [
      { event_name: 'project_created', label: 'Create Project' },
      { event_name: 'project_deleted', label: 'Delete Project' },
      { event_name: 'workspace_created', label: 'Create Workspace' },
      { event_name: 'workspace_started', label: 'Start Workspace' },
      { event_name: 'workspace_stopped', label: 'Stop Workspace' },
      { event_name: 'task_submitted', label: 'Submit Task' },
      { event_name: 'task_completed', label: 'Task Completed' },
      { event_name: 'task_failed', label: 'Task Failed' },
      { event_name: 'node_created', label: 'Create Node' },
      { event_name: 'node_deleted', label: 'Delete Node' },
      { event_name: 'credential_saved', label: 'Save Credential' },
      { event_name: 'session_created', label: 'Create Session' },
      { event_name: 'settings_changed', label: 'Change Settings' },
    ];

    const data: AnalyticsFeatureAdoptionResponse = {
      totals: allEvents.map(({ event_name }) => ({
        event_name,
        count: 1,
        unique_users: 1,
      })),
      trend: [],
      period: '30d',
    };

    render(<FeatureAdoptionChart data={data} />);

    for (const { label } of allEvents) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('renders large counts with locale formatting', () => {
    const data: AnalyticsFeatureAdoptionResponse = {
      totals: [{ event_name: 'task_submitted', count: 1_234_567, unique_users: 50_000 }],
      trend: [],
      period: '30d',
    };

    render(<FeatureAdoptionChart data={data} />);
    // toLocaleString() should produce locale-formatted output
    // The exact separator character depends on locale, but the number should appear
    expect(screen.getByText(/1.234.567|1,234,567/)).toBeDefined();
    expect(screen.getByText(/50.000 users|50,000 users/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GeoDistribution
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

  it('renders country rows with counts and percentages', () => {
    const data: AnalyticsGeoResponse = {
      geo: [
        { country: 'US', event_count: 100, unique_users: 20 },
        { country: 'DE', event_count: 50, unique_users: 10 },
        { country: 'CA', event_count: 30, unique_users: 5 },
      ],
      period: '7d',
    };

    render(<GeoDistribution data={data} />);

    // Country codes
    expect(screen.getByText('US')).toBeDefined();
    expect(screen.getByText('DE')).toBeDefined();
    expect(screen.getByText('CA')).toBeDefined();

    // User counts in bars
    expect(screen.getByText('20')).toBeDefined();
    expect(screen.getByText('10')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();

    // Event counts
    expect(screen.getByText('100 events')).toBeDefined();
    expect(screen.getByText('50 events')).toBeDefined();

    // Percentages (US: 20/35 ≈ 57%, DE: 10/35 ≈ 29%, CA: 5/35 ≈ 14%)
    expect(screen.getByText('57%')).toBeDefined();
    expect(screen.getByText('29%')).toBeDefined();
    expect(screen.getByText('14%')).toBeDefined();
  });

  it('renders a single country row correctly (no division-by-zero)', () => {
    const data: AnalyticsGeoResponse = {
      geo: [{ country: 'GB', event_count: 200, unique_users: 40 }],
      period: '30d',
    };

    render(<GeoDistribution data={data} />);
    expect(screen.getByText('GB')).toBeDefined();
    expect(screen.getByText('40')).toBeDefined();
    // Single entry — 100% share
    expect(screen.getByText('100%')).toBeDefined();
  });

  it('percentages round to nearest integer and sum to ~100', () => {
    // 3 equal countries — each 33% (rounding loses 1%)
    const data: AnalyticsGeoResponse = {
      geo: [
        { country: 'US', event_count: 100, unique_users: 10 },
        { country: 'DE', event_count: 100, unique_users: 10 },
        { country: 'FR', event_count: 100, unique_users: 10 },
      ],
      period: '30d',
    };

    render(<GeoDistribution data={data} />);
    // Each should be 33% (Math.round(10/30 * 100) = 33)
    const pctCells = screen.getAllByText('33%');
    expect(pctCells.length).toBe(3);
  });

  it('renders a large list without overflow or missing rows', () => {
    const geo = Array.from({ length: 50 }, (_, i) => ({
      country: `C${String(i).padStart(2, '0')}`,
      event_count: 100 - i,
      unique_users: 50 - i,
    }));

    const data: AnalyticsGeoResponse = { geo, period: '30d' };
    const { container } = render(<GeoDistribution data={data} />);

    // All 50 rows are present
    const rows = container.querySelectorAll('.flex.items-center.gap-3');
    expect(rows.length).toBe(50);
  });

  it('renders event counts with locale formatting for large numbers', () => {
    const data: AnalyticsGeoResponse = {
      geo: [{ country: 'US', event_count: 1_000_000, unique_users: 5_000 }],
      period: '30d',
    };

    render(<GeoDistribution data={data} />);
    expect(screen.getByText(/1.000.000 events|1,000,000 events/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// RetentionCohorts
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
    // A cohort that has W0 and W2 but no W1 — W1 cell should render empty string.
    // Row structure: <th scope="row">date</th> <td>size</td> <td>W0</td> <td>W1</td> <td>W2</td>
    // querySelectorAll('td') returns: [size, W0, W1, W2] (the <th scope="row"> is not a <td>)
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

  it('applies correct heat-map color classes for different retention rates', () => {
    // Row structure: <th scope="row">date</th> <td>size</td> <td>W0..W5</td>
    // querySelectorAll('td') returns: [size, W0, W1, W2, W3, W4, W5]
    // The date cell uses <th scope="row">, NOT <td>, so it is excluded from the td list.
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 100,
        weeks: [
          { week: 0, users: 100, rate: 100 }, // >= 80 -> bg-green-600 text-white
          { week: 1, users: 70, rate: 70 },   // >= 60 -> bg-green-500 text-white
          { week: 2, users: 50, rate: 50 },   // >= 40 -> bg-green-400 text-white
          { week: 3, users: 25, rate: 25 },   // >= 20 -> bg-green-300 text-green-900
          { week: 4, users: 10, rate: 10 },   // > 0  -> bg-green-200 text-green-900
          { week: 5, users: 0, rate: 0 },     // = 0  -> bg-surface-secondary text-fg-muted
        ],
      }],
      weeks: 8,
    };

    const { container } = render(<RetentionCohorts data={data} />);
    const allTds = container.querySelectorAll('td');
    // allTds[0]=size, allTds[1]=W0, allTds[2]=W1, ...
    const weekCells = Array.from(allTds).slice(1);

    expect(weekCells[0]?.className).toContain('bg-green-600');
    expect(weekCells[1]?.className).toContain('bg-green-500');
    expect(weekCells[2]?.className).toContain('bg-green-400');
    expect(weekCells[3]?.className).toContain('bg-green-300');
    expect(weekCells[4]?.className).toContain('bg-green-200');
    expect(weekCells[5]?.className).toContain('bg-surface-secondary');
  });

  it('renders aria-label attributes with user counts for accessibility', () => {
    // The component uses aria-label (not title) on week cells:
    // aria-label={`Week ${i}: ${weekData?.users ?? 0} users, ${rate}%, ${tier}`}
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: '2026-03-10',
        cohortSize: 10,
        weeks: [{ week: 0, users: 10, rate: 100 }],
      }],
      weeks: 4,
    };

    const { container } = render(<RetentionCohorts data={data} />);
    // W0 cell should have an aria-label attribute for accessibility
    const w0Cell = container.querySelector('td[aria-label*="Week 0"]');
    expect(w0Cell).not.toBeNull();
    expect(w0Cell?.getAttribute('aria-label')).toContain('10 users');
    expect(w0Cell?.getAttribute('aria-label')).toContain('100%');
  });

  it('column headers go from W0 up to max week offset in data', () => {
    // Cohort has weeks 0,1,2 — displayWeeks should be 2, so headers are W0, W1, W2
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
    // formatWeekLabel should fall back to the raw string when Date is invalid
    const data: AnalyticsRetentionResponse = {
      retention: [{
        cohortWeek: 'not-a-date',
        cohortSize: 5,
        weeks: [{ week: 0, users: 5, rate: 100 }],
      }],
      weeks: 4,
    };

    render(<RetentionCohorts data={data} />);
    // The raw string should appear as-is
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
