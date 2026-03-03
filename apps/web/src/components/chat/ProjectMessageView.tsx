import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { VoiceButton } from '@simple-agent-manager/acp-client';
import { getChatSession, getTranscribeApiUrl, resetIdleTimer, sendFollowUpPrompt } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionResponse, ChatSessionDetailResponse } from '../../lib/api';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import {
  FileText,
  FileEdit,
  Pencil,
  Terminal,
  Search,
  Wrench,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { RenderedMarkdown } from '../MarkdownRenderer';
import type { LucideIcon } from 'lucide-react';

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

// ---------------------------------------------------------------------------
// Tool kind → friendly label + icon mapping
// ---------------------------------------------------------------------------
interface ToolKindInfo {
  label: string;
  Icon: LucideIcon;
}

const TOOL_KINDS: Record<string, ToolKindInfo> = {
  write: { label: 'Write file', Icon: FileEdit },
  read: { label: 'Read file', Icon: FileText },
  edit: { label: 'Edit file', Icon: Pencil },
  bash: { label: 'Run command', Icon: Terminal },
  glob: { label: 'Search files', Icon: Search },
  grep: { label: 'Search content', Icon: Search },
};

const DEFAULT_TOOL_KIND: ToolKindInfo = { label: 'Tool', Icon: Wrench };

function getToolKind(meta: Record<string, unknown> | null): ToolKindInfo {
  if (!meta || typeof meta.kind !== 'string') return DEFAULT_TOOL_KIND;
  return TOOL_KINDS[meta.kind] ?? DEFAULT_TOOL_KIND;
}

function getToolPath(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const locations = meta.locations as Array<{ path?: string }> | undefined;
  if (!locations?.length) return null;
  const p = locations[0]?.path;
  return p ?? null;
}

/** True for placeholder content that adds no user value. */
function isPlaceholderContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '(tool call)' || trimmed === '(tool update)';
}

// ---------------------------------------------------------------------------
// Message grouping — merges consecutive same-role messages for clean display
// ---------------------------------------------------------------------------

interface MessageGroup {
  id: string;          // ID of first message in group
  role: string;
  messages: ChatMessageResponse[];
  createdAt: number;   // Timestamp of first message
}

/** Groups consecutive messages by role. Assistant chunks become one bubble,
 *  consecutive tool messages become one activity block. */
export function groupMessages(msgs: ChatMessageResponse[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const msg of msgs) {
    const last = groups[groups.length - 1];
    // Merge into existing group if same role and both are groupable roles
    if (last && last.role === msg.role && (msg.role === 'assistant' || msg.role === 'tool')) {
      last.messages.push(msg);
    } else {
      groups.push({
        id: msg.id,
        role: msg.role,
        messages: [msg],
        createdAt: msg.createdAt,
      });
    }
  }
  return groups;
}

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

// ---------------------------------------------------------------------------
// Message bubble components
// ---------------------------------------------------------------------------

/** Standard bubble for user/system messages (one message = one bubble). */
function MessageBubble({ message }: { message: ChatMessageResponse }) {
  const style = roleStyles[message.role] || roleStyles.system!;

  return (
    <div
      className="p-3 px-4 rounded-md"
      style={{
        backgroundColor: style.bg,
        borderLeft: `3px solid ${style.color}`,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: style.color }}
        >
          {style.label}
        </span>
        <span className="sam-type-caption text-fg-muted">
          {formatTimestamp(message.createdAt)}
        </span>
      </div>
      <RenderedMarkdown content={message.content} inline />
    </div>
  );
}

/** Merged assistant bubble — concatenates streaming chunks into one message. */
function AssistantBubble({ group }: { group: MessageGroup }) {
  const style = roleStyles.assistant!;
  const content = group.messages.map((m) => m.content).join('');

  if (!content.trim()) return null;

  return (
    <div
      className="p-3 px-4 rounded-md"
      style={{
        backgroundColor: style.bg,
        borderLeft: `3px solid ${style.color}`,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: style.color }}
        >
          {style.label}
        </span>
        <span className="sam-type-caption text-fg-muted">
          {formatTimestamp(group.createdAt)}
        </span>
      </div>
      <RenderedMarkdown content={content} inline />
    </div>
  );
}

