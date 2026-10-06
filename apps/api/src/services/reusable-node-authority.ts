import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';

import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { buildPlacementAuthoritySqlPredicate } from './placement-authority';

export interface ReusableNodeAuthoritySelection {
  nodeId: string;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
}

/**
 * Rank only hosts that can pass the same authority gate as final reservation.
 * Otherwise a draining host wins every retry and prevents provisioning forever.
 * Group identical snapshots so many hosts sharing an offering cost one read,
 * splitting only to respect D1's bound-parameter ceiling.
 */
export async function filterReusableNodesByCurrentAuthority(
  database: D1Database,
  input: {
    userId: string;
    projectId: string;
    selections: readonly ReusableNodeAuthoritySelection[];
  }
): Promise<Set<string>> {
  const groups = new Map<string, ReusableNodeAuthoritySelection[]>();
  for (const selection of input.selections) {
    const key = JSON.stringify(selection.capacityPlacementSnapshot);
    const group = groups.get(key) ?? [];
    group.push(selection);
    groups.set(key, group);
  }

  const eligible = new Set<string>();
  for (const selections of groups.values()) {
    const first = selections[0];
    if (!first) continue;
    const predicate = buildPlacementAuthoritySqlPredicate({
      userId: input.userId,
      projectId: input.projectId,
      nodeRole: 'workspace',
      workloadRole: 'workspace',
      capacityPlacementSnapshot: first.capacityPlacementSnapshot,
    });
    const chunkSize = D1_MAX_BOUND_PARAMETERS - predicate.binds.length;
    if (chunkSize <= 0) throw new Error('Placement authority exceeds D1 parameter limit');
    for (let offset = 0; offset < selections.length; offset += chunkSize) {
      const ids = selections.slice(offset, offset + chunkSize).map((selection) => selection.nodeId);
      const rows = await database
        .prepare(
          `SELECT n.id FROM nodes n
            WHERE n.id IN (${ids.map(() => '?').join(', ')})
              AND n.status = 'running'
              ${predicate.sql}`
        )
        .bind(...ids, ...predicate.binds)
        .all<{ id: string }>();
      for (const row of rows.results) eligible.add(row.id);
    }
  }
  return eligible;
}
