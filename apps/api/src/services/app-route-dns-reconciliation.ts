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
 *   covered. On a VM it runs before the provider deletion (while SAM still holds the IP) and
 *   again after it (for a release fetch that landed in between); a failed delete throws, so the
 *   node is not retired (which clears its IP) and the next attempt repeats it (fail closed).
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
import { resolveAdminSetting } from './admin-settings';
import {
  APP_ROUTE_DNS_RUNTIME_DEFAULTS,
  type AppRouteDnsSettingName,
} from './admin-settings-app-route-dns-definitions';
import {
  addCounts,
  type AppRouteCleanupCounts,
  cleanupRecords,
  dnsRequestEnv,
  emptyCounts,
} from './app-route-dns-cleanup';
import { appRouteRecordAddress } from './app-route-dns-target';
import {
  appRouteNameSuffix,
  hasAppRouteDnsApi,
  listAppRouteDnsRecordsPage,
} from './dns-app-route-inventory';

export {
  APP_ROUTE_DNS_FAILURE_BACKOFF_PREFIX,
  type AppRouteCleanupCounts,
  type AppRouteVerdict,
  judgeAppRouteRecord,
} from './app-route-dns-cleanup';

/** KV key holding the next page the sweep reads (1-based). */
export const APP_ROUTE_DNS_SWEEP_CURSOR_KEY = 'dns:app-route-sweep:next-page';

async function settingValue(
  env: Env,
  key: keyof typeof APP_ROUTE_DNS_RUNTIME_DEFAULTS
): Promise<number> {
  const name: AppRouteDnsSettingName = `appRouteDns.${key}`;
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' ? value : APP_ROUTE_DNS_RUNTIME_DEFAULTS[key];
}

/**
 * The addresses a releasing node's records can point at: its own IP, plus the address its
 * records point at when that differs (a reverse-tunnel node's records point at the box, written
 * even when the node has no IP of its own). Null when there is nothing to clean: wildcard-covered
 * routes never had per-route records (`upsertReleaseRouteRecords`), and a node with neither an
 * IP nor a transport address never had any. An address that cannot be resolved (a misconfigured
 * reverse-tunnel install) is not a reason to keep the VM: cleanup proceeds by IP.
 */
function releaseAddresses(
  env: Env,
  node: { id: string; ipAddress: string | null; transport?: string | null }
): Set<string> | null {
  const addresses = new Set<string>();
  if (node.ipAddress) addresses.add(node.ipAddress);
  try {
    const resolved = appRouteRecordAddress(
      { transport: node.transport ?? null, ipAddress: node.ipAddress },
      env
    );
    if (resolved.covered) return null;
    if (resolved.address) addresses.add(resolved.address);
  } catch (error) {
    log.error('dns.app_route_release_address_unresolved', {
      nodeId: node.id,
      transport: node.transport ?? null,
      error: error instanceof Error ? error.message : String(error),
      action: 'cleanup_by_ip',
    });
  }
  return addresses.size > 0 ? addresses : null;
}

/**
 * Delete every app-route record still pointing at a node SAM is releasing. Called from every
 * branch of `deleteNodeResourcesStrict` (on a VM, before and after the provider deletion), so
 * every release path runs it.
 * Throws when a record could not be deleted in time, so the node stays in its retryable teardown
 * state instead of being retired with a record pointing at an IP the provider may reassign.
 * A record whose environment row cannot be read is logged and left to the sweep rather than
 * wedging the teardown forever (`.claude/rules/71`).
 */
