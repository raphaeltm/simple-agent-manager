/**
 * Google's `ErrorInfo.reason` survives `providerFetch`, so callers can tell an API that is turned
 * off (`SERVICE_DISABLED`) from a token minted without a scope, both of which arrive as a 403
 * `PERMISSION_DENIED`. The error is built by the real `providerFetch` from Google's response body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeGcpBillingAccess } from '../../src/gcp-pricing';
import { googleErrorInfoOf } from '../../src/google-error-info';
import { providerFetch } from '../../src/provider-fetch';
import { ProviderError } from '../../src/types';

function googleError(details: unknown[]) {
  return new Response(
    JSON.stringify({
      error: {
        code: 403,
        message: 'Cloud Billing API has not been used in project 123456 before or it is disabled.',
        status: 'PERMISSION_DENIED',
        details,
      },
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  );
}

const serviceDisabled = {
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason: 'SERVICE_DISABLED',
  domain: 'googleapis.com',
  metadata: {
    service: 'cloudbilling.googleapis.com',
    consumer: 'projects/123456',
    activationUrl: 'https://console.developers.google.com/apis/api/cloudbilling.googleapis.com/overview?project=123456',
  },
};

async function errorFrom(response: Response): Promise<ProviderError> {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  try {
    await providerFetch('gcp', 'https://cloudbilling.googleapis.com/v1/services/x/skus');
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected providerFetch to throw');
}

describe('Google ErrorInfo on provider errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the reason and service Google reported, alongside status and code', async () => {
    const error = await errorFrom(
      googleError([{ '@type': 'type.googleapis.com/google.rpc.Help', links: [] }, serviceDisabled])
    );

    expect(error.statusCode).toBe(403);
    expect(error.providerCode).toBe('PERMISSION_DENIED');
    expect(error.message).toContain('has not been used in project 123456');
    expect(googleErrorInfoOf(error)).toEqual({
      reason: 'SERVICE_DISABLED',
      domain: 'googleapis.com',
      service: 'cloudbilling.googleapis.com',
    });
  });

  it('records nothing when Google sent no ErrorInfo', async () => {
    const error = await errorFrom(googleError([{ '@type': 'type.googleapis.com/google.rpc.Help' }]));
    expect(googleErrorInfoOf(error)).toBeNull();
    expect(error.context).toBeUndefined();
  });

  it('ignores an ErrorInfo whose fields are not identifiers', async () => {
    const error = await errorFrom(
      googleError([
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE DISABLED <script>',
          metadata: { service: 'cloudbilling.googleapis.com' },
        },
      ])
    );
    expect(googleErrorInfoOf(error)).toBeNull();
  });

  it('drops an unparseable service but keeps a valid reason', async () => {
    const error = await errorFrom(
      googleError([{ ...serviceDisabled, metadata: { service: 'x'.repeat(200) } }])
    );
    expect(googleErrorInfoOf(error)).toEqual({ reason: 'SERVICE_DISABLED', domain: 'googleapis.com' });
  });

  it('leaves non-Google error bodies as they were', async () => {
    const error = await errorFrom(
      new Response(JSON.stringify({ error: { code: 'resource_unavailable', message: 'x' } }), {
        status: 412,
      })
    );
    expect(error.providerCode).toBe('resource_unavailable');
    expect(error.context).toBeUndefined();
  });
});

describe('probeGcpBillingAccess', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads one SKU with the given token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skus: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await probeGcpBillingAccess('token-1', { requestTimeoutMs: 1_000 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('pageSize')).toBe('1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
  });

  it('throws the Google error with its ErrorInfo when the API is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => googleError([serviceDisabled])));

    const error = await probeGcpBillingAccess('token-1', { requestTimeoutMs: 1_000 }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(googleErrorInfoOf(error as ProviderError)?.reason).toBe('SERVICE_DISABLED');
  });
});
