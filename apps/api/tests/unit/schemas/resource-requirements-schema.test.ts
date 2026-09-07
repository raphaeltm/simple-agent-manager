import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { CreateAgentProfileSchema } from '../../../src/schemas/agent-profiles';
import { CreateSkillSchema } from '../../../src/schemas/skills';
import { SubmitTaskSchema } from '../../../src/schemas/tasks';
import { CreateTriggerSchema } from '../../../src/schemas/triggers';

describe('resource requirements request schemas', () => {
  it('accepts omitted, empty, explicit false, and disk zero resource inputs', () => {
    expect(
      v.safeParse(SubmitTaskSchema, { message: 'ship', resourceRequirements: {} }).success
    ).toBe(true);
    expect(v.safeParse(SubmitTaskSchema, { message: 'ship' }).success).toBe(true);
    expect(
      v.safeParse(SubmitTaskSchema, {
        message: 'ship',
        resourceRequirements: { minVcpu: 1, minMemoryGb: 0.5, minDiskGb: 0, exclusiveNode: false },
      }).success
    ).toBe(true);
  });

  it('keeps null semantics on profile, skill, and trigger adapters but rejects task nulls', () => {
    expect(
      v.safeParse(CreateAgentProfileSchema, { name: 'profile', resourceRequirements: null })
        .success
    ).toBe(true);
    expect(v.safeParse(CreateSkillSchema, { name: 'skill', resourceRequirements: null }).success)
      .toBe(true);
    expect(
      v.safeParse(CreateTriggerSchema, {
        name: 'Nightly',
        sourceType: 'cron',
        promptTemplate: 'run',
        resourceRequirements: null,
      }).success
    ).toBe(true);
    expect(
      v.safeParse(SubmitTaskSchema, { message: 'ship', resourceRequirements: null }).success
    ).toBe(false);
  });

  it('rejects zero CPU, zero memory, malformed booleans, and invalid co-tenant counts', () => {
    for (const resourceRequirements of [
      { minVcpu: 0 },
      { minMemoryGb: 0 },
      { exclusiveNode: 'false' },
      { maxCoTenants: 0 },
      { maxCoTenants: 1.5 },
      [],
    ]) {
      expect(
        v.safeParse(SubmitTaskSchema, { message: 'ship', resourceRequirements }).success
      ).toBe(false);
    }
  });
});
