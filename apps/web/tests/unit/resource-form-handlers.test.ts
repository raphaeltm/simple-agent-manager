import { describe, expect, it } from 'vitest';

import {
  clearStoredFieldError,
  deserializeResourceRequirements,
  EMPTY_RESOURCE_STATE,
  hasAnyResourceValue,
  hasValidationErrors,
  type ResourceRequirementsFormState,
  serializeResourceRequirements,
  toResourceRequirements,
  validateResourceState,
} from '../../src/components/resource-requirements';
import { buildBaseSubmitRequest } from '../../src/pages/project-chat/submitRequest';

/**
 * These tests exercise the actual save/submit handler semantics across all four
 * resource form surfaces (Profile, Skill, Trigger, Project Infrastructure) and
 * the chat submit flow. They use the real utility functions that the handlers call.
 */

const MIXED_LEGACY_MODERN = JSON.stringify({ minVcpu: 4, minMemoryGb: 16 });
const PARTIAL_MODERN = JSON.stringify({ minVcpu: 2 });
const FULL_MODERN = JSON.stringify({ minVcpu: 4, minMemoryGb: 8, minDiskGb: 40, exclusiveNode: true });
const MALFORMED = JSON.stringify({ minVcpu: 2, exclusiveNode: 'yes' });
const WITH_UNKNOWN = JSON.stringify({ minVcpu: 2, futureField: 'data', anotherNew: 42 });
const WITH_NULL_FIELD = JSON.stringify({ minVcpu: 2, minMemoryGb: null });

describe('save handler semantics (all four surfaces)', () => {
  function simulateSaveHandler(stored: string | null, edits: Partial<ResourceRequirementsFormState> = {}) {
    const state = deserializeResourceRequirements(stored);
    const edited = { ...state, ...edits };
    const errors = validateResourceState(edited);
    if (hasValidationErrors(errors)) return { errors, saved: null };
    const json = serializeResourceRequirements(edited);
    return { errors: {}, saved: json };
  }

  it('no-op save of mixed modern preserves both fields', () => {
    const { saved, errors } = simulateSaveHandler(MIXED_LEGACY_MODERN);
    expect(errors).toEqual({});
    expect(JSON.parse(saved!)).toEqual({ minVcpu: 4, minMemoryGb: 16 });
  });

  it('partial edit keeps unmodified fields', () => {
    const { saved } = simulateSaveHandler(MIXED_LEGACY_MODERN, { minVcpu: '8' });
    expect(JSON.parse(saved!)).toEqual({ minVcpu: 8, minMemoryGb: 16 });
  });

  it('partial modern no-op preserves value', () => {
    const { saved } = simulateSaveHandler(PARTIAL_MODERN);
    expect(JSON.parse(saved!)).toEqual({ minVcpu: 2 });
  });

  it('full modern no-op preserves all fields', () => {
    const { saved } = simulateSaveHandler(FULL_MODERN);
    expect(JSON.parse(saved!)).toEqual({ minVcpu: 4, minMemoryGb: 8, minDiskGb: 40, exclusiveNode: true });
  });

  it('explicit inherit/clear sends null', () => {
    const { saved } = simulateSaveHandler(MIXED_LEGACY_MODERN, { ...EMPTY_RESOURCE_STATE });
    expect(saved).toBeNull();
  });

  it('malformed data blocks save initially', () => {
    const { errors } = simulateSaveHandler(MALFORMED);
    expect(hasValidationErrors(errors)).toBe(true);
  });

  it('malformed data blocks save even after editing valid field', () => {
    const state = deserializeResourceRequirements(MALFORMED);
    const edited = { ...state, minVcpu: '3' };
    const errors = validateResourceState(edited);
    expect(hasValidationErrors(errors)).toBe(true);
    expect(() => serializeResourceRequirements(edited)).toThrow();
  });

  it('clearing raw invalid field allows save of remaining valid fields', () => {
    const state = deserializeResourceRequirements(MALFORMED);
    const cleared = { ...state, ...clearStoredFieldError(state, 'exclusiveNode') };
    const errors = validateResourceState(cleared);
    expect(hasValidationErrors(errors)).toBe(false);
    const json = serializeResourceRequirements(cleared);
    expect(JSON.parse(json!)).toEqual({ minVcpu: 2 });
  });

  it('unknown stored fields preserved through no-op save', () => {
    const { saved } = simulateSaveHandler(WITH_UNKNOWN);
    const parsed = JSON.parse(saved!);
    expect(parsed.futureField).toBe('data');
    expect(parsed.anotherNew).toBe(42);
    expect(parsed.minVcpu).toBe(2);
  });

  it('unknown stored fields preserved through edit of known field', () => {
    const { saved } = simulateSaveHandler(WITH_UNKNOWN, { minVcpu: '4' });
    const parsed = JSON.parse(saved!);
    expect(parsed.futureField).toBe('data');
    expect(parsed.anotherNew).toBe(42);
    expect(parsed.minVcpu).toBe(4);
  });

  it('null-typed field blocks save', () => {
    const { errors } = simulateSaveHandler(WITH_NULL_FIELD);
    expect(hasValidationErrors(errors)).toBe(true);
  });

  it('unsafe CPU 1e100 is rejected', () => {
    const { errors } = simulateSaveHandler(null, { minVcpu: '1e100' });
    expect(errors.minVcpu).toBeTruthy();
  });
});

