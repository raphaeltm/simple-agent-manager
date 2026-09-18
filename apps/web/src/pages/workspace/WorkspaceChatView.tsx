/**
 * WorkspaceChatView — DO-only chat component for the workspace page.
 *
 * All messages flow through a single source: the Durable Object WebSocket.
 * Prompts are sent via the REST API (POST /sessions/:sessionId/prompt),
 * which forwards to the VM agent. This eliminates the dual-WebSocket
 * architecture (DO + ACP) that caused React error #185 (infinite render loops).
 *
 * Agent state (idle/prompting/responding) is derived from message flow rather
 * than a direct ACP connection. The TypewriterText component animates batched
 * message delivery (~2s intervals) to maintain the perception of continuous
 * streaming.
 */
import { Spinner } from '@simple-agent-manager/ui';
import { ChevronDown } from 'lucide-react';
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import { FollowUpInput } from '../../components/project-message-view/FollowUpInput';
import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import {
  countDisplayRows,
  groupToolCallItems,
} from '../../components/project-message-view/tool-call-groups';
import {
  chatMessagesToConversationItems,
  deriveSessionState,
  VIRTUAL_START,
} from '../../components/project-message-view/types';
import { useCancelAgentPrompt } from '../../components/project-message-view/useCancelAgentPrompt';
import { useCompletionDockWorking } from '../../components/project-message-view/useCompletionDockWorking';
import { useToolCallGroupRowState } from '../../components/project-message-view/useToolCallGroupRowState';
import {
  getChatSession,
  getTranscribeApiUrl,
  resetIdleTimer,
  sendFollowUpPrompt,
  uploadSessionFiles,
} from '../../lib/api';
import type {
  ChatMessageResponse,
  ChatSessionDetailResponse,
  ChatSessionResponse,
} from '../../lib/api/sessions';
import { mergeMessages } from '../../lib/merge-messages';
import { useWorkspaceChatSocket } from './useWorkspaceChatSocket';

interface WorkspaceChatViewProps {
  projectId: string;
  sessionId: string;
}

/**
 * Memoized to prevent re-renders from the workspace page's 5s polling cycle.
 * The parent re-renders every poll, but our props (string IDs) don't change.
 */
