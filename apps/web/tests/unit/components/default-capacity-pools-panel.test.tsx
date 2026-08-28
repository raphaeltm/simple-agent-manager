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
  reconcileProjectDefaultCapacityPools: vi.fn(),
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
  reconcileProjectDefaultCapacityPools: mocks.reconcileProjectDefaultCapacityPools,
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<DefaultCapacityPoolsPanel projectId="project-1" />, {
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
  return {
    effective,
    effectiveScope,
    defaults: [
      {
        scope: 'project',
        visibility: 'visible',
        visibilityReason: 'project-secret-read',
        canReconcile: true,
        summary: effectiveScope === 'project' ? effective : null,
      },
      {
        scope: 'user',
        visibility: 'visible',
        visibilityReason: 'authenticated-user',
        canReconcile: true,
        summary: effectiveScope === 'user' ? effective : null,
      },
      {
        scope: 'installation',
        visibility: 'hidden',
        visibilityReason: 'superadmin-required',
        canReconcile: false,
        summary: null,
      },
    ],
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: ['project', 'user'],
    policyMutationSupported: false,
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
    expect(screen.getByText('Project default applies first for this context.')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('Hetzner · Project')).toBeInTheDocument();
    expect(screen.getByText('credentials:credential-project')).toBeInTheDocument();
    expect(screen.getByText('Hetzner · fsn1')).toBeInTheDocument();
    expect(screen.getByText('small')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.queryByText(/encrypted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it('reconciles defaults and replaces the stale summary', async () => {
    mocks.fetchProjectDefaultCapacityPools.mockResolvedValue(response(null, null));
    mocks.reconcileProjectDefaultCapacityPools.mockResolvedValue(response('user', summary('user')));

    renderPanel();

    expect(await screen.findByText('No visible active default pool')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    expect(await screen.findByText('user default pool')).toBeInTheDocument();
    expect(mocks.reconcileProjectDefaultCapacityPools).toHaveBeenCalledWith('project-1');
    expect(mocks.toast.success).toHaveBeenCalledWith('Default compute pools reconciled');
  });

  it('summarizes overflow candidate groups deterministically', async () => {
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
    expect(screen.getByText('+1 more provider/region groups')).toBeInTheDocument();
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
