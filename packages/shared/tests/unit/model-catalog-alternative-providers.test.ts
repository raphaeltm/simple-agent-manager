import { describe, expect, it } from 'vitest';

import { getModelGroupsForAgent, getModelsForAgent, isKnownModel } from '../../src/model-catalog';

const OPENCODE_CONSUMERS = ['opencode'] as const;

const EXPECTED_OPENCODE_MODELS = [
  'opencode/claude-fable-5',
  'opencode/claude-sonnet-5',
  'opencode/gpt-5.6-sol',
  'opencode/hy3-free',
  'opencode/minimax-m3',
  'opencode-go/glm-5.2',
  'opencode-go/grok-4.5',
  'opencode-go/kimi-k3',
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

  it('does not duplicate model IDs within each OpenCode consumer catalog', () => {
    for (const agentType of OPENCODE_CONSUMERS) {
      const ids = getModelsForAgent(agentType).map((model) => model.id);
      expect(new Set(ids).size, `${agentType} has duplicate model ids`).toBe(ids.length);
    }
  });
});
