import type { FC } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Monitor } from 'lucide-react';

export interface WorkspaceNodeData {
  label: string;
  branch: string | null;
  status: string;
  vmSize: string | null;
  isMobile: boolean;
  [key: string]: unknown;
}

export const WorkspaceNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as WorkspaceNodeData;
  const isRunning = d.status === 'running';

  return (
    <div
      className={`rounded-lg border bg-surface px-3 py-2 min-w-[170px] max-w-[210px] ${
        isRunning ? 'border-[#00ccff] shadow-[0_0_10px_rgba(0,204,255,0.2)]' : 'border-border-default'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#00ccff] !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} className="!bg-[#00ccff] !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-1">
        <Monitor size={14} className="text-[#00ccff] shrink-0" />
        <span className="sam-type-secondary text-fg-primary truncate font-medium">{d.label}</span>
        <span
          className={`ml-auto w-2 h-2 rounded-full shrink-0 ${
            isRunning ? 'bg-[#00ccff]' : 'bg-fg-muted'
          }`}
        />
      </div>

      {!d.isMobile && d.branch && (
        <div className="sam-type-caption text-fg-muted truncate font-mono">{d.branch}</div>
      )}
    </div>
  );
};
