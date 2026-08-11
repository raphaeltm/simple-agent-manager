import type {
  DetectedPort,
  LegacyPlacementExplanation,
  PlacementExplanation,
  PlacementRejectionReason,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import {
  isPlacementExplanationV2,
  VM_LOCATIONS,
  VM_SIZE_LABELS,
} from '@simple-agent-manager/shared';
import { ExternalLink, GitBranch, Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { useNodeSystemInfo } from '../hooks/useNodeSystemInfo';
import { getPortAccessUrl } from '../lib/api';
import { formatFileSize } from '../lib/file-utils';
import { sanitizeUrl } from '../lib/url-utils';
import { CollapsibleSection } from './CollapsibleSection';
import { ResourceBar } from './node/ResourceBar';

const REJECTION_LABELS: Record<PlacementRejectionReason, string> = {
  'node-not-found': 'Node was not found',
  'not-running': 'Node is not running',
  'wrong-runtime': 'Runtime cannot host VM workspaces',
  unhealthy: 'Health check is not healthy',
  'heartbeat-missing': 'Heartbeat is missing',
  'heartbeat-stale': 'Heartbeat is stale',
  'agent-not-ready': 'VM agent is not ready',
  'agent-version-mismatch': 'VM agent build is incompatible',
  undersized: 'VM is smaller than requested',
  'workspace-limit': 'Workspace limit reached',
  'cpu-threshold': 'CPU threshold reached',
  'memory-threshold': 'Memory threshold reached',
  'not-warm': 'Node is not in the warm pool',
  'warm-claim-lost': 'Another task claimed the warm node',
};

const PROVISIONING_OUTCOME_LABELS: Record<
  PlacementExplanation['provisioningAttempts'][number]['outcome'],
  string
> = {
  started: 'Started',
  succeeded: 'Succeeded',
  'capacity-rejected': 'Capacity unavailable',
  failed: 'Failed',
};

const PROVISIONING_FAILURE_LABELS: Record<
  NonNullable<PlacementExplanation['provisioningAttempts'][number]['failureReason']>,
  string
> = {
  'capacity-unavailable': 'Provider capacity unavailable',
  'node-limit': 'Node limit reached',
  'quota-exceeded': 'Compute quota exceeded',
  'credentials-unavailable': 'Cloud credentials unavailable',
  'provider-failed': 'Cloud provider failed',
  'provisioning-timeout': 'VM provisioning timed out',
  'readiness-timeout': 'VM agent readiness timed out',
  'node-unavailable': 'Provisioned node unavailable',
};

function useRelativeTime(isoDate: string | null | undefined): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isoDate) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isoDate]);

  if (!isoDate) return '-';
  const ms = now - new Date(isoDate).getTime();
  if (ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function vmSizeLabel(size: string): string {
  const config = VM_SIZE_LABELS[size as keyof typeof VM_SIZE_LABELS];
  return config ? `${config.label} (${config.shortDescription})` : size;
}

function vmLocationLabel(location: string): string {
  const config = VM_LOCATIONS[location];
  return config ? `${config.name}, ${config.country}` : location;
}

function InfoRow({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex justify-between items-baseline gap-2 min-w-0">
      <span className="text-fg-muted shrink-0" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
        {label}
      </span>
      <span
        className="text-fg-primary text-right min-w-0 break-words"
        style={{ fontSize: 'var(--sam-type-caption-size)' }}
      >
        {children}
      </span>
    </div>
  );
}

function PlacementDetail({
  explanation,
}: Readonly<{
  explanation: PlacementExplanation | LegacyPlacementExplanation | null | undefined;
}>) {
  if (!explanation) {
    return <span className="text-fg-muted text-xs">No placement explanation was recorded.</span>;
  }
  if (!isPlacementExplanationV2(explanation)) {
    return (
      <div className="grid gap-1.5 text-xs min-w-0">
        <p className="m-0 text-fg-primary break-words">{explanation.reason}</p>
        <InfoRow label="VM size">{explanation.selectedVmSize}</InfoRow>
        <InfoRow label="Source">{explanation.vmSizeSource}</InfoRow>
      </div>
    );
  }

  const rejected = explanation.evaluatedNodes.filter((evaluation) => !evaluation.accepted);
  return (
    <div className="grid gap-2.5 text-xs min-w-0" data-testid="placement-detail">
      <p className="m-0 text-fg-primary break-words">{explanation.summary}</p>
      <div className="grid gap-1">
        <InfoRow label="Outcome">{explanation.outcome}</InfoRow>
        <InfoRow label="Path">{explanation.selectionPath}</InfoRow>
        <InfoRow label="Requested">
          {explanation.request.vmSize} · {explanation.request.vmLocation}
        </InfoRow>
        {explanation.selectedNodeId && (
          <InfoRow label="Selected node">
            <span className="font-mono break-all">{explanation.selectedNodeId}</span>
          </InfoRow>
        )}
      </div>

      {rejected.length > 0 && (
        <div className="grid gap-1.5 min-w-0">
          <strong className="text-fg-primary">Rejected candidates</strong>
          {rejected.map((evaluation, index) => (
            <div
              key={`${evaluation.path}-${evaluation.nodeId}-${index}`}
              className="rounded-sm bg-inset px-2 py-1.5 min-w-0"
            >
              <div className="font-mono text-fg-primary break-all">{evaluation.nodeId}</div>
              <div className="text-fg-muted break-words">
                {evaluation.rejectionReasons.map((reason) => REJECTION_LABELS[reason]).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}

      {explanation.provisioningAttempts.length > 0 && (
        <div className="grid gap-1 min-w-0">
          <strong className="text-fg-primary">Provisioning attempts</strong>
          {explanation.provisioningAttempts.map((attempt, index) => (
            <div
              key={`${attempt.vmSize}-${attempt.outcome}-${index}`}
              className="text-fg-muted break-words"
            >
              {attempt.vmSize} · {attempt.vmLocation} ·{' '}
              {PROVISIONING_OUTCOME_LABELS[attempt.outcome]}
              {attempt.failureReason
                ? ` · ${PROVISIONING_FAILURE_LABELS[attempt.failureReason]}`
                : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspaceSidebarInfrastructure({
  workspace,
  isRunning,
  detectedPorts,
}: Readonly<{
  workspace: WorkspaceResponse | null;
  isRunning: boolean;
  detectedPorts: DetectedPort[];
}>) {
  const uptime = useRelativeTime(workspace?.createdAt);
  const { systemInfo, error: systemInfoError } = useNodeSystemInfo(
    workspace?.nodeId ?? undefined,
    isRunning ? 'running' : undefined
  );
  const repoUrl = workspace?.repository ? `https://github.com/${workspace.repository}` : null;

  return (
    <>
      <CollapsibleSection title="Workspace Info" storageKey="sam-sidebar-workspace-info">
        <div className="grid gap-1.5" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
          {workspace?.repository && (
            <InfoRow label="Repository">
              {repoUrl ? (
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-underline inline-flex items-center gap-1 break-all"
                  style={{ color: 'var(--sam-workspace-link-fg)' }}
                >
                  {workspace.repository}
                  <ExternalLink size={11} className="shrink-0" />
                </a>
              ) : (
                <span>{workspace.repository}</span>
              )}
            </InfoRow>
          )}
          {workspace?.branch && (
            <InfoRow label="Branch">
              <span className="inline-flex items-center gap-1 break-all">
                <GitBranch size={12} className="text-fg-muted shrink-0" />
                {workspace.branch}
              </span>
            </InfoRow>
          )}
          {workspace?.vmSize && (
            <InfoRow label="VM">
              {vmSizeLabel(workspace.vmSize)}
              {workspace.vmLocation ? ` · ${vmLocationLabel(workspace.vmLocation)}` : ''}
            </InfoRow>
          )}
          {workspace?.nodeId && (
            <InfoRow label="Node">
              <Link
                to={`/nodes/${workspace.nodeId}`}
                className="no-underline inline-flex items-center gap-1"
                style={{ color: 'var(--sam-workspace-link-fg)' }}
              >
                {workspace.nodeId.slice(0, 8)}
                <ExternalLink size={11} />
              </Link>
            </InfoRow>
          )}
          <InfoRow label="Uptime">{uptime}</InfoRow>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Placement" defaultCollapsed storageKey="sam-sidebar-placement">
        <PlacementDetail explanation={workspace?.placementExplanation} />
      </CollapsibleSection>

      {isRunning && workspace?.nodeId && (
        <CollapsibleSection
          title="Node Resources"
          defaultCollapsed
          storageKey="sam-sidebar-node-resources"
        >
          {systemInfo ? (
            <div className="grid gap-2.5">
              <ResourceBar
                label="CPU"
                percent={Math.min(100, (systemInfo.cpu.loadAvg1 / systemInfo.cpu.numCpu) * 100)}
                detail={`Load: ${systemInfo.cpu.loadAvg1.toFixed(2)} / ${systemInfo.cpu.numCpu} cores`}
              />
              <ResourceBar
                label="Memory"
                percent={systemInfo.memory.usedPercent}
                detail={`${formatFileSize(systemInfo.memory.usedBytes)} / ${formatFileSize(systemInfo.memory.totalBytes)}`}
              />
              <ResourceBar
                label="Disk"
                percent={systemInfo.disk.usedPercent}
                detail={`${formatFileSize(systemInfo.disk.usedBytes)} / ${formatFileSize(systemInfo.disk.totalBytes)}`}
              />
            </div>
          ) : (
            <span className="text-fg-muted text-xs">
              {systemInfoError ? 'Unable to load resource data' : 'Loading...'}
            </span>
          )}
        </CollapsibleSection>
      )}

      {isRunning && detectedPorts.length > 0 && (
        <CollapsibleSection
          title="Active Ports"
          badge={detectedPorts.length}
          storageKey="sam-sidebar-active-ports"
        >
          <div className="flex flex-col gap-1">
            {detectedPorts
              .slice()
              .sort((a, b) => a.port - b.port)
              .map((port) => (
                <a
                  key={port.port}
                  href={
                    workspace ? getPortAccessUrl(workspace.id, port.port) : sanitizeUrl(port.url)
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open port ${port.port} (${port.label})`}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-fg-primary hover:bg-surface-hover transition-colors min-w-0"
                  style={{ fontSize: 'var(--sam-type-caption-size)' }}
                >
                  <Globe className="w-3.5 h-3.5 text-fg-muted shrink-0" />
                  <span className="font-mono font-medium">{port.port}</span>
                  <span className="text-fg-muted truncate min-w-0">{port.label}</span>
                  {port.address === '127.0.0.1' && (
                    <span className="text-fg-muted ml-auto text-xs">(local)</span>
                  )}
                  <ExternalLink className="w-3 h-3 text-fg-muted ml-auto shrink-0" />
                </a>
              ))}
          </div>
        </CollapsibleSection>
      )}
    </>
  );
}
