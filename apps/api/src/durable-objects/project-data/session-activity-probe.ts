/**
 * The session-activity probe's network entry point: resolve each stale candidate's
 * owner, ask its vm-agent whether a turn is in flight, and fan a reconciled turn end
 * out to every consumer. A slept Instant container is not asked: it runs nothing, and
 * the request would wake it. Split out of `session-activity-reconciliation.ts`, which
 * keeps the SQL state machine (`.claude/rules/18-file-size-limits.md`).
 */
import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger, serializeError } from '../../lib/logger';
import { listAgentSessionsOnNode } from '../../services/node-agent';
import { isSleepingContainerRuntime } from '../../services/sleeping-container-runtime';
import { recordAcpActivityCallbackMetric } from '../../services/telemetry';
import { recordActivityEventInternal } from './activity';
import {
  sessionActivityProbeMaxAttempts,
  sessionActivityProbeMaxCandidates,
  sessionActivityProbeTimeoutMs,
} from './reconciliation-thresholds';
import {
  applyProbeOutcome,
  classifyProbeResponse,
  type ProbeOutcome,
  publishTurnEnd,
  selectStaleActivityProbeCandidates,
  type SessionActivityReconciliationHooks,
  type StaleActivityCandidate,
} from './session-activity-reconciliation';
import type { Env as DOEnv } from './types';

const log = createModuleLogger('session_activity_reconciliation');

/**
 * Resolve the workspace owner needed to authenticate the probe request, and whether the
 * probed runtime is a slept Instant container.
 */
async function resolveProbeTarget(
  env: WorkerEnv,
  candidate: StaleActivityCandidate,
  projectId: string | null
): Promise<{ userId: string; runtimeAsleep: boolean } | null> {
  const row = await env.DATABASE.prepare(
    `SELECT w.user_id, w.project_id, n.runtime AS node_runtime, n.status AS node_status
       FROM workspaces w
       LEFT JOIN nodes n ON n.id = ?
      WHERE w.id = ?
      LIMIT 1`
  )
    .bind(candidate.nodeId, candidate.workspaceId)
    .first<{
      user_id: string | null;
      project_id: string | null;
      node_runtime: string | null;
      node_status: string | null;
    }>();

  if (!row?.user_id) return null;
  // Never probe across tenants. Fail CLOSED (.claude/rules/51): an absent
  // project on either side leaves ownership ambiguous, and an ambiguous
  // identity must reject rather than fall through to the permissive path —
  // this probe mints a node-management token scoped to the workspace owner.
  if (!projectId || row.project_id !== projectId) {
    log.error('session_activity.workspace_project_mismatch', {
      workspaceId: candidate.workspaceId,
      expectedProjectId: projectId,
      actualProjectId: row.project_id,
      action: 'rejected',
    });
    return null;
  }
  return {
    userId: row.user_id,
    runtimeAsleep: isSleepingContainerRuntime({
      nodeRuntime: row.node_runtime ?? null,
      nodeStatus: row.node_status ?? null,
    }),
  };
}

/**
 * Probe every stale candidate and reconcile the authoritative state.
 *
 * Intended to run from `ctx.waitUntil()` — never inline on the alarm path.
 */
export async function probeStaleSessionActivity(
  sql: SqlStorage,
  env: DOEnv,
  hooks: SessionActivityReconciliationHooks,
  options: { thresholdMs: number; projectId: string | null }
): Promise<{ probed: number; reconciled: number }> {
  const maxAttempts = sessionActivityProbeMaxAttempts(env);
  const requestTimeoutMs = sessionActivityProbeTimeoutMs(env);
  const maxCandidates = sessionActivityProbeMaxCandidates(env);
  const candidates = selectStaleActivityProbeCandidates(sql, {
    thresholdMs: options.thresholdMs,
    maxAttempts,
    maxCandidates,
    // Worst case this pass takes maxCandidates * requestTimeoutMs; hold the
    // claim at least that long so an overlapping alarm cannot re-probe a row
    // this pass has not reached yet.
    leaseMs: maxCandidates * requestTimeoutMs,
  });
  if (candidates.length === 0) return { probed: 0, reconciled: 0 };

  const workerEnv = env as unknown as WorkerEnv;
  let reconciled = 0;

  for (const candidate of candidates) {
    let outcome: ProbeOutcome;
    try {
      const target = await resolveProbeTarget(workerEnv, candidate, options.projectId);
      if (!target) {
        outcome = { kind: 'unreachable', error: 'workspace_owner_unresolved' };
      } else if (target.runtimeAsleep) {
        // A slept Instant container runs nothing, so no turn can be in flight; asking would
        // restore it from its snapshot just to hear that.
        outcome = { kind: 'not_working', hostStatus: null };
      } else {
        const payload = await listAgentSessionsOnNode(
          candidate.nodeId,
          candidate.workspaceId,
          workerEnv,
          target.userId,
          { requestTimeoutMs }
        );
        outcome = classifyProbeResponse(payload, candidate.acpSessionId, candidate.workspaceId);
      }
    } catch (err) {
      outcome = { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) };
    }

    let changed = false;
    try {
      changed = applyProbeOutcome(sql, candidate, outcome, { maxAttempts });
    } catch (err) {
      log.error('session_activity.probe_apply_failed', {
        acpSessionId: candidate.acpSessionId,
        ...serializeError(err),
      });
      continue;
    }

    if (!changed) continue;
    reconciled += 1;
    recordAcpActivityCallbackMetric(
      {
        metric: 'acp_activity_callback',
        outcome: 'healed',
        projectId: options.projectId,
        sessionId: candidate.acpSessionId,
        nodeId: candidate.nodeId,
        workspaceId: candidate.workspaceId,
        activity: 'idle',
        reason: 'probe_reconciled',
        source: 'reconciliation_probe',
      },
      workerEnv
    );
    recordActivityEventInternal(
      sql,
      'session.activity_reconciled',
      'system',
      null,
      candidate.workspaceId,
      candidate.chatSessionId,
      null,
      JSON.stringify({
        acpSessionId: candidate.acpSessionId,
        outcome: outcome.kind,
        hostStatus: outcome.kind === 'not_working' ? outcome.hostStatus : null,
        staleForMs: Math.max(0, Date.now() - candidate.activityAt),
      })
    );
    // The TURN ended; the session itself is untouched and still wants an idle
    // timer. Alarm recomputation is deferred to one call after the sweep rather
    // than one per reconciled candidate (.claude/rules/47).
    await publishTurnEnd(hooks, candidate.chatSessionId, { kind: 'idle' }, { deferAlarm: true });
  }

  if (reconciled > 0) await hooks.recalculateAlarm();

  log.info('session_activity.probe_sweep_completed', {
    probed: candidates.length,
    reconciled,
  });
  return { probed: candidates.length, reconciled };
}
