import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

import { ConnectedAccountsSection } from '../../../src/components/ConnectedAccountsSection';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  list: vi.fn(),
  providers: { github: true, google: false, gitlab: false } as Record<string, boolean>,
}));
vi.mock('../../../src/lib/auth', () => ({
  connectProvider: mocks.connect,
  listConnectedProviders: mocks.list,
}));
vi.mock('../../../src/hooks/useLoginProviders', () => ({
  useLoginProviders: () => ({ providers: mocks.providers, failed: false, retry: vi.fn() }),
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset();
  mocks.providers = { github: true, google: false, gitlab: false };
});

it('offers Connect GitHub to an account without a GitHub link and starts the link flow', async () => {
  mocks.list.mockResolvedValue([]);
  render(wrap(<ConnectedAccountsSection />));
  const row = await screen.findByTestId('connected-provider-github');
  expect(row).toHaveTextContent('Not connected');
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith('github'));
});

it('shows GitHub as connected, with no button, once linked', async () => {
  mocks.list.mockResolvedValue(['github']);
  render(wrap(<ConnectedAccountsSection />));
  const row = await screen.findByTestId('connected-provider-github');
  await waitFor(() => expect(row).toHaveTextContent('Connected'));
  expect(row).not.toHaveTextContent('Not connected');
  expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
});

it('offers GitLab only where this installation has it', async () => {
  mocks.list.mockResolvedValue([]);
  mocks.providers = { github: false, google: false, gitlab: true };
  render(wrap(<ConnectedAccountsSection />));
  expect(await screen.findByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument();
  expect(screen.queryByTestId('connected-provider-github')).toBeNull();
});

it('shows the error when the link cannot start, and lets the user try again', async () => {
  mocks.list.mockResolvedValue([]);
  mocks.connect.mockRejectedValueOnce(new Error('Could not connect github'));
  render(wrap(<ConnectedAccountsSection />));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
  expect(await screen.findByText('Could not connect github')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect GitHub' })).not.toBeDisabled();
});
