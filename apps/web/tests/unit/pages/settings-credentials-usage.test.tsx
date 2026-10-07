import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listCCCredentials: mocks.listCCCredentials,
  listCCConfigurations: mocks.listCCConfigurations,
  listCCAttachments: mocks.listCCAttachments,
  listProjects: mocks.listProjects,
  getMyCredentialLimits: mocks.getMyCredentialLimits,
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

import { SettingsCredentials } from '../../../src/pages/SettingsCredentials';

const NOW = Date.now();

function credentialRow(id: string, name: string) {
  return {
    id,
    name,
    kind: 'oauth-token',
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function usage(credentialId: string, utilization: number) {
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    agentType: 'claude-code',
    level: utilization >= 75 ? 'warning' : 'ok',
    observedAt: NOW - 5 * 60_000,
    windows: [
      {
        windowType: 'claude.five_hour',
        provider: 'anthropic',
        source: 'claude-acp.rate_limit',
        status: 'allowed',
        level: utilization >= 75 ? 'warning' : 'ok',
        utilizationPercent: utilization,
        limitAmount: null,
        remainingAmount: null,
        windowMinutes: 300,
        resetsAt: NOW + 3_600_000,
        observedAt: NOW - 5 * 60_000,
        updatedAt: NOW - 5 * 60_000,
      },
    ],
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsCredentials />
    </QueryClientProvider>
  );
}

describe('SettingsCredentials usage rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCCCredentials.mockResolvedValue([
      credentialRow('cred-claude', 'Claude Max'),
      credentialRow('cred-silent', 'Key without samples'),
    ]);
    mocks.listCCConfigurations.mockResolvedValue([]);
    mocks.listCCAttachments.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue({ projects: [] });
  });

  it('shows a usage row only on the credential whose id matches a limits entry', async () => {
    mocks.getMyCredentialLimits.mockResolvedValue({
      credentials: [usage('cred-claude', 72), usage('cred-unknown-elsewhere', 10)],
      generatedAt: NOW,
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Claude Max')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByTestId('credential-usage-row')).toHaveLength(1));
    const row = screen.getByTestId('credential-usage-row');
    expect(row).toHaveTextContent('Claude · 5h 72%');
    expect(row).toHaveTextContent('sampled 5m ago');
    // The card without samples renders normally, without a usage row.
    expect(screen.getByText('Key without samples')).toBeInTheDocument();
    expect(mocks.getMyCredentialLimits).toHaveBeenCalledTimes(1);
  });

  it('renders every card without usage rows when the limits request fails', async () => {
    mocks.getMyCredentialLimits.mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() => expect(screen.getByText('Claude Max')).toBeInTheDocument());
    await waitFor(() => expect(mocks.getMyCredentialLimits).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Key without samples')).toBeInTheDocument();
    expect(screen.queryByTestId('credential-usage-row')).toBeNull();
  });
});
