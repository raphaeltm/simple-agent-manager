/**
 * Probe-backed reconciliation of the authoritative session-activity state.
 *
 * `session_state.activity` is written by the VM agent's own activity reports.
 * Those reports are lossy: a callback can 401, a turn can end abnormally
 * (cancel / interrupt / force-stop), or the report can simply never arrive.
 * When that happens the row wedges in a working state and THREE consumers
 * break together — the stop-button UI, durable-message delivery gating, and
 * idle/sleep scheduling.
 *
 * The pre-existing SQL-only heal (`session-state.reconcileStaleActivity`)
 * cannot help an awake session: it refuses to heal while the ACP session is
 * heartbeating, and a vm-agent heartbeats whether or not a prompt is in
 * flight. That is a liveness signal standing in for an idleness signal —
 * exactly the failure mode `.claude/rules/53` exists to prevent.
 *
 * So: a working state older than the staleness bound with no progress
 * evidence is UNPROVEN, not trusted. We ask the only authority that actually
 * knows — the vm-agent's live SessionHost status, already exposed by
 * `GET /workspaces/{workspaceId}/agent-sessions` (`hostStatus`) on every
 * deployed agent, so no vm-agent rollout is involved.
 *
 * Control-loop budget (`.claude/rules/47`): candidate selection is cheap SQL
 * on the alarm path; the network probe runs outside it via `waitUntil`, under
 * a short background timeout, bounded per pass, and every candidate leaves the
 * candidate set — reconciled, refreshed, or terminalized as dead after a
 * bounded number of unreachable probes.
 */
import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger, serializeError } from '../../lib/logger';
import { listAgentSessionsOnNode } from '../../services/node-agent';
import { recordActivityEventInternal } from './activity';
import {
  sessionActivityProbeMaxAttempts,
  sessionActivityProbeMaxCandidates,
  sessionActivityProbeTimeoutMs,
} from './reconciliation-thresholds';
import { recordTurnEnd, WORKING_ACTIVITIES } from './session-state';
import type { Env as DOEnv } from './types';

const log = createModuleLogger('session_activity_reconciliation');

/** Host statuses that prove a prompt turn really is in flight right now. */
const HOST_WORKING_STATUSES = new Set(['prompting', 'recovering']);

export interface StaleActivityCandidate {
  acpSessionId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  activityAt: number;
  probeAttempts: number;
}

export type ProbeOutcome =
  /** The vm-agent confirms a turn really is in flight. */
  | { kind: 'working' }
  /** The vm-agent is reachable and reports no turn in flight. */
  | { kind: 'not_working'; hostStatus: string | null }
  /** The vm-agent did not answer within the background budget. */
  | { kind: 'unreachable'; error: string };

export interface SessionActivityReconciliationHooks {
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
  /** Release durable messages queued behind the (now ended) turn. */
  nudgeDeliveries: (chatSessionId: string) => number;
  /** Re-arm the idle timer a wrongly-active session was never given. */
  armIdleCleanup: (chatSessionId: string) => void;
  recalculateAlarm: () => Promise<void>;
}

/**
 * Select working-state rows whose activity is older than the staleness bound
 * and that have no newer message progress. SQL only — no I/O.
 *
 * `activity_probe_attempts < maxAttempts` bounds the candidate set: a target
 * that never answers is terminalized as dead by `applyProbeOutcome` on its
 * final attempt, so no row can be re-probed forever.
 */
export function selectStaleActivityProbeCandidates(
  sql: SqlStorage,
  options: {
    thresholdMs: number;
    maxAttempts: number;
    maxCandidates: number;
    now?: number;
  }
): StaleActivityCandidate[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.thresholdMs;
  const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');

  return sql
    .exec(
      `SELECT ss.session_id AS acp_session_id,
              acp.chat_session_id AS chat_session_id,
              acp.workspace_id AS workspace_id,
              acp.node_id AS node_id,
              ss.activity_at AS activity_at,
              ss.activity_probe_attempts AS probe_attempts
       FROM session_state ss
       JOIN acp_sessions acp ON acp.id = ss.session_id
       WHERE ss.activity IN (${placeholders})
         AND ss.activity_at < ?
         AND COALESCE(ss.activity_probe_attempts, 0) < ?
         AND acp.workspace_id IS NOT NULL
         AND acp.node_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM chat_messages msg
           WHERE msg.session_id = acp.chat_session_id
             AND msg.created_at > ss.activity_at
         )
       ORDER BY ss.activity_at ASC
       LIMIT ?`,
      ...WORKING_ACTIVITIES,
      cutoff,
      options.maxAttempts,
      options.maxCandidates
    )
    .toArray()
    .flatMap((row) => {
      const acpSessionId = row.acp_session_id;
      const chatSessionId = row.chat_session_id;
      const workspaceId = row.workspace_id;
      const nodeId = row.node_id;
      if (
        typeof acpSessionId !== 'string' ||
        typeof chatSessionId !== 'string' ||
        typeof workspaceId !== 'string' ||
        typeof nodeId !== 'string'
      ) {
        // A malformed row must not abort the whole sweep (.claude/rules/50).
        log.warn('session_activity.candidate_row_skipped', { acpSessionId: String(acpSessionId) });
        return [];
      }
      return [
        {
          acpSessionId,
          chatSessionId,
          workspaceId,
          nodeId,
          activityAt: typeof row.activity_at === 'number' ? row.activity_at : 0,
          probeAttempts: typeof row.probe_attempts === 'number' ? row.probe_attempts : 0,
        },
      ];
    });
}

