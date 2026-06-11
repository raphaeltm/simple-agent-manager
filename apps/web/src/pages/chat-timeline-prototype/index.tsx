/**
 * Chat Session Timeline Prototype
 *
 * Self-contained prototype for design exploration (no API calls, no auth).
 * Demonstrates:
 *   1. Panel/drawer timeline (desktop = right drawer, mobile = bottom sheet)
 *   2. V2 density toggle (agent snippet before each human message)
 *   3. Jump rail (minimap-style vertical rail)
 */
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  GitPullRequest,
  Loader2,
  LogOut,
  Map as MapIcon,
  PanelRightOpen,
  ToggleLeft,
  ToggleRight,
  User,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AGENT_SNIPPETS,
  EMPTY_TIMELINE,
  LONG_SESSION_MESSAGES,
  LONG_SESSION_TIMELINE,
  NOTIFICATION_STYLES,
  SINGLE_MESSAGE_TIMELINE,
  type AgentSnippet,
  type MockMessage,
  type MockNotification,
  type NotificationType,
  type TimelineEntry,
} from './mock-data';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function NotificationIcon({ type, size = 14 }: { type: NotificationType; size?: number }) {
  const style = NOTIFICATION_STYLES[type];
  const props = { size, color: style.color, strokeWidth: 2 };
  switch (type) {
    case 'task_complete':
      return <CheckCircle2 {...props} />;
    case 'needs_input':
      return <AlertCircle {...props} />;
    case 'error':
      return <XCircle {...props} />;
    case 'progress':
      return <Loader2 {...props} />;
    case 'pr_created':
      return <GitPullRequest {...props} />;
    case 'session_ended':
      return <LogOut {...props} />;
  }
}

// ---------------------------------------------------------------------------
// Dataset selector
// ---------------------------------------------------------------------------

type DatasetKey = 'long' | 'single' | 'empty';
const DATASETS: Record<DatasetKey, { label: string; timeline: TimelineEntry[] }> = {
  long: { label: 'Long session (15+ turns)', timeline: LONG_SESSION_TIMELINE },
  single: { label: 'Single message', timeline: SINGLE_MESSAGE_TIMELINE },
  empty: { label: 'Empty', timeline: EMPTY_TIMELINE },
};

// ---------------------------------------------------------------------------
// Mock Chat View (left side / background)
// ---------------------------------------------------------------------------

function MockChatBubble({
  message,
  highlighted,
  innerRef,
}: {
  message: MockMessage;
  highlighted: boolean;
  innerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const isUser = message.role === 'user';

  return (
    <div
      ref={innerRef}
      data-msg-id={message.id}
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        padding: '4px 12px',
        transition: 'background-color 0.5s ease',
        backgroundColor: highlighted ? 'rgba(34, 197, 94, 0.12)' : 'transparent',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: 12,
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: isUser
            ? 'linear-gradient(135deg, rgba(22, 163, 74, 0.22), rgba(34, 197, 94, 0.1))'
            : 'rgba(12, 20, 17, 0.72)',
          border: `1px solid ${isUser ? 'rgba(34, 197, 94, 0.22)' : 'rgba(34, 197, 94, 0.12)'}`,
          color: 'var(--sam-color-fg-primary, #e6f2ee)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
            fontSize: 11,
            color: 'var(--sam-color-fg-muted, #9fb7ae)',
          }}
        >
          {isUser ? <User size={12} /> : <span style={{ fontSize: 12 }}>AI</span>}
          <span>{relativeTime(message.createdAt)}</span>
        </div>
        {message.content}
      </div>
    </div>
  );
}

function MockChatView({
  messages,
  highlightedId,
  chatScrollRef,
}: {
  messages: MockMessage[];
  highlightedId: string | null;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const msgRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Scroll to highlighted message
  useEffect(() => {
    if (!highlightedId) return;
    const el = msgRefs.current.get(highlightedId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedId]);

  return (
    <div
      ref={chatScrollRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {messages.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--sam-color-fg-muted)',
            fontSize: 14,
          }}
        >
          No messages yet
        </div>
      )}
      {messages.map((m) => (
        <MockChatBubble
          key={m.id}
          message={m}
          highlighted={m.id === highlightedId}
          innerRef={{
            current: null,
            ...{
              // Immediately register ref
            },
          } as never}
        />
      ))}
      {/* Re-render with proper refs: use callback ref pattern */}
      {messages.map((m) => null)}
    </div>
  );
}

