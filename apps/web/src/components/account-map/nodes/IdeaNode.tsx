import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Lightbulb } from 'lucide-react';
import type { FC } from 'react';
import { Link } from 'react-router';

export interface IdeaNodeData {
  label: string;
  status: string;
  linkedSessionCount: number;
  projectId: string;
  isMobile: boolean;
  [key: string]: unknown;
}

export const IdeaNode: FC<NodeProps> = ({ id, data }) => {
  const d = data as unknown as IdeaNodeData;
  const hasLinks = d.linkedSessionCount > 0;

  return (
    <div
      className={`rounded-lg border bg-surface px-3 py-2 min-w-[150px] max-w-[200px] ${
        hasLinks ? 'border-[#ffdd44]' : 'border-border-default'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#ffdd44] !w-2 !h-2" />

      <Link
        to={`/projects/${encodeURIComponent(d.projectId)}/ideas/${encodeURIComponent(id)}`}
        className="nodrag flex items-center gap-2 mb-1 rounded-sm focus-visible:outline-2 focus-visible:outline-focus-ring"
        aria-label={`Open idea: ${d.label || 'Idea'}`}
      >
        <Lightbulb size={14} className="text-[#ffdd44] shrink-0" />
        <span className="sam-type-secondary text-fg-primary truncate font-medium">
          {d.isMobile ? (d.label || 'Idea').slice(0, 15) : d.label || 'Idea'}
        </span>
      </Link>

      {!d.isMobile && hasLinks && (
        <div className="sam-type-caption text-fg-muted">
          {d.linkedSessionCount} linked session{d.linkedSessionCount !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
};