/** Classify a vm-agent agent-session listing for one ACP session. */
export function classifyProbeResponse(
  payload: unknown,
  acpSessionId: string
): { kind: 'working' } | { kind: 'not_working'; hostStatus: string | null } {
  const sessions =
    payload && typeof payload === 'object' && Array.isArray((payload as { sessions?: unknown }).sessions)
      ? ((payload as { sessions: unknown[] }).sessions as unknown[])
      : [];

  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.id !== acpSessionId) continue;
    const hostStatus = typeof record.hostStatus === 'string' ? record.hostStatus : null;
    if (hostStatus !== null && HOST_WORKING_STATUSES.has(hostStatus)) {
      return { kind: 'working' };
    }
    return { kind: 'not_working', hostStatus };
  }

  // The node does not know this session at all — it certainly is not
  // mid-prompt on our behalf.
  return { kind: 'not_working', hostStatus: null };
}

/**
 * Apply one probe result to the authoritative row.
 *
 * Returns true when the session left its working state (callers then fan the
 * transition out to the UI, delivery, and idle scheduling consumers).
 */
export function applyProbeOutcome(
  sql: SqlStorage,
  candidate: StaleActivityCandidate,
  outcome: ProbeOutcome,
  options: { maxAttempts: number; now?: number }
): boolean {
  const now = options.now ?? Date.now();

  if (outcome.kind === 'working') {
    // Positive proof of an in-flight turn. Refresh the staleness clock and
    // clear probe accounting so a long legitimate turn is never flipped.
    sql.exec(
      `UPDATE session_state
       SET activity_at = ?, activity_probe_attempts = 0, activity_probe_at = ?
       WHERE session_id = ?`,
      now,
      now,
      candidate.acpSessionId
    );
    return false;
  }

  if (outcome.kind === 'not_working') {
    return recordTurnEnd(sql, candidate.acpSessionId, {
      reason: 'probe_reconciled',
      source: 'probe',
      observedAt: candidate.activityAt,
      now,
    });
  }

  const attempts = candidate.probeAttempts + 1;
  if (attempts < options.maxAttempts) {
    sql.exec(
      `UPDATE session_state
       SET activity_probe_attempts = ?, activity_probe_at = ?
       WHERE session_id = ?`,
      attempts,
      now,
      candidate.acpSessionId
    );
    return false;
  }

  // Escape path: the target has not answered within its whole probe budget.
  // An unreachable agent is not prompting on our behalf, and leaving the row
  // in the candidate set forever is the zombie-candidate anti-pattern.
  log.warn('session_activity.probe_target_dead', {
    acpSessionId: candidate.acpSessionId,
    nodeId: candidate.nodeId,
    attempts,
  });
  return recordTurnEnd(sql, candidate.acpSessionId, {
    reason: 'dead',
    source: 'probe',
    observedAt: candidate.activityAt,
    now,
  });
}

/**
 * Fan a terminal activity transition out to every consumer of the state.
 *
 * Consolidated here so no consumer can be forgotten: the status UI reads the
 * broadcast, durable-message delivery reads the inbox nudge, and idle/sleep
 * scheduling reads the re-armed cleanup schedule.
 */
export async function publishTurnEnd(
  hooks: SessionActivityReconciliationHooks,
  chatSessionId: string
): Promise<void> {
  hooks.broadcastEvent(
    'session.activity',
    { sessionId: chatSessionId, activity: 'idle', promptStartedAt: null },
    chatSessionId
  );
  hooks.armIdleCleanup(chatSessionId);
  hooks.nudgeDeliveries(chatSessionId);
  await hooks.recalculateAlarm();
}

/** Resolve the workspace owner needed to authenticate the probe request. */
async function resolveProbeUserId(
  env: WorkerEnv,
  workspaceId: string,
  projectId: string | null
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    `SELECT user_id, project_id FROM workspaces WHERE id = ? LIMIT 1`
  )
    .bind(workspaceId)
    .first<{ user_id: string | null; project_id: string | null }>();

  if (!row?.user_id) return null;
  // Never probe across tenants: the workspace must belong to this DO's project.
  if (projectId && row.project_id && row.project_id !== projectId) {
    log.error('session_activity.workspace_project_mismatch', {
      workspaceId,
      expectedProjectId: projectId,
      actualProjectId: row.project_id,
      action: 'rejected',
    });
    return null;
  }
  return row.user_id;
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
  const candidates = selectStaleActivityProbeCandidates(sql, {
    thresholdMs: options.thresholdMs,
    maxAttempts,
    maxCandidates: sessionActivityProbeMaxCandidates(env),
  });
  if (candidates.length === 0) return { probed: 0, reconciled: 0 };

  const workerEnv = env as unknown as WorkerEnv;
  const requestTimeoutMs = sessionActivityProbeTimeoutMs(env);
  let reconciled = 0;

  for (const candidate of candidates) {
    let outcome: ProbeOutcome;
    try {
      const userId = await resolveProbeUserId(workerEnv, candidate.workspaceId, options.projectId);
      if (!userId) {
        outcome = { kind: 'unreachable', error: 'workspace_owner_unresolved' };
      } else {
        const payload = await listAgentSessionsOnNode(
          candidate.nodeId,
          candidate.workspaceId,
          workerEnv,
          userId,
          { requestTimeoutMs }
        );
        outcome = classifyProbeResponse(payload, candidate.acpSessionId);
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
    await publishTurnEnd(hooks, candidate.chatSessionId);
  }

  log.info('session_activity.probe_sweep_completed', {
    probed: candidates.length,
    reconciled,
  });
  return { probed: candidates.length, reconciled };
}
