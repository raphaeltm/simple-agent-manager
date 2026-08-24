import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RenderOptions } from '@testing-library/react';
import { render } from '@testing-library/react';
import { type ReactElement, type ReactNode, useState } from 'react';

/**
 * Creates a fresh QueryClient configured for tests:
 *  - retries disabled so failures surface immediately
 *  - gcTime 0 to avoid leaking state between tests
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

/**
 * Wraps children in a QueryClientProvider with a disposable test client.
 * Use via `renderWithQuery()` or as a standalone wrapper for tests that
 * need additional providers layered around the query provider.
 *
 * The client is held in state rather than constructed during render: a fresh
 * `QueryClient` per render would discard the cache on every re-render, so any test
 * asserting dedup, cache reuse, or stale-while-revalidate would silently measure a
 * cold cache each time.
 */
export function QueryTestWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Drop-in replacement for `render()` that wraps the UI in a
 * `QueryClientProvider` with a fresh, isolated `QueryClient`.
 *
 * Accepts all the same options as `@testing-library/react`'s `render`.
 * Any additional `wrapper` you supply will be nested _inside_ the
 * QueryClientProvider so queries are available throughout.
 */
export function renderWithQuery(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'> & { wrapper?: React.ComponentType<{ children: ReactNode }> },
) {
  const { wrapper: InnerWrapper, ...rest } = options ?? {};
  // One client per `renderWithQuery` call (not per render) so the cache survives
  // re-renders within a single test.
  const client = createTestQueryClient();

  function Wrapper({ children }: { children: ReactNode }) {
    const inner = InnerWrapper ? <InnerWrapper>{children}</InnerWrapper> : children;
    return <QueryClientProvider client={client}>{inner}</QueryClientProvider>;
  }

  return { ...render(ui, { wrapper: Wrapper, ...rest }), queryClient: client };
}
