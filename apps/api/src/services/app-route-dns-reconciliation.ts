/**
 * Dangling app-route DNS cleanup.
 *
 * App routes are unproxied A records (`r{n}-{service}-{port}-{envId}.apps.{BASE_DOMAIN}`) that
 * point at a deployment node's public IP. Once that node is released, the provider may hand the
 * IP to someone else, so a record left behind is a subdomain-takeover risk. Two callers share one
 * liveness predicate ({@link judgeAppRouteRecord}):
 *
 * - {@link releaseNodeAppRouteDnsRecords}: every managed node deletion
 *   (`deleteNodeResourcesStrict`, which stop, failed start, environment delete, node delete and
 *   every cleanup sweep go through) deletes the records still pointing at the node's IP. Keyed on
 *   the IP rather than on environment links, so an environment unlinked before teardown is still
 *   covered. It runs last in each proof branch, and a failed delete throws: the caller then
 *   cannot retire the node (which clears its IP), so the next attempt repeats it (fail closed).
 * - {@link runAppRouteDnsReconciliation}: the 5-minute cron backstop for records that already
 *   dangle (left by older code, or by a path that skipped the release).
 *
 * A record is live only when its environment exists, is linked to a node SAM has not released or
 * started releasing (status, or the termination proof), and that node's current IP is the
 * record's content. SAM can only judge what it recorded: a VM deleted at the provider behind
 * SAM's back keeps a `running` row, and its records with it, until a provider-existence check
 * exists for deployment nodes (idea 01M81Z9P6QFX4M9Q83K2XKGZVR). A release fetch already in flight when
 * a node is released can also re-create a record after the release cleanup listed; the next
 * sweep removes it once retirement unlinks the environment. Anything else
 * is judged again against fresh D1 state first (a replacement node may have been given the same
 * recycled IP). A record whose environment now runs on a live node at another address is
 * repointed there, because that node's release fetch may be upserting it concurrently and
 * Cloudflare has no conditional delete. Any other dangling record is deleted after a DNS re-read
 * shows it unchanged; with no live node, no release fetch can be writing it.
 *
 * Throughput at the defaults (`appRouteDns.*`: 500 records per page, 20 s budget, 50 deletes): a
 * list call is ~0.3 s, so one sweep can read ~30,000 records; a delete is one D1 read and two DNS
 * calls (~0.4 s), so the budget fits the 50-delete cap, ~600 deletes an hour. At an outer limit of
 * 10,000 dangling records in one zone (production holds a few dozen app routes in total) cleanup
 * takes ~17 hours. A cut-off sweep resumes from its stored page cursor; records created or
 * deleted between sweeps shift page offsets, so a record skipped in one cycle is reached in the
 * next. `cycleComplete` in `dns.app_route_sweep_completed` marks each full pass of the zone.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { resolveAdminSetting } from './admin-settings';
import {
  APP_ROUTE_DNS_RUNTIME_DEFAULTS,
  type AppRouteDnsSettingName,
} from './admin-settings-app-route-dns-definitions';
import {
  type AppRouteDnsRecord,
  appRouteNameSuffix,
  deleteObservedAppRouteDnsRecord,
  listAppRouteDnsRecordsPage,
} from './dns-app-route-inventory';
import { upsertAppRouteDNSRecord } from './dns-app-routes';
import { DEFAULT_CF_API_TIMEOUT_MS } from './dns-core';
import { getTimeoutMs } from './fetch-timeout';

/** KV key holding the next page the sweep reads (1-based). */
export const APP_ROUTE_DNS_SWEEP_CURSOR_KEY = 'dns:app-route-sweep:next-page';

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
  'environment_missing' | 'no_linked_node' | 'node_missing' | 'node_released' | 'ip_mismatch';

interface RouteTarget {
  nodeId: string | null;
  nodeStatus: string | null;
  ipAddress: string | null;
  /** `nodes.runtime_termination_confirmed_at`: set once this VM incarnation is proven deleted. */
  terminationConfirmedAt: string | null;
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
  if (target.ipAddress !== record.content) return { live: false, reason: 'ip_mismatch' };
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
            n.ip_address AS ipAddress,
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
    if (typeof environmentId !== 'string') continue;
    if (
      nodeId === undefined ||
      nodeStatus === undefined ||
      ipAddress === undefined ||
      terminationConfirmedAt === undefined
    ) {
      // A row we cannot read is never a reason to delete (.claude/rules/50).
      log.warn('dns.app_route_target_row_skipped', { environmentId, action: 'kept_records' });
      targets.set(environmentId, 'unknown');
      continue;
    }
    targets.set(environmentId, { nodeId, nodeStatus, ipAddress, terminationConfirmedAt });
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
}

function emptyCounts(): AppRouteCleanupCounts {
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
  };
}

function addCounts(total: AppRouteCleanupCounts, part: AppRouteCleanupCounts): void {
  for (const key of Object.keys(total) as (keyof AppRouteCleanupCounts)[]) {
    total[key] += part[key];
  }
}

