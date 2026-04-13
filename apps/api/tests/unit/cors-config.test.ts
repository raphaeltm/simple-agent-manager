import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the CORS origin callback logic.
 *
 * These tests exercise the origin validation function in isolation by
 * replicating the exact same logic used in apps/api/src/index.ts.
 * The worker smoke tests (worker-smoke.test.ts) additionally verify
 * the real middleware in the workerd runtime.
 */

/** Replicates the origin callback from apps/api/src/index.ts */
function corsOriginCallback(origin: string | undefined, baseDomain: string): string | null {
  if (!origin) return null;
  // Allow localhost only in development (BASE_DOMAIN contains 'localhost' or is empty)
  const isDevEnvironment = !baseDomain || baseDomain.includes('localhost');
  try {
    const url = new URL(origin);
    if (isDevEnvironment && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return origin;
  } catch {
    return null;
  }
  if (baseDomain) {
    try {
      const url = new URL(origin);
      if (url.hostname === baseDomain || url.hostname.endsWith(`.${baseDomain}`)) return origin;
    } catch {
      return null;
    }
  }
  return null;
}

describe('CORS origin callback', () => {
  const baseDomain = 'example.com';

  describe('allowed origins (production)', () => {
    it('allows exact baseDomain origins', () => {
      expect(corsOriginCallback('https://example.com', baseDomain)).toBe('https://example.com');
    });

    it('allows subdomain origins of baseDomain', () => {
      expect(corsOriginCallback('https://app.example.com', baseDomain)).toBe('https://app.example.com');
      expect(corsOriginCallback('https://api.example.com', baseDomain)).toBe('https://api.example.com');
      expect(corsOriginCallback('https://ws-abc123.example.com', baseDomain)).toBe('https://ws-abc123.example.com');
    });
  });

  describe('rejected origins (production)', () => {
    it('rejects localhost origins when BASE_DOMAIN is a real domain', () => {
      expect(corsOriginCallback('http://localhost:5173', baseDomain)).toBeNull();
      expect(corsOriginCallback('http://localhost:3000', baseDomain)).toBeNull();
      expect(corsOriginCallback('http://localhost', baseDomain)).toBeNull();
      expect(corsOriginCallback('http://127.0.0.1:5173', baseDomain)).toBeNull();
    });

    it('rejects unknown origins', () => {
      expect(corsOriginCallback('https://evil.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://attacker.org', baseDomain)).toBeNull();
    });

    it('rejects origins that contain baseDomain as substring but are not subdomains', () => {
      expect(corsOriginCallback('https://notexample.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://example.com.evil.com', baseDomain)).toBeNull();
    });

    it('rejects null/undefined origins', () => {
      expect(corsOriginCallback(undefined, baseDomain)).toBeNull();
      expect(corsOriginCallback('', baseDomain)).toBeNull();
    });

    it('rejects malformed origins', () => {
      expect(corsOriginCallback('not-a-url', baseDomain)).toBeNull();
      expect(corsOriginCallback('://broken', baseDomain)).toBeNull();
    });
  });

  describe('development mode (empty baseDomain)', () => {
    it('allows localhost when baseDomain is empty', () => {
      expect(corsOriginCallback('http://localhost:5173', '')).toBe('http://localhost:5173');
      expect(corsOriginCallback('http://localhost:3000', '')).toBe('http://localhost:3000');
      expect(corsOriginCallback('http://127.0.0.1:5173', '')).toBe('http://127.0.0.1:5173');
    });

    it('rejects non-localhost origins when baseDomain is empty', () => {
      expect(corsOriginCallback('https://anything.com', '')).toBeNull();
    });
  });

  describe('development mode (localhost baseDomain)', () => {
    it('allows localhost origins when baseDomain contains localhost', () => {
      expect(corsOriginCallback('http://localhost:5173', 'localhost')).toBe('http://localhost:5173');
      expect(corsOriginCallback('http://127.0.0.1:3000', 'localhost')).toBe('http://127.0.0.1:3000');
    });

    it('allows baseDomain subdomains even in dev mode', () => {
      expect(corsOriginCallback('http://localhost', 'localhost')).toBe('http://localhost');
    });
  });
});
