/**
 * The per-record half of dangling app-route DNS cleanup, shared by node-release cleanup and the
 * cron sweep (`app-route-dns-reconciliation.ts`): the liveness predicate, the D1 read behind
 * it, and the guarded delete/repoint of each record. Split from that module (file size limit).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { appRouteRecordAddress } from './app-route-dns-target';
import {
  type AppRouteDnsRecord,
  deleteObservedAppRouteDnsRecord,
  hasAppRouteSiblingAt,
  repointObservedAppRouteDnsRecord,
} from './dns-app-route-inventory';
import { DEFAULT_CF_API_TIMEOUT_MS } from './dns-core';
import { getTimeoutMs } from './fetch-timeout';

/** KV key prefix of a record whose delete failed: the sweep skips it until the key expires. */
export const APP_ROUTE_DNS_FAILURE_BACKOFF_PREFIX = 'dns:app-route-sweep:backoff:';

/**
 * Node statuses whose IP SAM has given up or is giving up. Not the callback-terminal set
 * (`node-callback-auth.ts`): a `stopped` node keeps its provider IP, so its records are not
 * dangling, and deleting them would break the routes when it restarts. A status is only a proxy
 * for "the VM is gone" (`.claude/rules/74`): the termination proof is the condition itself, and
 * {@link judgeAppRouteRecord} treats it as released whatever the status says (a teardown that
 * failed after the VM was deleted can leave a node in `error`).
 */
const RELEASED_NODE_STATUSES: ReadonlySet<string> = new Set([
  'destroying',
  'deleting',
  'deleted',
  'destroyed',
]);

type DanglingReason =
  | 'environment_missing'
  | 'no_linked_node'
  | 'node_missing'
  | 'node_released'
  | 'ip_mismatch'
  | 'wildcard_covered';

interface RouteTarget {
  nodeId: string | null;
  nodeStatus: string | null;
  ipAddress: string | null;
  /** `nodes.runtime_termination_confirmed_at`: set once this VM incarnation is proven deleted. */
  terminationConfirmedAt: string | null;
  /**
   * Where this node's app-route records must point (`appRouteRecordAddress`, the same answer the
   * release fetch writes): the node's IP on public transport, the box on the self-host reverse
   * tunnel, `covered` when no per-route record is written at all.
   */
  recordAddress: { covered: true } | { covered: false; address: string | null };
}

/** `'unknown'`: the environment's row could not be read, so its records are left alone. */
type RouteTargets = Map<string, RouteTarget | 'unknown'>;

export type AppRouteVerdict = { live: true } | { live: false; reason: DanglingReason } | null;

