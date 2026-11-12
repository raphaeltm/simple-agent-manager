import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

const fetchLoginProviders = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/api/setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/setup')>()),
  fetchLoginProviders,
}));

import {
  LOGIN_PROVIDERS_STORAGE_KEY,
  useLoginProviders,
} from '../../../src/hooks/useLoginProviders';

const EMAIL_ONLY = { github: false, google: false, gitlab: false, email: true };
const GITHUB_ONLY = { github: true, google: false, gitlab: false, email: false };

function renderProviders(client = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useLoginProviders(), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

it('reports no providers, not a guess, until a first-visit lookup answers', async () => {
  fetchLoginProviders.mockResolvedValue(EMAIL_ONLY);
  const { result } = renderProviders();

  expect(result.current.providers).toBeNull();
  expect(result.current.failed).toBe(false);
  await waitFor(() => expect(result.current.providers).toEqual(EMAIL_ONLY));
  expect(JSON.parse(window.localStorage.getItem(LOGIN_PROVIDERS_STORAGE_KEY)!)).toEqual(EMAIL_ONLY);
});

it('shows the remembered answer at once, then the live answer', async () => {
  window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, JSON.stringify(EMAIL_ONLY));
  fetchLoginProviders.mockResolvedValue(GITHUB_ONLY);
  const { result } = renderProviders();

  expect(result.current.providers).toEqual(EMAIL_ONLY);
  await waitFor(() => expect(result.current.providers).toEqual(GITHUB_ONLY));
  expect(JSON.parse(window.localStorage.getItem(LOGIN_PROVIDERS_STORAGE_KEY)!)).toEqual(
    GITHUB_ONLY
  );
});

it('ignores a malformed remembered answer', () => {
  window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, '{"github":"yes"}');
  fetchLoginProviders.mockReturnValue(new Promise(() => {}));
  expect(renderProviders().result.current.providers).toBeNull();

  window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, 'not json');
  expect(renderProviders().result.current.providers).toBeNull();
});

it('keeps the remembered answer, not a failure, when the lookup fails', async () => {
  window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, JSON.stringify(EMAIL_ONLY));
  fetchLoginProviders.mockRejectedValue(new Error('network down'));
  // The hook sets its own retry count; skip the backoff so the query reaches its error state.
  const client = new QueryClient();
  client.setQueryDefaults(['login-providers'], { retryDelay: 0 });
  const { result } = renderProviders(client);

  await waitFor(() => expect(client.getQueryState(['login-providers'])?.status).toBe('error'));
  expect(result.current.providers).toEqual(EMAIL_ONLY);
  expect(result.current.failed).toBe(false);
});

it('recovers from a failed lookup, so an email-only install still offers its way in', async () => {
  fetchLoginProviders
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValue(EMAIL_ONLY);
  const { result } = renderProviders();

  expect(result.current.providers).toBeNull();
  await waitFor(() => expect(result.current.providers).toEqual(EMAIL_ONLY), { timeout: 5000 });
  expect(fetchLoginProviders).toHaveBeenCalledTimes(2);
});

it('reports a failure with nothing remembered, and retry recovers', async () => {
  // The hook's own `retry: 3` wins over client defaults, so drive it past the retries quickly.
  const client = new QueryClient();
  client.setQueryDefaults(['login-providers'], { retryDelay: 0 });
  fetchLoginProviders.mockRejectedValue(new Error('network down'));
  const { result } = renderProviders(client);

  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.providers).toBeNull();

  fetchLoginProviders.mockResolvedValue(EMAIL_ONLY);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.providers).toEqual(EMAIL_ONLY));
  expect(result.current.failed).toBe(false);
});

it('ignores a remembered answer whose agent sign-in flag is not a boolean', () => {
  fetchLoginProviders.mockReturnValue(new Promise(() => {}));
  window.localStorage.setItem(
    LOGIN_PROVIDERS_STORAGE_KEY,
    JSON.stringify({ ...EMAIL_ONLY, agentSignIn: 0 })
  );
  expect(renderProviders().result.current.providers).toBeNull();

  // Control: a boolean flag, or none at all (older deployments), is a valid remembered answer.
  window.localStorage.setItem(
    LOGIN_PROVIDERS_STORAGE_KEY,
    JSON.stringify({ ...EMAIL_ONLY, agentSignIn: true })
  );
  expect(renderProviders().result.current.providers).toEqual({ ...EMAIL_ONLY, agentSignIn: true });
});

it('discloses agent sign-in only from a live answer or a remembered yes', async () => {
  window.localStorage.setItem(
    LOGIN_PROVIDERS_STORAGE_KEY,
    JSON.stringify({ ...EMAIL_ONLY, agentSignIn: false })
  );
  let answer: (value: unknown) => void = () => {};
  fetchLoginProviders.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const { result } = renderProviders();
  // A remembered "off" is not an answer: it may predate trust being turned on.
  expect(result.current.agentSignIn).toBe('checking');
  act(() => answer({ ...EMAIL_ONLY, agentSignIn: false }));
  await waitFor(() => expect(result.current.agentSignIn).toBe('refuses'));

  window.localStorage.setItem(
    LOGIN_PROVIDERS_STORAGE_KEY,
    JSON.stringify({ ...EMAIL_ONLY, agentSignIn: true })
  );
  fetchLoginProviders.mockReturnValue(new Promise(() => {}));
  expect(renderProviders().result.current.agentSignIn).toBe('accepts');
});

it('reports agent sign-in as unknown when the lookup fails without a remembered yes', async () => {
  window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, JSON.stringify(EMAIL_ONLY));
  fetchLoginProviders.mockRejectedValue(new Error('network down'));
  const client = new QueryClient();
  client.setQueryDefaults(['login-providers'], { retryDelay: 0 });
  const { result } = renderProviders(client);
  await waitFor(() => expect(result.current.agentSignIn).toBe('unknown'));
  expect(result.current.providers).toEqual(EMAIL_ONLY);
});
