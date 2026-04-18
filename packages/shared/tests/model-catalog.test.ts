import { describe, expect, it } from 'vitest';

import { getModelGroupsForAgent, getModelsForAgent, isKnownModel } from '../src/model-catalog';

describe('model-catalog', () => {
  describe('getModelGroupsForAgent', () => {
    it('returns grouped models for claude-code', () => {
      const groups = getModelGroupsForAgent('claude-code');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      expect(groups[0]!.label).toContain('Claude 4');
      expect(groups[0]!.models.length).toBeGreaterThanOrEqual(4);
    });

    it('returns grouped models for openai-codex', () => {
      const groups = getModelGroupsForAgent('openai-codex');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      expect(groups[0]!.models.some((m) => m.id === 'gpt-5.4')).toBe(true);
    });

    it('returns grouped models for mistral-vibe', () => {
      const groups = getModelGroupsForAgent('mistral-vibe');
      expect(groups.length).toBeGreaterThanOrEqual(2);
      expect(groups[0]!.models.some((m) => m.id === 'devstral-2512')).toBe(true);
    });

    it('returns grouped models for google-gemini', () => {
      const groups = getModelGroupsForAgent('google-gemini');
      expect(groups.length).toBeGreaterThanOrEqual(1);
      expect(groups[0]!.models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
    });

    it('returns empty array for unknown agent type', () => {
      expect(getModelGroupsForAgent('nonexistent')).toEqual([]);
    });

    it('returns empty array for opencode (no catalog)', () => {
      expect(getModelGroupsForAgent('opencode')).toEqual([]);
    });
  });

  describe('getModelsForAgent', () => {
    it('returns flat list of models for claude-code', () => {
      const models = getModelsForAgent('claude-code');
      expect(models.length).toBeGreaterThanOrEqual(7);
      expect(models.some((m) => m.id === 'claude-opus-4-7')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-4-6')).toBe(true);
    });

    it('returns empty array for unknown agent', () => {
      expect(getModelsForAgent('foo')).toEqual([]);
    });
  });

  describe('isKnownModel', () => {
    it('returns true for a known claude model', () => {
      expect(isKnownModel('claude-code', 'claude-opus-4-7')).toBe(true);
    });

    it('returns false for a codex model under claude-code', () => {
      expect(isKnownModel('claude-code', 'gpt-5.4')).toBe(false);
    });

    it('returns true for a codex model under openai-codex', () => {
      expect(isKnownModel('openai-codex', 'gpt-5.4')).toBe(true);
    });

    it('returns false for a custom/unknown model', () => {
      expect(isKnownModel('claude-code', 'my-custom-model')).toBe(false);
    });
  });
});
