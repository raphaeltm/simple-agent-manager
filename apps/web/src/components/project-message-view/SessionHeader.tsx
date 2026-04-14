import type { DetectedPort, NodeResponse, TaskDetailResponse, VMSize, WorkspaceResponse } from '@simple-agent-manager/shared';
import { VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import { Button, Dialog, Spinner } from '@simple-agent-manager/ui';
import { Box, CheckCircle2, ChevronDown, ChevronUp, Clock, Cloud, Cpu, ExternalLink, FolderOpen, GitBranch, GitCompare, GitFork, Globe, Loader2, MapPin, Monitor, RotateCcw, Server } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { useBrowserSidecar } from '../../hooks/useBrowserSidecar';
import type { ChatSessionResponse } from '../../lib/api';
import { deleteWorkspace, getProjectTask, updateProjectTaskStatus } from '../../lib/api';
import { stripMarkdown } from '../../lib/text-utils';
import { sanitizeUrl } from '../../lib/url-utils';
import type { SessionState } from './types';
import { formatCountdown } from './types';

/** Labeled value pill used in the session context panel. */
function ContextItem({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-muted min-w-0">
      <span className="shrink-0 opacity-60" aria-hidden="true">{icon}</span>
      <span className="font-medium shrink-0">{label}:</span>
      <span className="text-fg-primary truncate min-w-0">{children}</span>
    </div>
  );
}

/** Human-readable VM size label from shared constants. */
function formatVmSize(size: string): string {
  const config = VM_SIZE_LABELS[size as VMSize];
  return config ? config.label : size;
}

/** Collapsible session header — shows title + state dot, with expandable details. */
export function SessionHeader({
  projectId,
  session,
  sessionState,
  loading,
  idleCountdownMs,
  taskEmbed,
  workspace,
  node,
  detectedPorts,
  onSessionMutated,
  onOpenFiles,
  onOpenGit,
  onRetry,
  onFork,
}: {
  projectId: string;
  session: ChatSessionResponse;
  sessionState: SessionState;
  loading: boolean;
  idleCountdownMs: number | null;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: DetectedPort[];
  onSessionMutated?: () => void;
  onOpenFiles?: () => void;
  onOpenGit?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Trigger info — fetched on demand when expanding a task-linked session
  const [triggerDetail, setTriggerDetail] = useState<TaskDetailResponse | null>(null);
  const triggerFetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded || !session.taskId || triggerFetchedRef.current === session.taskId) return;
    triggerFetchedRef.current = session.taskId;
    void getProjectTask(projectId, session.taskId).then((detail) => {
      if (detail.trigger) setTriggerDetail(detail);
    }).catch(() => { /* best-effort */ });
  }, [expanded, session.taskId, projectId]);

  // Browser sidecar — always initialize the hook (React rules of hooks), but only
  // render the button when the workspace exists and session is active.
  const browserEnabled = !!(session.workspaceId && sessionState === 'active');
  const browser = useBrowserSidecar({ projectId, sessionId: session.id });

  const handleOpenBrowser = useCallback(() => {
    if (browser.status?.status === 'running') {
      // Already running — open the auto-login URL in a new tab
      const url = browser.status.autoLoginUrl || browser.status.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [browser.status]);

  const handleStartAndOpen = useCallback(async () => {
    // Open a blank window immediately in the user gesture context to avoid
    // mobile popup blockers. We'll set the URL once the API responds.
    const newWindow = window.open('about:blank', '_blank');

    const firstPort = detectedPorts.length > 0
      ? detectedPorts.slice().sort((a, b) => a.port - b.port)[0]
      : null;
    const result = await browser.start({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      isTouchDevice: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
      userAgent: navigator.userAgent,
      startURL: firstPort ? `http://localhost:${firstPort.port}` : undefined,
    });

    const url = result?.autoLoginUrl || result?.url;
    if (url && newWindow && !newWindow.closed) {
      newWindow.location.href = url;
    } else {
      // Close the blank tab if start failed or returned no URL
      newWindow?.close();
    }
  }, [browser, detectedPorts]);

  const hasDetails = !!(
    taskEmbed?.outputBranch ||
    taskEmbed?.outputPrUrl ||
    session.workspaceId ||
    detectedPorts.length > 0 ||
    (sessionState === 'idle' && idleCountdownMs !== null)
  );

  const canMarkComplete = !!(
    taskEmbed?.id &&
    taskEmbed.status !== 'completed' &&
    taskEmbed.status !== 'cancelled' &&
    taskEmbed.status !== 'failed'
  );

  const handleMarkComplete = useCallback(async () => {
    if (!taskEmbed?.id || completing) return;
    setCompleteError(null);
    setCompleting(true);
    setConfirmOpen(false);
    try {
      // 1. Mark the task as completed (this also stops the chat session server-side)
      await updateProjectTaskStatus(projectId, taskEmbed.id, { toStatus: 'completed' });

      // 2. Delete the workspace if one exists
      if (session.workspaceId) {
        await deleteWorkspace(session.workspaceId);
      }

      // Refresh session list via callback instead of full page reload.
      // Reset completing before the callback so the button is not stuck in
      // "Completing..." if the parent's refresh is slower than expected.
      setCompleting(false);
      onSessionMutated?.();
    } catch (err) {
      console.error('Failed to mark task complete:', err);
      setCompleteError(err instanceof Error ? err.message : 'Failed to complete task');
      setCompleting(false);
    }
  }, [projectId, taskEmbed?.id, session.workspaceId, completing, onSessionMutated]);

  return (
    <div className="border-b border-border-default shrink-0">
      {/* Compact row — always visible */}
      <div className="flex items-center gap-2 px-4 py-2 min-h-[44px]">
        <span className="text-sm font-semibold text-fg-primary truncate flex-1 min-w-0">
          {session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`}
        </span>

        {/* Workspace profile badge — null/undefined defaults to 'Full' (matches DEFAULT_WORKSPACE_PROFILE) */}
        {workspace && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
            aria-label={`Workspace profile: ${workspace.workspaceProfile === 'lightweight' ? 'Lightweight' : 'Full'}`}
            style={{
              backgroundColor: workspace.workspaceProfile === 'lightweight' ? 'var(--sam-color-info-tint)' : 'var(--sam-color-success-tint)',
              color: workspace.workspaceProfile === 'lightweight' ? 'var(--sam-color-info)' : 'var(--sam-color-success)',
            }}
          >
            {workspace.workspaceProfile === 'lightweight' ? 'Lightweight' : 'Full'}
          </span>
        )}

        {/* Active port badges — shown inline in compact row */}
        {detectedPorts.length > 0 && (
          <span className="inline-flex items-center gap-1 shrink-0">
            {detectedPorts
              .slice()
              .sort((a, b) => a.port - b.port)
              .slice(0, 3) // Show up to 3 port badges inline
              .map((p) => (
                <a
                  key={p.port}
                  href={sanitizeUrl(p.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded no-underline shrink-0"
                  style={{
                    backgroundColor: 'var(--sam-color-accent-tint, rgba(59, 130, 246, 0.1))',
                    color: 'var(--sam-color-accent-primary)',
                  }}
                  title={`${p.label} — ${p.url}`}
                >
                  <Globe size={10} />
                  {p.port}
                </a>
              ))}
            {detectedPorts.length > 3 && (
              <span className="text-[10px] text-fg-muted">+{detectedPorts.length - 3}</span>
            )}
          </span>
        )}

        {/* Retry & Fork — always visible when session has a task */}
        {(session.task?.id ?? session.taskId) && (
          <span className="inline-flex items-center gap-0.5 shrink-0">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                aria-label="Retry task"
                title="Retry — re-run this task"
                className="shrink-0 p-1.5 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary hover:bg-surface-hover transition-colors"
              >
                <RotateCcw size={14} />
              </button>
            )}
            {onFork && (
              <button
                type="button"
                onClick={onFork}
                aria-label="Fork session"
                title="Fork — start a new task from this session"
                className="shrink-0 p-1.5 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary hover:bg-surface-hover transition-colors"
              >
                <GitFork size={14} />
              </button>
            )}
          </span>
        )}

        {/* State indicator */}
        <span
          className="inline-flex items-center gap-1 text-xs font-medium shrink-0"
          style={{
            color: sessionState === 'active' ? 'var(--sam-color-success)'
              : sessionState === 'idle' ? 'var(--sam-color-warning, #f59e0b)'
              : 'var(--sam-color-fg-muted)',
          }}
        >
          <span className="w-[6px] h-[6px] rounded-full bg-current" />
          {sessionState === 'active' ? 'Active' : sessionState === 'idle' ? 'Idle' : 'Stopped'}
        </span>

        {/* Background refresh indicator */}
        {loading && (
          <span role="status" aria-label="Refreshing messages" className="inline-flex items-center shrink-0">
            <Spinner size="sm" />
          </span>
        )}

        {/* Expand/collapse toggle — only shown when there are details to show */}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide session details' : 'Show session details'}
            className="shrink-0 p-2 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

      {/* Expanded details panel */}
      {expanded && hasDetails && (
        <div className="px-4 py-2 border-t border-border-default bg-inset space-y-2">
          {/* PR link & idle countdown — separate row above buttons */}
          {(taskEmbed?.outputPrUrl || (sessionState === 'idle' && idleCountdownMs !== null)) && (
            <div className="flex items-center gap-3">
              {/* Idle countdown (TDF-8) */}
              {sessionState === 'idle' && idleCountdownMs !== null && (
                <span
                  className="sam-type-caption font-mono"
                  style={{
                    color: idleCountdownMs < 5 * 60 * 1000
                      ? 'var(--sam-color-danger)'
                      : 'var(--sam-color-warning, #f59e0b)',
                  }}
                >
                  Cleanup in {formatCountdown(idleCountdownMs)}
                </span>
              )}

              {/* PR link (T021) */}
              {taskEmbed?.outputPrUrl && (
                <a
                  href={taskEmbed.outputPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sam-type-caption font-medium no-underline"
                  style={{ color: 'var(--sam-color-accent-primary)' }}
                >
                  View PR
                </a>
              )}
            </div>
          )}

          {/* Trigger info — shown when task was spawned by an automation trigger */}
          {triggerDetail?.trigger && (
            <div
              className="flex items-start gap-2 px-2 py-1.5 rounded text-xs"
              style={{ background: 'color-mix(in srgb, var(--sam-color-info, #3b82f6) 8%, transparent)' }}
            >
              <Clock size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--sam-color-info, #3b82f6)' }} />
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="font-medium text-fg-primary">
                  Triggered by: {triggerDetail.trigger.name}
                </div>
                {triggerDetail.trigger.cronHumanReadable && (
                  <div className="text-fg-muted">
                    Schedule: {triggerDetail.trigger.cronHumanReadable}
                  </div>
                )}
                {triggerDetail.triggerExecution && (
                  <div className="text-fg-muted">
                    Run #{triggerDetail.triggerExecution.sequenceNumber}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <Link
                    to={`/projects/${projectId}/triggers/${triggerDetail.trigger.id}`}
                    className="text-accent-primary no-underline hover:underline"
                  >
                    View Trigger
                  </Link>
                  <Link
                    to={`/projects/${projectId}/triggers/${triggerDetail.trigger.id}`}
                    className="text-fg-muted no-underline hover:underline"
                  >
                    All Runs
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons — wraps on narrow viewports */}
          <div className="flex flex-wrap items-center gap-1.5">
            {session.workspaceId && sessionState === 'active' && (
              <>
                {onOpenFiles && (
                  <Button variant="ghost" size="sm" onClick={onOpenFiles}>
                    <FolderOpen size={14} className="mr-1" />
                    Files
                  </Button>
                )}
                {onOpenGit && (
                  <Button variant="ghost" size="sm" onClick={onOpenGit}>
                    <GitCompare size={14} className="mr-1" />
                    Git
                  </Button>
                )}
                {browserEnabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={browser.status?.status === 'running' ? 'Open remote browser' : 'Start remote browser'}
                    onClick={browser.status?.status === 'running' ? handleOpenBrowser : handleStartAndOpen}
                    disabled={browser.isLoading}
                  >
                    {browser.isLoading ? (
                      <Loader2 size={14} className="mr-1 animate-spin" />
                    ) : (
                      <Monitor size={14} className="mr-1" />
                    )}
                    Browser
                  </Button>
                )}
                <a
                  href={`/workspaces/${session.workspaceId}`}
                  aria-label="Open workspace"
                  className="no-underline"
                >
                  <Button variant="ghost" size="sm">
                    <ExternalLink size={14} className="mr-1" />
                    Workspace
                  </Button>
                </a>
              </>
            )}

            {canMarkComplete && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={completing}
                style={{ color: completing ? undefined : 'var(--sam-color-success)' }}
              >
                <CheckCircle2 size={14} className="mr-1" />
                {completing ? 'Completing...' : 'Complete'}
              </Button>
            )}
          </div>

          {/* Inline error for browser sidecar failures */}
          {browser.error && (
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="text-xs" style={{ color: 'var(--sam-color-danger)' }}>Browser: {browser.error}</span>
            </div>
          )}

          {/* Inline error for mark-complete failures */}
          {completeError && (
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="text-xs" style={{ color: 'var(--sam-color-danger)' }}>{completeError}</span>
              <button
                type="button"
                onClick={() => setCompleteError(null)}
                className="text-xs bg-transparent border-none cursor-pointer underline"
                style={{ color: 'var(--sam-color-fg-muted)' }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Infrastructure context — workspace & node details */}
          {session.workspaceId && (workspace || node) && (
            <div className="flex flex-col gap-1.5 pt-1 border-t border-border-default">
              {workspace && (
                <>
                  <ContextItem icon={<Box size={12} />} label="Workspace">
                    <a
                      href={`/workspaces/${workspace.id}`}
                      className="no-underline hover:underline"
                      style={{ color: 'var(--sam-color-accent-primary)' }}
                    >
                      {workspace.displayName || workspace.name}
                    </a>
                    <span className="text-fg-muted ml-1">({workspace.status})</span>
                  </ContextItem>
                  <ContextItem icon={<Cpu size={12} />} label="VM Size">
                    {formatVmSize(workspace.vmSize)}
                  </ContextItem>
                </>
              )}
              {node && (
                <>
                  <ContextItem icon={<Server size={12} />} label="Node">
                    <a
                      href={`/nodes/${node.id}`}
                      className="no-underline hover:underline"
                      style={{ color: 'var(--sam-color-accent-primary)' }}
                    >
                      {node.name}
                    </a>
                    {node.healthStatus && (
                      <span
                        className="ml-1"
                        style={{
                          color: node.healthStatus === 'healthy' ? 'var(--sam-color-success)'
                            : node.healthStatus === 'stale' ? 'var(--sam-color-warning, #f59e0b)'
                            : 'var(--sam-color-danger)',
                        }}
                      >
                        ({node.healthStatus})
                      </span>
                    )}
                  </ContextItem>
                  {node.cloudProvider && (
                    <ContextItem icon={<Cloud size={12} />} label="Provider">
                      {node.cloudProvider.charAt(0).toUpperCase() + node.cloudProvider.slice(1)}
                      {workspace?.vmLocation && (
                        <span className="text-fg-muted ml-1">— {workspace.vmLocation}</span>
                      )}
                    </ContextItem>
                  )}
                </>
              )}
              {!node && workspace?.vmLocation && (
                <ContextItem icon={<MapPin size={12} />} label="Location">
                  {workspace.vmLocation}
                </ContextItem>
              )}
              {taskEmbed?.outputBranch && (
                <ContextItem icon={<GitBranch size={12} />} label="Branch">
                  <span className="font-mono text-[11px]">
                    {taskEmbed.outputBranch}
                  </span>
                </ContextItem>
              )}
              {detectedPorts.length > 0 && (
                <ContextItem icon={<Globe size={12} />} label="Ports">
                  <span className="inline-flex flex-wrap gap-1.5">
                    {detectedPorts
                      .slice()
                      .sort((a, b) => a.port - b.port)
                      .map((p) => (
                        <a
                          key={p.port}
                          href={sanitizeUrl(p.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[11px] no-underline hover:underline"
                          style={{ color: 'var(--sam-color-accent-primary)' }}
                          title={p.label}
                        >
                          {p.port}
                          {p.address === '127.0.0.1' || p.address === '::1' ? ' (local)' : ''}
                          <ExternalLink size={10} />
                        </a>
                      ))}
                  </span>
                </ContextItem>
              )}
            </div>
          )}
          {/* Active ports section — shown when ports are detected and no infrastructure section is shown */}
          {detectedPorts.length > 0 && !(session.workspaceId && (workspace || node)) && (
            <div className="flex flex-col gap-1.5 pt-1 border-t border-border-default">
              <ContextItem icon={<Globe size={12} />} label="Ports">
                <span className="inline-flex flex-wrap gap-1.5">
                  {detectedPorts
                    .slice()
                    .sort((a, b) => a.port - b.port)
                    .map((p) => (
                      <a
                        key={p.port}
                        href={sanitizeUrl(p.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[11px] no-underline hover:underline"
                        style={{ color: 'var(--sam-color-accent-primary)' }}
                        title={p.label}
                      >
                        {p.port}
                        {p.address === '127.0.0.1' || p.address === '::1' ? ' (local)' : ''}
                        <ExternalLink size={10} />
                      </a>
                    ))}
                </span>
              </ContextItem>
            </div>
          )}
          {/* Fallback when workspace data is still loading or failed */}
          {session.workspaceId && !workspace && !node && (
            <div className="pt-1 border-t border-border-default">
              <span className="text-xs text-fg-muted">Loading infrastructure details...</span>
            </div>
          )}
        </div>
      )}

      {/* Confirmation dialog for mark-complete action */}
      <Dialog isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm">
        <h3 id="dialog-title" className="text-base font-semibold text-fg-primary mb-2">
          Mark task as complete?
        </h3>
        <p className="text-sm text-fg-muted mb-4">
          This will archive the task and delete the workspace. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleMarkComplete}>
            Complete & Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
