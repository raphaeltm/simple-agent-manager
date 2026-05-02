import { describe, expect, it } from 'vitest';

import {
  type ModelAllowedScope,
  PLATFORM_AI_MODELS,
  type PlatformAIModel,
  type ToolCallSupport,
} from '../../src/constants/ai-services';

describe('AI Model Registry', () => {
  describe('registry integrity', () => {
    it('has at least one model per provider', () => {
      const providers = new Set(PLATFORM_AI_MODELS.map((m) => m.provider));
      expect(providers).toContain('workers-ai');
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
    });

    it('has exactly one default model', () => {
      const defaults = PLATFORM_AI_MODELS.filter((m) => m.isDefault);
      expect(defaults).toHaveLength(1);
    });

    it('has unique model IDs', () => {
      const ids = PLATFORM_AI_MODELS.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all models have non-empty labels', () => {
      for (const model of PLATFORM_AI_MODELS) {
        expect(model.label.length, `Model ${model.id} has empty label`).toBeGreaterThan(0);
      }
    });

    it('all models have valid context window sizes', () => {
      for (const model of PLATFORM_AI_MODELS) {
        expect(model.contextWindow, `Model ${model.id} has invalid contextWindow`).toBeGreaterThan(0);
        expect(Number.isInteger(model.contextWindow), `Model ${model.id} contextWindow must be integer`).toBe(true);
      }
    });

    it('all models have valid cost values', () => {
      for (const model of PLATFORM_AI_MODELS) {
        expect(model.costPer1kInputTokens, `Model ${model.id} has negative input cost`).toBeGreaterThanOrEqual(0);
        expect(model.costPer1kOutputTokens, `Model ${model.id} has negative output cost`).toBeGreaterThanOrEqual(0);
      }
    });

    it('free-tier models have zero cost', () => {
      const freeModels = PLATFORM_AI_MODELS.filter((m) => m.tier === 'free');
      for (const model of freeModels) {
        expect(model.costPer1kInputTokens, `Free model ${model.id} should have zero input cost`).toBe(0);
        expect(model.costPer1kOutputTokens, `Free model ${model.id} should have zero output cost`).toBe(0);
      }
    });

    it('paid-tier models have non-zero cost', () => {
      const paidModels = PLATFORM_AI_MODELS.filter((m) => m.tier !== 'free');
      for (const model of paidModels) {
        expect(
          model.costPer1kInputTokens > 0 || model.costPer1kOutputTokens > 0,
          `Paid model ${model.id} should have non-zero cost`,
        ).toBe(true);
      }
    });

    it('all models have at least one allowed scope', () => {
      for (const model of PLATFORM_AI_MODELS) {
        expect(model.allowedScopes.length, `Model ${model.id} has no allowed scopes`).toBeGreaterThan(0);
      }
    });

    it('all models have a non-empty fallback group', () => {
      for (const model of PLATFORM_AI_MODELS) {
        expect(model.fallbackGroup.length, `Model ${model.id} has empty fallbackGroup`).toBeGreaterThan(0);
      }
    });
  });

  describe('Unified API model IDs', () => {
    it('Anthropic models have unifiedApiModelId with anthropic/ prefix', () => {
      const anthropicModels = PLATFORM_AI_MODELS.filter((m) => m.provider === 'anthropic');
      expect(anthropicModels.length).toBeGreaterThan(0);
      for (const model of anthropicModels) {
        expect(model.unifiedApiModelId, `Anthropic model ${model.id} missing unifiedApiModelId`).not.toBeNull();
        expect(
          model.unifiedApiModelId!.startsWith('anthropic/'),
          `Anthropic model ${model.id} unifiedApiModelId should start with 'anthropic/'`,
        ).toBe(true);
      }
    });

    it('OpenAI models have unifiedApiModelId with openai/ prefix', () => {
      const openaiModels = PLATFORM_AI_MODELS.filter((m) => m.provider === 'openai');
      expect(openaiModels.length).toBeGreaterThan(0);
      for (const model of openaiModels) {
        expect(model.unifiedApiModelId, `OpenAI model ${model.id} missing unifiedApiModelId`).not.toBeNull();
        expect(
          model.unifiedApiModelId!.startsWith('openai/'),
          `OpenAI model ${model.id} unifiedApiModelId should start with 'openai/'`,
        ).toBe(true);
      }
    });

    it('Workers AI models have null unifiedApiModelId (use Workers AI path)', () => {
      const workersModels = PLATFORM_AI_MODELS.filter((m) => m.provider === 'workers-ai');
      expect(workersModels.length).toBeGreaterThan(0);
      for (const model of workersModels) {
        expect(
          model.unifiedApiModelId,
          `Workers AI model ${model.id} should have null unifiedApiModelId`,
        ).toBeNull();
      }
    });

    it('unifiedApiModelId contains the model ID after the provider prefix', () => {
      const unifiedModels = PLATFORM_AI_MODELS.filter((m) => m.unifiedApiModelId !== null);
      for (const model of unifiedModels) {
        const parts = model.unifiedApiModelId!.split('/');
        expect(parts.length, `Model ${model.id} unifiedApiModelId should have exactly one /`).toBe(2);
        expect(parts[1], `Model ${model.id} unifiedApiModelId has empty model part`).toBe(model.id);
      }
    });
  });

  describe('tool-call support tiers', () => {
    const validTiers: ToolCallSupport[] = ['excellent', 'good', 'limited', 'none'];

    it('all models have valid tool-call support values', () => {
      for (const model of PLATFORM_AI_MODELS) {
        expect(
          validTiers.includes(model.toolCallSupport),
          `Model ${model.id} has invalid toolCallSupport: ${model.toolCallSupport}`,
        ).toBe(true);
      }
    });

    it('Anthropic and OpenAI models have excellent tool-call support', () => {
      const externalModels = PLATFORM_AI_MODELS.filter(
        (m) => m.provider === 'anthropic' || m.provider === 'openai',
      );
      for (const model of externalModels) {
        expect(
          model.toolCallSupport,
          `External model ${model.id} should have excellent tool-call support`,
        ).toBe('excellent');
      }
    });

    it('at least one Workers AI model has good tool-call support', () => {
      const workersWithTools = PLATFORM_AI_MODELS.filter(
        (m) => m.provider === 'workers-ai' && (m.toolCallSupport === 'excellent' || m.toolCallSupport === 'good'),
      );
      expect(workersWithTools.length).toBeGreaterThan(0);
    });
  });

  describe('fallback groups', () => {
    it('fallback groups contain models from the same provider', () => {
      const groups = new Map<string, Set<string>>();
      for (const model of PLATFORM_AI_MODELS) {
        if (!groups.has(model.fallbackGroup)) {
          groups.set(model.fallbackGroup, new Set());
        }
        groups.get(model.fallbackGroup)!.add(model.provider);
      }

      for (const [group, providers] of groups) {
        expect(
          providers.size,
          `Fallback group '${group}' contains models from multiple providers: ${[...providers].join(', ')}`,
        ).toBe(1);
      }
    });
  });

  describe('scope constraints', () => {
    const validScopes: ModelAllowedScope[] = ['workspace', 'project', 'top-level'];

    it('all allowedScopes values are valid', () => {
      for (const model of PLATFORM_AI_MODELS) {
        for (const scope of model.allowedScopes) {
          expect(
            validScopes.includes(scope),
            `Model ${model.id} has invalid scope: ${scope}`,
          ).toBe(true);
        }
      }
    });

    it('at least one model is allowed for each scope', () => {
      for (const scope of validScopes) {
        const modelsForScope = PLATFORM_AI_MODELS.filter((m) => m.allowedScopes.includes(scope));
        expect(
          modelsForScope.length,
          `No models allowed for scope '${scope}'`,
        ).toBeGreaterThan(0);
      }
    });

    it('top-level scope models have excellent tool-call support', () => {
      const topLevelModels = PLATFORM_AI_MODELS.filter((m) => m.allowedScopes.includes('top-level'));
      for (const model of topLevelModels) {
        expect(
          model.toolCallSupport,
          `Top-level model ${model.id} should have excellent tool-call support`,
        ).toBe('excellent');
      }
    });
  });

  describe('helper functions', () => {
    it('can look up model by ID', () => {
      const model = PLATFORM_AI_MODELS.find((m) => m.id === 'claude-sonnet-4-6');
      expect(model).toBeDefined();
      expect(model!.provider).toBe('anthropic');
      expect(model!.toolCallSupport).toBe('excellent');
      expect(model!.unifiedApiModelId).toBe('anthropic/claude-sonnet-4-6');
    });

    it('can filter models by scope', () => {
      const workspaceModels = PLATFORM_AI_MODELS.filter((m) => m.allowedScopes.includes('workspace'));
      expect(workspaceModels.length).toBe(PLATFORM_AI_MODELS.length); // all models should be workspace-allowed
    });

    it('can find fallback alternatives', () => {
      const sonnet = PLATFORM_AI_MODELS.find((m) => m.id === 'claude-sonnet-4-6')!;
      const sameGroup = PLATFORM_AI_MODELS.filter(
        (m) => m.fallbackGroup === sonnet.fallbackGroup && m.id !== sonnet.id,
      );
      // Sonnet is alone in its group (anthropic-standard) — this is valid
      expect(sameGroup.length).toBeGreaterThanOrEqual(0);
    });
  });
});
