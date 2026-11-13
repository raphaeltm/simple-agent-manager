import type { ProviderCatalog } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DefaultCapacityPoolsPanel } from '../../../src/components/project-settings/DefaultCapacityPoolsPanel';
import { ApiClientError } from '../../../src/lib/api/client';
import { providerCatalog, response, summary } from './compute-pool-fixtures';

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
  const rendered = render(<DefaultCapacityPoolsPanel {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    ),
  });
  return Object.assign(rendered, { queryClient });
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
    ).toHaveAttribute('href', '/projects/project-1/settings/accounts?connect=cloud:any');
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

  it.each([
    {
      props: { projectId: 'project-1' } as const,
      fetchMock: () => mocks.fetchProjectDefaultCapacityPools,
      title: 'No machines for this project yet',
      action: 'Connect a cloud account to this project',
      href: '/projects/project-1/settings/accounts?connect=cloud:any',
    },
    {
      props: { scope: 'user' } as const,
      fetchMock: () => mocks.fetchUserDefaultCapacityPools,
      title: 'No machines yet',
      action: 'Connect a cloud account',
      href: '/settings/infrastructure?connect=any',
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
      '/settings/infrastructure?connect=any'
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

  it.each(['project', 'user', 'installation'] as const)(
    'keeps a ready %s pool editable while showing a safe refresh recovery notice',
    async (scope) => {
      const ready = {
        ...summary(scope),
        candidates: summary(scope).candidates.map((candidate) => ({
          ...candidate,
          capacitySourceId: `source-${scope}`,
        })),
        effectiveState: 'configured-ready' as const,
        diagnostics: ['catalog-refresh-failed', '<script>unsafe provider failure</script>'],
      };
      const recovered = { ...ready, diagnostics: [] };
      const fetch =
        scope === 'project'
          ? mocks.fetchProjectDefaultCapacityPools
          : scope === 'user'
            ? mocks.fetchUserDefaultCapacityPools
            : mocks.fetchInstallationDefaultCapacityPools;
      const reconcile =
        scope === 'project'
          ? mocks.reconcileProjectDefaultCapacityPools
          : scope === 'user'
            ? mocks.reconcileUserDefaultCapacityPools
            : mocks.reconcileInstallationDefaultCapacityPools;
      fetch.mockResolvedValue(response(scope, ready));
      reconcile.mockResolvedValue(response(scope, recovered));

      renderPanel(scope === 'project' ? { projectId: 'project-1' } : { scope });

      expect(
        await screen.findByText(
          'Machine list refresh failed. Check the connected cloud accounts, then select Refresh to retry.'
        )
      ).toBeInTheDocument();
      expect(screen.getByText('Ready · 2 in pool')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: /^Use .+ in this pool$/ })).toBeEnabled();
      expect(screen.getAllByRole('button', { name: 'Refresh machine list' })).toHaveLength(1);
      expect(screen.queryByText(/unsafe provider failure/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh machine list' }));
      await waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
      if (scope === 'project') expect(reconcile).toHaveBeenCalledWith('project-1');
      else expect(reconcile).toHaveBeenCalledWith();
      await waitFor(() =>
        expect(screen.queryByText(/Machine list refresh failed/)).not.toBeInTheDocument()
      );
      expect(screen.getByRole('switch', { name: /^Use .+ in this pool$/ })).toBeEnabled();
    }
  );

  it('shows no refresh failure notice for a normal ready pool', async () => {
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue(
      response('user', {
        ...summary('user'),
        candidates: summary('user').candidates.map((candidate) => ({
          ...candidate,
          capacitySourceId: 'source-user',
        })),
        effectiveState: 'configured-ready',
        diagnostics: [],
      })
    );
    renderPanel({ scope: 'user' });
    expect(await screen.findByRole('switch', { name: /^Use .+ in this pool$/ })).toBeEnabled();
    expect(screen.queryByText(/Machine list refresh failed/)).not.toBeInTheDocument();
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

/**
 * A project pool with three serving sources (Hetzner from the loaded catalog, Google Cloud and
 * Scaleway without catalog rows; Scaleway allows nothing) plus a source whose only candidate is
 * deleted, which the server would reject in `sourceOrder`.
 */
