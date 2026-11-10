import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

const fetchLoginProviders = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/api/setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/setup')>()),
  fetchLoginProviders,
}));

import { useLoginProviders } from '../../../src/hooks/useLoginProviders';

it('recovers from a failed lookup, so an email-only install still offers its way in', async () => {
  // On an email-only install the defaults hide the only working sign-in form: a single failed
  // request must not leave the page stuck on them.
  fetchLoginProviders
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValue({ github: false, google: false, gitlab: false, email: true });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useLoginProviders(), { wrapper });

  // Until the deployment answers: GitHub shows, nothing that could error on use.
  expect(result.current).toEqual({ github: true, google: false, gitlab: false, email: false });
  await waitFor(
    () =>
      expect(result.current).toEqual({ github: false, google: false, gitlab: false, email: true }),
    { timeout: 5000 }
  );
  expect(fetchLoginProviders).toHaveBeenCalledTimes(2);
});
