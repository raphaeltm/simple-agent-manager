/**
 * Provider-existence reconciliation for running deployment nodes (idea 01M81Z9P6QFX4M9Q83K2XKGZVR).
 *
 * A deployment VM deleted at its provider behind SAM's back (provider console, provider-side
 * expiry) used to keep a `running` node row forever. Its app-route A records then looked live to
 * every SAM path (`judgeAppRouteRecord` reads node status) while pointing at a released IP the
 * provider can hand to someone else: a subdomain-takeover risk on hosted SAM and on self-host
 * installs alike. Nothing else moves a running deployment node out of `running`: the generic node
 * reconcilers filter to workspace nodes, and `runDeploymentNodeCleanup` only claims nodes already
 * being torn down. This is the reverse of provider orphan reconciliation (a VM with no row): a row
 * with no VM.
 *
 * Each sweep probes running managed deployment VMs through `probeDeploymentNodeInstance`, which
 * returns "absent" only for a definitive provider not-found through the node's pinned placement
 * credential. A node is released only after two absent verdicts at least
 * `deploymentNodeExistence.confirmIntervalSeconds` apart, for the same instance; a present
 * verdict in between clears the first one, and an inconclusive one leaves it. Release claims the
 * node and its environments atomically (`claimAbsentNodeRelease`) and then runs the ordinary
 * deployment teardown, `cleanupDeploymentNode` -> `deleteNodeResourcesStrict`, which deletes the
 * node's app-route records (`releaseNodeAppRouteDnsRecords`), confirms the provider deletion
 * (idempotent on a VM that is already gone) and retires the row. If that teardown fails the node
 * is already `destroying`, so the deployment-node cleanup sweep retries it and the app-route DNS
 * sweep judges its records released. There is no second cleanup path.
 *
 * Every verdict is recorded in `node_lifecycle_decisions` (source `provider_existence`, reason =
 * the exact verdict), so verdicts can be aggregated per reason later.
 *
 * Throughput at the defaults (`deploymentNodeExistence.*`: at most 100 lookups and 20 s per sweep,
 * 5 s per lookup, a node re-checked every 15 min, confirmation after 10 min) on the 5-minute cron:
 * a lookup is one provider GET (Hetzner ~0.2 s; GCP up to one GET per configured zone plus one
 * list, ~1 s), so a sweep makes 20-100 lookups, 240-1,200 an hour. 60-300 deployment nodes keep
 * their 15-minute cadence; then detection-to-release worst case is 15 + 10 + 5 = ~30 min. At an
 * outer limit of 10,000 deployment nodes a full pass takes 8-42 hours; nodes with a pending
 * absence are probed first, so release follows one pass + 10 min + one tick after the VM
 * disappears (raise `maxProbesPerSweep` / `sweepBudgetMs` for such an install). If every lookup
 * times out a sweep reaches 4 nodes; each probed node is stamped before its lookup, so the next
 * sweep moves on. Provider rate limits: Hetzner allows 3,600 requests an hour per project; this
 * adds at most 1,200, and a 429 stops lookups to that provider for the rest of the sweep. One
 * release can overrun the sweep budget by its teardown timeout. The sweep runs out of band, in
 * its own `waitUntil`, after the cron's foreground chain; the selection uses the partial index
 * `idx_nodes_deployment_existence_due`, so it reads running deployment nodes only.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings';
import {
  DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS,
  type DeploymentNodeExistenceSettingName,
} from './admin-settings-deployment-node-existence-definitions';
import {
  probeDeploymentNodeInstance,
  type ProviderExistenceInconclusiveReason,
} from './deployment-node-provider-existence-probe';
import {
  recordExistenceDecision,
  releaseConfirmedAbsentNode,
  type ReleaseOutcome,
  sameIncarnationSql,
} from './deployment-node-provider-existence-release';
import type { NodeRow } from './strict-node-deletion-shared';

/**
 * A first not-found older than this many confirmation intervals cannot confirm a new one: the
 * pair must be about one disappearance, not days apart with failed lookups in between.
 */
const STALE_OBSERVATION_FACTOR = 3;
/** Rows read per selection query; the sweep keeps selecting until its deadline or probe cap. */
const SELECTION_PAGE_SIZE = 25;
/** A present node is recorded at most once a day; an unchanged inconclusive reason once an hour. */
const PRESENT_DECISION_DEDUPE_MS = 24 * 60 * 60 * 1000;
const INCONCLUSIVE_DECISION_DEDUPE_MS = 60 * 60 * 1000;

