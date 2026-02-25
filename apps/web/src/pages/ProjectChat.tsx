import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Spinner } from '@simple-agent-manager/ui';
import { SessionSidebar } from '../components/chat/SessionSidebar';
import { ProjectMessageView } from '../components/chat/ProjectMessageView';
import type { TaskStatus } from '@simple-agent-manager/shared';
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
  errorMessage: string | null;
  startedAt: number;
}

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId } = useProjectContext();

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);

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
        setProvisioning((prev) => prev ? { ...prev, status: task.status, errorMessage: task.errorMessage ?? null } : null);

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

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: sessions.length > 0 ? '280px 1fr' : '1fr',
      border: '1px solid var(--sam-color-border-default)',
      borderRadius: 'var(--sam-radius-md)',
      backgroundColor: 'var(--sam-color-bg-surface)',
      overflow: 'hidden',
      minHeight: '500px',
      maxHeight: 'calc(100vh - 240px)',
    }}>
      {/* Sidebar — only when sessions exist */}
      {sessions.length > 0 && (
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

      {/* Main content */}
      <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {showNewChatInput ? (
          /* New chat / empty state */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--sam-space-8)',
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

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Inline provisioning progress — replaces the old TaskExecutionProgress banner. */
function ProvisioningIndicator({ state }: { state: ProvisioningState }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const seconds = Math.floor(elapsed / 1000);
  const elapsedDisplay = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  const statusLabel =
    state.status === 'queued' ? 'Setting up...' :
    state.status === 'delegated' ? 'Provisioning workspace...' :
    state.status === 'failed' ? 'Setup failed' :
    state.status === 'cancelled' ? 'Cancelled' :
    'Starting agent...';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--sam-space-2)',
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      backgroundColor: state.status === 'failed' ? 'var(--sam-color-danger-tint)' : 'var(--sam-color-info-tint)',
      borderBottom: '1px solid var(--sam-color-border-default)',
    }}>
      {!isTerminal(state.status) && <Spinner size="sm" />}
      <span className="sam-type-secondary" style={{
        color: state.status === 'failed' ? 'var(--sam-color-danger)' : 'var(--sam-color-fg-primary)',
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
      {state.errorMessage && (
        <span className="sam-type-caption" style={{ color: 'var(--sam-color-danger)' }}>
          {state.errorMessage}
        </span>
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
