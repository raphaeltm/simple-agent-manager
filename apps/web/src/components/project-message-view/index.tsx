/**
 * ProjectMessageView — DO-only chat component for project sessions.
 *
 * All messages flow through a single source: the Durable Object WebSocket.
 * Prompts are sent via the REST API. Agent state is derived from message flow.
 * TypewriterText animates the latest assistant message; historical messages
 * render instantly.
 */
// FILE SIZE EXCEPTION: Pre-existing large chat surface; this production hotfix adds a narrow URL-driven jump entry point that must stay colocated with existing Virtuoso jump/highlight state. See .claude/rules/18-file-size-limits.md
import type {
  ConversationItem,
  SlashCommand,
  ToolCallContentItem,
} from '@simple-agent-manager/acp-client';
import { mapToolCallContent, PlanModal } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { ChevronDown } from 'lucide-react';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { getMessageToolContent } from '../../lib/api/sessions';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { useAuth } from '../AuthProvider';
import { ChatFilePanel } from '../chat/ChatFilePanel';
import { type CommentInboxItem, countBuckets, toInboxItem } from './comments/comment-inbox';
import { CommentableConversationItem } from './comments/CommentableConversationItem';
import { DesktopCommentRail } from './comments/MessageCommentPanels';
import { useMessageComments } from './comments/useMessageComments';
import { useProjectMessageCommentUi } from './comments/useProjectMessageCommentUi';
import { CompletionDock } from './CompletionDock';
import { FloatingHeader } from './FloatingHeader';
import { FollowUpInput, ReadOnlyFollowUp } from './FollowUpInput';
import { ConnectionBanner } from './MessageBanners';
import {
  CHAT_LIST_COMPONENTS,
  type ChatListContext,
  useFloatingHeaderHeight,
} from './MessageListScaffold';
import { ProjectMessageViewDrawers } from './ProjectMessageViewDrawers';
import { currentPlanToPlanItem, ElapsedTime } from './session-view-utils';
import { StaleActivityNotice } from './StaleActivityNotice';
import { nearestItemId } from './timeline-jump';
import type { TimelineJumpTarget } from './timeline-types';
import { chatMessagesToConversationItems } from './types';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionTimeline } from './useSessionTimeline';
import { WakeProgressBanner } from './WakeProgressBanner';

// Re-export utilities used by external consumers
export { chatMessagesToConversationItems, groupMessages } from './types';

interface ProjectMessageViewProps {
  projectId: string;
  sessionId: string;
  /** When true, workspace is still provisioning — suppress "agent offline" banner. */
  isProvisioning?: boolean;
  /** Called after a mutation (e.g. mark complete) so the parent can refresh session list. */
  onSessionMutated?: () => void;
  /** Called when user clicks the retry button in the session header. */
  onRetry?: () => void;
  /** Called when user clicks the fork button in the session header. */
  onFork?: () => void;
  /** Source details for retries/forks. */
  sourceContext?: SessionSourceContext;
  /** Called when the user clicks Sleep on an awake idle conversation-mode session. */
  onSleepConversation?: () => void;
  /** Whether a sleep-conversation request is in flight. */
  sleepingConversation?: boolean;
  /** Error from a failed sleep-conversation attempt. */
  sleepError?: string | null;
  /** Called when the user confirms Archive on a sleeping conversation-mode session. */
  onCloseConversation?: () => void;
  /** Whether a close-conversation request is in flight. */
  closingConversation?: boolean;
  /** Error from a failed close-conversation attempt. */
  closeError?: string | null;
  /** Agent profiles available for @mention autocomplete in follow-up prompts. */
  agentProfiles?: AgentProfile[];
  /** Slash commands available for follow-up prompt autocomplete. */
  slashCommands?: SlashCommand[];
  /** Open hierarchy modal for the given task. */
  onShowHierarchy?: (taskId: string) => void;
  /** Start a new chat from read-only sessions. */
  onNewChat?: () => void;
  /** Message id requested by a route-level deep link, such as Project → Comments. */
  targetMessageId?: string | null;
  /** Timestamp used to load older history before resolving a route-level target. */
  targetMessageTimestamp?: number | null;
  /** Called once a route-level target has been consumed so refreshes do not re-jump. */
  onTargetMessageConsumed?: () => void;
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
  isProvisioning = false,
  onSessionMutated,
  onRetry,
  onFork,
  sourceContext,
  onSleepConversation,
  sleepingConversation,
  sleepError,
  onCloseConversation,
  closingConversation,
  closeError,
  agentProfiles = [],
  slashCommands = [],
  onShowHierarchy,
  onNewChat,
  targetMessageId,
  targetMessageTimestamp,
  onTargetMessageConsumed,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const [floatingHeaderRef, floatingHeaderHeight] = useFloatingHeaderHeight();
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const openComments = useCallback(() => setShowComments(true), []);
  const closeComments = useCallback(() => setShowComments(false), []);

