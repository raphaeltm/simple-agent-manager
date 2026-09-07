import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

import { PlacementDecisionSummary } from './PlacementDecisionSummary';

export type Hardware = Pick<
  NodeResponse,
  | 'providerInstanceType'
  | 'providerInstanceVcpuCount'
  | 'providerInstanceMemoryMb'
  | 'providerInstanceDiskGb'
  | 'providerInstanceBootDiskSizeGb'
  | 'providerInstanceArchitecture'
  | 'cloudProvider'
  | 'observedProviderInstanceType'
  | 'observedProviderInstanceVcpuCount'
  | 'observedProviderInstanceMemoryMb'
  | 'observedProviderInstanceDiskGb'
> & { vmSize?: string | null };

function amount(value: number | null | undefined, unit: string, divisor = 1): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? `${Number((value / divisor).toFixed(1))} ${unit}`
    : `${unit} unknown`;
}

export function hardwareRows(hardware: Partial<Hardware>): Array<[string, string]> {
  const configured =
    hardware.providerInstanceType ||
    hardware.providerInstanceVcpuCount ||
    hardware.providerInstanceMemoryMb ||
    hardware.providerInstanceDiskGb ||
    hardware.providerInstanceBootDiskSizeGb ||
    hardware.providerInstanceArchitecture;
  const observed =
    hardware.observedProviderInstanceType ||
    hardware.observedProviderInstanceVcpuCount ||
    hardware.observedProviderInstanceMemoryMb ||
    hardware.observedProviderInstanceDiskGb;
  const rows: Array<[string, string]> = [];
  if (observed)
    rows.push([
      'Observed hardware',
      [
        hardware.observedProviderInstanceType || 'Type unknown',
        amount(hardware.observedProviderInstanceVcpuCount, 'vCPU'),
        amount(hardware.observedProviderInstanceMemoryMb, 'GB RAM', 1024),
        amount(hardware.observedProviderInstanceDiskGb, 'GB disk'),
      ].join(' · '),
    ]);
  if (configured)
    rows.push([
      'Configured offering',
      [
        hardware.providerInstanceType || 'Type unknown',
        amount(hardware.providerInstanceVcpuCount, 'vCPU'),
        amount(hardware.providerInstanceMemoryMb, 'GB RAM', 1024),
        amount(hardware.providerInstanceDiskGb, 'GB disk'),
        ...(hardware.providerInstanceBootDiskSizeGb
          ? [`${hardware.providerInstanceBootDiskSizeGb} GB boot disk`]
          : []),
        ...(hardware.providerInstanceArchitecture ? [hardware.providerInstanceArchitecture] : []),
      ].join(' · '),
    ]);
  if (!observed) rows.push(['Observed hardware', 'Unknown — no hardware report']);
  if (!configured && hardware.vmSize) rows.push(['Compatibility estimate', hardware.vmSize]);
  return rows;
}

export function HardwareDetails({
  hardware,
  showProvider = false,
}: {
  hardware: Partial<Hardware>;
  showProvider?: boolean;
}) {
  return (
    <dl className="m-0 grid gap-1 text-xs min-w-0" aria-label="Hardware details">
      {showProvider && (
        <div>
          <dt className="text-fg-muted">Provider</dt>
          <dd className="m-0 text-fg-primary">{hardware.cloudProvider ?? 'Unknown'}</dd>
        </div>
      )}
      {hardwareRows(hardware).map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="m-0 text-fg-primary [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function record(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Only numeric reservation fields are displayed; raw plan JSON and identity references stay private. */
export function requestedResources(
  workspace: Pick<WorkspaceResponse, 'resolvedReservationJson' | 'resourceRequirementsJson'>
): string {
  const resolved = record(workspace.resolvedReservationJson);
  const requested = record(workspace.resourceRequirementsJson);
  const parts: string[] = [];
  const values = resolved
    ? [resolved.cpuMillis, resolved.memoryMb, resolved.diskMb]
    : [requested?.minVcpu, requested?.minMemoryGb, requested?.minDiskGb];
  const units = ['vCPU', 'GB RAM', 'GB disk'];
  const fields = ['minVcpu', 'minMemoryGb', 'minDiskGb'];
  const provenance = resolved?.fieldProvenance;
  const translated = (index: number) => {
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
    const field = (provenance as Record<string, unknown>)[fields[index] ?? ''];
    return !!field && typeof field === 'object' && 'compatibility' in field;
  };
  values.forEach((value, index) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      parts.push(
        `${Number((value / (resolved ? (index === 0 ? 1000 : 1024) : 1)).toFixed(1))} ${units[index]}${translated(index) ? ' (compatibility estimate)' : ''}`
      );
    }
  });
  const policy = resolved ?? requested;
  if (policy?.exclusiveNode === true) parts.push('exclusive node');
  else if (policy?.exclusiveNode === false) parts.push('node sharing allowed');
  if (
    typeof policy?.maxCoTenants === 'number' &&
    Number.isInteger(policy.maxCoTenants) &&
    policy.maxCoTenants > 0
  ) {
    parts.push(`up to ${policy.maxCoTenants} workspaces per node`);
  }
  return parts.length ? parts.join(' · ') : 'Unknown — no saved resource request';
}

export function WorkspaceHardwareDetails({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <div className="grid gap-2 min-w-0">
      <dl className="m-0 text-xs">
        <dt className="text-fg-muted">Requested resources</dt>
        <dd className="m-0 text-fg-primary [overflow-wrap:anywhere]">
          {requestedResources(workspace)}
        </dd>
      </dl>
      <HardwareDetails hardware={workspace.hardware ?? workspace} showProvider />
      <PlacementDecisionSummary
        explanationJson={workspace.placementExplanationJson}
        showRequested={false}
      />
    </div>
  );
}
