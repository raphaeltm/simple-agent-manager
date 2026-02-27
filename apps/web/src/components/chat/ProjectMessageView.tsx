import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { getChatSession, resetIdleTimer } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionResponse, ChatSessionDetailResponse } from '../../lib/api';

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

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
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

function deriveSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  const s = session as ChatSessionResponse & { agentCompletedAt?: number | null; isIdle?: boolean };
  if (s.isIdle || s.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<{ id: string; outputBranch?: string | null; outputPrUrl?: string | null } | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow-up input state
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data: ChatSessionDetailResponse & { session: ChatSessionResponse & { task?: { id: string; outputBranch?: string | null; outputPrUrl?: string | null } } } = await getChatSession(projectId, sessionId);
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

  // Auto-scroll to bottom only when new messages are appended (not on
  // every poll cycle, and not when "Load More" prepends older messages).
  // Tracks previous count via ref; skips while loadingMore to avoid
  // yanking the user to the bottom when they asked for older messages.
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && !loading && !loadingMore) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, loading, loadingMore]);

  // WebSocket for real-time updates — connects to project DO for message streaming
  useEffect(() => {
    if (!session || session.status !== 'active') return;

    const API_URL = import.meta.env.VITE_API_URL || '';
    const wsUrl = API_URL.replace(/^http/, 'ws') + `/api/projects/${projectId}/sessions/ws`;

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'message.new' && data.sessionId === sessionId) {
            const newMsg: ChatMessageResponse = {
              id: data.id || crypto.randomUUID(),
              sessionId: data.sessionId,
              role: data.role,
              content: data.content,
              toolMetadata: data.toolMetadata || null,
              createdAt: data.createdAt || Date.now(),
            };
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
          } else if (data.type === 'session.stopped' && data.sessionId === sessionId) {
            setSession((prev) => prev ? { ...prev, status: 'stopped' } : prev);
          }
        } catch {
          // Ignore malformed messages
        }
      };
    } catch {
      // WebSocket not available
    }

    // Polling fallback — only updates state when the server has new data.
    // Uses a fingerprint (count + last ID + session status) to avoid
    // replacing state with identical data, which would trigger unnecessary
    // re-renders and fight with auto-scroll logic.
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

    return () => {
      ws?.close();
      wsRef.current = null;
      clearInterval(pollInterval);
    };
  }, [session?.status, projectId, sessionId]);

  // Send follow-up message via WebSocket or HTTP
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    const currentState = session ? deriveSessionState(session) : 'terminated';

    setSendingFollowUp(true);
    try {
      // Reset idle timer if session is idle (T037)
      if (currentState === 'idle') {
        resetIdleTimer(projectId, sessionId).catch(() => {
          // Best-effort — timer reset failure shouldn't block sending
        });
      }

      // Try sending via the project DO WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'message.send',
          sessionId,
          content: trimmed,
          role: 'user',
        }));
        // Optimistic add
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          sessionId,
          role: 'user',
          content: trimmed,
          toolMetadata: null,
          createdAt: Date.now(),
        }]);
        setFollowUp('');
      } else {
        // Fallback: just show the message optimistically; the VM agent WS isn't
        // connected from the browser yet (Phase 5+6 will add direct VM WS).
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          sessionId,
          role: 'user',
          content: trimmed,
          toolMetadata: null,
          createdAt: Date.now(),
        }]);
        setFollowUp('');
      }
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

  const sessionState = session ? deriveSessionState(session) : 'terminated';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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

      {/* Input area — varies by session state (T019) */}
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
          placeholder="Send a follow-up..."
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
