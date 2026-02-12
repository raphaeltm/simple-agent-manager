import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNodeAgentReadyPollIntervalMs,
  getNodeAgentReadyTimeoutMs,
  waitForNodeAgentReady,
} from '../../../src/services/node-agent';

describe('node-agent readiness helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('parses node-agent readiness timeout/poll interval with safe defaults', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '15000' })).toBe(15000);
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '0' })).toBe(120000);
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: 'abc' })).toBe(120000);

    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: '750' })).toBe(
      750
    );
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: '-1' })).toBe(
      5000
    );
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: 'oops' })).toBe(
      5000
    );
  });

  it('returns once node agent health endpoint responds with success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await waitForNodeAgentReady('NODE_ABC', {
      BASE_DOMAIN: 'example.com',
      NODE_AGENT_READY_TIMEOUT_MS: '5000',
      NODE_AGENT_READY_POLL_INTERVAL_MS: '1000',
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('http://vm-node_abc.example.com:8080/health');
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws after timeout when node agent health never becomes reachable', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('error code: 1014', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const waitPromise = waitForNodeAgentReady('NODE_TIMEOUT', {
      BASE_DOMAIN: 'example.com',
      NODE_AGENT_READY_TIMEOUT_MS: '20',
      NODE_AGENT_READY_POLL_INTERVAL_MS: '5',
    } as never);

    const rejection = expect(waitPromise).rejects.toThrow('Node Agent not reachable');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fetchMock).toHaveBeenCalled();
  });

  it('aborts each health probe when fetch hangs and reports timeout details', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }

        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const waitPromise = waitForNodeAgentReady('NODE_HANG', {
      BASE_DOMAIN: 'example.com',
      NODE_AGENT_READY_TIMEOUT_MS: '40',
      NODE_AGENT_READY_POLL_INTERVAL_MS: '10',
    } as never);

    const rejection = expect(waitPromise).rejects.toThrow(/request timeout after/i);
    await vi.advanceTimersByTimeAsync(45);
    await rejection;
    expect(fetchMock).toHaveBeenCalled();
  });
});
