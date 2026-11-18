/**
 * Admin → Logs and Admin → Stream on a self-hosted install: the capabilities query (real, with
 * fetch stubbed at the boundary) says log search and the live stream are off, so each page shows
 * where logs are read instead of an error or a stream that waits forever.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ASSUMED_PLATFORM_CAPABILITIES } from '../../../src/lib/api/platform-capabilities';
import { AdminLogs } from '../../../src/pages/AdminLogs';
import { AdminStream } from '../../../src/pages/AdminStream';

vi.mock('../../../src/components/admin/LogViewer', () => ({
  LogViewer: () => <div data-testid="log-viewer" />,
}));
vi.mock('../../../src/components/admin/LogStream', () => ({
  LogStream: () => <div data-testid="log-stream" />,
}));

function serveCapabilities(body: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/config/platform-capabilities')) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function withQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const SELF_HOST = { ...ASSUMED_PLATFORM_CAPABILITIES, logSearch: false, liveLogStream: false };

afterEach(() => vi.unstubAllGlobals());

describe('admin log pages on a self-hosted install', () => {
  it('Logs shows the box log commands instead of the search viewer', async () => {
    serveCapabilities(SELF_HOST);
    render(withQuery(<AdminLogs />));
    await waitFor(() => expect(screen.getByTestId('box-logs-notice')).toBeInTheDocument());
    expect(screen.queryByTestId('log-viewer')).toBeNull();
    expect(screen.getByText(/docker compose logs -f --since 30m celld/)).toBeInTheDocument();
    expect(screen.getByText(/Log search is not available/)).toBeInTheDocument();
  });

  it('Stream shows the notice and never mounts the WebSocket stream', async () => {
    serveCapabilities(SELF_HOST);
    render(withQuery(<AdminStream />));
    await waitFor(() => expect(screen.getByTestId('box-logs-notice')).toBeInTheDocument());
    expect(screen.queryByTestId('log-stream')).toBeNull();
    expect(screen.getByText(/live log stream is not available/)).toBeInTheDocument();
  });

  it('mounts neither the search viewer nor the stream until the capabilities answer arrives', async () => {
    // Hold the answer open: a box must not get a log query or a WebSocket from the assumed
    // "every service present" default while the request is outstanding.
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          })
      )
    );
    render(
      withQuery(
        <>
          <AdminLogs />
          <AdminStream />
        </>
      )
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('log-viewer')).toBeNull();
    expect(screen.queryByTestId('log-stream')).toBeNull();

    answer(
      new Response(JSON.stringify(SELF_HOST), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    // Liveness: once answered, the box notice renders for both pages.
    await waitFor(() => expect(screen.getAllByTestId('box-logs-notice')).toHaveLength(2));
    expect(screen.queryByTestId('log-viewer')).toBeNull();
    expect(screen.queryByTestId('log-stream')).toBeNull();
  });

  it('Cloudflare installs keep the viewer and the stream', async () => {
    const fetchMock = serveCapabilities(ASSUMED_PLATFORM_CAPABILITIES);
    render(
      withQuery(
        <>
          <AdminLogs />
          <AdminStream />
        </>
      )
    );
    await waitFor(() => expect(screen.getByTestId('log-viewer')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.getByTestId('log-stream')).toBeInTheDocument();
    expect(screen.queryByTestId('box-logs-notice')).toBeNull();
  });
});
