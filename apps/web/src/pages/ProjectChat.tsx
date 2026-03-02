import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { List, Settings, LayoutGrid } from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { ProjectMessageView } from '../components/chat/ProjectMessageView';
import { useIsMobile } from '../hooks/useIsMobile';
import type { TaskStatus, TaskExecutionStep } from '@simple-agent-manager/shared';
import {
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  TASK_EXECUTION_STEPS,
} from '@simple-agent-manager/shared';
import {
  listChatSessions,
  listCredentials,
  submitTask,
  getProjectTask,
} from '../lib/api';
import type { ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to re-poll sessions when a task is actively executing (ms). */
const ACTIVE_SESSION_POLL_MS = 3000;
/** How often to poll task status during provisioning (ms). */
const TASK_STATUS_POLL_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvisioningState {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  errorMessage: string | null;
  startedAt: number;
}

type SessionState = 'active' | 'idle' | 'terminated';

// ---------------------------------------------------------------------------
// Session helpers (moved from SessionSidebar.tsx)
// ---------------------------------------------------------------------------

function getSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  const s = session as ChatSessionResponse & { agentCompletedAt?: number | null; isIdle?: boolean };
  if (s.isIdle || s.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

const STATE_COLORS: Record<SessionState, string> = {
  active: 'var(--sam-color-success)',
  idle: 'var(--sam-color-warning, #f59e0b)',
  terminated: 'var(--sam-color-fg-muted)',
};

const STATE_LABELS: Record<SessionState, string> = {
  active: 'Active',
  idle: 'Idle',
  terminated: 'Stopped',
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId, project, settingsOpen, setSettingsOpen, infoPanelOpen, setInfoPanelOpen } = useProjectContext();
  const isMobile = useIsMobile();

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // New chat input state
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Provisioning tracking
  const [provisioning, setProvisioning] = useState<ProvisioningState | null>(null);
  const sessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track "New Chat" intent so auto-select doesn't override it
  const newChatIntentRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Effects (all preserved from original)
  // ---------------------------------------------------------------------------

  // Check for Hetzner credentials
  useEffect(() => {
    void listCredentials()
      .then((creds) => setHasCloudCredentials(creds.some((c) => c.provider === 'hetzner')))
      .catch(() => setHasCloudCredentials(false));
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const result = await listChatSessions(projectId, { limit: 100 });
      setSessions(result.sessions);
      return result.sessions;
    } catch {
      return [];
    }
  }, [projectId]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    void loadSessions().finally(() => setLoading(false));
  }, [loadSessions]);

  // Poll task status during provisioning
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) return;

    const poll = async () => {
      try {
        const task = await getProjectTask(projectId, provisioning.taskId);
        setProvisioning((prev) => prev ? { ...prev, status: task.status, executionStep: task.executionStep ?? null, errorMessage: task.errorMessage ?? null } : null);

        if (task.status === 'in_progress' && (task.workspaceId || task.executionStep === 'running')) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
        }

        if (isTerminal(task.status)) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
          void loadSessions();
        }
      } catch {
        // Continue polling on transient errors
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), TASK_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [provisioning?.taskId, provisioning?.status, projectId, navigate, loadSessions, provisioning?.sessionId]);

  // Aggressive session polling during provisioning
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) {
      if (sessionPollRef.current) {
        clearInterval(sessionPollRef.current);
        sessionPollRef.current = null;
      }
      return;
    }

    sessionPollRef.current = setInterval(() => void loadSessions(), ACTIVE_SESSION_POLL_MS);
    return () => {
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    };
  }, [provisioning?.taskId, provisioning?.status, loadSessions]);

  // Restore provisioning state when navigating to a session with an active task
  useEffect(() => {
    if (!sessionId || provisioning) return;

    const selectedSession = sessions.find((s) => s.id === sessionId);
    if (!selectedSession?.taskId) return;

    let cancelled = false;
    void (async () => {
      try {
        const task = await getProjectTask(projectId, selectedSession.taskId!);
        if (cancelled) return;
        if (!isTerminal(task.status) && task.status !== 'in_progress') {
          setProvisioning({
            taskId: task.id,
            sessionId,
            branchName: task.outputBranch ?? '',
            status: task.status,
            executionStep: task.executionStep ?? null,
            errorMessage: task.errorMessage ?? null,
            startedAt: task.startedAt ? new Date(task.startedAt).getTime() : Date.now(),
          });
        }
      } catch {
        // Best-effort
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, sessions, projectId, provisioning]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    };
  }, []);

  // Auto-select the most recent session on initial load
  useEffect(() => {
    if (!sessionId && sessions.length > 0 && !loading && !provisioning) {
      if (newChatIntentRef.current) return;
      const mostRecent = sessions[0];
      if (mostRecent) {
        navigate(`/projects/${projectId}/chat/${mostRecent.id}`, { replace: true });
      }
    }
  }, [sessionId, sessions, loading, projectId, navigate, provisioning]);

  // ---------------------------------------------------------------------------
  // Handlers (all preserved from original)
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;

    if (!hasCloudCredentials) {
      setSubmitError('Cloud credentials required. Go to Settings to connect your Hetzner account.');
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await submitTask(projectId, { message: trimmed });
      setMessage('');
      setProvisioning({
        taskId: result.taskId,
        sessionId: result.sessionId,
        branchName: result.branchName,
        status: 'queued',
        executionStep: null,
        errorMessage: null,
        startedAt: Date.now(),
      });
      newChatIntentRef.current = false;
      navigate(`/projects/${projectId}/chat/${result.sessionId}`, { replace: true });
      void loadSessions();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true;
    navigate(`/projects/${projectId}/chat`, { replace: true });
    setMessage('');
    setSubmitError(null);
    setProvisioning(null);
  }, [navigate, projectId]);

  const handleSelect = (id: string) => {
    newChatIntentRef.current = false;
    setProvisioning(null);
    setSidebarOpen(false);
    navigate(`/projects/${projectId}/chat/${id}`);
  };

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const showNewChatInput = !sessionId || sessions.length === 0;
  const hasSessions = sessions.length > 0;

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (loading && sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-1 min-h-0">
      {/* ================================================================== */}
      {/* Desktop sidebar                                                    */}
      {/* ================================================================== */}
      {!isMobile && (
        <div className="w-72 shrink-0 border-r border-border-default flex flex-col bg-surface">
          {/* Sidebar header: project name + action buttons */}
          <div className="shrink-0 px-3 py-2.5 border-b border-border-default flex items-center gap-2">
            <span className="text-sm font-semibold text-fg-primary truncate flex-1">
              {project?.name || 'Project'}
            </span>
            <button
              type="button"
              onClick={() => setInfoPanelOpen(!infoPanelOpen)}
              title="Project status"
              aria-label="Project status"
              className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
            >
              <LayoutGrid size={15} />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(!settingsOpen)}
              title="Project settings"
              aria-label="Project settings"
              className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
            >
              <Settings size={15} />
            </button>
          </div>

          {/* New chat button */}
          <div className="shrink-0 p-2 border-b border-border-default">
            <button
              type="button"
              onClick={handleNewChat}
              className="w-full py-1.5 px-3 rounded-md border border-border-default bg-transparent cursor-pointer text-fg-primary text-xs font-medium hover:bg-surface-hover transition-colors"
            >
              + New Chat
            </button>
          </div>

          {/* Session list — scrollable */}
          {hasSessions ? (
            <nav className="flex-1 overflow-y-auto min-h-0">
              {sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={session.id === sessionId}
                  onSelect={handleSelect}
                />
              ))}
            </nav>
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <span className="text-xs text-fg-muted text-center">No chats yet. Start a new one above.</span>
            </div>
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* Main content area                                                  */}
      {/* ================================================================== */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile header bar */}
        {isMobile && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-default bg-surface">
            {hasSessions && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open chat list"
                className="p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
              >
                <List size={18} />
              </button>
            )}
            <span className="text-sm font-semibold text-fg-primary truncate flex-1">
              {project?.name || 'Project'}
            </span>
            <button
              type="button"
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-label="Project settings"
              className="shrink-0 p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
            >
              <Settings size={16} />
            </button>
          </div>
        )}

        {showNewChatInput ? (
          /* New chat / empty state */
          <div className="flex-1 flex flex-col min-h-0">
            <div className={`flex-1 flex flex-col items-center justify-center gap-3 ${isMobile ? 'p-4' : 'p-8'}`}>
              {provisioning ? (
                <ProvisioningIndicator state={provisioning} />
              ) : (
                <>
                  <span className="text-base font-semibold text-fg-primary">
                    What do you want to build?
                  </span>
                  <span className="sam-type-secondary text-fg-muted text-center max-w-[400px]">
                    Describe the task and an agent will start working on it automatically.
                  </span>
                </>
              )}
            </div>
            <ChatInput
              value={message}
              onChange={setMessage}
              onSubmit={handleSubmit}
              submitting={submitting}
              error={submitError}
              placeholder="Describe what you want the agent to do..."
            />
          </div>
        ) : (
          /* Active session view */
          <div className="flex-1 flex flex-col min-h-0">
            {provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status) && (
              <ProvisioningIndicator state={provisioning} />
            )}
            <ProjectMessageView projectId={projectId} sessionId={sessionId!} />
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* Mobile session drawer                                              */}
      {/* ================================================================== */}
      {isMobile && sidebarOpen && hasSessions && (
        <MobileSessionDrawer
          sessions={sessions}
          selectedSessionId={sessionId ?? null}
          onSelect={handleSelect}
          onNewChat={() => { setSidebarOpen(false); handleNewChat(); }}
          onClose={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session item (inline — replaces SessionSidebar.tsx)
// ---------------------------------------------------------------------------

function SessionItem({
  session,
  isSelected,
  onSelect,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const state = getSessionState(session);
  const dotColor = STATE_COLORS[state];

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={`block w-full text-left px-3 py-2.5 border-none border-b border-border-default cursor-pointer transition-colors duration-100 ${isSelected ? 'bg-inset' : 'hover:bg-surface-hover'}`}
      style={{
        borderLeft: isSelected
          ? '3px solid var(--sam-color-accent-primary)'
          : '3px solid transparent',
      }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: dotColor }}
        />
        <span className={`text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 ${isSelected ? 'font-semibold text-fg-primary' : 'font-medium text-fg-primary'}`}>
          {session.topic || `Chat ${session.id.slice(0, 8)}`}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-muted pl-[calc(6px+8px)]">
        <span style={{ color: dotColor }} className="font-medium">
          {STATE_LABELS[state]}
        </span>
        <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
        <span className="ml-auto">{formatRelativeTime(session.startedAt)}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mobile session drawer
// ---------------------------------------------------------------------------

function MobileSessionDrawer({
  sessions,
  selectedSessionId,
  onSelect,
  onNewChat,
  onClose,
}: {
  sessions: ChatSessionResponse[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
        style={{ animation: 'sam-session-drawer-fade-in 0.15s ease-out' }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat sessions"
        className="fixed top-0 left-0 bottom-0 bg-surface border-r border-border-default z-drawer flex flex-col"
        style={{
          width: '85vw',
          maxWidth: 320,
          animation: 'sam-session-drawer-slide-in 0.2s ease-out',
        }}
      >
        {/* Drawer header */}
        <div className="shrink-0 p-3 border-b border-border-default flex items-center justify-between">
          <span className="text-sm font-semibold text-fg-primary">Chats</span>
          <button
            type="button"
            onClick={onNewChat}
            className="bg-transparent border border-border-default rounded-sm px-2 py-0.5 cursor-pointer text-fg-primary text-xs font-medium"
          >
            + New
          </button>
        </div>

        {/* Session list */}
        <nav className="flex-1 overflow-y-auto min-h-0">
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              onSelect={onSelect}
            />
          ))}
        </nav>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Provisioning indicator (preserved)
// ---------------------------------------------------------------------------

const PROVISIONING_STEPS: TaskExecutionStep[] = TASK_EXECUTION_STEPS.filter(
  (s) => s !== 'running' && s !== 'awaiting_followup'
);

function ProvisioningIndicator({ state }: { state: ProvisioningState }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const seconds = Math.floor(elapsed / 1000);
  const elapsedDisplay = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  const statusLabel = state.status === 'failed' ? 'Setup failed'
    : state.status === 'cancelled' ? 'Cancelled'
    : state.executionStep ? EXECUTION_STEP_LABELS[state.executionStep]
    : 'Starting...';

  const currentStepOrder = state.executionStep ? EXECUTION_STEP_ORDER[state.executionStep] : -1;
  const isFailed = state.status === 'failed';

  return (
    <div className={`shrink-0 px-4 py-3 border-b border-border-default ${isFailed ? 'bg-danger-tint' : 'bg-info-tint'}`}>
      <div className="flex items-center gap-2 mb-2">
        {!isTerminal(state.status) && <Spinner size="sm" />}
        <span className={`sam-type-secondary font-medium ${isFailed ? 'text-danger' : 'text-fg-primary'}`}>
          {statusLabel}
        </span>
        {state.branchName && !isTerminal(state.status) && (
          <span className="sam-type-caption text-fg-muted">{state.branchName}</span>
        )}
        <span className="sam-type-caption text-fg-muted ml-auto">{elapsedDisplay}</span>
      </div>

      {!isTerminal(state.status) && (
        <div className="flex gap-[2px] h-[3px] rounded-sm overflow-hidden">
          {PROVISIONING_STEPS.map((step) => {
            const stepOrder = EXECUTION_STEP_ORDER[step];
            const isComplete = stepOrder < currentStepOrder;
            const isCurrent = stepOrder === currentStepOrder;
            return (
              <div
                key={step}
                title={EXECUTION_STEP_LABELS[step]}
                className="flex-1 transition-colors duration-300"
                style={{
                  backgroundColor: isComplete
                    ? 'var(--sam-color-success)'
                    : isCurrent
                    ? 'var(--sam-color-accent-primary)'
                    : 'var(--sam-color-border-default)',
                }}
              />
            );
          })}
        </div>
      )}

      {state.errorMessage && (
        <div className="sam-type-caption text-danger mt-2 p-2 px-3 bg-surface rounded-sm border border-danger-tint break-words">
          {state.errorMessage}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat input (preserved)
// ---------------------------------------------------------------------------

function ChatInput({
  value,
  onChange,
  onSubmit,
  submitting,
  error,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  placeholder: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface">
      {error && (
        <div className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}
      <div className="flex gap-2 items-end">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !submitting) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={submitting}
          rows={1}
          className="flex-1 p-2 px-3 bg-page border border-border-default rounded-md text-fg-primary text-base outline-none resize-none font-[inherit] leading-[1.5] min-h-[38px] max-h-[120px]"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !value.trim()}
          className="px-3 py-2 border-none rounded-md text-base font-medium whitespace-nowrap"
          style={{
            backgroundColor: submitting || !value.trim() ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: submitting || !value.trim() ? 'var(--sam-color-fg-muted)' : 'white',
            cursor: submitting || !value.trim() ? 'default' : 'pointer',
          }}
        >
          {submitting ? 'Sending...' : 'Send'}
        </button>
      </div>
      <div className="sam-type-caption text-fg-muted mt-1">
        Press Enter to send, Shift+Enter for new line
      </div>
    </div>
  );
}
