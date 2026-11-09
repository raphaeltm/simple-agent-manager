/**
 * The compute pool editor (tasks/active/2026-11-09-compute-pool-editor-redesign.md), driven
 * through the real panel with the API mocked at the client boundary. jsdom applies no CSS, so
 * the desktop table and the mobile list are both in the DOM: controls are found with getAll.
 */
import type {
  CapacityPoolCandidate,
  DefaultCapacityPoolSummary,
  ProviderCatalog,
} from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DefaultCapacityPoolsPanel } from '../../../src/components/project-settings/DefaultCapacityPoolsPanel';
import { ApiClientError } from '../../../src/lib/api/client';
import { candidate, providerCatalog, response, summary } from './compute-pool-fixtures';

const mocks = vi.hoisted(() => ({
  fetchProjectDefaultCapacityPools: vi.fn(),
  updateProjectDefaultCapacityPools: vi.fn(),
  providerCatalogs: [] as ProviderCatalog[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../src/hooks/useProviderCatalog', () => ({
  useProviderCatalog: () => ({
    catalogs: mocks.providerCatalogs,
    catalog: mocks.providerCatalogs[0] ?? null,
    loading: false,
    isRefreshing: false,
  }),
}));
vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../../src/lib/api/capacity-pools', () => ({
  fetchProjectDefaultCapacityPools: mocks.fetchProjectDefaultCapacityPools,
  fetchUserDefaultCapacityPools: vi.fn(),
  fetchInstallationDefaultCapacityPools: vi.fn(),
  reconcileProjectDefaultCapacityPools: vi.fn(),
  reconcileUserDefaultCapacityPools: vi.fn(),
  reconcileInstallationDefaultCapacityPools: vi.fn(),
  updateProjectDefaultCapacityPools: mocks.updateProjectDefaultCapacityPools,
  updateUserDefaultCapacityPools: vi.fn(),
  updateInstallationDefaultCapacityPools: vi.fn(),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<DefaultCapacityPoolsPanel projectId="project-1" />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    ),
  });
}

const GCP_SOURCE = 'source-gcp';

function gcpCatalog(): ProviderCatalog {
  return {
    provider: 'gcp',
    credentialSource: 'project',
    credentialId: 'credential-gcp',
    locations: [],
    sizes: {} as ProviderCatalog['sizes'],
    offerings: ['europe-west1-b', 'europe-west1-c', 'us-central1-a'].map((location) => ({
      provider: 'gcp' as const,
      providerInstanceType: 'e2-standard-4',
      providerInstanceSku: null,
      displayName: 'e2-standard-4',
      sku: 'e2-standard-4',
      location,
      vcpu: 4,
      memoryMb: 16_384,
      memoryGb: 16,
      diskGb: 50,
      price: location.startsWith('us') ? '$90.00/mo' : '$97.09/mo',
      priceMonthly: location.startsWith('us') ? 90 : 97.09,
      currency: 'USD',
      available: true,
      catalogSource: 'api' as const,
      catalogLastSeenAt: '2026-11-09T00:00:00.000Z',
    })),
    defaultLocation: 'us-central1-a',
  };
}

function gcpRow(location: string, status: CapacityPoolCandidate['status']): CapacityPoolCandidate {
  return candidate({
    id: `gcp-${location}`,
    capacitySourceId: GCP_SOURCE,
    provider: 'gcp',
    location,
    machineSize: null,
    providerInstanceType: 'e2-standard-4',
    providerInstanceVcpuCount: 4,
    providerInstanceMemoryMb: 16_384,
    providerInstanceDiskGb: 50,
    providerInstancePriceDisplay: location.startsWith('us') ? '$90.00/mo' : '$97.09/mo',
    providerInstancePriceCurrency: 'USD',
    status,
  });
}

