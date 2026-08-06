import { describe, expect, it } from 'vitest';

import {
  classifyTaskRuntimeLiveness,
  type TaskRuntimeLivenessSignals,
} from '../../../src/services/task-runtime-liveness';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const STALE_MS = 5 * 60 * 1000;

function signals(overrides: Partial<TaskRuntimeLivenessSignals> = {}): TaskRuntimeLivenessSignals {
  return {
    taskWorkspaceId: 'workspace-1',
    workspaceProbeOutcome: 'ok',
    workspace: {
      id: 'workspace-1',
      status: 'running',
      chatSessionId: 'chat-1',
      nodeId: 'node-1',
      nodeRuntime: 'vm',
      nodeStatus: 'running',
      nodeHealthStatus: 'healthy',
      nodeHeartbeatAt: NOW,
    },
    nowMs: NOW,
    heartbeatStaleMs: STALE_MS,
    acpProbeOutcome: 'ok',
    acpSessions: [
      {
        id: 'acp-1',
        status: 'running',
        workspaceId: 'workspace-1',
        lastHeartbeatAt: NOW,
        updatedAt: NOW,
        startedAt: NOW - 1_000,
        createdAt: NOW - 2_000,
      },
    ],
    containerProbeOutcome: 'not_run',
    containerLifecycle: null,
    ...overrides,
  };
}

function workspaceFrom(base: TaskRuntimeLivenessSignals) {
  if (!base.workspace) throw new Error('Test signal must include a workspace');
  return base.workspace;
}

describe('classifyTaskRuntimeLiveness', () => {
  it('proves a task-scoped ACP session is live', () => {
    expect(classifyTaskRuntimeLiveness(signals())).toEqual({
      live: true,
      conclusive: true,
      reason: 'task_acp_session_live',
      workspaceStatus: 'running',
      nodeId: 'node-1',
      activeAcpSessionId: 'acp-1',
    });
  });

  it.each(['creating', 'sleeping', 'recovery'])('treats workspace %s as inconclusive', (status) => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: { ...workspaceFrom(base), status },
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: `workspace_${status}_resumable`,
    });
  });

  it.each(['sleeping', 'recovering', 'waking', 'restoring'])(
    'treats container lifecycle %s as inconclusive',
    (status) => {
      const base = signals();
      expect(
        classifyTaskRuntimeLiveness(
          signals({
            workspace: { ...workspaceFrom(base), nodeRuntime: 'cf-container' },
            containerProbeOutcome: 'ok',
            containerLifecycle: { status, activeWorkStatus: null },
          })
        )
      ).toMatchObject({
        live: false,
        conclusive: false,
        reason: `cf_container_${status}_resumable`,
      });
    }
  );

  it.each([
    ['timeout', 'task_liveness_timeout'],
    ['error', 'task_liveness_unknown'],
    ['unknown', 'task_liveness_unknown'],
  ] as const)('preserves ACP probe outcome %s', (outcome, reason) => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          acpProbeOutcome: outcome,
          acpSessions: [],
        })
      )
    ).toMatchObject({ live: false, conclusive: false, reason });
  });

  it.each([
    ['timeout', 'cf_container_lifecycle_timeout'],
    ['error', 'cf_container_lifecycle_unknown'],
    ['unknown', 'cf_container_lifecycle_unknown'],
  ] as const)('preserves container probe outcome %s', (outcome, reason) => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: { ...workspaceFrom(base), nodeRuntime: 'cf-container' },
          containerProbeOutcome: outcome,
          containerLifecycle: null,
        })
      )
    ).toMatchObject({ live: false, conclusive: false, reason });
  });

  it('classifies a dead VM node conclusively', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: { ...workspaceFrom(base), nodeStatus: 'stopped' },
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'node_not_live',
    });
  });

  it('classifies a completed ACP session conclusively dead', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          acpSessions: [
            {
              id: 'acp-completed',
              status: 'completed',
              workspaceId: 'workspace-1',
              lastHeartbeatAt: NOW,
              updatedAt: NOW,
              startedAt: NOW - 1_000,
              createdAt: NOW - 2_000,
            },
          ],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'task_acp_session_not_live',
    });
  });

  it('classifies terminal container lifecycle state conclusively dead', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: { ...workspaceFrom(base), nodeRuntime: 'cf-container' },
          containerProbeOutcome: 'ok',
          containerLifecycle: { status: 'error', activeWorkStatus: null },
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'cf_container_error',
    });
  });
});