  const messageComments = useMessageComments(projectId, sessionId, Boolean(projectId && sessionId));
  const { user } = useAuth();
  const viewerId = user?.id ?? null;

  const lc = useSessionLifecycle(
    projectId,
    sessionId,
    isProvisioning,
    onSessionMutated,
    messageComments.applyRealtimeEvent
  );

  // One derivation feeds the header chip, the drawer, and the timeline, so the
  // three can never disagree about how many comments are outstanding.
  const commentInbox = useMemo<CommentInboxItem[]>(() => {
    const roleById = new Map(lc.messages.map((msg) => [msg.id, msg.role]));
    return messageComments.comments.map((thread) =>
      toInboxItem(thread, {
        kind: 'session',
        sessionId,
        sessionTopic: lc.session?.topic ?? 'This session',
        messageId: thread.anchor.messageId,
        messageRole: roleById.get(thread.anchor.messageId) === 'user' ? 'user' : 'assistant',
      })
    );
  }, [messageComments.comments, lc.messages, lc.session?.topic, sessionId]);

  const commentCounts = useMemo(
    () => countBuckets(commentInbox, viewerId),
    [commentInbox, viewerId]
  );
  const unresolvedCommentCount = commentCounts.all - commentCounts.resolved;

  // Convert DO messages to conversation items (single source)
  const conversationItems = useMemo<ConversationItem[]>(() => {
    return chatMessagesToConversationItems(lc.messages);
  }, [lc.messages]);

  // Build item-id → 0-based data index map for jump-to-message from the timeline.
  // Includes EVERY conversation item so any timeline anchor resolves. The value is
  // the ZERO-BASED index into `conversationItems` — Virtuoso's `scrollToIndex`
  // operates on the data-array coordinate, NOT the `firstItemIndex`-offset
  // absolute coordinate used for `itemContent`'s `index` arg. Passing the offset
  // value (VIRTUAL_START + i ≈ 100000) is out of range, so Virtuoso never scrolls
  // and the highlighted row stays virtualized-out → a dead click on real
  // (virtualized) sessions. jsdom renders all rows, which hid this locally.
  const itemIndexById = useMemo(() => {
    const map = new Map<string, number>();
    conversationItems.forEach((item, i) => {
      map.set(item.id, i);
    });
    return map;
  }, [conversationItems]);

  const timeline = useSessionTimeline(
    projectId,
    sessionId,
    lc.messages,
    showTimeline,
    messageComments.comments
  );

  // Jump-to-message from the timeline. A jump targets either an exact message
  // (user message) or the nearest message to a timestamp (status/activity
  // entries). Because the full conversation loads on open, the target is almost
  // always already rendered. For the rare oversized/guard-trimmed session the
  // target may predate the loaded window — we set a pending jump and load older
  // pages until it resolves, so a jump never dead-clicks.
  const [pendingJump, setPendingJump] = useState<TimelineJumpTarget | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const consumedTargetMessageRef = useRef<string | null>(null);

