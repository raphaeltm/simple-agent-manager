import { describe, expect, it } from 'vitest';

import { DIALECT_VALUES, HARNESS_CAPABILITIES } from '../../src/harness-capabilities';
import { PROVIDER_PRESETS, type ProviderPreset } from '../../src/provider-presets';

const hasRequiredShape = (preset: ProviderPreset) => {
  expect(typeof preset.id, `${preset.id} id`).toBe('string');
  expect(preset.id.length, `${preset.id} id`).toBeGreaterThan(0);
  expect(typeof preset.label, `${preset.id} label`).toBe('string');
  expect(preset.label.length, `${preset.id} label`).toBeGreaterThan(0);
  expect(typeof preset.baseUrl, `${preset.id} baseUrl`).toBe('string');
  expect(Array.isArray(preset.suggestedModels), `${preset.id} suggestedModels`).toBe(true);
  expect(preset.suggestedModels.length, `${preset.id} suggestedModels`).toBeGreaterThan(0);

  for (const model of preset.suggestedModels) {
    expect(typeof model, `${preset.id} suggested model`).toBe('string');
    expect(model.length, `${preset.id} suggested model`).toBeGreaterThan(0);
  }
};

describe('provider presets', () => {
  it('contains representative provider presets with the expected shape', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(5);

    for (const preset of PROVIDER_PRESETS) {
      hasRequiredShape(preset);
    }
  });

  it('uses only registered dialect values', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(DIALECT_VALUES).toContain(preset.dialect);
    }
  });

  it('uses HTTPS base URLs', () => {
    for (const preset of PROVIDER_PRESETS) {
      const url = new URL(preset.baseUrl);

      expect(url.protocol, `${preset.id} baseUrl`).toBe('https:');
    }
  });

  it('has unique preset ids', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only includes dialects spoken by at least one real harness', () => {
    const speakableDialects = new Set(
      HARNESS_CAPABILITIES.flatMap((capability) => capability.dialects)
    );

    for (const preset of PROVIDER_PRESETS) {
      expect(speakableDialects.has(preset.dialect), preset.id).toBe(true);
    }
  });
});
