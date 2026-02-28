/**
 * Behavioral unit tests for node agent health polling (TDF-3).
 *
 * Tests:
 * - getNodeAgentReadyTimeoutMs() — env var parsing with defaults
 * - getNodeAgentReadyPollIntervalMs() — env var parsing with defaults
 * - waitForNodeAgentReady() — polling loop with timeout, retries, error capture
 *
 * waitForNodeAgentReady is tested by mocking global fetch to simulate
 * various failure/success scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getNodeAgentReadyTimeoutMs,
  getNodeAgentReadyPollIntervalMs,
} from '../../src/services/node-agent';

// =============================================================================
// getNodeAgentReadyTimeoutMs — env var parsing
// =============================================================================

describe('getNodeAgentReadyTimeoutMs', () => {
  it('returns default 120000ms when env var is undefined', () => {
    expect(getNodeAgentReadyTimeoutMs({})).toBe(120000);
  });

  it('returns default when env var is empty string', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '' })).toBe(120000);
  });

  it('parses valid integer from env var', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '60000' })).toBe(60000);
  });

  it('returns default for non-numeric string', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: 'abc' })).toBe(120000);
  });

  it('returns default for zero', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '0' })).toBe(120000);
  });

  it('returns default for negative number', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '-5000' })).toBe(120000);
  });

  it('returns default for NaN', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: 'NaN' })).toBe(120000);
  });

  it('returns default for Infinity', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: 'Infinity' })).toBe(120000);
  });

  it('parses small timeout value', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '1000' })).toBe(1000);
  });

  it('parses very large timeout value', () => {
    expect(getNodeAgentReadyTimeoutMs({ NODE_AGENT_READY_TIMEOUT_MS: '600000' })).toBe(600000);
  });
});

// =============================================================================
// getNodeAgentReadyPollIntervalMs — env var parsing
// =============================================================================

describe('getNodeAgentReadyPollIntervalMs', () => {
  it('returns default 5000ms when env var is undefined', () => {
    expect(getNodeAgentReadyPollIntervalMs({})).toBe(5000);
  });

  it('returns default when env var is empty string', () => {
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: '' })).toBe(5000);
  });

  it('parses valid integer from env var', () => {
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: '2000' })).toBe(2000);
  });

  it('returns default for non-numeric string', () => {
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: 'abc' })).toBe(5000);
  });

  it('returns default for zero', () => {
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: '0' })).toBe(5000);
  });

  it('returns default for negative number', () => {
    expect(getNodeAgentReadyPollIntervalMs({ NODE_AGENT_READY_POLL_INTERVAL_MS: '-1000' })).toBe(5000);
  });
});

// =============================================================================
// waitForNodeAgentReady — polling behavior tests
// =============================================================================

describe('waitForNodeAgentReady', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  // Minimal env required by waitForNodeAgentReady
  const makeEnv = (overrides: Record<string, string> = {}) => ({
    BASE_DOMAIN: 'test.example.com',
    NODE_AGENT_READY_TIMEOUT_MS: overrides.NODE_AGENT_READY_TIMEOUT_MS ?? '500',
    NODE_AGENT_READY_POLL_INTERVAL_MS: overrides.NODE_AGENT_READY_POLL_INTERVAL_MS ?? '50',
    // other required Env fields stub
    DATABASE: {} as any,
    OBSERVABILITY_DATABASE: {} as any,
    JWT_PRIVATE_KEY: 'test-key',
    JWT_PUBLIC_KEY: 'test-pub',
    ENCRYPTION_KEY: 'test-enc',
    KV: {} as any,
  }) as any;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    // Use fake timers but allow promises to resolve
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('resolves immediately on first successful health check', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    await expect(waitForNodeAgentReady('node-1', makeEnv())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://vm-node-1.test.example.com:8080/health');
  });

  it('retries on non-ok response and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('starting', { status: 503 }))
      .mockResolvedValueOnce(new Response('starting', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    await expect(waitForNodeAgentReady('node-1', makeEnv())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries on fetch exception and succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    await expect(waitForNodeAgentReady('node-1', makeEnv())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on timeout after all retries fail', async () => {
    // Always fail
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const env = makeEnv({
      NODE_AGENT_READY_TIMEOUT_MS: '200',
      NODE_AGENT_READY_POLL_INTERVAL_MS: '50',
    });

    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    await expect(waitForNodeAgentReady('node-1', env)).rejects.toThrow(
      /Node Agent not reachable/
    );
  });

  it('includes last error in timeout message', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const env = makeEnv({
      NODE_AGENT_READY_TIMEOUT_MS: '200',
      NODE_AGENT_READY_POLL_INTERVAL_MS: '50',
    });

    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    await expect(waitForNodeAgentReady('node-1', env)).rejects.toThrow(
      /Last error:.*502/
    );
  });

  it('uses the correct health URL based on nodeId and BASE_DOMAIN', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const env = makeEnv();
    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    await waitForNodeAgentReady('ABC-123', env);

    // Node ID should be lowercased in the URL
    expect(fetchMock.mock.calls[0][0]).toBe('http://vm-abc-123.test.example.com:8080/health');
  });

  it('respects custom timeout from env var', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const env = makeEnv({
      NODE_AGENT_READY_TIMEOUT_MS: '100',
      NODE_AGENT_READY_POLL_INTERVAL_MS: '20',
    });

    const start = Date.now();
    const { waitForNodeAgentReady } = await import('../../src/services/node-agent');
    try {
      await waitForNodeAgentReady('node-1', env);
    } catch {
      // Expected
    }
    const elapsed = Date.now() - start;
    // Should timeout around 100ms (not the default 120s)
    expect(elapsed).toBeLessThan(5000);
  });
});
