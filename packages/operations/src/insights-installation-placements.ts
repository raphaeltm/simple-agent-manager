/**
 * Machine reuse, why new machines were created, and agents per busy machine, for Admin Health &
 * cost. All three read workspace-role machines that ran during the window
 * (`MANAGED_NODE_RAN_IN_WINDOW_SQL`) and reach workspaces through `idx_workspaces_node_id`.
 *
 * Reuse — condition: "this placement went onto a machine that already existed". Record: the
 * workspace order on its machine. A workspace is a new-machine placement when no earlier
 * workspace exists on that machine. `placement_explanation_json.diagnostics.selectedNodeId` is
 * not used: provisioning rewrites it to the new machine, so it reads the same for both cases.
 * The node decision log's warm-pool claims (`node_lifecycle` / `claimed` / `warm_node_reused`)
 * are reported as the part of reuse that came from the warm pool; they are not the whole rate,
 * because packing onto a busy machine records no decision.
 *
 * New-machine reasons — the first workspace on each new machine carries the capacity gate's
 * verdict on every existing machine it considered (`diagnostics.hosts[].reasons`), each reason
 * naming one condition (`.claude/rules/74`). Machine rows themselves rarely carry diagnostics.
 *
 * Agents per busy machine — running intervals come from resource telemetry
 * (`workspace_resource_summaries.started_at`..`ended_at`, first to last sample while the
 * workspace ran). `compute_usage` is not used: its intervals run from creation to deletion, so
 * stopped-but-undeleted workspaces inflate overlap (Library
 * /architecture/capacity-pools/sam-capacity-pools.html §03).
 */
