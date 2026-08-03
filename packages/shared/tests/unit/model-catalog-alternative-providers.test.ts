import { describe, expect, it } from 'vitest';

import { getModelGroupsForAgent, getModelsForAgent, isKnownModel } from '../../src/model-catalog';

const OPENCODE_CONSUMERS = ['opencode'] as const;

const EXPECTED_OPENCODE_MODELS = [
  'opencode/claude-fable-5',
  'opencode/claude-opus-5',
  'opencode/claude-sonnet-5',
  'opencode/gemini-3.6-flash',
  'opencode/gpt-5.6-sol',
  'opencode/laguna-s-2.1-free',
  'opencode/kimi-k3',
  'opencode/minimax-m3',
  'opencode/qwen3.7-plus',
  'opencode-go/glm-5.2',
  'opencode-go/grok-4.5',
  'opencode-go/gpt-5.6-luna',
  'opencode-go/hy3',
  'opencode-go/kimi-k3',
  'opencode-go/qwen3.8-max',
] as const;

const EXPECTED_GROUP_LABELS = ['OpenCode Zen', 'OpenCode Go'] as const;

describe('OpenCode model catalog entries', () => {
  it('keys suggested OpenCode models as provider-qualified IDs', () => {
    for (const agentType of OPENCODE_CONSUMERS) {
      const models = getModelsForAgent(agentType);

      for (const modelId of EXPECTED_OPENCODE_MODELS) {
        expect(
          models.some((model) => model.id === modelId),
          `${agentType} is missing ${modelId}`
        ).toBe(true);
        expect(isKnownModel(agentType, modelId), `${agentType} should know ${modelId}`).toBe(true);
      }
    }
  });

  it('keeps changed Models.dev display names in sync', () => {
    const namesById = new Map(
      getModelsForAgent('opencode').map((model) => [model.id, model.name])
    );

    expect(namesById.get('opencode/deepseek-v4-flash')).toBe('DeepSeek V4 Flash 0731');
    expect(namesById.get('opencode/deepseek-v4-flash-free')).toBe(
      'DeepSeek V4 Flash Free (New)'
    );
    expect(namesById.get('opencode-go/deepseek-v4-flash')).toBe(
      'DeepSeek V4 Flash (New)'
    );
    expect(namesById.get('opencode-go/gpt-5.6-luna')).toBe('GPT-5.6 Luna (2x usage)');
    expect(namesById.get('opencode-go/kimi-k3')).toBe('Kimi K3');
  });

  it('keeps OpenCode groups discoverable by provider label', () => {
    for (const agentType of OPENCODE_CONSUMERS) {
      const labels = getModelGroupsForAgent(agentType).map((group) => group.label);

      for (const label of EXPECTED_GROUP_LABELS) {
        expect(labels).toContain(label);
      }
    }
  });

  it('uses valid model definition fields consistent with catalog conventions', () => {
    for (const agentType of OPENCODE_CONSUMERS) {
      for (const group of getModelGroupsForAgent(agentType)) {
        expect(group.label.trim()).toBe(group.label);
        expect(group.label.length).toBeGreaterThan(0);
        expect(group.models.length).toBeGreaterThan(0);

        for (const model of group.models) {
          expect(model.id).toMatch(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
          expect(model.name.trim()).toBe(model.name);
          expect(model.name.length).toBeGreaterThan(0);
          expect(model.group).toBe(group.label);
        }
      }
    }
  });

  it('excludes inactive Models.dev records from the static fallback', () => {
    expect(isKnownModel('opencode', 'opencode/hy3-free')).toBe(false);
  });

  it('does not duplicate model IDs within each OpenCode consumer catalog', () => {
    for (const agentType of OPENCODE_CONSUMERS) {
      const ids = getModelsForAgent(agentType).map((model) => model.id);
      expect(new Set(ids).size, `${agentType} has duplicate model ids`).toBe(ids.length);
    }
  });
});
