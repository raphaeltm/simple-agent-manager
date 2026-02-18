import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  GitHubInstallation,
  ProjectDetailResponse,
  Task,
  TaskDetailResponse,
  TaskSortOrder,
  TaskStatus,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import {
  addTaskDependency,
  createProjectTask,
  deleteProject,
  deleteProjectTask,
  delegateTask,
  getProject,
  getProjectTask,
  listGitHubInstallations,
  listProjectTasks,
  listTaskEvents,
  listWorkspaces,
  removeTaskDependency,
  updateProject,
  updateProjectTask,
  updateProjectTaskStatus,
} from '../lib/api';
import { useToast } from '../hooks/useToast';
import { ProjectForm, type ProjectFormValues } from '../components/project/ProjectForm';
import { TaskFilters, type TaskFilterState } from '../components/project/TaskFilters';
import { TaskForm, type TaskFormValues } from '../components/project/TaskForm';
import { TaskList } from '../components/project/TaskList';
import { TaskDependencyEditor } from '../components/project/TaskDependencyEditor';
import { TaskDelegateDialog } from '../components/project/TaskDelegateDialog';
import { TaskDetailPanel } from '../components/project/TaskDetailPanel';

const VALID_STATUSES: TaskStatus[] = [
  'draft',
  'ready',
  'queued',
  'delegated',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];

function isTaskStatus(value: string | null): value is TaskStatus {
  return value ? VALID_STATUSES.includes(value as TaskStatus) : false;
}

function parseTaskSortOrder(value: string | null): TaskSortOrder {
  if (value === 'updatedAtDesc' || value === 'priorityDesc') {
    return value;
  }
  return 'createdAtDesc';
}

