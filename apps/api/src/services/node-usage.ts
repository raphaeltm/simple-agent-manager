import type {
  ActiveComputeSession,
  AdminUserNodeDetailedUsage,
  AdminUserNodeUsageSummary,
  ComputeUsagePeriod,
  CredentialSource,
  NodeUsageRecord,
} from '@simple-agent-manager/shared';
import { getVcpuCount, isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { getCurrentPeriodBounds } from './compute-usage';

// =============================================================================
// Node status helpers
// =============================================================================

const ENDED_STATUSES_ARRAY = ['destroyed', 'destroying', 'deleted', 'error'] as const;
const ENDED_STATUSES = new Set<string>(ENDED_STATUSES_ARRAY);

/**
 * Sentinel credential source for user-owned (BYO) nodes. SAM provisioned nothing for these, so they
 * cost SAM $0 and must be excluded from all vCPU-hour metering, admin cost, and quota accounting.
 */
const SELF_HOSTED_CREDENTIAL_SOURCE: CredentialSource = 'self-hosted';

function isNodeEnded(status: string): boolean {
  return ENDED_STATUSES.has(status);
}

/**
 * Derive the node's effective end time.
 * - If still running: null (use `now` for calculations)
 * - If ended: use updatedAt as the end time
 */
function getNodeEndedAt(status: string, updatedAt: string): string | null {
  return isNodeEnded(status) ? updatedAt : null;
}

/**
 * Calculate hours for a node within a period, clamped to period boundaries.
 */
function calculateNodeHoursInPeriod(
  createdAt: string,
  endedAt: string | null,
  periodStart: Date,
  periodEnd: Date,
  now: Date
): number {
  const start = new Date(createdAt);
  const end = endedAt ? new Date(endedAt) : now;

  const effectiveStart = start < periodStart ? periodStart : start;
  const effectiveEnd = end > periodEnd ? periodEnd : end;

  const ms = effectiveEnd.getTime() - effectiveStart.getTime();
  return ms > 0 ? ms / (1000 * 60 * 60) : 0;
}

export interface NodeUsageCalculationRow {
  vmSize: string;
  cloudProvider: string | null;
  credentialSource: string | null;
  /** Ownership class; user-owned (BYO) nodes accrue $0 regardless of credentialSource. */
  nodeClass: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface NodeUsageRow extends NodeUsageCalculationRow {
  id: string;
  name: string;
  vmLocation: string;
}

interface UserNodeUsageRow extends NodeUsageRow {
  userId: string;
}

export interface NodeUsageTotals {
  totalNodeHours: number;
  totalVcpuHours: number;
  platformNodeHours: number;
  platformVcpuHours: number;
  userNodeHours: number;
  userVcpuHours: number;
  activeNodes: number;
}

function createEmptyTotals(): NodeUsageTotals {
  return {
    totalNodeHours: 0,
    totalVcpuHours: 0,
    platformNodeHours: 0,
    platformVcpuHours: 0,
    userNodeHours: 0,
    userVcpuHours: 0,
    activeNodes: 0,
  };
}

function addNodeToTotals(
  totals: NodeUsageTotals,
  node: Pick<
    NodeUsageRow,
    | 'vmSize'
    | 'cloudProvider'
    | 'credentialSource'
    | 'nodeClass'
    | 'status'
    | 'createdAt'
    | 'updatedAt'
  >,
  periodStart: Date,
  periodEnd: Date,
  now: Date
): void {
  // User-owned (BYO) nodes cost SAM $0 — exclude them from every node-hour, vCPU-hour, and
  // active-node total so metering, admin cost (getAllUsersNodeUsageSummary → here), and quota
  // reflect only SAM-paid compute. Single chokepoint. See architecture-critique #9.
  //
  // Keyed on BOTH the canonical ownership axis (nodeClass='user-owned') AND the credentialSource
  // sentinel ('self-hosted'): every other Phase-0 guard uses nodeClass, so excluding on it here too
  // means billing can't silently re-include a BYO node if a future enrollment path sets nodeClass
  // but forgets the credentialSource sentinel (or vice-versa). See cloudflare/security review.
  if (
    isUserOwnedNodeClass(node.nodeClass) ||
    node.credentialSource === SELF_HOSTED_CREDENTIAL_SOURCE
  ) {
    return;
  }
  const endedAt = getNodeEndedAt(node.status, node.updatedAt);
  const hours = calculateNodeHoursInPeriod(node.createdAt, endedAt, periodStart, periodEnd, now);
  const vcpus = getVcpuCount(node.vmSize, node.cloudProvider);
  const vcpuHours = hours * vcpus;
  const isPlatform = node.credentialSource === 'platform';

  totals.totalNodeHours += hours;
  totals.totalVcpuHours += vcpuHours;
  if (isPlatform) {
    totals.platformNodeHours += hours;
    totals.platformVcpuHours += vcpuHours;
  } else {
    totals.userNodeHours += hours;
    totals.userVcpuHours += vcpuHours;
  }
  if (!isNodeEnded(node.status)) {
    totals.activeNodes += 1;
  }
}

export function calculateNodeUsageTotalsForRows(
  rows: NodeUsageCalculationRow[],
  periodStart: Date,
  periodEnd: Date,
  now: Date = new Date()
): NodeUsageTotals {
  const totals = createEmptyTotals();
  for (const node of rows) {
    addNodeToTotals(totals, node, periodStart, periodEnd, now);
  }
  return totals;
}

function roundUsageTotals(totals: NodeUsageTotals): NodeUsageTotals {
  return {
    totalNodeHours: Math.round(totals.totalNodeHours * 100) / 100,
    totalVcpuHours: Math.round(totals.totalVcpuHours * 100) / 100,
    platformNodeHours: Math.round(totals.platformNodeHours * 100) / 100,
    platformVcpuHours: Math.round(totals.platformVcpuHours * 100) / 100,
    userNodeHours: Math.round(totals.userNodeHours * 100) / 100,
    userVcpuHours: Math.round(totals.userVcpuHours * 100) / 100,
    activeNodes: totals.activeNodes,
  };
}

function getOverlappingNodeConditions(
  periodStartIso: string,
  periodEndIso: string,
  opts?: { userId?: string; credentialSource?: CredentialSource }
) {
  const conditions = [
    sql`${schema.nodes.createdAt} < ${periodEndIso}`,
    or(
      notInArray(schema.nodes.status, [...ENDED_STATUSES_ARRAY]),
      sql`${schema.nodes.updatedAt} > ${periodStartIso}`
    ),
  ];

  if (opts?.userId) {
    conditions.push(eq(schema.nodes.userId, opts.userId));
  }
  if (opts?.credentialSource) {
    conditions.push(eq(schema.nodes.credentialSource, opts.credentialSource));
  }

  return conditions;
}

async function getUserOverlappingNodeRows(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  periodStartIso: string,
  periodEndIso: string,
  credentialSource?: CredentialSource
): Promise<NodeUsageRow[]> {
  return db
    .select({
      id: schema.nodes.id,
      name: schema.nodes.name,
      vmSize: schema.nodes.vmSize,
      vmLocation: schema.nodes.vmLocation,
      cloudProvider: schema.nodes.cloudProvider,
      credentialSource: schema.nodes.credentialSource,
      nodeClass: schema.nodes.nodeClass,
      status: schema.nodes.status,
      createdAt: schema.nodes.createdAt,
      updatedAt: schema.nodes.updatedAt,
    })
    .from(schema.nodes)
    .where(
      and(
        ...getOverlappingNodeConditions(periodStartIso, periodEndIso, { userId, credentialSource })
      )
    )
    .orderBy(sql`${schema.nodes.createdAt} DESC`);
}

async function getAllOverlappingNodeRows(
  db: DrizzleD1Database<typeof schema>,
  periodStartIso: string,
  periodEndIso: string
): Promise<UserNodeUsageRow[]> {
  return db
    .select({
      id: schema.nodes.id,
      userId: schema.nodes.userId,
      name: schema.nodes.name,
      vmSize: schema.nodes.vmSize,
      vmLocation: schema.nodes.vmLocation,
      cloudProvider: schema.nodes.cloudProvider,
      credentialSource: schema.nodes.credentialSource,
      nodeClass: schema.nodes.nodeClass,
      status: schema.nodes.status,
      createdAt: schema.nodes.createdAt,
      updatedAt: schema.nodes.updatedAt,
    })
    .from(schema.nodes)
    .where(and(...getOverlappingNodeConditions(periodStartIso, periodEndIso)));
}

function toActiveComputeSession(node: NodeUsageRow): ActiveComputeSession | null {
  if (isNodeEnded(node.status)) {
    return null;
  }

  const credentialSource = (node.credentialSource ?? 'user') as CredentialSource;
  return {
    nodeId: node.id,
    name: node.name,
    workspaceId: node.id,
    serverType: node.vmSize,
    vmSize: node.vmSize,
    vcpuCount: getVcpuCount(node.vmSize, node.cloudProvider),
    startedAt: node.createdAt,
    createdAt: node.createdAt,
    credentialSource,
    status: node.status,
  };
}

function toNodeUsageRecord(
  node: NodeUsageRow,
  workspaceCounts: Map<string, number>
): NodeUsageRecord {
  return {
    nodeId: node.id,
    name: node.name,
    vmSize: node.vmSize,
    vcpuCount: getVcpuCount(node.vmSize, node.cloudProvider),
    vmLocation: node.vmLocation,
    cloudProvider: node.cloudProvider,
    credentialSource: (node.credentialSource ?? 'user') as CredentialSource,
    status: node.status,
    createdAt: node.createdAt,
    endedAt: getNodeEndedAt(node.status, node.updatedAt),
    workspaceCount: workspaceCounts.get(node.id) ?? 0,
  };
}

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

  const users = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(inArray(schema.users.id, userIds));

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
