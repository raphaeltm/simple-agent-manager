import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  Task,
  TaskDetailResponse,
  TaskStatus,
  TaskStatusEvent,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import {
  addTaskDependency,
  deleteProjectTask,
  delegateTask,
  getProjectTask,
  listProjectTasks,
  listTaskEvents,
  listWorkspaces,
  removeTaskDependency,
  updateProjectTask,
  updateProjectTaskStatus,
} from '../lib/api';
import { useToast } from '../hooks/useToast';
import { TaskDependencyEditor } from '../components/project/TaskDependencyEditor';
import { TaskDelegateDialog } from '../components/project/TaskDelegateDialog';
import { useProjectContext } from './ProjectContext';

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['queued', 'delegated', 'cancelled'],
  queued: ['delegated', 'failed', 'cancelled'],
  delegated: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['ready', 'cancelled'],
  cancelled: ['ready'],
};

function formatDate(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { projectId, project } = useProjectContext();

  const [task, setTask] = useState<TaskDetailResponse | null>(null);
  const [events, setEvents] = useState<TaskStatusEvent[]>([]);
  const [siblingTasks, setSiblingTasks] = useState<Task[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [transitioning, setTransitioning] = useState(false);
  const [savingDependency, setSavingDependency] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [showDelegateDialog, setShowDelegateDialog] = useState(false);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);

  const loadAll = useCallback(async () => {
    if (!taskId) return;
    try {
      setLoading(true);
      setError(null);
      const [taskDetail, eventsResponse, tasksResponse, wsList] = await Promise.all([
        getProjectTask(projectId, taskId),
        listTaskEvents(projectId, taskId, 50),
        listProjectTasks(projectId, {}),
        listWorkspaces('running').catch(() => [] as WorkspaceResponse[]),
      ]);
      setTask(taskDetail);
      setEvents(eventsResponse.events);
      setSiblingTasks(tasksResponse.tasks);
      setWorkspaces(wsList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleTransition = async (toStatus: TaskStatus) => {
    if (!taskId) return;
    try {
      setTransitioning(true);
      await updateProjectTaskStatus(projectId, taskId, { toStatus });
      toast.success(`Status changed to ${toStatus.replace('_', ' ')}`);
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setTransitioning(false);
    }
  };

  const handleSaveTitle = async () => {
    if (!taskId || !titleDraft.trim() || titleDraft === task?.title) {
      setEditingTitle(false);
      return;
    }
    try {
      setSavingTitle(true);
      await updateProjectTask(projectId, taskId, { title: titleDraft.trim() });
      toast.success('Title saved');
      setEditingTitle(false);
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save title');
    } finally {
      setSavingTitle(false);
    }
  };

  const handleAddDependency = async (dependsOnTaskId: string) => {
    if (!taskId) return;
    try {
      setSavingDependency(true);
      await addTaskDependency(projectId, taskId, { dependsOnTaskId });
      toast.success('Dependency added');
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add dependency');
    } finally {
      setSavingDependency(false);
    }
  };

  const handleRemoveDependency = async (dependsOnTaskId: string) => {
    if (!taskId) return;
    try {
      setSavingDependency(true);
      await removeTaskDependency(projectId, taskId, dependsOnTaskId);
      toast.success('Dependency removed');
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove dependency');
    } finally {
      setSavingDependency(false);
    }
  };

  const handleDelegate = async (workspaceId: string) => {
    if (!taskId) return;
    try {
      setDelegating(true);
      await delegateTask(projectId, taskId, { workspaceId });
      toast.success('Task delegated');
      setShowDelegateDialog(false);
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delegate task');
    } finally {
      setDelegating(false);
    }
  };

  const handleDelete = async () => {
    if (!taskId || !task) return;
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await deleteProjectTask(projectId, taskId);
      toast.success('Task deleted');
      navigate(`/projects/${projectId}/tasks`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

  if (!taskId) {
    return <Alert variant="error">Invalid task URL.</Alert>;
  }

  return (
    <div>
      <style>{`
        .task-detail-layout {
          display: grid;
          gap: var(--sam-space-4);
          align-items: start;
        }
        @media (min-width: 768px) {
          .task-detail-layout {
            grid-template-columns: minmax(0, 1fr) 300px;
          }
        }
        .task-title-btn:hover {
          text-decoration: underline;
          text-decoration-style: dotted;
        }
      `}</style>

      {/* Breadcrumb within project context */}
      <Breadcrumb
        segments={[
          { label: 'Dashboard', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: project?.name ?? '...', path: `/projects/${projectId}` },
          { label: 'Tasks', path: `/projects/${projectId}/tasks` },
          { label: task?.title ?? '...' },
        ]}
      />

      {error && (
        <div style={{ marginTop: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {loading && !task ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', marginTop: 'var(--sam-space-4)' }}>
          <Spinner size="md" />
          <span style={{ color: 'var(--sam-color-fg-muted)' }}>Loading task...</span>
        </div>
      ) : task ? (
        <div className="task-detail-layout" style={{ marginTop: 'var(--sam-space-4)' }}>
          {/* Main content column */}
          <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>

            {/* Title + status row */}
            <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              {editingTitle ? (
                <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'center' }}>
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSaveTitle();
                      if (e.key === 'Escape') setEditingTitle(false);
                    }}
                    onBlur={() => void handleSaveTitle()}
                    disabled={savingTitle}
                    style={{
                      flex: 1,
                      fontSize: 'var(--sam-type-section-heading-size)',
                      fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number,
                      background: 'var(--sam-color-bg-surface)',
                      border: '1px solid var(--sam-color-accent-primary)',
                      borderRadius: 'var(--sam-radius-md)',
                      color: 'var(--sam-color-fg-primary)',
                      padding: '0.375rem 0.5rem',
                    }}
                  />
                  {savingTitle && <Spinner size="sm" />}
                </div>
              ) : (
                <button
                  className="task-title-btn"
                  onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
                  title="Click to edit title"
                  style={{
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'text',
                    fontSize: 'var(--sam-type-section-heading-size)',
                    fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number,
                    color: 'var(--sam-color-fg-primary)',
                  }}
                >
                  {task.title}
                </button>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <StatusBadge status={task.status} />
                {task.blocked && (
                  <span style={{
                    fontSize: 'var(--sam-type-caption-size)',
                    padding: '2px 8px',
                    borderRadius: '9999px',
                    background: 'var(--sam-color-danger-tint)',
                    color: 'var(--sam-color-danger)',
                    fontWeight: 600,
                  }}>
                    Blocked
                  </span>
                )}
                {(TRANSITIONS[task.status]?.length ?? 0) > 0 && (
                  <select
                    aria-label="Transition status"
                    defaultValue=""
                    disabled={transitioning}
                    onChange={(e) => {
                      const val = e.currentTarget.value as TaskStatus;
                      if (val) {
                        void handleTransition(val);
                        e.currentTarget.value = '';
                      }
                    }}
                    style={{
                      borderRadius: 'var(--sam-radius-md)',
                      border: '1px solid var(--sam-color-border-default)',
                      background: 'var(--sam-color-bg-surface)',
                      color: 'var(--sam-color-fg-primary)',
                      fontSize: 'var(--sam-type-secondary-size)',
                      padding: '0.25rem 0.5rem',
                      minHeight: '2rem',
                    }}
                  >
                    <option value="">{transitioning ? 'Updating...' : 'Move to...'}</option>
                    {TRANSITIONS[task.status].map((s) => (
                      <option key={s} value={s}>{s.replace('_', ' ')}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Description */}
            <section style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              <h2 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                Description
              </h2>
              {task.description ? (
                <p className="sam-type-body" style={{ margin: 0, color: 'var(--sam-color-fg-muted)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {task.description}
                </p>
              ) : (
                <p className="sam-type-body" style={{ margin: 0, color: 'var(--sam-color-fg-muted)', fontStyle: 'italic' }}>
                  No description.
                </p>
              )}
            </section>

            {/* Output */}
            {(task.outputSummary || task.outputBranch || task.outputPrUrl) && (
              <section style={{
                display: 'grid',
                gap: 'var(--sam-space-2)',
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                padding: 'var(--sam-space-3)',
                background: 'var(--sam-color-bg-surface)',
              }}>
                <h2 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                  Output
                </h2>
                {task.outputSummary && (
                  <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)', whiteSpace: 'pre-wrap' }}>
                    {task.outputSummary}
                  </p>
                )}
                {task.outputBranch && (
                  <div className="sam-type-secondary">
                    <strong>Branch: </strong>
                    <code style={{
                      background: 'var(--sam-color-bg-page)',
                      padding: '0.125rem 0.375rem',
                      borderRadius: '4px',
                      fontSize: 'var(--sam-type-caption-size)',
                    }}>
                      {task.outputBranch}
                    </code>
                  </div>
                )}
                {task.outputPrUrl && (
                  <div className="sam-type-secondary">
                    <strong>Pull Request: </strong>
                    <a
                      href={task.outputPrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--sam-color-accent-primary)' }}
                    >
                      {task.outputPrUrl}
                    </a>
                  </div>
                )}
              </section>
            )}

            {/* Error */}
            {task.errorMessage && (
              <section style={{
                border: '1px solid var(--sam-color-danger)',
                borderRadius: 'var(--sam-radius-md)',
                padding: 'var(--sam-space-3)',
                background: 'var(--sam-color-danger-tint)',
                display: 'grid',
                gap: '0.375rem',
              }}>
                <h2 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-danger)' }}>Error</h2>
                <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)', whiteSpace: 'pre-wrap' }}>
                  {task.errorMessage}
                </p>
              </section>
            )}

            {/* Activity log */}
            <section style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              <h2 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                Activity
              </h2>
              {events.length === 0 ? (
                <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>No activity yet.</p>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.5rem' }}>
                  {events.map((event) => (
                    <li
                      key={event.id}
                      style={{
                        fontSize: 'var(--sam-type-caption-size)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}>
                        {formatDate(event.createdAt)}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        {event.fromStatus && (
                          <>
                            <StatusBadge status={event.fromStatus} />
                            <span style={{ color: 'var(--sam-color-fg-muted)' }}>→</span>
                          </>
                        )}
                        <StatusBadge status={event.toStatus} />
                      </span>
                      {event.actorType && (
                        <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
                          by {event.actorType}
                        </span>
                      )}
                      {event.reason && (
                        <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
                          — {event.reason}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Sidebar */}
          <aside style={{
            display: 'grid',
            gap: 'var(--sam-space-3)',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            background: 'var(--sam-color-bg-surface)',
            padding: 'var(--sam-space-3)',
          }}>
            {/* Metadata */}
            <div style={{ display: 'grid', gap: '0.5rem', fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
              <div><strong style={{ color: 'var(--sam-color-fg-primary)' }}>Priority:</strong> {task.priority}</div>
              <div><strong style={{ color: 'var(--sam-color-fg-primary)' }}>Created:</strong> {formatDate(task.createdAt)}</div>
              <div><strong style={{ color: 'var(--sam-color-fg-primary)' }}>Updated:</strong> {formatDate(task.updatedAt)}</div>
              {task.startedAt && (
                <div><strong style={{ color: 'var(--sam-color-fg-primary)' }}>Started:</strong> {formatDate(task.startedAt)}</div>
              )}
              {task.completedAt && (
                <div><strong style={{ color: 'var(--sam-color-fg-primary)' }}>Completed:</strong> {formatDate(task.completedAt)}</div>
              )}
              {task.workspaceId && (
                <div>
                  <strong style={{ color: 'var(--sam-color-fg-primary)' }}>Workspace: </strong>
                  <Link
                    to={`/workspaces/${task.workspaceId}`}
                    style={{ color: 'var(--sam-color-accent-primary)' }}
                  >
                    View workspace
                  </Link>
                </div>
              )}
            </div>

            <hr style={{ margin: 0, border: 'none', borderTop: '1px solid var(--sam-color-border-default)' }} />

            {/* Dependencies */}
            <TaskDependencyEditor
              task={task}
              tasks={siblingTasks}
              dependencies={task.dependencies}
              loading={savingDependency}
              onAdd={handleAddDependency}
              onRemove={handleRemoveDependency}
            />

            <hr style={{ margin: 0, border: 'none', borderTop: '1px solid var(--sam-color-border-default)' }} />

            {/* Actions */}
            <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              <Button onClick={() => setShowDelegateDialog(true)}>
                Delegate to workspace
              </Button>
              <Button variant="danger" onClick={() => void handleDelete()}>
                Delete task
              </Button>
            </div>
          </aside>
        </div>
      ) : null}

      {task && (
        <TaskDelegateDialog
          open={showDelegateDialog}
          task={task}
          workspaces={workspaces}
          loading={delegating}
          onClose={() => setShowDelegateDialog(false)}
          onDelegate={handleDelegate}
        />
      )}
    </div>
  );
}