// A simpler approach: use a single component that manages refs properly
function ChatArea({
  messages,
  highlightedId,
}: {
  messages: MockMessage[];
  highlightedId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlightedId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-msg-id="${highlightedId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedId]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {messages.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--sam-color-fg-muted)',
            fontSize: 14,
          }}
        >
          No messages yet
        </div>
      )}
      {messages.map((m) => {
        const isUser = m.role === 'user';
        const isHighlighted = m.id === highlightedId;
        return (
          <div
            key={m.id}
            data-msg-id={m.id}
            style={{
              display: 'flex',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
              padding: '4px 12px',
              transition: 'background-color 0.6s ease',
              backgroundColor: isHighlighted ? 'rgba(34, 197, 94, 0.12)' : 'transparent',
              borderRadius: 8,
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '10px 14px',
                borderRadius: 12,
                fontSize: 14,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: isUser
                  ? 'linear-gradient(135deg, rgba(22, 163, 74, 0.22), rgba(34, 197, 94, 0.1))'
                  : 'rgba(12, 20, 17, 0.72)',
                border: `1px solid ${isUser ? 'rgba(34, 197, 94, 0.22)' : 'rgba(34, 197, 94, 0.12)'}`,
                color: 'var(--sam-color-fg-primary, #e6f2ee)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  fontSize: 11,
                  color: 'var(--sam-color-fg-muted, #9fb7ae)',
                }}
              >
                {isUser ? <User size={12} /> : <span style={{ fontSize: 12 }}>AI</span>}
                <span>{relativeTime(m.createdAt)}</span>
              </div>
              {m.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline Entry Components
// ---------------------------------------------------------------------------

function TimelineMessageEntry({
  message,
  agentSnippet,
  showAgentSnippets,
  onJump,
}: {
  message: MockMessage;
  agentSnippet?: AgentSnippet;
  showAgentSnippets: boolean;
  onJump: (id: string) => void;
}) {
  const isUser = message.role === 'user';
  const snippet = message.content.length > 100 ? message.content.slice(0, 97) + '...' : message.content;

  if (message.isUnloaded) {
    return (
      <div
        style={{
          padding: '8px 12px',
          opacity: 0.4,
          fontSize: 13,
          color: 'var(--sam-color-fg-muted)',
          borderLeft: '2px solid rgba(159, 183, 174, 0.2)',
          marginLeft: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <User size={12} />
          <span style={{ fontSize: 11 }}>{relativeTime(message.createdAt)}</span>
        </div>
        <div
          style={{
            marginTop: 2,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {snippet}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* V2 agent snippet (before user message) */}
      {showAgentSnippets && agentSnippet && (
        <div
          style={{
            padding: '6px 12px 6px 20px',
            fontSize: 12,
            color: 'var(--sam-color-fg-muted)',
            opacity: 0.7,
            borderLeft: '2px solid rgba(34, 197, 94, 0.15)',
            marginLeft: 8,
            marginBottom: 2,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Agent
            </span>
          </div>
          <div
            style={{
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {agentSnippet.content}
          </div>
        </div>
      )}
      {/* User message entry */}
      <button
        onClick={() => onJump(message.id)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          borderLeft: isUser ? '2px solid rgba(34, 197, 94, 0.4)' : '2px solid rgba(159, 183, 174, 0.2)',
          marginLeft: 8,
          borderRadius: 0,
          color: 'var(--sam-color-fg-primary)',
          fontSize: 13,
          lineHeight: 1.4,
          transition: 'background-color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(34, 197, 94, 0.06)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <User size={12} color="var(--sam-color-fg-muted)" />
          <span style={{ fontSize: 11, color: 'var(--sam-color-fg-muted)' }}>
            {relativeTime(message.createdAt)}
          </span>
        </div>
        <div
          style={{
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
          }}
        >
          {snippet}
        </div>
      </button>
    </div>
  );
}

function TimelineNotificationEntry({ notification }: { notification: MockNotification }) {
  const style = NOTIFICATION_STYLES[notification.type];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        marginLeft: 8,
        borderLeft: `2px solid ${style.color}40`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          background: style.bgColor,
          flexShrink: 0,
        }}
      >
        <NotificationIcon type={notification.type} size={13} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            color: style.color,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {notification.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--sam-color-fg-muted)', marginTop: 1 }}>
          {relativeTime(notification.createdAt)}
        </div>
      </div>
      {notification.actionUrl && (
        <ExternalLink size={12} color="var(--sam-color-fg-muted)" style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}

function LazyBoundary({ onLoadOlder }: { onLoadOlder: () => void }) {
  return (
    <button
      onClick={onLoadOlder}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '8px 12px',
        margin: '4px 0',
        background: 'rgba(159, 183, 174, 0.06)',
        border: '1px dashed rgba(159, 183, 174, 0.2)',
        borderRadius: 6,
        color: 'var(--sam-color-fg-muted)',
        fontSize: 12,
        cursor: 'pointer',
        width: '100%',
        transition: 'background-color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'rgba(159, 183, 174, 0.12)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'rgba(159, 183, 174, 0.06)';
      }}
    >
      <ChevronDown size={12} />
      Load older messages
    </button>
  );
}

// ---------------------------------------------------------------------------
// Timeline Panel
// ---------------------------------------------------------------------------

function TimelinePanel({
  timeline,
  showAgentSnippets,
  onToggleSnippets,
  onJump,
}: {
  timeline: TimelineEntry[];
  showAgentSnippets: boolean;
  onToggleSnippets: () => void;
  onJump: (id: string) => void;
}) {
  // Build a map of agent snippets by the user message they precede
  const snippetMap = useMemo(() => {
    const map = new Map<string, AgentSnippet>();
    for (const s of AGENT_SNIPPETS) {
      map.set(s.beforeMessageId, s);
    }
    return map;
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--sam-color-border-default, #29423b)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Clock size={14} color="var(--sam-color-fg-muted)" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>
            Timeline
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--sam-color-fg-muted)',
              background: 'rgba(159, 183, 174, 0.1)',
              padding: '2px 6px',
              borderRadius: 4,
            }}
          >
            {timeline.filter((e) => e.kind === 'message' && e.data.role === 'user').length} turns
          </span>
        </div>

        {/* V2 density toggle */}
        <button
          onClick={onToggleSnippets}
          title={showAgentSnippets ? 'Hide agent snippets' : 'Show agent snippets (V2)'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            borderRadius: 6,
            border: `1px solid ${showAgentSnippets ? 'rgba(34, 197, 94, 0.3)' : 'rgba(159, 183, 174, 0.2)'}`,
            background: showAgentSnippets ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
            color: showAgentSnippets ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500,
            transition: 'all 0.15s',
          }}
        >
          {showAgentSnippets ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
          V2
        </button>
      </div>

      {/* Scrollable entries */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 4px' }}>
        {timeline.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--sam-color-fg-muted)',
              fontSize: 13,
            }}
          >
            No timeline entries
          </div>
        )}
        {timeline.map((entry, i) => {
          if (entry.kind === 'lazy-boundary') {
            return <LazyBoundary key={`lazy-${i}`} onLoadOlder={() => alert('Mock: would load older messages')} />;
          }
          if (entry.kind === 'notification') {
            return <TimelineNotificationEntry key={entry.data.id} notification={entry.data} />;
          }
          // Only show user messages in the timeline (assistant handled by V2 snippets)
          if (entry.data.role === 'assistant' && !entry.data.isUnloaded) return null;
          return (
            <TimelineMessageEntry
              key={entry.data.id}
              message={entry.data}
              agentSnippet={snippetMap.get(entry.data.id)}
              showAgentSnippets={showAgentSnippets}
              onJump={onJump}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jump Rail (minimap)
// ---------------------------------------------------------------------------

function JumpRail({
  timeline,
  onJump,
}: {
  timeline: TimelineEntry[];
  onJump: (id: string) => void;
}) {
  const entries = timeline.filter(
    (e) => e.kind === 'message' || e.kind === 'notification',
  );
  if (entries.length === 0) return null;

  return (
    <div
      style={{
        width: 20,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '12px 0',
        gap: 3,
        overflowY: 'auto',
        flexShrink: 0,
        borderRight: '1px solid var(--sam-color-border-default, #29423b)',
      }}
    >
      {entries.map((entry, i) => {
        if (entry.kind === 'notification') {
          const style = NOTIFICATION_STYLES[entry.data.type];
          return (
            <div
              key={`jr-${i}`}
              title={entry.data.title}
              style={{
                width: 6,
                height: 6,
                borderRadius: 2,
                backgroundColor: style.color,
                opacity: 0.7,
                flexShrink: 0,
              }}
            />
          );
        }
        if (entry.kind === 'message') {
          const isUser = entry.data.role === 'user';
          if (!isUser) return null;
          return (
            <button
              key={`jr-${i}`}
              onClick={() => onJump(entry.data.id)}
              title={entry.data.content.slice(0, 40)}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: entry.data.isUnloaded
                  ? 'rgba(159, 183, 174, 0.2)'
                  : 'rgba(34, 197, 94, 0.5)',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
                transition: 'transform 0.1s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.5)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom Sheet (Mobile)
// ---------------------------------------------------------------------------

function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 50,
        }}
      />
      {/* Sheet */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '70vh',
          background: 'var(--sam-color-bg-surface, #13201d)',
          borderTop: '1px solid var(--sam-color-border-default, #29423b)',
          borderRadius: '14px 14px 0 0',
          zIndex: 51,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Drag handle */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '8px 0 4px',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: 'rgba(159, 183, 174, 0.3)',
            }}
          />
        </div>
        {children}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Prototype Page
// ---------------------------------------------------------------------------

export function ChatTimelinePrototype() {
  const [dataset, setDataset] = useState<DatasetKey>('long');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showAgentSnippets, setShowAgentSnippets] = useState(false);
  const [showJumpRail, setShowJumpRail] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // Simple mobile detection
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const { timeline } = DATASETS[dataset];
  const allMessages = useMemo(
    () =>
      timeline
        .filter((e): e is { kind: 'message'; data: MockMessage } => e.kind === 'message')
        .map((e) => e.data),
    [timeline],
  );

  const handleJump = useCallback((id: string) => {
    setHighlightedId(id);
    // Clear highlight after animation
    setTimeout(() => setHighlightedId(null), 1500);
  }, []);

  return (
    <div
      style={{
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--sam-color-bg-canvas, #0b1110)',
        color: 'var(--sam-color-fg-primary, #e6f2ee)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* ---- Session Header ---- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--sam-color-border-default, #29423b)',
          background: 'var(--sam-color-bg-surface, #13201d)',
          flexShrink: 0,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Project Chat</span>
          <span style={{ fontSize: 12, color: 'var(--sam-color-fg-muted)' }}>
            (Timeline Prototype)
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {/* Dataset selector */}
          <select
            value={dataset}
            onChange={(e) => setDataset(e.target.value as DatasetKey)}
            style={{
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--sam-color-border-default)',
              background: 'var(--sam-color-bg-inset)',
              color: 'var(--sam-color-fg-primary)',
              cursor: 'pointer',
            }}
          >
            {Object.entries(DATASETS).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>

          {/* Jump rail toggle */}
          <button
            onClick={() => setShowJumpRail((v) => !v)}
            title="Toggle jump rail"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 10px',
              borderRadius: 6,
              border: `1px solid ${showJumpRail ? 'rgba(34, 197, 94, 0.3)' : 'var(--sam-color-border-default)'}`,
              background: showJumpRail ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
              color: showJumpRail ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <MapIcon size={13} />
            Rail
          </button>

          {/* Timeline toggle */}
          <button
            onClick={() => setDrawerOpen((v) => !v)}
            title="Toggle timeline"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 10px',
              borderRadius: 6,
              border: `1px solid ${drawerOpen ? 'rgba(34, 197, 94, 0.3)' : 'var(--sam-color-border-default)'}`,
              background: drawerOpen ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
              color: drawerOpen ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <PanelRightOpen size={13} />
            Timeline
          </button>
        </div>
      </div>

      {/* ---- Main content area ---- */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* Jump rail (left of chat) */}
        {showJumpRail && !isMobile && (
          <JumpRail timeline={timeline} onJump={handleJump} />
        )}

        {/* Chat area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {/* Mobile: jump rail as horizontal strip */}
          {showJumpRail && isMobile && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '6px 12px',
                overflowX: 'auto',
                borderBottom: '1px solid var(--sam-color-border-default, #29423b)',
                flexShrink: 0,
              }}
            >
              {timeline
                .filter(
                  (e) =>
                    (e.kind === 'message' && e.data.role === 'user') ||
                    e.kind === 'notification',
                )
                .map((entry, i) => {
                  if (entry.kind === 'notification') {
                    const s = NOTIFICATION_STYLES[entry.data.type];
                    return (
                      <div
                        key={`mjr-${i}`}
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 2,
                          backgroundColor: s.color,
                          opacity: 0.7,
                          flexShrink: 0,
                        }}
                      />
                    );
                  }
                  return (
                    <button
                      key={`mjr-${i}`}
                      onClick={() => entry.kind === 'message' && handleJump(entry.data.id)}
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        backgroundColor:
                          entry.kind === 'message' && entry.data.isUnloaded
                            ? 'rgba(159, 183, 174, 0.2)'
                            : 'rgba(34, 197, 94, 0.5)',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
            </div>
          )}

          <ChatArea messages={allMessages} highlightedId={highlightedId} />
        </div>

        {/* Desktop drawer (right side) */}
        {drawerOpen && !isMobile && (
          <div
            style={{
              width: 320,
              borderLeft: '1px solid var(--sam-color-border-default, #29423b)',
              background: 'var(--sam-color-bg-surface, #13201d)',
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <TimelinePanel
              timeline={timeline}
              showAgentSnippets={showAgentSnippets}
              onToggleSnippets={() => setShowAgentSnippets((v) => !v)}
              onJump={handleJump}
            />
          </div>
        )}
      </div>

      {/* Mobile bottom sheet */}
      {isMobile && (
        <BottomSheet open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <TimelinePanel
            timeline={timeline}
            showAgentSnippets={showAgentSnippets}
            onToggleSnippets={() => setShowAgentSnippets((v) => !v)}
            onJump={(id) => {
              handleJump(id);
              setDrawerOpen(false);
            }}
          />
        </BottomSheet>
      )}
    </div>
  );
}
