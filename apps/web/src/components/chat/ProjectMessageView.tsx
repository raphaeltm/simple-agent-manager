import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Spinner } from '@simple-agent-manager/ui';
import {
  VoiceButton,
  MessageBubble as AcpMessageBubble,
  ToolCallCard as AcpToolCallCard,
  ThinkingBlock as AcpThinkingBlock,
  PlanView,
  RawFallbackView,
} from '@simple-agent-manager/acp-client';
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { mapToolCallContent, getErrorMeta } from '@simple-agent-manager/acp-client';
import type { AcpSessionHandle } from '@simple-agent-manager/acp-client';
import { ChevronDown, ChevronUp, Server, Box, Cpu, MapPin, Cloud, GitBranch, CheckCircle2 } from 'lucide-react';
import { TruncatedSummary } from './TruncatedSummary';
import { stripMarkdown } from '../../lib/text-utils';
import { getChatSession, getTranscribeApiUrl, getTtsApiUrl, resetIdleTimer, getWorkspace, getNode, updateProjectTaskStatus, deleteWorkspace } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionResponse, ChatSessionDetailResponse } from '../../lib/api';
import type { WorkspaceResponse, NodeResponse, VMSize } from '@simple-agent-manager/shared';
import { VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import { useProjectAgentSession } from '../../hooks/useProjectAgentSession';

interface ProjectMessageViewProps {
  projectId: string;
  sessionId: string;
  /** When true, workspace is still provisioning — suppress "agent offline" banner. */
  isProvisioning?: boolean;
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
    if (last && last.role === msg.role && (msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'thinking')) {
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

/** Lazily computed TTS API URL — avoids module-scope errors in test environments. */
let _cachedTtsApiUrl: string | undefined;
function getTtsUrl(): string {
  if (!_cachedTtsApiUrl) _cachedTtsApiUrl = getTtsApiUrl();
  return _cachedTtsApiUrl;
}

/** Renders a single ACP ConversationItem using the shared acp-client components. */
function AcpConversationItemView({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <AcpMessageBubble text={item.text} role="user" />;
    case 'agent_message':
      return <AcpMessageBubble text={item.text} role="agent" streaming={item.streaming} timestamp={item.timestamp} ttsApiUrl={getTtsUrl()} ttsStorageId={item.id} />;
    case 'thinking':
      return <AcpThinkingBlock text={item.text} active={item.active} />;
    case 'tool_call':
      return <AcpToolCallCard toolCall={item} />;
    case 'plan':
      return <PlanView plan={item} />;
    case 'system_message':
      return <SystemMessageBubble text={item.text} />;
    case 'raw_fallback':
      return <RawFallbackView item={item} />;
    default:
      return null;
  }
}

/** Converts DO-persisted ChatMessageResponse[] into ConversationItem[] for unified rendering. */
export function chatMessagesToConversationItems(msgs: ChatMessageResponse[]): ConversationItem[] {
  // Deduplicate by message ID — the same message can arrive through multiple
  // channels (initial REST load, WebSocket onMessage, onCatchUp, polling).
  const seenIds = new Set<string>();
  const dedupedMsgs = msgs.filter((msg) => {
    if (seenIds.has(msg.id)) return false;
    seenIds.add(msg.id);
    return true;
  });

  // First pass: build items, tracking tool calls by toolCallId for deduplication
  const toolCallMap = new Map<string, number>(); // toolCallId → index in acc
  const items = dedupedMsgs.reduce<ConversationItem[]>((acc, msg) => {
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
    } else if (msg.role === 'thinking') {
      // Merge consecutive thinking chunks (same pattern as assistant messages)
      const last = acc[acc.length - 1];
      if (last?.kind === 'thinking') {
        (last as { text: string }).text += msg.content;
      } else {
        acc.push({ kind: 'thinking', id: msg.id, text: msg.content, active: false, timestamp: msg.createdAt });
      }
    } else if (msg.role === 'plan') {
      // Parse plan entries from JSON content
      let entries: Array<{ content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }> = [];
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          entries = parsed.map((e: Record<string, unknown>) => ({
            content: typeof e.content === 'string' ? e.content : '',
            priority: (['high', 'medium', 'low'].includes(e.priority as string) ? e.priority : 'medium') as 'high' | 'medium' | 'low',
            status: (['pending', 'in_progress', 'completed'].includes(e.status as string) ? e.status : 'pending') as 'pending' | 'in_progress' | 'completed',
          }));
        }
      } catch {
        // Invalid JSON — skip this plan message
      }
      if (entries.length > 0) {
        // Plans are replaced wholesale — find existing plan and update it
        const existingIdx = acc.findIndex((i) => i.kind === 'plan');
        const planItem: ConversationItem = {
          kind: 'plan',
          id: existingIdx >= 0 ? (acc[existingIdx]?.id ?? msg.id) : msg.id,
          entries,
          timestamp: msg.createdAt,
        };
        if (existingIdx >= 0) {
          acc[existingIdx] = planItem;
        } else {
          acc.push(planItem);
        }
      }
    } else if (msg.role === 'tool') {
      const meta = msg.toolMetadata as Record<string, unknown> | null;
      const toolCallId = meta && typeof meta.toolCallId === 'string' ? meta.toolCallId : '';
      const kind = meta && typeof meta.kind === 'string' ? meta.kind : 'tool';
      // Build a meaningful title: prefer the explicit title from metadata,
      // then humanize the kind (e.g. "read" → "Read"), and only fall back
      // to the generic "Tool Call" if kind is also just "tool".
      const rawTitle = meta && typeof meta.title === 'string' && meta.title ? meta.title : '';
      const title = rawTitle || (kind && kind !== 'tool'
        ? kind.charAt(0).toUpperCase() + kind.slice(1)
        : 'Tool Call');
      const locations = (meta?.locations as Array<{ path?: string; line?: number | null }>) ?? [];
      const validStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
      const rawStatus = meta && typeof meta.status === 'string' ? meta.status : '';
      const status = (validStatuses.has(rawStatus)
        ? rawStatus
        : 'completed') as 'pending' | 'in_progress' | 'completed' | 'failed';

      // Use structured content from metadata when available; fall back to raw content field.
      // Content items are now stored as raw ACP JSON (same shape as real-time WebSocket),
      // so we pass them through mapToolCallContent — the same function the real-time path uses.
      const structuredContent = meta?.content as Array<{ type: string } & Record<string, unknown>> | undefined;
      let contentItems: Array<{ type: 'content' | 'diff' | 'terminal'; text?: string; data?: unknown }>;
      if (Array.isArray(structuredContent) && structuredContent.length > 0) {
        contentItems = structuredContent.map((c) => mapToolCallContent(c));
      } else {
        contentItems = isPlaceholderContent(msg.content) ? [] : [{ type: 'content' as const, text: msg.content }];
      }

      // Deduplicate tool calls by toolCallId: merge updates into existing tool call
      if (toolCallId && toolCallMap.has(toolCallId)) {
        const existingIdx = toolCallMap.get(toolCallId)!;
        const existing = acc[existingIdx] as { status: string; title: string; content: unknown[]; locations: unknown[]; toolKind?: string };
        // Update with latest status, title, content, and locations
        if (rawStatus) existing.status = status;
        if (title !== kind) existing.title = title;
        if (contentItems.length > 0) existing.content = contentItems;
        if (locations.length > 0) existing.locations = locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null }));
        if (kind !== 'tool') existing.toolKind = kind;
      } else {
        const idx = acc.length;
        acc.push({
          kind: 'tool_call',
          id: msg.id,
          toolCallId: toolCallId || msg.id,
          title,
          toolKind: kind !== 'tool' ? kind : undefined,
          status,
          content: contentItems,
          locations: locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null })),
          timestamp: msg.createdAt,
        });
        if (toolCallId) {
          toolCallMap.set(toolCallId, idx);
        }
      }
    } else if (msg.role === 'system') {
      // System messages (task status, error logs) rendered as preformatted text
      // to prevent markdown interpretation of build log characters (#, *, URLs)
      acc.push({ kind: 'system_message', id: msg.id, text: msg.content, timestamp: msg.createdAt });
    } else {
      // Unknown roles render as raw fallback (matches workspace chat behavior)
      // to ensure no messages are silently dropped.
      acc.push({
        kind: 'raw_fallback' as const,
        id: msg.id,
        data: { role: msg.role, content: msg.content, toolMetadata: msg.toolMetadata },
        timestamp: msg.createdAt,
      });
    }
    return acc;
  }, []);

  return items;
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

function deriveSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  if (session.isIdle || session.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
  isProvisioning = false,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);

  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<ChatSessionResponse['task'] | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workspace & node context for session header
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [node, setNode] = useState<NodeResponse | null>(null);

  // Follow-up input state
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);

  // Grace period: keep showing ACP view after prompting ends so DO can catch up
  // (VM agent batches messages with ~2s delay before persisting to DO)
  const [acpGrace, setAcpGrace] = useState(false);
  const acpGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPromptingRef = useRef(false);

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
  //
  // CRITICAL: We MUST use the agent session ID (ULID from D1) — never fall
  // back to the chat session ID.  If the agent session ID is not yet available
  // (TaskRunner hasn't created it yet, or D1 query hasn't returned it), we
  // keep the ACP connection disabled.  Falling back to the chat session ID
  // causes the VM agent to create a SECOND ACP session (because the chat
  // session ID doesn't match the agent session ID that TaskRunner created),
  // which splits the conversation across two tabs and loses context.
  const agentSessionId = session?.agentSessionId ?? null;
  const agentSession = useProjectAgentSession({
    workspaceId: session?.workspaceId ?? null,
    sessionId: agentSessionId ?? sessionId, // Hook needs a string; disabled when null
    enabled: (sessionState === 'active' || sessionState === 'idle') && agentSessionId !== null,
    // Don't hardcode a preferred agent — let the task runner's agent selection
    // stand. Hardcoding 'claude-code' caused the browser to auto-select claude-code
    // and kill task-driven agents like mistral-vibe on first connect.
    preferredAgentType: undefined,
  });

  // Reset grace state when switching sessions
  useEffect(() => {
    setAcpGrace(false);
    wasPromptingRef.current = false;
    if (acpGraceTimerRef.current) {
      clearTimeout(acpGraceTimerRef.current);
      acpGraceTimerRef.current = null;
    }
  }, [sessionId]);

  // Track isPrompting transitions to manage ACP→DO handoff grace period
  useEffect(() => {
    const { isPrompting } = agentSession;
    if (isPrompting) {
      // Starting to prompt — clear any pending grace timer
      wasPromptingRef.current = true;
      if (acpGraceTimerRef.current) {
        clearTimeout(acpGraceTimerRef.current);
        acpGraceTimerRef.current = null;
      }
      setAcpGrace(false);
    } else if (wasPromptingRef.current) {
      // Just stopped prompting — start grace period for DO to catch up
      wasPromptingRef.current = false;
      setAcpGrace(true);
      acpGraceTimerRef.current = setTimeout(() => {
        setAcpGrace(false);
        acpGraceTimerRef.current = null;
      }, 10_000);
    }
    return () => {
      if (acpGraceTimerRef.current) {
        clearTimeout(acpGraceTimerRef.current);
        acpGraceTimerRef.current = null;
      }
    };
  }, [agentSession.isPrompting]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data: ChatSessionDetailResponse = await getChatSession(projectId, sessionId);
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

  // Fetch workspace and node details for the session header context dropdown.
  // Fires once when the session's workspaceId first becomes available.
  useEffect(() => {
    const wsId = session?.workspaceId;
    if (!wsId) return;
    // Skip if already fetched for this workspace
    if (workspace?.id === wsId) return;

    let cancelled = false;
    (async () => {
      try {
        const ws = await getWorkspace(wsId);
        if (cancelled) return;
        setWorkspace(ws);
        if (ws.nodeId) {
          const nd = await getNode(ws.nodeId);
          if (!cancelled) setNode(nd);
        }
      } catch {
        // Best-effort — context info is supplementary
      }
    })();
    return () => { cancelled = true; };
  }, [session?.workspaceId, workspace?.id]);

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
        const data: ChatSessionDetailResponse = await getChatSession(
          projectId, sessionId, { signal: abortController.signal }
        );
        // Guard: skip if the server returned a different session than requested
        if (data.session.id !== sessionId) return;
        const newLastId = data.messages[data.messages.length - 1]?.id ?? '';
        const taskStatus = data.session.task?.status ?? '';
        const agentSessId = data.session.agentSessionId ?? '';
        const fingerprint = `${data.messages.length}:${newLastId}:${data.session.status}:${data.hasMore}:${taskStatus}:${agentSessId}`;
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
  const cleanupAt = session?.cleanupAt ?? null;
  const agentCompletedAt = session?.agentCompletedAt ?? null;

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

      // Always persist user message via DO WebSocket so it survives
      // workspace teardown. The DO deduplicates by content+role if needed.
      // Note: if the DO WebSocket is closed, persistence is best-effort —
      // the message will still reach the agent via ACP but won't appear
      // in chat history after workspace termination.
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'message.send',
          sessionId,
          content: trimmed,
          role: 'user',
        }));
      }

      if (agentSession.isAgentActive) {
        // Also send via ACP so the agent processes the prompt
        agentSession.sendPrompt(trimmed);
      } else {
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

      {/* ACP agent error / disconnect warning — shown when DO WebSocket is fine but agent is unreachable.
          Suppressed during provisioning since the agent was never online yet. */}
      {sessionState === 'active' && connectionState === 'connected' && session?.workspaceId &&
        !agentSession.isAgentActive && !agentSession.isConnecting && !isProvisioning && (
        <AgentErrorBanner session={agentSession.session} />
      )}

      {/* Session header — compact by default, expandable for details */}
      {session && (
        <SessionHeader
          projectId={projectId}
          session={session}
          sessionState={sessionState}
          loading={loading}
          idleCountdownMs={idleCountdownMs}
          taskEmbed={taskEmbed}
          workspace={workspace}
          node={node}
        />
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
        <TruncatedSummary summary={taskEmbed.outputSummary} />
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
          // During active prompting or the grace period after prompting ends
          // (gives DO time to receive batched messages from VM agent ~2s delay),
          // show the full ACP view since it has the most up-to-date content.
          // When DO has no messages yet (initial provisioning), show ACP only.
          const useFullAcpView = acpItems.length > 0 && (
            convertedItems.length === 0 || agentSession.isPrompting || acpGrace
          );

          if (useFullAcpView) {
            return <AcpMessages items={acpItems} />;
          }

          // Find ACP items newer than the latest DO message timestamp
          const latestDoTimestamp = convertedItems.length > 0
            ? Math.max(...convertedItems.map((item) => item.timestamp || 0))
            : 0;

          // Collect ACP-only items: items with timestamps after the latest DO
          // message. Includes agent responses not yet persisted to DO.
          // Also deduplicate by ID to prevent overlap when ACP and DO timestamps
          // are identical (same message persisted to DO while ACP still holds it).
          const doIds = new Set(convertedItems.map((item) => item.id));
          const acpOnlyItems = latestDoTimestamp > 0
            ? acpItems.filter((item) => item.timestamp > latestDoTimestamp && !doIds.has(item.id))
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

/** Labeled value pill used in the session context panel. */
function ContextItem({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-muted min-w-0">
      <span className="shrink-0 opacity-60" aria-hidden="true">{icon}</span>
      <span className="font-medium shrink-0">{label}:</span>
      <span className="text-fg-primary truncate min-w-0">{children}</span>
    </div>
  );
}

/** Human-readable VM size label from shared constants. */
function formatVmSize(size: string): string {
  const config = VM_SIZE_LABELS[size as VMSize];
  return config ? config.label : size;
}

/** Collapsible session header — shows title + state dot, with expandable details. */
function SessionHeader({
  projectId,
  session,
  sessionState,
  loading,
  idleCountdownMs,
  taskEmbed,
  workspace,
  node,
}: {
  projectId: string;
  session: ChatSessionResponse;
  sessionState: SessionState;
  loading: boolean;
  idleCountdownMs: number | null;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const hasDetails = !!(
    taskEmbed?.outputBranch ||
    taskEmbed?.outputPrUrl ||
    session.workspaceId ||
    (sessionState === 'idle' && idleCountdownMs !== null)
  );

  const canMarkComplete = !!(
    taskEmbed?.id &&
    taskEmbed.status !== 'completed' &&
    taskEmbed.status !== 'cancelled' &&
    taskEmbed.status !== 'failed'
  );

  const handleMarkComplete = useCallback(async () => {
    if (!taskEmbed?.id || completing) return;
    setCompleteError(null);
    setCompleting(true);
    setConfirmOpen(false);
    try {
      // 1. Mark the task as completed (this also stops the chat session server-side)
      await updateProjectTaskStatus(projectId, taskEmbed.id, { toStatus: 'completed' });

      // 2. Delete the workspace if one exists
      if (session.workspaceId) {
        await deleteWorkspace(session.workspaceId);
      }

      // Force a page reload to reflect the new state
      window.location.reload();
    } catch (err) {
      console.error('Failed to mark task complete:', err);
      setCompleteError(err instanceof Error ? err.message : 'Failed to complete task');
      setCompleting(false);
    }
  }, [projectId, taskEmbed?.id, session.workspaceId, completing]);

  return (
    <div className="border-b border-border-default shrink-0">
      {/* Compact row — always visible */}
      <div className="flex items-center gap-2 px-4 py-2 min-h-[40px]">
        <span className="text-sm font-semibold text-fg-primary truncate flex-1 min-w-0">
          {session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`}
        </span>

        {/* Workspace profile badge — null/undefined defaults to 'Full' (matches DEFAULT_WORKSPACE_PROFILE) */}
        {workspace && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
            aria-label={`Workspace profile: ${workspace.workspaceProfile === 'lightweight' ? 'Lightweight' : 'Full'}`}
            style={{
              backgroundColor: workspace.workspaceProfile === 'lightweight' ? 'var(--sam-color-info-tint)' : 'var(--sam-color-success-tint)',
              color: workspace.workspaceProfile === 'lightweight' ? 'var(--sam-color-info)' : 'var(--sam-color-success)',
            }}
          >
            {workspace.workspaceProfile === 'lightweight' ? 'Lightweight' : 'Full'}
          </span>
        )}

        {/* State indicator */}
        <span
          className="inline-flex items-center gap-1 text-xs font-medium shrink-0"
          style={{
            color: sessionState === 'active' ? 'var(--sam-color-success)'
              : sessionState === 'idle' ? 'var(--sam-color-warning, #f59e0b)'
              : 'var(--sam-color-fg-muted)',
          }}
        >
          <span className="w-[6px] h-[6px] rounded-full bg-current" />
          {sessionState === 'active' ? 'Active' : sessionState === 'idle' ? 'Idle' : 'Stopped'}
        </span>

        {/* Background refresh indicator */}
        {loading && (
          <span role="status" aria-label="Refreshing messages" className="inline-flex items-center shrink-0">
            <Spinner size="sm" />
          </span>
        )}

        {/* Expand/collapse toggle — only shown when there are details to show */}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide session details' : 'Show session details'}
            className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

      {/* Expanded details panel */}
      {expanded && hasDetails && (
        <div className="px-4 py-2 border-t border-border-default bg-inset space-y-2">
          {/* Action row — idle countdown, PR link, action buttons */}
          <div className="flex items-center gap-3 flex-wrap">
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

            <div className="ml-auto flex items-center gap-2">
              {session.workspaceId && sessionState === 'active' && (
                <a
                  href={`/workspaces/${session.workspaceId}`}
                  className="no-underline"
                >
                  <Button variant="ghost" size="sm">
                    Open Workspace
                  </Button>
                </a>
              )}

              {canMarkComplete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={completing}
                  style={{ color: completing ? undefined : 'var(--sam-color-success)' }}
                >
                  <CheckCircle2 size={14} className="mr-1" />
                  {completing ? 'Completing...' : 'Mark Complete'}
                </Button>
              )}
            </div>
          </div>

          {/* Inline error for mark-complete failures */}
          {completeError && (
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="text-xs" style={{ color: 'var(--sam-color-danger)' }}>{completeError}</span>
              <button
                type="button"
                onClick={() => setCompleteError(null)}
                className="text-xs bg-transparent border-none cursor-pointer underline"
                style={{ color: 'var(--sam-color-fg-muted)' }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Infrastructure context — workspace & node details */}
          {session.workspaceId && (workspace || node) && (
            <div className="flex flex-col gap-1.5 pt-1 border-t border-border-default">
              {workspace && (
                <>
                  <ContextItem icon={<Box size={12} />} label="Workspace">
                    <a
                      href={`/workspaces/${workspace.id}`}
                      className="no-underline hover:underline"
                      style={{ color: 'var(--sam-color-accent-primary)' }}
                    >
                      {workspace.displayName || workspace.name}
                    </a>
                    <span className="text-fg-muted ml-1">({workspace.status})</span>
                  </ContextItem>
                  <ContextItem icon={<Cpu size={12} />} label="VM Size">
                    {formatVmSize(workspace.vmSize)}
                  </ContextItem>
                </>
              )}
              {node && (
                <>
                  <ContextItem icon={<Server size={12} />} label="Node">
                    <a
                      href={`/nodes/${node.id}`}
                      className="no-underline hover:underline"
                      style={{ color: 'var(--sam-color-accent-primary)' }}
                    >
                      {node.name}
                    </a>
                    {node.healthStatus && (
                      <span
                        className="ml-1"
                        style={{
                          color: node.healthStatus === 'healthy' ? 'var(--sam-color-success)'
                            : node.healthStatus === 'stale' ? 'var(--sam-color-warning, #f59e0b)'
                            : 'var(--sam-color-danger)',
                        }}
                      >
                        ({node.healthStatus})
                      </span>
                    )}
                  </ContextItem>
                  {node.cloudProvider && (
                    <ContextItem icon={<Cloud size={12} />} label="Provider">
                      {node.cloudProvider.charAt(0).toUpperCase() + node.cloudProvider.slice(1)}
                      {workspace?.vmLocation && (
                        <span className="text-fg-muted ml-1">— {workspace.vmLocation}</span>
                      )}
                    </ContextItem>
                  )}
                </>
              )}
              {!node && workspace?.vmLocation && (
                <ContextItem icon={<MapPin size={12} />} label="Location">
                  {workspace.vmLocation}
                </ContextItem>
              )}
              {taskEmbed?.outputBranch && (
                <ContextItem icon={<GitBranch size={12} />} label="Branch">
                  <span className="font-mono text-[11px]">
                    {taskEmbed.outputBranch}
                  </span>
                </ContextItem>
              )}
            </div>
          )}
          {/* Fallback when workspace data is still loading or failed */}
          {session.workspaceId && !workspace && !node && (
            <div className="pt-1 border-t border-border-default">
              <span className="text-xs text-fg-muted">Loading infrastructure details...</span>
            </div>
          )}
        </div>
      )}

      {/* Confirmation dialog for mark-complete action */}
      <Dialog isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm">
        <h3 id="dialog-title" className="text-base font-semibold text-fg-primary mb-2">
          Mark task as complete?
        </h3>
        <p className="text-sm text-fg-muted mb-4">
          This will archive the task and delete the workspace. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleMarkComplete}>
            Complete & Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

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

/** Agent connection error / offline banner for project chat.
 *  Shows structured error details (matching workspace chat's ErrorBanner)
 *  when the ACP session is in error state, or a generic "Agent offline"
 *  message when the agent is simply unreachable. */
function AgentErrorBanner({ session }: { session: AcpSessionHandle }) {
  const isError = session.state === 'error';

  if (!isError) {
    // Not an error state — show generic offline warning
    return (
      <div role="alert" className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-warning-tint text-warning text-xs">
        <span>Agent offline — messages will be saved but not processed until the agent reconnects.</span>
      </div>
    );
  }

  // Error state — show structured error details
  const meta = session.errorCode ? getErrorMeta(session.errorCode) : null;
  const userMessage = meta?.userMessage ?? session.error ?? 'Connection lost';
  const suggestedAction = meta?.suggestedAction;
  const severity = meta?.severity ?? 'recoverable';

  const detailedError = session.error && session.error !== userMessage && session.error !== meta?.userMessage
    ? session.error
    : null;

  const isFatal = severity === 'fatal';
  const isTransient = severity === 'transient';
  const showReconnect = !isFatal && !isTransient && session.errorCode !== 'NETWORK_OFFLINE';

  return (
    <div
      role="alert"
      className={`border-b border-border-default px-4 py-1.5 text-xs text-center ${
        isTransient ? 'bg-warning-tint text-warning' : 'bg-danger-tint text-danger'
      }`}
    >
      <div className="flex items-center justify-center gap-2">
        <span className="font-medium">{userMessage}</span>
        {showReconnect && (
          <button
            type="button"
            onClick={() => session.reconnect()}
            className="px-3 py-1 min-h-[44px] bg-danger text-white text-xs rounded hover:opacity-80"
            aria-label="Reconnect to agent"
          >
            Reconnect
          </button>
        )}
      </div>
      {detailedError && (
        <p className="text-xs mt-0.5 opacity-80 truncate max-w-lg mx-auto" title={detailedError}>{detailedError}</p>
      )}
      {suggestedAction && (
        <p className="text-xs mt-0.5 opacity-70">{suggestedAction}</p>
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
            if (e.key === 'Enter' && e.shiftKey && !sending) {
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
