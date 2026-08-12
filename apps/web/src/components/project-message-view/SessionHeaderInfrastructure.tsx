import type { DetectedPort, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Box, Cloud, Cpu, GitBranch, MapPin, Server } from 'lucide-react';

import type { ChatSessionResponse } from '../../lib/api';
import { PortsContextItem } from './SessionHeaderBadges';
import { formatVmSize } from './SessionHeaderFormatters';

function ContextItem({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-muted min-w-0">
      <span className="shrink-0 opacity-60" aria-hidden="true">
        {icon}
      </span>
      <span className="font-medium shrink-0">{label}:</span>
      <span className="text-fg-primary truncate min-w-0">{children}</span>
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
      {session.workspaceId && (workspace || node) && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-border-default">
          {workspace && (
            <>
              <ContextItem icon={<Box size={12} />} label="Workspace">
                <a
                  href={`/workspaces/${workspace.id}`}
                  className="no-underline hover:underline"
                  style={{ color: 'var(--sam-color-accent-primary)' }}
                >
                  {workspace.displayName || workspace.name}
                </a>
                <span className="text-fg-muted ml-1">({workspace.status})</span>
              </ContextItem>
              <ContextItem icon={<Cpu size={12} />} label="VM Size">
                {formatVmSize(workspace.vmSize)}
              </ContextItem>
            </>
          )}
          {node && (
            <>
              <ContextItem icon={<Server size={12} />} label="Node">
                <a
                  href={`/nodes/${node.id}`}
                  className="no-underline hover:underline"
                  style={{ color: 'var(--sam-color-accent-primary)' }}
                >
                  {node.name}
                </a>
                {node.healthStatus && (
                  <span
                    className="ml-1"
                    style={{
                      color:
                        node.healthStatus === 'healthy'
                          ? 'var(--sam-color-success)'
                          : node.healthStatus === 'stale'
                            ? 'var(--sam-color-warning, #f59e0b)'
                            : 'var(--sam-color-danger)',
                    }}
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
      )}
      {detectedPorts.length > 0 && !(session.workspaceId && (workspace || node)) && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-border-default">
          <PortsContextItem ports={detectedPorts} getHref={getWorkspacePortHref} />
        </div>
      )}
      {session.workspaceId && !workspace && !node && (
        <div className="pt-1 border-t border-border-default">
          <span className="text-xs text-fg-muted">Loading infrastructure details...</span>
        </div>
      )}
    </>
  );
}
