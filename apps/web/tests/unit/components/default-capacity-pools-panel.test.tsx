import type {
  CapacityPoolCandidate,
  CapacityPoolScope,
  DefaultCapacityPoolSummary,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
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
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
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
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function candidate(overrides: Partial<CapacityPoolCandidate> = {}): CapacityPoolCandidate {
  return {
    id: 'candidate-1',
    poolId: 'pool-project',
    capacitySourceId: 'source-project',
    provider: 'hetzner',
    location: 'fsn1',
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: 'medium',
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
      candidate({ id: `candidate-${scope}-small`, machineSize: 'small' }),
      candidate({ id: `candidate-${scope}-medium`, machineSize: 'medium', candidateOrder: 1 }),
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
  });

  it('renders effective pool policy, sources, and machine candidates without secret fields', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(
      response('project', summary('project'))
    );

    renderPanel();

    expect(await screen.findByText('project default pool')).toBeInTheDocument();
    expect(screen.getByText('Project default applies to this context.')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('Hetzner · Project')).toBeInTheDocument();
    expect(screen.getByText('credentials:credential-project')).toBeInTheDocument();
    expect(screen.getByText('Hetzner · fsn1')).toBeInTheDocument();
    expect(screen.getByText('small')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.queryByText(/encrypted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hidden outside this settings context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Installation defaults require/i)).not.toBeInTheDocument();
  });

  it('shows project fallback read-only without hidden-scope placeholder cards', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(await screen.findByText('user default pool')).toBeInTheDocument();
    expect(screen.getByText('Using user fallback.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Hidden outside this settings context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Installation defaults require/i)).not.toBeInTheDocument();
  });

  it('updates project-owned policy and candidate statuses', async () => {
    const current = summary('project');
    current.candidates = [
      candidate({ id: 'candidate-project-fsn1-small', location: 'fsn1', machineSize: 'small' }),
      candidate({
        id: 'candidate-project-ash-medium',
        location: 'ash',
        machineSize: 'medium',
        priority: 1,
        candidateOrder: 1,
      }),
      candidate({
        id: 'candidate-project-hil-large',
        location: 'hil',
        machineSize: 'large',
        priority: 2,
        candidateOrder: 2,
      }),
    ];
    current.activeCandidateCount = 3;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', current));
    mocks.updateProjectDefaultCapacityPools.mockResolvedValue(
      response('project', {
        ...current,
        pool: { ...current.pool, strategy: 'pack', revision: 4 },
        candidates: current.candidates.map((candidateItem) =>
          candidateItem.id === 'candidate-project-ash-medium'
            ? { ...candidateItem, status: 'deleted' }
            : candidateItem.id === 'candidate-project-hil-large'
              ? { ...candidateItem, status: 'disabled' }
              : candidateItem
        ),
        activeCandidateCount: 1,
      })
    );

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: 'pack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hetzner ash Medium candidate' }));
    fireEvent.click(screen.getByLabelText('Hetzner hil Large candidate active'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1', {
        policy: { strategy: 'pack' },
        candidates: [
          { id: 'candidate-project-ash-medium', status: 'deleted' },
          { id: 'candidate-project-hil-large', status: 'disabled' },
        ],
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Project default compute pool updated');
  });

  it('routes user and installation edits to their owned default APIs', async () => {
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));
    mocks.updateUserDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    const userRender = renderPanel({ scope: 'user' });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hetzner fsn1 Small candidate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateUserDefaultCapacityPools).toHaveBeenCalledWith({
        candidates: [{ id: 'candidate-user-small', status: 'deleted' }],
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hetzner fsn1 Small candidate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateInstallationDefaultCapacityPools).toHaveBeenCalledWith({
        candidates: [{ id: 'candidate-installation-small', status: 'deleted' }],
      })
    );
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

    expect(await screen.findByText('Your Default Compute Pool')).toBeInTheDocument();
    expect(screen.getByText(/personal default pool/i)).toBeInTheDocument();
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

    expect(await screen.findByText('Installation Default Compute Pool')).toBeInTheDocument();
    expect(screen.getByText(/platform-admin pool/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    await waitFor(() =>
      expect(mocks.reconcileInstallationDefaultCapacityPools).toHaveBeenCalledTimes(1)
    );
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Installation default compute pool reconciled'
    );
  });

  it('renders all active candidate groups in the bounded list', async () => {
    const many = summary('project');
    many.candidates = Array.from({ length: 13 }, (_, index) =>
      candidate({
        id: `candidate-${index}`,
        location: `region-${index}`,
        machineSize: 'medium',
        priority: index,
        candidateOrder: index,
      })
    );
    many.activeCandidateCount = many.candidates.length;
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response('project', many));

    renderPanel();

    expect(await screen.findByText('Hetzner · region-0')).toBeInTheDocument();
    expect(screen.getByText('Hetzner · region-12')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more provider\/region groups/)).not.toBeInTheDocument();
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
