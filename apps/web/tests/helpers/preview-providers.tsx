import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

/**
 * Renders a tree that mounts the library file preview.
 *
 * The preview shows where a file came from, which means it reads the linked-work query, which
 * means it needs a `QueryClientProvider` and the identity that scopes the cache key — exactly
 * what the real app gives it at the root. Rows inside it are router links, so a router is
 * needed too.
 *
 * Callers must additionally mock `useAuth`, because `AuthContext` is module-private; see the
 * `vi.mock` block at the top of each test file that uses this helper.
 */
export function renderWithPreviewProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  }
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}
