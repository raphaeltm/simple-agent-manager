/**
 * Which workspace placements came from the warm pool, for Admin Health & cost's reuse tile.
 *
 * Condition: "this placement took a machine out of the warm pool". Record: the node decision
 * log's `node_lifecycle` / `claimed` / `warm_node_reused` row, written by the NodeLifecycle DO
 * before the task creates its workspace row (`tryClaimWarmNode` → `workspace-placement.ts`), and
 * the `claim_released` row written when an unused claim is given back.
 *
 * Claims are attributed to placements rather than counted on their own: the log keeps claims
 * whose workspace row was later deleted (`workspace-cleanup.ts`, node delete), and claims that
 * were released unused, so a bare count can exceed the placements it is meant to be part of.
 * A placement is from the warm pool when an unreleased claim on its machine falls after the
 * previous placement read on that machine and at or before this one.
 *
 * Cost: one range read on `idx_node_lifecycle_decisions_created` over the window, residual-
 * filtered to two decision kinds, capped at the placement cap; attribution is a sort and one
 * pass per machine in memory. The decision log keeps `nodeDecisionLogRetentionDays` (14 by
 * default), so placements older than that cannot be credited and the figure is a lower bound.
 */
import { log } from '@simple-agent-manager/worker-core';

import { type HealthWindowBounds, storedTimeMs } from './insights-installation-compute';
import type { OperationContext } from './types';

export interface WarmClaimEvent {
  nodeId: string;
  kind: 'claimed' | 'released';
  atMs: number;
}

export interface PlacementTime {
  id: string;
  nodeId: string;
  atMs: number;
}

export interface WarmClaimRead {
  events: WarmClaimEvent[];
  /**
   * The cap was reached and the oldest events were not read. A kept claim's later release is
   * always kept too, so this only undercounts the warm-pool part.
   */
  truncated: boolean;
}

interface DecisionRow {
  node_id: string;
  decision: string;
  created_at: string;
}

/** Newest-first claims and releases in the read window; undefined when the log cannot be read. */
export async function readWarmClaims(
  ctx: Pick<OperationContext, 'env'>,
  bounds: HealthWindowBounds,
  maxEvents: number
): Promise<WarmClaimRead | undefined> {
  try {
    const { results } = await ctx.env.DATABASE.prepare(
      `SELECT node_id, decision, created_at FROM node_lifecycle_decisions
        WHERE created_at >= ? AND created_at < ?
          AND source = 'node_lifecycle'
          AND ((decision = 'claimed' AND reason = 'warm_node_reused') OR decision = 'claim_released')
        ORDER BY created_at DESC
        LIMIT ?`
    )
      .bind(
        new Date(bounds.readStartMs).toISOString(),
        new Date(bounds.nowMs).toISOString(),
        maxEvents + 1
      )
      .all<DecisionRow>();
    const rows = results ?? [];
    const truncated = rows.length > maxEvents;
    const events: WarmClaimEvent[] = [];
    for (const row of rows.slice(0, maxEvents)) {
      const atMs = storedTimeMs(row.created_at);
      if (atMs === null) {
        log.warn('insights_installation.warm_claim_row_skipped', {
          nodeId: row.node_id,
          reason: 'unreadable_timestamp',
          action: 'skipped',
        });
        continue;
      }
      events.push({
        nodeId: row.node_id,
        kind: row.decision === 'claimed' ? 'claimed' : 'released',
        atMs,
      });
    }
    return { events, truncated };
  } catch (error) {
    // The reuse rate still stands; only the warm-pool part becomes unknown.
    log.warn('insights_installation.warm_claims_unavailable', {
      error: error instanceof Error ? error.message : String(error),
      action: 'reported_unknown',
    });
    return undefined;
  }
}

/**
 * Ids of the placements an unreleased warm claim on the same machine preceded, since the previous
 * placement on that machine. `placements` must hold every placement read on each machine from
 * `sinceMs` on, so "previous placement read" is the real previous one for any claim at or after
 * `sinceMs`. A claim at the same millisecond as a placement counts for it.
 */
/** Binary id order, matching the SQL tie-break (`p.id < w.id`). */
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function warmPlacementIds(
  placements: readonly PlacementTime[],
  events: readonly WarmClaimEvent[],
  sinceMs: number
): Set<string> {
  type Step = { atMs: number; order: number; placementId?: string; kind?: WarmClaimEvent['kind'] };
  const byNode = new Map<string, Step[]>();
  const add = (nodeId: string, step: Step) => {
    const steps = byNode.get(nodeId);
    if (steps) steps.push(step);
    else byNode.set(nodeId, [step]);
  };
  // At one instant: claim, then release, then placement.
  for (const event of events) {
    if (event.atMs < sinceMs) continue;
    add(event.nodeId, {
      atMs: event.atMs,
      order: event.kind === 'claimed' ? 0 : 1,
      kind: event.kind,
    });
  }
  for (const placement of placements) {
    add(placement.nodeId, { atMs: placement.atMs, order: 2, placementId: placement.id });
  }

  const warm = new Set<string>();
  for (const steps of byNode.values()) {
    steps.sort(
      (a, b) =>
        a.atMs - b.atMs || a.order - b.order || byId(a.placementId ?? '', b.placementId ?? '')
    );
    let pendingClaim = false;
    for (const step of steps) {
      if (step.kind === 'claimed') pendingClaim = true;
      else if (step.kind === 'released') pendingClaim = false;
      else if (step.placementId !== undefined) {
        if (pendingClaim) warm.add(step.placementId);
        pendingClaim = false;
      }
    }
  }
  return warm;
}
