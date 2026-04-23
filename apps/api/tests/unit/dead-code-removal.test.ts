/**
 * Behavioral tests verifying dead code has been properly removed.
 *
 * These tests verify that removed code is no longer accessible at the module level,
 * and that replaced duplicates now resolve to the canonical implementation.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('dead code removal', () => {
  describe('apps/api/src/lib/errors.ts', () => {
    it('should no longer exist on disk', () => {
      const errorsPath = join(__dirname, '../../src/lib/errors.ts');
      expect(existsSync(errorsPath)).toBe(false);
    });
  });

  describe('scripts/deploy/types.ts exports', () => {
    it('should not export DEPLOYMENT_STATE_VERSION constant', async () => {
      const types = await import('../../../../scripts/deploy/types');
      expect('DEPLOYMENT_STATE_VERSION' in types).toBe(false);
    });

    it('should still export other runtime values like REQUIRED_SECRETS', async () => {
      const types = await import('../../../../scripts/deploy/types');
      expect('REQUIRED_SECRETS' in types).toBe(true);
    });
  });
});
