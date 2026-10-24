import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { buildWebhookCredential } from '../../../src/routes/triggers/webhooks';

describe('webhook credential origin', () => {
  it('uses the configured trusted API origin', () => {
    const credential = buildWebhookCredential({ BASE_DOMAIN: 'example.com' } as Env, 'secret-token');

    expect(credential).toEqual({
      endpointUrl: 'https://api.example.com/api/webhooks/ingest',
      token: 'secret-token',
      headerName: 'Authorization',
    });
  });

  it('ignores malicious request Host and X-Forwarded-Host by not accepting request URL input', () => {
    const credential = buildWebhookCredential({ BASE_DOMAIN: 'sam.example' } as Env, 'secret-token');

    expect(credential.endpointUrl).toBe('https://api.sam.example/api/webhooks/ingest');
    expect(credential.endpointUrl).not.toContain('evil.example');
  });

  it('keeps localhost development compatibility', () => {
    const credential = buildWebhookCredential({ BASE_DOMAIN: 'localhost:8787' } as Env, 'secret-token');

    expect(credential.endpointUrl).toBe('http://localhost:8787/api/webhooks/ingest');
  });
});
