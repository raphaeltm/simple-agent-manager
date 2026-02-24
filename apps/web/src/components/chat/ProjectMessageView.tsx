import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { getChatSession } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionResponse } from '../../lib/api';

interface ProjectMessageViewProps {
  projectId: string;
  sessionId: string;
}

const roleStyles: Record<string, { label: string; color: string; bg: string }> = {
  user: { label: 'User', color: 'var(--sam-color-tn-blue)', bg: 'var(--sam-color-info-tint)' },
  assistant: { label: 'Assistant', color: 'var(--sam-color-tn-green)', bg: 'var(--sam-color-success-tint)' },
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

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
}) => {
  const navigate = useNavigate();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data = await getChatSession(projectId, sessionId);
      setSession(data.session);
      setMessages(data.messages);
      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0 && !loading) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, loading]);

  // WebSocket connection for real-time updates on active sessions
  useEffect(() => {
    if (!session || session.status !== 'active') return;

    const API_URL = import.meta.env.VITE_API_URL || '';
    const wsUrl = API_URL.replace(/^http/, 'ws') + `/api/projects/${projectId}/sessions/ws`;

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
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
              // Deduplicate by id
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
      // WebSocket not available — polling fallback below
    }

    // Polling fallback for when WebSocket is unavailable or fails
    const pollInterval = setInterval(async () => {
      try {
        const data = await getChatSession(projectId, sessionId);
        setSession(data.session);
        setMessages(data.messages);
        setHasMore(data.hasMore);
      } catch {
        // Silently fail on poll errors
      }
    }, 10000);

    return () => {
      ws?.close();
      clearInterval(pollInterval);
    };
  }, [session?.status, projectId, sessionId]);

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

  const isActive = session?.status === 'active';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Session header */}
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
            {session.topic || `Session ${session.id.slice(0, 8)}`}
          </span>
          <StatusBadge
            status={isActive ? 'running' : 'stopped'}
            label={session.status}
          />
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
            {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
          </span>
          {session.workspaceId && isActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/workspace/${session.workspaceId}`)}
              style={{ marginLeft: 'auto' }}
            >
              Open Workspace
            </Button>
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
            {isActive ? 'Waiting for messages...' : 'No messages in this session.'}
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
    </div>
  );
};
