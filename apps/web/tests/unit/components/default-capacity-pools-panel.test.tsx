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
  useProviderCatalog: () => ({
    catalogs: mocks.providerCatalogs,
    catalog: mocks.providerCatalogs[0] ?? null,
    loading: false,
    isRefreshing: false,
  }),
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
    | { scope?: 'project'; projectId: string }
    | { scope: 'user' }
    | { scope: 'installation' } = { projectId: 'project-1' }
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
        providerInstanceType: 'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only',
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
    providerInstancePriceMonthlyCents:
      sku === 'cx22' ? 379 : sku === 'ccx33' ? 5520 : 1310,
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
      candidate({ id: `candidate-${scope}-cx22`, machineSize: 'small', providerInstanceType: 'cx22' }),
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

describe('DefaultCapacityPoolsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerCatalogs = [providerCatalog()];
  });

  it('renders effective pool policy, sources, and provider-native allowed instances without secret fields', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();

    expect(await screen.findByText('project default pool')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project Infrastructure Compute Pool' })).toBeInTheDocument();
    expect(screen.getByText('Project default applies to this context.')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('Hetzner · Project')).toBeInTheDocument();
    expect(screen.getByText('credentials:credential-project')).toBeInTheDocument();
    expect(screen.getByText('cx22')).toBeInTheDocument();
    expect(screen.getByText('cpx31')).toBeInTheDocument();
    expect(screen.getByText(/Hetzner · Nuremberg \(fsn1\) · DE/)).toBeInTheDocument();
    expect(screen.getByText(/Hetzner · Ashburn \(ash\) · US/)).toBeInTheDocument();
    expect(screen.getAllByText('2')[0]).toBeInTheDocument();
    expect(screen.getByText('4 GB')).toBeInTheDocument();
    expect(screen.getByText('€13.10/mo')).toBeInTheDocument();
    expect(screen.queryByText('small')).not.toBeInTheDocument();
    expect(screen.queryByText('medium')).not.toBeInTheDocument();
    expect(screen.queryByText(/encrypted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hidden outside this settings context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Installation defaults require/i)).not.toBeInTheDocument();
  });

  it('shows project fallback read-only and guides users to project credential setup', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(await screen.findByText('user default pool')).toBeInTheDocument();
    expect(screen.getByText('Using user fallback.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Create a project-scoped infrastructure pool')).toBeInTheDocument();
    expect(screen.getByText(/a user connects and grants for this project/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up project credentials' })).toHaveAttribute(
      'href',
      '/projects/project-1/settings/connections'
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Hidden outside this settings context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Installation defaults require/i)).not.toBeInTheDocument();
  });

  it('updates project-owned policy and add/remove offering statuses', async () => {
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
        priority: 1,
        candidateOrder: 1,
      }),
      candidate({
        id: 'candidate-project-hil-ccx33',
        location: 'hil',
        machineSize: 'large',
        providerInstanceType: 'ccx33',
        priority: 2,
        candidateOrder: 2,
        status: 'deleted',
      }),
    ];
    current.activeCandidateCount = 2;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(
      response('project', {
        ...current,
        pool: { ...current.pool, strategy: 'pack', revision: 4 },
        candidates: current.candidates.map((candidateItem) =>
          candidateItem.id === 'candidate-project-ash-cpx31'
            ? { ...candidateItem, status: 'deleted' }
            : candidateItem.id === 'candidate-project-hil-ccx33'
              ? { ...candidateItem, status: 'active' }
              : candidateItem
        ),
        activeCandidateCount: 2,
      })
    );

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: 'pack' } });
    fireEvent.click(screen.getByRole('button', { name: /Remove Hetzner ash cpx31/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add back Hetzner hil ccx33/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        policy: { strategy: 'pack' },
        candidates: [
          { id: 'candidate-project-ash-cpx31', status: 'deleted' },
          { id: 'candidate-project-hil-ccx33', status: 'active' },
        ],
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Project default compute pool updated');
  });

  it('filters catalog offerings and applies bulk add/remove through candidate statuses', async () => {
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
        status: 'deleted',
      }),
      candidate({
        id: 'candidate-project-hil-ccx33',
        location: 'hil',
        machineSize: 'large',
        providerInstanceType: 'ccx33',
      }),
    ];
    current.activeCandidateCount = 2;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(response('project', current));

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Filter region or location'), {
      target: { value: 'ash' },
    });
    expect(screen.getByText(/1 matching offering across 1 region/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add filtered' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        candidates: [{ id: 'candidate-project-ash-cpx31', status: 'active' }],
      })
    );
  });

  it('keeps same provider location and SKU rows distinct by credential source', async () => {
    mocks.providerCatalogs = [providerCatalog('credential-alpha'), providerCatalog('credential-beta')];
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
        machineSize: 'medium',
        providerInstanceType: 'cpx31',
      }),
      candidate({
        id: 'candidate-beta-ash-cpx31',
        capacitySourceId: 'source-beta',
        location: 'ash',
        machineSize: 'medium',
        providerInstanceType: 'cpx31',
        candidateOrder: 1,
        priority: 1,
      }),
    ];
    current.activeCandidateCount = 2;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(response('project', current));

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getAllByText(/Source: Project credential credential-alpha/).length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByText(/Source: Project credential credential-beta/).length).toBeGreaterThan(
      0
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /Remove Hetzner ash cpx31 via Project credential credential-alpha/,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        candidates: [{ id: 'candidate-alpha-ash-cpx31', status: 'deleted' }],
      })
    );
  });

  it('routes user and installation edits to their owned default APIs', async () => {
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));
    mocks.updateUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    const userRender = renderPanel({ scope: 'user' });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Hetzner fsn1 cx22/ }));
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

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Hetzner fsn1 cx22/ }));
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
      title: 'Project compute credentials are required',
      action: 'Set up project credentials',
      href: '/projects/project-1/settings/connections',
    },
    {
      props: { scope: 'user' } as const,
      fetchMock: () => mocks.fetchUserDefaultCapacityPools,
      title: 'Personal compute credentials are required',
      action: 'Set up cloud provider',
      href: '/settings/cloud-provider',
    },
    {
      props: { scope: 'installation' } as const,
      fetchMock: () => mocks.fetchInstallationDefaultCapacityPools,
      title: 'Platform compute credentials are required',
      action: 'Set up platform credentials',
      href: '/admin/credentials',
    },
  ])('renders scoped credential setup guidance for $title', async ({ props, fetchMock, title, action, href }) => {
    fetchMock().mockResolvedValue(response(null, null));

    renderPanel(props);

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: action })).toHaveAttribute('href', href);
  });

  it('reconciles defaults and replaces the stale summary', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response(null, null));
    mocks.reconcileProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(await screen.findByText('No visible active default pool')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    expect(await screen.findByText('user default pool')).toBeInTheDocument();
    expect(mocks.reconcileProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1');
    expect(mocks.toast.success).toHaveBeenCalledWith('Project default compute pool reconciled');
  });

  it('renders and reconciles the user default pool variant', async () => {
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));
    mocks.reconcileUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel({ scope: 'user' });

    expect(await screen.findByText('Your Infrastructure Compute Pool')).toBeInTheDocument();
    expect(screen.getByText(/personal infrastructure pool/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    await waitFor(() => expect(mocks.reconcileUserDefaultCapacityPools).toHaveBeenCalledTimes(1));
    expect(mocks.toast.success).toHaveBeenCalledWith('User default compute pool reconciled');
  });

  it('renders and reconciles the installation default pool variant', async () => {
    mocks.fetchInstallationDefaultCapacityPools.mockResolvedValue(
      response('installation', summary('installation'))
    );
    mocks.reconcileInstallationDefaultCapacityPools.mockResolvedValue(
      response('installation', summary('installation'))
    );

    renderPanel({ scope: 'installation' });

    expect(await screen.findByText('Installation Infrastructure Compute Pool')).toBeInTheDocument();
    expect(screen.getByText(/platform-admin pool/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    await waitFor(() =>
      expect(mocks.reconcileInstallationDefaultCapacityPools).toHaveBeenCalledTimes(1)
    );
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Installation default compute pool reconciled'
    );
  });

  it('renders all active provider-native offerings in the bounded list', async () => {
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

    expect(await screen.findByText('provider-sku-with-a-long-name-0')).toBeInTheDocument();
    expect(screen.getByText('provider-sku-with-a-long-name-12')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more provider\/region groups/)).not.toBeInTheDocument();
  });

  it('hides catalog-only offerings until backend candidate rows exist', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(
      screen.queryByText('long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only')
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/requires the backend provider-native candidate mutation/i)).not.toBeInTheDocument();
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
