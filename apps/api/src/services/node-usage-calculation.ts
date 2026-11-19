import type {
  ActiveComputeSession,
  CredentialSource,
  NodeUsageRecord,
} from '@simple-agent-manager/shared';
import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { and, eq, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { resolveComputeVcpuCount } from './compute-usage';
import {
  ENDED_STATUSES,
  ENDED_STATUSES_ARRAY,
  type NodeUsageCalculationRow,
  type NodeUsageRow,
  type NodeUsageTotals,
  SELF_HOSTED_CREDENTIAL_SOURCE,
  type UserNodeUsageRow,
} from './node-usage-common';

export function isNodeEnded(status: string): boolean {
  return ENDED_STATUSES.has(status);
}

/**
 * Derive the node's effective end time.
 * - If still running: null (use `now` for calculations)
 * - If ended: use updatedAt as the end time
 */
export function getNodeEndedAt(status: string, updatedAt: string): string | null {
  return isNodeEnded(status) ? updatedAt : null;
}

/**
 * Calculate hours for a node within a period, clamped to period boundaries.
 */
export function calculateNodeHoursInPeriod(
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

export function createEmptyTotals(): NodeUsageTotals {
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

export function addNodeToTotals(
  totals: NodeUsageTotals,
  node: NodeUsageCalculationRow,
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
  const { vcpuCount } = resolveComputeVcpuCount(node, { legacyNode: node });
  // Unknown CPU contributes no invented charge; node uptime remains accounted
  // and its active/detail record exposes null with source="unknown".
  const vcpuHours = vcpuCount === null ? 0 : hours * vcpuCount;
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

export function roundUsageTotals(totals: NodeUsageTotals): NodeUsageTotals {
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

export function getOverlappingNodeConditions(
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

export async function getUserOverlappingNodeRows(
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
      providerInstanceType: schema.nodes.providerInstanceType,
      providerInstanceVcpuCount: schema.nodes.providerInstanceVcpuCount,
      providerInstanceMemoryMb: schema.nodes.providerInstanceMemoryMb,
      providerInstanceDiskGb: schema.nodes.providerInstanceDiskGb,
      providerInstanceBootDiskSizeGb: schema.nodes.providerInstanceBootDiskSizeGb,
      providerInstanceImage: schema.nodes.providerInstanceImage,
      providerInstanceArchitecture: schema.nodes.providerInstanceArchitecture,
      observedProviderInstanceType: schema.nodes.observedProviderInstanceType,
      observedProviderInstanceVcpuCount: schema.nodes.observedProviderInstanceVcpuCount,
      observedProviderInstanceMemoryMb: schema.nodes.observedProviderInstanceMemoryMb,
      observedProviderInstanceDiskGb: schema.nodes.observedProviderInstanceDiskGb,
      observedHardwareJson: schema.nodes.observedHardwareJson,
      observedHardwareSource: schema.nodes.observedHardwareSource,
      providerInstancePriceDisplay: schema.nodes.providerInstancePriceDisplay,
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

export async function getAllOverlappingNodeRows(
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
      providerInstanceType: schema.nodes.providerInstanceType,
      providerInstanceVcpuCount: schema.nodes.providerInstanceVcpuCount,
      providerInstanceMemoryMb: schema.nodes.providerInstanceMemoryMb,
      providerInstanceDiskGb: schema.nodes.providerInstanceDiskGb,
      providerInstanceBootDiskSizeGb: schema.nodes.providerInstanceBootDiskSizeGb,
      providerInstanceImage: schema.nodes.providerInstanceImage,
      providerInstanceArchitecture: schema.nodes.providerInstanceArchitecture,
      observedProviderInstanceType: schema.nodes.observedProviderInstanceType,
      observedProviderInstanceVcpuCount: schema.nodes.observedProviderInstanceVcpuCount,
      observedProviderInstanceMemoryMb: schema.nodes.observedProviderInstanceMemoryMb,
      observedProviderInstanceDiskGb: schema.nodes.observedProviderInstanceDiskGb,
      observedHardwareJson: schema.nodes.observedHardwareJson,
      observedHardwareSource: schema.nodes.observedHardwareSource,
      providerInstancePriceDisplay: schema.nodes.providerInstancePriceDisplay,
      credentialSource: schema.nodes.credentialSource,
      nodeClass: schema.nodes.nodeClass,
      status: schema.nodes.status,
      createdAt: schema.nodes.createdAt,
      updatedAt: schema.nodes.updatedAt,
    })
    .from(schema.nodes)
    .where(and(...getOverlappingNodeConditions(periodStartIso, periodEndIso)));
}

export function toActiveComputeSession(node: NodeUsageRow): ActiveComputeSession | null {
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
    ...resolveComputeVcpuCount(node, { legacyNode: node }),
    providerInstanceType: node.providerInstanceType,
    providerInstanceVcpuCount: node.providerInstanceVcpuCount,
    providerInstanceMemoryMb: node.providerInstanceMemoryMb,
    providerInstanceDiskGb: node.providerInstanceDiskGb,
    providerInstanceBootDiskSizeGb: node.providerInstanceBootDiskSizeGb,
    providerInstanceImage: node.providerInstanceImage,
    providerInstanceArchitecture: node.providerInstanceArchitecture,
    observedProviderInstanceType: node.observedProviderInstanceType,
    observedProviderInstanceVcpuCount: node.observedProviderInstanceVcpuCount,
    observedProviderInstanceMemoryMb: node.observedProviderInstanceMemoryMb,
    observedProviderInstanceDiskGb: node.observedProviderInstanceDiskGb,
    observedHardwareJson: node.observedHardwareJson,
    observedHardwareSource: node.observedHardwareSource,
    providerInstancePriceDisplay: node.providerInstancePriceDisplay,
    startedAt: node.createdAt,
    createdAt: node.createdAt,
    credentialSource,
    status: node.status,
  };
}

export function toNodeUsageRecord(
  node: NodeUsageRow,
  workspaceCounts: Map<string, number>
): NodeUsageRecord {
  return {
    nodeId: node.id,
    name: node.name,
    vmSize: node.vmSize,
    ...resolveComputeVcpuCount(node, { legacyNode: node }),
    providerInstanceType: node.providerInstanceType,
    providerInstanceVcpuCount: node.providerInstanceVcpuCount,
    providerInstanceMemoryMb: node.providerInstanceMemoryMb,
    providerInstanceDiskGb: node.providerInstanceDiskGb,
    providerInstanceBootDiskSizeGb: node.providerInstanceBootDiskSizeGb,
    providerInstanceImage: node.providerInstanceImage,
    providerInstanceArchitecture: node.providerInstanceArchitecture,
    observedProviderInstanceType: node.observedProviderInstanceType,
    observedProviderInstanceVcpuCount: node.observedProviderInstanceVcpuCount,
    observedProviderInstanceMemoryMb: node.observedProviderInstanceMemoryMb,
    observedProviderInstanceDiskGb: node.observedProviderInstanceDiskGb,
    observedHardwareJson: node.observedHardwareJson,
    observedHardwareSource: node.observedHardwareSource,
    providerInstancePriceDisplay: node.providerInstancePriceDisplay,
    vmLocation: node.vmLocation,
    cloudProvider: node.cloudProvider,
    credentialSource: (node.credentialSource ?? 'user') as CredentialSource,
    status: node.status,
    createdAt: node.createdAt,
    endedAt: getNodeEndedAt(node.status, node.updatedAt),
    workspaceCount: workspaceCounts.get(node.id) ?? 0,
  };
}
