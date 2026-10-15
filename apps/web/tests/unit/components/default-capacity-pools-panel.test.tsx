import type {
  CapacityPoolCandidate,
  CapacityPoolScope,
  DefaultCapacityPoolSummary,
  ProjectDefaultCapacityPoolsResponse,
  ProviderCatalog,
} from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DefaultCapacityPoolsPanel } from '../../../src/components/project-settings/DefaultCapacityPoolsPanel';
import { ApiClientError } from '../../../src/lib/api/client';

const mocks = vi.hoisted(() => ({
  fetchProjectDefaultCapacityPools: vi.fn(),
  fetchUserDefaultCapacityPools: vi.fn(),
  fetchInstallationDefaultCapacityPools: vi.fn(),
  reconcileProjectDefaultCapacityPools: vi.fn(),
  reconcileUserDefaultCapacityPools: vi.fn(),
  reconcileInstallationDefaultCapacityPools: vi.fn(),
  updateProjectDefaultCapacityPools: vi.fn(),
  updateUserDefaultCapacityPools: vi.fn(),
  updateInstallationDefaultCapacityPools: vi.fn(),
  useProviderCatalog: vi.fn(),
  providerCatalogs: [] as ProviderCatalog[],
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

vi.mock('../../../src/hooks/useProviderCatalog', () => ({
  useProviderCatalog: (...args: unknown[]) => {
    mocks.useProviderCatalog(...args);
    return {
      catalogs: mocks.providerCatalogs,
      catalog: mocks.providerCatalogs[0] ?? null,
      loading: false,
      isRefreshing: false,
    };
  },
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../../src/lib/api/capacity-pools', () => ({
  fetchProjectDefaultCapacityPools: mocks.fetchProjectDefaultCapacityPools,
  fetchUserDefaultCapacityPools: mocks.fetchUserDefaultCapacityPools,
  fetchInstallationDefaultCapacityPools: mocks.fetchInstallationDefaultCapacityPools,
  reconcileProjectDefaultCapacityPools: mocks.reconcileProjectDefaultCapacityPools,
  reconcileUserDefaultCapacityPools: mocks.reconcileUserDefaultCapacityPools,
  reconcileInstallationDefaultCapacityPools: mocks.reconcileInstallationDefaultCapacityPools,
  updateProjectDefaultCapacityPools: mocks.updateProjectDefaultCapacityPools,
  updateUserDefaultCapacityPools: mocks.updateUserDefaultCapacityPools,
  updateInstallationDefaultCapacityPools: mocks.updateInstallationDefaultCapacityPools,
}));

function renderPanel(
  props:
    { scope?: 'project'; projectId: string } | { scope: 'user' } | { scope: 'installation' } = {
    projectId: 'project-1',
  }
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<DefaultCapacityPoolsPanel {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    ),
  });
}

function providerCatalog(credentialId = 'credential-project'): ProviderCatalog {
  return {
    provider: 'hetzner',
    credentialSource: 'project',
    credentialId,
    locations: [
      { id: 'fsn1', name: 'Nuremberg', country: 'DE' },
      { id: 'ash', name: 'Ashburn', country: 'US' },
      { id: 'hil', name: 'Hillsboro', country: 'US' },
      { id: 'hel1', name: 'Helsinki', country: 'FI' },
    ],
    sizes: {
      small: {
        type: 'cx22',
        price: '€3.79/mo',
        vcpu: 2,
        ramGb: 4,
        storageGb: 40,
      },
      medium: {
        type: 'cpx31',
        price: '€13.10/mo',
        vcpu: 4,
        ramGb: 8,
        storageGb: 160,
      },
      large: {
        type: 'ccx33',
        price: '€55.20/mo',
        vcpu: 8,
        ramGb: 32,
        storageGb: 240,
      },
    },
    offerings: [
      {
        provider: 'hetzner',
        providerInstanceType: 'cx22',
        providerInstanceSku: null,
        displayName: 'CX22',
        sku: 'cx22',
        location: 'fsn1',
        locationName: 'Nuremberg',
        country: 'DE',
        vcpu: 2,
        memoryMb: 4096,
        memoryGb: 4,
        diskGb: 40,
        price: '€3.79/mo',
        priceMonthly: 3.79,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'cpx31',
        providerInstanceSku: null,
        displayName: 'CPX31',
        sku: 'cpx31',
        location: 'ash',
        locationName: 'Ashburn',
        country: 'US',
        vcpu: 4,
        memoryMb: 8192,
        memoryGb: 8,
        diskGb: 160,
        price: '€13.10/mo',
        priceMonthly: 13.1,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'ccx33',
        providerInstanceSku: null,
        displayName: 'CCX33',
        sku: 'ccx33',
        location: 'hil',
        locationName: 'Hillsboro',
        country: 'US',
        vcpu: 8,
        memoryMb: 32_768,
        memoryGb: 32,
        diskGb: 240,
        price: '€55.20/mo',
        priceMonthly: 55.2,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType:
          'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only',
        providerInstanceSku: null,
        displayName: 'Long catalog-only SKU',
        sku: 'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only',
        location: 'hel1',
        locationName: 'Helsinki',
        country: 'FI',
        vcpu: 16,
        memoryMb: 65_536,
        memoryGb: 64,
        diskGb: 480,
        price: '€220.00/mo',
        priceMonthly: 220,
        currency: 'EUR',
        available: false,
        status: 'temporarily unavailable',
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
    ],
    defaultLocation: 'fsn1',
  };
}

function candidate(overrides: Partial<CapacityPoolCandidate> = {}): CapacityPoolCandidate {
  const machineSize = overrides.machineSize ?? 'medium';
  const sku =
    overrides.providerInstanceType ??
    (machineSize === 'small' ? 'cx22' : machineSize === 'large' ? 'ccx33' : 'cpx31');
  const vcpu = sku === 'cx22' ? 2 : sku === 'ccx33' ? 8 : 4;
  const memoryMb = sku === 'cx22' ? 4096 : sku === 'ccx33' ? 32_768 : 8192;
  const diskGb = sku === 'cx22' ? 40 : sku === 'ccx33' ? 240 : 160;
  const priceDisplay = sku === 'cx22' ? '€3.79/mo' : sku === 'ccx33' ? '€55.20/mo' : '€13.10/mo';

  return {
    id: 'candidate-1',
    poolId: 'pool-project',
    capacitySourceId: 'source-project',
    provider: 'hetzner',
    location: 'fsn1',
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize,
    providerInstanceType: sku,
    providerInstanceVcpuCount: vcpu,
    providerInstanceMemoryMb: memoryMb,
    providerInstanceDiskGb: diskGb,
    providerInstancePriceDisplay: priceDisplay,
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: sku === 'cx22' ? 379 : sku === 'ccx33' ? 5520 : 1310,
    providerInstancePriceHourlyMicros: null,
    priority: 0,
    candidateOrder: 0,
    status: 'active',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function summary(scope: CapacityPoolScope): DefaultCapacityPoolSummary {
  return {
    pool: {
      id: `pool-${scope}`,
      scope,
      ownerUserId: scope === 'user' ? 'user-1' : null,
      ownerProjectId: scope === 'project' ? 'project-1' : null,
      name: `${scope} default pool`,
      isDefault: true,
      revision: 3,
      status: 'active',
      strategy: 'balanced',
      deploymentStrategy: 'smallest-fit',
      exhaustionPolicy: 'queue',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
    sources: [
      {
        id: `source-${scope}`,
        scope,
        ownerUserId: scope === 'user' ? 'user-1' : null,
        ownerProjectId: scope === 'project' ? 'project-1' : null,
        sourceKind: 'cloud-provider-credential',
        provider: 'hetzner',
        credentialSource: scope === 'installation' ? 'platform' : scope,
        credentialId: scope === 'installation' ? null : `credential-${scope}`,
        platformCredentialId: scope === 'installation' ? 'platform-credential-1' : null,
        credentialReference:
          scope === 'installation'
            ? 'platform_credentials:platform-credential-1'
            : `credentials:credential-${scope}`,
        credentialVersion: 1787875200000,
        externalSourceRef: null,
        status: 'active',
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
    ],
    candidates: [
      candidate({
        id: `candidate-${scope}-cx22`,
        machineSize: 'small',
        providerInstanceType: 'cx22',
      }),
      candidate({
        id: `candidate-${scope}-cpx31`,
        location: 'ash',
        machineSize: 'medium',
        providerInstanceType: 'cpx31',
        candidateOrder: 1,
      }),
    ],
    activeCandidateCount: 2,
  };
}

function response(
  effectiveScope: CapacityPoolScope | null,
  effective: DefaultCapacityPoolSummary | null
): ProjectDefaultCapacityPoolsResponse {
  const installationContext = effectiveScope === 'installation';
  return {
    effective,
    effectiveScope,
    defaults: [
      {
        scope: 'project',
        visibility: installationContext ? 'hidden' : 'visible',
        visibilityReason: installationContext ? 'project-context-required' : 'project-secret-read',
        canReconcile: !installationContext,
        summary: effectiveScope === 'project' ? effective : null,
      },
      {
        scope: 'user',
        visibility: installationContext ? 'hidden' : 'visible',
        visibilityReason: installationContext
          ? 'authenticated-user-context-required'
          : 'authenticated-user',
        canReconcile: !installationContext,
        summary: effectiveScope === 'user' ? effective : null,
      },
      {
        scope: 'installation',
        visibility: installationContext ? 'visible' : 'hidden',
        visibilityReason: installationContext ? 'superadmin' : 'superadmin-required',
        canReconcile: installationContext,
        summary: effectiveScope === 'installation' ? effective : null,
      },
    ],
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: ['project', 'user'],
    policyMutationSupported: true,
  };
}

const LONG_SKU = 'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only';

function chip(name: string) {
  return screen.getByRole('button', { name, exact: true });
}

describe('DefaultCapacityPoolsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerCatalogs = [providerCatalog()];
  });

  it.each([
    {
      props: { projectId: 'project-1' } as const,
      setup: () =>
        mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
          response('project', summary('project'))
        ),
      expected: { scope: 'project', projectId: 'project-1' },
    },
    {
      props: { scope: 'user' } as const,
      setup: () =>
        mocks.fetchUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user'))),
      expected: { scope: 'user', projectId: null },
    },
    {
      props: { scope: 'installation' } as const,
      setup: () =>
        mocks.fetchInstallationDefaultCapacityPools.mockResolvedValue(
          response('installation', summary('installation'))
        ),
      expected: { scope: 'installation', projectId: null },
    },
  ])('requests $expected.scope-scoped provider catalogs', ({ props, setup, expected }) => {
    setup();

    const rendered = renderPanel(props);

    expect(mocks.useProviderCatalog).toHaveBeenCalledWith('user-1', expected);
    rendered.unmount();
  });

  it.each([
    {
      props: { projectId: 'project-1' } as const,
      setup: () =>
        mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
          response('project', summary('project'))
        ),
      assertFetch: () =>
        expect(mocks.fetchProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1'),
    },
    {
      props: { scope: 'user' } as const,
      setup: () =>
        mocks.fetchUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user'))),
      assertFetch: () => expect(mocks.fetchUserDefaultCapacityPools).toHaveBeenCalledWith(),
    },
    {
      props: { scope: 'installation' } as const,
      setup: () =>
        mocks.fetchInstallationDefaultCapacityPools.mockResolvedValue(
          response('installation', summary('installation'))
        ),
      assertFetch: () => expect(mocks.fetchInstallationDefaultCapacityPools).toHaveBeenCalledWith(),
    },
  ])(
    'loads $props.scope defaults without forcing reconciliation',
    async ({ props, setup, assertFetch }) => {
      setup();

      renderPanel(props);

      await waitFor(assertFetch);
    }
  );

  it('describes the pool in plain language without internal ids or states', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();

    expect(await screen.findByText('Allowed machines (2)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project compute pool' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'SAM can start Hetzner machines in Nuremberg or Ashburn, from cx22 (2 vCPU, 4 GB RAM, €3.79/mo) to cpx31 (4 vCPU, 8 GB RAM, €13.10/mo).'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('New agents go to the least busy machine.', { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByText('Wait and retry.')).toBeInTheDocument();
    expect(screen.getByText('cx22')).toBeInTheDocument();
    expect(screen.getByText('cpx31')).toBeInTheDocument();
    expect(screen.getByText('€13.10/mo')).toBeInTheDocument();
    expect(screen.getByText(/Uses this project's Hetzner account/)).toBeInTheDocument();
    for (const internal of [
      /credentials:credential-project/,
      /revision/i,
      /shared-vm/,
      /not selected/i,
      /reconcile/i,
      /encrypted/i,
      /token/i,
      /^small$/,
      /^medium$/,
    ]) {
      expect(screen.queryByText(internal)).not.toBeInTheDocument();
    }
    // The machine limit caps every strategy, so it is always shown.
    expect(screen.getByText('Machine limit')).toBeInTheDocument();
    expect(screen.getByText(/Up to 3 machines at once per person/)).toBeInTheDocument();
  });

  it('shows the personal pool read-only on a project without its own pool', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(
      await screen.findByText(/This project uses your personal compute pool/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit your pool' })).toHaveAttribute(
      'href',
      '/settings/infrastructure'
    );
    expect(
      screen.getByRole('link', { name: 'connect a cloud account to the project' })
    ).toHaveAttribute('href', '/projects/project-1/settings/connections');
    expect(screen.getByText('Allowed machines (2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('names the regions of a fallback pool without calling its machines unavailable', async () => {
    // The project-scoped catalog request covers project credentials only, so the personal
    // pool a project falls back to arrives without a catalog of its own (seen on staging).
    mocks.providerCatalogs = [];
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(
      await screen.findByText(/This project uses your personal compute pool/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'SAM can start Hetzner machines in Falkenstein or Ashburn, from cx22 (2 vCPU, 4 GB RAM, €3.79/mo) to cpx31 (4 vCPU, 8 GB RAM, €13.10/mo).'
      )
    ).toBeInTheDocument();
    expect(screen.queryAllByText(/not currently offered/i)).toHaveLength(0);
  });

  it('keeps an owned pool with no allowed machines editable so machines can be allowed again', async () => {
    const empty = summary('project');
    empty.pool = { ...empty.pool, status: 'disabled' };
    empty.candidates = empty.candidates.map((candidateItem, index) => ({
      ...candidateItem,
      status: index === 0 ? 'deleted' : 'disabled',
    }));
    empty.activeCandidateCount = 0;
    const emptyResponse: ProjectDefaultCapacityPoolsResponse = {
      ...response(null, null),
      defaults: response(null, null).defaults.map((item) =>
        item.scope === 'project' ? { ...item, summary: empty } : item
      ),
    };
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(emptyResponse);
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(emptyResponse);

    renderPanel();

    expect(
      await screen.findByText("No machines are allowed, so SAM can't start any from this pool.")
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect a cloud account/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(chip('cx22 in Nuremberg')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip('cx22 in Nuremberg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        candidates: [{ id: 'candidate-project-cx22', status: 'active' }],
      })
    );
  });

  it('saves placement settings and machine changes for a project pool', async () => {
    const current = summary('project');
    current.candidates = [
      candidate({
        id: 'candidate-project-fsn1-cx22',
        location: 'fsn1',
        machineSize: 'small',
        providerInstanceType: 'cx22',
      }),
      candidate({
        id: 'candidate-project-ash-cpx31',
        location: 'ash',
        machineSize: 'medium',
        providerInstanceType: 'cpx31',
      }),
      candidate({
        id: 'candidate-project-hil-ccx33',
        location: 'hil',
        machineSize: 'large',
        providerInstanceType: 'ccx33',
        status: 'deleted',
      }),
    ];
    current.activeCandidateCount = 2;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(response('project', current));

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Placing agents'), { target: { value: 'spread' } });
    expect(screen.getByText(/With Spread, each agent gets its own machine/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Machine limit per person'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('App deployments'), { target: { value: 'balanced' } });
    fireEvent.click(chip('cpx31 in Ashburn'));
    fireEvent.click(screen.getByRole('button', { name: /Show 2 more machine types/ }));
    fireEvent.click(chip('ccx33 in Hillsboro'));
    expect(screen.getByText('5 unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        policy: { strategy: 'spread', deploymentStrategy: 'balanced', maxNodes: 5 },
        candidates: [
          { id: 'candidate-project-ash-cpx31', status: 'deleted' },
          { id: 'candidate-project-hil-ccx33', status: 'active' },
        ],
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Compute pool saved');
  });

  it('turns a region off and back on when a legacy size row shares it', async () => {
    // Staging pools keep a legacy "small" row beside the native cx22 row in the same region.
    // The server refuses to activate the legacy row, so re-allowing must leave it out.
    const pool = summary('project');
    pool.candidates = [
      candidate({
        id: 'candidate-project-cx22',
        machineSize: 'small',
        providerInstanceType: 'cx22',
        catalogAvailability: 'available',
        providerInstanceCatalogSource: 'api',
      }),
      candidate({
        id: 'candidate-project-small',
        machineSize: 'small',
        providerInstanceType: null,
        status: 'disabled',
        catalogAvailability: 'last-known-unavailable',
        providerInstanceCatalogSource: null,
      }),
    ];
    const blocked = structuredClone(pool);
    blocked.candidates[0] = { ...blocked.candidates[0]!, status: 'deleted' };
    mocks.providerCatalogs = [providerCatalog()];
    mocks.providerCatalogs[0]!.offerings![0] = {
      ...mocks.providerCatalogs[0]!.offerings![0]!,
      machineSize: 'small',
    };
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', pool));
    mocks.updateProjectDefaultCapacityPools
      .mockResolvedValueOnce(response('project', blocked))
      .mockResolvedValueOnce(response('project', pool));

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(chip('cx22 in Nuremberg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenNthCalledWith(1, 'project-1', {
        candidates: [{ id: 'candidate-project-cx22', status: 'deleted' }],
      })
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(chip('cx22 in Nuremberg')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip('cx22 in Nuremberg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenNthCalledWith(2, 'project-1', {
        candidates: [{ id: 'candidate-project-cx22', status: 'active' }],
      })
    );
  });

  it('lets the machine limit be cleared and retyped, and saves only whole numbers', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const limit = screen.getByLabelText('Machine limit per person');
    fireEvent.change(limit, { target: { value: '' } });
    // The field stays empty while editing instead of snapping back to the saved value.
    expect(limit).toHaveValue(null);
    fireEvent.change(limit, { target: { value: '2.5' } });
    expect(screen.getByText('No changes yet')).toBeInTheDocument();
    fireEvent.blur(limit);
    // Leaving the field shows the value that would be saved.
    expect(limit).toHaveValue(3);
    fireEvent.change(limit, { target: { value: '1e3' } });
    fireEvent.blur(limit);
    expect(limit).toHaveValue(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        policy: { maxNodes: 1000 },
      })
    );
  });

  it('saves the deployment strategy on its own', async () => {
    const current = summary('project');
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(response('project', current));

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('App deployments'), { target: { value: 'balanced' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        policy: { deploymentStrategy: 'balanced' },
      })
    );
  });

  it('cancel discards changes without saving', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(chip('cx22 in Nuremberg'));
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Allowed machines (2)')).toBeInTheDocument();
    expect(mocks.updateProjectDefaultCapacityPools).not.toHaveBeenCalled();
  });

  it('keeps two connections to the same provider separate', async () => {
    mocks.providerCatalogs = [
      providerCatalog('credential-alpha'),
      providerCatalog('credential-beta'),
    ];
    const current = summary('project');
    current.sources = [
      {
        ...current.sources[0]!,
        id: 'source-alpha',
        credentialId: 'credential-alpha',
        credentialReference: 'credentials:credential-alpha',
      },
      {
        ...current.sources[0]!,
        id: 'source-beta',
        credentialId: 'credential-beta',
        credentialReference: 'credentials:credential-beta',
      },
    ];
    current.candidates = [
      candidate({
        id: 'candidate-alpha-ash-cpx31',
        capacitySourceId: 'source-alpha',
        location: 'ash',
        providerInstanceType: 'cpx31',
      }),
      candidate({
        id: 'candidate-beta-ash-cpx31',
        capacitySourceId: 'source-beta',
        location: 'ash',
        providerInstanceType: 'cpx31',
      }),
    ];
    current.activeCandidateCount = 2;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(response('project', current));

    renderPanel();

    expect(
      await screen.findByRole('heading', { name: 'Hetzner · Project credentials' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Hetzner · Project credentials (2)' })
    ).toBeInTheDocument();
    // Each section title links to where that connection is managed.
    expect(screen.getAllByRole('link', { name: /^Hetzner · Project credentials/ })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Hetzner · Project credentials' })).toHaveAttribute(
      'href',
      '/projects/project-1/settings/connections'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const [alphaChip, betaChip] = screen.getAllByRole('button', {
      name: 'cpx31 in Ashburn',
      exact: true,
    });
    expect(betaChip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(alphaChip!);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        candidates: [{ id: 'candidate-alpha-ash-cpx31', status: 'deleted' }],
      })
    );
  });

  it('does not let machines the provider stopped offering be allowed again', async () => {
    const current = summary('project');
    current.candidates = [
      candidate({ id: 'candidate-project-fsn1-cx22', providerInstanceType: 'cx22' }),
      candidate({
        id: 'candidate-project-hel1-long',
        location: 'hel1',
        machineSize: null,
        providerInstanceType: LONG_SKU,
        providerInstanceVcpuCount: 16,
        providerInstanceMemoryMb: 65_536,
        providerInstanceDiskGb: 480,
        providerInstancePriceDisplay: '€220.00/mo',
        providerInstancePriceMonthlyCents: 22_000,
        status: 'deleted',
      }),
    ];
    current.activeCandidateCount = 1;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Show \d+ more machine types?/ }));
    expect(screen.getByText(LONG_SKU)).toBeInTheDocument();
    expect(chip(`${LONG_SKU} in Helsinki (temporarily unavailable)`)).toBeDisabled();
  });

  it('adds catalog machines the pool has no row for', async () => {
    const catalogWithAvailableRow = providerCatalog();
    catalogWithAvailableRow.offerings = catalogWithAvailableRow.offerings?.map((offering) =>
      offering.providerInstanceType === LONG_SKU
        ? { ...offering, available: true, status: null }
        : offering
    );
    mocks.providerCatalogs = [catalogWithAvailableRow];
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Show 2 more machine types/ }));
    fireEvent.click(chip(`${LONG_SKU} in Helsinki`));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        catalogAdditions: [
          {
            sourceId: 'source-project',
            provider: 'hetzner',
            location: 'hel1',
            providerInstanceType: LONG_SKU,
            providerInstanceSku: null,
          },
        ],
      })
    );
  });

  it('routes user and installation edits to their own APIs', async () => {
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));
    mocks.updateUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    const userRender = renderPanel({ scope: 'user' });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(chip('cx22 in Nuremberg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateUserDefaultCapacityPools).toHaveBeenCalledWith({
        candidates: [{ id: 'candidate-user-cx22', status: 'deleted' }],
      })
    );
    userRender.unmount();

    mocks.fetchInstallationDefaultCapacityPools.mockResolvedValue(
      response('installation', summary('installation'))
    );
    mocks.updateInstallationDefaultCapacityPools.mockResolvedValue(
      response('installation', summary('installation'))
    );

    renderPanel({ scope: 'installation' });

    expect(await screen.findByRole('heading', { name: 'Shared compute pool' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(chip('cx22 in Nuremberg'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateInstallationDefaultCapacityPools).toHaveBeenCalledWith({
        candidates: [{ id: 'candidate-installation-cx22', status: 'deleted' }],
      })
    );
  });

  it.each([
    {
      props: { projectId: 'project-1' } as const,
      fetchMock: () => mocks.fetchProjectDefaultCapacityPools,
      title: 'No machines for this project yet',
      action: 'Connect a cloud account to this project',
      href: '/projects/project-1/settings/connections',
    },
    {
      props: { scope: 'user' } as const,
      fetchMock: () => mocks.fetchUserDefaultCapacityPools,
      title: 'No machines yet',
      action: 'Connect a cloud account',
      href: '/settings/cloud-provider',
    },
    {
      props: { scope: 'installation' } as const,
      fetchMock: () => mocks.fetchInstallationDefaultCapacityPools,
      title: 'No platform cloud account yet',
      action: 'Add a platform credential',
      href: '/admin/credentials',
    },
  ])(
    'guides $props.scope scope without a pool: $title',
    async ({ props, fetchMock, title, action, href }) => {
      fetchMock().mockResolvedValue(response(null, null));

      renderPanel(props);

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: action })).toHaveAttribute('href', href);
    }
  );

  it('tells people without a pool that shared machines are running their work', async () => {
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue({
      ...response(null, null),
      effectiveSummary: {
        scope: 'installation',
        state: 'configured-ready',
        strategy: 'balanced',
        exhaustionPolicy: 'queue',
        availableCandidateCount: 1,
        nativeOfferings: [
          {
            provider: 'hetzner',
            location: 'fsn1',
            providerInstanceType: 'cx23',
            displayName: 'cx23',
            vcpu: 2,
            memoryMb: 4096,
            diskGb: 40,
            price: '€4.49/mo',
          },
        ],
      },
    });

    renderPanel({ scope: 'user' });

    expect(await screen.findByText("You're using shared machines")).toBeInTheDocument();
    expect(screen.getByText(/Hetzner cx23 in Falkenstein/)).toBeInTheDocument();
    expect(screen.queryByText(/required/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect a cloud account' })).toHaveAttribute(
      'href',
      '/settings/cloud-provider'
    );
  });

  it('refreshes the machine list and shows the result', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response(null, null));
    mocks.reconcileProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(await screen.findByText('No machines for this project yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh machine list' }));

    expect(
      await screen.findByText(/This project uses your personal compute pool/)
    ).toBeInTheDocument();
    expect(mocks.reconcileProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1');
    expect(mocks.toast.success).toHaveBeenCalledWith('Machine list refreshed');
  });

  it('lists every allowed machine type', async () => {
    const many = summary('project');
    many.candidates = Array.from({ length: 13 }, (_, index) =>
      candidate({
        id: `candidate-${index}`,
        location: `region-${index}`,
        providerInstanceType: `provider-sku-with-a-long-name-${index}`,
        providerInstanceVcpuCount: index + 1,
        priority: index,
        candidateOrder: index,
      })
    );
    many.activeCandidateCount = many.candidates.length;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', many));

    renderPanel();

    expect(await screen.findByText('Allowed machines (13)')).toBeInTheDocument();
    expect(screen.getByText('provider-sku-with-a-long-name-0')).toBeInTheDocument();
    expect(screen.getByText('provider-sku-with-a-long-name-12')).toBeInTheDocument();
  });

  it('explains a permission error in plain words', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockRejectedValue(
      new ApiClientError('FORBIDDEN', 'Project capability is required', 403)
    );

    renderPanel();

    expect(
      await screen.findByText(
        "You don't have access to this project's compute pool. Ask a project owner or admin."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Project capability is required')).not.toBeInTheDocument();
  });

  it('shows a deterministic error state', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockRejectedValue(
      new Error('Project capability is required')
    );

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText('Project capability is required')).toBeInTheDocument()
    );
  });
});
