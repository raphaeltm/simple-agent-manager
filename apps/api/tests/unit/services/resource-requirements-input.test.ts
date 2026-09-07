import { resolveResourceReservation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  createPersistedTaskResourcePlanJson,
  normalizeResourceRequirementsInput,
  parseStoredResourceRequirementsJson,
  readPersistedTaskResourcePlan,
  serializeModernResourceRequirementsInput,
  serializeResourceRequirementsInput,
} from '../../../src/services/resource-requirements-input';

describe('resource requirements input validation', () => {
  it('preserves supported modern fields, explicit false, and disk zero', () => {
    const result = normalizeResourceRequirementsInput({
      minVcpu: 4,
      minMemoryGb: 16,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 1,
      legacyNote: 'ignored',
    });

    expect(result).toEqual({
      minVcpu: 4,
      minMemoryGb: 16,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 1,
    });
  });

  it('ignores inherited and unknown fields before serializing', () => {
    const inherited = Object.create({ minVcpu: 64 });
    inherited.minMemoryGb = 16;
    inherited.extra = 'ignored';

    expect(normalizeResourceRequirementsInput(inherited)).toEqual({ minMemoryGb: 16 });
    expect(serializeResourceRequirementsInput(inherited)).toBe('{"minMemoryGb":16}');
  });

  it('normalizes JSON strings for persisted compatibility fields', () => {
    expect(
      serializeResourceRequirementsInput(
        '{"minVcpu":2,"exclusiveNode":false}',
        'resourceRequirementsJson'
      )
    ).toBe('{"minVcpu":2,"exclusiveNode":false}');
  });

  it('rejects JSON strings on modern resourceRequirements fields', () => {
    expect(() =>
      serializeModernResourceRequirementsInput('{"minVcpu":2}', 'resourceRequirements')
    ).toThrow(/resourceRequirements must be an object or null/);
    expect(() => serializeModernResourceRequirementsInput([], 'resourceRequirements')).toThrow(
      /resourceRequirements must be an object or null/
    );
    expect(serializeModernResourceRequirementsInput(null, 'resourceRequirements')).toBeNull();
    expect(
      serializeModernResourceRequirementsInput(
        { minVcpu: 2, exclusiveNode: false, minDiskGb: 0 },
        'resourceRequirements'
      )
    ).toBe('{"minVcpu":2,"minDiskGb":0,"exclusiveNode":false}');
  });

  it('rejects malformed known fields', () => {
    for (const value of [
      { minVcpu: -1 },
      { minVcpu: 0 },
      { minMemoryGb: Number.NaN },
      { minDiskGb: Number.POSITIVE_INFINITY },
      { exclusiveNode: 'false' },
      { maxCoTenants: 0 },
      { maxCoTenants: 1.5 },
      [],
    ]) {
      expect(() => normalizeResourceRequirementsInput(value)).toThrow();
    }
  });

  it('keeps null and omitted semantics in API adapters', () => {
    expect(serializeResourceRequirementsInput(null)).toBeNull();
    expect(serializeResourceRequirementsInput('')).toBeNull();
    expect(parseStoredResourceRequirementsJson(null)).toBeUndefined();
    expect(parseStoredResourceRequirementsJson(undefined)).toBeUndefined();
  });

  it('rejects malformed stored resource JSON instead of wiping intent', () => {
    expect(() => parseStoredResourceRequirementsJson('{"minVcpu":0}')).toThrow(
      /resourceRequirementsJson is malformed/
    );
    expect(() => parseStoredResourceRequirementsJson('not-json')).toThrow(
      /resourceRequirementsJson is malformed/
    );
  });

  it('round-trips versioned task resource plans with inherited layer identity', () => {
    const layers = {
      skill: { minVcpu: 4 },
      agentProfile: { minMemoryGb: 12 },
      project: { minDiskGb: 0, exclusiveNode: false },
    };
    const resolvedReservation = resolveResourceReservation(layers, {
      taskId: 'task-1',
      skillId: 'skill-1',
      agentProfileId: 'profile-1',
      projectId: 'project-1',
      userId: 'user-1',
    });

    const planJson = createPersistedTaskResourcePlanJson({
      layers,
      resolvedReservation,
      requestedVmSize: 'large',
      requestedVmSizeSource: 'skill',
    });
    const read = readPersistedTaskResourcePlan({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      resourceRequirementPlanJson: planJson,
      resourceRequirementsJson: '{"minVcpu":4}',
      resourceRequirementsSource: 'skill',
      resolvedReservationJson: JSON.stringify(resolvedReservation),
      requestedVmSize: 'small',
      requestedVmSizeSource: 'project',
    });

    expect(read.source).toBe('plan-v1');
    expect(read.layers).toEqual(layers);
    expect(read.resolvedReservation).toMatchObject({
      cpuMillis: 4000,
      memoryMb: 12 * 1024,
      diskMb: 0,
      exclusiveNode: false,
    });
    expect(read.resolvedReservation?.fieldProvenance?.minVcpu).toMatchObject({
      source: 'skill',
      value: 4,
    });
    expect(read.resolvedReservation?.fieldProvenance?.minMemoryGb).toMatchObject({
      source: 'agent-profile',
      value: 12,
    });
    expect(read.requestedVmSize).toBe('large');
    expect(read.requestedVmSizeSource).toBe('skill');
  });

  it('reconstructs old rows from resolved reservation provenance without guessing legacy JSON is task input', () => {
    const oldReservation = resolveResourceReservation(
      {
        skill: { minVcpu: 4 },
        agentProfile: { minMemoryGb: 12 },
        project: { minDiskGb: 0, exclusiveNode: false },
      },
      {
        taskId: 'task-1',
        skillId: 'skill-1',
        agentProfileId: 'profile-1',
        projectId: 'project-1',
        userId: 'user-1',
      }
    );

    const read = readPersistedTaskResourcePlan({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      resourceRequirementsJson: '{"minVcpu":4}',
      resourceRequirementsSource: null,
      resolvedReservationJson: JSON.stringify(oldReservation),
    });

    expect(read.source).toBe('reservation-provenance');
    expect(read.layers).toEqual({
      skill: { minVcpu: 4 },
      agentProfile: { minMemoryGb: 12 },
      project: { minDiskGb: 0, exclusiveNode: false },
    });
    expect(read.resolvedReservation?.fieldProvenance?.minVcpu?.source).toBe('skill');
  });

  it('requires legacy first-layer JSON to name its source when no reservation provenance exists', () => {
    expect(() =>
      readPersistedTaskResourcePlan({
        taskId: 'task-1',
        projectId: 'project-1',
        userId: 'user-1',
        resourceRequirementsJson: '{"minVcpu":4}',
      })
    ).toThrow(/ambiguous without resourceRequirementsSource/);
  });
});
