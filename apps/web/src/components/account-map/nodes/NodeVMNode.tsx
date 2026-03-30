import type { FC } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Server } from 'lucide-react';

export interface NodeVMNodeData {
  label: string;
  status: string;
  vmSize: string | null;
  vmLocation: string | null;
  cloudProvider: string | null;
  ipAddress: string | null;
  healthStatus: string | null;
  isMobile: boolean;
  [key: string]: unknown;
}

const healthColor: Record<string, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  unhealthy: 'bg-danger',
};

export const NodeVMNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as NodeVMNodeData;
  const dotClass = healthColor[d.healthStatus ?? ''] ?? 'bg-fg-muted';

  return (
    <div className="rounded-lg border border-border-default bg-surface px-3 py-2 min-w-[180px] max-w-[220px]">
      <Handle type="target" position={Position.Top} className="!bg-success !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-1">
        <Server size={14} className="text-success shrink-0" />
        <span className="sam-type-secondary text-fg-primary truncate font-medium">{d.label}</span>
        <span className={`ml-auto w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
      </div>

      {!d.isMobile && (
        <div className="flex gap-2 sam-type-caption text-fg-muted">
          {d.vmLocation && <span>{d.vmLocation}</span>}
          {d.vmSize && <span>{d.vmSize}</span>}
          {d.cloudProvider && <span>{d.cloudProvider}</span>}
        </div>
      )}

      {!d.isMobile && d.ipAddress && (
        <div className="sam-type-caption text-fg-muted mt-1 font-mono">{d.ipAddress}</div>
      )}
    </div>
  );
};
