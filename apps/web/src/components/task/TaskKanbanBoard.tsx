import { type FC, useCallback, useEffect, useState } from 'react';
import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { listProjectTasks } from '../../lib/api';
import { TaskKanbanCard } from './TaskKanbanCard';

export interface TaskKanbanBoardProps {
  projectId: string;
  onTaskClick: (task: Task) => void;
}

/** Primary columns always displayed */
const PRIMARY_COLUMNS: TaskStatus[] = [
  'draft', 'ready', 'in_progress', 'completed', 'failed', 'cancelled',
];

/** Transient statuses that get dynamic columns only when they have items */
const TRANSIENT_STATUSES: TaskStatus[] = ['queued', 'delegated'];

/** Map a transient status to its parent primary column for display */
const TRANSIENT_PARENT: Record<string, TaskStatus> = {
  queued: 'in_progress',
  delegated: 'in_progress',
};

const COLUMN_LABELS: Record<string, string> = {
  draft: 'Draft',
  ready: 'Ready',
  queued: 'Queued',
  delegated: 'Delegated',
  in_progress: 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const TaskKanbanBoard: FC<TaskKanbanBoardProps> = ({
  projectId,
  onTaskClick,
}) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTasks = useCallback(async () => {
    try {
      setLoading(true);
      const response = await listProjectTasks(projectId, { limit: 200 });
      setTasks(response.tasks);
    } catch {
      // Best effort
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  if (loading && tasks.length === 0) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  // Group tasks by status
  const tasksByStatus: Record<string, Task[]> = {};
  for (const task of tasks) {
    const status = task.status;
    if (!tasksByStatus[status]) {
      tasksByStatus[status] = [];
    }
    tasksByStatus[status]!.push(task);
  }

  // Sort tasks within each status by priority (descending)
  for (const status of Object.keys(tasksByStatus)) {
    tasksByStatus[status]!.sort((a, b) => b.priority - a.priority);
  }

  // Determine which transient columns need dynamic display
  const dynamicTransientColumns = TRANSIENT_STATUSES.filter(
    (s) => (tasksByStatus[s]?.length ?? 0) > 0
  );

  // Build final column order: primary columns + dynamic transient columns inserted appropriately
  const columns: TaskStatus[] = [...PRIMARY_COLUMNS];
  for (const transient of dynamicTransientColumns) {
    const parentIdx = columns.indexOf(TRANSIENT_PARENT[transient]!);
    if (parentIdx !== -1) {
      columns.splice(parentIdx, 0, transient);
    } else {
      columns.push(transient);
    }
  }

  return (
    <div
      className="grid gap-3 overflow-x-auto pb-2"
      style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` }}
    >
      {columns.map((status) => {
        const columnTasks = tasksByStatus[status] ?? [];
        const isTransient = TRANSIENT_STATUSES.includes(status);

        return (
          <div
            key={status}
            className="flex flex-col gap-2 min-h-[120px]"
          >
            {/* Column header */}
            <div className="flex items-center gap-2 p-2 border-b-2 border-border-default">
              <span className="text-xs font-semibold text-fg-primary uppercase tracking-wide">
                {COLUMN_LABELS[status] ?? status}
              </span>
              <span className="text-xs text-fg-muted bg-inset rounded-full px-1.5 min-w-[18px] text-center">
                {columnTasks.length}
              </span>
              {isTransient && (
                <Spinner size="sm" />
              )}
            </div>

            {/* Cards */}
            <div className="flex flex-col gap-2 flex-1">
              {columnTasks.length === 0 ? (
                <div className="text-fg-muted text-xs text-center p-4 border border-dashed border-border-default rounded-md">
                  No tasks
                </div>
              ) : (
                columnTasks.map((task) => (
                  <TaskKanbanCard
                    key={task.id}
                    task={task}
                    onClick={onTaskClick}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
