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
});
