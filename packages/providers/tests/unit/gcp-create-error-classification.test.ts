/**
 * GCP create errors carry a recovery-action category (rule 72), built through the real
 * `GcpProvider.createVM` the way production builds them (rule 62).
 *
 * Before this, `classifyGcpError` had no call sites: every GCP error reached the TaskRunner as
 * `unknown`, so a zone stockout failed the task on its first attempt. Payloads mirror Compute
 * Engine's documented shapes: an `instances.insert` operation that finishes DONE with
 * `error.errors[]`, and the HTTP error envelope `{ error: { code, message, status?, errors[] } }`.
 * Every call mints a fresh `Response`, and each case asserts the parsed message and code so a
 * degraded fixture (`HTTP 403`, no code) cannot pass silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import { ProviderError, type VMConfig } from '../../src/types';

const ZONE = 'us-central1-a';
const STOCKOUT_MESSAGE = `The zone 'projects/test-project/zones/${ZONE}' does not have enough resources available to fulfill the request.  Try a different zone, or try again later.`;
const QUOTA_MESSAGE = "Quota 'CPUS' exceeded.  Limit: 8.0 in region us-central1.";
const PERMISSION_MESSAGE = `Required 'compute.instances.create' permission for 'projects/test-project/zones/${ZONE}/instances/node-x'`;

const config: VMConfig = {
  name: 'node-x',
  size: 'medium',
  location: ZONE,
  userData: '#cloud-config',
};

type InsertOutcome =
  | { kind: 'http'; status: number; body: unknown }
  | { kind: 'operation'; errors: Array<Record<string, unknown>> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubCompute(outcome: InsertOutcome): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/global/firewalls') && method === 'POST') {
      return json(
        { error: { code: 409, message: 'already exists', status: 'ALREADY_EXISTS' } },
        409
      );
    }
    if (url.endsWith(`/zones/${ZONE}/instances`) && method === 'POST') {
      if (outcome.kind === 'http') return json(outcome.body, outcome.status);
      return json({ name: 'operation-insert-1', status: 'PENDING', operationType: 'insert' });
    }
    if (url.includes(`/zones/${ZONE}/operations/operation-insert-1`)) {
      if (outcome.kind !== 'operation') throw new Error('unexpected operation poll');
      return json({
        kind: 'compute#operation',
        name: 'operation-insert-1',
        operationType: 'insert',
        status: 'DONE',
        error: { errors: outcome.errors },
        httpErrorStatusCode: 503,
        httpErrorMessage: 'SERVICE UNAVAILABLE',
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function createFailure(
  outcome: InsertOutcome,
  provider = new GcpProvider('test-project', async () => 'token', ZONE)
): Promise<ProviderError> {
  stubCompute(outcome);
  const err = await provider.createVM(config).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe('GcpProvider.createVM error categories', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('a zone stockout descends (transient_capacity)', () => {
    it('operation error ZONE_RESOURCE_POOL_EXHAUSTED', async () => {
      const err = await createFailure({
        kind: 'operation',
        errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: STOCKOUT_MESSAGE }],
      });
      expect(err.category).toBe('transient_capacity');
      expect(err.providerCode).toBe('ZONE_RESOURCE_POOL_EXHAUSTED');
      expect(err.message).toBe(
        `GCP operation failed: ZONE_RESOURCE_POOL_EXHAUSTED: ${STOCKOUT_MESSAGE}`
      );
    });

    it('operation error ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS', async () => {
      const message = `The zone 'projects/test-project/zones/${ZONE}' does not have enough resources available to fulfill the request. '(resource type:compute)'.`;
      const err = await createFailure({
        kind: 'operation',
        errors: [
          {
            code: 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS',
            message,
            errorDetails: [{ help: { links: [{ description: 'Troubleshooting' }] } }],
          },
        ],
      });
      expect(err.category).toBe('transient_capacity');
      expect(err.providerCode).toBe('ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS');
    });

    it('the stockout code wins when it is not the first operation error', async () => {
      const err = await createFailure({
        kind: 'operation',
        errors: [
          { code: 'UNKNOWN_DETAIL', message: 'see next error' },
          { code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: STOCKOUT_MESSAGE },
        ],
      });
      expect(err.category).toBe('transient_capacity');
      expect(err.providerCode).toBe('ZONE_RESOURCE_POOL_EXHAUSTED');
      expect(err.message).toContain('UNKNOWN_DETAIL: see next error');
    });

    it('synchronous 503 whose message is the stockout text', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 503,
        body: { error: { code: 503, message: STOCKOUT_MESSAGE, status: 'UNAVAILABLE' } },
      });
      expect(err.category).toBe('transient_capacity');
      expect(err.statusCode).toBe(503);
      expect(err.providerCode).toBe('UNAVAILABLE');
      expect(err.message).toBe(`gcp API error (503): ${STOCKOUT_MESSAGE}`);
    });
  });

  describe('quota and rate limits are not credential failures', () => {
    it('operation error QUOTA_EXCEEDED → quota_exceeded', async () => {
      const err = await createFailure({
        kind: 'operation',
        errors: [{ code: 'QUOTA_EXCEEDED', message: QUOTA_MESSAGE }],
      });
      expect(err.category).toBe('quota_exceeded');
      expect(err.providerCode).toBe('QUOTA_EXCEEDED');
      expect(err.message).toBe(`GCP operation failed: QUOTA_EXCEEDED: ${QUOTA_MESSAGE}`);
    });

    it('synchronous 403 quotaExceeded with no status → quota_exceeded', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 403,
        body: {
          error: {
            code: 403,
            message: QUOTA_MESSAGE,
            errors: [{ message: QUOTA_MESSAGE, domain: 'usageLimits', reason: 'quotaExceeded' }],
          },
        },
      });
      expect(err.category).toBe('quota_exceeded');
      expect(err.statusCode).toBe(403);
      expect(err.message).toBe(`gcp API error (403): ${QUOTA_MESSAGE}`);
    });

    it('synchronous 403 rateLimitExceeded → rate_limited', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'Rate Limit Exceeded',
            errors: [
              {
                message: 'Rate Limit Exceeded',
                domain: 'usageLimits',
                reason: 'rateLimitExceeded',
              },
            ],
          },
        },
      });
      expect(err.category).toBe('rate_limited');
      expect(err.message).toBe('gcp API error (403): Rate Limit Exceeded');
    });
  });

  describe('controls: failures that must not descend', () => {
    it('403 PERMISSION_DENIED → auth_error', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 403,
        body: { error: { code: 403, message: PERMISSION_MESSAGE, status: 'PERMISSION_DENIED' } },
      });
      expect(err.category).toBe('auth_error');
      expect(err.providerCode).toBe('PERMISSION_DENIED');
      expect(err.message).toBe(`gcp API error (403): ${PERMISSION_MESSAGE}`);
    });

    it('403 forbidden with no status → auth_error', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 403,
        body: {
          error: {
            code: 403,
            message: PERMISSION_MESSAGE,
            errors: [{ message: PERMISSION_MESSAGE, domain: 'global', reason: 'forbidden' }],
          },
        },
      });
      expect(err.category).toBe('auth_error');
      expect(err.providerCode).toBeUndefined();
    });

    it('401 UNAUTHENTICATED → auth_error', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 401,
        body: {
          error: {
            code: 401,
            message: 'Request had invalid authentication credentials.',
            status: 'UNAUTHENTICATED',
          },
        },
      });
      expect(err.category).toBe('auth_error');
      expect(err.providerCode).toBe('UNAUTHENTICATED');
      expect(err.message).toBe(
        'gcp API error (401): Request had invalid authentication credentials.'
      );
    });

    it('a bare 503 UNAVAILABLE stays unknown: the insert may have created the VM', async () => {
      const err = await createFailure({
        kind: 'http',
        status: 503,
        body: {
          error: {
            code: 503,
            message: 'The service is currently unavailable.',
            status: 'UNAVAILABLE',
          },
        },
      });
      expect(err.category).toBe('unknown');
      expect(err.providerCode).toBe('UNAVAILABLE');
    });

    it('an operation poll timeout stays unknown: the insert was accepted', async () => {
      // operationPollTimeoutMs = 0: the insert is accepted, then the poll deadline has passed.
      const provider = new GcpProvider(
        'test-project',
        async () => 'token',
        ZONE,
        undefined,
        undefined,
        undefined,
        undefined,
        0
      );
      const err = await createFailure(
        {
          kind: 'operation',
          errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: STOCKOUT_MESSAGE }],
        },
        provider
      );
      expect(err.category).toBe('unknown');
      expect(err.message).toBe('GCP operation timed out after 0ms');
    });

    it('an unrecognised operation error stays unknown', async () => {
      const err = await createFailure({
        kind: 'operation',
        errors: [{ code: 'INTERNAL_ERROR', message: 'Internal error. Please try again.' }],
      });
      expect(err.category).toBe('unknown');
      expect(err.providerCode).toBe('INTERNAL_ERROR');
    });
  });

  it('a caller abort is rethrown unchanged, not reclassified', async () => {
    const provider = new GcpProvider('test-project', async () => 'token', ZONE);
    stubCompute({ kind: 'operation', errors: [] });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    await expect(provider.createVM(config, { signal: controller.signal })).rejects.toBe(reason);
  });
});