import type {
  InstallationMachineDensity,
  InstallationMachineReuse,
  InstallationNewMachineReason,
  InstallationNewMachineReasonKind,
  InstallationNewMachineReasons,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import {
  type HealthWindowBounds,
  MANAGED_NODE_RAN_IN_WINDOW_SQL,
  storedTimeMs,
} from './insights-installation-compute';
import type { OperationContext } from './types';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/**
 * Longest reason text returned. Capacity-gate reasons are short fixed phrases today; this only
 * bounds the response if a producer ever interpolates something long.
 */
const MAX_REASON_CHARS = 200;

/** Labels for the two reasons that are not the capacity gate's own words. */
export const NO_CANDIDATE_REASON = 'No other machine in the pool to try';
export const NOT_RECORDED_REASON = 'Placement explanation not recorded';

interface PlacementRow {
  id: string;
  node_id: string;
  created_at: string;
  reused: number;
  /** `diagnostics.hosts` of a new-machine placement; null for reuse or when absent/invalid. */
  hosts_json: string | null;
}

interface RunRow {
  node_id: string;
  started_at: number;
  ended_at: number;
}

export interface PlacementSections {
  reuse: InstallationMachineReuse;
  newMachines: InstallationNewMachineReasons;
}

const isoBinds = (bounds: HealthWindowBounds) => [
  new Date(bounds.nowMs).toISOString(),
  new Date(bounds.readStartMs).toISOString(),
];

/**
 * Distinct refusal reasons a new-machine placement recorded against the existing machines it
 * considered, or the single synthetic reason when there were none / nothing readable.
 * Never throws: a malformed row is a `not_recorded` placement.
 */
export function newMachineReasonsFor(
  row: Pick<PlacementRow, 'id' | 'node_id' | 'hosts_json'>
): { reason: string; kind: InstallationNewMachineReasonKind }[] {
  if (row.hosts_json === null) return [{ reason: NOT_RECORDED_REASON, kind: 'not_recorded' }];
  let hosts: unknown;
  try {
    hosts = JSON.parse(row.hosts_json) as unknown;
  } catch (error) {
    log.warn('insights_installation.placement_row_skipped', {
      workspaceId: row.id,
      reason: 'unreadable_hosts',
      error: error instanceof Error ? error.message : String(error),
      action: 'counted_not_recorded',
    });
    return [{ reason: NOT_RECORDED_REASON, kind: 'not_recorded' }];
  }
  if (!Array.isArray(hosts)) return [{ reason: NOT_RECORDED_REASON, kind: 'not_recorded' }];
  const reasons = new Set<string>();
  let refusedHosts = 0;
  for (const host of hosts) {
    if (!host || typeof host !== 'object') continue;
    const record = host as Record<string, unknown>;
    if (record.outcome === 'selected' || record.nodeId === row.node_id) continue;
    refusedHosts += 1;
    if (!Array.isArray(record.reasons)) continue;
    for (const reason of record.reasons) {
      if (typeof reason === 'string' && reason.trim()) reasons.add(reason.trim());
    }
  }
  if (refusedHosts === 0) return [{ reason: NO_CANDIDATE_REASON, kind: 'no_candidate' }];
  if (reasons.size === 0) return [{ reason: NOT_RECORDED_REASON, kind: 'not_recorded' }];
  return [...reasons].map((reason) => ({ reason, kind: 'refused' as const }));
}

export async function readPlacementSections(
  ctx: Pick<OperationContext, 'env'>,
  bounds: HealthWindowBounds,
  maxPlacements: number,
  maxReasons: number
): Promise<PlacementSections> {
  // A tie on created_at is broken by id so exactly one workspace is first on a machine. The
  // placement JSON (kilobytes per row) is read back by primary key only for new-machine
  // placements, so reused placements never carry it through the sort. `json_valid` keeps one
  // malformed value from failing the statement.
  //
  // Lower bound: a machine whose first workspace row was later removed shows its next placement
  // as new. Not observed in production (2026-11-16: all 281 first placements in 30 days were
  // created within an hour of their machine).
  const placementsQuery = ctx.env.DATABASE.prepare(
    `SELECT x.id, x.node_id, x.created_at, x.reused,
            CASE WHEN json_valid(pw.placement_explanation_json)
                 THEN json_extract(pw.placement_explanation_json, '$.diagnostics.hosts') END
              AS hosts_json
       FROM (
         SELECT w.id, w.node_id, w.created_at,
                EXISTS (
                  SELECT 1 FROM workspaces p
                   WHERE p.node_id = w.node_id
                     AND (p.created_at < w.created_at OR (p.created_at = w.created_at AND p.id < w.id))
                ) AS reused
           FROM nodes n
           JOIN workspaces w ON w.node_id = n.id
          WHERE ${MANAGED_NODE_RAN_IN_WINDOW_SQL}
            AND n.node_role = 'workspace'
            AND w.created_at >= ? AND w.created_at < ?
          ORDER BY w.created_at DESC, w.id DESC
          LIMIT ?
       ) x
       LEFT JOIN workspaces pw ON pw.id = x.id AND x.reused = 0`
  ).bind(
    ...isoBinds(bounds),
    new Date(bounds.readStartMs).toISOString(),
    new Date(bounds.nowMs).toISOString(),
    maxPlacements + 1
  );
  const warmClaimsQuery = ctx.env.DATABASE.prepare(
    `SELECT COUNT(*) AS claims FROM node_lifecycle_decisions
      WHERE created_at >= ? AND created_at < ?
        AND source = 'node_lifecycle' AND decision = 'claimed' AND reason = 'warm_node_reused'`
  ).bind(new Date(bounds.rangeStartMs).toISOString(), new Date(bounds.nowMs).toISOString());

  const [placementResult, warmClaims] = await Promise.all([
    placementsQuery.all<PlacementRow>(),
    // A failed count leaves the reuse rate standing and reports the warm-pool part as unknown.
    warmClaimsQuery.first<{ claims: number }>().catch((error: unknown) => {
      log.warn('insights_installation.warm_claims_unavailable', {
        error: error instanceof Error ? error.message : String(error),
        action: 'reported_unknown',
      });
      return undefined;
    }),
  ]);
  const rows = placementResult.results ?? [];
  const truncated = rows.length > maxPlacements;

  let placements = 0;
  let onExisting = 0;
  const weekly = bounds.weekStarts.map(() => ({ placements: 0, reused: 0 }));
  const reasonCounts = new Map<
    string,
    { kind: InstallationNewMachineReasonKind; machines: number }
  >();
  let newMachines = 0;

  for (const row of rows.slice(0, maxPlacements)) {
    const at = storedTimeMs(row.created_at);
    if (at === null) {
      log.warn('insights_installation.placement_row_skipped', {
        workspaceId: row.id,
        reason: 'unreadable_timestamp',
        action: 'skipped',
      });
      continue;
    }
    const reused = Number(row.reused) === 1;
    const week =
      weekly[bounds.weekStarts.findIndex((start) => at >= start && at < start + WEEK_MS)];
    if (week) {
      week.placements += 1;
      if (reused) week.reused += 1;
    }
    if (at < bounds.rangeStartMs) continue;
    placements += 1;
    if (reused) {
      onExisting += 1;
      continue;
    }
    newMachines += 1;
    for (const { reason, kind } of newMachineReasonsFor(row)) {
      const entry = reasonCounts.get(reason) ?? { kind, machines: 0 };
      entry.machines += 1;
      reasonCounts.set(reason, entry);
    }
  }

  const ranked: InstallationNewMachineReason[] = [...reasonCounts.entries()]
    .map(([reason, entry]) => ({
      reason:
        reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason,
      kind: entry.kind,
      machines: entry.machines,
    }))
    .sort((a, b) => b.machines - a.machines || a.reason.localeCompare(b.reason));
  // Most common first; the rest are disclosed as a count, never silently dropped (rule 65).
  const reasons = ranked.slice(0, maxReasons);
  const otherReasons = ranked.length - reasons.length;

  return {
    reuse: {
      placements,
      onExistingMachine: onExisting,
      onNewMachine: placements - onExisting,
      fromWarmPool: warmClaims === undefined ? null : Number(warmClaims?.claims ?? 0),
      reuseRate: placements > 0 ? onExisting / placements : null,
      weeks: bounds.weekStarts.map((weekStart, index) => {
        const week = weekly[index] ?? { placements: 0, reused: 0 };
        return {
          weekStart: new Date(weekStart).toISOString(),
          placements: week.placements,
          reuseRate: week.placements > 0 ? week.reused / week.placements : null,
        };
      }),
      truncated,
    },
    newMachines: { newMachines, reasons, otherReasons },
  };
}

/**
 * Time-weighted agents per machine while it had at least one agent running. Per machine, a sweep
 * over interval edges integrates "agents running" and "at least one running"; the result is the
 * sum of agent-time over the sum of busy time across machines.
 */
export function densityFromRuns(
  runs: readonly { nodeId: string; startMs: number; endMs: number }[],
  fromMs: number,
  toMs: number
): Omit<InstallationMachineDensity, 'runs' | 'truncated'> {
  const edgesByNode = new Map<string, { at: number; delta: number }[]>();
  for (const run of runs) {
    const start = Math.max(run.startMs, fromMs);
    const end = Math.min(run.endMs, toMs);
    if (!(end > start)) continue;
    const edges = edgesByNode.get(run.nodeId) ?? [];
    edges.push({ at: start, delta: 1 }, { at: end, delta: -1 });
    edgesByNode.set(run.nodeId, edges);
  }
  let busyMs = 0;
  let agentMs = 0;
  let peak = 0;
  for (const edges of edgesByNode.values()) {
    // Ends before starts at the same instant, so back-to-back runs are not counted as overlap.
    edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let running = 0;
    let previous = edges[0]?.at ?? 0;
    for (const edge of edges) {
      const span = edge.at - previous;
      if (running > 0 && span > 0) {
        busyMs += span;
        agentMs += span * running;
      }
      running += edge.delta;
      peak = Math.max(peak, running);
      previous = edge.at;
    }
  }
  return {
    agentsPerBusyMachine: busyMs > 0 ? Math.round((agentMs / busyMs) * 100) / 100 : null,
    busyMachineHours: Math.round((busyMs / HOUR_MS) * 10) / 10,
    agentHours: Math.round((agentMs / HOUR_MS) * 10) / 10,
    peakAgentsOnOneMachine: peak,
    machines: edgesByNode.size,
  };
}

export async function readMachineDensity(
  ctx: Pick<OperationContext, 'env'>,
  bounds: HealthWindowBounds,
  maxRuns: number
): Promise<InstallationMachineDensity> {
  const { results } = await ctx.env.DATABASE.prepare(
    `SELECT n.id AS node_id, r.started_at, r.ended_at
       FROM nodes n
       JOIN workspaces w ON w.node_id = n.id
       JOIN workspace_resource_summaries r ON r.project_id = w.project_id AND r.workspace_id = w.id
      WHERE ${MANAGED_NODE_RAN_IN_WINDOW_SQL}
        AND n.node_role = 'workspace'
        AND r.ended_at >= ? AND r.started_at < ?
      ORDER BY r.ended_at DESC, r.id DESC
      LIMIT ?`
  )
    .bind(...isoBinds(bounds), bounds.rangeStartMs, bounds.nowMs, maxRuns + 1)
    .all<RunRow>();
  const rows = results ?? [];
  const runs: { nodeId: string; startMs: number; endMs: number }[] = [];
  for (const row of rows.slice(0, maxRuns)) {
    const startMs = Number(row.started_at);
    const endMs = Number(row.ended_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      log.warn('insights_installation.run_row_skipped', {
        nodeId: row.node_id,
        reason: 'unreadable_interval',
        action: 'skipped',
      });
      continue;
    }
    runs.push({ nodeId: row.node_id, startMs, endMs });
  }
  return {
    ...densityFromRuns(runs, bounds.rangeStartMs, bounds.nowMs),
    runs: runs.length,
    truncated: rows.length > maxRuns,
  };
}
