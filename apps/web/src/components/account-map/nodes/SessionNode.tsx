import type { FC } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare } from 'lucide-react';

export interface SessionNodeData {
  label: string;
  status: string;
  messageCount: number;
  isMobile: boolean;
  [key: string]: unknown;
}

export const SessionNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as SessionNodeData;
  const isLive = d.status === 'running' || d.status === 'active';

  return (
    <div
      className={`rounded-lg border bg-surface px-3 py-2 min-w-[160px] max-w-[200px] ${
        isLive ? 'border-[#aa88ff] shadow-[0_0_10px_rgba(170,136,255,0.2)]' : 'border-border-default'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#aa88ff] !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} className="!bg-[#aa88ff] !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-1">
        <MessageSquare size={14} className="text-[#aa88ff] shrink-0" />
        <span className="sam-type-secondary text-fg-primary truncate font-medium">
          {d.isMobile ? (d.label || 'Chat').slice(0, 15) : d.label || 'Chat Session'}
        </span>
      </div>

      {!d.isMobile && (
        <div className="sam-type-caption text-fg-muted">
          {d.messageCount} message{d.messageCount !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
};