/** The one liveness predicate both cleanup paths use. `null`: cannot tell, keep the record. */
export function judgeAppRouteRecord(
  record: Pick<AppRouteDnsRecord, 'content'>,
  target: RouteTarget | 'unknown' | undefined
): AppRouteVerdict {
  if (target === 'unknown') return null;
  if (!target) return { live: false, reason: 'environment_missing' };
  if (!target.nodeId) return { live: false, reason: 'no_linked_node' };
  if (!target.nodeStatus) return { live: false, reason: 'node_missing' };
  if (RELEASED_NODE_STATUSES.has(target.nodeStatus) || target.terminationConfirmedAt) {
    return { live: false, reason: 'node_released' };
  }
  // A covered node's names resolve through the installation's wildcard, and the release fetch
  // writes no per-route record for them. One that exists is left over from an earlier node (it
  // overrides the wildcard and may point at that node's released IP), so it goes.
  if (target.recordAddress.covered) return { live: false, reason: 'wildcard_covered' };
  if (target.recordAddress.address !== record.content) {
    return { live: false, reason: 'ip_mismatch' };
  }
  return { live: true };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where each environment's routes should point, in one query: the id list travels as one JSON
 * bind, so the D1 bound-parameter ceiling does not apply however large the page is.
 */
async function loadRouteTargets(env: Env, environmentIds: string[]): Promise<RouteTargets> {
  const targets: RouteTargets = new Map();
  if (environmentIds.length === 0) return targets;
  const result = await env.DATABASE.prepare(
    `SELECT de.id AS environmentId, de.node_id AS nodeId, n.status AS nodeStatus,
            n.ip_address AS ipAddress, n.transport AS transport,
            n.runtime_termination_confirmed_at AS terminationConfirmedAt
     FROM deployment_environments de
     LEFT JOIN nodes n ON n.id = de.node_id
     WHERE de.id IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(environmentIds))
    .all();
  for (const raw of result.results ?? []) {
    const row = maybeJsonRecord(raw) ?? {};
    const environmentId = row.environmentId;
    const nodeId = nullableString(row.nodeId);
    const nodeStatus = nullableString(row.nodeStatus);
    const ipAddress = nullableString(row.ipAddress);
    const terminationConfirmedAt = nullableString(row.terminationConfirmedAt);
    const transport = nullableString(row.transport);
    if (typeof environmentId !== 'string') continue;
    if (
      nodeId === undefined ||
      nodeStatus === undefined ||
      ipAddress === undefined ||
      terminationConfirmedAt === undefined ||
      transport === undefined
    ) {
      // A row we cannot read is never a reason to delete (.claude/rules/50).
      log.warn('dns.app_route_target_row_skipped', { environmentId, action: 'kept_records' });
      targets.set(environmentId, 'unknown');
      continue;
    }
    let recordAddress: RouteTarget['recordAddress'];
    try {
      recordAddress = appRouteRecordAddress({ transport, ipAddress }, env);
    } catch (error) {
      // A misconfigured transport (e.g. a box missing SAM_DNS_PUBLIC_IPV4) cannot say where this
      // environment's routes belong; judge only its records as unknown (`.claude/rules/50`).
      log.warn('dns.app_route_target_address_unresolved', {
        environmentId,
        transport,
        error: error instanceof Error ? error.message : String(error),
        action: 'kept_records',
      });
      targets.set(environmentId, 'unknown');
      continue;
    }
    targets.set(environmentId, {
      nodeId,
      nodeStatus,
      ipAddress,
      terminationConfirmedAt,
      recordAddress,
    });
  }
  return targets;
}

export interface AppRouteCleanupCounts {
  examined: number;
  kept: number;
  unknown: number;
  deleted: number;
  /** Live again, or repointed, when re-checked right before the delete; left alone. */
  changed: number;
  /** Listed under the app-route suffix but not a SAM app-route name; never touched. */
  unparsed: number;
  /** Pointed at the stale IP of an environment that now runs on a live node: moved to its IP. */
  repointed: number;
  absent: number;
  failed: number;
  deferred: number;
  /** A delete of this record failed recently; skipped until its backoff expires (sweep only). */
  backedOff: number;
  /** Mutation attempts that spent the per-sweep cap (see `cleanupRecords`). */
  attempts: number;
}

export function emptyCounts(): AppRouteCleanupCounts {
  return {
    examined: 0,
    kept: 0,
    unknown: 0,
    deleted: 0,
    changed: 0,
    unparsed: 0,
    repointed: 0,
    absent: 0,
    failed: 0,
    deferred: 0,
    backedOff: 0,
    attempts: 0,
  };
}

export function addCounts(total: AppRouteCleanupCounts, part: AppRouteCleanupCounts): void {
  for (const key of Object.keys(total) as (keyof AppRouteCleanupCounts)[]) {
    total[key] += part[key];
  }
}

export async function cleanupRecords(
  env: Env,
  records: AppRouteDnsRecord[],
  input: {
    trigger: 'node_release' | 'sweep';
    nodeId?: string;
    maxDeletes: number;
    deadline: number;
    signal?: AbortSignal;
    /** Sweep only: skip records whose delete failed within this many seconds. */
    failureBackoffSeconds?: number;
    /**
     * Touch only records whose environment is linked to this node (on the page and on the fresh
     * re-check). For an address other environments share (the box): matching content there says
     * nothing about ownership, so other environments' records are left to the sweep.
     */
    ownedByNodeId?: string;
  }
): Promise<AppRouteCleanupCounts> {
  const owned = (target: RouteTarget | 'unknown' | undefined) =>
    !input.ownedByNodeId ||
    (!!target && target !== 'unknown' && target.nodeId === input.ownedByNodeId);
  const counts = emptyCounts();
  const targets = await loadRouteTargets(env, [...new Set(records.map((r) => r.environmentId))]);
  // Every mutation attempt spends the cap, including a failed one whose backoff was recorded, so
  // a fast-failing DNS API cannot burst over every record; the backoff keeps that record off
  // later sweeps, so the records behind it are still reached. The deadline bounds the rest.
  for (const record of records) {
    counts.examined++;
    if (!owned(targets.get(record.environmentId))) {
      counts.kept++;
      continue;
    }
    const verdict = judgeAppRouteRecord(record, targets.get(record.environmentId));
    if (verdict === null) {
      counts.unknown++;
      // Never deleted on an unreadable row (`.claude/rules/50`), so it must stay loud instead:
      // the run that saw it fails (see the callers) until the row is repaired.
      log.error('dns.app_route_record_unjudged', {
        trigger: input.trigger,
        nodeId: input.nodeId ?? null,
        hostname: record.name,
        recordId: record.id,
        content: record.content,
        environmentId: record.environmentId,
        action: 'kept_needs_operator',
      });
      continue;
    }
    if (verdict.live) {
      counts.kept++;
      continue;
    }
    if (counts.attempts >= input.maxDeletes || Date.now() >= input.deadline) {
      counts.deferred++;
      continue;
    }
    const backoffKey = `${APP_ROUTE_DNS_FAILURE_BACKOFF_PREFIX}${record.id}`;
    if (input.failureBackoffSeconds && (await env.KV.get(backoffKey))) {
      // A record that keeps failing costs no DNS calls while it waits, but stays loud: the
      // sweep reports it as a failure on every run (see runAppRouteDnsReconciliation).
      counts.backedOff++;
      continue;
    }
    try {
      // Judge again on fresh D1 state: a start may have linked this environment to a node since
      // the page was judged, possibly one given the same recycled IP (the release fetch then
      // re-upserts the same content, which the DNS re-read below cannot tell apart).
      const fresh = await loadRouteTargets(env, [record.environmentId]);
      const current = judgeAppRouteRecord(record, fresh.get(record.environmentId));
      if (!current || current.live || !owned(fresh.get(record.environmentId))) {
        counts.changed++;
        counts.attempts++;
        continue;
      }
      const target = fresh.get(record.environmentId);
      const liveAddress =
        target && target !== 'unknown' && !target.recordAddress.covered
          ? target.recordAddress.address
          : null;
      if (current.reason === 'ip_mismatch' && target && target !== 'unknown' && liveAddress) {
        // The environment runs on a live node at another address, so its release fetch may be
        // upserting this very record right now. Repointing converges with that upsert, where a
        // delete could race it and remove the new route (Cloudflare has no conditional delete).
        // Either way the record stops pointing at the released IP.
        // This record itself, not the first record of its name (a live sibling may share it).
        // A sibling of the same name already at the live address makes this record redundant:
        // delete it rather than updating it into a duplicate (which the provider can refuse).
        if (await hasAppRouteSiblingAt(env, record, liveAddress, input.signal)) {
          const outcome = await deleteObservedAppRouteDnsRecord(env, record, input.signal);
          counts[outcome]++;
          counts.attempts++;
          if (outcome === 'deleted') {
            log.info('dns.app_route_dangling_deleted', {
              trigger: input.trigger,
              nodeId: input.nodeId ?? null,
              hostname: record.name,
              recordId: record.id,
              content: record.content,
              environmentId: record.environmentId,
              reason: 'duplicate_of_live_sibling',
            });
          }
          continue;
        }
        await repointObservedAppRouteDnsRecord(env, record, liveAddress, input.signal);
        // The live node may have started teardown between the read above and the update, its
        // own release cleanup listing before the record pointed at it. Judge once more and, if
        // the address is no longer live, delete the record now rather than at the next sweep.
        const after = await loadRouteTargets(env, [record.environmentId]);
        const repointed = { ...record, content: liveAddress };
        const afterVerdict = judgeAppRouteRecord(repointed, after.get(record.environmentId));
        // `ip_mismatch` here means the environment moved to yet another live node, whose release
        // fetch may be writing this record: leave it for the next sweep rather than delete it.
        if (afterVerdict && !afterVerdict.live && afterVerdict.reason !== 'ip_mismatch') {
          const outcome = await deleteObservedAppRouteDnsRecord(env, repointed, input.signal);
          counts[outcome]++;
          counts.attempts++;
          log.info('dns.app_route_repoint_target_released', {
            trigger: input.trigger,
            hostname: record.name,
            recordId: record.id,
            content: liveAddress,
            environmentId: record.environmentId,
            reason: afterVerdict.reason,
            outcome,
          });
          continue;
        }
        counts.repointed++;
        counts.attempts++;
        log.info('dns.app_route_dangling_repointed', {
          trigger: input.trigger,
          nodeId: input.nodeId ?? null,
          hostname: record.name,
          recordId: record.id,
          fromContent: record.content,
          toContent: liveAddress,
          environmentId: record.environmentId,
          liveNodeId: target.nodeId,
        });
        continue;
      }
      const outcome = await deleteObservedAppRouteDnsRecord(env, record, input.signal);
      counts[outcome]++;
      counts.attempts++;
      if (outcome === 'deleted') {
        log.info('dns.app_route_dangling_deleted', {
          trigger: input.trigger,
          nodeId: input.nodeId ?? null,
          hostname: record.name,
          recordId: record.id,
          content: record.content,
          environmentId: record.environmentId,
          reason: verdict.reason,
        });
      }
    } catch (error) {
      if (input.signal?.aborted) {
        // The caller's deadline cut this delete off; the next attempt picks the record up again.
        counts.deferred++;
        continue;
      }
      counts.failed++;
      // A failure spends the cap only once its backoff is recorded: the backoff is what lets a
      // later sweep pass the record. Without it (a KV write failure) the record would be retried
      // first next time, and records that always fail would hold the sweep on this page forever.
      if (input.failureBackoffSeconds) {
        const backedOff = await env.KV.put(backoffKey, new Date().toISOString(), {
          expirationTtl: input.failureBackoffSeconds,
        }).then(
          () => true,
          () => false
        );
        if (backedOff) counts.attempts++;
      }
      log.error('dns.app_route_dangling_delete_failed', {
        trigger: input.trigger,
        nodeId: input.nodeId ?? null,
        hostname: record.name,
        recordId: record.id,
        environmentId: record.environmentId,
        reason: verdict.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return counts;
}

/** Shortest per-request DNS timeout, so a slow but working API is not cut off. */
const MIN_DNS_REQUEST_TIMEOUT_MS = 1000;

/**
 * The env DNS calls run with during cleanup: each request may take at most a quarter of the
 * budget (never more than `CF_API_TIMEOUT_MS`). A request that hangs then fails on its own and
 * counts as a failure (spending the delete cap only once its backoff is recorded), and the
 * records after it are still reached in the same run, instead of the hang using up the budget.
 */
export function dnsRequestEnv(env: Env, budgetMs: number): Env {
  const configured = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const perRequest = Math.min(
    configured,
    Math.max(MIN_DNS_REQUEST_TIMEOUT_MS, Math.floor(budgetMs / 4))
  );
  return { ...env, CF_API_TIMEOUT_MS: String(perRequest) };
}
