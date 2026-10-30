import type {
  ActiveComputeSession,
  AdminUserNodeDetailedUsage,
  AdminUserNodeUsageSummary,
  ComputeUsagePeriod,
  CredentialSource,
} from '@simple-agent-manager/shared';
import { inArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { getCurrentPeriodBounds } from './compute-usage';
import {
  addNodeToTotals,
  calculateNodeUsageTotalsForRows,
  createEmptyTotals,
  getAllOverlappingNodeRows,
  getUserOverlappingNodeRows,
  roundUsageTotals,
  toActiveComputeSession,
  toNodeUsageRecord,
} from './node-usage-calculation';
import { type NodeUsageTotals } from './node-usage-common';

/** Calculate node-based vCPU-hours for a user in a period. */
export async function calculateNodeVcpuHoursForPeriod(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  periodStart: Date,
  periodEnd: Date,
  credentialSource?: CredentialSource
): Promise<number> {
  const rows = await getUserOverlappingNodeRows(
    db,
    userId,
    periodStart.toISOString(),
    periodEnd.toISOString(),
    credentialSource
  );
  const totals = calculateNodeUsageTotalsForRows(rows, periodStart, periodEnd);

  return totals.totalVcpuHours;
}

/** Get the current user's node-based compute usage summary for the current period. */
export async function getUserNodeUsageSummary(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<{ period: ComputeUsagePeriod; activeSessions: ActiveComputeSession[] }> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  const now = new Date();
  const rows = await getUserOverlappingNodeRows(db, userId, start, end);
  const totals = calculateNodeUsageTotalsForRows(rows, periodStart, periodEnd, now);

  const activeSessions = rows.flatMap((node) => {
    const session = toActiveComputeSession(node);
    return session ? [session] : [];
  });

  const rounded = roundUsageTotals(totals);
  return {
    period: {
      start,
      end,
      totalNodeHours: rounded.totalNodeHours,
      totalVcpuHours: rounded.totalVcpuHours,
      platformNodeHours: rounded.platformNodeHours,
      platformVcpuHours: rounded.platformVcpuHours,
      userNodeHours: rounded.userNodeHours,
      userVcpuHours: rounded.userVcpuHours,
      activeNodes: rounded.activeNodes,
      activeWorkspaces: rounded.activeNodes,
    },
    activeSessions,
  };
}

// =============================================================================
// Admin: All Users Node Usage Summary
// =============================================================================

/** Get all users' node usage summary for the current period. */
export async function getAllUsersNodeUsageSummary(
  db: DrizzleD1Database<typeof schema>
): Promise<{ period: { start: string; end: string }; users: AdminUserNodeUsageSummary[] }> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  const now = new Date();

  const rows = await getAllOverlappingNodeRows(db, start, end);

  // Aggregate per user
  const userMap = new Map<string, NodeUsageTotals>();

  for (const node of rows) {
    const existing = userMap.get(node.userId) ?? createEmptyTotals();
    addNodeToTotals(existing, node, periodStart, periodEnd, now);
    userMap.set(node.userId, existing);
  }

  // Fetch user details
  const userIds = Array.from(userMap.keys());
  if (userIds.length === 0) {
    return { period: { start, end }, users: [] };
  }

  const users = (
    await Promise.all(
      chunk(userIds, D1_MAX_BOUND_PARAMETERS).map((ids) =>
        db
          .select({
            id: schema.users.id,
            email: schema.users.email,
            name: schema.users.name,
            avatarUrl: schema.users.avatarUrl,
          })
          .from(schema.users)
          .where(inArray(schema.users.id, ids))
      )
    )
  ).flat();

  const userLookup = new Map(users.map((u) => [u.id, u]));

  const summaries: AdminUserNodeUsageSummary[] = userIds
    .map((userId) => {
      const usage = roundUsageTotals(userMap.get(userId) ?? createEmptyTotals());
      const user = userLookup.get(userId);
      return {
        userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        totalNodeHours: usage.totalNodeHours,
        totalVcpuHours: usage.totalVcpuHours,
        platformNodeHours: usage.platformNodeHours,
        activeNodes: usage.activeNodes,
      };
    })
    .sort((a, b) => b.totalNodeHours - a.totalNodeHours);

  return { period: { start, end }, users: summaries };
}

// =============================================================================
// Admin: Per-User Node Detail
// =============================================================================

/** Get detailed node usage for a specific user. */
export async function getUserNodeDetailedUsage(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  recentLimit = 50
): Promise<AdminUserNodeDetailedUsage> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  const now = new Date();

  const allNodeRows = await getUserOverlappingNodeRows(db, userId, start, end);
  const nodeRows = allNodeRows.slice(0, recentLimit);

  // Count workspaces per node
  const nodeIds = nodeRows.map((n) => n.id);
  const workspaceCounts = new Map<string, number>();

  if (nodeIds.length > 0) {
    const wsRows = await db
      .select({
        nodeId: schema.workspaces.nodeId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.workspaces)
      .where(inArray(schema.workspaces.nodeId, nodeIds))
      .groupBy(schema.workspaces.nodeId);

    for (const row of wsRows) {
      if (row.nodeId) workspaceCounts.set(row.nodeId, row.count);
    }
  }

  const totals = roundUsageTotals(
    calculateNodeUsageTotalsForRows(allNodeRows, periodStart, periodEnd, now)
  );
  const nodes = nodeRows.map((node) => toNodeUsageRecord(node, workspaceCounts));

  return {
    period: { start, end },
    totalNodeHours: totals.totalNodeHours,
    totalVcpuHours: totals.totalVcpuHours,
    platformNodeHours: totals.platformNodeHours,
    activeNodes: totals.activeNodes,
    nodes,
  };
}
