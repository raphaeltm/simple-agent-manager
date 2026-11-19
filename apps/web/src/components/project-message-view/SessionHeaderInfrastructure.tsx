import type { DetectedPort, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Box, Cloud, Cpu, GitBranch, MapPin, Server } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { EffectivePoolSummary } from '../hardware/EffectivePoolSummary';
import { HardwareDetails, requestedResources } from '../hardware/HardwareDetails';
import { PlacementDecisionSummary } from '../hardware/PlacementDecisionSummary';
import { SessionDetailSection } from './SessionDetailSection';
import { PortsContextItem } from './SessionHeaderBadges';

const NODE_HEALTH_CLASS: Record<string, string> = {
  healthy: 'text-[var(--sam-status-success-fg)]',
  stale: 'text-[var(--sam-status-warning-fg)]',
};

function ContextItem({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="font-medium shrink-0">{label}:</span>
      <span className="text-fg-primary [overflow-wrap:anywhere] min-w-0">{children}</span>
    </div>
  );
}

export function SessionHeaderInfrastructure({
  session,
  workspace,
  node,
  taskEmbed,
  detectedPorts,
  getWorkspacePortHref,
}: {
  session: ChatSessionResponse;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  taskEmbed: ChatSessionResponse['task'] | null;
  detectedPorts: DetectedPort[];
  getWorkspacePortHref: (port: DetectedPort) => string;
}) {
  return (
    <>
      {!workspace && taskEmbed?.placementExplanationJson && (
        <SessionDetailSection icon={<Server size={12} />} label="Placement">
          <PlacementDecisionSummary explanationJson={taskEmbed.placementExplanationJson} />
        </SessionDetailSection>
      )}
      {session.workspaceId && (workspace || node) && (
        <SessionDetailSection icon={<Server size={12} />} label="Infrastructure">
          <div className="flex flex-col gap-1.5">
            {workspace && (
              <>
                {/*
                Plain text, deliberately. Workspaces are an implementation detail —
                `/workspaces/:id` survives for debugging but nothing in the chat routes a
                user there. The name and status still earn their place here because they
                are what you quote when something is wrong; the Node row below is the
                link worth having, since that is the machine you would actually go look at.
              */}
                <ContextItem icon={<Box size={12} />} label="Workspace">
                  {workspace.displayName || workspace.name}
                  <span className="text-fg-muted ml-1">({workspace.status})</span>
                </ContextItem>
                <ContextItem icon={<Cpu size={12} />} label="Requested">
                  {requestedResources(workspace)}
                </ContextItem>
                <HardwareDetails
                  hardware={node ?? workspace.hardware ?? workspace}
                  showProvider={!node}
                />
                <EffectivePoolSummary projectId={workspace.projectId} />
                <PlacementDecisionSummary
                  explanationJson={workspace.placementExplanationJson}
                  showRequested={false}
                />
              </>
            )}
            {node && (
              <>
                <ContextItem icon={<Server size={12} />} label="Node">
                  <a
                    href={`/nodes/${node.id}`}
                    className="text-accent no-underline hover:underline"
                  >
                    {node.name}
                  </a>
                  {node.healthStatus && (
                    <span
                      className={`ml-1 ${NODE_HEALTH_CLASS[node.healthStatus] ?? 'text-[var(--sam-status-danger-fg)]'}`}
                    >
                      ({node.healthStatus})
                    </span>
                  )}
                </ContextItem>
                {node.cloudProvider && (
                  <ContextItem icon={<Cloud size={12} />} label="Provider">
                    {node.cloudProvider.charAt(0).toUpperCase() + node.cloudProvider.slice(1)}
                    {workspace?.vmLocation && (
                      <span className="text-fg-muted ml-1">— {workspace.vmLocation}</span>
                    )}
                  </ContextItem>
                )}
              </>
            )}
            {!node && workspace?.vmLocation && (
              <ContextItem icon={<MapPin size={12} />} label="Location">
                {workspace.vmLocation}
              </ContextItem>
            )}
            {taskEmbed?.outputBranch && (
              <ContextItem icon={<GitBranch size={12} />} label="Branch">
                <span className="font-mono text-[11px]">{taskEmbed.outputBranch}</span>
              </ContextItem>
            )}
            {detectedPorts.length > 0 && (
              <PortsContextItem ports={detectedPorts} getHref={getWorkspacePortHref} />
            )}
          </div>
        </SessionDetailSection>
      )}
      {detectedPorts.length > 0 && !(session.workspaceId && (workspace || node)) && (
        <SessionDetailSection icon={<Server size={12} />} label="Infrastructure">
          <PortsContextItem ports={detectedPorts} getHref={getWorkspacePortHref} />
        </SessionDetailSection>
      )}
      {session.workspaceId && !workspace && !node && (
        <SessionDetailSection icon={<Server size={12} />} label="Infrastructure">
          <span className="text-xs text-fg-muted">Loading infrastructure details...</span>
        </SessionDetailSection>
      )}
    </>
  );
}
