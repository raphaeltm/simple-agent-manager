import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  GitHubInstallation,
  ProjectDetailResponse,
  ProjectRuntimeConfigResponse,
  Task,
  TaskSortOrder,
  TaskStatus,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import {
  createProjectTask,
  createWorkspace,
  deleteProject,
  deleteProjectRuntimeEnvVar,
  deleteProjectRuntimeFile,
  deleteProjectTask,
  delegateTask,
  getProject,
  getProjectRuntimeConfig,
  listActivityEvents,
  listChatSessions,
  listGitHubInstallations,
  listProjectTasks,
  listWorkspaces,
  updateProject,
  updateProjectTaskStatus,
  upsertProjectRuntimeEnvVar,
  upsertProjectRuntimeFile,
} from '../lib/api';
import type { ActivityEventResponse, ChatSessionResponse } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { ProjectForm, type ProjectFormValues } from '../components/project/ProjectForm';
import { TaskFilters, type TaskFilterState } from '../components/project/TaskFilters';
import { TaskForm, type TaskFormValues } from '../components/project/TaskForm';
import { TaskList } from '../components/project/TaskList';
import { TaskDelegateDialog } from '../components/project/TaskDelegateDialog';
import { NeedsAttentionSection } from '../components/project/NeedsAttentionSection';
import { ChatSessionList } from '../components/ChatSessionList';
import { ActivityFeed } from '../components/ActivityFeed';

type ProjectTab = 'overview' | 'tasks';

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

