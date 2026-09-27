import { describe, expect, it } from 'vitest';

import {
  getPlatformAIModelTier,
  isPlatformAIModelTier,
  PLATFORM_AI_MODEL_TIERS,
  PLATFORM_AI_MODELS,
} from '../../src/constants';

describe('PLATFORM_AI_MODEL_TIERS', () => {
  it('lists the budget tiers in cheapest-first order', () => {
    expect(PLATFORM_AI_MODEL_TIERS).toEqual(['low-cost', 'standard', 'premium']);
  });

  it('covers every tier the model catalog uses', () => {
    const used = new Set(PLATFORM_AI_MODELS.map((model) => model.tier));
    for (const tier of used) expect(PLATFORM_AI_MODEL_TIERS).toContain(tier);
  });
});

describe('isPlatformAIModelTier', () => {
  it.each(['low-cost', 'standard', 'premium'])('accepts %s', (tier) => {
    expect(isPlatformAIModelTier(tier)).toBe(true);
  });

  it.each([
    'frontier',
    'Premium',
    'premium ',
    '',
    'toString',
    '__proto__',
    'constructor',
    null,
    undefined,
    3,
    ['premium'],
  ])('rejects %j', (value) => {
    expect(isPlatformAIModelTier(value)).toBe(false);
  });
});

describe('getPlatformAIModelTier', () => {
  it('returns the catalog tier for every catalog model', () => {
    for (const model of PLATFORM_AI_MODELS) {
      expect(getPlatformAIModelTier(model.id)).toBe(model.tier);
    }
  });

  it('spans all three tiers across providers', () => {
    expect(getPlatformAIModelTier('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe('low-cost');
    expect(getPlatformAIModelTier('claude-sonnet-5')).toBe('standard');
    expect(getPlatformAIModelTier('claude-opus-5-5')).toBe('premium');
    expect(getPlatformAIModelTier('gpt-6-luna')).toBe('standard');
    expect(getPlatformAIModelTier('gpt-6-sol')).toBe('premium');
  });

  it.each(['claude-sonnet-4-5', 'gpt-4o', '@cf/unknown/model', '', 'claude-opus-5-5 '])(
    'returns null for an ID the catalog does not list: %j',
    (modelId) => {
      expect(getPlatformAIModelTier(modelId)).toBeNull();
    }
  );
});
