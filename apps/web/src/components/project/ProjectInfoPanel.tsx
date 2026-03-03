/**
 * ProjectInfoPanel — slide-out panel showing active workspaces and recent tasks.
 *
 * Gives users visibility into what's happening in a project without leaving
 * the chat-first interface. Accessible via the info icon in the project header.
 */
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Task, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { listProjectTasks, listWorkspaces } from '../../lib/api';

interface ProjectInfoPanelProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

const MAX_ITEMS = 5;

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const ProjectInfoPanel: FC<ProjectInfoPanelProps> = ({ projectId, open, onClose }) => {
  const panelRef = useCallback((node: HTMLDivElement | null) => {
    if (node && open) node.focus();
  }, [open]);

  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedRef = useRef(false);

  // Reset when project changes
  useEffect(() => {
    hasLoadedRef.current = false;
    setLoading(true);
  }, [projectId]);

  const loadData = useCallback(async () => {
    try {
      if (hasLoadedRef.current) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      const [ws, taskResult] = await Promise.all([
        listWorkspaces(undefined, undefined, projectId).catch(() => [] as WorkspaceResponse[]),
        listProjectTasks(projectId, { limit: MAX_ITEMS }).catch(() => ({ tasks: [] as Task[], total: 0 })),
      ]);
      setWorkspaces(ws);
      setTasks(taskResult.tasks);
      hasLoadedRef.current = true;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const activeWorkspaces = workspaces.filter((w) => w.status === 'running' || w.status === 'creating');
  const stoppedWorkspaces = workspaces.filter((w) => w.status !== 'running' && w.status !== 'creating');

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-panel-title"
        tabIndex={-1}
        className="fixed top-0 right-0 bottom-0 w-[min(400px,90vw)] bg-surface shadow-overlay z-drawer flex flex-col overflow-y-auto outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-default shrink-0">
          <div className="flex items-center gap-2">
            <h2 id="info-panel-title" className="m-0 text-base font-semibold text-fg-primary">
              Project Status
            </h2>
            {refreshing && <Spinner size="sm" />}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close project status"
            className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm flex items-center"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 grid gap-6 content-start">
          {loading ? (
            <div className="flex items-center gap-2 justify-center p-8">
              <Spinner size="md" />
              <span className="text-fg-muted">Loading...</span>
            </div>
          ) : (
            <>
              {/* Workspaces section */}
              <section className="grid gap-3">
                <h3 className="sam-type-card-title m-0 text-fg-primary">
                  Workspaces
                  {workspaces.length > 0 && (
                    <span className="font-normal text-fg-muted ml-2">
                      ({workspaces.length})
                    </span>
                  )}
                </h3>

                {workspaces.length === 0 ? (
                  <p className="sam-type-secondary m-0 text-fg-muted">
                    No workspaces for this project.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {/* Active first, then stopped */}
                    {[...activeWorkspaces, ...stoppedWorkspaces].slice(0, MAX_ITEMS).map((ws) => (
                      <div
                        key={ws.id}
                        className="flex items-center gap-2 py-2 px-3 border border-border-default rounded-sm text-sm"
                      >
                        <StatusBadge status={ws.status} />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap">
                            {ws.displayName || ws.name}
                          </div>
                          {ws.branch && (
                            <div className="sam-type-caption text-fg-muted font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                              {ws.branch}
                            </div>
                          )}
                        </div>
                        {ws.status === 'running' && (
                          <Link
                            to={`/workspaces/${ws.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button variant="ghost" size="sm">Open</Button>
                          </Link>
                        )}
                      </div>
                    ))}
                    {workspaces.length > MAX_ITEMS && (
                      <Link
                        to={`/projects/${projectId}/overview`}
                        onClick={onClose}
                        className="sam-type-caption text-accent no-underline"
                      >
                        View all {workspaces.length} workspaces
                      </Link>
                    )}
                  </div>
                )}
              </section>

              {/* Tasks section */}
              <section className="grid gap-3">
                <h3 className="sam-type-card-title m-0 text-fg-primary">
                  Recent Tasks
                </h3>

                {tasks.length === 0 ? (
                  <p className="sam-type-secondary m-0 text-fg-muted">
                    No tasks yet.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {tasks.map((task) => (
                      <Link
                        key={task.id}
                        to={`/projects/${projectId}/tasks/${task.id}`}
                        onClick={onClose}
                        className="no-underline text-inherit"
                      >
                        <div
                          className="sam-hover-surface flex items-center gap-2 py-2 px-3 border border-border-default rounded-sm text-sm"
                        >
                          <StatusBadge status={task.status} />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap">
                              {task.title}
                            </div>
                            <div className="sam-type-caption text-fg-muted">
                              {timeAgo(task.updatedAt)}
                              {task.outputBranch && (
                                <span className="ml-2 font-mono">
                                  {task.outputBranch}
                                </span>
                              )}
                            </div>
                          </div>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sam-color-fg-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </div>
                      </Link>
                    ))}
                    {tasks.length >= MAX_ITEMS && (
                      <Link
                        to={`/projects/${projectId}/tasks`}
                        onClick={onClose}
                        className="sam-type-caption text-accent no-underline"
                      >
                        View all tasks
                      </Link>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
};