  const scrollAndHighlight = useCallback(
    (itemId: string): boolean => {
      const index = itemIndexById.get(itemId);
      if (index === undefined) return false;
      virtuosoRef.current?.scrollToIndex({ index, behavior: 'smooth', align: 'center' });
      setHighlightedItemId(itemId);
      return true;
    },
    [itemIndexById]
  );

  const handleTimelineJump = useCallback(
    (target: TimelineJumpTarget) => {
      setShowTimeline(false);
      // Fast path: exact message already loaded.
      if (target.messageId && itemIndexById.has(target.messageId)) {
        scrollAndHighlight(target.messageId);
        return;
      }
      // Otherwise resolve via the pending-jump effect, loading older pages toward
      // the target timestamp first (no-op when the history is already fully loaded).
      setPendingJump(target);
      void lc.loadUntil(target.timestamp);
    },
    [itemIndexById, scrollAndHighlight, lc]
  );

  // Route-driven jump from the project Comments page. This deliberately reuses
  // the same jump path as the timeline and session comments drawer so URL
  // deep-links inherit the existing virtualized-list coordinate fix and
  // fallback loading behavior.
  useEffect(() => {
    if (!targetMessageId) return;
    const targetKey = `${sessionId}:${targetMessageId}`;
    if (consumedTargetMessageRef.current === targetKey) return;
    consumedTargetMessageRef.current = targetKey;
    handleTimelineJump({
      messageId: targetMessageId,
      timestamp: targetMessageTimestamp ?? Date.now(),
    });
    onTargetMessageConsumed?.();
  }, [
    handleTimelineJump,
    onTargetMessageConsumed,
    sessionId,
    targetMessageId,
    targetMessageTimestamp,
  ]);

  // Resolve a pending jump once the target (or the nearest message, after
  // loading settles) is available in the rendered list.
  useEffect(() => {
    if (!pendingJump) return;
    let targetId: string | undefined;
    if (pendingJump.messageId && itemIndexById.has(pendingJump.messageId)) {
      targetId = pendingJump.messageId;
    } else if (!lc.loadingMore) {
      // No exact anchor, or the anchor never materialized after loading
      // settled → jump to the nearest loaded message by timestamp.
      targetId = nearestItemId(conversationItems, pendingJump.timestamp);
    }
    if (targetId && scrollAndHighlight(targetId)) {
      setPendingJump(null);
    }
  }, [pendingJump, itemIndexById, conversationItems, lc.loadingMore, scrollAndHighlight]);

  // Auto-clear the jump highlight after the flash animation. The 2200ms here is
  // coupled to the `.sam-message-highlight` animation-duration (2.2s) in index.css
  // — keep the two in sync. Re-jumping resets the timer via this effect's cleanup.
  useEffect(() => {
    if (!highlightedItemId) return;
    const timer = setTimeout(() => setHighlightedItemId(null), 2200);
    return () => clearTimeout(timer);
  }, [highlightedItemId]);

  // Close plan modal when agent transitions to idle
  useEffect(() => {
    if (lc.agentActivity === 'idle') setShowPlanModal(false);
  }, [lc.agentActivity]);

  // Track IDs of user messages that should animate (freshly submitted optimistic messages)
  const [animatedUserMsgIds] = useState(() => new Set<string>());
  const prevMsgCountRef = useRef(0);

  /** Lazy-load tool content for a compact-mode tool call card. */
  const handleLoadToolContent = useCallback(
    async (messageId: string): Promise<ToolCallContentItem[]> => {
      const { content } = await getMessageToolContent(projectId, sessionId, messageId);
      return (content as Array<{ type: string } & Record<string, unknown>>).map((c) =>
        mapToolCallContent(c)
      );
    },
    [projectId, sessionId]
  );