/** A project pool with a Hetzner key and a named GCP connection. */
function twoAccountPool(
  overrides: {
    gcpStatus?: CapacityPoolCandidate['status'];
    gcpSourceStatus?: 'active' | 'disabled';
    excluded?: string[];
  } = {}
): DefaultCapacityPoolSummary {
  const pool = summary('project');
  const base = pool.sources[0]!;
  pool.pool.excludedSourceIds = overrides.excluded ?? [];
  pool.sources = [
    base,
    {
      ...base,
      id: GCP_SOURCE,
      provider: 'gcp',
      credentialId: 'credential-gcp',
      label: 'SAM GCP Prod',
      status: overrides.gcpSourceStatus ?? 'active',
    },
  ];
  pool.candidates = [
    ...pool.candidates,
    gcpRow('europe-west1-b', overrides.gcpStatus ?? 'active'),
    gcpRow('europe-west1-c', overrides.gcpStatus ?? 'active'),
    gcpRow('us-central1-a', 'disabled'),
  ];
  return pool;
}

function load(pool: DefaultCapacityPoolSummary) {
  mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', pool));
  mocks.updateProjectDefaultCapacityPools.mockResolvedValue(response('project', pool));
}

async function click(name: string) {
  const [button] = await screen.findAllByRole('button', { name });
  fireEvent.click(button!);
}

async function save() {
  await click('Save changes');
  await waitFor(() => expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledTimes(1));
  return mocks.updateProjectDefaultCapacityPools.mock.calls[0]![1];
}

