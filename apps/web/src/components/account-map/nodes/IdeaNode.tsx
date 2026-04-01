import { Handle, type NodeProps,Position } from '@xyflow/react';
import { Lightbulb } from 'lucide-react';
import type { FC } from 'react';

export interface IdeaNodeData {
  label: string;
  status: string;
  linkedSessionCount: number;
  isMobile: boolean;
  [key: string]: unknown;
}

export const IdeaNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as IdeaNodeData;
  const hasLinks = d.linkedSessionCount > 0;

  return (
    <div
      className={`rounded-lg border bg-surface px-3 py-2 min-w-[150px] max-w-[200px] ${
        hasLinks ? 'border-[#ffdd44]' : 'border-border-default'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#ffdd44] !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-1">
        <Lightbulb size={14} className="text-[#ffdd44] shrink-0" />
        <span className="sam-type-secondary text-fg-primary truncate font-medium">
          {d.isMobile ? (d.label || 'Idea').slice(0, 15) : d.label || 'Idea'}
        </span>
      </div>

      {!d.isMobile && hasLinks && (
        <div className="sam-type-caption text-fg-muted">
          {d.linkedSessionCount} linked session{d.linkedSessionCount !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
};