  // Detect newly added optimistic user messages for fade animation
  useEffect(() => {
    const currentCount = lc.messages.length;
    if (currentCount > prevMsgCountRef.current) {
      // Check for new optimistic messages in the delta
      for (let i = prevMsgCountRef.current; i < currentCount; i++) {
        const msg = lc.messages[i];
        if (msg && msg.role === 'user' && msg.id.startsWith('optimistic-')) {
          animatedUserMsgIds.add(msg.id);
          // Remove from set after animation completes (max 1.5s + buffer)
          setTimeout(() => {
            animatedUserMsgIds.delete(msg.id);
          }, 2000);
        }
      }
    }
    prevMsgCountRef.current = currentCount;
  }, [lc.messages, animatedUserMsgIds]);

  // Identify the animation target: only animate if the very last item is an
  // agent_message. If a tool_call or thinking block is the latest item, the
  // previous agent_message should NOT be animated — its text is settled.
  const animationTargetIdx = useMemo(() => {
    const lastIdx = conversationItems.length - 1;
    if (lastIdx >= 0 && conversationItems[lastIdx]?.kind === 'agent_message') return lastIdx;
    return -1;
  }, [conversationItems]);

  // Only pass a file-click handler through when the session can actually serve
  // files; hoisted so `renderConversationItem` has a stable dependency instead of
  // rebuilding the ternary (and therefore the callback) on every render.
  const fileClickHandler =
    lc.session?.workspaceId && lc.sessionState === 'active' ? lc.handleFileClick : undefined;
  const canWriteSession = lc.session?.isMine !== false;
  const commentUi = useProjectMessageCommentUi({
    messageComments,
    canWriteSession,
    hasMessages: conversationItems.length > 0,
    chatLogRef,
    sessionId,
    onRequestCommentSurface: openComments,
  });
  const showDockedCommentRail = showComments && commentUi.usesDesktopRail;
  const showMobileCommentsDrawer = showComments && !commentUi.usesDesktopRail;

  /**
   * Row renderer for the virtualized conversation.
   *
   * Memoized so the identity only changes when something a row actually reads
   * changes. An inline arrow here gives Virtuoso a new `itemContent` on every
   * parent render, which re-renders every row currently inside the scroll window
   * — the exact cost `React.memo` on `AcpConversationItemView` exists to avoid.
   *
   * `index` is Virtuoso's `firstItemIndex`-OFFSET coordinate, which is why the
   * animation comparison subtracts `lc.firstItemIndex` to get back to the
   * zero-based data index. Do not "simplify" that away — see the coordinate-space
   * note on `itemIndexById` above.
   */
  const renderConversationItem = useCallback(
    (index: number, item: ConversationItem) => {
      return (
        <CommentableConversationItem
          index={index}
          firstItemIndex={lc.firstItemIndex}
          item={item}
          projectId={projectId}
          highlighted={highlightedItemId === item.id}
          onFileClick={fileClickHandler}
          onLoadToolContent={handleLoadToolContent}
          animateAgentText
          animateUserMessage={item.kind === 'user_message' && animatedUserMsgIds.has(item.id)}
          canWriteSession={canWriteSession}
          agentActivity={lc.agentActivity}
          animationTargetIdx={animationTargetIdx}
          commentState={commentUi.rowState}
        />
      );
    },
    [
      highlightedItemId,
      projectId,
      fileClickHandler,
      handleLoadToolContent,
      lc.firstItemIndex,
      lc.agentActivity,
      animationTargetIdx,
      animatedUserMsgIds,
      canWriteSession,
      commentUi.rowState,
    ]
  );

  /** Values the stable `ChatListHeader` reads, passed via Virtuoso's `context`. */
  const chatListContext = useMemo<ChatListContext>(
    () => ({
      headerSpacerHeight: floatingHeaderHeight + 8,
      hasMore: lc.hasMore,
      loadingMore: lc.loadingMore,
      onLoadMore: lc.loadMore,
    }),
    [floatingHeaderHeight, lc.hasMore, lc.loadingMore, lc.loadMore]
  );

