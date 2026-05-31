import { describe, expect, it } from 'vitest';

import { parseResourceRequirementsJson, resolveTaskStartAudit } from '../../../src/services/task-start-audit';

describe('resolveTaskStartAudit', () => {
  it('resolves resource precedence per field: task > trigger > profile > project > platform', () => {
    const audit = resolveTaskStartAudit({
      taskId: 'task-1',
      triggerId: 'trigger-1',
      agentProfileId: 'profile-1',
      projectId: 'project-1',
      userId: 'user-1',
      explicit: { resourceRequirements: { minVcpu: 8 } },
      trigger: { resourceRequirements: { minMemoryMb: 16384 } },
      agentProfile: { resourceRequirements: { minDiskMb: 204800 } },
      project: { defaultResourceRequirements: { maxCoTenants: 2 } },
      taskModeFallback: 'task',
    });

    expect(audit.resources.resolvedReservation.cpuMillis).toBe(8000);
    expect(audit.resources.resolvedReservation.memoryMb).toBe(16384);
    expect(audit.resources.resolvedReservation.diskMb).toBe(204800);
    expect(audit.resources.resolvedReservation.maxCoTenants).toBe(2);
    expect(audit.resources.resolvedReservation.exclusiveNode).toBe(false);
    expect(audit.resources.resolvedReservation.fieldSources).toMatchObject({
      minVcpu: 'task',
      minMemoryMb: 'trigger',
      minDiskMb: 'agent-profile',
      maxCoTenants: 'project',
      exclusiveNode: 'platform',
    });
  });

  it('preserves MCP task-mode policy fallback regardless of lightweight workspace', () => {
    const audit = resolveTaskStartAudit({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      explicit: { workspaceProfile: 'lightweight' },
      project: {},
      taskModeFallback: 'task',
    });

    expect(audit.workspaceProfile).toBe('lightweight');
    expect(audit.taskMode).toBe('task');
  });

  it('keeps UI submit lightweight fallback as conversation mode', () => {
    const audit = resolveTaskStartAudit({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      explicit: { workspaceProfile: 'lightweight' },
      project: {},
      taskModeFallback: 'workspace-profile',
    });

    expect(audit.taskMode).toBe('conversation');
  });

  it('rejects invalid persisted JSON', () => {
    expect(() => parseResourceRequirementsJson('{"maxCoTenants":0}', 'test requirements'))
      .toThrow(/maxCoTenants/);
  });
});

