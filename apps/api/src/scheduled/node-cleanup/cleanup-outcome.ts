/**
 * How a cleanup-sweep destroy attempt is recorded: the decision log row, the observability row,
 * and the failure path (claim release, refusal diagnosis, backoff). Split from `shared.ts`.
 */
import { DEFAULT_NODE_CLEANUP_BLOCKED_RETIREMENT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  type NodeLifecycleDecision,
  recordNodeLifecycleDecision,
} from '../../services/node-lifecycle-decisions';
import { NodeTeardownBlockedError } from '../../services/node-teardown-authority';
import { persistError } from '../../services/observability';
import { resolveOperationsTelemetrySetting } from '../../services/operations-telemetry-settings';
import { releaseNodeCleanupClaim } from './cleanup-claim';
import { diagnoseCleanupRefusal, recordCleanupRefusal } from './cleanup-refusal';

export type CleanupContext = Record<string, string | number | null | undefined>;

export type CleanupNode = {
  id: string;
  user_id: string;
  status: string;
  cleanup_blocked_since?: string | null;
};

/** The parts of a destroy attempt's options that decide how its outcome is recorded. */
export interface CleanupOutcomeOptions {
  failureLogEvent: string;
  successMessage: string;
  failureMessagePrefix: string;
  recoveryType: string;
  failureRecoveryType: string;
  level?: 'info' | 'warn';
  failureBackoffMs: number;
  blockedRetirementMs?: number;
  refusalWarnAfterMs?: number;
  workspaceIdleThresholdIso?: string;
  context: CleanupContext;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `backoff` is the sweep's own retry clock, not a reason the node stays alive; leaving it in
 * would make every second refusal look like a new decision and defeat the dedupe window.
 */
export function refusalDecisionReason(reasons: readonly string[]): string {
  const causes = reasons.filter((reason) => reason !== 'backoff');
  return causes.length ? causes.join(',') : reasons.length ? 'backoff' : 'cleanup_claim_refused';
}

/** Best-effort decision log row. Repeating skips are deduped so a stuck node logs once per window. */
export async function recordSweepDecision(
  env: Env,
  node: CleanupNode,
  options: CleanupOutcomeOptions,
  decision: NodeLifecycleDecision,
  reason: string | null,
  repeating = false
): Promise<void> {
  await recordNodeLifecycleDecision(env.DATABASE, {
    nodeId: node.id,
    source: 'cleanup_sweep',
    decision,
    reason,
    detail: { phase: options.recoveryType, nodeStatus: node.status },
    dedupeWindowMs: repeating
      ? await resolveOperationsTelemetrySetting(env, 'nodeDecisionDedupeWindowMs')
      : undefined,
  });
}

export async function persistCleanupSuccess(
  env: Env,
  node: CleanupNode,
  options: CleanupOutcomeOptions
): Promise<void> {
  try {
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: options.level ?? 'warn',
        message: options.successMessage,
        context: {
          recoveryType: options.recoveryType,
          nodeId: node.id,
          ...options.context,
        },
        userId: node.user_id,
        nodeId: node.id,
      },
      env
    );
  } catch (error) {
    log.error('node_cleanup.success_observability_write_failed', {
      nodeId: node.id,
      error: errorMessage(error),
    });
  }
}

async function releaseCleanupClaimAfterFailure(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  backoffUntil: string
): Promise<string | null> {
  try {
    const status = await releaseNodeCleanupClaim(env, node, nowIso, backoffUntil);
    log.warn('node_cleanup.candidate_backed_off', {
      nodeId: node.id,
      backoffUntil,
      ...(status && status !== node.status ? { releasedStatus: status } : {}),
    });
    return status;
  } catch (error) {
    log.error('node_cleanup.candidate_claim_release_failed', {
      nodeId: node.id,
      error: errorMessage(error),
    });
    return null;
  }
}

async function persistCleanupFailure(
  env: Env,
  node: CleanupNode,
  options: CleanupOutcomeOptions,
  error: unknown,
  backoffUntil: string
): Promise<void> {
  try {
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: `${options.failureMessagePrefix}: ${errorMessage(error)}`,
        stack: error instanceof Error ? error.stack : undefined,
        context: {
          recoveryType: options.failureRecoveryType,
          nodeId: node.id,
          backoffUntil,
          ...options.context,
        },
        userId: node.user_id,
        nodeId: node.id,
      },
      env
    );
  } catch (persistErrorValue) {
    log.error('node_cleanup.failure_observability_write_failed', {
      nodeId: node.id,
      error: errorMessage(persistErrorValue),
    });
  }
}