async function cleanupRecords(
  env: Env,
  records: AppRouteDnsRecord[],
  input: {
    trigger: 'node_release' | 'sweep';
    nodeId?: string;
    maxDeletes: number;
    deadline: number;
    signal?: AbortSignal;
  }
): Promise<AppRouteCleanupCounts> {
  const counts = emptyCounts();
  const targets = await loadRouteTargets(env, [...new Set(records.map((r) => r.environmentId))]);
  // Completed attempts (deleted, absent, changed). A failed delete does not spend the cap, so
  // records that always fail cannot keep later records from being reached; the deadline still
  // bounds the time failures can take.
  let attempts = 0;
  for (const record of records) {
    counts.examined++;
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
    if (attempts >= input.maxDeletes || Date.now() >= input.deadline) {
      counts.deferred++;
      continue;
    }
    try {
      // Judge again on fresh D1 state: a start may have linked this environment to a node since
      // the page was judged, possibly one given the same recycled IP (the release fetch then
      // re-upserts the same content, which the DNS re-read below cannot tell apart).
      const fresh = await loadRouteTargets(env, [record.environmentId]);
      const current = judgeAppRouteRecord(record, fresh.get(record.environmentId));
      if (!current || current.live) {
        counts.changed++;
        attempts++;
        continue;
      }
      const target = fresh.get(record.environmentId);
      if (current.reason === 'ip_mismatch' && target && target !== 'unknown' && target.ipAddress) {
        // The environment runs on a live node at another address, so its release fetch may be
        // upserting this very record right now. Repointing converges with that upsert, where a
        // delete could race it and remove the new route (Cloudflare has no conditional delete).
        // Either way the record stops pointing at the released IP.
        await upsertAppRouteDNSRecord(record.name, target.ipAddress, env);
        counts.repointed++;
        attempts++;
        log.info('dns.app_route_dangling_repointed', {
          trigger: input.trigger,
          nodeId: input.nodeId ?? null,
          hostname: record.name,
          recordId: record.id,
          fromContent: record.content,
          toContent: target.ipAddress,
          environmentId: record.environmentId,
          liveNodeId: target.nodeId,
        });
        continue;
      }
      const outcome = await deleteObservedAppRouteDnsRecord(env, record, input.signal);
      counts[outcome]++;
      attempts++;
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
 * budget (never more than `CF_API_TIMEOUT_MS`). A request that hangs then fails on its own,
 * counts as a failure (which does not spend the delete cap), and the records after it are still
 * reached in the same run, instead of the hang using up the whole budget every run.
 */
function dnsRequestEnv(env: Env, budgetMs: number): Env {
  const configured = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const perRequest = Math.min(
    configured,
    Math.max(MIN_DNS_REQUEST_TIMEOUT_MS, Math.floor(budgetMs / 4))
  );
  return { ...env, CF_API_TIMEOUT_MS: String(perRequest) };
}

async function settingValue(
  env: Env,
  key: keyof typeof APP_ROUTE_DNS_RUNTIME_DEFAULTS
): Promise<number> {
  const name: AppRouteDnsSettingName = `appRouteDns.${key}`;
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' ? value : APP_ROUTE_DNS_RUNTIME_DEFAULTS[key];
}

/**
 * Delete every app-route record still pointing at a node SAM is releasing. Called last in each
 * termination-proof branch of `deleteNodeResourcesStrict`, so every release path runs it.
 * Throws when a record could not be deleted in time, so the node stays in its retryable teardown
 * state instead of being retired with a record pointing at an IP the provider may reassign.
 * A record whose environment row cannot be read is logged and left to the sweep rather than
 * wedging the teardown forever (`.claude/rules/71`).
 */
export async function releaseNodeAppRouteDnsRecords(
  env: Env,
  node: { id: string; nodeRole: string | null; ipAddress: string | null },
  signal?: AbortSignal
): Promise<AppRouteCleanupCounts | null> {
  // Only deployment nodes serve app routes; any other node's IP is left to the sweep, so a
  // DNS outage cannot block workspace teardown.
  if (node.nodeRole !== 'deployment' || !node.ipAddress) return null;
  if (!appRouteNameSuffix(env.BASE_DOMAIN)) return null;
  const [perPage, budgetMs] = await Promise.all([
    settingValue(env, 'sweepPageSize'),
    settingValue(env, 'sweepBudgetMs'),
  ]);
  // Bounded by the cleanup budget, and by the caller's deadline when it passes one.
  const budget = AbortSignal.timeout(budgetMs);
  const effectiveSignal = signal ? AbortSignal.any([signal, budget]) : budget;
  const dnsEnv = dnsRequestEnv(env, budgetMs);
  const counts = emptyCounts();
  let unparsed = 0;
  // Page by page, so a large inventory still makes progress within one budget. Deleted, absent
  // and repointed records leave the `content` filter, shifting later records onto this page, so
  // the page is read again after any of them; every re-read follows a removal.
  for (let page = 1; ;) {
    const result = await listAppRouteDnsRecordsPage(
      dnsEnv,
      { page, perPage, content: node.ipAddress },
      effectiveSignal
    );
    unparsed += result.providerCount - result.records.length;
    const pageCounts = await cleanupRecords(dnsEnv, result.records, {
      trigger: 'node_release',
      nodeId: node.id,
      maxDeletes: Number.POSITIVE_INFINITY,
      deadline: Number.POSITIVE_INFINITY,
      signal: effectiveSignal,
    });
    addCounts(counts, pageCounts);
    if (result.providerCount < perPage || pageCounts.deferred > 0) break;
    if (pageCounts.deleted + pageCounts.absent + pageCounts.repointed === 0) page++;
  }
  counts.unparsed = unparsed;
  if (counts.unknown > 0) {
    log.error('dns.app_route_release_unjudged', {
      nodeId: node.id,
      unknown: counts.unknown,
      action: 'left_to_sweep',
    });
  }
  if (counts.failed > 0 || counts.deferred > 0) {
    throw new Error(
      `Could not delete ${counts.failed + counts.deferred} app-route DNS record(s) pointing at node ${node.id}`
    );
  }
  return counts;
}

async function readCursor(env: Env): Promise<number> {
  const raw = await env.KV.get(APP_ROUTE_DNS_SWEEP_CURSOR_KEY);
  const page = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

export interface AppRouteDnsSweepResult extends AppRouteCleanupCounts {
  pagesRead: number;
  startPage: number;
  nextPage: number;
  cycleComplete: boolean;
  stoppedBy: 'end_of_zone' | 'deadline' | 'delete_limit' | 'no_base_domain';
}

/** The cron backstop: scan the zone's app-route records page by page and delete dangling ones. */
export async function runAppRouteDnsReconciliation(env: Env): Promise<AppRouteDnsSweepResult> {
  const totals = emptyCounts();
  if (!appRouteNameSuffix(env.BASE_DOMAIN)) {
    const result = {
      ...totals,
      pagesRead: 0,
      startPage: 1,
      nextPage: 1,
      cycleComplete: false,
      stoppedBy: 'no_base_domain' as const,
    };
    log.info('dns.app_route_sweep_completed', { ...result });
    return result;
  }
  const [budgetMs, perPage, maxDeletes] = await Promise.all([
    settingValue(env, 'sweepBudgetMs'),
    settingValue(env, 'sweepPageSize'),
    settingValue(env, 'sweepMaxDeletes'),
  ]);
  const deadline = Date.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  const dnsEnv = dnsRequestEnv(env, budgetMs);
  const startPage = await readCursor(env);
  const attemptsUsed = () => totals.deleted + totals.changed + totals.absent + totals.repointed;
  let page = startPage;
  let pagesRead = 0;
  let cycleComplete = false;
  let stoppedBy: AppRouteDnsSweepResult['stoppedBy'] = 'deadline';
  try {
    for (;;) {
      if (Date.now() >= deadline) break;
      if (attemptsUsed() >= maxDeletes) {
        stoppedBy = 'delete_limit';
        break;
      }
      const listed = await listAppRouteDnsRecordsPage(dnsEnv, { page, perPage }, signal);
      pagesRead++;
      totals.unparsed += listed.providerCount - listed.records.length;
      const counts = await cleanupRecords(dnsEnv, listed.records, {
        trigger: 'sweep',
        maxDeletes: maxDeletes - attemptsUsed(),
        deadline,
        signal,
      });
      addCounts(totals, counts);
      if (counts.deferred > 0) {
        // Out of budget part-way through this page: resume on it next sweep.
        stoppedBy = Date.now() >= deadline ? 'deadline' : 'delete_limit';
        break;
      }
      if (listed.providerCount < perPage) {
        cycleComplete = true;
        stoppedBy = 'end_of_zone';
        page = 1;
        break;
      }
      // Deletions shift later records onto this page; read it again rather than skip them.
      // Each re-read follows at least one removal, so the loop always makes progress.
      if (counts.deleted === 0 && counts.absent === 0) page++;
    }
  } catch (error) {
    // The budget's own abort is a clean stop at the deadline, not a sweep failure.
    if (!signal.aborted) throw error;
    stoppedBy = 'deadline';
  } finally {
    if (page !== startPage) await env.KV.put(APP_ROUTE_DNS_SWEEP_CURSOR_KEY, String(page));
  }
  const result: AppRouteDnsSweepResult = {
    ...totals,
    pagesRead,
    startPage,
    nextPage: page,
    cycleComplete,
    stoppedBy,
  };
  log.info('dns.app_route_sweep_completed', { ...result });
  // A record that could not be judged is reported as a failure on every run until its
  // environment row is repaired, so it can never dangle behind a sweep that reports success.
  if (totals.failed > 0 || totals.unknown > 0) {
    throw new Error(
      `App-route DNS sweep failed to delete ${totals.failed} dangling record(s) and could not judge ${totals.unknown}`
    );
  }
  return result;
}
