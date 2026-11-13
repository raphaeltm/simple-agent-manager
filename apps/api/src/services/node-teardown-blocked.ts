/**
 * Visible blocked state for a managed node whose cloud VM cannot be torn down by SAM.
 *
 * `cleanup_blocked_reason` is what operators read (the `node_destroying_too_long` anomaly, the
 * admin node view); `alertNodeCleanupBlocked` is the existing rate-limited operator alert. A node
 * that can never be torn down automatically must surface here rather than retry silently
 * (`apps/api/.claude/rules/71`, rule 47).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveCleanupConfig } from '../scheduled/node-cleanup/config';
import type { NodeTeardownBlockedError } from './node-teardown-authority';
import { persistError } from './observability';
import type { NodeRow } from './strict-node-deletion-shared';

export interface BlockedNodeAlertInput {
  nodeId: string;
  userId: string;
  status: string;
  blockedSince: string | null;
  reasons: string[];
  provider: string | null;
  providerInstanceId: string | null;
  recoveryType: string;
}

/**
 * Raise the operator alert for a node whose VM may still exist at the provider. Claims
 * `cleanup_blocked_alerted_at` first, so concurrent callers and later sweeps alert at most once per
 * `intervalMs` for the same blocked episode.
 */
export async function alertNodeCleanupBlocked(
  env: Env,
  input: BlockedNodeAlertInput,
  now: Date,
  intervalMs: number
): Promise<void> {
  const cutoff = new Date(now.getTime() - intervalMs).toISOString();
  const claimed = await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_blocked_alerted_at=?
    WHERE id=? AND user_id=? AND status=? AND cleanup_blocked_since IS NOT NULL
      AND (cleanup_blocked_alerted_at IS NULL OR cleanup_blocked_alerted_at <= ?)`
  )
    .bind(now.toISOString(), input.nodeId, input.userId, input.status, cutoff)
    .run();
  if (!claimed.meta.changes) return;
  const context = {
    recoveryType: input.recoveryType,
    nodeId: input.nodeId,
    userId: input.userId,
    blockedSince: input.blockedSince,
    reasons: input.reasons,
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
  };
  log.error('node_cleanup.stranded_node_ownership_blocked', context);
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'error',
      nodeId: input.nodeId,
      userId: input.userId,
      message: `VM may still exist at provider: ${input.provider ?? 'unknown'} ${input.providerInstanceId ?? 'unknown'}; cleanup requires ownership/operator resolution`,
      context,
    },
    env
  );
}

/**
 * Record a named teardown refusal on the node and alert. Fenced on the exact runtime incarnation
 * the teardown attempted, so a replaced runtime never inherits the verdict. Never throws: the
 * original teardown error stays the one the caller sees.
 */
export async function recordNodeTeardownBlocked(
  env: Env,
  node: NodeRow,
  error: NodeTeardownBlockedError
): Promise<void> {
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    await env.DATABASE.prepare(
      `UPDATE nodes SET cleanup_blocked_since=COALESCE(cleanup_blocked_since, ?),
        cleanup_blocked_reason=?
      WHERE id=? AND user_id=? AND status IN ('stopped','destroying')
        AND provider_instance_id IS ? AND runtime_incarnation_id IS ?`
    )
      .bind(
        nowIso,
        error.reason,
        node.id,
        node.userId,
        node.providerInstanceId,
        node.runtimeIncarnationId
      )
      .run();
    const current = await env.DATABASE.prepare(
      'SELECT status, cleanup_blocked_since FROM nodes WHERE id=? AND user_id=?'
    )
      .bind(node.id, node.userId)
      .first<{ status: string; cleanup_blocked_since: string | null }>();
    if (!current) return;
    await alertNodeCleanupBlocked(
      env,
      {
        nodeId: node.id,
        userId: node.userId,
        status: current.status,
        blockedSince: current.cleanup_blocked_since,
        reasons: [error.reason],
        provider: node.cloudProvider,
        providerInstanceId: node.providerInstanceId,
        recoveryType: 'node_teardown_blocked',
      },
      now,
      resolveCleanupConfig(env).ownershipAlertIntervalMs
    );
  } catch (recordError) {
    log.error('node_teardown.blocked_record_failed', {
      nodeId: node.id,
      reason: error.reason,
      error: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
}
