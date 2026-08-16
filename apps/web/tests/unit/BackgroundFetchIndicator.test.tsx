import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundFetchIndicator } from '../../src/components/BackgroundFetchIndicator';

const QUERY_KEY = ['indicator-test'] as const;

function QueryConsumer({ queryFn }: { queryFn: () => Promise<string> }) {
  const query = useQuery({ queryKey: QUERY_KEY, queryFn });
  return <span>{query.data ?? 'No data'}</span>;
}

describe('BackgroundFetchIndicator', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
  });

  it('only becomes visible for a delayed background refresh with cached data', async () => {
    const queryFn = vi.fn().mockResolvedValue('Cached data');
    render(
      <QueryClientProvider client={queryClient}>
        <BackgroundFetchIndicator />
        <QueryConsumer queryFn={queryFn} />
      </QueryClientProvider>,
    );

    const indicator = screen.getByTestId('background-fetch-indicator');
    expect(indicator).toHaveAttribute('data-refreshing', 'false');
    expect(indicator).toHaveClass('opacity-0');
    expect(await screen.findByText('Cached data')).toBeInTheDocument();

    let resolveRefresh: ((value: string) => void) | undefined;
    queryFn.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    act(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });

    expect(indicator).toHaveAttribute('data-refreshing', 'false');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await waitFor(() => expect(indicator).toHaveAttribute('data-refreshing', 'true'));
    expect(indicator).toHaveClass('opacity-100');
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing data');
    expect(screen.getByText('Cached data')).toBeInTheDocument();

    await act(async () => {
      resolveRefresh?.('Fresh data');
    });

    await waitFor(() => expect(indicator).toHaveAttribute('data-refreshing', 'false'));
    expect(screen.getByText('Fresh data')).toBeInTheDocument();
  });

  it('never shows or announces a background refresh that finishes before the delay', async () => {
    const queryFn = vi.fn().mockResolvedValue('Cached data');
    render(
      <QueryClientProvider client={queryClient}>
        <BackgroundFetchIndicator />
        <QueryConsumer queryFn={queryFn} />
      </QueryClientProvider>,
    );
    await screen.findByText('Cached data');

    const indicator = screen.getByTestId('background-fetch-indicator');
    const observedStates: string[] = [];
    const observer = new MutationObserver(() => {
      observedStates.push(indicator.getAttribute('data-refreshing') ?? 'missing');
    });
    observer.observe(indicator, { attributes: true, attributeFilter: ['data-refreshing'] });

    queryFn.mockResolvedValueOnce('Fresh data');
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
    await screen.findByText('Fresh data');
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    observer.disconnect();

    expect(observedStates).not.toContain('true');
    expect(indicator).toHaveAttribute('data-refreshing', 'false');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