  const planItem = useMemo(
    () =>
      lc.currentPlan && lc.currentPlan.length > 0 ? currentPlanToPlanItem(lc.currentPlan) : null,
    [lc.currentPlan]
  );
  const sessionOwnerLabel =
    lc.session?.createdBy?.name?.trim() ||
    lc.session?.createdBy?.email?.split('@')[0] ||
    'the creator';
  const isConversationLifecycleSession =
    lc.taskEmbed?.taskMode === 'conversation' ||
    (!lc.taskEmbed?.id && (lc.session?.status === 'active' || lc.session?.status === 'sleeping'));
  const canSleepSession = Boolean(
    onSleepConversation &&
    lc.session?.workspaceId &&
    lc.sessionState !== 'sleeping' &&
    isConversationLifecycleSession
  );
  const canArchiveSession = Boolean(
    onCloseConversation && lc.sessionState === 'sleeping' && isConversationLifecycleSession
  );
  const dockCenterAction =
    lc.agentActivity !== 'idle'
      ? 'interrupt'
      : lc.sessionState === 'sleeping'
        ? 'archive'
        : 'sleep';

  // Initial load — only show full spinner when no data exists yet
  if (lc.loading && lc.messages.length === 0 && !lc.session) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (lc.error && !lc.session) {
    return <div className="p-4 text-danger text-sm">{lc.error}</div>;
  }

