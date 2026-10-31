/** Deadline backstop independent of the ordinary handoff selector's safety filters. */
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { prepareBoundedStrandedRetirement } from '../../services/bounded-stranded-retirement-authority';
import { persistError } from '../../services/observability';
import { preparePreservedVmRetirement } from '../../services/preserved-vm-retirement';
import { repairRetiredVmSleepSnapshots } from '../../services/retired-vm-sleep-repair';
import {
  type CleanupRefusal,
  type CleanupRefusalNode,
  diagnoseCleanupRefusal,
  recordCleanupRefusal,
} from './cleanup-refusal';
import type { CleanupConfig } from './config';
import {
  type CleanupDb,
  destroyNodeForCleanup,
  getNodeWorkspaceIdleThresholdIso,
  type NodeCleanupResult,
} from './shared';
import { repairStrandedRetirementNotices } from './stranded-retirement-notices';
import { type RetirementSource, verifyRetirementSource } from './stranded-source-preservation';

async function alertBlockedNode(
  env: Env,
  node: CleanupRefusalNode,
  refusal: CleanupRefusal,
  now: Date,
  intervalMs: number
): Promise<void> {
  const cutoff = new Date(now.getTime() - intervalMs).toISOString();
  const claimed = await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_blocked_alerted_at=?
    WHERE id=? AND user_id=? AND status=? AND cleanup_blocked_since IS NOT NULL
      AND (cleanup_blocked_alerted_at IS NULL OR cleanup_blocked_alerted_at <= ?)`
  )
    .bind(now.toISOString(), node.id, node.user_id, node.status, cutoff)
    .run();
  if (!claimed.meta.changes) return;
  const context = {
    recoveryType: 'bounded_stranded_node_ownership_blocked',
    nodeId: node.id,
    userId: node.user_id,
    blockedSince: refusal.cleanup_blocked_since,
    reasons: refusal.reasons,
    provider: refusal.cloud_provider,
    providerInstanceId: refusal.provider_instance_id,
  };
  log.error('node_cleanup.stranded_node_ownership_blocked', context);
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'error',
      nodeId: node.id,
      userId: node.user_id,
      message: `VM may still exist at provider: ${refusal.cloud_provider ?? 'unknown'} ${refusal.provider_instance_id ?? 'unknown'}; cleanup requires ownership/operator resolution`,
      context,
    },
    env
  );
}

type UnpreservedSource = RetirementSource;

/** Bounded artifact checks keep all R2 objects and keys; a failed check never deletes them. */
async function findUnpreservedSources(
  env: Env,
  node: CleanupRefusalNode,
  refusal: CleanupRefusal,
  limit: number
): Promise<UnpreservedSource[]> {
  const inventory = await env.DATABASE.prepare(
    `SELECT json_group_array(json_object(
      'workspaceId',workspaceId,'snapshotId',snapshotId,'projectId',projectId,'chatSessionId',chatSessionId,
      'eviction_generation',eviction_generation,'runtime_deletion_confirmed_at',runtime_deletion_confirmed_at,
      'runtime_deletion_proof',runtime_deletion_proof,'snapshotGeneration',snapshotGeneration)) AS sources FROM (SELECT w.id AS workspaceId, s.id AS snapshotId,
      w.project_id AS projectId, w.chat_session_id AS chatSessionId, w.eviction_generation,
      w.runtime_deletion_confirmed_at, w.runtime_deletion_proof, s.snapshot_generation AS snapshotGeneration
    FROM workspaces w LEFT JOIN session_snapshots s ON s.workspace_id=w.id AND s.node_id=w.node_id
    WHERE w.node_id=? AND w.user_id=?
    UNION ALL SELECT s.workspace_id, s.id, s.project_id, s.chat_session_id, NULL, NULL, NULL, s.snapshot_generation
      FROM session_snapshots s WHERE s.node_id=? AND s.user_id=?
      AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=s.workspace_id AND w.node_id=s.node_id)
    )`
  )
    .bind(node.id, node.user_id, node.id, node.user_id)
    .first<{ sources: string }>();
  const rows = v.parse(
    v.array(
      v.object({
        workspaceId: v.nullable(v.string()),
        snapshotId: v.nullable(v.string()),
        snapshotGeneration: v.nullable(v.string()),
        projectId: v.nullable(v.string()),
        chatSessionId: v.nullable(v.string()),
        eviction_generation: v.nullable(v.string()),
        runtime_deletion_confirmed_at: v.nullable(v.string()),
        runtime_deletion_proof: v.nullable(v.string()),
      })
    ),
    JSON.parse(inventory?.sources ?? '[]') as unknown
  );

  const lost: UnpreservedSource[] = [];
  let checksRemaining = limit;
  for (const row of rows) {
    const source: RetirementSource = {
      workspaceId: row.workspaceId,
      snapshotId: row.snapshotId,
      snapshotGeneration: row.snapshotGeneration,
      workspaceGeneration: row.eviction_generation,
      projectId: row.projectId,
      chatSessionId: row.chatSessionId,
      runtimeIncarnationId: refusal.runtime_incarnation_id,
      providerInstanceId: refusal.provider_instance_id,
    };
    let preserved = false;
    source.preservationPending = checksRemaining-- <= 0;
    if (!source.preservationPending) {
      try {
        preserved = await verifyRetirementSource(env, node, source);
      } catch {
        source.preservationPending = true;
      }
    }
    if (
      !preserved &&
      (!row.runtime_deletion_confirmed_at || !row.runtime_deletion_proof || row.snapshotId)
    )
      lost.push(source);
  }
  return lost;
}

export async function sweepStrandedNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const nowIso = now.toISOString();
  const due = new Date(now.getTime() - config.blockedRetirementMs).toISOString();
  const idleThreshold = getNodeWorkspaceIdleThresholdIso(now, config);
  const sweepDeadline = Date.now() + config.stoppedHandoffSweepBudgetMs;
  // Ordinary selectors deliberately omit the artifact guard. Refusal diagnostics and
  // this independent page guarantee a bounded outcome, including missing provenance.
  const candidates = await env.DATABASE.prepare(
    `SELECT id,user_id,status,cleanup_blocked_since FROM nodes
    WHERE node_class='managed' AND runtime='vm' AND status IN ('stopped','destroying')
      AND (cleanup_blocked_since IS NULL OR cleanup_backoff_until IS NULL OR cleanup_backoff_until <= ?
        OR (cleanup_blocked_since <= ? AND (cleanup_blocked_alerted_at IS NULL OR cleanup_blocked_alerted_at <= ?)))
    ORDER BY CASE WHEN cleanup_blocked_since <= ? THEN 0 ELSE 1 END,
      COALESCE(cleanup_backoff_until, cleanup_blocked_since, created_at), id LIMIT ?`
  )
    .bind(
      nowIso,
      due,
      new Date(now.getTime() - config.ownershipAlertIntervalMs).toISOString(),
      due,
      config.nodeSweepLimit
    )
    .all<CleanupRefusalNode>();
  for (const node of candidates.results) {
    if (Date.now() >= sweepDeadline) break;
    try {
      const refusal = await diagnoseCleanupRefusal(env, node, nowIso, idleThreshold);
      if (!refusal) continue;
      // A claim failure may already have installed a short backoff this tick.
      const firstBlocked = refusal.cleanup_blocked_since ?? nowIso;
      if (!refusal.cleanup_blocked_since) {
        await recordCleanupRefusal(
          env,
          node,
          nowIso,
          config.failureBackoffMs,
          refusal,
          config.blockedRetirementMs,
          config.refusalWarnAfterMs
        );
        continue;
      }
      if (firstBlocked > due) continue;
      const authority = await prepareBoundedStrandedRetirement(
        env,
        node.id,
        node.user_id,
        nowIso,
        config.blockedRetirementMs,
        idleThreshold
      );
      if (!authority || refusal.reasons.includes('provenance')) {
        await alertBlockedNode(env, node, refusal, now, config.ownershipAlertIntervalMs);
        await env.DATABASE.prepare(
          'UPDATE nodes SET cleanup_backoff_until=? WHERE id=? AND user_id=? AND status=?'
        )
          .bind(
            new Date(now.getTime() + config.refusalWarnAfterMs).toISOString(),
            node.id,
            node.user_id,
            node.status
          )
          .run();
        continue;
      }
      // Preservation failures cannot silently restart the deadline. Preserve every
      // existing artifact, attempt the normal bounded repair, then use distinct authority.
      try {
        await repairRetiredVmSleepSnapshots(env, node.id, node.user_id);
        await preparePreservedVmRetirement(env, node.id, node.user_id, {
          remainingSources: config.workspaceSweepLimit,
        });
      } catch (error) {
        log.warn('node_cleanup.stranded_preservation_attempt_failed', {
          nodeId: node.id,
          error: String(error),
        });
      }
      const lost = await findUnpreservedSources(env, node, refusal, config.workspaceSweepLimit);
      const manifest = await env.DATABASE.prepare(
        `UPDATE nodes SET cleanup_retirement_sources_json=? WHERE id=? AND user_id=? AND status=? AND runtime_incarnation_id IS ? AND provider_instance_id IS ?`
      )
        .bind(
          JSON.stringify(lost),
          node.id,
          node.user_id,
          node.status,
          authority.runtimeIncarnationId,
          authority.providerInstanceId
        )
        .run();
      if (!manifest.meta.changes) continue;
      // An expired deadline overrides retry scheduling, never a safety or ownership fence.
      await env.DATABASE.prepare(
        'UPDATE nodes SET cleanup_backoff_until=NULL WHERE id=? AND user_id=? AND status=?'
      )
        .bind(node.id, node.user_id, node.status)
        .run();
      const destroyed = await destroyNodeForCleanup(db, env, nowIso, node, {
        boundedStrandedRetirement: authority,
        requireWorkspaceIdle: false,
        workspaceIdleThresholdIso: idleThreshold,
        requestDeadlineMs: Math.min(
          sweepDeadline,
          Date.now() + config.stoppedHandoffRequestTimeoutMs
        ),
        logEvent: 'node_cleanup.stranded_node_force_retiring',
        failureLogEvent: 'node_cleanup.stranded_node_force_retirement_failed',
        successMessage: 'Automatically retired stranded VM after cleanup refusal deadline',
        failureMessagePrefix: 'Automatic deadline retirement failed',
        recoveryType: 'bounded_stranded_node_retirement',
        failureRecoveryType: 'bounded_stranded_node_retirement_failed',
        failureBackoffMs: config.failureBackoffMs,
        context: {
          blockedSince: firstBlocked,
          provenance: authority.provenance,
          refusalReasons: refusal.reasons.join(', '),
          unpreservedSources: JSON.stringify(lost),
        },
      });
      if (destroyed === 'destroyed') {
        result.lifetimeDestroyed++;
        log.warn('node_cleanup.stranded_node_force_retired', {
          nodeId: node.id,
          userId: node.user_id,
          blockedSince: firstBlocked,
          unpreservedSources: lost,
        });
      } else if (destroyed === 'failed') {
        result.errors++;
        // A provider ownership refusal must retain the original deadline, even
        // though the ordinary release helper intentionally clears its claim clock.
        await env.DATABASE.prepare(
          `UPDATE nodes SET cleanup_blocked_since=COALESCE(cleanup_blocked_since,?), cleanup_blocked_reason=? WHERE id=? AND user_id=? AND status IN ('stopped','destroying')`
        )
          .bind(
            firstBlocked,
            'strict_provider_ownership_or_deletion_failure',
            node.id,
            node.user_id
          )
          .run();
        await alertBlockedNode(env, node, refusal, now, config.ownershipAlertIntervalMs);
      }
    } catch (error) {
      result.errors++;
      log.error('node_cleanup.stranded_node_failed', { nodeId: node.id, error: String(error) });
    }
  }
  // One independently bounded notice page per cron. A ProjectData/D1 notice
  // outage must not prevent retirement of a billed runtime.
  try {
    await repairStrandedRetirementNotices(env, config.nodeSweepLimit, config.workspaceSweepLimit);
  } catch (error) {
    result.errors++;
    log.error('node_cleanup.stranded_notice_repair_failed', { error: String(error) });
  }
}
