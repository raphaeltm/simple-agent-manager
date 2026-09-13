import { describe, expect, it } from 'vitest';

import {
  classifyTaskRuntimeDelivery,
  classifyTaskRuntimeLiveness,
  needsNodeHealthProbe,
  needsSessionResumabilityProbe,
  type SessionResumabilitySnapshot,
  type TaskRuntimeLivenessSignals,
} from '../../../src/services/task-runtime-liveness';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const STALE_MS = 5 * 60 * 1000;
/** Mirrors `DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`. */
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_ATTEMPT_DECAY_MS = 15 * 60 * 1000;

function signals(overrides: Partial<TaskRuntimeLivenessSignals> = {}): TaskRuntimeLivenessSignals {
  return {
    projectId: 'project-1',
    taskWorkspaceId: 'workspace-1',
    chatSessionId: 'chat-1',
    workspaceProbeOutcome: 'ok',
    workspace: {
      id: 'workspace-1',
      status: 'running',
      chatSessionId: 'chat-1',
      nodeId: 'node-1',
      userId: 'user-1',
      nodeRuntime: 'vm',
      nodeStatus: 'running',
      nodeHealthStatus: 'healthy',
      nodeHeartbeatAt: NOW,
      runningWorkspacesOnNode: 1,
    },
    nowMs: NOW,
    heartbeatStaleMs: STALE_MS,
    acpProbeOutcome: 'ok',
    nodeHealthProbeOutcome: 'not_run',
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
    sessionWork: null,
    containerProbeOutcome: 'not_run',
    containerLifecycle: null,
    // Default `not_run` keeps every pre-existing expectation in this file
    // unchanged, which is the back-compat proof for callers that cannot probe.
    resumabilityProbeOutcome: 'not_run',
    sessionResumability: null,
    resumabilityMaxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    resumabilityRecoveryAttemptDecayMs: RECOVERY_ATTEMPT_DECAY_MS,
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
      deliveryTarget: { nodeId: 'node-1', userId: 'user-1' },
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

  it('requires a node health probe for stale VM heartbeat even with running workspaces', () => {
    const base = signals();
    const staleSignals = signals({
      workspace: {
        ...workspaceFrom(base),
        nodeHeartbeatAt: NOW - STALE_MS - 1,
        runningWorkspacesOnNode: 2,
      },
      acpProbeOutcome: 'not_run',
      acpSessions: [],
    });

    expect(needsNodeHealthProbe(staleSignals)).toBe(true);
    expect(classifyTaskRuntimeLiveness(staleSignals)).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'node_heartbeat_stale_running_workspaces',
    });
  });

  it('treats a failed stale-node health response as inconclusive', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: {
            ...workspaceFrom(base),
            nodeHeartbeatAt: NOW - STALE_MS - 1,
            runningWorkspacesOnNode: 2,
          },
          acpProbeOutcome: 'not_run',
          nodeHealthProbeOutcome: 'failed',
          acpSessions: [],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'node_health_probe_failed',
    });
  });

  it('continues to task-scoped ACP liveness after successful node probe', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: {
            ...workspaceFrom(base),
            nodeHeartbeatAt: NOW - STALE_MS - 1,
            runningWorkspacesOnNode: 2,
          },
          nodeHealthProbeOutcome: 'ok',
        })
      )
    ).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_acp_session_live',
      activeAcpSessionId: 'acp-1',
    });
  });

  it('treats a timed-out node health probe as inconclusive', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: {
            ...workspaceFrom(base),
            nodeHeartbeatAt: NOW - STALE_MS - 1,
            runningWorkspacesOnNode: 2,
          },
          acpProbeOutcome: 'not_run',
          nodeHealthProbeOutcome: 'timeout',
          acpSessions: [],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'node_health_probe_timeout',
    });
  });

  it('treats a node health probe configuration error as inconclusive', () => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: {
            ...workspaceFrom(base),
            nodeHeartbeatAt: NOW - STALE_MS - 1,
            runningWorkspacesOnNode: 2,
          },
          acpProbeOutcome: 'not_run',
          nodeHealthProbeOutcome: 'error',
          acpSessions: [],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'node_health_probe_error',
    });
  });

  it('classifies an explicit terminal ACP session as conclusive terminal evidence', () => {
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
      reason: 'task_acp_session_terminal',
      activeAcpSessionId: 'acp-completed',
    });
  });

  it('does not let a historical terminal ACP session kill the expected running owner', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          expectedAcpSessionId: 'acp-current',
          acpSessions: [
            {
              id: 'acp-historical',
              status: 'completed',
              workspaceId: 'workspace-1',
              lastHeartbeatAt: NOW,
              updatedAt: NOW,
              startedAt: NOW - 4_000,
              createdAt: NOW - 5_000,
            },
            {
              id: 'acp-current',
              status: 'running',
              workspaceId: 'workspace-1',
              lastHeartbeatAt: NOW - STALE_MS - 1,
              updatedAt: NOW - STALE_MS - 1,
              startedAt: NOW - 2_000,
              createdAt: NOW - 3_000,
            },
          ],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'task_acp_session_stale',
    });
  });

  it('accepts terminal ACP evidence only for the expected current owner', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          expectedAcpSessionId: 'acp-current',
          acpSessions: [
            {
              id: 'acp-current',
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
      reason: 'task_acp_session_terminal',
      activeAcpSessionId: 'acp-current',
    });
  });

  it('treats a rebound workspace chat as inconclusive', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          expectedChatSessionId: 'chat-expected',
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_chat_session_mismatch',
    });
  });

  it('treats a missing ProjectData ACP session as suspect for a healthy VM runtime', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          acpSessions: [],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'task_acp_session_missing',
    });
  });

  it('treats a stale ProjectData ACP session as suspect for a healthy VM runtime', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          acpSessions: [
            {
              id: 'acp-stale',
              status: 'running',
              workspaceId: 'workspace-1',
              lastHeartbeatAt: NOW - STALE_MS - 1,
              updatedAt: NOW - STALE_MS - 1,
              startedAt: NOW - STALE_MS - 2_000,
              createdAt: NOW - STALE_MS - 3_000,
            },
          ],
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'task_acp_session_stale',
    });
  });

  it('treats fresh prompt-turn state as positive liveness even when ACP heartbeat is stale', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          acpSessions: [
            {
              id: 'acp-1',
              status: 'running',
              workspaceId: 'workspace-1',
              lastHeartbeatAt: NOW - STALE_MS - 1,
              updatedAt: NOW - STALE_MS - 1,
              startedAt: NOW - 10 * 60 * 1000,
              createdAt: NOW - 10 * 60 * 1000,
            },
          ],
          sessionWork: {
            active: true,
            activeAcpSessionId: 'acp-1',
            reason: 'task_prompt_turn_active',
          },
        })
      )
    ).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_prompt_turn_active',
      activeAcpSessionId: 'acp-1',
    });
  });

  it('treats fresh runtime-work state as positive liveness even when ACP heartbeat is absent', () => {
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          acpSessions: [
            {
              id: 'acp-1',
              status: 'running',
              workspaceId: 'workspace-1',
              lastHeartbeatAt: null,
              updatedAt: NOW - STALE_MS - 1,
              startedAt: NOW - 10 * 60 * 1000,
              createdAt: NOW - 10 * 60 * 1000,
            },
          ],
          sessionWork: {
            active: true,
            activeAcpSessionId: 'acp-1',
            reason: 'task_runtime_work_active',
          },
        })
      )
    ).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_runtime_work_active',
      activeAcpSessionId: 'acp-1',
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