export async function releaseNodeAppRouteDnsRecords(
  env: Env,
  node: {
    id: string;
    nodeRole: string | null;
    ipAddress: string | null;
    transport?: string | null;
  },
  signal?: AbortSignal
): Promise<AppRouteCleanupCounts | null> {
  // Only deployment nodes serve app routes; any other node's IP is left to the sweep, so a
  // DNS outage cannot block workspace teardown.
  if (node.nodeRole !== 'deployment') return null;
  // No BASE_DOMAIN: no app-route name can exist (every one is built under `.apps.<BASE_DOMAIN>`).
  if (!appRouteNameSuffix(env.BASE_DOMAIN)) return null;
  const addresses = releaseAddresses(env, node);
  if (!addresses) return null;
  // Without a DNS API the release fetch cannot write a route record either, so there is
  // nothing this teardown could protect by refusing; refusing would only keep the VM billed.
  // Logged loudly, and the sweep reports `no_dns_api` on every run.
  if (!hasAppRouteDnsApi(env)) {
    log.error('dns.app_route_release_no_dns_api', { nodeId: node.id, action: 'skipped' });
    return null;
  }
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
  for (const content of addresses) {
    if (content === node.ipAddress) {
      unparsed += await releaseRecordsAt(
        dnsEnv,
        node.id,
        content,
        perPage,
        counts,
        effectiveSignal
      );
      continue;
    }
    // A shared ingress address (the box) is never released with this node, so its records are
    // no takeover risk, and other environments' records share it: only records of environments
    // linked to this node are touched (`ownedByNodeId`), best-effort, the rest left to the sweep.
    const shared = emptyCounts();
    try {
      unparsed += await releaseRecordsAt(
        dnsEnv,
        node.id,
        content,
        perPage,
        shared,
        effectiveSignal,
        { ownedOnly: true }
      );
    } catch (error) {
      log.error('dns.app_route_release_shared_address_failed', {
        nodeId: node.id,
        content,
        error: error instanceof Error ? error.message : String(error),
        action: 'left_to_sweep',
      });
    }
    if (shared.failed + shared.deferred > 0) {
      log.error('dns.app_route_release_shared_address_incomplete', {
        nodeId: node.id,
        content,
        failed: shared.failed,
        deferred: shared.deferred,
        action: 'left_to_sweep',
      });
    }
    addCounts(counts, { ...shared, failed: 0, deferred: 0 });
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

/** Release cleanup of the records at one address, page by page; returns the unparsed count. */
async function releaseRecordsAt(
  dnsEnv: Env,
  nodeId: string,
  content: string,
  perPage: number,
  counts: AppRouteCleanupCounts,
  signal: AbortSignal,
  options: { ownedOnly?: boolean } = {}
): Promise<number> {
  let unparsed = 0;
  for (let page = 1; ;) {
    const result = await listAppRouteDnsRecordsPage(dnsEnv, { page, perPage, content }, signal);
    unparsed += result.providerCount - result.records.length;
    const pageCounts = await cleanupRecords(dnsEnv, result.records, {
      trigger: 'node_release',
      nodeId,
      maxDeletes: Number.POSITIVE_INFINITY,
      deadline: Number.POSITIVE_INFINITY,
      signal,
      ownedByNodeId: options.ownedOnly ? nodeId : undefined,
    });
    addCounts(counts, pageCounts);
    if (result.providerCount < perPage || pageCounts.deferred > 0) break;
    // `changed` records may also have been rewritten off the filter by a release fetch in flight.
    if (pageCounts.deleted + pageCounts.absent + pageCounts.repointed + pageCounts.changed === 0) {
      page++;
    }
  }
  return unparsed;
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
  stoppedBy: 'end_of_zone' | 'deadline' | 'delete_limit' | 'no_base_domain' | 'no_dns_api';
}

/** The cron backstop: scan the zone's app-route records page by page and delete dangling ones. */
export async function runAppRouteDnsReconciliation(env: Env): Promise<AppRouteDnsSweepResult> {
  const totals = emptyCounts();
  const skipReason = !appRouteNameSuffix(env.BASE_DOMAIN)
    ? ('no_base_domain' as const)
    : !hasAppRouteDnsApi(env)
      ? ('no_dns_api' as const)
      : null;
  if (skipReason) {
    const result = {
      ...totals,
      pagesRead: 0,
      startPage: 1,
      nextPage: 1,
      cycleComplete: false,
      stoppedBy: skipReason,
    };
    log.info('dns.app_route_sweep_completed', { ...result });
    return result;
  }
  const [budgetMs, perPage, maxDeletes, failureBackoffSeconds] = await Promise.all([
    settingValue(env, 'sweepBudgetMs'),
    settingValue(env, 'sweepPageSize'),
    settingValue(env, 'sweepMaxDeletes'),
    settingValue(env, 'failureBackoffSeconds'),
  ]);
  const deadline = Date.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  const dnsEnv = dnsRequestEnv(env, budgetMs);
  const startPage = await readCursor(env);
  // Failed mutations spend the cap too once their backoff is recorded (`cleanupRecords`), so a
  // fast-failing DNS API cannot turn one sweep into a burst over every record.
  const attemptsUsed = () => totals.attempts;
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
        failureBackoffSeconds,
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
  if (totals.failed > 0 || totals.unknown > 0 || totals.backedOff > 0) {
    throw new Error(
      `App-route DNS sweep failed to delete ${totals.failed + totals.backedOff} dangling record(s) and could not judge ${totals.unknown}`
    );
  }
  return result;
}
