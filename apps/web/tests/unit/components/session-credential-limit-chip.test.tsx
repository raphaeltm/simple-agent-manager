import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../../../src/lib/api/client', () => ({
  request: (...args: unknown[]) => request(...args),
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));

import { SessionCredentialLimitChip } from '../../../src/components/credential-limits/SessionCredentialLimitChip';

function renderChip() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <div data-testid="liveness">header</div>
      <SessionCredentialLimitChip projectId="proj-1" agentSessionId="as-1" />
    </QueryClientProvider>
  );
  return client;
}

describe('SessionCredentialLimitChip', () => {
  beforeEach(() => request.mockReset());

  // Reached through the real query, the way the chat header reaches it: the
  // response body decides whether the chip renders, and a body the server never
  // promised (`{}`, as the tool-rail Playwright audit answers) must not crash.
  it('renders nothing and does not crash on an unexpected body', async () => {
    request.mockResolvedValueOnce({});
    const client = renderChip();
    // Wait for the query to settle and the resulting re-render to commit: the
    // crash, when it existed, happened on that re-render, not on first paint.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await waitFor(() => expect(client.getQueryCache().getAll()[0]?.state.status).toBe('success'));
    expect(screen.getByTestId('liveness')).toBeInTheDocument();
    expect(screen.queryByTestId('credential-limit-chip')).toBeNull();
  });

  it('renders the chip for a well-formed credential (control)', async () => {
    request.mockResolvedValueOnce({
      generatedAt: 1,
      credentials: [
        {
          credentialReference: 'cc_credentials:cred-1',
          credentialId: 'cred-1',
          credentialSource: 'user',
          provider: 'openai',
          providerMode: 'direct',
          agentType: 'openai-codex',
          level: 'ok',
          observedAt: Date.now(),
          windows: [
            {
              windowType: 'codex.primary',
              provider: 'openai',
              source: 'vm-agent.codex_rollout',
              status: 'allowed',
              level: 'ok',
              utilizationPercent: 65,
              limitAmount: null,
              remainingAmount: null,
              windowMinutes: 10080,
              resetsAt: null,
              observedAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        },
      ],
    });
    renderChip();
    await screen.findByTestId('credential-limit-chip');
    expect(screen.getByTestId('credential-limit-chip')).toHaveTextContent('Codex · Week 65%');
  });
});
