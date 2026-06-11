/**
 * Unit tests for deployment release slice 2 constraints.
 *
 * Tests the extracted validateSlice2Constraints() function which enforces:
 * 1. Single-service constraint (multi-service rejected)
 * 2. Secret reference rejection (secret store deferred)
 */
import { describe, expect, it } from 'vitest';

import { validateSlice2Constraints } from '../../../src/routes/deployment-releases';

describe('validateSlice2Constraints', () => {
  describe('single-service constraint', () => {
    it('accepts a single-service manifest', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: { NODE_ENV: 'production' } },
        },
      });
      expect(result).toBeNull();
    });

    it('rejects a two-service manifest with MULTI_SERVICE_NOT_SUPPORTED', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: {} },
          worker: { env: {} },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.error).toBe('MULTI_SERVICE_NOT_SUPPORTED');
      expect(result!.message).toContain('2 services');
      expect(result!.message).toContain('only 1 is allowed');
    });

    it('rejects a three-service manifest', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: {} },
          worker: { env: {} },
          cron: { env: {} },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.error).toBe('MULTI_SERVICE_NOT_SUPPORTED');
      expect(result!.message).toContain('3 services');
    });
  });

  describe('secret reference rejection', () => {
    it('accepts literal string env values', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: { DB_URL: 'postgres://localhost/db', API_KEY: 'abc123' } },
        },
      });
      expect(result).toBeNull();
    });

    it('accepts empty env', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: {} },
        },
      });
      expect(result).toBeNull();
    });

    it('rejects secret reference with SECRETS_NOT_SUPPORTED', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: { DB_PASS: { secret: 'my-db-password' } as unknown } },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.error).toBe('SECRETS_NOT_SUPPORTED');
      expect(result!.message).toContain('web');
      expect(result!.message).toContain('DB_PASS');
      expect(result!.message).toContain('my-db-password');
    });

    it('identifies the correct service and env var in the error message', () => {
      const result = validateSlice2Constraints({
        services: {
          api: { env: { SECRET_KEY: { secret: 'api-secret' } as unknown } },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.message).toContain('api');
      expect(result!.message).toContain('SECRET_KEY');
      expect(result!.message).toContain('api-secret');
    });

    it('checks multi-service before secrets (multi-service error takes precedence)', () => {
      const result = validateSlice2Constraints({
        services: {
          web: { env: { DB_PASS: { secret: 'password' } as unknown } },
          worker: { env: {} },
        },
      });
      // Multi-service check runs first
      expect(result).not.toBeNull();
      expect(result!.error).toBe('MULTI_SERVICE_NOT_SUPPORTED');
    });
  });
});
