/**
 * F16: a durable provisioning failure must not carry raw provider text into `lastError`, which
 * `NodeLifecycleProvisioning.reportExhausted()` copies into `nodes.error_message` and
 * `workspaces.error_message`. Errors are built by the real producer (`providerFetch`), so the
 * raw response body is embedded exactly the way production embeds it.
 */
import { ProviderError, providerFetch } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcpApiError } from '../../../src/services/gcp-errors';
import {
  describeProvisioningAttemptFailure,
  NodeAllocationUncertainError,
  summarizeProvisioningFailure,
} from '../../../src/services/node-allocation-recovery';

const SA_EMAIL = 'sam-platform@platform-project-123.iam.gserviceaccount.com';
const RESOURCE_PATH = 'projects/platform-project-123/zones/europe-west1-b/instances/node-abc';

async function gcpProviderError(): Promise<ProviderError> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: `Permission denied on ${RESOURCE_PATH} for ${SA_EMAIL}`,
          },
        },
        { status: 403 }
      )
    )
  );
  try {
    await providerFetch('gcp', `https://compute.googleapis.test/compute/v1/${RESOURCE_PATH}`);
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error('expected providerFetch to throw');
}

afterEach(() => vi.unstubAllGlobals());

describe('summarizeProvisioningFailure', () => {
  it('keeps the structured fields of a provider error and drops its raw body text', async () => {
    const error = await gcpProviderError();
    // Fixture fidelity: the producer really embedded the raw body in the message.
    expect(error.message).toContain(SA_EMAIL);
    expect(error.providerCode).toBe('PERMISSION_DENIED');

    const summary = summarizeProvisioningFailure(error);

    expect(summary).toBe('ProviderError (gcp, HTTP 403, PERMISSION_DENIED)');
    expect(summary).not.toContain(SA_EMAIL);
    expect(summary).not.toContain('platform-project-123');
  });

  it('says there was no HTTP response for a provider timeout, without the request URL', () => {
    const error = new ProviderError(
      'gcp',
      undefined,
      `gcp API request timed out after 30000ms: https://compute.googleapis.test/${RESOURCE_PATH}`
    );
    expect(summarizeProvisioningFailure(error)).toBe('ProviderError (gcp, no HTTP response)');
  });

  it('keeps a non-unknown category and refuses a provider code that is free text', () => {
    const error = new ProviderError('hetzner', 412, 'raw', {
      providerCode: `placement failed for ${SA_EMAIL}`,
      category: 'transient_capacity',
    });
    expect(summarizeProvisioningFailure(error)).toBe(
      'ProviderError (hetzner, HTTP 412, transient_capacity)'
    );
    // A code shaped like an identifier (project id, resource name) is refused too.
    for (const providerCode of ['platform-project-123', 'zones/europe-west1-b', 'a.b']) {
      expect(
        summarizeProvisioningFailure(new ProviderError('gcp', 400, 'raw', { providerCode }))
      ).toBe('ProviderError (gcp, HTTP 400)');
    }
  });

  it('uses the GCP sanitizer hint, never the raw body', () => {
    const error = new GcpApiError({
      step: 'create_instance',
      statusCode: 403,
      message: `raw ${SA_EMAIL}`,
      rawBody: `{"error":"${RESOURCE_PATH}"}`,
    });
    const summary = summarizeProvisioningFailure(error);
    expect(summary).toMatch(/^GcpApiError \(create_instance, HTTP 403\): /);
    expect(summary).not.toContain(SA_EMAIL);
    expect(summary).not.toContain(RESOURCE_PATH);
  });

  it('names a GCP error without a status code', () => {
    const summary = summarizeProvisioningFailure(
      new GcpApiError({ step: 'sts_exchange', message: `timeout ${SA_EMAIL}` })
    );
    expect(summary).toMatch(/^GcpApiError \(sts_exchange\): /);
    expect(summary).not.toContain(SA_EMAIL);
  });

  it('reduces any other error to its name', () => {
    expect(summarizeProvisioningFailure(new TypeError(`bad ${SA_EMAIL}`))).toBe('TypeError');
    expect(summarizeProvisioningFailure('plain string')).toBe('string');
  });
});

describe('describeProvisioningAttemptFailure', () => {
  it('logs the wrapper message and the safe fields of the provider cause it wraps', async () => {
    const cause = await gcpProviderError();
    const wrapped = new NodeAllocationUncertainError(
      `Provider allocation is unresolved (${summarizeProvisioningFailure(cause)})`,
      { cause }
    );

    const fields = describeProvisioningAttemptFailure(wrapped);

    expect(fields).toEqual({
      error: {
        name: 'NodeAllocationUncertainError',
        message:
          'Provider allocation is unresolved (ProviderError (gcp, HTTP 403, PERMISSION_DENIED))',
      },
      cause: {
        name: 'ProviderError',
        providerName: 'gcp',
        statusCode: 403,
        providerCode: 'PERMISSION_DENIED',
        category: 'unknown',
      },
    });
    expect(JSON.stringify(fields)).not.toContain(SA_EMAIL);
  });

  it('describes a non-Error cause by its type only', () => {
    const fields = describeProvisioningAttemptFailure(
      new NodeAllocationUncertainError('wrapped', { cause: `raw ${SA_EMAIL}` })
    );
    expect(fields).toEqual({
      error: { name: 'NodeAllocationUncertainError', message: 'wrapped' },
      cause: { name: 'string' },
    });
  });

  it('caps the authored wrapper message and omits cause when there is none', () => {
    const fields = describeProvisioningAttemptFailure(
      new NodeAllocationUncertainError('x'.repeat(500))
    );
    expect(fields).toEqual({
      error: { name: 'NodeAllocationUncertainError', message: 'x'.repeat(200) },
    });
  });
});
