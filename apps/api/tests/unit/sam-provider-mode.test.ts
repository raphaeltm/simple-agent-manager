/**
 * Tests for explicit SAM provider selection feature:
 * - validateBudgetUpdate respects admin allowance ceilings
 * - AgentProviderMode validation in agent settings schema
 * - Agent catalog configured status with providerMode
 */
import {
  VALID_AGENT_PROVIDER_MODES,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { validateBudgetUpdate } from '../../src/services/ai-token-budget';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI_USAGE_MAX_DAILY_TOKEN_LIMIT: '',
    AI_USAGE_MIN_DAILY_TOKEN_LIMIT: '',
    AI_USAGE_MAX_MONTHLY_COST_CAP_USD: '',
    AI_USAGE_MIN_MONTHLY_COST_CAP_USD: '',
    ...overrides,
  } as unknown as Env;
}

// =============================================================================
// validateBudgetUpdate with admin allowance ceilings
// =============================================================================

describe('validateBudgetUpdate with admin ceilings', () => {
  it('allows setting limits within admin ceiling', () => {
    const result = validateBudgetUpdate(
      { dailyInputTokenLimit: 500_000 },
      makeEnv(),
      { maxDailyInputTokens: 1_000_000, maxDailyOutputTokens: null, maxMonthlyCostCapUsd: null, allowedModelTiers: null, updatedAt: '', updatedBy: '' },
    );
    expect(result.dailyInputTokenLimit).toBe(500_000);
  });

  it('rejects limits above admin ceiling', () => {
    expect(() =>
      validateBudgetUpdate(
        { dailyInputTokenLimit: 2_000_000 },
        makeEnv(),
        { maxDailyInputTokens: 1_000_000, maxDailyOutputTokens: null, maxMonthlyCostCapUsd: null, allowedModelTiers: null, updatedAt: '', updatedBy: '' },
      ),
    ).toThrow(/dailyInputTokenLimit must be between/);
  });

  it('rejects output limits above admin ceiling', () => {
    expect(() =>
      validateBudgetUpdate(
        { dailyOutputTokenLimit: 3_000_000 },
        makeEnv(),
        { maxDailyInputTokens: null, maxDailyOutputTokens: 500_000, maxMonthlyCostCapUsd: null, allowedModelTiers: null, updatedAt: '', updatedBy: '' },
      ),
    ).toThrow(/dailyOutputTokenLimit must be between/);
  });

  it('rejects monthly cap above admin ceiling', () => {
    expect(() =>
      validateBudgetUpdate(
        { monthlyCostCapUsd: 100 },
        makeEnv(),
        { maxDailyInputTokens: null, maxDailyOutputTokens: null, maxMonthlyCostCapUsd: 50, allowedModelTiers: null, updatedAt: '', updatedBy: '' },
      ),
    ).toThrow(/monthlyCostCapUsd must be between/);
  });

  it('uses platform defaults when no admin allowance', () => {
    // Should not throw with reasonable values when no admin ceiling
    const result = validateBudgetUpdate(
      { dailyInputTokenLimit: 1_000_000 },
      makeEnv(),
      null,
    );
    expect(result.dailyInputTokenLimit).toBe(1_000_000);
  });

  it('uses platform defaults when admin allowance field is null', () => {
    const result = validateBudgetUpdate(
      { dailyInputTokenLimit: 1_000_000 },
      makeEnv(),
      { maxDailyInputTokens: null, maxDailyOutputTokens: null, maxMonthlyCostCapUsd: null, allowedModelTiers: null, updatedAt: '', updatedBy: '' },
    );
    expect(result.dailyInputTokenLimit).toBe(1_000_000);
  });
});

// =============================================================================
// AgentProviderMode constants
// =============================================================================

describe('AgentProviderMode', () => {
  it('includes sam, user-api-key, and oauth', () => {
    expect(VALID_AGENT_PROVIDER_MODES).toContain('sam');
    expect(VALID_AGENT_PROVIDER_MODES).toContain('user-api-key');
    expect(VALID_AGENT_PROVIDER_MODES).toContain('oauth');
  });

  it('has exactly 3 modes', () => {
    expect(VALID_AGENT_PROVIDER_MODES).toHaveLength(3);
  });
});