describe('classifyTaskRuntimeDelivery', () => {
  const target = { nodeId: 'node-1', userId: 'user-1' };

  it('delivers when live runtime evidence and a scoped target agree', () => {
    expect(
      classifyTaskRuntimeDelivery({
        live: true,
        conclusive: true,
        reason: 'task_acp_session_live',
        workspaceStatus: 'running',
        nodeId: 'node-1',
        activeAcpSessionId: 'acp-1',
        deliveryTarget: target,
      })
    ).toEqual({ kind: 'deliverable', target });
  });

  it.each(['task_acp_session_missing', 'task_acp_session_stale', 'task_acp_session_suspect'])(
    'permits one bounded delivery probe for %s',
    (reason) => {
      expect(
        classifyTaskRuntimeDelivery({
          live: false,
          conclusive: false,
          reason,
          workspaceStatus: 'running',
          nodeId: 'node-1',
          activeAcpSessionId: null,
          deliveryTarget: target,
        })
      ).toEqual({ kind: 'deliverable', target });
    }
  );

  it.each(['node_health_probe_failed', 'node_health_probe_timeout', 'node_health_probe_error'])(
    'defers delivery when node reachability is %s',
    (reason) => {
      expect(
        classifyTaskRuntimeDelivery({
          live: false,
          conclusive: false,
          reason,
          workspaceStatus: 'running',
          nodeId: 'node-1',
          activeAcpSessionId: null,
          deliveryTarget: target,
        })
      ).toEqual({ kind: 'inconclusive', reason });
    }
  );

  it('routes explicit terminal ownership evidence to canonical convergence', () => {
    expect(
      classifyTaskRuntimeDelivery({
        live: false,
        conclusive: true,
        reason: 'task_acp_session_terminal',
        workspaceStatus: 'running',
        nodeId: 'node-1',
        activeAcpSessionId: 'acp-1',
        deliveryTarget: target,
      })
    ).toEqual({ kind: 'terminal', reason: 'task_acp_session_terminal', nodeId: 'node-1' });
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
      // The `workspaces` row `loadRecoveryContext` requires still exists.
      recoveryWorkspacePresent: true,
      sleepingAt: SLEEPING_AT,
      sleepStatus: 'sleeping',
      expiresAtMs: EXPIRES_AT,
      status: 'available',
      degradation: 'none',
      recoveryAttempts: 0,
      recoveryFailedAtMs: null,
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
    // NOTE: `workspaceId: 'workspace-2'` used to appear here. It was removed on
    // 2026-09-13: `claimSessionSnapshotRecovery` is keyed on chat session and
    // never filtered on `workspace_id`, and the column is nulled by
    // `ON DELETE SET NULL` when the slept workspace row is removed — so scoping
    // the verdict to it terminalized exactly the sessions the resumer could
    // still wake. `snapshot for another chat session` below is the replacement
    // control, and it discriminates the predicate that actually scopes the read.
    ['snapshot for another chat session', { chatSessionId: 'chat-2' }],
    ['snapshot for another project', { projectId: 'project-2' }],
    // `loadRecoveryContext` requires the workspace ROW, so a snapshot that lost
    // its pointer is genuinely unwakeable — the destroyer must not be LOOSER
    // than the resumer either (`.claude/rules/58` req 2).
    ['snapshot lost its runtime workspace row', { recoveryWorkspacePresent: false }],
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

  // Through the REAL wiring: `classifyTaskRuntimeLiveness` reads both budget
  // signals off `TaskRuntimeLivenessSignals` and hands them to
  // `isSessionResumable`. The dedicated budget suite proves the primitive; this
  // proves the struct -> call seam production actually uses (`.claude/rules/62`).
  // Both cases sit one millisecond either side of the cutoff.
  it.each([
    ['decayed', -1, 'workspace_deleted_snapshot_resumable'],
    // CHANGED 2026-09-13: an undecayed burst is a refusal the resumer releases by
    // itself within `RECOVERY_ATTEMPT_DECAY_MS`, so the destroyer waits it out
    // under its own diagnostic reason rather than terminalizing. See
    // `session-snapshot-recovery-budget.test.ts` for the production evidence.
    ['undecayed', 1, 'workspace_deleted_wake_retry_pending'],
  ])('%s exhausted budget', (_label, cutoffOffsetMs, reason) => {
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable({
            recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
            recoveryFailedAtMs: base.nowMs - RECOVERY_ATTEMPT_DECAY_MS + cutoffOffsetMs,
          }),
        })
      )
    ).toMatchObject({ conclusive: false, reason });
  });

  it('terminalizes an exhausted budget that can never decay', () => {
    // Discriminating control for the row above: with no clean failure anchor the
    // budget never releases, so the bounded escape must still fire
    // (`.claude/rules/47`).
    const base = signals();
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: sleptWorkspace(base),
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable({
            recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
            recoveryFailedAtMs: null,
          }),
        })
      )
    ).toMatchObject({ live: false, conclusive: true, reason: 'workspace_deleted' });
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

  it('keeps a missing workspace row conclusively dead when the snapshot lost its row too', () => {
    // `loadRecoveryContext` requires the `workspaces` ROW, and deleting it also
    // nulls `session_snapshots.workspace_id` via `ON DELETE SET NULL`. This is
    // production's shape: 36 of 278 sleeping VM snapshots hold a null pointer and
    // genuinely cannot be woken (SAM idea 01M2CQD1FK7YA96VD6Q74302K0).
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          workspace: null,
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable({
            workspaceId: null,
            recoveryWorkspacePresent: false,
          }),
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_missing',
    });
  });

  it('preserves a task whose own workspace binding is gone but whose snapshot still resolves', () => {
    // The 2026-09-13 production shape the sweep was failing: `tasks.workspace_id`
    // is null, so the classifier reaches `workspace_missing` — but the SNAPSHOT
    // still names a live workspace row, which is what `loadRecoveryContext`
    // actually reads. The resumer would accept this wake, so the destroyer must
    // not terminalize it (`.claude/rules/58`).
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          taskWorkspaceId: null,
          workspace: null,
          resumabilityProbeOutcome: 'ok',
          sessionResumability: resumable(),
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_missing_snapshot_resumable',
    });
  });

  it('withholds the missing-workspace verdict when the snapshot read failed', () => {
    // `.claude/rules/58` req 4 on the branch that previously had no probe at all.
    expect(
      classifyTaskRuntimeLiveness(
        signals({
          taskWorkspaceId: null,
          workspace: null,
          resumabilityProbeOutcome: 'error',
          sessionResumability: null,
        })
      )
    ).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_missing_resumability_unknown',
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
    expect(
      needsSessionResumabilityProbe({
        workspace: signals().workspace,
        workspaceProbeOutcome: 'ok',
        chatSessionId: 'chat-1',
      })
    ).toBe(false);
  });

  it.each(['deleted', 'stopped', 'error', 'pending'])(
    'probes resumability before failing a %s workspace',
    (status) => {
      const base = signals();
      expect(
        needsSessionResumabilityProbe({
          workspace: { ...workspaceFrom(base), status },
          workspaceProbeOutcome: 'ok',
          chatSessionId: 'chat-1',
        })
      ).toBe(true);
    }
  );

  it('probes resumability when the workspace row is gone entirely', () => {
    // The production shape from 2026-09-13: deleting a slept workspace nulls
    // `tasks.workspace_id`, so the classifier reaches `workspace_missing` with no
    // row at all. Gating the probe on a workspace existing blinded it to exactly
    // the sessions it protects (`.claude/rules/63`).
    expect(
      needsSessionResumabilityProbe({
        workspace: null,
        workspaceProbeOutcome: 'ok',
        chatSessionId: 'chat-1',
      })
    ).toBe(true);
  });

  it('skips the probe when the chat binding or the workspace read is unusable', () => {
    const base = signals();
    const deleted = { ...workspaceFrom(base), status: 'deleted' };
    expect(
      needsSessionResumabilityProbe({
        workspace: deleted,
        workspaceProbeOutcome: 'error',
        chatSessionId: 'chat-1',
      })
    ).toBe(false);
    // No chat session means no key to read the resumer's record with — that is
    // the supersession handoff's shape, which `needsTaskSupersessionProbe` owns.
    expect(
      needsSessionResumabilityProbe({
        workspace: deleted,
        workspaceProbeOutcome: 'ok',
        chatSessionId: null,
      })
    ).toBe(false);
    expect(
      needsSessionResumabilityProbe({
        workspace: null,
        workspaceProbeOutcome: 'ok',
        chatSessionId: null,
      })
    ).toBe(false);
    expect(
      needsSessionResumabilityProbe({
        workspace: { ...deleted, status: 'sleeping' },
        workspaceProbeOutcome: 'ok',
        chatSessionId: 'chat-1',
      })
    ).toBe(false);
  });
});
