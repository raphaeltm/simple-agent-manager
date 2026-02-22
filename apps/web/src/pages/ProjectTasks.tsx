import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Task, TaskSortOrder, TaskStatus, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';
import { TaskFilters, type TaskFilterState } from '../components/project/TaskFilters';
import { TaskForm, type TaskFormValues } from '../components/project/TaskForm';
import { TaskList } from '../components/project/TaskList';
import { TaskDelegateDialog } from '../components/project/TaskDelegateDialog';
import { NeedsAttentionSection } from '../components/project/NeedsAttentionSection';
import {
  createProjectTask,
  deleteProjectTask,
  delegateTask,
  listProjectTasks,
  listWorkspaces,
  updateProjectTaskStatus,
} from '../lib/api';
import { useToast } from '../hooks/useToast';
import { useProjectContext } from './ProjectContext';

const VALID_STATUSES: TaskStatus[] = [
  'draft', 'ready', 'queued', 'delegated', 'in_progress', 'completed', 'failed', 'cancelled',
];

function isTaskStatus(value: string | null): value is TaskStatus {
  return value ? VALID_STATUSES.includes(value as TaskStatus) : false;
}

function parseTaskSortOrder(value: string | null): TaskSortOrder {
  if (value === 'updatedAtDesc' || value === 'priorityDesc') return value;
  return 'createdAtDesc';
}

export function ProjectTasks() {
  const toast = useToast();
  const { projectId, reload } = useProjectContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [delegateTargetTask, setDelegateTargetTask] = useState<Task | null>(null);
  const [delegating, setDelegating] = useState(false);

  const filters: TaskFilterState = useMemo(() => {
    const status = searchParams.get('status');
    const minPriorityRaw = searchParams.get('minPriority');
    const minPriority = minPriorityRaw ? Number.parseInt(minPriorityRaw, 10) : undefined;
    return {
      status: isTaskStatus(status) ? status : undefined,
      minPriority: Number.isNaN(minPriority) ? undefined : minPriority,
      sort: parseTaskSortOrder(searchParams.get('sort')),
    };
  }, [searchParams]);

  const setFilters = useCallback((next: TaskFilterState) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next.status) { params.set('status', next.status); } else { params.delete('status'); }
      if (next.minPriority !== undefined) { params.set('minPriority', String(next.minPriority)); } else { params.delete('minPriority'); }
      if (next.sort !== 'createdAtDesc') { params.set('sort', next.sort); } else { params.delete('sort'); }
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const loadTasks = useCallback(async () => {
    try {
      setTasksLoading(true);
      const response = await listProjectTasks(projectId, {
        status: filters.status,
        minPriority: filters.minPriority,
        sort: filters.sort,
      });
      setTasks(response.tasks);
    } catch {
      toast.error('Failed to load tasks');
    } finally {
      setTasksLoading(false);
    }
  }, [projectId, filters.status, filters.minPriority, filters.sort, toast]);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  useEffect(() => {
    void listWorkspaces('running')
      .then((response) => setWorkspaces(response))
      .catch(() => setWorkspaces([]));
  }, []);

  const handleTaskCreate = async (values: TaskFormValues) => {
    try {
      setSavingTask(true);
      await createProjectTask(projectId, {
        title: values.title,
        description: values.description || undefined,
        priority: values.priority,
        parentTaskId: values.parentTaskId || undefined,
        agentProfileHint: values.agentProfileHint || undefined,
      });
      toast.success('Task created');
      setShowTaskCreate(false);
      await loadTasks();
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSavingTask(false);
    }
  };

  const handleTaskDelete = async (task: Task) => {
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await deleteProjectTask(projectId, task.id);
      toast.success('Task deleted');
      await loadTasks();
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

  const handleTaskTransition = async (task: Task, toStatus: TaskStatus) => {
    try {
      await updateProjectTaskStatus(projectId, task.id, { toStatus });
      toast.success(`Task moved to ${toStatus.replace('_', ' ')}`);
      await loadTasks();
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  const handleDelegate = async (workspaceId: string) => {
    if (!delegateTargetTask) return;
    try {
      setDelegating(true);
      await delegateTask(projectId, delegateTargetTask.id, { workspaceId });
      toast.success('Task delegated');
      setDelegateTargetTask(null);
      await loadTasks();
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delegate task');
    } finally {
      setDelegating(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 'var(--sam-space-2)',
        flexWrap: 'wrap',
      }}>
        <TaskFilters value={filters} onChange={setFilters} />
        <Button onClick={() => setShowTaskCreate(true)}>
          New task
        </Button>
      </div>

      {/* New task dialog */}
      <Dialog isOpen={showTaskCreate} onClose={() => setShowTaskCreate(false)} maxWidth="lg">
        <h2 style={{ margin: '0 0 var(--sam-space-3)', fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>New Task</h2>
        <TaskForm
          mode="create"
          tasks={tasks}
          submitting={savingTask}
          onSubmit={handleTaskCreate}
          onCancel={() => setShowTaskCreate(false)}
        />
      </Dialog>

      {/* Needs attention */}
      <NeedsAttentionSection tasks={tasks} projectId={projectId} />

      {/* Task list */}
      <TaskList
        tasks={tasks}
        projectId={projectId}
        loading={tasksLoading}
        onDeleteTask={handleTaskDelete}
        onTransitionTask={handleTaskTransition}
        onDelegateTask={(task) => setDelegateTargetTask(task)}
      />

      <TaskDelegateDialog
        open={!!delegateTargetTask}
        task={delegateTargetTask}
        workspaces={workspaces}
        loading={delegating}
        onClose={() => setDelegateTargetTask(null)}
        onDelegate={handleDelegate}
      />
    </div>
  );
}