export const WorkspaceChatView: FC<WorkspaceChatViewProps> = memo(function WorkspaceChatView({
  projectId,
  sessionId,
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // ── Core state ──
  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Follow-up ──
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [uploading, setUploading] = useState(false);

  // ── Scroll ──
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUAL_START);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const sessionState = session ? deriveSessionState(session) : 'terminated';
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  const {
    connectionState,
    wsRef,
    agentActivity,
    setAgentActivity,
    hydrateActivity,
    stopVerifyDecayTimer,
  } = useWorkspaceChatSocket({
    projectId,
    sessionId,
    sessionStatus: session?.status,
    setMessages,
    setSession,
  });

  // ── Load session data ──
  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data: ChatSessionDetailResponse = await getChatSession(projectId, sessionId);
      setSession(data.session);
      setMessages(data.messages);
      setHasMore(data.hasMore);
      hydrateActivity(data.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId, hydrateActivity]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Reset scroll on session change
  useEffect(() => {
    setFirstItemIndex(VIRTUAL_START);
    setShowScrollButton(false);
    stopVerifyDecayTimer();
  }, [sessionId, stopVerifyDecayTimer]);

  // ── Conversation items from DO messages only (single source) ──
  // Consecutive tool calls fold into one collapsed activity row, with the same
  // parent-held expansion state and the same live signal as project chat, so the
  // two surfaces cannot drift (`.claude/rules/24`).
  const conversationItems = useMemo<DisplayItem[]>(() => {
    return groupToolCallItems(chatMessagesToConversationItems(messages));
  }, [messages]);

  /*
   * Expansion lives here, not in the card: Virtuoso unmounts rows outside its
   * overscan window, so card-local state would collapse on scroll. Shared with
   * project chat so the two surfaces cannot drift again (`.claude/rules/24`);
   * see the hook's doc comment for why the working signal is
   * `useCompletionDockWorking` and not `isWorkingActivity`.
   */
  const agentIsWorking = useCompletionDockWorking(agentActivity);
  const groupRowState = useToolCallGroupRowState(conversationItems, agentIsWorking);

  // Stable identity: an inline arrow gives Virtuoso a new `itemContent` on every
  // parent render, re-rendering every windowed row and defeating
  // `AcpConversationItemView`'s memo (`.claude/rules/64`).
  const renderConversationItem = useCallback(
    (_index: number, item: DisplayItem) => (
      <div className="px-4 py-1">
        <AcpConversationItemView
          item={item}
          projectId={projectId}
          groupExpanded={
            item.kind === 'tool_call_group' ? groupRowState.groupExpandedFor(item.id) : undefined
          }
          onToggleGroup={groupRowState.onToggleGroup}
          groupLive={groupRowState.groupLiveFor(item.id)}
        />
      </div>
    ),
    [projectId, groupRowState]
  );

  // ── Cancel the current in-flight prompt ──
  // Shares one implementation with the project-chat dock so the two surfaces
  // cannot drift apart again (.claude/rules/24).
  const onCancelled = useCallback(() => setAgentActivity('idle'), [setAgentActivity]);
  const {
    cancelling,
    cancelError,
    cancelPrompt: handleCancelPrompt,
    clearCancelError,
  } = useCancelAgentPrompt({
    projectId,
    sessionId,
    enabled: agentActivity !== 'idle',
    onCancelled,
  });

  // ── Send follow-up message via REST API ──
  const handleSendFollowUp = useCallback(async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
    setAgentActivity('prompting');
    // A new turn supersedes any failed interrupt of the previous one; leaving the
    // old banner up would attach it to work it has nothing to do with.
    clearCancelError();
    try {
      if (sessionState === 'idle') {
        resetIdleTimer(projectId, sessionId)
          .then((result) => {
            if (result.cleanupAt) {
              setSession((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  cleanupAt: result.cleanupAt,
                  isIdle: false,
                  agentCompletedAt: null,
                } as ChatSessionResponse;
              });
            }
          })
          .catch(() => {});
      }

      // Optimistic user message
      setMessages((prev) => [
        ...prev,
        {
          id: `optimistic-${crypto.randomUUID()}`,
          sessionId,
          role: 'user',
          content: trimmed,
          toolMetadata: null,
          createdAt: Date.now(),
        },
      ]);

      // Persist via DO WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'message.send',
            sessionId,
            content: trimmed,
            role: 'user',
          })
        );
      }

      // Forward prompt to the running agent via REST API
      try {
        await sendFollowUpPrompt(projectId, sessionId, trimmed);
      } catch {
        // Agent may be offline — message is still persisted via DO.
        // Reset to idle so the input isn't stuck in "Agent is working..." forever.
        setAgentActivity('idle');
      }

      setFollowUp('');
    } finally {
      setSendingFollowUp(false);
    }
  }, [
    followUp,
    sendingFollowUp,
    sessionState,
    projectId,
    sessionId,
    wsRef,
    clearCancelError,
    setAgentActivity,
  ]);

  // ── Upload files ──
  const handleUploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;
      setUploading(true);
      try {
        const result = await uploadSessionFiles(projectId, sessionId, fileArray);
        const names = result.files.map((f) => f.name).join(', ');
        setMessages((prev) => [
          ...prev,
          {
            id: `optimistic-upload-${crypto.randomUUID()}`,
            sessionId,
            role: 'user' as const,
            content: `Uploaded ${result.files.length} file${result.files.length > 1 ? 's' : ''}: ${names}`,
            toolMetadata: null,
            createdAt: Date.now(),
          },
        ]);
      } catch (err) {
        console.error('File upload failed:', err);
      } finally {
        setUploading(false);
      }
    },
    [projectId, sessionId]
  );

  // ── Load more (pagination) ──
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    const firstMessage = messages[0];
    if (!firstMessage) return;

    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, {
        before: firstMessage.createdAt,
      });
      setMessages((prev) => {
        const merged = mergeMessages(prev, data.messages, 'prepend');
        // Rendered rows, not messages — same accounting as project chat. See
        // `countDisplayRows`.
        const displayRowsAdded = countDisplayRows(merged) - countDisplayRows(prev);
        if (displayRowsAdded > 0) {
          setFirstItemIndex((fi) => fi - displayRowsAdded);
        }
        return merged;
      });
      setHasMore(data.hasMore);
    } catch {
      // Best-effort pagination
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, messages, projectId, sessionId]);

  // ── Derive placeholder from agent activity ──
  const placeholder =
    agentActivity === 'prompting' || agentActivity === 'responding'
      ? 'Agent is working...'
      : 'Send a message...';

  // ── Render ──
  if (loading && messages.length === 0 && !session) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error && !session) {
    return <div className="p-4 text-danger text-sm">{error}</div>;
  }

  const isActive = sessionState === 'active' || sessionState === 'idle';
  const showInput = isActive && session?.workspaceId;
  const connectionLabel =
    connectionState === 'connected'
      ? ''
      : connectionState === 'reconnecting'
        ? 'Reconnecting...'
        : '';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Connection state banner */}
      {isActive && connectionState !== 'connected' && connectionState !== 'disconnected' && (
        <div className="px-4 py-1.5 border-b border-border-default bg-warning-tint text-xs text-fg-muted">
          {connectionLabel}
        </div>
      )}

      {/* Error banner */}
      {(error || cancelError) && session && (
        <div
          role="alert"
          className="px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs break-words"
        >
          {error ?? cancelError}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 relative">
        <Virtuoso
          ref={virtuosoRef}
          data={conversationItems}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={conversationItems.length > 0 ? conversationItems.length - 1 : 0}
          followOutput="smooth"
          increaseViewportBy={{ top: 200, bottom: 100 }}
          atBottomStateChange={(atBottom) => setShowScrollButton(!atBottom)}
          startReached={
            hasMore
              ? () => {
                  void loadMore();
                }
              : undefined
          }
          itemContent={renderConversationItem}
        />

        {loadingMore && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2">
            <Spinner size="sm" />
          </div>
        )}

        {showScrollButton && (
          <button
            type="button"
            className="absolute bottom-4 right-4 p-2 rounded-full bg-surface-raised border border-border-default shadow-md cursor-pointer hover:bg-surface-hover"
            onClick={() =>
              virtuosoRef.current?.scrollToIndex({
                index: conversationItems.length - 1,
                behavior: 'smooth',
              })
            }
          >
            <ChevronDown size={16} />
          </button>
        )}
      </div>

      {/* Agent working indicator */}
      {agentActivity !== 'idle' && isActive && (
        <div
          role="status"
          className="flex items-center gap-2 px-4 py-2 border-t border-border-default bg-surface shrink-0"
        >
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Agent is working...</span>
          <button
            type="button"
            onClick={handleCancelPrompt}
            disabled={cancelling}
            aria-busy={cancelling}
            aria-label={cancelling ? 'Cancelling agent' : 'Cancel agent'}
            className="ml-auto flex-shrink-0 px-2 py-2.5 min-h-[44px] text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer text-danger hover:bg-danger-tint disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}

      {/* Input */}
      {showInput && (
        <FollowUpInput
          value={followUp}
          onChange={setFollowUp}
          onSend={() => {
            void handleSendFollowUp();
          }}
          onUploadFiles={(files) => {
            void handleUploadFiles(files);
          }}
          sending={sendingFollowUp}
          uploading={uploading}
          placeholder={placeholder}
          transcribeApiUrl={transcribeApiUrl}
        />
      )}
    </div>
  );
});
