/**
 * The Deployments page follows the installation's `appDeployments` capability, read through
 * the real query (`GET /api/config/platform-capabilities`). A self-hosted install without
 * Cloudflare DNS cannot run deployments, and the API refuses them; the page says so instead of
 * offering a "New environment" button that can only fail.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ASSUMED_PLATFORM_CAPABILITIES } from '../../../src/lib/api/platform-capabilities';
import { DeploymentsList } from '../../../src/pages/deployments/list';

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: 'proj-1' }),
}));
// Deployments data hooks: an empty project. The capabilities query stays real.
vi.mock('../../../src/pages/deployments/data', () => ({
  useEnvironments: () => ({ data: [], isPending: false, isError: false }),
  useProfiles: () => [],
}));
vi.mock('../../../src/pages/deployments/new-environment', () => ({
  NewEnvironmentDialog: () => null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

let client: QueryClient;

function renderPage(capabilities: Record<string, boolean>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/config/platform-capabilities'))
        return Response.json(capabilities);
      throw new Error(`unexpected request ${String(input)}`);
    })
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DeploymentsList />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function capabilitiesSettled() {
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.state.status === 'success')
    ).toBe(true)
  );
}

describe('Deployments page and the appDeployments capability', () => {
  it('on an installation without app deployments, explains why and offers no create button', async () => {
    renderPage({ ...ASSUMED_PLATFORM_CAPABILITIES, appDeployments: false });
    await capabilitiesSettled();

    expect(
      await screen.findByText('Deployments aren’t available on this installation')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New environment/ })).toBeNull();
    // Liveness: the page itself rendered.
    expect(screen.getByText('Deployments')).toBeTruthy();
  });

  it('control: with app deployments, shows the normal empty state and its create button', async () => {
    renderPage({ ...ASSUMED_PLATFORM_CAPABILITIES, appDeployments: true });
    await capabilitiesSettled();

    expect(await screen.findByRole('button', { name: /New environment/ })).toBeTruthy();
    expect(screen.queryByText('Deployments aren’t available on this installation')).toBeNull();
  });
});
