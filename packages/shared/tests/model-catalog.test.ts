import { describe, expect, it } from 'vitest';

import { PLATFORM_AI_MODELS } from '../src/constants/ai-services';
import { getModelGroupsForAgent, getModelsForAgent, isKnownModel } from '../src/model-catalog';

const CLAUDE_CODE_1M_SELECTOR_SUFFIX = '[1m]';

function isClaudeCode1mSelector(modelId: string): boolean {
  return modelId.endsWith(CLAUDE_CODE_1M_SELECTOR_SUFFIX);
}

function toClaudeCodeBaseModelId(modelId: string): string {
  return modelId.endsWith(CLAUDE_CODE_1M_SELECTOR_SUFFIX)
    ? modelId.slice(0, -CLAUDE_CODE_1M_SELECTOR_SUFFIX.length)
    : modelId;
}

describe('model-catalog', () => {
  describe('getModelGroupsForAgent', () => {
    it('returns grouped models for claude-code', () => {
      const groups = getModelGroupsForAgent('claude-code');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      expect(groups[0]!.label).toContain('Claude');
      expect(groups[0]!.models.length).toBeGreaterThanOrEqual(1);
    });

    it('returns grouped models for openai-codex', () => {
      const groups = getModelGroupsForAgent('openai-codex');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      const latestModels = groups[0]?.models.map((model) => model.id) ?? [];
      expect(latestModels).toEqual(
        expect.arrayContaining([
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5-pro',
          'gpt-5.5',
          'gpt-5.4',
        ])
      );
    });

    it('returns grouped models for mistral-vibe', () => {
      const groups = getModelGroupsForAgent('mistral-vibe');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      const allModels = groups.flatMap((g) => g.models);
      expect(allModels.some((m) => m.id === 'devstral-2-2512')).toBe(true);
    });

    it('returns grouped models for google-gemini', () => {
      const groups = getModelGroupsForAgent('google-gemini');
      expect(groups.length).toBeGreaterThanOrEqual(1);
      const allModels = groups.flatMap((g) => g.models);
      expect(allModels.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.5-flash')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.1-pro-preview')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.1-flash-lite')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.1-pro')).toBe(false);
      expect(allModels.some((m) => m.id === 'gemini-2.0-flash')).toBe(false);
    });

    it('returns empty array for unknown agent type', () => {
      expect(getModelGroupsForAgent('nonexistent')).toEqual([]);
    });

    it('returns grouped models for opencode', () => {
      const groups = getModelGroupsForAgent('opencode');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      const allModels = groups.flatMap((g) => g.models);
      expect(groups.map((g) => g.label)).toEqual(
        expect.arrayContaining(['OpenCode Zen', 'OpenCode Go'])
      );
      expect(allModels.some((m) => m.id === 'opencode/claude-sonnet-4-6')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode-go/glm-5.2')).toBe(true);
    });
  });

  describe('getModelsForAgent', () => {
    it('returns flat list of models for claude-code', () => {
      const models = getModelsForAgent('claude-code');
      expect(models.length).toBeGreaterThanOrEqual(14);
      expect(models.some((m) => m.id === 'claude-fable-5')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-5')).toBe(true);
      expect(models.some((m) => m.id === 'claude-opus-4-8')).toBe(true);
      expect(models.some((m) => m.id === 'claude-opus-4-7')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-4-6')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-4-20250514')).toBe(false);
    });

    it('lists the current Claude Code 1M context choices', () => {
      const models = getModelsForAgent('claude-code');
      const namesById = new Map(models.map((model) => [model.id, model.name]));

      const expectedOneMillionContextModels = [
        'claude-fable-5',
        'claude-sonnet-5',
        'claude-opus-4-8[1m]',
        'claude-opus-4-7[1m]',
        'claude-opus-4-6[1m]',
        'claude-sonnet-4-6[1m]',
      ];

      expect(models.map((model) => model.id)).toEqual(
        expect.arrayContaining(expectedOneMillionContextModels)
      );
      expect(models.some((model) => model.id === 'claude-sonnet-5[1m]')).toBe(false);

      for (const modelId of expectedOneMillionContextModels) {
        expect(
          namesById.get(modelId),
          `${modelId} should be labeled as a 1M context choice`
        ).toContain('1M context');
      }
    });

    it('returns empty array for unknown agent', () => {
      expect(getModelsForAgent('foo')).toEqual([]);
    });
  });

  describe('cross-catalog invariant', () => {
    it('every platform-routed claude-code and openai-codex dropdown model has a PLATFORM_AI_MODELS entry', () => {
      const platformIds = new Set(PLATFORM_AI_MODELS.map((m) => m.id));
      for (const agentType of ['claude-code', 'openai-codex'] as const) {
        const dropdown = getModelsForAgent(agentType);
        for (const model of dropdown) {
          if (agentType === 'claude-code' && isClaudeCode1mSelector(model.id)) {
            continue;
          }

          expect(
            platformIds.has(model.id),
            `${agentType} dropdown model ${model.id} missing from PLATFORM_AI_MODELS`
          ).toBe(true);
        }
      }
    });

    it('keeps Claude Code 1M selector suffixes out of raw platform proxy model IDs', () => {
      const platformIds = new Set(PLATFORM_AI_MODELS.map((m) => m.id));
      const selectorIds = getModelsForAgent('claude-code')
        .map((model) => model.id)
        .filter(isClaudeCode1mSelector);

      expect(selectorIds).toEqual(
        expect.arrayContaining([
          'claude-opus-4-8[1m]',
          'claude-opus-4-7[1m]',
          'claude-opus-4-6[1m]',
          'claude-sonnet-4-6[1m]',
        ])
      );

      for (const selectorId of selectorIds) {
        expect(
          platformIds.has(selectorId),
          `${selectorId} should not be accepted by the raw platform proxy`
        ).toBe(false);
        expect(
          platformIds.has(toClaudeCodeBaseModelId(selectorId)),
          `${selectorId} should map back to a known platform base model`
        ).toBe(true);
      }
    });
  });

  describe('isKnownModel', () => {
    it('returns true for a known claude model', () => {
      expect(isKnownModel('claude-code', 'claude-opus-4-7')).toBe(true);
    });

    it('returns true for a Claude Code 1M selector variant', () => {
      expect(isKnownModel('claude-code', 'claude-opus-4-8[1m]')).toBe(true);
    });

    it('returns false for a codex model under claude-code', () => {
      expect(isKnownModel('claude-code', 'gpt-5.4')).toBe(false);
    });

    it('returns true for a codex model under openai-codex', () => {
      expect(isKnownModel('openai-codex', 'gpt-5.6-sol')).toBe(true);
      expect(isKnownModel('openai-codex', 'gpt-5.6-terra')).toBe(true);
      expect(isKnownModel('openai-codex', 'gpt-5.6-luna')).toBe(true);
    });

    it('returns false for a custom/unknown model', () => {
      expect(isKnownModel('claude-code', 'my-custom-model')).toBe(false);
    });
  });
});
