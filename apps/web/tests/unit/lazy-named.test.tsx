import { cleanup, render, screen } from '@testing-library/react';
import { Component, type ReactNode, Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lazyNamed } from '../../src/lib/lazy-with-retry';

/**
 * Direct coverage of `lazyNamed` itself.
 *
 * `app-code-splitting.test.tsx` exercises it transitively through `App`, but only ever
 * with page modules that resolve successfully. These tests cover the wrapper's own
 * contract, including the case TypeScript cannot catch at runtime: a module that
 * resolves but does not carry the requested export (a rename, or a `vi.mock` factory
 * that forgets it).
 */

class CatchBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  render() {
    if (this.state.message !== null) {
      return <div data-testid="boundary">{this.state.message}</div>;
    }
    return this.props.children;
  }
}

afterEach(() => {
  cleanup();
});

describe('lazyNamed', () => {
  it('renders the named export from the resolved module', async () => {
    const Page = lazyNamed(
      () => Promise.resolve({ Widget: () => <div data-testid="widget">hello</div> }),
      'Widget'
    );

    render(
      <Suspense fallback={<div data-testid="pending" />}>
        <Page />
      </Suspense>
    );

    expect(screen.getByTestId('pending')).toBeInTheDocument();
    expect(await screen.findByTestId('widget')).toHaveTextContent('hello');
  });

  it('surfaces a missing export to the error boundary rather than rendering nothing', async () => {
    // A resolved-but-wrong module is NOT a chunk-load failure, so it must not be
    // retried or trigger a reload — it is a code bug and belongs on the error path.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const Page = lazyNamed(
      () =>
        Promise.resolve({ SomethingElse: () => <div /> }) as Promise<{
          Widget: () => ReactNode;
        }>,
      'Widget'
    );

    render(
      <CatchBoundary>
        <Suspense fallback={<div data-testid="pending" />}>
          <Page />
        </Suspense>
      </CatchBoundary>
    );

    const boundary = await screen.findByTestId('boundary');
    expect(boundary.textContent ?? '').not.toBe('');

    consoleError.mockRestore();
  });

  it('does not evaluate the loader until the component is rendered', async () => {
    const loader = vi.fn(() => Promise.resolve({ Widget: () => <div data-testid="widget" /> }));
    const Page = lazyNamed(loader, 'Widget');

    // Declaring the lazy component must not fetch its chunk — that is the entire point
    // of route-level splitting.
    expect(loader).not.toHaveBeenCalled();

    render(
      <Suspense fallback={<div data-testid="pending" />}>
        <Page />
      </Suspense>
    );
    await screen.findByTestId('widget');

    expect(loader).toHaveBeenCalledTimes(1);
  });
});
