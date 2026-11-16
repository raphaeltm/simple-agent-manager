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

const mocks = vi.hoisted(() => ({
  getInstallationHealth: vi.fn(),
  refreshCloudflareCost: vi.fn(),
}));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getInstallationHealth: mocks.getInstallationHealth,
  refreshCloudflareCost: mocks.refreshCloudflareCost,
}));

import { ToastProvider } from '../../../src/hooks/useToast';
import { AdminHealthCost } from '../../../src/pages/AdminHealthCost';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

function health(overrides: Partial<InstallationHealthResponse> = {}): InstallationHealthResponse {
  return {
    window: { range: 'month', start: '2026-11-01T00:00:00.000Z', end: '2026-11-16T12:00:00.000Z' },
    generatedAt: '2026-11-16T12:00:00.000Z',
    compute: {
      currencies: [
        {
          currency: 'USD',
          total: 412.4,
          byProvider: [
            { provider: 'hetzner', amount: 291.25, nodeHours: 3000, nodes: 40 },
            { provider: 'gcp', amount: 121.25, nodeHours: 300, nodes: 6 },
          ],
          weeks: [
            {
              weekStart: '2026-11-09T00:00:00.000Z',
              total: 100,
              byProvider: [{ provider: 'hetzner', amount: 100 }],
            },
            {
              weekStart: '2026-11-16T00:00:00.000Z',
              total: 20,
              byProvider: [{ provider: 'gcp', amount: 20 }],
            },
          ],
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
      otherReasons: 3,
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
    cloudflare: cloudflare(),
    unavailable: [],
    ...overrides,
  };
}

function cloudflare(
  overrides: Partial<NonNullable<InstallationHealthResponse['cloudflare']>> = {}
): NonNullable<InstallationHealthResponse['cloudflare']> {
  return {
    status: 'ok',
    lastAttemptAt: '2026-11-16T03:00:05.000Z',
    lastSuccessAt: '2026-11-16T03:00:05.000Z',
    error: null,
    month: '2026-11',
    throughDay: '2026-11-15',
    monthComplete: false,
    missingDays: 0,
    monthToDateUsd: 18.41,
    projectedUsd: 36.9,
    productLines: [
      {
        key: 'doRowsWritten',
        product: 'Durable Objects',
        label: 'Durable Objects SQLite rows written',
        unit: 'rows',
        monthToDateUsage: 25_710_000,
        monthToDateUsd: 4.2,
        projectedUsd: 9.39,
      },
      {
        key: 'workersAiNeurons',
        product: 'Workers AI',
        label: 'Workers AI neurons',
        unit: 'neurons',
        monthToDateUsage: 272_240,
        monthToDateUsd: 1.6,
        projectedUsd: 3.4,
      },
    ],
    otherProductLines: { count: 17, monthToDateUsd: 12.61, projectedUsd: 24.11 },
    daily: [
      { day: '2026-11-14', costUsd: null },
      { day: '2026-11-15', costUsd: 1.25 },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/health-cost']}>
      <ToastProvider>
        <AdminHealthCost />
      </ToastProvider>
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
    // Visible text (with screen-reader suffixes) carries every number, not aria-label alone.
    const reasonRows = screen.getAllByTestId('reason-row');
    expect(reasonRows[0]).toHaveTextContent('Host agent version is incompatible20 machines');
    expect(screen.getByTestId('other-reasons')).toHaveTextContent(
      '3 less common reasons not listed.'
    );
    expect(screen.getByLabelText('Week of Nov 9: $100 (Hetzner $100)')).toBeInTheDocument();
    const latencyRows = screen.getAllByTestId('latency-row');
    expect(latencyRows[0]).toHaveTextContent(
      'Stop a workspacep95 31m 00s ✕, budget 10m 00s, 14 episodes, over budget'
    );
    expect(latencyRows[1]).toHaveTextContent('Start a machineno data, budget 15m 00s');
    expect(screen.getByTestId('latency-sampling-note')).toHaveTextContent('lower bounds');
    expect(mocks.getInstallationHealth).toHaveBeenCalledWith('month', expect.anything());
  });

  it('lists every week in a table for readers who cannot hover the chart', async () => {
    mocks.getInstallationHealth.mockResolvedValue(health());
    renderPage();

    const table = await screen.findByTestId('spend-table-USD');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + two weeks
    expect(rows[1]).toHaveTextContent('Nov 9$100Hetzner $100');
    expect(rows[2]).toHaveTextContent('Nov 16$20.00Google Cloud $20.00');
  });

  it('shows each price currency on its own, never added together', async () => {
    const week = (weekStart: string, provider: string, amount: number) => ({
      weekStart,
      total: amount,
      byProvider: [{ provider, amount }],
    });
    mocks.getInstallationHealth.mockResolvedValue(
      health({
        compute: {
          currencies: [
            {
              currency: 'EUR',
              total: 1234,
              byProvider: [{ provider: 'hetzner', amount: 1234, nodeHours: 9000, nodes: 244 }],
              weeks: [week('2026-11-16T00:00:00.000Z', 'hetzner', 300)],
            },
            {
              currency: 'USD',
              total: 56.5,
              byProvider: [{ provider: 'gcp', amount: 56.5, nodeHours: 90, nodes: 52 }],
              weeks: [week('2026-11-16T00:00:00.000Z', 'gcp', 20)],
            },
          ],
          unpricedNodes: 0,
          nodes: 296,
          truncated: false,
        },
      })
    );
    renderPage();

    const compute = await screen.findByTestId('stat-compute');
    expect(within(compute).getByText('€1,234 · $56.50')).toBeInTheDocument();
    expect(compute).toHaveTextContent('Hetzner €1,234 · Google Cloud $56.50');
    expect(compute).not.toHaveTextContent('without a price');
    expect(screen.getByTestId('spend-chart-EUR')).toHaveTextContent('Priced in EUR');
    expect(screen.getByTestId('spend-table-EUR')).toHaveTextContent('€300');
    expect(screen.getByTestId('spend-table-USD')).toHaveTextContent('$20.00');
    expect(
      screen.getByLabelText('Week of Nov 16: $20.00 (Google Cloud $20.00)')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Week of Nov 16: €300 (Hetzner €300)')).toBeInTheDocument();
  });

  it('gives the warm-pool part of reuse under the reuse rate', async () => {
    mocks.getInstallationHealth.mockResolvedValue(health());
    renderPage();

    const reuse = await screen.findByTestId('stat-reuse');
    expect(reuse).toHaveTextContent(
      '61 of 100 placements on an existing machine · 7 from the warm pool'
    );
  });

  it('leaves out the warm-pool part when that count could not be read', async () => {
    mocks.getInstallationHealth.mockResolvedValue(
      health({ reuse: { ...health().reuse!, fromWarmPool: null } })
    );
    renderPage();

    const reuse = await screen.findByTestId('stat-reuse');
    expect(reuse).toHaveTextContent('61 of 100 placements on an existing machine');
    expect(reuse).not.toHaveTextContent('warm pool');
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
        compute: {
          ...health().compute!,
          currencies: [{ ...health().compute!.currencies[0]!, total: 88 }],
        },
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

  it('shows the Cloudflare month to date, projection and top lines as an estimate, apart from compute', async () => {
    mocks.getInstallationHealth.mockResolvedValue(health());
    renderPage();

    const tile = await screen.findByTestId('stat-cloudflare');
    expect(tile).toHaveTextContent(
      'Cloudflare · estimated$18.41November so far · projected $36.90'
    );
    // Compute stays per currency; the Cloudflare dollars are never folded into it.
    expect(within(screen.getByTestId('stat-compute')).getByText('$412')).toBeInTheDocument();
    const pane = screen.getByTestId('cloudflare-pane');
    expect(pane).toHaveTextContent('estimate from usage · whole account');
    expect(pane).toHaveTextContent('November through Nov 15 · projected $36.90 for November');
    expect(pane).toHaveTextContent('not an invoice');
    const lines = screen.getAllByTestId('cloudflare-line');
    expect(lines[0]).toHaveTextContent('Durable Objects SQLite rows written$4.20 → $9.39');
    expect(screen.getByTestId('cloudflare-other')).toHaveTextContent(
      'Everything else (17 lines): $12.61 → $24.11'
    );
    expect(screen.getByLabelText('Nov 14: no data')).toBeInTheDocument();
    expect(screen.getByLabelText('Nov 15: $1.25')).toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-status')).not.toBeInTheDocument();
  });

  it('explains what to set when the Cloudflare credential is missing, without an error', async () => {
    mocks.getInstallationHealth.mockResolvedValue(
      health({
        cloudflare: cloudflare({
          status: 'not_configured',
          lastSuccessAt: null,
          month: null,
          throughDay: null,
          monthToDateUsd: 0,
          projectedUsd: 0,
          productLines: [],
          otherProductLines: { count: 0, monthToDateUsd: 0, projectedUsd: 0 },
          daily: [],
        }),
      })
    );
    renderPage();

    const status = await screen.findByTestId('cloudflare-status');
    expect(status).toHaveTextContent('CF_API_TOKEN and CF_ACCOUNT_ID');
    expect(status).toHaveTextContent('Account → Account Analytics → Read');
    expect(screen.getByTestId('stat-cloudflare')).toHaveTextContent('Not set up');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The rest of the page still renders.
    expect(screen.getByText('$412')).toBeInTheDocument();
  });

  it('says the token lacks analytics permission and keeps earlier days on screen', async () => {
    mocks.getInstallationHealth.mockResolvedValue(
      health({ cloudflare: cloudflare({ status: 'permission_denied', missingDays: 3 }) })
    );
    renderPage();

    expect(await screen.findByTestId('cloudflare-status')).toHaveTextContent(
      'cannot read account analytics'
    );
    expect(screen.getByTestId('cloudflare-missing')).toHaveTextContent(
      '3 days of November have no data and count as $0.'
    );
    expect(screen.getAllByTestId('cloudflare-line')).toHaveLength(2);
  });

  it('runs the snapshot on Refresh now and reloads the numbers without blanking the page', async () => {
    mocks.getInstallationHealth.mockResolvedValueOnce(
      health({ cloudflare: cloudflare({ status: 'never_run', month: null, daily: [] }) })
    );
    mocks.getInstallationHealth.mockResolvedValue(health());
    let finish: (value: unknown) => void = () => undefined;
    mocks.refreshCloudflareCost.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    renderPage();

    expect(await screen.findByTestId('cloudflare-status')).toHaveTextContent('No snapshot yet');
    fireEvent.click(screen.getByTestId('cloudflare-refresh'));
    await waitFor(() => expect(mocks.refreshCloudflareCost).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('cloudflare-refresh')).toBeDisabled();
    // While the snapshot runs, the page keeps what it showed.
    expect(screen.getByText('$412')).toBeInTheDocument();

    finish({
      status: 'ok',
      firstDay: '2026-10-17',
      lastDay: '2026-11-15',
      rowsWritten: 570,
      error: null,
    });
    expect(await screen.findByText('Cloudflare cost updated')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('stat-cloudflare')).toHaveTextContent('$18.41'));
    expect(mocks.getInstallationHealth).toHaveBeenCalledTimes(2);
  });

  it('names the Cloudflare section when it could not be read', async () => {
    mocks.getInstallationHealth.mockResolvedValue(
      health({ cloudflare: null, unavailable: ['cloudflare'] })
    );
    renderPage();

    expect(await screen.findByText(/Not available right now: Cloudflare cost/)).toBeInTheDocument();
    expect(screen.getByText('Cloudflare cost could not be read just now.')).toBeInTheDocument();
  });
});
