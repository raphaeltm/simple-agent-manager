/**
 * SessionMessageView — the chat view for ONE project session.
 *
 * All messages flow through a single source: the Durable Object WebSocket.
 * Prompts are sent via the REST API. Agent state is derived from message flow.
 * TypewriterText animates the latest assistant message; historical messages
 * render instantly.
 *
 * Mounted per session by `ProjectMessageView` (index.tsx), so every piece of
 * state here belongs to exactly one session.
 */
import type { SlashCommand, ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { mapToolCallContent } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useMemo, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { useIsMobile } from '../../hooks/useIsMobile';
import { getMessageToolContent } from '../../lib/api/sessions';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { useAuth } from '../AuthProvider';
import { ChatFilePanel } from '../chat/ChatFilePanel';
import { SessionEventsDrawer } from '../chat/SessionEventsDrawer';
import { ReportIssueDialog } from '../ReportIssueDialog';
import { type CommentInboxItem, countBuckets, toInboxItem } from './comments/comment-inbox';
import { CommentableConversationItem } from './comments/CommentableConversationItem';
import { DesktopCommentRail } from './comments/MessageCommentPanels';
import { useMessageComments } from './comments/useMessageComments';
import { useProjectMessageCommentUi } from './comments/useProjectMessageCommentUi';
import { ConversationPane } from './ConversationPane';
import { FloatingHeader } from './FloatingHeader';
import { type ChatListContext, useFloatingHeaderHeight } from './MessageListScaffold';
import { ProjectMessageViewDrawers } from './ProjectMessageViewDrawers';
import { SessionFooter } from './SessionFooter';
import { SessionHeaderCompletionDialog } from './SessionHeaderCompletionDialog';
import { SessionStatusBanners } from './SessionStatusBanners';
import { SessionToolRail } from './SessionToolRail';
import type { DisplayItem } from './tool-call-groups';
import { groupToolCallItems } from './tool-call-groups';
import { chatMessagesToConversationItems } from './types';
import { useAnimatedUserMessages } from './useAnimatedUserMessages';
import { useConversationJump } from './useConversationJump';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionTimeline } from './useSessionTimeline';
import { useSessionTools } from './useSessionTools';
import { useToolCallGroupRowState } from './useToolCallGroupRowState';

