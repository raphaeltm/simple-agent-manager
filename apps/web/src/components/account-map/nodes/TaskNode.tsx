import { Handle, type NodeProps,Position } from '@xyflow/react';
import { ListTodo } from 'lucide-react';
import type { FC } from 'react';

export interface TaskNodeData {
  label: string;
  status: string;
  executionStep: string | null;
  priority: number | null;
  isMobile: boolean;
  [key: string]: unknown;
}

const statusColor: Record<string, string> = {
  in_progress: 'text-warning',
  queued: 'text-fg-muted',
  completed: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-fg-muted',
};

export const TaskNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as TaskNodeData;
  const isActive = d.status === 'in_progress' || d.status === 'queued';

  return (
    <div
      className={`rounded-lg border bg-surface px-3 py-2 min-w-[160px] max-w-[210px] ${
        isActive ? 'border-warning shadow-[0_0_10px_rgba(245,158,11,0.2)]' : 'border-border-default'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-warning !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} className="!bg-warning !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-1">
        <ListTodo size={14} className="text-warning shrink-0" />
        <span className="sam-type-secondary text-fg-primary truncate font-medium">
          {d.isMobile ? (d.label || 'Task').slice(0, 15) : d.label || 'Task'}
        </span>
      </div>

      {!d.isMobile && (
        <div className="flex items-center gap-2 sam-type-caption">
          <span className={statusColor[d.status] ?? 'text-fg-muted'}>{d.status}</span>
          {d.executionStep && <span className="text-fg-muted">{d.executionStep}</span>}
        </div>
      )}
    </div>
  );
};