export function Project() {
  const navigate = useNavigate();
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();

  // Active tab — driven by ?tab= search param
  const activeTab: ProjectTab = searchParams.get('tab') === 'tasks' ? 'tasks' : 'overview';

  const setTab = (tab: ProjectTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'overview') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      return next;
    }, { replace: true });
  };

  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfigResponse>({ envVars: [], files: [] });
  const [projectLoading, setProjectLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [runtimeConfigLoading, setRuntimeConfigLoading] = useState(true);
  const [chatSessions, setChatSessions] = useState<ChatSessionResponse[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEventResponse[]>([]);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showProjectEdit, setShowProjectEdit] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [delegateTargetTask, setDelegateTargetTask] = useState<Task | null>(null);

  const [savingProject, setSavingProject] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);
  const [launchingWorkspace, setLaunchingWorkspace] = useState(false);

  const [envKeyInput, setEnvKeyInput] = useState('');
  const [envValueInput, setEnvValueInput] = useState('');
  const [envSecretInput, setEnvSecretInput] = useState(false);
  const [filePathInput, setFilePathInput] = useState('');
  const [fileContentInput, setFileContentInput] = useState('');
  const [fileSecretInput, setFileSecretInput] = useState(false);

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

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      setError(null);
      setProjectLoading(true);
      setProject(await getProject(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setProjectLoading(false);
    }
  }, [projectId]);

  const loadTasks = useCallback(async () => {
    if (!projectId) return;
    try {
      setTasksLoading(true);
      const response = await listProjectTasks(projectId, {
        status: filters.status,
        minPriority: filters.minPriority,
        sort: filters.sort,
      });
      setTasks(response.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setTasksLoading(false);
    }
  }, [projectId, filters.status, filters.minPriority, filters.sort]);

  const loadRuntimeConfig = useCallback(async () => {
    if (!projectId) return;
    try {
      setRuntimeConfigLoading(true);
      const config = await getProjectRuntimeConfig(projectId);
      setRuntimeConfig(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runtime config');
    } finally {
      setRuntimeConfigLoading(false);
    }
  }, [projectId]);

  const loadChatSessions = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await listChatSessions(projectId, { limit: 10 });
      setChatSessions(result.sessions);
    } catch {
      // Best-effort — chat sessions may not exist for pre-migration projects
    }
  }, [projectId]);

  const loadActivityEvents = useCallback(async (loadMore = false) => {
    if (!projectId) return;
    try {
      setActivityLoading(true);
      const lastEvent = loadMore ? activityEvents[activityEvents.length - 1] : undefined;
      const before = lastEvent?.createdAt;
      const result = await listActivityEvents(projectId, { limit: 20, before });
      if (loadMore) {
        setActivityEvents((prev) => [...prev, ...result.events]);
      } else {
        setActivityEvents(result.events);
      }
      setActivityHasMore(result.hasMore);
    } catch {
      // Best-effort
    } finally {
      setActivityLoading(false);
    }
  }, [projectId, activityEvents]);

  useEffect(() => { void loadProject(); }, [loadProject]);
  useEffect(() => { void loadTasks(); }, [loadTasks]);
  useEffect(() => { void loadRuntimeConfig(); }, [loadRuntimeConfig]);
  useEffect(() => { void loadChatSessions(); }, [loadChatSessions]);
  useEffect(() => { void loadActivityEvents(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void listGitHubInstallations()
      .then((response) => setInstallations(response))
      .catch(() => setInstallations([]));
    void listWorkspaces('running')
      .then((response) => setWorkspaces(response))
      .catch(() => setWorkspaces([]));
  }, []);

  const handleProjectUpdate = async (values: ProjectFormValues) => {
    if (!projectId) return;
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
    if (!projectId) return;
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

  const handleTaskDelete = async (task: Task) => {
    if (!projectId) return;
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await deleteProjectTask(projectId, task.id);
      toast.success('Task deleted');
      await loadTasks();
      await loadProject();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

  const handleTaskTransition = async (task: Task, toStatus: TaskStatus) => {
    if (!projectId) return;
    try {
      await updateProjectTaskStatus(projectId, task.id, { toStatus });
      toast.success(`Task moved to ${toStatus.replace('_', ' ')}`);
      await loadTasks();
      await loadProject();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  const handleDelegate = async (workspaceId: string) => {
    if (!projectId || !delegateTargetTask) return;
    try {
      setDelegating(true);
      await delegateTask(projectId, delegateTargetTask.id, { workspaceId });
      toast.success('Task delegated');
      setDelegateTargetTask(null);
      await loadTasks();
      await loadProject();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delegate task');
    } finally {
      setDelegating(false);
    }
  };

  const handleUpsertEnvVar = async () => {
    if (!projectId) return;
    if (!envKeyInput.trim()) {
      toast.error('Env key is required');
      return;
    }
    try {
      setSavingRuntimeConfig(true);
      const response = await upsertProjectRuntimeEnvVar(projectId, {
        key: envKeyInput.trim(),
        value: envValueInput,
        isSecret: envSecretInput,
      });
      setRuntimeConfig(response);
      setEnvKeyInput('');
      setEnvValueInput('');
      setEnvSecretInput(false);
      toast.success('Runtime env var saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save env var');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleDeleteEnvVar = async (envKey: string) => {
    if (!projectId) return;
    try {
      setSavingRuntimeConfig(true);
      const response = await deleteProjectRuntimeEnvVar(projectId, envKey);
      setRuntimeConfig(response);
      toast.success(`Removed ${envKey}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove env var');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleUpsertFile = async () => {
    if (!projectId) return;
    if (!filePathInput.trim()) {
      toast.error('File path is required');
      return;
    }
    try {
      setSavingRuntimeConfig(true);
      const response = await upsertProjectRuntimeFile(projectId, {
        path: filePathInput.trim(),
        content: fileContentInput,
        isSecret: fileSecretInput,
      });
      setRuntimeConfig(response);
      setFilePathInput('');
      setFileContentInput('');
      setFileSecretInput(false);
      toast.success('Runtime file saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save runtime file');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleDeleteFile = async (path: string) => {
    if (!projectId) return;
    try {
      setSavingRuntimeConfig(true);
      const response = await deleteProjectRuntimeFile(projectId, path);
      setRuntimeConfig(response);
      toast.success(`Removed ${path}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove runtime file');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleLaunchWorkspace = async () => {
    if (!project) return;
    try {
      setLaunchingWorkspace(true);
      const workspace = await createWorkspace({
        name: `${project.name} Workspace`,
        projectId: project.id,
      });
      toast.success('Workspace launch started');
      navigate(`/workspaces/${workspace.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to launch workspace');
    } finally {
      setLaunchingWorkspace(false);
    }
  };

  if (!projectId) {
    return (
      <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
        <Alert variant="error">Project ID is missing.</Alert>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
      {/* Breadcrumb */}
      <nav style={{ marginBottom: 'var(--sam-space-4)', fontSize: '0.875rem' }}>
        <Link to="/" style={{ color: 'var(--sam-color-fg-muted)', textDecoration: 'none' }}>Dashboard</Link>
        <span style={{ margin: '0 var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>/</span>
        <span style={{ color: 'var(--sam-color-fg-primary)' }}>{project?.name || 'Project'}</span>
      </nav>
      <style>{`
        .project-tab-btn {
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          padding: 0.5rem 0.25rem;
          cursor: pointer;
          font-size: 0.9375rem;
          font-weight: 500;
          color: var(--sam-color-fg-muted);
          transition: color 0.15s, border-color 0.15s;
          min-height: 44px;
        }
        .project-tab-btn:hover {
          color: var(--sam-color-fg-primary);
        }
        .project-tab-btn[aria-selected="true"] {
          color: var(--sam-color-fg-primary);
          border-bottom-color: var(--sam-color-accent-primary);
        }
      `}</style>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {projectLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          <Spinner size="md" />
          <span>Loading project…</span>
        </div>
      ) : !project ? (
        <Alert variant="error">Project not found.</Alert>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>

          {/* ── Project header ── */}
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
              <Button
                onClick={handleLaunchWorkspace}
                loading={launchingWorkspace}
                disabled={launchingWorkspace || project.status === 'detached'}
                title={project.status === 'detached' ? 'Cannot launch workspace for a detached project' : undefined}
              >
                Launch Workspace
              </Button>
              <Button variant="secondary" onClick={() => setShowProjectEdit((v) => !v)}>
                {showProjectEdit ? 'Close edit' : 'Edit project'}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (!window.confirm(`Delete project "${project.name}"?`)) return;
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

          {/* Detached warning */}
          {project.status === 'detached' && (
            <Alert variant="warning">
              This project&apos;s GitHub repository has been deleted. Workspace creation is disabled.
              You can still view existing sessions, tasks, and activity.
            </Alert>
          )}

          {/* ── Tab strip ── */}
          <div
            role="tablist"
            style={{
              display: 'flex',
              gap: 'var(--sam-space-4)',
              borderBottom: '1px solid var(--sam-color-border-default)',
            }}
          >
            <button
              role="tab"
              aria-selected={activeTab === 'overview'}
              className="project-tab-btn"
              onClick={() => setTab('overview')}
            >
              Overview
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'tasks'}
              className="project-tab-btn"
              onClick={() => setTab('tasks')}
            >
              Tasks
            </button>
          </div>

          {/* ── Overview tab ── */}
          {activeTab === 'overview' && (
            <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>

              {/* Summary stats */}
              <section
                style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  padding: 'var(--sam-space-3)',
                  display: 'grid',
                  gap: 'var(--sam-space-2)',
                }}
              >
                <div style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>
                  Linked workspaces: {project.summary.linkedWorkspaces}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem' }}>
                  <span style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>Tasks:</span>
                  {(Object.entries(project.summary.taskCountsByStatus) as [string, number][])
                    .filter(([, count]) => count > 0)
                    .map(([status, count]) => (
                      <StatusBadge
                        key={status}
                        status={status}
                        label={`${status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} (${count})`}
                      />
                    ))}
                  {Object.values(project.summary.taskCountsByStatus).every((c) => c === 0) && (
                    <span style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>none</span>
                  )}
                </div>
              </section>

              {/* Edit form */}
              {showProjectEdit && (
                <section
                  style={{
                    border: '1px solid var(--sam-color-border-default)',
                    borderRadius: 'var(--sam-radius-md)',
                    background: 'var(--sam-color-bg-surface)',
                    padding: 'var(--sam-space-3)',
                  }}
                >
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
                </section>
              )}

              {/* Runtime Config */}
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
                <h2 style={{ margin: 0, fontSize: '1.125rem', color: 'var(--sam-color-fg-primary)' }}>
                  Runtime Config
                </h2>

                {runtimeConfigLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                    <Spinner size="sm" />
                    <span>Loading runtime config...</span>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
                    <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                      <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--sam-color-fg-primary)' }}>Environment Variables</h3>
                      <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                        <input
                          aria-label="Runtime env key"
                          placeholder="API_TOKEN"
                          value={envKeyInput}
                          onChange={(event) => setEnvKeyInput(event.currentTarget.value)}
                        />
                        <input
                          aria-label="Runtime env value"
                          placeholder="Value"
                          value={envValueInput}
                          onChange={(event) => setEnvValueInput(event.currentTarget.value)}
                        />
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem' }}>
                          <input
                            type="checkbox"
                            checked={envSecretInput}
                            onChange={(event) => setEnvSecretInput(event.currentTarget.checked)}
                          />
                          Secret
                        </label>
                        <Button
                          variant="secondary"
                          onClick={handleUpsertEnvVar}
                          loading={savingRuntimeConfig}
                          disabled={savingRuntimeConfig}
                        >
                          Save
                        </Button>
                      </div>
                      {runtimeConfig.envVars.length === 0 ? (
                        <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.8125rem' }}>
                          No runtime env vars configured.
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: '0.5rem' }}>
                          {runtimeConfig.envVars.map((item) => (
                            <div
                              key={item.key}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 'var(--sam-space-2)',
                                alignItems: 'center',
                                fontSize: '0.8125rem',
                              }}
                            >
                              <div>
                                <strong>{item.key}</strong>{' '}
                                <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                                  {item.isSecret ? '••••••' : item.value}
                                </span>
                              </div>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => void handleDeleteEnvVar(item.key)}
                                disabled={savingRuntimeConfig}
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                      <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--sam-color-fg-primary)' }}>Runtime Files</h3>
                      <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                        <input
                          aria-label="Runtime file path"
                          placeholder=".env.local"
                          value={filePathInput}
                          onChange={(event) => setFilePathInput(event.currentTarget.value)}
                        />
                        <textarea
                          aria-label="Runtime file content"
                          placeholder="FOO=bar"
                          rows={4}
                          value={fileContentInput}
                          onChange={(event) => setFileContentInput(event.currentTarget.value)}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem' }}>
                            <input
                              type="checkbox"
                              checked={fileSecretInput}
                              onChange={(event) => setFileSecretInput(event.currentTarget.checked)}
                            />
                            Secret file content
                          </label>
                          <Button
                            variant="secondary"
                            onClick={handleUpsertFile}
                            loading={savingRuntimeConfig}
                            disabled={savingRuntimeConfig}
                          >
                            Save file
                          </Button>
                        </div>
                      </div>
                      {runtimeConfig.files.length === 0 ? (
                        <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.8125rem' }}>
                          No runtime files configured.
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: '0.5rem' }}>
                          {runtimeConfig.files.map((item) => (
                            <div
                              key={item.path}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 'var(--sam-space-2)',
                                alignItems: 'center',
                                fontSize: '0.8125rem',
                              }}
                            >
                              <div>
                                <strong>{item.path}</strong>{' '}
                                <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                                  {item.isSecret ? '••••••' : 'stored'}
                                </span>
                              </div>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => void handleDeleteFile(item.path)}
                                disabled={savingRuntimeConfig}
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/* Chat sessions (from DO) */}
              <section
                style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: 'var(--sam-space-3) var(--sam-space-4)', borderBottom: '1px solid var(--sam-color-border-default)' }}>
                  <strong style={{ color: 'var(--sam-color-fg-primary)', fontSize: '0.9375rem' }}>
                    Chat Sessions
                  </strong>
                </div>
                <ChatSessionList
                  sessions={chatSessions}
                  onSelect={(sessionId) => navigate(`/projects/${projectId}/sessions/${sessionId}`)}
                />
              </section>

              {/* Activity feed */}
              <section
                style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: 'var(--sam-space-3) var(--sam-space-4)', borderBottom: '1px solid var(--sam-color-border-default)' }}>
                  <strong style={{ color: 'var(--sam-color-fg-primary)', fontSize: '0.9375rem' }}>
                    Activity
                  </strong>
                </div>
                <ActivityFeed
                  events={activityEvents}
                  hasMore={activityHasMore}
                  onLoadMore={() => void loadActivityEvents(true)}
                  loading={activityLoading}
                />
              </section>
            </div>
          )}

          {/* ── Tasks tab ── */}
          {activeTab === 'tasks' && (
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
                <Button onClick={() => setShowTaskCreate((v) => !v)}>
                  {showTaskCreate ? 'Cancel' : 'New task'}
                </Button>
              </div>

              {/* New task form */}
              {showTaskCreate && (
                <div style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  padding: 'var(--sam-space-3)',
                }}>
                  <TaskForm
                    mode="create"
                    tasks={tasks}
                    submitting={savingTask}
                    onSubmit={handleTaskCreate}
                    onCancel={() => setShowTaskCreate(false)}
                  />
                </div>
              )}

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
            </div>
          )}
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
