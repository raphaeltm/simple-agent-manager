import { describe, expect, it } from 'vitest';

import { getModelGroupsForAgent, getModelsForAgent, isKnownModel } from '../../src/model-catalog';

const OPENAI_COMPATIBLE_CONSUMERS = ['opencode'] as const;

const EXPECTED_ALTERNATIVE_PROVIDER_MODELS = {
  mistral: [
    'mistral-medium-3-5-2604',
    'mistral-small-2603',
    'mistral-large-2512',
    'devstral-2512',
    'codestral-2508',
  ],
  cohere: [
    'north-mini-code-1-0',
    'command-a-plus-05-2026',
    'command-a-03-2025',
    'command-a-reasoning-08-2025',
  ],
  scaleway: [
    'qwen3-coder-30b-a3b-instruct',
    'qwen3.6-35b-a3b',
    'gemma-4-26b-a4b-it',
    'gpt-oss-120b',
  ],
} as const;

const EXPECTED_GROUP_LABELS = [
  'Mistral AI (OpenAI-compatible)',
  'Cohere North (OpenAI-compatible)',
  'Scaleway Generative APIs (OpenAI-compatible)',
] as const;

describe('alternative-provider model catalog entries', () => {
  it('keys suggested alternative-provider models under openai-compatible consumers', () => {
    for (const agentType of OPENAI_COMPATIBLE_CONSUMERS) {
      const models = getModelsForAgent(agentType);

      for (const providerModels of Object.values(EXPECTED_ALTERNATIVE_PROVIDER_MODELS)) {
        for (const modelId of providerModels) {
          expect(
            models.some((model) => model.id === modelId),
            `${agentType} is missing ${modelId}`
          ).toBe(true);
          expect(isKnownModel(agentType, modelId), `${agentType} should know ${modelId}`).toBe(
            true
          );
        }
      }
    }
  });

  it('keeps alternative-provider groups discoverable by provider label', () => {
    for (const agentType of OPENAI_COMPATIBLE_CONSUMERS) {
      const labels = getModelGroupsForAgent(agentType).map((group) => group.label);

      for (const label of EXPECTED_GROUP_LABELS) {
        expect(labels).toContain(label);
      }
    }
  });

  it('uses valid model definition fields consistent with catalog conventions', () => {
    for (const agentType of OPENAI_COMPATIBLE_CONSUMERS) {
      for (const group of getModelGroupsForAgent(agentType)) {
        expect(group.label.trim()).toBe(group.label);
        expect(group.label.length).toBeGreaterThan(0);
        expect(group.models.length).toBeGreaterThan(0);

        for (const model of group.models) {
          expect(model.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
          expect(model.name.trim()).toBe(model.name);
          expect(model.name.length).toBeGreaterThan(0);
          expect(model.group).toBe(group.label);
        }
      }
    }
  });

  it('does not duplicate model IDs within each openai-compatible consumer catalog', () => {
    for (const agentType of OPENAI_COMPATIBLE_CONSUMERS) {
      const ids = getModelsForAgent(agentType).map((model) => model.id);
      expect(new Set(ids).size, `${agentType} has duplicate model ids`).toBe(ids.length);
    }
  });
});
