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
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin;
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

  describe('allowed origins', () => {
    it('allows localhost origins', () => {
      expect(corsOriginCallback('http://localhost:5173', baseDomain)).toBe('http://localhost:5173');
      expect(corsOriginCallback('http://localhost:3000', baseDomain)).toBe('http://localhost:3000');
      expect(corsOriginCallback('http://localhost', baseDomain)).toBe('http://localhost');
    });

    it('allows 127.0.0.1 origins', () => {
      expect(corsOriginCallback('http://127.0.0.1:5173', baseDomain)).toBe('http://127.0.0.1:5173');
    });

    it('allows exact baseDomain origins', () => {
      expect(corsOriginCallback('https://example.com', baseDomain)).toBe('https://example.com');
    });

    it('allows subdomain origins of baseDomain', () => {
      expect(corsOriginCallback('https://app.example.com', baseDomain)).toBe('https://app.example.com');
      expect(corsOriginCallback('https://api.example.com', baseDomain)).toBe('https://api.example.com');
      expect(corsOriginCallback('https://ws-abc123.example.com', baseDomain)).toBe('https://ws-abc123.example.com');
    });
  });

  describe('rejected origins', () => {
    it('rejects unknown origins', () => {
      expect(corsOriginCallback('https://evil.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://attacker.org', baseDomain)).toBeNull();
    });

    it('rejects origins that contain baseDomain as substring but are not subdomains', () => {
      // e.g., "notexample.com" contains "example.com" but is not a subdomain
      expect(corsOriginCallback('https://notexample.com', baseDomain)).toBeNull();
      // e.g., "example.com.evil.com" — baseDomain appears but not as the registrable domain
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

    it('rejects origins when baseDomain is empty', () => {
      // With no baseDomain configured, only localhost should be allowed
      expect(corsOriginCallback('https://anything.com', '')).toBeNull();
      expect(corsOriginCallback('http://localhost:5173', '')).toBe('http://localhost:5173');
    });
  });
});
