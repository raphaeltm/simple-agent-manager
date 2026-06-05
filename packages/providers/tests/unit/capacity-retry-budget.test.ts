import { afterEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider } from '../../src/hetzner';
import type { ProviderLogger, VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';
import { createMockServer } from '../fixtures/hetzner-mocks';

function mockLogger(): ProviderLogger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
  };
}

const vmConfig: VMConfig = {
  name: 'test-server',
  size: 'medium',
  location: 'fsn1',
  userData: '#cloud-config',
  labels: { node: 'node-123' },
};

function capacityErrorResponse(code = 'resource_unavailable', msg = 'unsupported location for server type') {
  return new Response(
    JSON.stringify({ error: { code, message: msg } }),
    { status: 422 },
  );
}

function successResponse() {
  return new Response(
    JSON.stringify({ server: createMockServer({ status: 'initializing' }) }),
    { status: 201 },
  );
}

describe('HetznerProvider time-bounded capacity retry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('retries transient_capacity (via structured code) and succeeds on later attempt', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 5,
      capacityRetryBudgetMs: 60_000,
    });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse())
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.id).toBe('12345');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries Hetzner "unsupported location for server type" 422 with code resource_unavailable', async () => {
    vi.useFakeTimers();
    const logger = mockLogger();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 5,
      capacityRetryBudgetMs: 60_000,
      logger,
    });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse('resource_unavailable', 'unsupported location for server type'))
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.id).toBe('12345');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'hetzner transient capacity error; retrying createVM',
      expect.objectContaining({
        providerCode: 'resource_unavailable',
      }),
    );
  });

  it('does NOT retry quota_exceeded errors (fails fast)', async () => {
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 5,
      capacityRetryBudgetMs: 60_000,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'server_limit_exceeded', message: 'server limit exceeded' } }),
        { status: 403 },
      ),
    );

    const err = await provider.createVM(vmConfig).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('server limit exceeded');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry invalid_config errors (fails fast)', async () => {
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 5,
      capacityRetryBudgetMs: 60_000,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'invalid_input', message: 'invalid server_type' } }),
        { status: 422 },
      ),
    );

    const err = await provider.createVM(vmConfig).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('invalid server_type');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when time budget is exceeded', async () => {
    vi.useFakeTimers();
    const logger = mockLogger();
    // Budget of 150ms, initial delay 100ms — allows ~1 retry before budget runs out
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 10,
      capacityRetryBudgetMs: 150,
      logger,
    });

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(capacityErrorResponse()),
    );

    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain('Capacity exhausted');
    expect(err.category).toBe('transient_capacity');
    // Should have stopped due to budget, not max attempts (10)
    const callCount = vi.mocked(fetch).mock.calls.length;
    expect(callCount).toBeLessThan(10);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('stops retrying when max attempts reached within budget', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 2,
      capacityRetryBudgetMs: 999_999, // huge budget — should not be the limiting factor
    });

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(capacityErrorResponse()),
    );

    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('Capacity exhausted after 2 attempts');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('logs budgetRemainingMs in retry warnings', async () => {
    vi.useFakeTimers();
    const logger = mockLogger();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 5,
      capacityRetryBudgetMs: 60_000,
      logger,
    });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse())
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);
    await vi.runAllTimersAsync();
    await promise;

    const warnCalls = vi.mocked(logger.warn).mock.calls.filter(
      (call) => call[0].includes('transient capacity error'),
    );
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toHaveProperty('budgetRemainingMs');
    expect(typeof warnCalls[0]?.[1]?.budgetRemainingMs).toBe('number');
  });

  it('capacity exhaustion error carries transient_capacity category', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, {
      capacityRetryMaxAttempts: 1,
      capacityRetryBudgetMs: 60_000,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(capacityErrorResponse());

    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.category).toBe('transient_capacity');
    expect(err.cause).toBeInstanceOf(ProviderError);
  });

  it('config knobs control retry behavior via createProvider-style constructor', async () => {
    vi.useFakeTimers();
    // Use specific values to verify they're threaded through
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 50, 200, {
      capacityRetryMaxAttempts: 3,
      capacityRetryBudgetMs: 10_000,
    });

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(capacityErrorResponse()),
    );

    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('Capacity exhausted after 3 attempts');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('providerFetch threads providerCode through ProviderError', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts Hetzner error.code as providerCode', async () => {
    const { providerFetch } = await import('../../src/provider-fetch');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'resource_unavailable', message: 'unsupported location for server type' },
        }),
        { status: 422 },
      ),
    );

    const err = await providerFetch('hetzner', 'https://api.hetzner.cloud/v1/servers').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.providerCode).toBe('resource_unavailable');
  });

  it('extracts Scaleway type field as providerCode', async () => {
    // Test via providerFetch directly imported
    const { providerFetch } = await import('../../src/provider-fetch');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'quota_exceeded', message: 'quota exceeded for this resource' }),
        { status: 403 },
      ),
    );

    const err = await providerFetch('scaleway', 'https://api.scaleway.com/test').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.providerCode).toBe('quota_exceeded');
  });

  it('extracts GCP error.status as providerCode', async () => {
    const { providerFetch } = await import('../../src/provider-fetch');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' },
        }),
        { status: 429 },
      ),
    );

    const err = await providerFetch('gcp', 'https://compute.googleapis.com/test').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.providerCode).toBe('RESOURCE_EXHAUSTED');
  });
});
