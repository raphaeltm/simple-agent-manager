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
        ])
      );
      expect(groups[1]?.models.map((model) => model.id)).toEqual(
        expect.arrayContaining([
          'gpt-5.4-pro',
          'gpt-5.4',
          'gpt-5.4-mini',
          'gpt-5.4-nano',
        ])
      );

      const namesById = new Map(
        groups.flatMap((group) => group.models).map((model) => [model.id, model.name])
      );
      expect(
        groups.find((group) => group.label === 'GPT-5.4 (Current)')?.models.map((model) => model.id)
      ).toEqual(['gpt-5.4-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']);
      expect(
        groups.find((group) => group.label === 'Codex (Current)')?.models.map((model) => model.id)
      ).toEqual(['gpt-5.3-codex']);
      expect(
        groups.find((group) => group.label === 'Deprecated')?.models.map((model) => model.id)
      ).toEqual(['o4-mini']);
      expect(
        groups.find((group) => group.label === 'GPT-5 (Previous)')?.models.map((model) => model.id)
      ).toEqual(['gpt-5-mini']);
      expect(namesById.get('gpt-5.4')).not.toContain('retires');
      expect(namesById.get('gpt-5.4-mini')).not.toContain('retires');
      expect(namesById.get('gpt-5.3-codex')).not.toContain('Deprecated');
      expect(namesById.has('gpt-5.2-codex')).toBe(false);
      expect(namesById.has('gpt-5.1-codex-max')).toBe(false);
      expect(namesById.has('gpt-5.1-codex-mini')).toBe(false);
      expect(namesById.get('o4-mini')).toContain('Deprecated');
    });

    it('returns grouped models for mistral-vibe', () => {
      const groups = getModelGroupsForAgent('mistral-vibe');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      const allModels = groups.flatMap((g) => g.models);
      expect(allModels.map((model) => model.id)).toEqual(
        expect.arrayContaining([
          'mistral-medium-3-5',
          'mistral-small-2603',
          'mistral-large-2512',
          'codestral-2508',
          'ministral-14b-2512',
          'ministral-8b-2512',
          'ministral-3b-2512',
        ])
      );
      expect(allModels.some((model) => model.id === 'mistral-medium-3-5-2604')).toBe(false);
      expect(allModels.some((model) => model.id === 'devstral-2-2512')).toBe(false);
      expect(allModels.some((model) => model.id === 'mistral-medium-2508')).toBe(false);
      expect(allModels.some((model) => model.id === 'magistral-medium-1-2-2509')).toBe(false);
      expect(allModels.some((model) => model.id.startsWith('ministral-3-'))).toBe(false);
    });

    it('returns grouped models for google-gemini', () => {
      const groups = getModelGroupsForAgent('google-gemini');
      expect(groups.length).toBeGreaterThanOrEqual(1);
      const allModels = groups.flatMap((g) => g.models);
      expect(allModels.some((m) => m.id === 'gemini-3.7-flash')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.6-flash')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.5-flash')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.5-flash-lite')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-2.5-flash-lite')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.1-pro-preview')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.1-flash-lite')).toBe(true);
      expect(allModels.some((m) => m.id === 'gemini-3.1-pro')).toBe(false);
      expect(allModels.some((m) => m.id === 'gemini-2.0-flash')).toBe(false);

      const currentGroup = groups.find((group) => group.label === 'Gemini 2.5 (Current)');
      expect(currentGroup?.models.map((model) => model.name)).toEqual([
        'Gemini 2.5 Pro',
        'Gemini 2.5 Flash',
        'Gemini 2.5 Flash-Lite',
      ]);
      expect(allModels.find((model) => model.id === 'gemini-3.1-flash-lite')?.name).toContain(
        'retires May 7, 2027'
      );
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
      expect(allModels.some((m) => m.id === 'opencode/gemini-3.7-flash')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode/grok-4.6')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode/muse-spark-1.2')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode/muse-spark-1.2-contributor-free')).toBe(
        true
      );
      expect(allModels.some((m) => m.id === 'opencode/nemotron-3.5-lightning-free')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode/x-preview-f-free')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode/ling-3.0-tiny-free')).toBe(false);
      expect(allModels.some((m) => m.id === 'opencode-go/glm-5.2')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode-go/glm-5.3')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode-go/deepseek-v4-flash-vision-exp')).toBe(
        true
      );
      expect(allModels.some((m) => m.id === 'opencode-go/muse-spark-1.2-contributor')).toBe(true);
      expect(allModels.some((m) => m.id === 'opencode-go/ox-alpha-free')).toBe(true);
    });
  });

  describe('getModelsForAgent', () => {
    it('returns flat list of models for claude-code', () => {
      const models = getModelsForAgent('claude-code');
      expect(models.length).toBeGreaterThanOrEqual(14);
      expect(models.some((m) => m.id === 'claude-fable-5')).toBe(true);
      expect(models.some((m) => m.id === 'claude-opus-5')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-5')).toBe(true);
      expect(models.some((m) => m.id === 'claude-opus-4-8')).toBe(true);
      expect(models.some((m) => m.id === 'claude-opus-4-7')).toBe(true);
      expect(models.some((m) => m.id === 'claude-opus-4-1-20250805')).toBe(false);
      expect(models.some((m) => m.id === 'claude-sonnet-4-6')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-4-20250514')).toBe(false);
    });

    it('lists the current Claude Code 1M context choices', () => {
      const models = getModelsForAgent('claude-code');
      const namesById = new Map(models.map((model) => [model.id, model.name]));

      const expectedOneMillionContextModels = [
        'claude-fable-5',
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-opus-4-8[1m]',
        'claude-opus-4-7[1m]',
        'claude-opus-4-6[1m]',
        'claude-sonnet-4-6[1m]',
      ];

      expect(models.map((model) => model.id)).toEqual(
        expect.arrayContaining(expectedOneMillionContextModels)
      );
      // Native 1M models (Claude 5 family) are base IDs — no [1m] selector variants.
      expect(models.some((model) => model.id === 'claude-sonnet-5[1m]')).toBe(false);
      expect(models.some((model) => model.id === 'claude-opus-5[1m]')).toBe(false);

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
      expect(isKnownModel('claude-code', 'claude-opus-5')).toBe(true);
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
