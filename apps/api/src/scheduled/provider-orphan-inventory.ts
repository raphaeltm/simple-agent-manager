import * as v from 'valibot';

import type { Env } from '../env';

export const PROVIDER_ORPHAN_NODE_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/i;

export interface ClaimingNode {
  status: string;
  providerInstanceId: string | null;
}

/**
 * Return one explicit found/absent result per requested node. Successful subsets
 * are not authoritative absence and fail cardinality validation.
 */
export async function loadClaimingNodeStatuses(
  env: Env,
  nodeIds: string[]
): Promise<Map<string, ClaimingNode>> {
  const requestedRows = nodeIds.map(() => '(?)').join(', ');
  const rawResult: unknown = await env.DATABASE.prepare(
    `WITH requested(requested_id) AS (VALUES ${requestedRows})
     SELECT requested.requested_id, nodes.id, nodes.status, nodes.provider_instance_id
     FROM requested
     LEFT JOIN nodes ON lower(nodes.id) = requested.requested_id`
  )
    .bind(...nodeIds)
    .all<Record<string, unknown>>();
  const parsedResult = v.parse(claimingNodeResultSchema, rawResult);
  if (parsedResult.results.length !== nodeIds.length) {
    throw new Error('D1 claim lookup returned a partial or expanded inventory result');
  }
  const statuses = new Map<string, ClaimingNode>();
  const requestedIds = new Set(nodeIds);
  for (const row of parsedResult.results) addClaimingNode(statuses, requestedIds, row);
  return statuses;
}

function addClaimingNode(
  statuses: Map<string, ClaimingNode>,
  requestedIds: Set<string>,
  row: v.InferOutput<typeof claimingNodeRowSchema>
): void {
  const requestedId = row.requested_id.toLowerCase();
  if (!PROVIDER_ORPHAN_NODE_ID_PATTERN.test(requestedId) || !requestedIds.delete(requestedId)) {
    throw new Error('D1 claim lookup returned an unexpected node identity');
  }
  if (row.id === null) return;
  if (row.id.toLowerCase() !== requestedId) {
    throw new Error('D1 claim lookup returned a mismatched node identity');
  }
  statuses.set(requestedId, {
    status: row.status,
    providerInstanceId: row.provider_instance_id ?? null,
  });
}

const claimingNodeRowSchema = v.union([
  v.object({
    requested_id: v.string(),
    id: v.null(),
    status: v.null(),
    provider_instance_id: v.null(),
  }),
  v.object({
    requested_id: v.string(),
    id: v.string(),
    status: v.string(),
    provider_instance_id: v.optional(v.nullable(v.string())),
  }),
]);

const claimingNodeResultSchema = v.object({
  success: v.literal(true),
  results: v.array(claimingNodeRowSchema),
});