export interface DeploymentNodeExistenceSweepResult {
  skipReason?: 'disabled';
  probed: number;
  present: number;
  absentObserved: number;
  absentAwaitingConfirmation: number;
  released: number;
  releaseFailed: number;
  /** A node whose check threw (D1 fault, teardown throw); stamped, so retried next interval. */
  nodeErrors: number;
  deferred: number;
  superseded: number;
  inconclusive: Partial<Record<ProviderExistenceInconclusiveReason, number>>;
  rateLimitedProviders: string[];
  reachedDeadline: boolean;
  reachedProbeCap: boolean;
}

interface SweepSettings {
  enabled: boolean;
  checkIntervalMs: number;
  confirmIntervalMs: number;
  sweepBudgetMs: number;
  maxProbesPerSweep: number;
  requestTimeoutMs: number;
}

async function setting<K extends keyof typeof DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS>(
  env: Env,
  key: K
): Promise<(typeof DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS)[K]> {
  const name: DeploymentNodeExistenceSettingName = `deploymentNodeExistence.${key}`;
  const value = await resolveAdminSetting(env, name);
  const fallback = DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS[key];
  return (typeof value === typeof fallback ? value : fallback) as typeof fallback;
}

async function resolveSettings(env: Env): Promise<SweepSettings> {
  const [enabled, check, confirm, budget, probes, timeout] = await Promise.all([
    setting(env, 'enabled'),
    setting(env, 'checkIntervalSeconds'),
    setting(env, 'confirmIntervalSeconds'),
    setting(env, 'sweepBudgetMs'),
    setting(env, 'maxProbesPerSweep'),
    setting(env, 'requestTimeoutMs'),
  ]);
  return {
    enabled,
    checkIntervalMs: check * 1000,
    confirmIntervalMs: confirm * 1000,
    sweepBudgetMs: budget,
    maxProbesPerSweep: probes,
    requestTimeoutMs: timeout,
  };
}

function emptyResult(): DeploymentNodeExistenceSweepResult {
  return {
    probed: 0,
    present: 0,
    absentObserved: 0,
    absentAwaitingConfirmation: 0,
    released: 0,
    releaseFailed: 0,
    nodeErrors: 0,
    deferred: 0,
    superseded: 0,
    inconclusive: {},
    rateLimitedProviders: [],
    reachedDeadline: false,
    reachedProbeCap: false,
  };
}

/**
 * Running managed deployment VMs due a probe: never probed, last probed a check interval ago, or
 * (with a pending absence) a confirmation interval ago. Pending absences first, then the
 * longest-unchecked. Every predicate carries the managed-class guard (`.claude/rules/51`): a
 * user-owned machine is never probed or released here.
 */
async function selectDueNodes(
  env: Env,
  now: Date,
  settings: SweepSettings,
  limit: number,
  excludedProviders: readonly string[]
): Promise<Array<{ id: string; cloudProvider: string | null }>> {
  const checkCutoff = new Date(now.getTime() - settings.checkIntervalMs).toISOString();
  const confirmCutoff = new Date(now.getTime() - settings.confirmIntervalMs).toISOString();
  // At most one bind per provider SAM supports, far below the D1 bind ceiling.
  const exclusion = excludedProviders.length
    ? `AND (cloud_provider IS NULL OR cloud_provider NOT IN (${excludedProviders.map(() => '?').join(', ')}))`
    : '';
  const rows = await env.DATABASE.prepare(
    `SELECT id, cloud_provider AS cloudProvider FROM nodes
     WHERE node_role = 'deployment' AND node_class = 'managed' AND runtime = 'vm'
       AND status = 'running' AND provider_instance_id IS NOT NULL
       AND (provider_existence_checked_at IS NULL OR provider_existence_checked_at <=
         CASE WHEN provider_absence_observed_at IS NULL THEN ? ELSE ? END)
       ${exclusion}
     ORDER BY CASE WHEN provider_absence_observed_at IS NULL THEN 1 ELSE 0 END,
       COALESCE(provider_existence_checked_at, ''), id
     LIMIT ?`
  )
    .bind(checkCutoff, confirmCutoff, ...excludedProviders, limit)
    .all<{ id: string; cloudProvider: string | null }>();
  return rows.results;
}

