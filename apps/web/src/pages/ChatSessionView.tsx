import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Breadcrumb, Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { getChatSession } from '../lib/api';
import type { ChatMessageResponse, ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const diff = end - startedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

const roleStyles: Record<string, { label: string; color: string; bg: string }> = {
  user: { label: 'User', color: '#7aa2f7', bg: 'rgba(122, 162, 247, 0.1)' },
  assistant: { label: 'Assistant', color: '#9ece6a', bg: 'rgba(158, 206, 106, 0.1)' },
  system: { label: 'System', color: '#e0af68', bg: 'rgba(224, 175, 104, 0.1)' },
  tool: { label: 'Tool', color: '#bb9af7', bg: 'rgba(187, 154, 247, 0.1)' },
};

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

export function ChatSessionView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId, project } = useProjectContext();

  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      setError(null);
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

  const loadMore = async () => {
    if (!sessionId || !hasMore || loadingMore) return;
    const firstMessage = messages[0];
    if (!firstMessage) return;

    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, {
        before: firstMessage.createdAt,
      });
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more messages');
    } finally {
      setLoadingMore(false);
    }
  };

  const sessionTitle = session?.topic || `Session ${sessionId?.slice(0, 8) ?? ''}`;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      {/* Breadcrumb */}
      <Breadcrumb
        segments={[
          { label: 'Dashboard', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: project?.name ?? '...', path: `/projects/${projectId}` },
          { label: 'Sessions', path: `/projects/${projectId}/sessions` },
          { label: sessionTitle },
        ]}
      />

      {error && (
        <div style={{
          padding: 'var(--sam-space-3) var(--sam-space-4)',
          borderRadius: 'var(--sam-radius-md)',
          backgroundColor: 'var(--sam-color-danger-tint)',
          border: '1px solid var(--sam-color-danger)',
          color: 'var(--sam-color-danger)',
          fontSize: 'var(--sam-type-secondary-size)',
          marginTop: 'var(--sam-space-3)',
        }}>
          {error}
        </div>
      )}

      {/* Session info header */}
      {session && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-3)',
          padding: 'var(--sam-space-4)',
          borderRadius: 'var(--sam-radius-md)',
          border: '1px solid var(--sam-color-border-default)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          marginTop: 'var(--sam-space-4)',
          flexWrap: 'wrap',
        }}>
          <StatusBadge
            status={session.status === 'active' ? 'running' : session.status === 'error' ? 'error' : 'stopped'}
            label={session.status}
          />
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
            {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
          </span>
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
            Duration: {formatDuration(session.startedAt, session.endedAt)}
          </span>
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', marginLeft: 'auto' }}>
            Started {formatTimestamp(session.startedAt)}
          </span>
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 'var(--sam-space-3)' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadMore}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load earlier messages
          </Button>
        </div>
      )}

      {/* Messages */}
      <div style={{ display: 'grid', gap: 'var(--sam-space-3)', marginTop: 'var(--sam-space-4)' }}>
        {messages.length === 0 ? (
          <div style={{
            color: 'var(--sam-color-fg-muted)',
            fontSize: 'var(--sam-type-secondary-size)',
            textAlign: 'center',
            padding: 'var(--sam-space-8)',
          }}>
            No messages in this session.
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
        )}
      </div>
    </div>
  );
}