describe('exclusive checkbox preserves maxCoTenants (Fix 5)', () => {
  it('unchecking exclusive does NOT clear stored maxCoTenants', () => {
    const json = JSON.stringify({ exclusiveNode: true, maxCoTenants: 2 });
    const state = deserializeResourceRequirements(json);
    expect(state.exclusiveNode).toBe(true);
    expect(state.maxCoTenants).toBe('2');
    const toggled = { ...state, exclusiveNode: false as boolean | undefined };
    expect(toggled.maxCoTenants).toBe('2');
    const saved = serializeResourceRequirements(toggled);
    expect(JSON.parse(saved!)).toEqual({ exclusiveNode: false, maxCoTenants: 2 });
  });

  it('explicit false is distinct from inherit undefined', () => {
    const withFalse = { ...EMPTY_RESOURCE_STATE, exclusiveNode: false as boolean | undefined };
    const withUndefined = { ...EMPTY_RESOURCE_STATE };
    const savedFalse = serializeResourceRequirements(withFalse);
    const savedUndefined = serializeResourceRequirements(withUndefined);
    expect(JSON.parse(savedFalse!)).toEqual({ exclusiveNode: false });
    expect(savedUndefined).toBeNull();
  });
});

describe('chat submit request builder', () => {
  const BASE = {
    message: 'do work',
    agentProfileId: 'prof-1' as string | null,
    skillId: null as string | null,
    selectedAgentType: 'claude-code',
    selectedWorkspaceProfile: 'full' as const,
    selectedDevcontainerConfigName: '',
    selectedTaskMode: 'task' as const,
    pendingDerived: null,
  };

  it('profile VM with resources includes resourceRequirements', () => {
    const req = buildBaseSubmitRequest({
      ...BASE,
      selectedResourceRequirements: { minVcpu: 4, minMemoryGb: 8 },
    });
    expect(req.agentProfileId).toBe('prof-1');
    expect(req.resourceRequirements).toEqual({ minVcpu: 4, minMemoryGb: 8 });
  });

  it('profile with no resources omits resourceRequirements', () => {
    const req = buildBaseSubmitRequest(BASE);
    expect('resourceRequirements' in req).toBe(false);
  });

  it('exclusiveNode false reaches API', () => {
    const req = buildBaseSubmitRequest({
      ...BASE,
      selectedResourceRequirements: { exclusiveNode: false },
    });
    expect(req.resourceRequirements).toEqual({ exclusiveNode: false });
  });

  it('disk 0 reaches API', () => {
    const req = buildBaseSubmitRequest({
      ...BASE,
      selectedResourceRequirements: { minDiskGb: 0 },
    });
    expect(req.resourceRequirements).toEqual({ minDiskGb: 0 });
  });

  it('no-profile builder includes resources', () => {
    const req = buildBaseSubmitRequest({
      ...BASE,
      agentProfileId: null,
      selectedResourceRequirements: { minVcpu: 2 },
    });
    expect(req.resourceRequirements).toEqual({ minVcpu: 2 });
  });
});

describe('toResourceRequirements conversion', () => {
  it('empty state returns undefined', () => {
    expect(toResourceRequirements(EMPTY_RESOURCE_STATE)).toBeUndefined();
  });

  it('valid state returns normalized object', () => {
    const state = { ...EMPTY_RESOURCE_STATE, minVcpu: '4', minMemoryGb: '8' };
    expect(toResourceRequirements(state)).toEqual({ minVcpu: 4, minMemoryGb: 8 });
  });

  it('exclusiveNode false is included', () => {
    const state = { ...EMPTY_RESOURCE_STATE, exclusiveNode: false as boolean | undefined };
    expect(toResourceRequirements(state)).toEqual({ exclusiveNode: false });
  });
});

