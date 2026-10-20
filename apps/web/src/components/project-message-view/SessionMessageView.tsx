import type { ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { mapToolCallContent } from '@simple-agent-manager/acp-client';
import { Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { useAcpPermissionInteractions } from '../../hooks/useAcpPermissionInteractions';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getMessageToolContent } from '../../lib/api/sessions';
import { useAuth } from '../AuthProvider';
import { ChatFilePanel } from '../chat/ChatFilePanel';
import { type CommentInboxItem, countBuckets, toInboxItem } from './comments/comment-inbox';
import { CommentableConversationItem } from './comments/CommentableConversationItem';
import { buildCommentedMessageDescriber } from './comments/commented-message-label';
import { DesktopCommentRail } from './comments/MessageCommentPanels';
import { useMessageComments } from './comments/useMessageComments';
import { useProjectMessageCommentUi } from './comments/useProjectMessageCommentUi';
import { ConversationPane } from './ConversationPane';
import { FloatingHeader } from './FloatingHeader';
import { type ChatListContext, useFloatingHeaderHeight } from './MessageListScaffold';
import { ProjectMessageViewDrawers } from './ProjectMessageViewDrawers';
import { useSessionFocusHandoff } from './session-focus-handoff';
import { resolveSessionViewerCapabilities, sessionOwnerLabel } from './session-viewer-access';
import { SessionFooter } from './SessionFooter';
import type { ProjectMessageViewProps } from './SessionMessageView.types';
import { SessionMessageViewDialogs } from './SessionMessageViewDialogs';
import { SessionStatusBanners } from './SessionStatusBanners';
import { SessionToolRail } from './SessionToolRail';
import type { DisplayItem } from './tool-call-groups';
import { groupToolCallItems } from './tool-call-groups';
import { chatMessagesToConversationItems } from './types';
import { useAcpPermissionPlacement } from './useAcpPermissionPlacement';
import { useAnimatedUserMessages } from './useAnimatedUserMessages';
import { useConversationJump } from './useConversationJump';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionTimeline } from './useSessionTimeline';
import { useSessionTools } from './useSessionTools';
import { useToolCallGroupRowState } from './useToolCallGroupRowState';

