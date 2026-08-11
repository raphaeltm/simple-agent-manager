import type { PlacementExplanation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type * as schema from '../../../src/db/schema';
import { toTaskResponse, toWorkspaceResponse } from '../../../src/lib/mappers';

const placement: PlacementExplanation = {
  schemaVersion: 2,
  outcome: 'reused',
  selectionPath: 'capacity',
  selectedNodeId: 'node-1',
  summary: 'Reused node node-1 through the capacity path.',
  request: {
    runtime: 'vm',
    vmSize: 'medium',
    vmLocation: 'hel1',
    maxWorkspacesPerNode: 5,
    cpuThresholdPercent: 50,
    memoryThresholdPercent: 50,
    heartbeatStaleSeconds: 180,
  },
  evaluatedNodes: [],
  provisioningAttempts: [],
  decidedAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
};

describe('placement response mappers', () => {
  it('returns parsed workspace placement and rejects malformed JSON', () => {
    const base = {
      id: 'workspace-1',
      nodeId: 'node-1',
      projectId: 'project-1',
      userId: 'user-1',
      installationId: 'installation-1',
      displayName: 'Workspace',
      name: 'Workspace',
      repository: 'owner/repo',
      branch: 'main',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'hel1',
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      vmIp: null,
      lastActivityAt: null,
      portsPublicEnabled: false,
      errorMessage: null,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      chatSessionId: null,
      placementExplanationJson: JSON.stringify(placement),
    } as unknown as schema.Workspace;

    expect(toWorkspaceResponse(base, 'example.test').placementExplanation).toEqual(placement);
    expect(
      toWorkspaceResponse(
        { ...base, placementExplanationJson: '{bad json' } as schema.Workspace,
        'example.test'
      ).placementExplanation
    ).toBeNull();
  });

  it('retains raw task JSON while adding a safely parsed field', () => {
    const raw = JSON.stringify(placement);
    const task = {
      id: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      parentTaskId: null,
      workspaceId: null,
      title: 'Task',
      description: null,
      status: 'queued',
      executionStep: 'node_selection',
      priority: 0,
      taskMode: 'task',
      dispatchDepth: 0,
      agentProfileHint: null,
      skillId: null,
      skillHint: null,
      triggeredBy: 'user',
      triggerId: null,
      triggerExecutionId: null,
      requestedVmSize: null,
      requestedVmSizeSource: null,
      provisionedVmSize: null,
      resourceRequirementsJson: null,
      resourceRequirementsSource: null,
      resolvedReservationJson: null,
      placementExplanationJson: raw,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      outputSummary: null,
      outputBranch: null,
      outputPrUrl: null,
      completionEvidence: null,
      finalizedAt: null,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    } as unknown as schema.Task;

    const response = toTaskResponse(task);
    expect(response.placementExplanationJson).toBe(raw);
    expect(response.placementExplanation).toEqual(placement);
  });
});
