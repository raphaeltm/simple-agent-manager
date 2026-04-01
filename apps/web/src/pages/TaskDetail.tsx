import type {
  Task,
  TaskDetailResponse,
  TaskStatus,
  TaskStatusEvent,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { TaskDelegateDialog } from '../components/project/TaskDelegateDialog';
import { TaskDependencyEditor } from '../components/project/TaskDependencyEditor';
import { useGlobalAudio } from '../contexts/GlobalAudioContext';
import { useToast } from '../hooks/useToast';
import {
  addTaskDependency,
  delegateTask,
  deleteProjectTask,
  getProjectTask,
  getTtsApiUrl,
  listProjectTasks,
  listTaskEvents,
  listWorkspaces,
  removeTaskDependency,
  updateProjectTask,
  updateProjectTaskStatus,
} from '../lib/api';
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

/** Lazily computed TTS API URL — avoids module-scope errors in test environments. */
let _cachedTtsApiUrl: string | undefined;
function getTtsUrl(): string {
  if (!_cachedTtsApiUrl) _cachedTtsApiUrl = getTtsApiUrl();
  return _cachedTtsApiUrl;
}

/** Output section with audio playback support for task summaries. */
function TaskOutputSection({ task }: { task: TaskDetailResponse }) {
  const globalAudio = useGlobalAudio();
  const showSpeaker = !!task.outputSummary;

  const handlePlayAudio = useCallback(() => {
    if (!task.outputSummary) return;
    globalAudio.startPlayback({
      text: task.outputSummary,
      ttsApiUrl: getTtsUrl(),
      ttsStorageId: `task-${task.id}`,
      label: 'Task Output',
      sourceText: task.outputSummary.slice(0, 200),
    });
  }, [globalAudio, task.outputSummary, task.id]);

  if (!task.outputSummary && !task.outputBranch && !task.outputPrUrl) return null;

  return (
    <section className="grid gap-2 border border-border-default rounded-md p-3 bg-surface">
      <div className="flex items-center gap-2">
        <h2 className="sam-type-card-title m-0 text-fg-primary">
          Output
        </h2>
        {showSpeaker && (
          <button
            type="button"
            onClick={handlePlayAudio}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors hover:bg-[var(--sam-color-bg-inset)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-accent-primary,#16a34a)]"
            style={{ color: 'var(--sam-color-fg-muted)' }}
            aria-label="Read summary aloud"
            title="Read summary aloud"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          </button>
        )}
      </div>

      {task.outputSummary && (
        <p className="sam-type-secondary m-0 text-fg-muted whitespace-pre-wrap">
          {task.outputSummary}
        </p>
      )}
      {task.outputBranch && (
        <div className="sam-type-secondary">
          <strong>Branch: </strong>
          <code className="bg-page py-0.5 px-1.5 rounded-[4px] text-xs">
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
            className="text-accent"
          >
            {task.outputPrUrl}
          </a>
        </div>
      )}
    </section>
  );
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
      {/* Breadcrumb within project context */}
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: project?.name ?? '...', path: `/projects/${projectId}` },
          { label: 'Tasks', path: `/projects/${projectId}/tasks` },
          { label: task?.title ?? '...' },
        ]}
      />

      {error && (
        <div className="mt-3">
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {loading && !task ? (
        <div className="flex items-center gap-2 mt-4">
          <Spinner size="md" />
          <span className="text-fg-muted">Loading task...</span>
        </div>
      ) : task ? (
        <div className="grid gap-4 items-start mt-4 md:grid-cols-[minmax(0,1fr)_300px]">
          {/* Main content column */}
          <div className="grid gap-4">

            {/* Title + status row */}
            <div className="grid gap-2">
              {editingTitle ? (
                <div className="flex gap-2 items-center">
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
                    className="flex-1 text-base font-semibold bg-surface border border-accent rounded-md text-fg-primary py-1.5 px-2"
                  />
                  {savingTitle && <Spinner size="sm" />}
                </div>
              ) : (
                <button
                  className="text-left bg-transparent border-none p-0 cursor-text text-base font-semibold text-fg-primary hover:underline hover:decoration-dotted"
                  onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
                  title="Click to edit title"
                >
                  {task.title}
                </button>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={task.status} />
                {task.blocked && (
                  <span className="text-xs py-0.5 px-2 rounded-full bg-danger-tint text-danger font-semibold">
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
                    className="rounded-md border border-border-default bg-surface text-fg-primary text-sm py-1 px-2 min-h-8"
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
            <section className="grid gap-2">
              <h2 className="sam-type-card-title m-0 text-fg-primary">
                Description
              </h2>
              {task.description ? (
                <p className="sam-type-body m-0 text-fg-muted whitespace-pre-wrap leading-relaxed">
                  {task.description}
                </p>
              ) : (
                <p className="sam-type-body m-0 text-fg-muted italic">
                  No description.
                </p>
              )}
            </section>

            {/* Output (with audio playback for summaries) */}
            <TaskOutputSection task={task} />

            {/* Error */}
            {task.errorMessage && (
              <section className="border border-danger rounded-md p-3 bg-danger-tint grid gap-1.5">
                <h2 className="sam-type-card-title m-0 text-danger">Error</h2>
                <p className="sam-type-secondary m-0 text-fg-muted whitespace-pre-wrap">
                  {task.errorMessage}
                </p>
              </section>
            )}

            {/* Activity log */}
            <section className="grid gap-2">
              <h2 className="sam-type-card-title m-0 text-fg-primary">
                Activity
              </h2>
              {events.length === 0 ? (
                <p className="sam-type-secondary m-0 text-fg-muted">No activity yet.</p>
              ) : (
                <ul className="m-0 p-0 list-none grid gap-2">
                  {events.map((event) => (
                    <li
                      key={event.id}
                      className="text-xs flex items-center gap-2 flex-wrap"
                    >
                      <span className="sam-type-caption text-fg-muted shrink-0">
                        {formatDate(event.createdAt)}
                      </span>
                      <span className="flex items-center gap-1">
                        {event.fromStatus && (
                          <>
                            <StatusBadge status={event.fromStatus} />
                            <span className="text-fg-muted">→</span>
                          </>
                        )}
                        <StatusBadge status={event.toStatus} />
                      </span>
                      {event.actorType && (
                        <span className="sam-type-caption text-fg-muted">
                          by {event.actorType}
                        </span>
                      )}
                      {event.reason && (
                        <span className="sam-type-caption text-fg-muted">
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
          <aside className="grid gap-3 border border-border-default rounded-md bg-surface p-3">
            {/* Metadata */}
            <div className="grid gap-2 text-sm text-fg-muted">
              <div><strong className="text-fg-primary">Priority:</strong> {task.priority}</div>
              <div><strong className="text-fg-primary">Created:</strong> {formatDate(task.createdAt)}</div>
              <div><strong className="text-fg-primary">Updated:</strong> {formatDate(task.updatedAt)}</div>
              {task.startedAt && (
                <div><strong className="text-fg-primary">Started:</strong> {formatDate(task.startedAt)}</div>
              )}
              {task.completedAt && (
                <div><strong className="text-fg-primary">Completed:</strong> {formatDate(task.completedAt)}</div>
              )}
              {task.workspaceId && (
                <div>
                  <strong className="text-fg-primary">Workspace: </strong>
                  <Link
                    to={`/workspaces/${task.workspaceId}`}
                    className="text-accent"
                  >
                    View workspace
                  </Link>
                </div>
              )}
            </div>

            <hr className="m-0 border-none border-t border-border-default" />

            {/* Dependencies */}
            <TaskDependencyEditor
              task={task}
              tasks={siblingTasks}
              dependencies={task.dependencies}
              loading={savingDependency}
              onAdd={handleAddDependency}
              onRemove={handleRemoveDependency}
            />

            <hr className="m-0 border-none border-t border-border-default" />

            {/* Actions */}
            <div className="grid gap-2">
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