export interface ProjectMessageViewProps {
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

export const SessionMessageView: FC<ProjectMessageViewProps> = ({
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
  const [showTimeline, setShowTimeline] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const openComments = useCallback(() => setShowComments(true), []);
  const closeComments = useCallback(() => setShowComments(false), []);
  // Stable identity matters: this feeds `useSessionTools`' memoized action array, and an
  // inline arrow would rebuild it on every render (rule 64).
  const openTimeline = useCallback(() => setShowTimeline(true), []);
  const closeTimeline = useCallback(() => setShowTimeline(false), []);
  const openResources = useCallback(() => setShowResources(true), []);
  const openEvents = useCallback(() => setShowEvents(true), []);

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
        messageRole: anchorRole(roleById.get(thread.anchor.messageId)),
      })
    );
  }, [messageComments.comments, lc.messages, lc.session?.topic, sessionId]);

  const commentCounts = useMemo(
    () => countBuckets(commentInbox, viewerId),
    [commentInbox, viewerId]
  );
  const unresolvedCommentCount = commentCounts.all - commentCounts.resolved;

  // Convert DO messages to conversation items (single source), then fold
  // consecutive tool activity into one collapsed group row. Both passes live in
  // the same memo because every item object is rebuilt on every incoming token.
  const displayItems = useMemo<DisplayItem[]>(() => {
    return groupToolCallItems(chatMessagesToConversationItems(lc.messages));
  }, [lc.messages]);

  const timeline = useSessionTimeline(
    projectId,
    sessionId,
    lc.messages,
    showTimeline,
    messageComments.comments
  );

  const { jumpToMessage, highlightedRowId } = useConversationJump({
    sessionId,
    displayItems,
    virtuosoRef,
    // `ConversationPane` mounts the list once the session is known and has rows.
    listReady: Boolean(lc.session) && displayItems.length > 0,
    loadUntil: lc.loadUntil,
    loadingMore: lc.loadingMore,
    targetMessageId,
    targetMessageTimestamp,
    onTargetMessageConsumed,
    onJump: closeTimeline,
  });

  const animatedUserMsgIds = useAnimatedUserMessages(lc.messages);

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

  // Identify the animation target: only animate if the very last item is an
  // agent_message. If a tool_call or thinking block is the latest item, the
  // previous agent_message should NOT be animated — its text is settled.
  const animationTargetIdx = useMemo(() => {
    const lastIdx = displayItems.length - 1;
    if (lastIdx >= 0 && displayItems[lastIdx]?.kind === 'agent_message') return lastIdx;
    return -1;
  }, [displayItems]);

  /*
   * Expansion survives virtualization because it lives here, and the live-tail
   * glyph keys on `completionDockWorking` rather than `isWorkingActivity`. Both
   * chat surfaces share this hook; see its doc comment for why that signal is
   * the correct one (`.claude/rules/24`).
   */
  const groupRowState = useToolCallGroupRowState(displayItems, lc.completionDockWorking);

  // Only pass a file-click handler through when the session can actually serve
  // files; hoisted so `renderConversationItem` has a stable dependency instead of
  // rebuilding the ternary (and therefore the callback) on every render.
  const fileClickHandler =
    lc.session?.workspaceId && lc.sessionState === 'active' ? lc.handleFileClick : undefined;
  const canWriteSession = lc.session?.isMine !== false;
  const commentUi = useProjectMessageCommentUi({
    messageComments,
    canWriteSession,
    hasMessages: displayItems.length > 0,
    chatLogRef,
    sessionId,
    onRequestCommentSurface: openComments,
  });
  const showDockedCommentRail = showComments && commentUi.usesDesktopRail;
  const showMobileCommentsDrawer = showComments && !commentUi.usesDesktopRail;

  const isMobile = useIsMobile();
  const sessionTools = useSessionTools({
    projectId,
    session: lc.session,
    sessionState: lc.sessionState,
    taskEmbed: lc.taskEmbed,
    unresolvedCommentCount,
    needsAttentionCommentCount: commentCounts.needs_you,
    onSessionMutated,
    onOpenFiles: lc.handleOpenFileBrowser,
    onOpenGit: lc.handleOpenGitChanges,
    onOpenTimeline: openTimeline,
    onOpenResources: openResources,
    onOpenEvents: openEvents,
    onOpenComments: openComments,
    onRetry,
    onFork,
  });
  const sessionToolRail = lc.session ? (
    <SessionToolRail
      actions={sessionTools.actions}
      mode={sessionTools.mode}
      onModeChange={sessionTools.setMode}
      onSelect={sessionTools.selectTool}
      isMobile={isMobile}
    />
  ) : null;

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
   * note on `itemIndexById` in `useConversationJump`.
   */
  const renderConversationItem = useCallback(
    (index: number, item: DisplayItem) => {
      return (
        <CommentableConversationItem
          index={index}
          firstItemIndex={lc.firstItemIndex}
          item={item}
          projectId={projectId}
          highlighted={highlightedRowId === item.id}
          onFileClick={fileClickHandler}
          onLoadToolContent={handleLoadToolContent}
          animateAgentText
          animateUserMessage={item.kind === 'user_message' && animatedUserMsgIds.has(item.id)}
          canWriteSession={canWriteSession}
          agentActivity={lc.agentActivity}
          animationTargetIdx={animationTargetIdx}
          commentState={commentUi.rowState}
          groupExpanded={
            item.kind === 'tool_call_group' ? groupRowState.groupExpandedFor(item.id) : undefined
          }
          onToggleGroup={groupRowState.onToggleGroup}
          groupLive={groupRowState.groupLiveFor(item.id)}
        />
      );
    },
    [
      highlightedRowId,
      projectId,
      fileClickHandler,
      handleLoadToolContent,
      lc.firstItemIndex,
      lc.agentActivity,
      animationTargetIdx,
      animatedUserMsgIds,
      canWriteSession,
      commentUi.rowState,
      groupRowState,
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

  // Nothing renders until the session is known: its first load is outstanding, or
  // failed. A cached chat never waits here — its session is there on the first
  // render, and a background refresh never brings this back.
  if (!lc.session) {
    return lc.error ? (
      <div className="p-4 text-danger text-sm">{lc.error}</div>
    ) : (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

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
        jumpToMessage({ messageId, timestamp: Date.now() });
      }}
      onClose={closeComments}
    />
  ) : null;

  const floatingHeader = (
    <FloatingHeader
      projectId={projectId}
      lc={lc}
      onSessionMutated={onSessionMutated}
      onOpenComments={openComments}
      unresolvedCommentCount={unresolvedCommentCount}
      needsAttentionCommentCount={commentCounts.needs_you}
      sourceContext={sourceContext}
      onShowHierarchy={onShowHierarchy}
      containerRef={floatingHeaderRef}
      expanded={sessionTools.detailsExpanded}
      onExpandedChange={sessionTools.setDetailsExpanded}
      flushRight={sessionTools.mode !== 'hidden'}
      completeError={sessionTools.completeError}
      onDismissCompleteError={sessionTools.dismissCompleteError}
    />
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SessionStatusBanners lc={lc} />

      <ConversationPane
        lc={lc}
        displayItems={displayItems}
        header={floatingHeader}
        headerHeight={floatingHeaderHeight}
        chatLogRef={chatLogRef}
        virtuosoRef={virtuosoRef}
        renderItem={renderConversationItem}
        listContext={chatListContext}
        selectionControls={commentUi.selectionControls}
        commentRail={desktopCommentRail}
        toolRail={sessionToolRail}
      />

      <SessionFooter
        lc={lc}
        canWriteSession={canWriteSession}
        selectedTextComposer={commentUi.selectedTextComposer}
        onSleepConversation={onSleepConversation}
        sleepingConversation={sleepingConversation}
        sleepError={sleepError}
        onCloseConversation={onCloseConversation}
        closingConversation={closingConversation}
        closeError={closeError}
        agentProfiles={agentProfiles}
        slashCommands={slashCommands}
        onNewChat={onNewChat}
      />

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
        projectId={projectId}
        sessionId={sessionId}
        timelineEntries={timeline.entries}
        timelineLoading={timeline.loading}
        showTimelineContext={timeline.showContext}
        onToggleTimelineContext={() => timeline.setShowContext(!timeline.showContext)}
        onCloseTimeline={closeTimeline}
        showResources={showResources}
        onCloseResources={() => setShowResources(false)}
        showComments={showMobileCommentsDrawer}
        commentItems={commentInbox}
        commentsLoading={messageComments.loading}
        viewerId={viewerId}
        canWriteSession={canWriteSession}
        onCloseComments={closeComments}
        onJump={jumpToMessage}
        onReply={(threadId, body, action) =>
          messageComments.reply({ commentId: threadId, body, action })
        }
        onResolve={messageComments.resolve}
        onReopen={messageComments.reopen}
        onSendToAgent={(threadId) => messageComments.sendToAgent({ commentId: threadId })}
      />

      {showEvents && (
        <SessionEventsDrawer
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setShowEvents(false)}
        />
      )}

      {/* Dialogs for the rail's Report and Complete actions. They live here rather than
          in `SessionHeader` because the actions that open them do. */}
      <ReportIssueDialog
        isOpen={sessionTools.reportOpen}
        onClose={sessionTools.closeReport}
        refs={{
          sessionId,
          taskId: lc.session?.taskId || undefined,
          nodeId: lc.workspace?.nodeId || undefined,
        }}
      />
      <SessionHeaderCompletionDialog
        isOpen={sessionTools.confirmCompleteOpen}
        onClose={sessionTools.closeConfirmComplete}
        onConfirm={sessionTools.confirmComplete}
      />
    </div>
  );
};

/** The annotated message's author, or null when it is not loaded (older history). */
function anchorRole(role: string | undefined): 'user' | 'assistant' | null {
  if (role === undefined) return null;
  return role === 'user' ? 'user' : 'assistant';
}
