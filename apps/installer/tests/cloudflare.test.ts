import { afterEach, describe, expect, it, vi } from 'vitest';

import { cloudflare, CloudflareError } from '../src/cloudflare';

afterEach(() => vi.unstubAllGlobals());

describe('cloudflare client failures', () => {
  it('records method, account-masked path and numeric codes without the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          { status: 403 }
        )
      )
    );
    const error = await cloudflare(
      'token-private',
      `/accounts/${'a'.repeat(32)}/workers/scripts/x`,
      {
        method: 'PUT',
      }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareError);
    const detail = (error as CloudflareError).detail;
    expect(detail).toEqual({
      method: 'PUT',
      path: '/accounts/:account/workers/scripts/x',
      codes: [10000],
      contentType: 'application/json',
    });
    expect(JSON.stringify(detail)).not.toContain('token-private');
    expect(JSON.stringify(detail)).not.toContain('Authentication error');
    expect(JSON.stringify(detail)).not.toContain('a'.repeat(32));
  });

  it('classifies a non-JSON provider response as a failure instead of throwing a parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad gateway', { status: 502 }))
    );
    const error = await cloudflare('token', '/accounts/x/workers/subdomain').catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(CloudflareError);
    expect((error as CloudflareError).status).toBe(502);
  });
});
