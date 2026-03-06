import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner } from '@simple-agent-manager/ui';
import {
  VoiceButton,
  MessageBubble as AcpMessageBubble,
  ToolCallCard as AcpToolCallCard,
  ThinkingBlock as AcpThinkingBlock,
} from '@simple-agent-manager/acp-client';
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { getChatSession, getTranscribeApiUrl, resetIdleTimer } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionResponse, ChatSessionDetailResponse } from '../../lib/api';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import { useProjectAgentSession } from '../../hooks/useProjectAgentSession';

interface ProjectMessageViewProps {
  projectId: string;
  sessionId: string;
}

/** Default idle timeout in ms — matches the server-side default (NODE_WARM_TIMEOUT_MS). */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// ACP ConversationItem rendering — reuses exported acp-client components
// ---------------------------------------------------------------------------

/** Renders a single ACP ConversationItem using the shared acp-client components. */
function AcpConversationItemView({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <AcpMessageBubble text={item.text} role="user" />;
    case 'agent_message':
      return <AcpMessageBubble text={item.text} role="agent" streaming={item.streaming} />;
    case 'thinking':
      return <AcpThinkingBlock text={item.text} active={item.active} />;
    case 'tool_call':
      return <AcpToolCallCard toolCall={item} />;
    case 'plan':
      return (
        <div className="my-2 border border-border-default rounded-lg p-3 bg-surface">
          <h4 className="text-xs font-medium text-fg-muted uppercase mb-2">Plan</h4>
          <ul className="space-y-1">
            {item.entries.map((entry, idx) => (
              <li key={idx} className="flex items-center space-x-2 text-sm">
                <span className={`inline-block h-2 w-2 rounded-full ${
                  entry.status === 'completed' ? 'bg-green-400' :
                  entry.status === 'in_progress' ? 'bg-blue-400 animate-pulse' : 'bg-gray-300'
                }`} />
                <span className={entry.status === 'completed' ? 'line-through text-fg-muted' : 'text-fg-primary'}>
                  {entry.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'system_message':
      return <SystemMessageBubble text={item.text} />;
    case 'raw_fallback':
      return null; // Skip raw fallbacks in project chat — typically protocol noise
    default:
      return null;
  }
}

/** Converts DO-persisted ChatMessageResponse[] into ConversationItem[] for unified rendering. */
export function chatMessagesToConversationItems(msgs: ChatMessageResponse[]): ConversationItem[] {
  return msgs.reduce<ConversationItem[]>((acc, msg) => {
    if (msg.role === 'user') {
      acc.push({ kind: 'user_message', id: msg.id, text: msg.content, timestamp: msg.createdAt });
    } else if (msg.role === 'assistant') {
      // Merge consecutive assistant chunks into one item (same as groupMessages logic)
      const last = acc[acc.length - 1];
      if (last?.kind === 'agent_message') {
        (last as { text: string }).text += msg.content;
      } else {
        acc.push({ kind: 'agent_message', id: msg.id, text: msg.content, streaming: false, timestamp: msg.createdAt });
      }
    } else if (msg.role === 'tool') {
      const meta = msg.toolMetadata as Record<string, unknown> | null;
      const kind = meta && typeof meta.kind === 'string' ? meta.kind : 'tool';
      const locations = (meta?.locations as Array<{ path?: string; line?: number | null }>) ?? [];
      acc.push({
        kind: 'tool_call',
        id: msg.id,
        toolCallId: msg.id,
        title: kind,
        toolKind: kind,
        status: 'completed',
        content: isPlaceholderContent(msg.content) ? [] : [{ type: 'content', text: msg.content }],
        locations: locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null })),
        timestamp: msg.createdAt,
      });
    } else if (msg.role === 'system') {
      // System messages (task status, error logs) rendered as preformatted text
      // to prevent markdown interpretation of build log characters (#, *, URLs)
      acc.push({ kind: 'system_message', id: msg.id, text: msg.content, timestamp: msg.createdAt });
    }
    return acc;
  }, []);
}

/** Renders a system message (task status, error logs) as preformatted text.
 *  Prevents markdown interpretation of build log characters (#, *, URLs). */
function SystemMessageBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start mb-4">
      <div
        role="region"
        aria-label="System message"
        className="max-w-[90%] rounded-lg px-4 py-3 border"
        style={{
          backgroundColor: 'var(--sam-color-bg-inset)',
          borderColor: 'var(--sam-color-border-default)',
        }}
      >
        <div className="flex items-center gap-1.5 mb-2">
          <span
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--sam-color-fg-muted)' }}
          >
            System
          </span>
        </div>
        <pre
          className="text-xs whitespace-pre-wrap break-words m-0 font-mono leading-relaxed"
          style={{ color: 'var(--sam-color-fg-primary)' }}
        >
          {text}
        </pre>
      </div>
    </div>
  );
}

