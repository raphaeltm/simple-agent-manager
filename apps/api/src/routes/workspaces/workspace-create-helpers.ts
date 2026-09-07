import { type CredentialSource } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { startComputeTracking } from '../../services/compute-usage';

export function optionalPositiveInteger(
  value: number | undefined,
  field: string
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw errors.badRequest(`${field} must be a positive integer`);
  }
  return value;
}

export function optionalTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeCredentialSource(
  value: string | null | undefined
): CredentialSource | null {
  return value === 'user' || value === 'project' || value === 'platform' || value === 'self-hosted'
    ? value
    : null;
}

export async function startComputeTrackingForNode(
  db: Parameters<typeof startComputeTracking>[0],
  input: {
    userId: string;
    workspaceId: string;
    nodeId: string;
    vmSize: string;
  }
): Promise<void> {
  try {
    const [nodeRow] = await db
      .select({
        cloudProvider: schema.nodes.cloudProvider,
        credentialSource: schema.nodes.credentialSource,
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
        providerInstancePriceCurrency: schema.nodes.providerInstancePriceCurrency,
        providerInstancePriceMonthlyCents: schema.nodes.providerInstancePriceMonthlyCents,
        providerInstancePriceHourlyMicros: schema.nodes.providerInstancePriceHourlyMicros,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, input.nodeId))
      .limit(1);

    await startComputeTracking(db, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      vmSize: input.vmSize,
      cloudProvider: nodeRow?.cloudProvider,
      providerInstanceType: nodeRow?.providerInstanceType,
      providerInstanceVcpuCount: nodeRow?.providerInstanceVcpuCount,
      providerInstanceMemoryMb: nodeRow?.providerInstanceMemoryMb,
      providerInstanceDiskGb: nodeRow?.providerInstanceDiskGb,
      providerInstanceBootDiskSizeGb: nodeRow?.providerInstanceBootDiskSizeGb,
      providerInstanceImage: nodeRow?.providerInstanceImage,
      providerInstanceArchitecture: nodeRow?.providerInstanceArchitecture,
      observedProviderInstanceType: nodeRow?.observedProviderInstanceType,
      observedProviderInstanceVcpuCount: nodeRow?.observedProviderInstanceVcpuCount,
      observedProviderInstanceMemoryMb: nodeRow?.observedProviderInstanceMemoryMb,
      observedProviderInstanceDiskGb: nodeRow?.observedProviderInstanceDiskGb,
      observedHardwareJson: nodeRow?.observedHardwareJson,
      observedHardwareSource: nodeRow?.observedHardwareSource,
      providerInstancePriceDisplay: nodeRow?.providerInstancePriceDisplay,
      providerInstancePriceCurrency: nodeRow?.providerInstancePriceCurrency,
      providerInstancePriceMonthlyCents: nodeRow?.providerInstancePriceMonthlyCents,
      providerInstancePriceHourlyMicros: nodeRow?.providerInstancePriceHourlyMicros,
      credentialSource: (nodeRow?.credentialSource as CredentialSource) ?? 'user',
    });
  } catch (err) {
    log.error('workspace.compute_tracking_start_failed', {
      workspaceId: input.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
