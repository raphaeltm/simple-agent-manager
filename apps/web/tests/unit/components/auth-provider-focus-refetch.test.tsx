/**
 * A signed-out visitor returning to the tab must keep what they were doing.
 *
 * Regression (2026-11-09, first-run email sign-in on a phone): switching to the mail app and back
 * made BetterAuth refetch the session. It reports that refetch as `isPending` while the session
 * is null, AuthProvider swapped the whole app for its "Verifying your session" spinner, and the
 * sign-in page remounted with the code field gone. This drives the real BetterAuth client and
 * its real focus listener; only the network is faked.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../../src/components/AuthProvider';

// BetterAuth binds `fetch` when its client module loads, so the fake must exist before import.
const network = vi.hoisted(() => {
  const state = { impl: (_url: string): Promise<Response> => new Promise<Response>(() => {}) };
  globalThis.fetch = ((input: RequestInfo | URL) =>
    state.impl(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )) as typeof fetch;
  return state;
});

vi.mock('../../../src/hooks/useQueryCachePersistence', () => ({
  useQueryCachePersistence: () => false,
  discardPersistedQueryCache: vi.fn(),
}));

let sessionRequests = 0;
let releaseRefetch: (() => void) | null = null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  sessionRequests = 0;
  releaseRefetch = null;
  network.impl = async (url) => {
    if (!url.includes('/get-session')) return json(null);
    sessionRequests += 1;
    if (sessionRequests === 1) return json(null);
    // Hold the focus refetch open so the test can look at the page mid-flight.
    await new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    return json(null);
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stands in for the sign-in form: local state that a remount would throw away. */
function CodeEntry() {
  const [code, setCode] = useState('');
  return <input aria-label="Sign-in code" value={code} onChange={(e) => setCode(e.target.value)} />;
}

it('keeps a signed-out page mounted while the session refetches on window focus', async () => {
  render(
    <AuthProvider>
      <CodeEntry />
    </AuthProvider>
  );
  // The first answer (signed out) settles the provider; the visitor starts typing after that.
  await waitFor(() => expect(sessionRequests).toBe(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '123456' } });
  expect(screen.getByLabelText('Sign-in code')).toHaveValue('123456');

  // BetterAuth skips focus refetches within 5 seconds of the last request.
  const later = Date.now() + 10_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await waitFor(() => expect(sessionRequests).toBe(2));
  // Mid-refetch: the page is still there with what the visitor typed, and no spinner covers it.
  expect(screen.getByLabelText('Sign-in code')).toHaveValue('123456');
  expect(screen.queryByRole('status', { name: 'Verifying your session' })).not.toBeInTheDocument();

  await act(async () => {
    releaseRefetch?.();
  });
  expect(screen.getByLabelText('Sign-in code')).toHaveValue('123456');
});
