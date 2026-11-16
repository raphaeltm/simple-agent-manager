/**
 * Admin Health & cost page: renders the read's numbers, asks for the range the admin picks while
 * keeping the previous range on screen, links an open watchdog incident, and recovers from a
 * failed first load.
 */
import type { InstallationHealthResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'admin-1', email: 'a@example.com', name: 'Admin' } }),
}));

const mocks = vi.hoisted(() => ({ getInstallationHealth: vi.fn() }));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getInstallationHealth: mocks.getInstallationHealth,
}));

import { AdminHealthCost } from '../../../src/pages/AdminHealthCost';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

function health(overrides: Partial<InstallationHealthResponse> = {}): InstallationHealthResponse {
  return {
    window: { range: 'month', start: '2026-11-01T00:00:00.000Z', end: '2026-11-16T12:00:00.000Z' },
    generatedAt: '2026-11-16T12:00:00.000Z',
    compute: {
      currency: 'USD',
      totalUsd: 412.4,
      byProvider: [
        { provider: 'hetzner', usd: 291.25, nodeHours: 3000, nodes: 40 },
        { provider: 'gcp', usd: 121.25, nodeHours: 300, nodes: 6 },
      ],
      weeks: [
        {
          weekStart: '2026-11-09T00:00:00.000Z',
          totalUsd: 100,
          byProvider: [{ provider: 'hetzner', usd: 100 }],
        },
        {
          weekStart: '2026-11-16T00:00:00.000Z',
          totalUsd: 20,
          byProvider: [{ provider: 'gcp', usd: 20 }],
        },
      ],
      unpricedNodes: 2,
      nodes: 48,
      truncated: false,
    },
    reuse: {
      placements: 100,
      onExistingMachine: 61,
      onNewMachine: 39,
      fromWarmPool: 7,
      reuseRate: 0.61,
      weeks: [
        { weekStart: '2026-11-09T00:00:00.000Z', placements: 80, reuseRate: 0.5 },
        { weekStart: '2026-11-16T00:00:00.000Z', placements: 20, reuseRate: 0.7 },
      ],
      truncated: false,
    },
    density: {
      agentsPerBusyMachine: 2.43,
      busyMachineHours: 120,
      agentHours: 291.6,
      peakAgentsOnOneMachine: 6,
      machines: 12,
      runs: 300,
      truncated: false,
    },
    newMachines: {
      newMachines: 39,
      reasons: [
        { reason: 'Host agent version is incompatible', kind: 'refused', machines: 20 },
        { reason: 'No other machine in the pool to try', kind: 'no_candidate', machines: 5 },
      ],
    },
    latency: {
      minSamples: 5,
      states: [
        {
          entityType: 'workspace',
          status: 'stopping',
          budgetMs: 600_000,
          count: 14,
          p50Ms: 900_000,
          p95Ms: 1_860_000,
          maxMs: 2_000_000,
          truncated: false,
          overBudget: true,
          overBudgetNow: 3,
          incidents: [
            {
              signature: 'sig',
              state: 'pending',
              firstSeenAt: '2026-11-16T09:12:00.000Z',
              lastSeenAt: '2026-11-16T11:00:00.000Z',
              occurrences: 14,
              ideaId: 'idea-1',
              ideaProjectId: 'ops-project',
            },
          ],
        },
        {
          entityType: 'node',
          status: 'creating',
          budgetMs: 900_000,
          count: 0,
          p50Ms: null,
          p95Ms: null,
          maxMs: null,
          truncated: false,
          overBudget: false,
          overBudgetNow: 0,
          incidents: [],
        },
      ],
    },
    unavailable: [],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/health-cost']}>
      <AdminHealthCost />
    </MemoryRouter>,
    { wrapper: QueryTestWrapper }
  );
}

describe('AdminHealthCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows spend, reuse, density, reasons and latency from the read', async () => {
    mocks.getInstallationHealth.mockResolvedValue(health());
    renderPage();

    const compute = await screen.findByTestId('stat-compute');
    expect(within(compute).getByText('$412')).toBeInTheDocument();
    expect(
      within(compute).getByText(/Hetzner \$291 · Google Cloud \$121.*2 without a price/)
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-reuse')).getByText('61%')).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-density')).getByText('2.4')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Host agent version is incompatible: 20 machines')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Week of Nov 9: $100 (Hetzner $100)')).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        'Stop a workspace: p95 31m 00s, budget 10m 00s, 14 episodes, over budget'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Start a machine: no finished episodes, budget 15m 00s')
    ).toBeInTheDocument();
    expect(mocks.getInstallationHealth).toHaveBeenCalledWith('month', expect.anything());
  });

  it('links the open watchdog incident for an over-budget state', async () => {
    mocks.getInstallationHealth.mockResolvedValue(health());
    renderPage();

    const link = await screen.findByRole('link', { name: 'Open incident' });
    expect(link).toHaveAttribute('href', '/projects/ops-project/ideas/idea-1');
    expect(screen.getByText(/3 past budget right now/)).toBeInTheDocument();
  });

  it('asks for the picked range and keeps the previous numbers on screen meanwhile', async () => {
    let resolve7d: (value: InstallationHealthResponse) => void = () => undefined;
    mocks.getInstallationHealth.mockImplementation((range: string) =>
      range === '7d'
        ? new Promise<InstallationHealthResponse>((r) => {
            resolve7d = r;
          })
        : Promise.resolve(health())
    );
    renderPage();
    await screen.findByText('$412');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() =>
      expect(mocks.getInstallationHealth).toHaveBeenCalledWith('7d', expect.anything())
    );
    expect(screen.getByText('$412')).toBeInTheDocument(); // stale while the new range loads
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');

    resolve7d(
      health({
        window: { range: '7d', start: '2026-11-09T12:00:00.000Z', end: '2026-11-16T12:00:00.000Z' },
        compute: { ...health().compute!, totalUsd: 88 },
      })
    );
    expect(await screen.findByText('$88.00')).toBeInTheDocument();
    expect(screen.getByText(/This installation · Last 7 days/)).toBeInTheDocument();
    expect(screen.getByText('Compute · Last 7 days')).toBeInTheDocument();
  });

  it('names a section that could not be read and still shows the others', async () => {
    mocks.getInstallationHealth.mockResolvedValue(
      health({ latency: null, unavailable: ['latency'] })
    );
    renderPage();

    expect(
      await screen.findByText(/Not available right now: lifecycle latency/)
    ).toBeInTheDocument();
    expect(screen.getByText('Lifecycle latency could not be read just now.')).toBeInTheDocument();
    expect(screen.getByText('$412')).toBeInTheDocument();
  });

  it('shows an error with a retry that loads the page', async () => {
    mocks.getInstallationHealth.mockRejectedValueOnce(new Error('Superadmin access required'));
    mocks.getInstallationHealth.mockResolvedValue(health());
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Superadmin access required');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$412')).toBeInTheDocument();
  });
});
