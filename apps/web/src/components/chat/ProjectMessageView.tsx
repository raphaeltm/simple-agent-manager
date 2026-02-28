import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { getChatSession, resetIdleTimer } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionResponse, ChatSessionDetailResponse } from '../../lib/api';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import type { ChatConnectionState } from '../../hooks/useChatWebSocket';

interface ProjectMessageViewProps {
  projectId: string;
  sessionId: string;
}

const roleStyles: Record<string, { label: string; color: string; bg: string }> = {
  user: { label: 'You', color: 'var(--sam-color-tn-blue)', bg: 'var(--sam-color-info-tint)' },
  assistant: { label: 'Agent', color: 'var(--sam-color-tn-green)', bg: 'var(--sam-color-success-tint)' },
  system: { label: 'System', color: 'var(--sam-color-tn-yellow)', bg: 'var(--sam-color-warning-tint)' },
  tool: { label: 'Tool', color: 'var(--sam-color-tn-purple)', bg: 'var(--sam-color-info-tint)' },
};

/** Default idle timeout in ms — matches the server-side default (NODE_WARM_TIMEOUT_MS). */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function MessageBubble({ message }: { message: ChatMessageResponse }) {
  const style = roleStyles[message.role] || roleStyles.system!;

  return (
    <div style={{
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      borderRadius: 'var(--sam-radius-md)',
      backgroundColor: style.bg,
      borderLeft: `3px solid ${style.color}`,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sam-space-2)',
        marginBottom: 'var(--sam-space-2)',
      }}>
        <span style={{
          fontSize: 'var(--sam-type-caption-size)',
          fontWeight: 600,
          color: style.color,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {style.label}
        </span>
        <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
          {formatTimestamp(message.createdAt)}
        </span>
      </div>
      <div className="sam-type-body" style={{
        color: 'var(--sam-color-fg-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
      }}>
        {message.content}
      </div>
      {message.toolMetadata && (
        <details style={{ marginTop: 'var(--sam-space-2)' }}>
          <summary className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', cursor: 'pointer' }}>
            Tool metadata
          </summary>
          <pre style={{
            fontSize: 'var(--sam-type-caption-size)',
            color: 'var(--sam-color-fg-muted)',
            backgroundColor: 'var(--sam-color-bg-inset)',
            padding: 'var(--sam-space-2)',
            borderRadius: 'var(--sam-radius-sm)',
            overflow: 'auto',
            maxHeight: '200px',
            marginTop: 'var(--sam-space-1)',
          }}>
            {JSON.stringify(message.toolMetadata, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

type SessionState = 'active' | 'idle' | 'terminated';

interface ExtendedSession extends ChatSessionResponse {
  agentCompletedAt?: number | null;
  isIdle?: boolean;
  cleanupAt?: number | null;
  task?: { id: string; outputBranch?: string | null; outputPrUrl?: string | null; errorMessage?: string | null; outputSummary?: string | null };
}

function deriveSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  const s = session as ExtendedSession;
  if (s.isIdle || s.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<ExtendedSession['task'] | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow-up input state
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);

  // Idle timer state (TDF-8)
  const [idleCountdownMs, setIdleCountdownMs] = useState<number | null>(null);

  const sessionState = session ? deriveSessionState(session) : 'terminated';

  // WebSocket with reconnection (TDF-8)
  const { connectionState, wsRef, retry: retryWs } = useChatWebSocket({
    projectId,
    sessionId,
    enabled: session?.status === 'active',
    onMessage: useCallback((msg: ChatMessageResponse) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    }, []),
    onSessionStopped: useCallback(() => {
      setSession((prev) => prev ? { ...prev, status: 'stopped' } : prev);
    }, []),
    onCatchUp: useCallback((catchUpMessages: ChatMessageResponse[], catchUpSession: ChatSessionResponse, catchUpHasMore: boolean) => {
      setSession(catchUpSession);
      setMessages(catchUpMessages);
      setHasMore(catchUpHasMore);
    }, []),
  });

  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data: ChatSessionDetailResponse & { session: ExtendedSession } = await getChatSession(projectId, sessionId);
      setSession(data.session);
      setMessages(data.messages);
      setHasMore(data.hasMore);
      if (data.session.task) {
        setTaskEmbed(data.session.task);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Auto-scroll to bottom only when new messages are appended
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && !loading && !loadingMore) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, loading, loadingMore]);

  // Polling fallback — keeps running alongside WebSocket for reliability.
  // Only updates state when the server has new data (fingerprint-based).
  useEffect(() => {
    if (!session || session.status !== 'active') return;

    const ACTIVE_POLL_MS = 3000;
    let lastPollFingerprint = '';
    const pollInterval = setInterval(async () => {
      try {
        const data = await getChatSession(projectId, sessionId);
        const newLastId = data.messages[data.messages.length - 1]?.id ?? '';
        const fingerprint = `${data.messages.length}:${newLastId}:${data.session.status}:${data.hasMore}`;
        if (fingerprint !== lastPollFingerprint) {
          lastPollFingerprint = fingerprint;
          setSession(data.session);
          setHasMore(data.hasMore);
          setMessages(data.messages);
        }
      } catch {
        // Silently fail on poll errors
      }
    }, ACTIVE_POLL_MS);

    return () => clearInterval(pollInterval);
  }, [session?.status, projectId, sessionId]);

  // Idle timer countdown (TDF-8)
  // Extract primitive values to avoid re-firing on every session object change
  const ext = session as ExtendedSession | null;
  const cleanupAt = ext?.cleanupAt ?? null;
  const agentCompletedAt = ext?.agentCompletedAt ?? null;

  useEffect(() => {
    if (sessionState !== 'idle') {
      setIdleCountdownMs(null);
      return;
    }

    if (cleanupAt) {
      // Server told us the exact cleanup time
      const tick = () => setIdleCountdownMs(Math.max(0, cleanupAt - Date.now()));
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    } else if (agentCompletedAt) {
      // Estimate from agentCompletedAt + default timeout
      const estimatedCleanup = agentCompletedAt + DEFAULT_IDLE_TIMEOUT_MS;
      const tick = () => setIdleCountdownMs(Math.max(0, estimatedCleanup - Date.now()));
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    }
    // No timing info available — don't show countdown
    return;
  }, [sessionState, cleanupAt, agentCompletedAt]);

  // Send follow-up message via WebSocket or HTTP
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
    try {
      // Reset idle timer if session is idle (T037)
      if (sessionState === 'idle') {
        resetIdleTimer(projectId, sessionId)
          .then((result) => {
            // Update countdown with server-provided cleanup time
            if (result.cleanupAt) {
              setSession((prev) => {
                if (!prev) return prev;
                return { ...prev, cleanupAt: result.cleanupAt, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
              });
            }
          })
          .catch(() => {
            // Best-effort — timer reset failure shouldn't block sending
          });
      }

      // Optimistic add
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        sessionId,
        role: 'user',
        content: trimmed,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);

      // Try sending via WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'message.send',
          sessionId,
          content: trimmed,
          role: 'user',
        }));
      } else {
        // WebSocket not connected — message shown optimistically but may not
        // be delivered until the next poll cycle or WS reconnects.
        console.warn('[ProjectMessageView] WebSocket not connected, message delivery deferred');
      }

      setFollowUp('');
    } finally {
      setSendingFollowUp(false);
    }
  };

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    const firstMessage = messages[0];
    if (!firstMessage) return;

    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, {
        before: firstMessage.createdAt,
      });
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
    } catch {
      // Silently fail
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: 'var(--sam-space-4)',
        color: 'var(--sam-color-danger)',
        fontSize: 'var(--sam-type-secondary-size)',
      }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Connection indicator (TDF-8) */}
      {sessionState === 'active' && connectionState !== 'connected' && (
        <ConnectionBanner state={connectionState} onRetry={retryWs} />
      )}

      {/* Session header with branch/PR info */}
      {session && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-3)',
          padding: 'var(--sam-space-3) var(--sam-space-4)',
          borderBottom: '1px solid var(--sam-color-border-default)',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 'var(--sam-type-body-size)',
            fontWeight: 600,
            color: 'var(--sam-color-fg-primary)',
          }}>
            {session.topic || `Chat ${session.id.slice(0, 8)}`}
          </span>

          {/* State indicator */}
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: 'var(--sam-type-caption-size)',
            color: sessionState === 'active' ? 'var(--sam-color-success)'
              : sessionState === 'idle' ? 'var(--sam-color-warning, #f59e0b)'
              : 'var(--sam-color-fg-muted)',
            fontWeight: 500,
          }}>
            <span style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: 'currentColor',
            }} />
            {sessionState === 'active' ? 'Active' : sessionState === 'idle' ? 'Idle' : 'Stopped'}
          </span>

          {/* Idle countdown (TDF-8) */}
          {sessionState === 'idle' && idleCountdownMs !== null && (
            <span className="sam-type-caption" style={{
              color: idleCountdownMs < 5 * 60 * 1000
                ? 'var(--sam-color-danger)'
                : 'var(--sam-color-warning, #f59e0b)',
              fontFamily: 'monospace',
            }}>
              Cleanup in {formatCountdown(idleCountdownMs)}
            </span>
          )}

          {/* Branch name (T021) */}
          {taskEmbed?.outputBranch && (
            <span className="sam-type-caption" style={{
              color: 'var(--sam-color-fg-muted)',
              fontFamily: 'monospace',
              backgroundColor: 'var(--sam-color-bg-inset)',
              padding: '1px 6px',
              borderRadius: 'var(--sam-radius-sm)',
            }}>
              {taskEmbed.outputBranch}
            </span>
          )}

          {/* PR link (T021) */}
          {taskEmbed?.outputPrUrl && (
            <a
              href={taskEmbed.outputPrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="sam-type-caption"
              style={{
                color: 'var(--sam-color-accent-primary)',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              View PR
            </a>
          )}

          {session.workspaceId && sessionState === 'active' && (
            <a
              href={`/workspaces/${session.workspaceId}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 'auto' }}
            >
              <Button variant="ghost" size="sm">
                Open Workspace
              </Button>
            </a>
          )}
        </div>
      )}

      {/* Task error/summary display (TDF-8) */}
      {taskEmbed?.errorMessage && sessionState === 'terminated' && (
        <div style={{
          padding: 'var(--sam-space-2) var(--sam-space-4)',
          backgroundColor: 'var(--sam-color-danger-tint)',
          borderBottom: '1px solid var(--sam-color-border-default)',
        }}>
          <span className="sam-type-caption" style={{
            color: 'var(--sam-color-danger)',
            fontWeight: 500,
          }}>
            Error:
          </span>{' '}
          <span className="sam-type-caption" style={{
            color: 'var(--sam-color-danger)',
            wordBreak: 'break-word',
          }}>
            {taskEmbed.errorMessage}
          </span>
        </div>
      )}
      {taskEmbed?.outputSummary && sessionState === 'terminated' && (
        <div style={{
          padding: 'var(--sam-space-2) var(--sam-space-4)',
          backgroundColor: 'var(--sam-color-success-tint)',
          borderBottom: '1px solid var(--sam-color-border-default)',
        }}>
          <span className="sam-type-caption" style={{
            color: 'var(--sam-color-success)',
            fontWeight: 500,
          }}>
            Summary:
          </span>{' '}
          <span className="sam-type-caption" style={{
            color: 'var(--sam-color-fg-primary)',
            wordBreak: 'break-word',
          }}>
            {taskEmbed.outputSummary}
          </span>
        </div>
      )}

      {/* Messages area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 'var(--sam-space-4)',
      }}>
        {hasMore && (
          <div style={{ textAlign: 'center', marginBottom: 'var(--sam-space-3)' }}>
            <Button variant="ghost" size="sm" onClick={loadMore} loading={loadingMore}>
              Load earlier messages
            </Button>
          </div>
        )}

        {messages.length === 0 ? (
          <div style={{
            color: 'var(--sam-color-fg-muted)',
            fontSize: 'var(--sam-type-secondary-size)',
            textAlign: 'center',
            padding: 'var(--sam-space-8)',
          }}>
            {sessionState === 'active' ? 'Waiting for messages...' : 'No messages in this session.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — varies by session state */}
      {sessionState === 'active' && (
        <FollowUpInput
          value={followUp}
          onChange={setFollowUp}
          onSend={handleSendFollowUp}
          sending={sendingFollowUp}
          placeholder="Send a message..."
        />
      )}
      {sessionState === 'idle' && (
        <FollowUpInput
          value={followUp}
          onChange={setFollowUp}
          onSend={handleSendFollowUp}
          sending={sendingFollowUp}
          placeholder="Send a follow-up to keep the session alive..."
        />
      )}
      {sessionState === 'terminated' && (
        <div style={{
          borderTop: '1px solid var(--sam-color-border-default)',
          padding: 'var(--sam-space-3) var(--sam-space-4)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          textAlign: 'center',
        }}>
          <span className="sam-type-secondary" style={{ color: 'var(--sam-color-fg-muted)' }}>
            This session has ended.
          </span>
        </div>
      )}
    </div>
  );
};

/** WebSocket connection status banner (TDF-8). */
function ConnectionBanner({ state, onRetry }: { state: ChatConnectionState; onRetry: () => void }) {
  const label = state === 'connecting' ? 'Connecting...'
    : state === 'reconnecting' ? 'Reconnecting...'
    : 'Disconnected';

  const isRecoverable = state === 'disconnected';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--sam-space-2)',
      padding: 'var(--sam-space-1) var(--sam-space-4)',
      backgroundColor: isRecoverable ? 'var(--sam-color-danger-tint)' : 'var(--sam-color-warning-tint, var(--sam-color-info-tint))',
      borderBottom: '1px solid var(--sam-color-border-default)',
      fontSize: 'var(--sam-type-caption-size)',
    }}>
      {!isRecoverable && <Spinner size="sm" />}
      <span style={{
        color: isRecoverable ? 'var(--sam-color-danger)' : 'var(--sam-color-fg-muted)',
      }}>
        {label}
      </span>
      {isRecoverable && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--sam-color-accent-primary)',
            fontSize: 'var(--sam-type-caption-size)',
            fontWeight: 500,
            textDecoration: 'underline',
            padding: 0,
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** Follow-up message input for active/idle sessions. */
function FollowUpInput({
  value,
  onChange,
  onSend,
  sending,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
}) {
  return (
    <div style={{
      borderTop: '1px solid var(--sam-color-border-default)',
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      backgroundColor: 'var(--sam-color-bg-surface)',
    }}>
      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'flex-end' }}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !sending) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          disabled={sending}
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
          onClick={onSend}
          disabled={sending || !value.trim()}
          style={{
            padding: 'var(--sam-space-2) var(--sam-space-3)',
            backgroundColor: sending || !value.trim() ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: sending || !value.trim() ? 'var(--sam-color-fg-muted)' : 'white',
            border: 'none',
            borderRadius: 'var(--sam-radius-md)',
            cursor: sending || !value.trim() ? 'default' : 'pointer',
            fontSize: 'var(--sam-type-body-size)',
            fontWeight: 500,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