/**
 * Stamp the probe before any network I/O, compare-and-set on the stamp read, so the node leaves
 * the candidate set even if the lookup hangs or the isolate dies (`.claude/rules/47`), and two
 * overlapping sweeps never probe the same node twice. Only this sweep writes the column.
 */
async function claimProbe(env: Env, node: NodeRow, now: Date): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE nodes SET provider_existence_checked_at = ?
     WHERE id = ? AND status = 'running' AND provider_existence_checked_at IS ?`
  )
    .bind(now.toISOString(), node.id, node.providerExistenceCheckedAt)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

type NodeOutcome =
  | { kind: 'skipped' }
  | { kind: 'present' }
  | { kind: 'absent_observed' }
  | { kind: 'absent_awaiting_confirmation' }
  | { kind: 'inconclusive'; reason: ProviderExistenceInconclusiveReason }
  | { kind: ReleaseOutcome };

async function checkNode(
  env: Env,
  nodeId: string,
  settings: SweepSettings,
  deadline: number
): Promise<NodeOutcome> {
  const db = drizzle(env.DATABASE, { schema });
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)).limit(1);
  if (
    !node ||
    node.status !== 'running' ||
    node.nodeRole !== 'deployment' ||
    node.nodeClass !== 'managed' ||
    node.runtime !== 'vm' ||
    !node.providerInstanceId
  ) {
    return { kind: 'skipped' };
  }
  const probeStartedAt = new Date();
  if (!(await claimProbe(env, node, probeStartedAt))) return { kind: 'skipped' };
  // An observation about another instance, none yet, or one too old to pair with this
  // answer (inconclusive lookups in between, `STALE_OBSERVATION_FACTOR`) starts a new
  // confirmation. It is stamped with this lookup's start, equal to the probe stamp, so the
  // selector makes the confirming lookup exactly one confirmation interval later.
  const observedAt = node.providerAbsenceObservedAt;
  const observationAgeMs = observedAt
    ? probeStartedAt.getTime() - Date.parse(observedAt)
    : Number.NaN;
  const stale =
    !Number.isFinite(observationAgeMs) ||
    observationAgeMs > settings.confirmIntervalMs * STALE_OBSERVATION_FACTOR;
  const startsNewObservation =
    !observedAt || node.providerAbsenceInstanceId !== node.providerInstanceId || stale;
  // A not-found now would be the second one: the probe then also checks the account inventory.
  const confirming = !startsNewObservation && observationAgeMs >= settings.confirmIntervalMs;
  const signal = AbortSignal.timeout(
    Math.max(1, Math.min(settings.requestTimeoutMs, deadline - Date.now()))
  );
  const verdict = await probeDeploymentNodeInstance(env, db, node, signal, { confirming });

  if (verdict.kind === 'inconclusive') {
    log.warn('deployment_node_existence.inconclusive', {
      nodeId: node.id,
      provider: node.cloudProvider,
      reason: verdict.reason,
      error: verdict.message,
    });
    await recordExistenceDecision(
      env,
      node,
      'provider_check_inconclusive',
      verdict.reason,
      {},
      INCONCLUSIVE_DECISION_DEDUPE_MS
    );
    return { kind: 'inconclusive', reason: verdict.reason };
  }

  if (verdict.kind === 'present') {
    const hadAbsence = node.providerAbsenceObservedAt !== null;
    if (hadAbsence) {
      await env.DATABASE.prepare(
        `UPDATE nodes SET provider_absence_observed_at = NULL, provider_absence_instance_id = NULL
         WHERE id = ? AND provider_absence_observed_at IS ?`
      )
        .bind(node.id, node.providerAbsenceObservedAt)
        .run();
    }
    await recordExistenceDecision(
      env,
      node,
      'provider_instance_present',
      hadAbsence ? 'present_after_absence' : 'present',
      {},
      hadAbsence ? undefined : PRESENT_DECISION_DEDUPE_MS
    );
    return { kind: 'present' };
  }

  // Absent: start a new confirmation, or wait for or complete the pending one (see above).
  if (startsNewObservation) {
    const firstAt = probeStartedAt.toISOString();
    const write = await env.DATABASE.prepare(
      `UPDATE nodes SET provider_absence_observed_at = ?, provider_absence_instance_id = ?
       WHERE id = ? AND ${sameIncarnationSql()}`
    )
      .bind(
        firstAt,
        node.providerInstanceId,
        node.id,
        node.providerInstanceId,
        node.runtimeIncarnationId
      )
      .run();
    // The node changed during the lookup (stopped, replaced): this answer is about nothing.
    if ((write.meta.changes ?? 0) !== 1) return { kind: 'skipped' };
    await recordExistenceDecision(
      env,
      node,
      'provider_instance_absent_observed',
      observedAt ? 'first_not_found_restarted' : 'first_not_found',
      {
        firstObservedAt: firstAt,
      }
    );
    return { kind: 'absent_observed' };
  }
  // The confirming lookup must start a full interval after the first one started.
  if (!confirming) {
    await recordExistenceDecision(
      env,
      node,
      'provider_instance_absent_observed',
      'awaiting_confirmation',
      {
        firstObservedAt: observedAt,
      }
    );
    return { kind: 'absent_awaiting_confirmation' };
  }
  return { kind: await releaseConfirmedAbsentNode(env, node, observedAt, new Date()) };
}

/** One bounded pass; called from the 5-minute cron, out of band (`node-teardown-sweeps.ts`). */
export async function runDeploymentNodeProviderExistenceSweep(
  env: Env
): Promise<DeploymentNodeExistenceSweepResult> {
  const result = emptyResult();
  const settings = await resolveSettings(env);
  if (!settings.enabled) {
    result.skipReason = 'disabled';
    log.info('deployment_node_existence.sweep_completed', { ...result });
    return result;
  }
  const deadline = Date.now() + settings.sweepBudgetMs;
  const rateLimited = new Set<string>();
  const visited = new Set<string>();
  sweep: for (;;) {
    if (Date.now() >= deadline) {
      result.reachedDeadline = true;
      break;
    }
    if (result.probed >= settings.maxProbesPerSweep) {
      result.reachedProbeCap = true;
      break;
    }
    // Probed nodes are stamped and drop out of the selection; `visited` only guards against a
    // node the claim skipped (another sweep stamped it first) being selected again.
    const page = (
      await selectDueNodes(env, new Date(), settings, SELECTION_PAGE_SIZE, [...rateLimited])
    ).filter((row) => !visited.has(row.id));
    if (page.length === 0) break;
    for (const row of page) {
      if (Date.now() >= deadline) {
        result.reachedDeadline = true;
        break sweep;
      }
      if (result.probed >= settings.maxProbesPerSweep) {
        result.reachedProbeCap = true;
        break sweep;
      }
      visited.add(row.id);
      // A 429 is the provider asking SAM to slow down: no more lookups to it this sweep.
      if (row.cloudProvider && rateLimited.has(row.cloudProvider)) continue;
      let outcome: NodeOutcome;
      try {
        outcome = await checkNode(env, row.id, settings, deadline);
      } catch (error) {
        // Per-node isolation: one node's failure (a D1 fault, a teardown throw) never stops the
        // sweep. The node was stamped, so it is retried on its next interval.
        result.nodeErrors++;
        log.error('deployment_node_existence.node_failed', {
          nodeId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (outcome.kind === 'skipped') continue;
      result.probed++;
      switch (outcome.kind) {
        case 'present':
          result.present++;
          break;
        case 'absent_observed':
          result.absentObserved++;
          break;
        case 'absent_awaiting_confirmation':
          result.absentAwaitingConfirmation++;
          break;
        case 'released':
          result.released++;
          break;
        case 'release_failed':
          result.releaseFailed++;
          break;
        case 'deferred':
          result.deferred++;
          break;
        case 'superseded':
          result.superseded++;
          break;
        case 'inconclusive':
          result.inconclusive[outcome.reason] = (result.inconclusive[outcome.reason] ?? 0) + 1;
          if (outcome.reason === 'rate_limited' && row.cloudProvider) {
            rateLimited.add(row.cloudProvider);
          }
          break;
      }
    }
  }
  result.rateLimitedProviders = [...rateLimited];
  log.info('deployment_node_existence.sweep_completed', { ...result });
  return result;
}
