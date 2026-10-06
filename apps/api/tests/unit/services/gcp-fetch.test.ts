import { ProviderError } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchGcpWithTimeout } from '../../../src/services/gcp-fetch';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pendingAbortAwareFetch() {
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
        once: true,
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, getRequestSignal: () => requestSignal };
}

describe('fetchGcpWithTimeout', () => {
  it('does not start GCP authentication HTTP for a pre-cancelled caller', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const reason = new ProviderError('gcp', 503, 'caller cancelled authentication');
    caller.abort(reason);

    await expect(
      fetchGcpWithTimeout('https://oauth2.googleapis.test/token', {}, 10_000, {
        signal: caller.signal,
      })
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves an in-flight caller abort instead of reporting the internal timeout', async () => {
    const { fetchMock, getRequestSignal } = pendingAbortAwareFetch();
    const caller = new AbortController();
    const reason = new ProviderError('gcp', 409, 'caller cancelled token exchange');

    const request = fetchGcpWithTimeout('https://oauth2.googleapis.test/token', {}, 10_000, {
      signal: caller.signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(getRequestSignal()?.reason).toBe(reason);
  });

  it('preserves caller cancellation after GCP response headers while the body is pending', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            requestSignal?.addEventListener(
              'abort',
              () => controller.error(requestSignal?.reason),
              { once: true }
            );
          },
        });
        return Promise.resolve(new Response(body));
      })
    );
    const caller = new AbortController();
    const reason = new ProviderError('gcp', 409, 'caller cancelled pending GCP body');

    const request = fetchGcpWithTimeout('https://oauth2.googleapis.test/token', {}, 10_000, {
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(requestSignal?.reason).toBe(reason);
  });

  it('preserves cancellation that wins as a successful zero-body GCP response settles', async () => {
    const caller = new AbortController();
    const reason = new ProviderError('gcp', 409, 'caller cancelled zero-body GCP response');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        queueMicrotask(() => caller.abort(reason));
        return Promise.resolve(new Response(null, { status: 204 }));
      })
    );

    await expect(
      fetchGcpWithTimeout('https://compute.googleapis.test/operation', {}, 10_000, {
        signal: caller.signal,
      })
    ).rejects.toBe(reason);
  });

  it('keeps an internal timeout distinct when it wins before caller cancellation', async () => {
    vi.useFakeTimers();
    const { getRequestSignal } = pendingAbortAwareFetch();
    const caller = new AbortController();

    const result = fetchGcpWithTimeout('https://oauth2.googleapis.test/token', {}, 50, {
      signal: caller.signal,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);

    const timeoutReason = await result;
    expect(timeoutReason).not.toBeUndefined();
    expect(timeoutReason).not.toBe(caller.signal.reason);
    const requestReason = getRequestSignal()?.reason;
    caller.abort(new Error('caller was too late'));
    expect(getRequestSignal()?.reason).toBe(requestReason);
  });

  it.each(['success', 'network failure', 'caller cancellation', 'timeout'] as const)(
    'cleans its caller listener and timer after %s',
    async (outcome) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const addListener = vi.spyOn(caller.signal, 'addEventListener');
      const removeListener = vi.spyOn(caller.signal, 'removeEventListener');

      if (outcome === 'success') {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
      } else if (outcome === 'network failure') {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failed')));
      } else {
        pendingAbortAwareFetch();
      }

      const request = fetchGcpWithTimeout('https://oauth2.googleapis.test/token', {}, 50, {
        signal: caller.signal,
      }).catch((error: unknown) => error);
      if (outcome === 'caller cancellation') caller.abort(new Error('cancelled'));
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(50);
      await request;

      const listener = addListener.mock.calls[0]?.[1];
      expect(listener).toBeTypeOf('function');
      expect(removeListener).toHaveBeenCalledWith('abort', listener);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
