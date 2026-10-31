/** One grouped read for platform quota usage; billing remains per node lifetime. */
import { and, eq, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { resolveComputeVcpuCount } from './compute-usage';

export async function calculatePlatformNodeUsageByUser(
  db: DrizzleD1Database<typeof schema>,
  start: Date,
  end: Date,
  now = new Date()
): Promise<Map<string, number>> {
  const hardware = {
    vmSize: schema.nodes.vmSize,
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
  };
  const ended = sql`${schema.nodes.status} IN ('destroyed','destroying','deleted','error')`;
  const rows = await db
    .select({
      userId: schema.nodes.userId,
      ...hardware,
      hours: sql<number>`SUM(MAX(0, MIN(
      unixepoch(CASE WHEN ${ended} THEN ${schema.nodes.updatedAt} ELSE ${now.toISOString()} END, 'subsec'),
      unixepoch(${end.toISOString()}, 'subsec')) - MAX(unixepoch(${schema.nodes.createdAt}, 'subsec'), unixepoch(${start.toISOString()}, 'subsec'))) / 3600.0)`,
    })
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.credentialSource, 'platform'),
        sql`(${schema.nodes.nodeClass} IS NULL OR ${schema.nodes.nodeClass} <> 'user-owned')`,
        sql`${schema.nodes.createdAt} < ${end.toISOString()}`,
        or(sql`NOT (${ended})`, sql`${schema.nodes.updatedAt} > ${start.toISOString()}`)
      )
    )
    .groupBy(schema.nodes.userId, ...Object.values(hardware));
  const usage = new Map<string, number>();
  for (const row of rows) {
    const { vcpuCount } = resolveComputeVcpuCount(row, { legacyNode: row });
    usage.set(row.userId, (usage.get(row.userId) ?? 0) + Number(row.hours) * (vcpuCount ?? 0));
  }
  return usage;
}