export type { ProjectMessageViewProps };

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
  permissionRefreshSignal,
  focusCommentThreadId,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const [floatingHeaderRef, floatingHeaderHeight] = useFloatingHeaderHeight();
  const [showTimeline, setShowTimeline] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const openComments = useCallback(() => setShowComments(true), []);
  const closeComments = useCallback(() => setShowComments(false), []);
  // Stable identity matters: this feeds `useSessionTools`' memoized action array, and an
  // inline arrow would rebuild it on every render (rule 64).
  const openTimeline = useCallback(() => setShowTimeline(true), []);
  const closeTimeline = useCallback(() => setShowTimeline(false), []);
  const openResources = useCallback(() => setShowResources(true), []);
  const openEvents = useCallback(() => setShowEvents(true), []);
  const closeEvents = useCallback(() => setShowEvents(false), []);
  const openShare = useCallback(() => setShowShare(true), []);
  const closeShare = useCallback(() => setShowShare(false), []);

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
  const permissionInteractions = useAcpPermissionInteractions({
    projectId,
    sessionId,
    viewerId,
    connectionState: lc.connectionState,
    refreshSignal: permissionRefreshSignal,
  });
  const permissionItems = permissionInteractions.authorizationError
    ? []
    : permissionInteractions.interactions;
  const refreshPermissionInteractions = permissionInteractions.refresh;

  // Convert DO messages to conversation items (single source), then fold
  // consecutive tool activity into one collapsed group row. Both passes live in
  // the same memo because every item object is rebuilt on every incoming token.
  const undeliveredList = lc.session?.access?.undelivered;
  const displayItems = useMemo<DisplayItem[]>(() => {
    return groupToolCallItems(chatMessagesToConversationItems(lc.messages, undeliveredList));
  }, [lc.messages, undeliveredList]);
  // Owner and grantees drive the agent; every member can comment; the server enforces both.
  const viewer = resolveSessionViewerCapabilities(lc.session);
  // A teammate's Files/Git panel closes when their access ends; the server already refuses
  // its next read.
  const canBrowseWorkspace = viewer.canBrowseWorkspace;
  const couldBrowseWorkspace = useRef(canBrowseWorkspace);
  const { setFilePanel } = lc;
  useEffect(() => {
    if (couldBrowseWorkspace.current && !canBrowseWorkspace) setFilePanel(null);
    couldBrowseWorkspace.current = canBrowseWorkspace;
  }, [canBrowseWorkspace, setFilePanel]);
  // One description per commented message ("the agent's reply", "Olivia's message"), shared by
  // the drawer rows and the desktop rail so they cannot name the same message differently.
  const ownerName = sessionOwnerLabel(lc.session);
  const viewerIsOwner = viewer.viewerAccess === 'owner';
  const describeCommentedMessage = useMemo(
    () => buildCommentedMessageDescriber(displayItems, { ownerName, viewerIsOwner }),
    [displayItems, ownerName, viewerIsOwner]
  );

  // One derivation feeds the header chip, the drawer, and the timeline, so the
  // three can never disagree about how many comments are outstanding.
  const commentInbox = useMemo<CommentInboxItem[]>(() => {
    return messageComments.comments.map((thread) => {
      const message = describeCommentedMessage(thread.anchor.messageId);
      return toInboxItem(thread, {
        kind: 'session',
        sessionId,
        sessionTopic: lc.session?.topic ?? 'This session',
        messageId: thread.anchor.messageId,
        messageDescription: message.loaded ? message.phrase : null,
      });
    });
  }, [messageComments.comments, describeCommentedMessage, lc.session?.topic, sessionId]);

  const commentCounts = useMemo(
    () => countBuckets(commentInbox, viewerId),
    [commentInbox, viewerId]
  );
  const unresolvedCommentCount = commentCounts.all - commentCounts.resolved;

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
    listRootRef: chatLogRef,
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

  // Expansion survives virtualization; the hook documents its live-tail signal.
  const groupRowState = useToolCallGroupRowState(displayItems, lc.completionDockWorking);

  // Only pass a file-click handler through when the session can actually serve
  // files; hoisted so `renderConversationItem` has a stable dependency instead of
  // rebuilding the ternary (and therefore the callback) on every render.
  const fileClickHandler =
    lc.session?.workspaceId && lc.sessionState === 'active' ? lc.handleFileClick : undefined;
  const permissionPlacement = useAcpPermissionPlacement({
    displayItems,
    interactions: permissionItems,
    projectId,
    sessionId,
    canAnswer: viewer.canDriveSession,
    onRefresh: refreshPermissionInteractions,
  });
  const commentUi = useProjectMessageCommentUi({
    messageComments,
    canComment: viewer.canComment,
    canSendToAgent: viewer.canSendToAgent,
    hasMessages: displayItems.length > 0,
    chatLogRef,
    sessionId,
    projectId,
    onRequestCommentSurface: openComments,
    focusCommentThreadId,
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
    onOpenShare: lc.session?.access ? openShare : undefined,
    sharedWithCount: lc.session?.access?.grants.length ?? 0,
    canManageShare: viewer.canManageAccess,
    canBrowseWorkspace,
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

  // Virtuoso supplies an offset index, so compare it after subtracting `firstItemIndex`.
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
          canComment={viewer.canComment}
          canSendToAgent={viewer.canSendToAgent}
          agentActivity={lc.agentActivity}
          animationTargetIdx={animationTargetIdx}
          commentState={commentUi.rowState}
          groupExpanded={
            item.kind === 'tool_call_group' ? groupRowState.groupExpandedFor(item.id) : undefined
          }
          onToggleGroup={groupRowState.onToggleGroup}
          groupLive={groupRowState.groupLiveFor(item.id)}
          afterContent={
            permissionPlacement.anchored.has(item.id)
              ? permissionPlacement.render(permissionPlacement.anchored.get(item.id) ?? [])
              : null
          }
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
      viewer.canComment,
      viewer.canSendToAgent,
      commentUi.rowState,
      groupRowState,
      permissionPlacement,
    ]
  );

  /** Values the stable `ChatListHeader` reads, passed via Virtuoso's `context`. */
  const chatListContext = useMemo<ChatListContext>(
    () => ({
      headerSpacerHeight: floatingHeaderHeight + 8,
      hasMore: lc.hasMore,
      loadingMore: lc.loadingMore,
      onLoadMore: lc.loadMore,
      footer:
        permissionPlacement.unanchored.length > 0 ? (
          <div className="px-4 pb-3">
            {permissionPlacement.render(permissionPlacement.unanchored)}
          </div>
        ) : null,
    }),
    [floatingHeaderHeight, lc.hasMore, lc.loadingMore, lc.loadMore, permissionPlacement]
  );

  useSessionFocusHandoff(Boolean(lc.session));

  // Nothing renders until the session is known: its first load is outstanding, or
  // failed. A cached chat never waits here — its session is there on the first
  // render, and a background refresh never brings this back.
  if (!lc.session) {
    return lc.error ? (
      <div className="p-4 text-danger text-sm">{lc.error}</div>
    ) : (
      <div className="flex justify-center p-8" data-testid="chat-loading">
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
      describeMessage={describeCommentedMessage}
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
        tail={chatListContext.footer}
      />

      <SessionFooter
        projectId={projectId}
        onFork={onFork}
        lc={lc}
        viewer={viewer}
        viewerId={viewerId}
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
        canSendToAgent={viewer.canSendToAgent}
        onCloseComments={closeComments}
        onJump={jumpToMessage}
        onReply={(threadId, body, action, mentions) =>
          messageComments.reply({ commentId: threadId, body, action, mentions })
        }
        onResolve={messageComments.resolve}
        onReopen={messageComments.reopen}
        onSendToAgent={(threadId) => messageComments.sendToAgent({ commentId: threadId })}
      />

      <SessionMessageViewDialogs
        projectId={projectId}
        sessionId={sessionId}
        session={lc.session}
        nodeId={lc.workspace?.nodeId ?? null}
        viewerId={viewerId}
        sessionTools={sessionTools}
        showEvents={showEvents}
        onCloseEvents={closeEvents}
        showShare={showShare}
        onCloseShare={closeShare}
        onAccessChanged={lc.applySessionAccess}
      />
    </div>
  );
};

/** The annotated message's author, or null when it is not loaded (older history). */