/** Compact tool activity block — groups consecutive tool calls into a summary. */
function ToolActivityBlock({ group }: { group: MessageGroup }) {
  const [expanded, setExpanded] = useState(false);

  // Build summary lines from tool messages
  const toolLines = group.messages.map((msg) => {
    const kind = getToolKind(msg.toolMetadata as Record<string, unknown> | null);
    const path = getToolPath(msg.toolMetadata as Record<string, unknown> | null);
    const hasContent = !isPlaceholderContent(msg.content);
    return { kind, path, content: hasContent ? msg.content : null, id: msg.id };
  });

  // Deduplicate: consecutive same-kind + same-path entries collapse into one
  const deduped: typeof toolLines = [];
  for (const line of toolLines) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.kind.label === line.kind.label && prev.path === line.path && !line.content) {
      continue; // Skip duplicate status update for same tool+path
    }
    deduped.push(line);
  }

  // Count how many have meaningful content for the expand toggle
  const contentLines = deduped.filter((l) => l.content);

  return (
    <div
      className="rounded-md border border-border-default overflow-hidden"
      style={{ backgroundColor: 'var(--sam-color-bg-inset)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-transparent border-none cursor-pointer text-left"
      >
        {expanded
          ? <ChevronDown size={14} className="text-fg-muted shrink-0" />
          : <ChevronRight size={14} className="text-fg-muted shrink-0" />
        }
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">
          Activity
        </span>
        <span className="text-xs text-fg-muted">
          {deduped.length} {deduped.length === 1 ? 'action' : 'actions'}
        </span>
      </button>

      {/* Collapsed: show compact summary of tool actions */}
      {!expanded && (
        <div className="px-3 pb-2 flex flex-wrap gap-x-3 gap-y-1">
          {deduped.map((line) => (
            <span key={line.id} className="inline-flex items-center gap-1 text-xs text-fg-muted">
              <line.kind.Icon size={12} />
              <span>{line.kind.label}</span>
              {line.path && (
                <span className="font-mono opacity-70">
                  {line.path.split('/').pop()}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Expanded: show full details */}
      {expanded && (
        <div className="border-t border-border-default">
          {deduped.map((line) => (
            <div
              key={line.id}
              className="flex items-start gap-2 px-3 py-1.5 border-b border-border-default last:border-b-0"
            >
              <line.kind.Icon size={14} className="text-fg-muted shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-fg-secondary">
                    {line.kind.label}
                  </span>
                  {line.path && (
                    <span className="text-xs font-mono text-fg-muted truncate">
                      {line.path}
                    </span>
                  )}
                </div>
                {line.content && (
                  <pre className="text-xs text-fg-muted mt-1 whitespace-pre-wrap break-words max-h-[200px] overflow-auto">
                    {line.content}
                  </pre>
                )}
              </div>
            </div>
          ))}
          {contentLines.length === 0 && (
            <div className="px-3 py-2 text-xs text-fg-muted">
              No detailed output available.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a message group — dispatches to the right component by role. */
function MessageGroupView({ group }: { group: MessageGroup }) {
  if (group.role === 'assistant') {
    return <AssistantBubble group={group} />;
  }
  if (group.role === 'tool') {
    return <ToolActivityBlock group={group} />;
  }
  // user / system — render each message individually (usually just one)
  return (
    <>
      {group.messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </>
  );
}

/** Renders all messages with grouping applied. */
function GroupedMessages({ messages }: { messages: ChatMessageResponse[] }) {
  const groups = useMemo(() => groupMessages(messages), [messages]);
  return (
    <div className="grid gap-3">
      {groups.map((group) => (
        <MessageGroupView key={group.id} group={group} />
      ))}
    </div>
  );
}

type SessionState = 'active' | 'idle' | 'terminated';

interface ExtendedSession extends ChatSessionResponse {
  agentCompletedAt?: number | null;
  isIdle?: boolean;
  cleanupAt?: number | null;
  task?: { id: string; status?: string; executionStep?: string | null; errorMessage?: string | null; outputBranch?: string | null; outputPrUrl?: string | null; outputSummary?: string | null; finalizedAt?: string | null };
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
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);

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

  // Prompt pending state — shows "Agent is working..." indicator
  const [promptPending, setPromptPending] = useState(false);
  const promptPendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Idle timer state (TDF-8)
  const [idleCountdownMs, setIdleCountdownMs] = useState<number | null>(null);

  const sessionState = session ? deriveSessionState(session) : 'terminated';
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // WebSocket with reconnection (TDF-8)
  const { connectionState, wsRef, retry: retryWs } = useChatWebSocket({
    projectId,
    sessionId,
    enabled: session?.status === 'active',
    onMessage: useCallback((msg: ChatMessageResponse) => {
      // Clear "Agent is working..." indicator when agent responds
      if (msg.role === 'assistant' || msg.role === 'tool') {
        setPromptPending(false);
        if (promptPendingTimeoutRef.current) {
          clearTimeout(promptPendingTimeoutRef.current);
          promptPendingTimeoutRef.current = null;
        }
      }

      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        // Replace optimistic message if this is a server-confirmed user message with matching content
        if (msg.role === 'user') {
          const optimisticIdx = prev.findIndex(
            (m) => m.id.startsWith('optimistic-') && m.role === 'user' && m.content === msg.content
          );
          if (optimisticIdx !== -1) {
            const updated = [...prev];
            updated[optimisticIdx] = msg;
            return updated;
          }
        }
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
    onAgentCompleted: useCallback((agentCompletedAt: number) => {
      setSession((prev) => prev ? { ...prev, agentCompletedAt, isIdle: true } as ChatSessionResponse : prev);
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

  // Auto-scroll to bottom on initial load, session switch, and new messages.
  // Skip when older messages were prepended via "Load earlier messages".
  const prevMessageCountRef = useRef(0);
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (loading) return;

    // Skip auto-scroll when messages were prepended via "load more"
    if (isLoadingMoreRef.current) {
      prevMessageCountRef.current = messages.length;
      return;
    }

    const isNewSession = prevSessionIdRef.current !== sessionId;
    const hasNewMessages = messages.length > prevMessageCountRef.current;
    const isInitialLoad = prevMessageCountRef.current === 0 && messages.length > 0;

    if (isNewSession || hasNewMessages || isInitialLoad) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: isNewSession ? 'instant' : 'smooth' });
      });
    }

    prevMessageCountRef.current = messages.length;
    prevSessionIdRef.current = sessionId;
  }, [messages.length, loading, sessionId]);

  // Polling fallback — keeps running alongside WebSocket for reliability.
  // Only updates state when the server has new data (fingerprint-based).
  useEffect(() => {
    if (!session || session.status !== 'active') return;

    const ACTIVE_POLL_MS = 3000;
    let lastPollFingerprint = '';
    const pollInterval = setInterval(async () => {
      try {
        const data: ChatSessionDetailResponse & { session: ExtendedSession } = await getChatSession(projectId, sessionId);
        const newLastId = data.messages[data.messages.length - 1]?.id ?? '';
        const taskStatus = data.session.task?.status ?? '';
        const fingerprint = `${data.messages.length}:${newLastId}:${data.session.status}:${data.hasMore}:${taskStatus}`;
        if (fingerprint !== lastPollFingerprint) {
          lastPollFingerprint = fingerprint;
          setSession(data.session);
          setHasMore(data.hasMore);
          setMessages(data.messages);
          if (data.session.task) {
            setTaskEmbed(data.session.task);
          }
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

      // Optimistic add — use a prefixed ID so we can replace it with the server-confirmed message
      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      setMessages((prev) => [...prev, {
        id: optimisticId,
        sessionId,
        role: 'user',
        content: trimmed,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);

      // Try sending via WebSocket (persists message in ProjectData DO)
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

      // Forward the prompt to the running agent via API
      setPromptPending(true);
      // Safety timeout — clear indicator after 30s even if no response
      promptPendingTimeoutRef.current = setTimeout(() => {
        setPromptPending(false);
        promptPendingTimeoutRef.current = null;
      }, 30_000);

      sendFollowUpPrompt(projectId, sessionId, trimmed).catch((err) => {
        console.warn('[ProjectMessageView] Follow-up prompt forwarding failed:', err);
        setPromptPending(false);
        if (promptPendingTimeoutRef.current) {
          clearTimeout(promptPendingTimeoutRef.current);
          promptPendingTimeoutRef.current = null;
        }
      });

      setFollowUp('');
    } finally {
      setSendingFollowUp(false);
    }
  };

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    const firstMessage = messages[0];
    if (!firstMessage) return;

    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;

    isLoadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, {
        before: firstMessage.createdAt,
      });
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);

      // Restore scroll position after prepending older messages.
      // The new content increases scrollHeight; offset scrollTop to keep
      // the same messages visible.
      requestAnimationFrame(() => {
        if (container) {
          const newScrollHeight = container.scrollHeight;
          container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
        }
        isLoadingMoreRef.current = false;
      });
    } catch {
      isLoadingMoreRef.current = false;
    } finally {
      setLoadingMore(false);
    }
  };

  // Initial load — only show full spinner when no data exists yet
  if (loading && messages.length === 0 && !session) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="p-4 text-danger text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Inline error when session already loaded */}
      {error && session && (
        <div className="px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs">
          {error}
        </div>
      )}

      {/* Connection indicator (TDF-8) */}
      {sessionState === 'active' && connectionState !== 'connected' && (
        <ConnectionBanner state={connectionState} onRetry={retryWs} />
      )}

      {/* Session header with branch/PR info */}
      {session && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border-default flex-wrap shrink-0">
          <span className="text-base font-semibold text-fg-primary">
            {session.topic || `Chat ${session.id.slice(0, 8)}`}
          </span>

          {/* State indicator */}
          <span
            className="inline-flex items-center gap-1 text-xs font-medium"
            style={{
              color: sessionState === 'active' ? 'var(--sam-color-success)'
                : sessionState === 'idle' ? 'var(--sam-color-warning, #f59e0b)'
                : 'var(--sam-color-fg-muted)',
            }}
          >
            <span className="w-[6px] h-[6px] rounded-full bg-current" />
            {sessionState === 'active' ? 'Active' : sessionState === 'idle' ? 'Idle' : 'Stopped'}
          </span>

          {/* Background refresh indicator — inline in header */}
          {loading && (
            <span role="status" aria-label="Refreshing messages" className="inline-flex items-center">
              <Spinner size="sm" />
            </span>
          )}

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

          {/* Branch name (T021) */}
          {taskEmbed?.outputBranch && (
            <span className="sam-type-caption text-fg-muted font-mono bg-inset px-[6px] py-[1px] rounded-sm">
              {taskEmbed.outputBranch}
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

          {session.workspaceId && sessionState === 'active' && (
            <a
              href={`/workspaces/${session.workspaceId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto"
            >
              <Button variant="ghost" size="sm">
                Open Workspace
              </Button>
            </a>
          )}
        </div>
      )}

      {/* Task error/summary display — shown whenever task has error/summary, regardless of session state */}
      {taskEmbed?.errorMessage && (
        <div className="px-4 py-2 bg-danger-tint border-b border-border-default">
          <span className="sam-type-caption text-danger font-medium">
            Task failed:
          </span>{' '}
          <span className="sam-type-caption text-danger break-words">
            {taskEmbed.errorMessage}
          </span>
        </div>
      )}
      {taskEmbed?.outputSummary && (
        <div className="px-4 py-2 bg-success-tint border-b border-border-default">
          <span className="sam-type-caption text-success font-medium">
            Summary:
          </span>{' '}
          <span className="sam-type-caption text-fg-primary break-words">
            {taskEmbed.outputSummary}
          </span>
        </div>
      )}

      {/* Messages area */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 p-4">
        {hasMore && (
          <div className="text-center mb-3">
            <Button variant="ghost" size="sm" onClick={loadMore} loading={loadingMore}>
              Load earlier messages
            </Button>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="text-fg-muted text-sm text-center p-8">
            {sessionState === 'active' ? 'Waiting for messages...' : 'No messages in this session.'}
          </div>
        ) : (
          <GroupedMessages messages={messages} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Agent working indicator — shown after sending a follow-up prompt */}
      {promptPending && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border-default bg-surface shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Agent is working...</span>
        </div>
      )}

      {/* Input area — varies by session state */}
      {sessionState === 'active' && (
        <FollowUpInput
          value={followUp}
          onChange={setFollowUp}
          onSend={handleSendFollowUp}
          sending={sendingFollowUp}
          placeholder="Send a message..."
          transcribeApiUrl={transcribeApiUrl}
        />
      )}
      {sessionState === 'idle' && (
        <FollowUpInput
          value={followUp}
          onChange={setFollowUp}
          onSend={handleSendFollowUp}
          sending={sendingFollowUp}
          placeholder="Send a follow-up to keep the session alive..."
          transcribeApiUrl={transcribeApiUrl}
        />
      )}
      {sessionState === 'terminated' && (
        <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface text-center">
          <span className="sam-type-secondary text-fg-muted">
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
    <div
      className="flex items-center gap-2 px-4 py-1 border-b border-border-default text-xs"
      style={{
        backgroundColor: isRecoverable ? 'var(--sam-color-danger-tint)' : 'var(--sam-color-warning-tint, var(--sam-color-info-tint))',
      }}
    >
      {!isRecoverable && <Spinner size="sm" />}
      <span style={{ color: isRecoverable ? 'var(--sam-color-danger)' : 'var(--sam-color-fg-muted)' }}>
        {label}
      </span>
      {isRecoverable && (
        <button
          type="button"
          onClick={onRetry}
          className="bg-transparent border-none cursor-pointer text-xs font-medium underline p-0"
          style={{ color: 'var(--sam-color-accent-primary)' }}
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
  transcribeApiUrl,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
  transcribeApiUrl: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleTranscription = useCallback(
    (text: string) => {
      const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
      onChange(value + separator + text);
      inputRef.current?.focus();
    },
    [value, onChange],
  );

  return (
    <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface">
      <div className="flex gap-2 items-end">
        <textarea
          ref={inputRef}
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
          className="flex-1 p-2 px-3 bg-page border border-border-default rounded-md text-fg-primary text-base outline-none resize-none font-[inherit] leading-[1.5] min-h-[38px] max-h-[120px]"
        />
        <VoiceButton
          onTranscription={handleTranscription}
          disabled={sending}
          apiUrl={transcribeApiUrl}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !value.trim()}
          className="px-3 py-2 border-none rounded-md text-base font-medium"
          style={{
            backgroundColor: sending || !value.trim() ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: sending || !value.trim() ? 'var(--sam-color-fg-muted)' : 'white',
            cursor: sending || !value.trim() ? 'default' : 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
