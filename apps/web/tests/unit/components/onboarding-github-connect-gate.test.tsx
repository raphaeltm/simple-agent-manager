import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { GitHubConnectGate } from '../../../src/components/onboarding/choose-path/GitHubConnectGate';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), list: vi.fn() }));
vi.mock('../../../src/lib/auth', () => ({
  connectProvider: mocks.connect,
  listConnectedProviders: mocks.list,
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GitHubConnectGate>
        <button type="button">Install the GitHub app</button>
      </GitHubConnectGate>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset();
});

it('asks an email-signed account to connect GitHub before installing the App', async () => {
  mocks.list.mockResolvedValue([]);
  renderGate();
  fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith('github'));
  expect(screen.queryByRole('button', { name: 'Install the GitHub app' })).toBeNull();
});

it('shows the install step unchanged once GitHub is connected', async () => {
  mocks.list.mockResolvedValue(['github']);
  renderGate();
  expect(await screen.findByRole('button', { name: 'Install the GitHub app' })).toBeInTheDocument();
  expect(screen.queryByTestId('onboarding-connect-github')).toBeNull();
});

it('falls back to the install step when the connected accounts cannot be read', async () => {
  mocks.list.mockRejectedValue(new Error('offline'));
  renderGate();
  expect(await screen.findByRole('button', { name: 'Install the GitHub app' })).toBeInTheDocument();
});