describe('per-task resource override lifecycle (chat hook semantics)', () => {
  it('hasAnyResourceValue detects non-empty state', () => {
    expect(hasAnyResourceValue(EMPTY_RESOURCE_STATE)).toBe(false);
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, minVcpu: '4' })).toBe(true);
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, exclusiveNode: false })).toBe(true);
  });

  it('hasAnyResourceValue detects opaque/invalid fields', () => {
    const withOpaque = { ...EMPTY_RESOURCE_STATE, _opaqueFields: { futureField: 'x' } };
    expect(hasAnyResourceValue(withOpaque)).toBe(true);
    const withInvalid = { ...EMPTY_RESOURCE_STATE, _rawInvalidFields: { minVcpu: 'oops' } };
    expect(hasAnyResourceValue(withInvalid)).toBe(true);
  });

  it('validation blocks submit for invalid resource overrides', () => {
    const state = { ...EMPTY_RESOURCE_STATE, minVcpu: '1e100' };
    const errors = validateResourceState(state);
    expect(hasValidationErrors(errors)).toBe(true);
    expect(errors.minVcpu).toBeTruthy();
  });

  it('validation passes for valid resource overrides', () => {
    const state = { ...EMPTY_RESOURCE_STATE, minVcpu: '4', minMemoryGb: '8' };
    const errors = validateResourceState(state);
    expect(hasValidationErrors(errors)).toBe(false);
  });

  it('reset to EMPTY_RESOURCE_STATE clears all per-task overrides', () => {
    const state = { ...EMPTY_RESOURCE_STATE, minVcpu: '4', minMemoryGb: '8' };
    expect(hasAnyResourceValue(state)).toBe(true);
    const reset = { ...EMPTY_RESOURCE_STATE };
    expect(hasAnyResourceValue(reset)).toBe(false);
    expect(toResourceRequirements(reset)).toBeUndefined();
  });
});

describe('clearStoredFieldError', () => {
  it('clears only the targeted field error and raw entry', () => {
    const state: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      storedFieldErrors: { minVcpu: 'bad', minMemoryGb: 'also bad' },
      _rawInvalidFields: { minVcpu: 'x', minMemoryGb: null },
    };
    const patch = clearStoredFieldError(state, 'minVcpu');
    const next = { ...state, ...patch };
    expect(next.storedFieldErrors?.minVcpu).toBeUndefined();
    expect(next.storedFieldErrors?.minMemoryGb).toBe('also bad');
    expect(next._rawInvalidFields?.minVcpu).toBeUndefined();
    expect(next._rawInvalidFields?.minMemoryGb).toBeNull();
  });

  it('clears metadata entirely when last field is cleared', () => {
    const state: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      storedFieldErrors: { minVcpu: 'bad' },
      _rawInvalidFields: { minVcpu: 'x' },
    };
    const patch = clearStoredFieldError(state, 'minVcpu');
    expect(patch.storedFieldErrors).toBeUndefined();
    expect(patch._rawInvalidFields).toBeUndefined();
  });

  it('returns empty patch for non-existent field', () => {
    const patch = clearStoredFieldError(EMPTY_RESOURCE_STATE, 'minVcpu');
    expect(Object.keys(patch)).toHaveLength(0);
  });

  it('clears stored null value (own-key presence, not truthiness)', () => {
    const state: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      storedFieldErrors: { minMemoryGb: 'Invalid type' },
      _rawInvalidFields: { minMemoryGb: null },
    };
    const patch = clearStoredFieldError(state, 'minMemoryGb');
    expect(patch._rawInvalidFields).toBeUndefined();
    expect(patch.storedFieldErrors).toBeUndefined();
  });

  it('clears stored false value (own-key presence, not truthiness)', () => {
    const state: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      storedFieldErrors: { exclusiveNode: 'Invalid type' },
      _rawInvalidFields: { exclusiveNode: false },
    };
    const patch = clearStoredFieldError(state, 'exclusiveNode');
    expect(patch._rawInvalidFields).toBeUndefined();
    expect(patch.storedFieldErrors).toBeUndefined();
  });

  it('clears stored empty string value (own-key presence, not truthiness)', () => {
    const state: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      storedFieldErrors: { minVcpu: 'Invalid' },
      _rawInvalidFields: { minVcpu: '' },
    };
    const patch = clearStoredFieldError(state, 'minVcpu');
    expect(patch._rawInvalidFields).toBeUndefined();
    expect(patch.storedFieldErrors).toBeUndefined();
  });
});

describe('null-typed field repair through form edit (end-to-end)', () => {
  it('stored null minMemoryGb can be cleared by editing that field to a valid number', () => {
    const json = JSON.stringify({ minVcpu: 2, minMemoryGb: null });
    const state = deserializeResourceRequirements(json);
    expect(state._rawInvalidFields?.minMemoryGb).toBeNull();
    expect(state.storedFieldErrors?.minMemoryGb).toBeTruthy();

    const fieldPatch = clearStoredFieldError(state, 'minMemoryGb');
    const edited = { ...state, ...fieldPatch, minMemoryGb: '8' };

    expect(edited._rawInvalidFields).toBeUndefined();
    expect(edited.storedFieldErrors).toBeUndefined();
    const errors = validateResourceState(edited);
    expect(hasValidationErrors(errors)).toBe(false);
    const saved = serializeResourceRequirements(edited);
    expect(JSON.parse(saved!)).toEqual({ minVcpu: 2, minMemoryGb: 8 });
  });
});
