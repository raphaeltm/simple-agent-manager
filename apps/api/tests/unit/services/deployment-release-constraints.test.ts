/**
 * Unit tests for deployment release slice 2 constraints.
 *
 * Tests the extracted validateSlice2Constraints() function which enforces:
 * 1. Single-service constraint (multi-service rejected)
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
});
