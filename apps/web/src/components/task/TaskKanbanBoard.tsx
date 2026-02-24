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
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
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
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))`,
      gap: 'var(--sam-space-3)',
      overflowX: 'auto',
      paddingBottom: 'var(--sam-space-2)',
    }}>
      {columns.map((status) => {
        const columnTasks = tasksByStatus[status] ?? [];
        const isTransient = TRANSIENT_STATUSES.includes(status);

        return (
          <div
            key={status}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sam-space-2)',
              minHeight: '120px',
            }}
          >
            {/* Column header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sam-space-2)',
              padding: 'var(--sam-space-2)',
              borderBottom: '2px solid var(--sam-color-border-default)',
            }}>
              <span style={{
                fontSize: 'var(--sam-type-caption-size)',
                fontWeight: 600,
                color: 'var(--sam-color-fg-primary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                {COLUMN_LABELS[status] ?? status}
              </span>
              <span style={{
                fontSize: 'var(--sam-type-caption-size)',
                color: 'var(--sam-color-fg-muted)',
                backgroundColor: 'var(--sam-color-bg-inset)',
                borderRadius: '9999px',
                padding: '0 6px',
                minWidth: '18px',
                textAlign: 'center',
              }}>
                {columnTasks.length}
              </span>
              {isTransient && (
                <Spinner size="sm" />
              )}
            </div>

            {/* Cards */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sam-space-2)',
              flex: 1,
            }}>
              {columnTasks.length === 0 ? (
                <div style={{
                  color: 'var(--sam-color-fg-muted)',
                  fontSize: 'var(--sam-type-caption-size)',
                  textAlign: 'center',
                  padding: 'var(--sam-space-4)',
                  border: '1px dashed var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                }}>
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