export function Project() {
  const navigate = useNavigate();
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();

  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showProjectEdit, setShowProjectEdit] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [dependencyTask, setDependencyTask] = useState<Task | null>(null);
  const [delegateTargetTask, setDelegateTargetTask] = useState<Task | null>(null);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetailResponse | null>(null);
  const [taskEvents, setTaskEvents] = useState<Awaited<ReturnType<typeof listTaskEvents>>['events']>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [savingProject, setSavingProject] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [savingDependency, setSavingDependency] = useState(false);
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
    const params = new URLSearchParams();
    if (next.status) {
      params.set('status', next.status);
    }
    if (next.minPriority !== undefined) {
      params.set('minPriority', String(next.minPriority));
    }
    if (next.sort !== 'createdAtDesc') {
      params.set('sort', next.sort);
    }
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);

  const loadProject = useCallback(async () => {
    if (!projectId) {
      return;
    }

    try {
      setError(null);
      setProjectLoading(true);
      const data = await getProject(projectId);
      setProject(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setProjectLoading(false);
    }
  }, [projectId]);

  const loadTasks = useCallback(async () => {
    if (!projectId) {
      return;
    }

    try {
      setTasksLoading(true);
      const response = await listProjectTasks(projectId, {
        status: filters.status,
        minPriority: filters.minPriority,
        sort: filters.sort,
      });
      setTasks(response.tasks);
      if (selectedTaskId && !response.tasks.some((task) => task.id === selectedTaskId)) {
        setSelectedTaskId(null);
        setSelectedTaskDetail(null);
        setTaskEvents([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setTasksLoading(false);
    }
  }, [projectId, filters.status, filters.minPriority, filters.sort, selectedTaskId]);

  const loadTaskDetail = useCallback(async (taskId: string) => {
    if (!projectId) {
      return;
    }

    try {
      setDetailLoading(true);
      const [detail, eventsResponse] = await Promise.all([
        getProjectTask(projectId, taskId),
        listTaskEvents(projectId, taskId, 25),
      ]);
      setSelectedTaskDetail(detail);
      setTaskEvents(eventsResponse.events);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load task detail');
    } finally {
      setDetailLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    void listGitHubInstallations()
      .then((response) => setInstallations(response))
      .catch(() => setInstallations([]));

    void listWorkspaces('running')
      .then((response) => setWorkspaces(response))
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setSelectedTaskDetail(null);
      setTaskEvents([]);
      return;
    }

    void loadTaskDetail(selectedTaskId);
  }, [selectedTaskId, loadTaskDetail]);

  const handleProjectUpdate = async (values: ProjectFormValues) => {
    if (!projectId) {
      return;
    }

    try {
      setSavingProject(true);
      await updateProject(projectId, {
        name: values.name,
        description: values.description || undefined,
        defaultBranch: values.defaultBranch,
      });
      toast.success('Project updated');
      setShowProjectEdit(false);
      await loadProject();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update project');
    } finally {
      setSavingProject(false);
    }
  };

  const handleTaskCreate = async (values: TaskFormValues) => {
    if (!projectId) {
      return;
    }

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
      await loadProject();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSavingTask(false);
    }
  };

  const handleTaskUpdate = async (values: TaskFormValues) => {
    if (!projectId || !editingTask) {
      return;
    }

    try {
      setSavingTask(true);
      await updateProjectTask(projectId, editingTask.id, {
        title: values.title,
        description: values.description || undefined,
        priority: values.priority,
        parentTaskId: values.parentTaskId || null,
      });
      toast.success('Task updated');
      setEditingTask(null);
      await loadTasks();
      if (selectedTaskId === editingTask.id) {
        await loadTaskDetail(editingTask.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update task');
    } finally {
      setSavingTask(false);
    }
  };

  const handleTaskDelete = async (task: Task) => {
    if (!projectId) {
      return;
    }

    if (!window.confirm(`Delete task "${task.title}"?`)) {
      return;
    }

    try {
      await deleteProjectTask(projectId, task.id);
      toast.success('Task deleted');
      if (selectedTaskId === task.id) {
        setSelectedTaskId(null);
      }
      await loadTasks();
      await loadProject();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

  const handleTaskTransition = async (task: Task, toStatus: TaskStatus) => {
    if (!projectId) {
      return;
    }

    try {
      await updateProjectTaskStatus(projectId, task.id, { toStatus });
      toast.success(`Task moved to ${toStatus}`);
      await loadTasks();
      await loadProject();
      if (selectedTaskId === task.id) {
        await loadTaskDetail(task.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  const handleAddDependency = async (dependsOnTaskId: string) => {
    if (!projectId || !dependencyTask) {
      return;
    }

    try {
      setSavingDependency(true);
      await addTaskDependency(projectId, dependencyTask.id, { dependsOnTaskId });
      toast.success('Dependency added');
      await loadTasks();
      await loadTaskDetail(dependencyTask.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add dependency');
    } finally {
      setSavingDependency(false);
    }
  };

  const handleRemoveDependency = async (dependsOnTaskId: string) => {
    if (!projectId || !dependencyTask) {
      return;
    }

    try {
      setSavingDependency(true);
      await removeTaskDependency(projectId, dependencyTask.id, dependsOnTaskId);
      toast.success('Dependency removed');
      await loadTasks();
      await loadTaskDetail(dependencyTask.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove dependency');
    } finally {
      setSavingDependency(false);
    }
  };

  const handleDelegate = async (workspaceId: string) => {
    if (!projectId || !delegateTargetTask) {
      return;
    }

    try {
      setDelegating(true);
      await delegateTask(projectId, delegateTargetTask.id, { workspaceId });
      toast.success('Task delegated');
      setDelegateTargetTask(null);
      await loadTasks();
      await loadProject();
      await loadTaskDetail(delegateTargetTask.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delegate task');
    } finally {
      setDelegating(false);
    }
  };

  const selectedTask = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId) ?? null
    : null;

  if (!projectId) {
    return (
      <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
        <Alert variant="error">Project ID is missing.</Alert>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
      {error && (
        <div style={{ marginBottom: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {projectLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          <Spinner size="md" />
          <span>Loading project...</span>
        </div>
      ) : !project ? (
        <Alert variant="error">Project not found.</Alert>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
          <section
            style={{
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
              background: 'var(--sam-color-bg-surface)',
              padding: 'var(--sam-space-4)',
              display: 'grid',
              gap: 'var(--sam-space-3)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: '0.25rem' }}>
                <h1 style={{ margin: 0, color: 'var(--sam-color-fg-primary)', fontSize: '1.25rem' }}>
                  {project.name}
                </h1>
                <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
                  {project.repository}@{project.defaultBranch}
                </div>
                {project.description && (
                  <p style={{ margin: 0, color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
                    {project.description}
                  </p>
                )}
              </div>

              <div style={{ display: 'flex', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={() => setShowProjectEdit((value) => !value)}>
                  {showProjectEdit ? 'Close edit' : 'Edit project'}
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!window.confirm(`Delete project "${project.name}"?`)) {
                      return;
                    }
                    try {
                      await deleteProject(project.id);
                      toast.success('Project deleted');
                      navigate('/projects');
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Failed to delete project');
                    }
                  }}
                >
                  Delete project
                </Button>
              </div>
            </div>

            <div style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>
              <div>Linked workspaces: {project.summary.linkedWorkspaces}</div>
              <div>
                Task counts: {Object.entries(project.summary.taskCountsByStatus).map(([status, count]) => `${status}:${count}`).join(' | ') || 'none'}
              </div>
            </div>

            {showProjectEdit && (
              <ProjectForm
                mode="edit"
                installations={installations}
                initialValues={{
                  name: project.name,
                  description: project.description ?? '',
                  installationId: project.installationId,
                  repository: project.repository,
                  defaultBranch: project.defaultBranch,
                }}
                submitting={savingProject}
                onSubmit={handleProjectUpdate}
                onCancel={() => setShowProjectEdit(false)}
              />
            )}
          </section>

          <section style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: '1.125rem', color: 'var(--sam-color-fg-primary)' }}>Backlog</h2>
              <Button onClick={() => setShowTaskCreate((value) => !value)}>
                {showTaskCreate ? 'Close task form' : 'New task'}
              </Button>
            </div>

            <TaskFilters value={filters} onChange={setFilters} />

            {showTaskCreate && (
              <div
                style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  padding: 'var(--sam-space-3)',
                }}
              >
                <TaskForm
                  mode="create"
                  tasks={tasks}
                  submitting={savingTask}
                  onSubmit={handleTaskCreate}
                  onCancel={() => setShowTaskCreate(false)}
                />
              </div>
            )}

            {editingTask && (
              <div
                style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  padding: 'var(--sam-space-3)',
                }}
              >
                <TaskForm
                  mode="edit"
                  tasks={tasks}
                  currentTaskId={editingTask.id}
                  initialValues={{
                    title: editingTask.title,
                    description: editingTask.description ?? '',
                    priority: editingTask.priority,
                    parentTaskId: editingTask.parentTaskId ?? '',
                  }}
                  submitting={savingTask}
                  onSubmit={handleTaskUpdate}
                  onCancel={() => setEditingTask(null)}
                />
              </div>
            )}

            <TaskList
              tasks={tasks}
              loading={tasksLoading}
              selectedTaskId={selectedTaskId ?? undefined}
              onSelectTask={(taskId) => setSelectedTaskId(taskId)}
              onEditTask={(task) => setEditingTask(task)}
              onDeleteTask={handleTaskDelete}
              onTransitionTask={handleTaskTransition}
              onManageDependencies={(task) => {
                setDependencyTask(task);
                setSelectedTaskId(task.id);
              }}
              onDelegateTask={(task) => setDelegateTargetTask(task)}
            />

            <TaskDependencyEditor
              task={dependencyTask}
              tasks={tasks}
              dependencies={
                selectedTaskDetail && dependencyTask && selectedTaskDetail.id === dependencyTask.id
                  ? selectedTaskDetail.dependencies
                  : []
              }
              loading={savingDependency || detailLoading}
              onAdd={handleAddDependency}
              onRemove={handleRemoveDependency}
              onClose={() => setDependencyTask(null)}
            />
          </section>

          <TaskDetailPanel
            task={selectedTask && selectedTaskDetail && selectedTaskDetail.id === selectedTask.id ? selectedTaskDetail : null}
            events={taskEvents}
            loading={detailLoading}
            onClose={() => setSelectedTaskId(null)}
          />
        </div>
      )}

      <TaskDelegateDialog
        open={!!delegateTargetTask}
        task={delegateTargetTask}
        workspaces={workspaces}
        loading={delegating}
        onClose={() => setDelegateTargetTask(null)}
        onDelegate={handleDelegate}
      />
    </PageLayout>
  );
}
