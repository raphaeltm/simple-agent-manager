import type { CredentialSource } from '@simple-agent-manager/shared';

// =============================================================================
// Node status helpers
// =============================================================================

export const ENDED_STATUSES_ARRAY = ['destroyed', 'destroying', 'deleted', 'error'] as const;

export const ENDED_STATUSES = new Set<string>(ENDED_STATUSES_ARRAY);

/**
 * Sentinel credential source for user-owned (BYO) nodes. SAM provisioned nothing for these, so they
 * cost SAM $0 and must be excluded from all vCPU-hour metering, admin cost, and quota accounting.
 */
export const SELF_HOSTED_CREDENTIAL_SOURCE: CredentialSource = 'self-hosted';

export interface NodeUsageCalculationRow {
  vmSize: string;
  cloudProvider: string | null;
  providerInstanceType?: string | null;
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: string | null;
  observedProviderInstanceType?: string | null;
  observedProviderInstanceVcpuCount?: number | null;
  observedProviderInstanceMemoryMb?: number | null;
  observedProviderInstanceDiskGb?: number | null;
  observedHardwareJson?: string | null;
  observedHardwareSource?: string | null;
  providerInstancePriceDisplay?: string | null;
  credentialSource: string | null;
  /** Ownership class; user-owned (BYO) nodes accrue $0 regardless of credentialSource. */
  nodeClass: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeUsageRow extends NodeUsageCalculationRow {
  id: string;
  name: string;
  vmLocation: string;
}

export interface UserNodeUsageRow extends NodeUsageRow {
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