/**
 * When a failed destroy attempt may run again.
 *
 * - A named teardown refusal needs a person (reconnect the account, attest, or remove the VM by
 *   hand) and cannot clear itself: the full failure backoff.
 * - A `stopped`/`destroying` row has a stranded-node deadline (`sweepStrandedNodes`); the failure
 *   backoff never postpones a deadline that is still ahead, and applies in full once it has
 *   passed, so a row that keeps failing is never retried on every tick.
 * - Any other row has no deadline: the full failure backoff.
 */
function failureRetryAt(
  error: unknown,
  node: CleanupNode,
  nowIso: string,
  backoffUntil: string,
  refusal: { cleanup_blocked_since: string | null } | null,
  options: CleanupOutcomeOptions
): string {
  if (error instanceof NodeTeardownBlockedError) return backoffUntil;
  if (!['stopped', 'destroying'].includes(node.status)) return backoffUntil;
  const blockedSince = Date.parse(refusal?.cleanup_blocked_since ?? nowIso);
  const deadline =
    blockedSince + (options.blockedRetirementMs ?? DEFAULT_NODE_CLEANUP_BLOCKED_RETIREMENT_MS);
  const now = Date.parse(nowIso);
  return deadline > now && deadline < Date.parse(backoffUntil)
    ? new Date(deadline).toISOString()
    : backoffUntil;
}

export async function handleCleanupFailure(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  options: CleanupOutcomeOptions,
  error: unknown
): Promise<void> {
  log.error(options.failureLogEvent, {
    nodeId: node.id,
    userId: node.user_id,
    error: errorMessage(error),
  });

  const backoffUntil = new Date(
    new Date(nowIso).getTime() + options.failureBackoffMs
  ).toISOString();
  // The release may hand an uncertain providerless row to the destroying state machine
  // (`releaseNodeCleanupClaim`); every later write keys on the status the row now has.
  const releasedStatus = await releaseCleanupClaimAfterFailure(env, node, nowIso, backoffUntil);
  const current: CleanupNode = releasedStatus ? { ...node, status: releasedStatus } : node;
  // Release clears claim bookkeeping; a failed destructive guard starts/retains
  // its own refusal episode independently of heartbeat updated_at writes.
  const refusal = await diagnoseCleanupRefusal(
    env,
    current,
    nowIso,
    options.workspaceIdleThresholdIso ?? nowIso
  );
  if (refusal) {
    refusal.cleanup_blocked_since = node.cleanup_blocked_since ?? nowIso;
    // A named teardown refusal is the actual cause; the re-diagnosis only sees its aftermath
    // (the backoff just written, or nothing, which it would label a lost race).
    if (error instanceof NodeTeardownBlockedError) {
      refusal.reasons = [
        error.reason,
        ...refusal.reasons.filter((reason) => reason !== 'lost_race'),
      ];
    }
    await env.DATABASE.prepare(
      `UPDATE nodes SET cleanup_blocked_since=?
      WHERE id=? AND user_id=? AND status=? AND status IN ('stopped','destroying')`
    )
      .bind(refusal.cleanup_blocked_since, current.id, current.user_id, current.status)
      .run();
    await recordCleanupRefusal(
      env,
      current,
      nowIso,
      options.failureBackoffMs,
      refusal,
      options.blockedRetirementMs,
      options.refusalWarnAfterMs
    );
  }
  // The refusal backoff above is a re-check cadence for refusals that made no attempt: it is
  // capped at the refusal warn interval (5 min by default) and drops to zero once the
  // stranded-node deadline has passed. A failed attempt already spent provider I/O and wrote an
  // error row, so it waits out its failure backoff (rule 47); `failureRetryAt` keeps only the
  // deadline cap. Production retried two max-lifetime nodes every 5-10 minutes for days while
  // logging a one-hour backoff (idea 01M7GVRC956Q8JMGCRP1PQ4R5B).
  const retryAt = failureRetryAt(error, current, nowIso, backoffUntil, refusal, options);
  // Outside a named refusal, a pending provider deletion keeps no backoff: its confirm phase owns
  // it (`releaseNodeCleanupClaim`). The write only ever moves the retry later.
  await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_backoff_until=?
    WHERE id=? AND user_id=? AND status=?
      ${error instanceof NodeTeardownBlockedError ? '' : 'AND NOT (provider_deletion_requested_at IS NOT NULL AND runtime_termination_confirmed_at IS NULL)'}
      AND (cleanup_backoff_until IS NULL OR cleanup_backoff_until < ?)`
  )
    .bind(retryAt, current.id, current.user_id, current.status, retryAt)
    .run();
  await persistCleanupFailure(env, node, options, error, backoffUntil);
}