/** Renders ConversationItem array with the ACP-style components. */
function AcpMessages({ items }: { items: ConversationItem[] }) {
  return (
    <div className="grid gap-3">
      {items.map((item) => (
        <AcpConversationItemView key={item.id} item={item} />
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

  // ACP agent session — direct WebSocket to VM agent for prompts and cancel.
  // Active when workspace is available and session is interactive.
  const agentSession = useProjectAgentSession({
    workspaceId: session?.workspaceId ?? null,
    sessionId,
    enabled: sessionState === 'active' || sessionState === 'idle',
    preferredAgentType: 'claude-code',
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
  // Uses AbortController to cancel in-flight requests on session switch,
  // preventing cross-contamination from stale responses.
  useEffect(() => {
    if (!session || session.status !== 'active') return;

    const abortController = new AbortController();
    const ACTIVE_POLL_MS = 3000;
    let lastPollFingerprint = '';
    const pollInterval = setInterval(async () => {
      try {
        const data: ChatSessionDetailResponse & { session: ExtendedSession } = await getChatSession(
          projectId, sessionId, { signal: abortController.signal }
        );
        // Guard: skip if the server returned a different session than requested
        if (data.session.id !== sessionId) return;
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
      } catch (err) {
        // Ignore aborted requests (expected on session switch) and other poll errors
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }, ACTIVE_POLL_MS);

    return () => {
      clearInterval(pollInterval);
      abortController.abort();
    };
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

  // Send follow-up message via DO WebSocket (persistence) + ACP (agent prompt)
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
    try {
      // Reset idle timer if session is idle (T037)
      if (sessionState === 'idle') {
        resetIdleTimer(projectId, sessionId)
          .then((result) => {
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

      if (agentSession.isAgentActive) {
        // ACP path: prompt goes to agent via WebSocket; VM agent's MessageReporter
        // handles persistence to the DO, so we do NOT also send via DO WebSocket
        // (that would create a duplicate with a different messageId).
        agentSession.sendPrompt(trimmed);
      } else {
        // Fallback: persist via DO WebSocket so the message is at least saved,
        // even though the agent won't receive it.
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'message.send',
            sessionId,
            content: trimmed,
            role: 'user',
          }));
        }
        setError('Agent is not connected — message saved but prompt not delivered.');
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

      {/* ACP agent disconnect warning — shown when DO WebSocket is fine but agent is unreachable */}
      {sessionState === 'active' && connectionState === 'connected' && session?.workspaceId &&
        !agentSession.isAgentActive && !agentSession.isConnecting && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-warning-tint text-warning text-xs">
          <span>Agent offline — messages will be saved but not processed until the agent reconnects.</span>
        </div>
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

      {/* Messages area — merged DO (persistent) + ACP (streaming/unpersisted) */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 p-4">
        {(() => {
          const acpItems = agentSession.messages.items;
          const convertedItems = chatMessagesToConversationItems(messages);

          // Merge strategy: DO messages are the persistent base. ACP items
          // that are newer than the latest DO message are appended. This
          // handles two cases:
          // 1. During/after prompting, agent responses not yet persisted to DO
          // 2. ACP-created sessions where MessageReporter isn't configured
          //
          // When DO has no messages yet (initial provisioning), show ACP only.
          if (convertedItems.length === 0 && acpItems.length > 0) {
            return <AcpMessages items={acpItems} />;
          }

          // Find ACP items newer than the latest DO message timestamp
          const latestDoTimestamp = convertedItems.length > 0
            ? Math.max(...convertedItems.map((item) => item.timestamp || 0))
            : 0;

          // Collect ACP-only items: items with timestamps after the latest DO
          // message, excluding user messages (which are already in DO via
          // optimistic add or DO WebSocket persistence).
          const acpOnlyItems = latestDoTimestamp > 0
            ? acpItems.filter((item) =>
                item.timestamp > latestDoTimestamp && item.kind !== 'user_message'
              )
            : [];

          const mergedItems = acpOnlyItems.length > 0
            ? [...convertedItems, ...acpOnlyItems]
            : convertedItems;

          return (
            <>
              {hasMore && (
                <div className="text-center mb-3">
                  <Button variant="ghost" size="sm" onClick={loadMore} loading={loadingMore}>
                    Load earlier messages
                  </Button>
                </div>
              )}

              {mergedItems.length === 0 ? (
                <div className="text-fg-muted text-sm text-center p-8">
                  {sessionState === 'active' ? 'Waiting for messages...' : 'No messages in this session.'}
                </div>
              ) : (
                <AcpMessages items={mergedItems} />
              )}
            </>
          );
        })()}

        <div ref={messagesEndRef} />
      </div>

      {/* Agent working indicator — driven by ACP session state */}
      {agentSession.isPrompting && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border-default bg-surface shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Agent is working...</span>
          <button
            type="button"
            onClick={agentSession.cancelPrompt}
            className="ml-auto px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer"
            style={{ color: 'var(--sam-color-danger)' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ACP connecting indicator */}
      {agentSession.isConnecting && session?.workspaceId && (
        <div className="flex items-center gap-2 px-4 py-1 border-t border-border-default bg-surface shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Connecting to agent...</span>
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
