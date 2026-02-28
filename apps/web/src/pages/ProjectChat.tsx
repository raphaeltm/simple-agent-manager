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

        // When task reaches in_progress and has a workspace, navigate to its session
        if (task.status === 'in_progress' && task.workspaceId) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
        }

        if (isTerminal(task.status)) {
          // Reload sessions on terminal to pick up final state
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
    navigate(`/projects/${projectId}/chat`, { replace: true });
    setMessage('');
    setSubmitError(null);
    setProvisioning(null);
  }, [navigate, projectId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    };
  }, []);

  // Auto-select the most recent session if none is selected and not provisioning
  useEffect(() => {
    if (!sessionId && sessions.length > 0 && !loading && !provisioning) {
      const mostRecent = sessions[0];
      if (mostRecent) {
        navigate(`/projects/${projectId}/chat/${mostRecent.id}`, { replace: true });
      }
    }
  }, [sessionId, sessions, loading, projectId, navigate, provisioning]);

  const handleSelect = (id: string) => {
    setProvisioning(null);
    setSidebarOpen(false);
    navigate(`/projects/${projectId}/chat/${id}`);
  };

  if (loading && sessions.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  // Determine if we're showing the "new chat" input (no session selected, or empty state)
  const showNewChatInput = !sessionId || sessions.length === 0;
  const hasSessions = sessions.length > 0;
  const showInlineSidebar = hasSessions && !isMobile;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: showInlineSidebar ? '280px 1fr' : '1fr',
      border: isMobile ? 'none' : '1px solid var(--sam-color-border-default)',
      borderRadius: isMobile ? 0 : 'var(--sam-radius-md)',
      backgroundColor: 'var(--sam-color-bg-surface)',
      overflow: 'hidden',
      ...(isMobile
        ? { flex: 1, minHeight: 0 }
        : { minHeight: '500px', maxHeight: 'calc(100vh - 240px)' }
      ),
    }}>
      {/* Desktop sidebar — inline when sessions exist */}
      {showInlineSidebar && (
        <div style={{
          borderRight: '1px solid var(--sam-color-border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
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
      <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Mobile session toggle bar */}
        {isMobile && hasSessions && !showNewChatInput && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sam-space-2)',
              padding: 'var(--sam-space-2) var(--sam-space-3)',
              backgroundColor: 'var(--sam-color-bg-surface)',
              border: 'none',
              borderBottom: '1px solid var(--sam-color-border-default)',
              cursor: 'pointer',
              color: 'var(--sam-color-fg-muted)',
              fontSize: 'var(--sam-type-caption-size)',
              fontWeight: 500,
              width: '100%',
              textAlign: 'left',
              minHeight: '44px',
            }}
          >
            <List size={16} />
            <span>{sessions.length} chat{sessions.length !== 1 ? 's' : ''}</span>
          </button>
        )}

        {showNewChatInput ? (
          /* New chat / empty state */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: isMobile ? 'var(--sam-space-4)' : 'var(--sam-space-8)',
              gap: 'var(--sam-space-3)',
            }}>
              {provisioning ? (
                <ProvisioningIndicator state={provisioning} />
              ) : (
                <>
                  <span style={{
                    fontSize: 'var(--sam-type-body-size)',
                    fontWeight: 600,
                    color: 'var(--sam-color-fg-primary)',
                  }}>
                    What do you want to build?
                  </span>
                  <span className="sam-type-secondary" style={{
                    color: 'var(--sam-color-fg-muted)',
                    textAlign: 'center',
                    maxWidth: '400px',
                  }}>
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
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Inline provisioning indicator if this is the provisioning session */}
            {provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status) && (
              <ProvisioningIndicator state={provisioning} />
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
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
      <style>{`
        @keyframes sam-session-drawer-slide-in {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @keyframes sam-session-drawer-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>

      {/* Backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--sam-color-bg-overlay)',
          zIndex: 'var(--sam-z-drawer-backdrop)' as unknown as number,
          animation: 'sam-session-drawer-fade-in 0.15s ease-out',
        }}
      />

      {/* Panel — slides from left */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat sessions"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: '85vw',
          maxWidth: 320,
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderRight: '1px solid var(--sam-color-border-default)',
          zIndex: 'var(--sam-z-drawer)' as unknown as number,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
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
    <div style={{
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      backgroundColor: isFailed ? 'var(--sam-color-danger-tint)' : 'var(--sam-color-info-tint)',
      borderBottom: '1px solid var(--sam-color-border-default)',
    }}>
      {/* Status header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sam-space-2)',
        marginBottom: 'var(--sam-space-2)',
      }}>
        {!isTerminal(state.status) && <Spinner size="sm" />}
        <span className="sam-type-secondary" style={{
          color: isFailed ? 'var(--sam-color-danger)' : 'var(--sam-color-fg-primary)',
          fontWeight: 500,
        }}>
          {statusLabel}
        </span>
        {state.branchName && !isTerminal(state.status) && (
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
            {state.branchName}
          </span>
        )}
        <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', marginLeft: 'auto' }}>
          {elapsedDisplay}
        </span>
      </div>

      {/* Step progress bar (only during active provisioning) */}
      {!isTerminal(state.status) && (
        <div style={{
          display: 'flex',
          gap: '2px',
          height: '3px',
          borderRadius: '2px',
          overflow: 'hidden',
        }}>
          {PROVISIONING_STEPS.map((step) => {
            const stepOrder = EXECUTION_STEP_ORDER[step];
            const isComplete = stepOrder < currentStepOrder;
            const isCurrent = stepOrder === currentStepOrder;

            return (
              <div
                key={step}
                title={EXECUTION_STEP_LABELS[step]}
                style={{
                  flex: 1,
                  backgroundColor: isComplete
                    ? 'var(--sam-color-success)'
                    : isCurrent
                    ? 'var(--sam-color-accent-primary)'
                    : 'var(--sam-color-border-default)',
                  transition: 'background-color 0.3s ease',
                }}
              />
            );
          })}
        </div>
      )}

      {/* Error message */}
      {state.errorMessage && (
        <div className="sam-type-caption" style={{
          color: 'var(--sam-color-danger)',
          marginTop: 'var(--sam-space-2)',
          padding: 'var(--sam-space-2) var(--sam-space-3)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderRadius: 'var(--sam-radius-sm)',
          border: '1px solid var(--sam-color-danger-tint)',
          wordBreak: 'break-word',
        }}>
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
    <div style={{
      borderTop: '1px solid var(--sam-color-border-default)',
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      backgroundColor: 'var(--sam-color-bg-surface)',
    }}>
      {error && (
        <div style={{
          padding: 'var(--sam-space-2) var(--sam-space-3)',
          marginBottom: 'var(--sam-space-2)',
          borderRadius: 'var(--sam-radius-sm)',
          backgroundColor: 'var(--sam-color-danger-tint)',
          color: 'var(--sam-color-danger)',
          fontSize: 'var(--sam-type-caption-size)',
        }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'flex-end' }}>
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
          style={{
            flex: 1,
            padding: 'var(--sam-space-2) var(--sam-space-3)',
            backgroundColor: 'var(--sam-color-bg-page)',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            color: 'var(--sam-color-fg-primary)',
            fontSize: 'var(--sam-type-body-size)',
            outline: 'none',
            resize: 'none',
            fontFamily: 'inherit',
            lineHeight: 1.5,
            minHeight: '38px',
            maxHeight: '120px',
          }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !value.trim()}
          style={{
            padding: 'var(--sam-space-2) var(--sam-space-3)',
            backgroundColor: submitting || !value.trim() ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: submitting || !value.trim() ? 'var(--sam-color-fg-muted)' : 'white',
            border: 'none',
            borderRadius: 'var(--sam-radius-md)',
            cursor: submitting || !value.trim() ? 'default' : 'pointer',
            fontSize: 'var(--sam-type-body-size)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          {submitting ? 'Sending...' : 'Send'}
        </button>
      </div>
      <div className="sam-type-caption" style={{
        color: 'var(--sam-color-fg-muted)',
        marginTop: 'var(--sam-space-1)',
      }}>
        Press Enter to send, Shift+Enter for new line
      </div>
    </div>
  );
}
