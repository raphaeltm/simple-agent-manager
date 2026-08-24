import { describe, expect, it } from 'vitest';

import {
  classifyTaskRuntimeLiveness,
  needsSessionResumabilityProbe,
  type SessionResumabilitySnapshot,
  type TaskRuntimeLivenessSignals,
} from '../../../src/services/task-runtime-liveness';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const STALE_MS = 5 * 60 * 1000;
/** Mirrors `DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`. */
const MAX_RECOVERY_ATTEMPTS = 3;

function signals(overrides: Partial<TaskRuntimeLivenessSignals> = {}): TaskRuntimeLivenessSignals {
  return {
    projectId: 'project-1',
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
    // Default `not_run` keeps every pre-existing expectation in this file
    // unchanged, which is the back-compat proof for callers that cannot probe.
    resumabilityProbeOutcome: 'not_run',
    sessionResumability: null,
    resumabilityMaxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    // Same back-compat proof for the supersession signals: `not_run` / `none`
    // must leave every pre-existing verdict in this file untouched.
    supersessionProbeOutcome: 'not_run',
    supersession: 'none',
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

/**
 * Regression suite for the 2026-08-16 production incident: two task sessions
 * (`da90b7c4`, `8bd22a42`) were terminalized as
 * "Task runtime is conclusively gone after reconciliation grace (workspace_deleted)"
 * while their `session_snapshots` rows were asleep, unexpired and restorable.
 *
 * `NodeLifecycle` rewrites a slept workspace's `sleeping` status to `deleted`
 * five minutes after sleep, so workspace status alone cannot tell "slept and
 * restorable" apart from "destroyed". Fixture values below are the real
 * production rows.
 */
describe('classifyTaskRuntimeLiveness — slept sessions are not dead', () => {
  const SLEEPING_AT = NOW - 9 * 60 * 1000;
  const EXPIRES_AT = NOW + 7 * 24 * 60 * 60 * 1000;

  function resumable(overrides: Partial<SessionResumabilitySnapshot> = {}) {
    return {
      chatSessionId: 'chat-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      sleepingAt: SLEEPING_AT,
      sleepStatus: 'sleeping',
      expiresAtMs: EXPIRES_AT,
      status: 'available',
      degradation: 'none',
      recoveryAttempts: 0,
      ...overrides,
    } satisfies SessionResumabilitySnapshot;
  }

  /** Workspace as NodeLifecycle leaves it 5 min after an idle sleep. */
  function sleptWorkspace(base: TaskRuntimeLivenessSignals) {
    return { ...workspaceFrom(base), status: 'deleted' };
  }

  it('does not terminalize a slept session with a live snapshot (incident 8bd22a42)', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable(),
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_snapshot_resumable',
      workspaceStatus: 'deleted',
    });
  });

  it('treats a degraded-but-restorable snapshot as resumable (incident da90b7c4)', () => {
    // Real row: status='degraded', degradation='entries-skipped', home R2 key
    // present. `restorableSnapshotCondition()` accepts that pair, so the
    // classifier must too. These fields are genuinely read by
    // `isRestorableSnapshot`, so this case is not a duplicate of the one above.
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable({
            status: 'degraded',
            degradation: 'entries-skipped',
          }),
        })
      )
    ).toMatchObject({ conclusive: false, reason: 'workspace_deleted_snapshot_resumable' });
  });

  it('still terminalizes a user-deleted workspace that has no snapshot row', () => {
    // Discriminating control: a user delete destroys the snapshot row, so this
    // must keep failing exactly as before. Without it, the test above would
    // also pass if terminalization were disabled outright.
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: null,
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it.each([
    ['expired snapshot', { expiresAtMs: NOW - 1 }],
    ['expiry exactly now', { expiresAtMs: NOW }],
    ['unparseable/absent expiry', { expiresAtMs: null }],
    ['never slept', { sleepingAt: null }],
    // Every real wake path clears BOTH fields; this guards the half-cleared
    // shape defensively rather than reproducing an observed transition.
    ['already woke (sleep_status cleared)', { sleepStatus: null }],
    ['snapshot for another workspace', { workspaceId: 'workspace-2' }],
    ['snapshot for another project', { projectId: 'project-2' }],
    // Parity with `claimSessionSnapshotRecovery`: the resumer refuses these, so
    // preserving the task would strand it until the snapshot TTL.
    ['unrestorable status/degradation pair', { status: 'failed', degradation: 'none' }],
    ['degraded but degradation cleared', { status: 'degraded', degradation: 'none' }],
    ['available but degradation set', { status: 'available', degradation: 'entries-skipped' }],
    ['wake attempts exhausted', { recoveryAttempts: MAX_RECOVERY_ATTEMPTS }],
    ['wake attempts over budget', { recoveryAttempts: MAX_RECOVERY_ATTEMPTS + 1 }],
  ])('terminalizes when the snapshot is not restorable: %s', (_label, overrides) => {
    // Bounded escape path (`.claude/rules/47`): a snapshot must never be able
    // to keep a task alive forever.
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable(overrides),
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('still preserves on the last remaining wake attempt', () => {
    // Boundary control for the `recoveryAttempts` escape: one attempt left is
    // still resumable, so the guard must be `>=`, not `>`.
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable({ recoveryAttempts: MAX_RECOVERY_ATTEMPTS - 1 }),
        })
      )
    ).toMatchObject({ conclusive: false, reason: 'workspace_deleted_snapshot_resumable' });
  });

  it('withholds a death verdict when the resumability probe failed', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'error',
          sessionResumability: null,
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_resumability_unknown',
    });
  });

  it('keeps a missing workspace row conclusively dead even with a snapshot', () => {
    // `loadRecoveryContext` requires the workspace row to exist, so a
    // hard-deleted workspace genuinely cannot be resumed.
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: null,
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable(),
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_missing',
    });
  });

  it('leaves the already-inconclusive sleeping status untouched', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: { ...workspaceFrom(base), status: 'sleeping' },
          resumabilityProbeOutcome: 'not_run',
        })
      )
    ).toMatchObject({ conclusive: false, reason: 'workspace_sleeping_resumable' });
  });

  it('does not probe resumability for a workspace that is not about to be failed', () => {
    expect(needsSessionResumabilityProbe(signals().workspace, 'ok')).toBe(false);
  });

  it.each(['deleted', 'stopped', 'error', 'pending'])(
    'probes resumability before failing a %s workspace',
    (status) => {
      const base = signals();
      expect(needsSessionResumabilityProbe({ ...workspaceFrom(base), status }, 'ok')).toBe(true);
    }
  );

  it('skips the probe when workspace identity or the workspace read is unusable', () => {
    const base = signals();
    const deleted = { ...workspaceFrom(base), status: 'deleted' };
    expect(needsSessionResumabilityProbe(deleted, 'error')).toBe(false);
    expect(needsSessionResumabilityProbe({ ...deleted, chatSessionId: null }, 'ok')).toBe(false);
    expect(needsSessionResumabilityProbe(null, 'ok')).toBe(false);
    expect(needsSessionResumabilityProbe({ ...deleted, status: 'sleeping' }, 'ok')).toBe(false);
  });
});
