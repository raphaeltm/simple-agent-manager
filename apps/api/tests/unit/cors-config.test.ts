import { describe, expect, it } from 'vitest';

import { resolveCredentialedCorsOrigin } from '../../src/lib/cors-origin';

describe('CORS origin callback', () => {
  const baseDomain = 'example.com';
  const corsOriginCallback = resolveCredentialedCorsOrigin;

  describe('allowed origins (production)', () => {
    it('allows exact baseDomain origins', () => {
      expect(corsOriginCallback('https://example.com', baseDomain)).toBe('https://example.com');
    });

    it('allows only legitimate first-party app, API, and docs origins', () => {
      expect(corsOriginCallback('https://app.example.com', baseDomain)).toBe('https://app.example.com');
      expect(corsOriginCallback('https://api.example.com', baseDomain)).toBe('https://api.example.com');
      expect(corsOriginCallback('https://docs.example.com', baseDomain)).toBe('https://docs.example.com');
      expect(corsOriginCallback('https://www.example.com', baseDomain)).toBe('https://www.example.com');
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

    it('rejects non-HTTPS origins outside local development', () => {
      expect(corsOriginCallback('http://app.example.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('http://api.example.com', baseDomain)).toBeNull();
    });

    it('rejects origins that contain baseDomain as substring but are not subdomains', () => {
      expect(corsOriginCallback('https://notexample.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://example.com.evil.com', baseDomain)).toBeNull();
    });

    it('rejects workspace, workspace-port, VM, and arbitrary subdomain origins', () => {
      expect(corsOriginCallback('https://ws-abc123.example.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://ws-abc123--5173.example.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://node-123.vm.example.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://customer-controlled.example.com', baseDomain)).toBeNull();
    });

    it('rejects nested subdomains under otherwise allowed labels', () => {
      expect(corsOriginCallback('https://preview.app.example.com', baseDomain)).toBeNull();
      expect(corsOriginCallback('https://foo.docs.example.com', baseDomain)).toBeNull();
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

    it('allows baseDomain origins in dev mode', () => {
      expect(corsOriginCallback('http://localhost', 'localhost')).toBe('http://localhost');
    });
  });
});
