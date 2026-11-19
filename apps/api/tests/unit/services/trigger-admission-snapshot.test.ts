import { describe, expect, it } from 'vitest';

import { readTriggerAdmissionSnapshot } from '../../../src/services/trigger-admission-snapshot';

const current = {
  id: 't',
  projectId: 'p',
  userId: 'u',
  executionUserId: null,
  status: 'active',
  name: 'name',
  description: null,
  promptTemplate: 'original',
  triggerCount: 0,
  agentProfileId: null,
  skillId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  resourceRequirementsJson: null,
};

describe('immutable trigger admission snapshot', () => {
  it('validates snapshot shape and refuses foreign identity', () => {
    const row = current as Parameters<typeof readTriggerAdmissionSnapshot>[1];
    expect(() => readTriggerAdmissionSnapshot('[]', row)).toThrow();
    expect(() =>
      readTriggerAdmissionSnapshot(JSON.stringify({ ...current, projectId: 'other' }), row)
    ).toThrow(/identity/);
    expect(() =>
      readTriggerAdmissionSnapshot(JSON.stringify({ ...current, promptTemplate: 1 }), row)
    ).toThrow();
    expect(
      readTriggerAdmissionSnapshot(JSON.stringify(current), { ...row, promptTemplate: 'changed' })
        .promptTemplate
    ).toBe('original');
  });
});
