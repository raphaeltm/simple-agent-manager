import { describe, expect, it } from 'vitest';

import type * as schema from '../../../src/db/schema';
import { toTaskResponse } from '../../../src/lib/mappers';

function makeTaskRow(overrides: Partial<schema.Task> = {}): schema.Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    parentTaskId: null,
    workspaceId: null,
    title: 'Test task',
    description: 'desc',
    status: 'queued',
    executionStep: 'node_selection',
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: 'implementer',
    skillId: 'skill-1',
    skillHint: 'ship-it',
    triggeredBy: 'user',
    triggerId: null,
    triggerExecutionId: null,
    requestedVmSize: 'large',
    requestedVmSizeSource: 'agent-profile',
    provisionedVmSize: null,
    resourceRequirementsJson: '{"minVcpu":4}',
    resourceRequirementsSource: 'skill',
    resolvedReservationJson: null,
    placementExplanationJson: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    finalizedAt: null,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...overrides,
  } as schema.Task;
}

describe('toTaskResponse skill fields', () => {
  it('surfaces persisted skillId and skillHint', () => {
    const res = toTaskResponse(makeTaskRow());
    expect(res.skillId).toBe('skill-1');
    expect(res.skillHint).toBe('ship-it');
  });

  it('returns null skill fields when the task has no skill', () => {
    const res = toTaskResponse(makeTaskRow({ skillId: null, skillHint: null }));
    expect(res.skillId).toBeNull();
    expect(res.skillHint).toBeNull();
  });
});
