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
  minReconciliationAlarmDelayMs,
  sessionActivityProbeMaxAttempts,
  sessionActivityProbeMaxCandidates,
  sessionActivityProbeTimeoutMs,
} from './reconciliation-thresholds';
import {
  parseActivityStaleThreshold,
  recordTurnEnd,
  WORKING_ACTIVITIES,
} from './session-state';
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
 * Select working-state rows that are stale and have no RECENT progress, then
 * claim them so a concurrent pass cannot probe the same row twice. SQL only —
 * no I/O.
 *
 * Two bounds keep the candidate set finite:
 * - `activity_probe_attempts < maxAttempts` — a target that never answers is
 *   terminalized as dead by `applyProbeOutcome` on its final attempt.
 * - `activity_probe_at` acts as a lease: a row claimed by an in-flight pass is
 *   skipped until the lease expires, so overlapping alarms do not double-probe.
 *
 * The progress guard deliberately measures message recency against the ROLLING
 * staleness cutoff, not against the frozen `activity_at`. Anchoring it to
 * `activity_at` means a single trailing message that lands after the last
 * successful activity report disqualifies the row FOREVER — it can never age
 * out, because `activity_at` never advances again once reporting dies. That
 * would recreate the permanent wedge this whole module exists to break.
 */
export function selectStaleActivityProbeCandidates(
  sql: SqlStorage,
  options: {
    thresholdMs: number;
    maxAttempts: number;
    maxCandidates: number;
    /** Lease window for a claimed candidate. Defaults to the staleness bound. */
    leaseMs?: number;
    now?: number;
  }
): StaleActivityCandidate[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.thresholdMs;
  const leaseCutoff = now - (options.leaseMs ?? options.thresholdMs);
  const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');

  const candidates = sql
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
         AND (ss.activity_probe_at IS NULL OR ss.activity_probe_at <= ?)
         AND acp.workspace_id IS NOT NULL
         AND acp.node_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM chat_messages msg
           WHERE msg.session_id = acp.chat_session_id
             AND msg.created_at > ?
         )
       ORDER BY ss.activity_at ASC
       LIMIT ?`,
      ...WORKING_ACTIVITIES,
      cutoff,
      options.maxAttempts,
      leaseCutoff,
      cutoff,
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

  // Claim the batch in the same synchronous block as the read, so a second
  // alarm firing while this pass is awaiting the network cannot re-select the
  // same rows (.claude/rules/45 — there is no `await` between read and claim,
  // so this pair cannot be interleaved).
  for (const candidate of candidates) {
    sql.exec(
      'UPDATE session_state SET activity_probe_at = ? WHERE session_id = ?',
      now,
      candidate.acpSessionId
    );
  }

  return candidates;
}

/**
 * When the next stale-activity probe becomes due.
 *
 * Without this, conversation-mode sessions would depend on some unrelated
 * alarm source happening to fire — the task-mode reconciliation query is
 * task-scoped and contributes nothing for them, so the probe's own staleness
 * bound would not actually be honoured by the scheduler.
 */
export function computeSessionActivityProbeAlarmTime(
  sql: SqlStorage,
  env: DOEnv,
  now = Date.now()
): number | null {
  const thresholdMs = parseActivityStaleThreshold(
    (env as unknown as Record<string, string | undefined>).SESSION_ACTIVITY_STALE_THRESHOLD_MS
  );
  const maxAttempts = sessionActivityProbeMaxAttempts(env);
  const minDelayMs = minReconciliationAlarmDelayMs(env);
  // Must mirror `probeStaleSessionActivity`'s lease derivation exactly, or the
  // scheduler and the selector disagree about when a claimed row is due again.
  const leaseMs = sessionActivityProbeMaxCandidates(env) * sessionActivityProbeTimeoutMs(env);
  const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');

  // A row is next selectable at the LATER of (a) its staleness bound and (b) its
  // outstanding probe lease expiring. Scanning only (a) reports a claimed-but-
  // unresolved candidate as due *now* on every tick — the SELECT then correctly
  // returns nothing (the lease holds), but the alarm has already re-armed to
  // `now`, so the whole handler busy-loops for the entire reconciliation episode
  // with no log signal. See `.claude/rules/47`.
  const row = sql
    .exec(
      `SELECT MIN(MAX(ss.activity_at + ?, COALESCE(ss.activity_probe_at, 0) + ?)) AS earliest_due
       FROM session_state ss
       JOIN acp_sessions acp ON acp.id = ss.session_id
       WHERE ss.activity IN (${placeholders})
         AND COALESCE(ss.activity_probe_attempts, 0) < ?
         AND acp.workspace_id IS NOT NULL
         AND acp.node_id IS NOT NULL`,
      thresholdMs,
      leaseMs,
      ...WORKING_ACTIVITIES,
      maxAttempts
    )
    .toArray()[0];

  const earliestDue = row?.earliest_due;
  if (typeof earliestDue !== 'number') return null;
  // Floor the alarm into the future even when a candidate is already overdue,
  // matching `computeReconciliationAlarmTime`'s `minAlarmDelayMs` clamp. Belt
  // and braces against any future predicate drift reintroducing the tight loop.
  return Math.max(earliestDue, now + minDelayMs);
}

/**
 * Classify a vm-agent agent-session listing for one ACP session.
 *
 * A malformed payload is not evidence of anything. Only a well-formed listing
 * may end a turn; anything else degrades to `unreachable` so it inherits the
 * bounded-retry path instead of terminalizing a possibly live turn on the
 * strength of a response we could not parse.
 */
export function classifyProbeResponse(payload: unknown, acpSessionId: string): ProbeOutcome {
  const rawSessions =
    payload && typeof payload === 'object'
      ? (payload as { sessions?: unknown }).sessions
      : undefined;
  if (!Array.isArray(rawSessions)) {
    return { kind: 'unreachable', error: 'malformed_agent_sessions_response' };
  }
  const sessions = rawSessions as unknown[];

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
    //
    // Same compare-and-set as `recordTurnEnd`: the row may have legitimately
    // left its working state while this probe was in flight (a real VM `idle`
    // report, or a concurrent probe's `not_working` result winning the race).
    // Bumping `activity_at` unconditionally would push the idle clock that
    // `session-sleep.ts` reads forward on an already-idle session, delaying
    // sleep — a regression in one of the three consumers this fixes.
    const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');
    sql.exec(
      `UPDATE session_state
       SET activity_at = ?, activity_probe_attempts = 0, activity_probe_at = ?
       WHERE session_id = ?
         AND activity IN (${placeholders})
         AND activity_at <= ?`,
      now,
      now,
      candidate.acpSessionId,
      ...WORKING_ACTIVITIES,
      candidate.activityAt
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
    // Same compare-and-set discipline as the two branches above. Without it a
    // stale `unreachable` outcome — one whose probe was still in flight while the
    // turn ended and a brand-new prompt epoch began — would charge an attempt
    // against that new epoch, which resets `activity_probe_attempts` to 0 on
    // every authoritative write. `recordTurnEnd`'s own CAS still stops the new
    // epoch being terminalized, so the blast radius is only a silently reduced
    // retry budget; the fix keeps the module's CAS discipline uniform.
    // Named `placeholders` deliberately: `scripts/quality/ast-checks.ts`
    // allowlists that exact identifier for `.map(() => '?').join(', ')` IN-clause
    // expansion, which is what this is (over a compile-time const array).
    const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');
    sql.exec(
      `UPDATE session_state
       SET activity_probe_attempts = ?, activity_probe_at = ?
       WHERE session_id = ?
         AND activity IN (${placeholders})
         AND activity_at <= ?`,
      attempts,
      now,
      candidate.acpSessionId,
      ...WORKING_ACTIVITIES,
      candidate.activityAt
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
  // Never probe across tenants. Fail CLOSED (.claude/rules/51): an absent
  // project on either side leaves ownership ambiguous, and an ambiguous
  // identity must reject rather than fall through to the permissive path —
  // this probe mints a node-management token scoped to the workspace owner.
  if (!projectId || row.project_id !== projectId) {
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
