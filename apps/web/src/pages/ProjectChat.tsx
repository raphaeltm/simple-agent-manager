import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { List } from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { SessionSidebar } from '../components/chat/SessionSidebar';
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

/** How often to re-poll sessions when a task is actively executing (ms). */
const ACTIVE_SESSION_POLL_MS = 3000;
/** How often to poll task status during provisioning (ms). */
const TASK_STATUS_POLL_MS = 2000;

interface ProvisioningState {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  errorMessage: string | null;
  startedAt: number;
}

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Simple text input state
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Inline provisioning tracking (replaces TaskExecutionProgress banner)
  const [provisioning, setProvisioning] = useState<ProvisioningState | null>(null);
  const sessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track when user explicitly clicked "New Chat" so auto-select does not override it
  const newChatIntentRef = useRef(false);
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

        // Dismiss provisioning when task is running or has a workspace
        if (task.status === 'in_progress' && (task.workspaceId || task.executionStep === 'running')) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
        }

        if (isTerminal(task.status)) {
          // Clear provisioning so the session view renders and shows the task error
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
      // Navigate to the new session immediately
      newChatIntentRef.current = false;
      navigate(`/projects/${projectId}/chat/${result.sessionId}`, { replace: true });
      // Reload sessions to include the new one
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

  // Restore provisioning state when navigating to a session with an active task.
  // This covers the case where the user navigates away during provisioning and
  // comes back — the ephemeral ProvisioningState was lost, so we reconstruct it
  // from the task's current status in D1.
  useEffect(() => {
    if (!sessionId || provisioning) return;

    const selectedSession = sessions.find((s) => s.id === sessionId);
    if (!selectedSession?.taskId) return;

    let cancelled = false;
    void (async () => {
      try {
        const task = await getProjectTask(projectId, selectedSession.taskId!);
        if (cancelled) return;
        // Only restore if the task is still in a provisioning phase
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
        // Best-effort — if the task lookup fails, we just don't show provisioning
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

  // Auto-select the most recent session on initial load (skip if user clicked "New Chat")
  useEffect(() => {
    if (!sessionId && sessions.length > 0 && !loading && !provisioning) {
      if (newChatIntentRef.current) return;
      const mostRecent = sessions[0];
      if (mostRecent) {
        navigate(`/projects/${projectId}/chat/${mostRecent.id}`, { replace: true });
      }
    }
  }, [sessionId, sessions, loading, projectId, navigate, provisioning]);

  const handleSelect = (id: string) => {
    newChatIntentRef.current = false;
    setProvisioning(null);
    setSidebarOpen(false);
    navigate(`/projects/${projectId}/chat/${id}`);
  };

  if (loading && sessions.length === 0) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  // Determine if we're showing the "new chat" input (no session selected, or empty state)
  const showNewChatInput = !sessionId || sessions.length === 0;
  const hasSessions = sessions.length > 0;
  const showInlineSidebar = hasSessions && !isMobile;

  return (
    <div
      className={`grid bg-surface overflow-hidden ${isMobile ? 'flex-1 min-h-0' : 'border border-border-default rounded-md min-h-[500px] max-h-[calc(100vh-240px)]'}`}
      style={{
        gridTemplateColumns: showInlineSidebar ? '280px 1fr' : '1fr',
      }}
    >
      {/* Desktop sidebar — inline when sessions exist */}
      {showInlineSidebar && (
        <div className="border-r border-border-default flex flex-col overflow-hidden">
          <SessionSidebar
            sessions={sessions}
            selectedSessionId={sessionId ?? null}
            loading={false}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
          />
        </div>
      )}

      {/* Mobile session drawer overlay */}
      {isMobile && sidebarOpen && hasSessions && (
        <MobileSessionDrawer
          sessions={sessions}
          selectedSessionId={sessionId ?? null}
          onSelect={handleSelect}
          onNewChat={() => { setSidebarOpen(false); handleNewChat(); }}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="overflow-hidden flex flex-col min-h-0">
        {/* Mobile session toggle bar */}
        {isMobile && hasSessions && !showNewChatInput && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="flex items-center gap-2 px-3 py-2 bg-surface border-none border-b border-border-default cursor-pointer text-fg-muted text-xs font-medium w-full text-left min-h-[44px]"
          >
            <List size={16} />
            <span>{sessions.length} chat{sessions.length !== 1 ? 's' : ''}</span>
          </button>
        )}

        {showNewChatInput ? (
          /* New chat / empty state */
          <div className="flex-1 flex flex-col">
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
          /* Existing session view */
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {/* Inline provisioning indicator if this is the provisioning session */}
            {provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status) && (
              <ProvisioningIndicator state={provisioning} />
            )}
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <ProjectMessageView projectId={projectId} sessionId={sessionId!} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Mobile drawer overlay for the session sidebar. */
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
  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Lock body scroll while drawer is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <>
      {/* Keyframes (sam-session-drawer-slide-in, sam-session-drawer-fade-in) defined in app.css */}

      {/* Backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
        style={{
          animation: 'sam-session-drawer-fade-in 0.15s ease-out',
        }}
      />

      {/* Panel — slides from left */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat sessions"
        className="fixed top-0 left-0 bottom-0 bg-surface border-r border-border-default z-drawer flex flex-col overflow-hidden"
        style={{
          width: '85vw',
          maxWidth: 320,
          animation: 'sam-session-drawer-slide-in 0.2s ease-out',
        }}
      >
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          loading={false}
          onSelect={onSelect}
          onNewChat={onNewChat}
        />
      </div>
    </>
  );
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Steps shown in the provisioning progress bar (setup steps only, not running/followup). */
const PROVISIONING_STEPS: TaskExecutionStep[] = TASK_EXECUTION_STEPS.filter(
  (s) => s !== 'running' && s !== 'awaiting_followup'
);

/** Inline provisioning progress with granular execution step display (TDF-8). */
function ProvisioningIndicator({ state }: { state: ProvisioningState }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const seconds = Math.floor(elapsed / 1000);
  const elapsedDisplay = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  // Use execution step label if available, otherwise fall back to status-based label
  const statusLabel = state.status === 'failed' ? 'Setup failed'
    : state.status === 'cancelled' ? 'Cancelled'
    : state.executionStep ? EXECUTION_STEP_LABELS[state.executionStep]
    : 'Starting...';

  const currentStepOrder = state.executionStep ? EXECUTION_STEP_ORDER[state.executionStep] : -1;
  const isFailed = state.status === 'failed';

  return (
    <div className={`px-4 py-3 border-b border-border-default ${isFailed ? 'bg-danger-tint' : 'bg-info-tint'}`}>
      {/* Status header */}
      <div className="flex items-center gap-2 mb-2">
        {!isTerminal(state.status) && <Spinner size="sm" />}
        <span className={`sam-type-secondary font-medium ${isFailed ? 'text-danger' : 'text-fg-primary'}`}>
          {statusLabel}
        </span>
        {state.branchName && !isTerminal(state.status) && (
          <span className="sam-type-caption text-fg-muted">
            {state.branchName}
          </span>
        )}
        <span className="sam-type-caption text-fg-muted ml-auto">
          {elapsedDisplay}
        </span>
      </div>

      {/* Step progress bar (only during active provisioning) */}
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

      {/* Error message */}
      {state.errorMessage && (
        <div className="sam-type-caption text-danger mt-2 p-2 px-3 bg-surface rounded-sm border border-danger-tint break-words">
          {state.errorMessage}
        </div>
      )}
    </div>
  );
}

/** Simple chat-style text input with enter-to-submit. */
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
    <div className="border-t border-border-default px-4 py-3 bg-surface">
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
