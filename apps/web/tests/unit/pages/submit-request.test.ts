import { describe, expect, it } from 'vitest';

import { buildBaseSubmitRequest } from '../../../src/pages/project-chat/submitRequest';

const BASE_ARGS = {
  message: 'Fix the bug',
  agentProfileId: null as string | null,
  skillId: null as string | null,
  selectedAgentType: 'claude-code',
  selectedWorkspaceProfile: 'full' as const,
  selectedDevcontainerConfigName: '',
  selectedTaskMode: 'task' as const,
  pendingDerived: null,
};

describe('buildBaseSubmitRequest', () => {
  it('includes resourceRequirements when no profile is selected', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      selectedResourceRequirements: { minVcpu: 4, minMemoryGb: 8 },
    });
    expect(result.resourceRequirements).toEqual({ minVcpu: 4, minMemoryGb: 8 });
  });

  it('includes resourceRequirements even when a profile is selected', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      agentProfileId: 'profile-123',
      selectedResourceRequirements: { minVcpu: 2 },
    });
    expect(result.agentProfileId).toBe('profile-123');
    expect(result.resourceRequirements).toEqual({ minVcpu: 2 });
  });

  it('omits resourceRequirements when undefined (inherits)', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      agentProfileId: 'profile-123',
    });
    expect(result.resourceRequirements).toBeUndefined();
  });

  it('passes exclusiveNode false through to the request', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      selectedResourceRequirements: { exclusiveNode: false },
    });
    expect(result.resourceRequirements).toEqual({ exclusiveNode: false });
  });

  it('passes disk 0 through to the request', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      selectedResourceRequirements: { minDiskGb: 0 },
    });
    expect(result.resourceRequirements).toEqual({ minDiskGb: 0 });
  });

  it('no-op without resources produces no resourceRequirements field', () => {
    const result = buildBaseSubmitRequest(BASE_ARGS);
    expect('resourceRequirements' in result).toBe(false);
  });

  it('includes skillId with profile', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      agentProfileId: 'profile-123',
      skillId: 'skill-456',
    });
    expect(result.agentProfileId).toBe('profile-123');
    expect(result.skillId).toBe('skill-456');
  });

  it('carries fork/retry lineage as parentTaskId and never a context summary', () => {
    const pendingDerived = {
      type: 'fork' as const,
      parentSessionId: 'session-1',
      parentSessionLabel: 'Fix the login bug',
      parentTaskId: 'task-1',
      promptLoading: false,
    };
    for (const agentProfileId of [null, 'profile-123']) {
      const result = buildBaseSubmitRequest({ ...BASE_ARGS, agentProfileId, pendingDerived });
      expect(result.parentTaskId).toBe('task-1');
      expect('contextSummary' in result).toBe(false);
    }
  });

  it('omits parentTaskId when the derived session has no task', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      pendingDerived: {
        type: 'fork',
        parentSessionId: 'session-1',
        parentSessionLabel: 'Fix the login bug',
        parentTaskId: '',
        promptLoading: false,
      },
    });
    expect('parentTaskId' in result).toBe(false);
    expect(result.message).toBe('Fix the bug');
  });
});
