import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentCustomDomain, DeploymentPublicRoute } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  createDeploymentCustomDomain: vi.fn(),
  deleteDeploymentCustomDomain: vi.fn(),
  listDeploymentCustomDomains: vi.fn(),
  listDeploymentPublicRoutes: vi.fn(),
  verifyDeploymentCustomDomain: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createDeploymentCustomDomain: mocks.createDeploymentCustomDomain,
  deleteDeploymentCustomDomain: mocks.deleteDeploymentCustomDomain,
  listDeploymentCustomDomains: mocks.listDeploymentCustomDomains,
  listDeploymentPublicRoutes: mocks.listDeploymentPublicRoutes,
  verifyDeploymentCustomDomain: mocks.verifyDeploymentCustomDomain,
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

import { DeploymentCustomDomainsPanel } from '../../../src/components/deployments/DeploymentCustomDomainsPanel';

const PROJECT_ID = 'project-1';
const ENV_ID = 'env-1';

const ROUTES: DeploymentPublicRoute[] = [
  {
    id: 'web:8080:0',
    service: 'web',
    port: 8080,
    hostname: 'r1-web-8080-env-1.apps.sammy.party',
    hostPort: 36120,
    routeIndex: 0,
  },
  {
    id: 'api:3000:1',
    service: 'api',
    port: 3000,
    hostname: 'r2-api-3000-env-1.apps.sammy.party',
    hostPort: 36121,
    routeIndex: 1,
  },
];

const WEB_ROUTE_HOSTNAME = 'r1-web-8080-env-1.apps.sammy.party';

function makeDomain(overrides: Partial<DeploymentCustomDomain>): DeploymentCustomDomain {
  return {
    id: 'domain-1',
    environmentId: ENV_ID,
    service: 'web',
    port: 8080,
    routeIndex: 0,
    hostname: 'app.customer.example.com',
    verificationStatus: 'pending',
    verificationError: null,
    verifiedAt: null,
    verifiedCnameTarget: null,
    desiredState: 'active',
    routingStatus: 'pending_dns',
    servingStatus: 'pending_dns',
    activationRoutingRevision: null,
    deactivationRoutingRevision: null,
    deletedAt: null,
    createdBy: 'user-1',
    createdAt: '2026-06-24T10:00:00.000Z',
    cnameTarget: WEB_ROUTE_HOSTNAME,
    routeTargetChanged: false,
    environmentStatus: 'active',
    desiredRoutingRevision: 0,
    observedRoutingRevision: 0,
    observedRoutingStatus: null,
    observedRoutingError: null,
    ...overrides,
  };
}

async function renderPanel(domains: DeploymentCustomDomain[] = []) {
  mocks.listDeploymentPublicRoutes.mockResolvedValue({ publicRoutes: ROUTES });
  mocks.listDeploymentCustomDomains.mockResolvedValue({ customDomains: domains });
  render(<DeploymentCustomDomainsPanel projectId={PROJECT_ID} environmentId={ENV_ID} />);
  await screen.findByText('Public routes');
}

describe('DeploymentCustomDomainsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('loads public routes and shows the exact CNAME record preview', async () => {
    await renderPanel();

    expect(screen.getAllByText('web:8080').length).toBeGreaterThan(0);
    expect(screen.getAllByText('r1-web-8080-env-1.apps.sammy.party').length).toBeGreaterThan(0);
    expect(screen.getByText('CNAME')).toBeInTheDocument();
    expect(screen.getByText('subdomain.example.com')).toBeInTheDocument();
  });

  it('adds a pending domain to the selected route using service and port', async () => {
    const created = makeDomain({
      id: 'domain-created',
      service: 'api',
      port: 3000,
      routeIndex: 1,
      hostname: 'api.customer.example.com',
      cnameTarget: ROUTES[1]?.hostname ?? null,
    });
    mocks.createDeploymentCustomDomain.mockResolvedValue(created);
    await renderPanel();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'api:3000:1' } });
    fireEvent.change(screen.getByPlaceholderText('app.example.com'), {
      target: { value: 'api.customer.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add pending domain' }));

    await waitFor(() => {
      expect(mocks.createDeploymentCustomDomain).toHaveBeenCalledWith(PROJECT_ID, ENV_ID, {
        service: 'api',
        port: 3000,
        hostname: 'api.customer.example.com',
      });
    });
    expect((await screen.findAllByText('api.customer.example.com')).length).toBeGreaterThan(0);
  });

  it('renders route-missing and failed verification states', async () => {
    await renderPanel([
      makeDomain({
        id: 'missing',
        cnameTarget: null,
        verificationStatus: 'verified',
        verificationError: 'The legacy route is gone.',
      }),
      makeDomain({
        id: 'failed',
        hostname: 'bad.customer.example.com',
        verificationStatus: 'failed',
        verificationError: 'bad.customer.example.com does not resolve to the expected target.',
      }),
    ]);

    expect(screen.getByText('Route missing')).toBeInTheDocument();
    expect(screen.getByText('The legacy route is gone.')).toBeInTheDocument();
    expect(screen.getByText('DNS mismatch')).toBeInTheDocument();
    expect(screen.getByText(/does not resolve/)).toBeInTheDocument();
  });

  it('verifies and deletes custom domains', async () => {
    const pending = makeDomain({ id: 'domain-verify' });
    const verified = {
      ...pending,
      verificationStatus: 'verified' as const,
      verifiedAt: '2026-06-24T10:05:00.000Z',
      verifiedCnameTarget: WEB_ROUTE_HOSTNAME,
      routingStatus: 'activating',
      servingStatus: 'activating',
      activationRoutingRevision: 1,
      desiredRoutingRevision: 1,
    };
    mocks.verifyDeploymentCustomDomain.mockResolvedValue(verified);
    mocks.deleteDeploymentCustomDomain.mockResolvedValue({
      ...verified,
      desiredState: 'deactivating',
      routingStatus: 'deactivating',
      servingStatus: 'deactivating',
      deactivationRoutingRevision: 2,
      desiredRoutingRevision: 2,
    });
    await renderPanel([pending]);

    const card = screen.getAllByText(pending.hostname)[0]?.closest('article');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Verify domain' }));

    await waitFor(() => {
      expect(mocks.verifyDeploymentCustomDomain).toHaveBeenCalledWith(
        PROJECT_ID,
        ENV_ID,
        pending.id
      );
    });
    expect((await screen.findAllByText('Verified')).length).toBeGreaterThan(0);

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Remove domain' }));
    await waitFor(() => {
      expect(mocks.deleteDeploymentCustomDomain).toHaveBeenCalledWith(
        PROJECT_ID,
        ENV_ID,
        pending.id
      );
    });
    expect(screen.getByText('Deactivating')).toBeInTheDocument();
  });
});