  const isActive =
    lc.sessionState === 'active' || lc.sessionState === 'idle' || lc.sessionState === 'sleeping';
  const desktopCommentRail = showDockedCommentRail ? (
    <DesktopCommentRail
      comments={messageComments.comments}
      draft={commentUi.rowState.draft}
      loading={messageComments.loading}
      refreshing={messageComments.refreshing}
      error={messageComments.error}
      activeMessageId={commentUi.rowState.activeMessageId}
      focusedCommentId={commentUi.rowState.focusedCommentId}
      actions={commentUi.rowState.actions}
      onRetry={() => {
        void messageComments.refetch();
      }}
      onClearDraft={commentUi.rowState.onClearDraft}
      onSelectMessage={(messageId, commentId) => {
        commentUi.rowState.onSelectMessageComments(messageId, commentId);
        handleTimelineJump({ messageId, timestamp: Date.now() });
      }}
      onClose={closeComments}
    />
  ) : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Inline error when session already loaded */}
      {lc.error && lc.session && (
        <div className="px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs">
          {lc.error}
        </div>
      )}

      {/* Connection indicator (DO WebSocket) */}
      {lc.sessionState === 'active' &&
        lc.connectionState !== 'connected' &&
        lc.showConnectionBanner && (
          <ConnectionBanner state={lc.connectionState} onRetry={lc.retryWs} />
        )}

      {/* Resuming agent banner */}
      {lc.isResuming && (
        <div
          role="status"
          aria-label="Agent resume status"
          className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-surface text-xs text-fg-muted"
        >
          <Spinner size="sm" />
          <span>Waking and restoring Instant session...</span>
          {lc.resumeStartedAt != null && <ElapsedTime startedAt={lc.resumeStartedAt} />}
        </div>
      )}

      {/*
        Wake progress. `isWaking` is the server-derived signal (D1 hydrate + socket
        push). `agentActivity !== 'idle'` is retained as the pre-existing local
        fallback so a wake still shows a banner when no phase signal is available —
        e.g. an API that predates `wakePhase`, or a wake claimed before the
        replacement runner has written its first execution step.
      */}
      {lc.sessionState === 'sleeping' && (lc.isWaking || lc.agentActivity !== 'idle') && (
        <WakeProgressBanner
          wakePhase={lc.wakePhase}
          elapsed={
            lc.promptStartedAt != null ? <ElapsedTime startedAt={lc.promptStartedAt} /> : null
          }
        />
      )}

      {/* Resume / delivery error banner with retry */}
      {lc.resumeError && (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs"
        >
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            {lc.resumeError}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {lc.followUp.trim() && (
              <button
                type="button"
                className="px-2 py-1 text-xs font-medium rounded border border-danger/30 bg-transparent cursor-pointer hover:bg-danger-tint text-danger-fg transition-colors"
                onClick={() => {
                  lc.clearResumeError();
                  void lc.handleSendFollowUp();
                }}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              className="px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer hover:bg-surface-raised"
              onClick={lc.clearResumeError}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Messages area — virtualized, DO-only */}
      {conversationItems.length === 0 ? (
        <div className="relative flex flex-1 min-h-0 min-w-0 flex-col lg:flex-row">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <FloatingHeader
              projectId={projectId}
              lc={lc}
              onSessionMutated={onSessionMutated}
              onRetry={onRetry}
              onFork={onFork}
              onOpenTimeline={() => setShowTimeline(true)}
              onOpenComments={openComments}
              unresolvedCommentCount={unresolvedCommentCount}
              needsAttentionCommentCount={commentCounts.needs_you}
              sourceContext={sourceContext}
              onShowHierarchy={onShowHierarchy}
              containerRef={floatingHeaderRef}
            />
            <div
              className="flex flex-1 items-center justify-center"
              style={{ paddingTop: floatingHeaderHeight }}
            >
              <span className="text-fg-muted text-sm">
                {lc.sessionState === 'active'
                  ? 'Waiting for messages...'
                  : 'No messages in this session.'}
              </span>
            </div>
          </div>
          {desktopCommentRail}
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 relative flex flex-col lg:flex-row">
          <div
            ref={chatLogRef}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            <FloatingHeader
              projectId={projectId}
              lc={lc}
              onSessionMutated={onSessionMutated}
              onRetry={onRetry}
              onFork={onFork}
              onOpenTimeline={() => setShowTimeline(true)}
              onOpenComments={openComments}
              unresolvedCommentCount={unresolvedCommentCount}
              needsAttentionCommentCount={commentCounts.needs_you}
              sourceContext={sourceContext}
              onShowHierarchy={onShowHierarchy}
              containerRef={floatingHeaderRef}
            />
            <div className="flex-1 min-h-0">
              <Virtuoso
                ref={virtuosoRef}
                style={{ height: '100%' }}
                data={conversationItems}
                firstItemIndex={lc.firstItemIndex}
                initialTopMostItemIndex={conversationItems.length - 1}
                followOutput={(isAtBottom: boolean) => (isAtBottom ? 'smooth' : false)}
                alignToBottom
                atBottomThreshold={50}
                atBottomStateChange={(atBottom) => lc.setShowScrollButton(!atBottom)}
                overscan={200}
                itemContent={renderConversationItem}
                context={chatListContext}
                components={CHAT_LIST_COMPONENTS}
              />
            </div>

            {/* Scroll to bottom button */}
            {lc.showScrollButton && (
              <button
                type="button"
                onClick={() => {
                  virtuosoRef.current?.scrollToIndex({
                    index: 'LAST',
                    behavior: 'smooth',
                  });
                }}
                className="sam-scroll-button absolute right-4 z-10 flex items-center justify-center w-11 h-11 rounded-full border border-[var(--sam-form-border)] bg-[var(--sam-form-bg)] shadow-md cursor-pointer hover:bg-page"
                data-agent-active={lc.agentActivity !== 'idle'}
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} className="text-fg-muted" />
              </button>
            )}

            {commentUi.selectionControls}
          </div>
          {desktopCommentRail}
        </div>
      )}

      {/* Lifecycle control — a single always-mounted dock while the session is
          active. Its center button morphs between Interrupt (working), Sleep
          (awake idle), and Archive (already sleeping), so irreversible archive
          is only the primary action after the reversible sleep boundary. */}
      {isActive &&
        canWriteSession &&
        (lc.completionDockWorking || canSleepSession || canArchiveSession) && (
          <CompletionDock
            working={lc.completionDockWorking}
            centerAction={dockCenterAction}
            hasPlan={!!planItem}
            onInterrupt={lc.handleCancelPrompt}
            onSleep={() => onSleepConversation?.()}
            onArchive={() => onCloseConversation?.()}
            onOpenPlan={() => setShowPlanModal(true)}
            sleeping={sleepingConversation}
            archiving={closingConversation}
            sleepError={sleepError}
            archiveError={closeError}
            elapsed={
              lc.promptStartedAt ? <ElapsedTime startedAt={lc.promptStartedAt} /> : undefined
            }
          />
        )}
      {planItem && (
        <PlanModal plan={planItem} isOpen={showPlanModal} onClose={() => setShowPlanModal(false)} />
      )}

      {/* Stale activity notice — shown once per verified-stale transition */}
      {lc.staleNotice && <StaleActivityNotice onDismiss={lc.dismissStaleNotice} />}
      {commentUi.selectedTextComposer}

      {/* Input area */}
      {isActive && canWriteSession && (
        <FollowUpInput
          value={lc.followUp}
          onChange={lc.setFollowUp}
          onSend={() => {
            void lc.handleSendFollowUp();
          }}
          onUploadFiles={(files) => {
            void lc.handleUploadFiles(files);
          }}
          sending={lc.sendingFollowUp}
          uploading={lc.uploading}
          placeholder={
            // A wake already in flight must not be advertised as "send a message
            // to wake" — that contradicts the banner directly above and is what
            // invites the duplicate wake this feature exists to prevent.
            lc.isWaking
              ? 'Waking the agent — your message will be delivered...'
              : lc.agentActivity === 'prompting' || lc.agentActivity === 'responding'
                ? 'Agent is working...'
                : lc.sessionState === 'idle'
                  ? 'Send a message to resume the agent...'
                  : lc.sessionState === 'sleeping'
                    ? 'Send a message to wake the agent...'
                    : 'Send a message...'
          }
          transcribeApiUrl={lc.transcribeApiUrl}
          agentProfiles={agentProfiles}
          slashCommands={slashCommands}
        />
      )}
      {isActive && !canWriteSession && (
        <ReadOnlyFollowUp ownerLabel={sessionOwnerLabel} onNewChat={onNewChat} />
      )}
      {lc.sessionState === 'terminated' && (
        <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface text-center">
          <span className="sam-type-secondary text-fg-muted">This session has ended.</span>
        </div>
      )}

      {/* File viewer slide-over panel */}
      {lc.filePanel && lc.session && (
        <ChatFilePanel
          projectId={projectId}
          sessionId={sessionId}
          initialMode={lc.filePanel.mode}
          initialPath={lc.filePanel.path}
          onClose={() => lc.setFilePanel(null)}
        />
      )}

      <ProjectMessageViewDrawers
        showTimeline={showTimeline}
        timelineEntries={timeline.entries}
        timelineLoading={timeline.loading}
        showTimelineContext={timeline.showContext}
        onToggleTimelineContext={() => timeline.setShowContext(!timeline.showContext)}
        onCloseTimeline={() => setShowTimeline(false)}
        showComments={showMobileCommentsDrawer}
        commentItems={commentInbox}
        commentsLoading={messageComments.loading}
        viewerId={viewerId}
        canWriteSession={canWriteSession}
        onCloseComments={closeComments}
        onJump={handleTimelineJump}
        onReply={(threadId, body, action) =>
          messageComments.reply({ commentId: threadId, body, action })
        }
        onResolve={messageComments.resolve}
        onReopen={messageComments.reopen}
        onSendToAgent={(threadId) => messageComments.sendToAgent({ commentId: threadId })}
      />
    </div>
  );
};
