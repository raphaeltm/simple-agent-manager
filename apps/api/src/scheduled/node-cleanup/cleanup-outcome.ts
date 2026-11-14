/**
 * How a cleanup-sweep destroy attempt is recorded: the decision log row, the observability row,
 * and the failure path (claim release, refusal diagnosis, backoff). Split from `shared.ts`.
 */
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
): Promise<void> {
  try {
    await releaseNodeCleanupClaim(env, node, nowIso, backoffUntil);
    log.warn('node_cleanup.candidate_backed_off', { nodeId: node.id, backoffUntil });
  } catch (error) {
    log.error('node_cleanup.candidate_claim_release_failed', {
      nodeId: node.id,
      error: errorMessage(error),
    });
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
  await releaseCleanupClaimAfterFailure(env, node, nowIso, backoffUntil);
  // Release clears claim bookkeeping; a failed destructive guard starts/retains
  // its own refusal episode independently of heartbeat updated_at writes.
  const refusal = await diagnoseCleanupRefusal(
    env,
    node,
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
      .bind(refusal.cleanup_blocked_since, node.id, node.user_id, node.status)
      .run();
    await recordCleanupRefusal(
      env,
      node,
      nowIso,
      options.failureBackoffMs,
      refusal,
      options.blockedRetirementMs,
      options.refusalWarnAfterMs
    );
  }
  if (error instanceof NodeTeardownBlockedError) {
    // A named teardown refusal needs a person (reconnect the account, or remove the VM by hand),
    // so it cannot clear itself. The refusal backoff above shrinks to zero once the blocked
    // deadline passes, which would re-read the provider every tick forever (rule 47). Keep the
    // full failure backoff instead.
    await env.DATABASE.prepare(
      `UPDATE nodes SET cleanup_backoff_until=?
      WHERE id=? AND user_id=? AND status IN ('stopped','destroying')
        AND (cleanup_backoff_until IS NULL OR cleanup_backoff_until < ?)`
    )
      .bind(backoffUntil, node.id, node.user_id, backoffUntil)
      .run();
  }
  await persistCleanupFailure(env, node, options, error, backoffUntil);
}