describe('compute pool editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerCatalogs = [providerCatalog(), gcpCatalog()];
  });

  it('lists one row per machine and region, with native-currency prices and no legacy size names', async () => {
    load(twoAccountPool());
    renderPanel();
    expect((await screen.findAllByRole('button', { name: 'Add ccx33 in Hillsboro' })).length).toBe(
      2
    );
    // GCP zones fold into regions: Belgium is one row whatever its zones.
    expect(
      screen.getAllByRole('button', { name: 'Remove e2-standard-4 in Belgium' })
    ).not.toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Add e2-standard-4 in Iowa' })).not.toHaveLength(
      0
    );
    expect(screen.getAllByText('€55.20/mo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$90.00/mo').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\b(small|medium|large)\b/i)).toBeNull();
    expect(screen.getAllByText('Google Cloud · SAM GCP Prod').length).toBeGreaterThan(0);
  });

  it('adds a catalog row and removes a picked one in a single save', async () => {
    load(twoAccountPool());
    renderPanel();
    await click('Add ccx33 in Hillsboro');
    await click('Remove cpx31 in Ashburn');
    expect(screen.getByText('2 unsaved changes')).toBeInTheDocument();
    expect(await save()).toEqual({
      candidates: [{ id: 'candidate-project-cpx31', status: 'deleted' }],
      catalogAdditions: [
        {
          sourceId: 'source-project',
          provider: 'hetzner',
          location: 'hil',
          providerInstanceType: 'ccx33',
          providerInstanceSku: null,
        },
      ],
    });
  });

  it('adds every zone of a region', async () => {
    load(twoAccountPool({ gcpStatus: 'disabled' }));
    renderPanel();
    await click('Add e2-standard-4 in Belgium');
    expect(await save()).toEqual({
      candidates: [
        { id: 'gcp-europe-west1-b', status: 'active' },
        { id: 'gcp-europe-west1-c', status: 'active' },
      ],
    });
  });

  it('warns that an empty pool runs only Instant sessions, until a machine is added', async () => {
    const empty = summary('project');
    empty.candidates = empty.candidates.map((row) => ({ ...row, status: 'disabled' as const }));
    load(empty);
    renderPanel();
    expect(await screen.findByText('Empty · Instant sessions only')).toBeInTheDocument();
    expect(
      screen.getByText('Your pool is empty, so only Instant sessions can run.')
    ).toBeInTheDocument();
    await click('Add cx22 in Nuremberg');
    expect(screen.getByText('Ready · 1 in pool')).toBeInTheDocument();
    expect(screen.queryByText('Your pool is empty, so only Instant sessions can run.')).toBeNull();
  });

  it('switches an account off, keeps its machines, and saves only the switch', async () => {
    load(twoAccountPool());
    renderPanel();
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Use Google Cloud · SAM GCP Prod in this pool' })
    );
    expect(screen.getByText('1 machine kept, not used')).toBeInTheDocument();
    expect(screen.getByText('Ready · 2 in pool')).toBeInTheDocument();
    expect(await save()).toEqual({ excludedSourceIds: [GCP_SOURCE] });
  });

  it('switches an account back on when a machine from it is added', async () => {
    load(twoAccountPool({ excluded: [GCP_SOURCE] }));
    renderPanel();
    expect(await screen.findByText('1 machine kept, not used')).toBeInTheDocument();
    await click('Add e2-standard-4 in Iowa');
    expect(await save()).toEqual({
      candidates: [{ id: 'gcp-us-central1-a', status: 'active' }],
      excludedSourceIds: [],
    });
  });

  it('hides a disconnected account and its machines', async () => {
    load(twoAccountPool({ gcpSourceStatus: 'disabled' }));
    renderPanel();
    expect(
      (await screen.findAllByRole('button', { name: 'Add ccx33 in Hillsboro' })).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/SAM GCP Prod/)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /e2-standard-4/ })).toHaveLength(0);
  });

  it('orders accounts and saves the order', async () => {
    load(twoAccountPool());
    renderPanel();
    await click('Try accounts in this order');
    await click('Try Google Cloud · SAM GCP Prod earlier');
    expect(await save()).toEqual({ sourceOrder: [GCP_SOURCE, 'source-project'] });
  });

  it('adds selected rows in bulk', async () => {
    load(twoAccountPool());
    renderPanel();
    fireEvent.click(
      (await screen.findAllByRole('checkbox', { name: 'Select ccx33 in Hillsboro' }))[0]!
    );
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select e2-standard-4 in Iowa' })[0]!);
    await click('Add 2 to pool');
    const body = await save();
    expect(body.candidates).toEqual([{ id: 'gcp-us-central1-a', status: 'active' }]);
    expect(body.catalogAdditions).toHaveLength(1);
  });

  it('removes everything with Remove all', async () => {
    load(twoAccountPool());
    renderPanel();
    await click('Remove all');
    expect(screen.getByText('Empty · Instant sessions only')).toBeInTheDocument();
    const body = await save();
    expect(body.candidates.map((c: { id: string }) => c.id).sort()).toEqual([
      'candidate-project-cpx31',
      'candidate-project-cx22',
      'gcp-europe-west1-b',
      'gcp-europe-west1-c',
    ]);
    expect(body.candidates.every((c: { status: string }) => c.status === 'deleted')).toBe(true);
  });

  it('discards a draft without saving', async () => {
    load(twoAccountPool());
    renderPanel();
    await click('Add ccx33 in Hillsboro');
    await click('Discard');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Add ccx33 in Hillsboro' }).length).toBe(2);
    expect(mocks.updateProjectDefaultCapacityPools).not.toHaveBeenCalled();
  });

  it('reloads the pool and clears the draft when a save conflicts', async () => {
    load(twoAccountPool());
    mocks.updateProjectDefaultCapacityPools.mockRejectedValue(
      new ApiClientError('CONFLICT', 'Default capacity pool changed; reload and retry', 409)
    );
    renderPanel();
    await click('Add ccx33 in Hillsboro');
    await click('Save changes');
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        expect.stringContaining('changed while you were editing')
      )
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    await waitFor(() => expect(mocks.fetchProjectDefaultCapacityPools).toHaveBeenCalledTimes(2));
  });

  it('filters to the machines in the pool', async () => {
    load(twoAccountPool());
    renderPanel();
    const show = await screen.findByRole('radiogroup', { name: 'Show' }).catch(() => null);
    const inPool = show
      ? within(show).getByRole('radio', { name: 'In pool' })
      : screen.getByRole('button', { name: 'In pool' });
    fireEvent.click(inPool);
    expect(screen.queryAllByRole('button', { name: 'Add ccx33 in Hillsboro' })).toHaveLength(0);
    expect(
      screen.getAllByRole('button', { name: 'Remove cx22 in Nuremberg' }).length
    ).toBeGreaterThan(0);
  });
});
