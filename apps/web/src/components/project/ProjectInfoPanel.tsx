/**
 * ProjectInfoPanel — slide-out panel showing active workspaces and recent tasks.
 *
 * Gives users visibility into what's happening in a project without leaving
 * the chat-first interface. Accessible via the info icon in the project header.
 */
import { type FC, useCallback, useEffect, useState } from 'react';
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

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [ws, taskResult] = await Promise.all([
        listWorkspaces(undefined, undefined, projectId).catch(() => [] as WorkspaceResponse[]),
        listProjectTasks(projectId, { limit: MAX_ITEMS }).catch(() => ({ tasks: [] as Task[], total: 0 })),
      ]);
      setWorkspaces(ws);
      setTasks(taskResult.tasks);
    } finally {
      setLoading(false);
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
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--sam-color-bg-overlay)',
          zIndex: 'var(--sam-z-drawer-backdrop)' as unknown as number,
        }}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-panel-title"
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(400px, 90vw)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          boxShadow: 'var(--sam-shadow-overlay)',
          zIndex: 'var(--sam-z-drawer)' as unknown as number,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          outline: 'none',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--sam-space-4)',
          borderBottom: '1px solid var(--sam-color-border-default)',
          flexShrink: 0,
        }}>
          <h2 id="info-panel-title" style={{
            margin: 0,
            fontSize: 'var(--sam-type-section-heading-size)',
            fontWeight: 600,
            color: 'var(--sam-color-fg-primary)',
          }}>
            Project Status
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close project status"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--sam-color-fg-muted)',
              padding: 'var(--sam-space-1)',
              borderRadius: 'var(--sam-radius-sm)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, padding: 'var(--sam-space-4)', display: 'grid', gap: 'var(--sam-space-6)', alignContent: 'start' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
              <Spinner size="md" />
              <span style={{ color: 'var(--sam-color-fg-muted)' }}>Loading...</span>
            </div>
          ) : (
            <>
              {/* Workspaces section */}
              <section style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
                <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                  Workspaces
                  {workspaces.length > 0 && (
                    <span style={{ fontWeight: 400, color: 'var(--sam-color-fg-muted)', marginLeft: 'var(--sam-space-2)' }}>
                      ({workspaces.length})
                    </span>
                  )}
                </h3>

                {workspaces.length === 0 ? (
                  <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>
                    No workspaces for this project.
                  </p>
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                    {/* Active first, then stopped */}
                    {[...activeWorkspaces, ...stoppedWorkspaces].slice(0, MAX_ITEMS).map((ws) => (
                      <div
                        key={ws.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 'var(--sam-space-2)',
                          padding: 'var(--sam-space-2) var(--sam-space-3)',
                          border: '1px solid var(--sam-color-border-default)',
                          borderRadius: 'var(--sam-radius-sm)',
                          fontSize: 'var(--sam-type-secondary-size)',
                        }}
                      >
                        <StatusBadge status={ws.status} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontWeight: 500,
                            color: 'var(--sam-color-fg-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {ws.displayName || ws.name}
                          </div>
                          {ws.branch && (
                            <div className="sam-type-caption" style={{
                              color: 'var(--sam-color-fg-muted)',
                              fontFamily: 'monospace',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
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
                        className="sam-type-caption"
                        style={{ color: 'var(--sam-color-accent-primary)', textDecoration: 'none' }}
                      >
                        View all {workspaces.length} workspaces
                      </Link>
                    )}
                  </div>
                )}
              </section>

              {/* Tasks section */}
              <section style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
                <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                  Recent Tasks
                </h3>

                {tasks.length === 0 ? (
                  <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>
                    No tasks yet.
                  </p>
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                    {tasks.map((task) => (
                      <Link
                        key={task.id}
                        to={`/projects/${projectId}/tasks/${task.id}`}
                        onClick={onClose}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div
                          className="sam-hover-surface"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--sam-space-2)',
                            padding: 'var(--sam-space-2) var(--sam-space-3)',
                            border: '1px solid var(--sam-color-border-default)',
                            borderRadius: 'var(--sam-radius-sm)',
                            fontSize: 'var(--sam-type-secondary-size)',
                          }}
                        >
                          <StatusBadge status={task.status} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontWeight: 500,
                              color: 'var(--sam-color-fg-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {task.title}
                            </div>
                            <div className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
                              {timeAgo(task.updatedAt)}
                              {task.outputBranch && (
                                <span style={{ marginLeft: 'var(--sam-space-2)', fontFamily: 'monospace' }}>
                                  {task.outputBranch}
                                </span>
                              )}
                            </div>
                          </div>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sam-color-fg-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </div>
                      </Link>
                    ))}
                    {tasks.length >= MAX_ITEMS && (
                      <Link
                        to={`/projects/${projectId}/tasks`}
                        onClick={onClose}
                        className="sam-type-caption"
                        style={{ color: 'var(--sam-color-accent-primary)', textDecoration: 'none' }}
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
