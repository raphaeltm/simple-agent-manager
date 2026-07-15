import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { buildTrustedApiUrl, getTrustedApiOrigin } from '../../../src/lib/trusted-origins';

describe('trusted API origin derivation', () => {
  it('derives production API origin from configured BASE_DOMAIN', () => {
    expect(getTrustedApiOrigin({ BASE_DOMAIN: 'example.com' } as Env)).toBe('https://api.example.com');
    expect(buildTrustedApiUrl({ BASE_DOMAIN: 'example.com' } as Env, '/api/webhooks/ingest')).toBe(
      'https://api.example.com/api/webhooks/ingest'
    );
  });

  it('normalizes an accidentally URL-shaped BASE_DOMAIN without trusting request hosts', () => {
    expect(getTrustedApiOrigin({ BASE_DOMAIN: 'https://example.com/' } as Env)).toBe(
      'https://api.example.com'
    );
  });

  it('preserves localhost development compatibility', () => {
    expect(getTrustedApiOrigin({ BASE_DOMAIN: 'localhost:8787' } as Env)).toBe(
      'http://localhost:8787'
    );
  });

  it('fails closed when BASE_DOMAIN is missing or invalid', () => {
    expect(() => getTrustedApiOrigin({ BASE_DOMAIN: '' } as Env)).toThrow('BASE_DOMAIN is required');
    expect(() => getTrustedApiOrigin({ BASE_DOMAIN: 'bad host' } as Env)).toThrow(
      'BASE_DOMAIN must be a valid host'
    );
  });
});
