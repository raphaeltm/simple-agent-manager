import type { FC } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FolderKanban } from 'lucide-react';

export interface ProjectNodeData {
  label: string;
  repository: string | null;
  status: string | null;
  lastActivityAt: string | null;
  activeSessionCount: number | null;
  workspaceCount: number;
  taskCount: number;
  sessionCount: number;
  isMobile: boolean;
  [key: string]: unknown;
}

export const ProjectNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as ProjectNodeData;
  const isActive = (d.activeSessionCount ?? 0) > 0;

  return (
    <div
      className={`rounded-lg border bg-surface px-4 py-3 min-w-[200px] max-w-[260px] ${
        isActive ? 'border-accent shadow-[0_0_12px_rgba(22,163,74,0.3)]' : 'border-border-default'
      }`}
    >
      <Handle type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2" />
      <Handle type="target" position={Position.Top} className="!bg-accent !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-2">
        <FolderKanban size={16} className="text-accent shrink-0" />
        <span className="sam-type-card-title text-fg-primary truncate">{d.label}</span>
      </div>

      {!d.isMobile && d.repository && (
        <div className="sam-type-caption text-fg-muted truncate mb-2">{d.repository}</div>
      )}

      <div className="flex gap-3 sam-type-caption text-fg-muted">
        <span>{d.workspaceCount} ws</span>
        <span>{d.sessionCount} chat</span>
        <span>{d.taskCount} task</span>
      </div>
    </div>
  );
};
