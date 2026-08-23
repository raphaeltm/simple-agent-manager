/**
 * Policy lifecycle validation — the shared write-boundary rule used by BOTH the MCP
 * tool handlers (`apps/api/src/routes/mcp/policy-tools.ts`) and the REST routes
 * (`apps/api/src/routes/policies.ts`), so the two cannot drift apart (rule 24).
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY_MAX_EXPIRY_MS,
  isPolicyScope,
  POLICY_SCOPES,
  validatePolicyLifecycle,
} from '../src';

const NOW = 1_800_000_000_000;
const MAX = DEFAULT_POLICY_MAX_EXPIRY_MS;

function validate(scope: string, expiresAt: number | null | undefined) {
  return validatePolicyLifecycle({ scope, expiresAt, now: NOW, maxExpiryMs: MAX });
}

describe('validatePolicyLifecycle', () => {
  describe('the load-bearing invariant: a task-scoped policy must expire', () => {
    it('rejects scope=task with no expiry', () => {
      expect(validate('task', null)).toMatch(/task-scoped policy must set expiresAt/);
    });

    it('rejects scope=task with an omitted expiry', () => {
      expect(validate('task', undefined)).toMatch(/task-scoped policy must set expiresAt/);
    });

    it('accepts scope=task with a future expiry', () => {
      expect(validate('task', NOW + 60_000)).toBeNull();
    });

    it('points the caller at the standing-policy alternative', () => {
      // The error has to teach the fix, otherwise an agent just retries the same call.
      expect(validate('task', null)).toContain("scope 'always'");
    });
  });

  describe('scope=always — the default and the pre-lifecycle behavior', () => {
    it('accepts no expiry (a permanent standing policy)', () => {
      expect(validate('always', null)).toBeNull();
      expect(validate('always', undefined)).toBeNull();
    });

    it('accepts an expiry (a standing policy that is being retired on a date)', () => {
      expect(validate('always', NOW + 60_000)).toBeNull();
    });
  });

  describe('expiry bounds', () => {
    it('rejects an expiry in the past', () => {
      expect(validate('always', NOW - 1)).toMatch(/must be in the future/);
    });

    it('rejects an expiry exactly at now — the boundary is exclusive', () => {
      // Matches the SQL predicate `expires_at > ?`, so a policy can never be created
      // in a state where it is already filtered out.
      expect(validate('always', NOW)).toMatch(/must be in the future/);
    });

    it('directs an immediate retirement to remove_policy instead', () => {
      expect(validate('always', NOW - 1)).toContain('remove_policy');
    });

    it('rejects an expiry beyond the configured horizon', () => {
      expect(validate('always', NOW + MAX + 1)).toMatch(/must be within/);
    });

    it('accepts an expiry exactly at the horizon', () => {
      expect(validate('always', NOW + MAX)).toBeNull();
    });

    it('honours a caller-supplied horizon rather than the default', () => {
      const tight = validatePolicyLifecycle({
        scope: 'always',
        expiresAt: NOW + 10_000,
        now: NOW,
        maxExpiryMs: 5_000,
      });
      expect(tight).toMatch(/must be within 5000ms/);
    });

    it('rejects a non-finite expiry', () => {
      expect(validate('always', Number.NaN)).toMatch(/must be a number/);
      expect(validate('always', Number.POSITIVE_INFINITY)).toMatch(/must be a number/);
    });

    it('rejects a fractional expiry', () => {
      expect(validate('always', NOW + 0.5)).toMatch(/integer/);
    });
  });

  describe('scope validation', () => {
    it('rejects an unknown scope', () => {
      expect(validate('forever', null)).toMatch(/scope must be one of/);
    });

    it('names the valid scopes in the error', () => {
      const error = validate('forever', null);
      for (const scope of POLICY_SCOPES) {
        expect(error).toContain(scope);
      }
    });
  });

  describe('isPolicyScope', () => {
    it('accepts every declared scope', () => {
      for (const scope of POLICY_SCOPES) {
        expect(isPolicyScope(scope)).toBe(true);
      }
    });

    it('rejects anything else', () => {
      expect(isPolicyScope('workflow')).toBe(false);
      expect(isPolicyScope('')).toBe(false);
      expect(isPolicyScope('ALWAYS')).toBe(false);
    });
  });

  describe('DEFAULT_POLICY_MAX_EXPIRY_MS', () => {
    it('is 365 days', () => {
      expect(DEFAULT_POLICY_MAX_EXPIRY_MS).toBe(365 * 24 * 60 * 60 * 1000);
    });
  });
});
