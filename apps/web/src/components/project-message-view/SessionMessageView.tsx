import type { ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useMemo, useRef } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { useAcpPermissionInteractions } from '../../hooks/useAcpPermissionInteractions';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAuth } from '../AuthProvider';
import { ChatFilePanel } from '../chat/ChatFilePanel';
import { CommentableConversationItem } from './comments/CommentableConversationItem';
import { DesktopCommentRail } from './comments/MessageCommentPanels';
import { useMessageComments } from './comments/useMessageComments';
import { useProjectMessageCommentUi } from './comments/useProjectMessageCommentUi';
import { ConversationPane } from './ConversationPane';
import { FloatingHeader } from './FloatingHeader';
import { loadToolCallContent } from './load-tool-content';
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
import { useFilePanelAccessGate } from './useFilePanelAccessGate';
import { useSessionCommentInbox } from './useSessionCommentInbox';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionLinkedWork } from './useSessionLinkedWork';
import { useSessionOverlays } from './useSessionOverlays';
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
  /*
   * The on-demand panels the tool rail opens. Their handlers must keep a stable identity:
   * they feed `useSessionTools`' memoized action array, and an inline arrow would rebuild it
   * on every render (rule 64). See `useSessionOverlays`.
   */
  const {
    showTimeline,
    openTimeline,
    closeTimeline,
    showComments,
    openComments,
    closeComments,
    showResources,
    openResources,
    closeResources,
    showAutomation,
    openAutomation,
    closeAutomation,
    showRelated,
    openRelated,
    closeRelated,
    showShare,
    openShare,
    closeShare,
  } = useSessionOverlays();

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
  const accessNoticeRef = useRef<HTMLDivElement>(null);
  const filePanelNotice = useFilePanelAccessGate({
    canBrowseWorkspace: viewer.canBrowseWorkspace,
    filePanelOpen: lc.filePanel !== null,
    setFilePanel: lc.setFilePanel,
    accessNoticeRef,
  });
  // One derivation of the comment threads for the header chip, the drawer, the desktop rail
  // and the timeline, so the four cannot disagree. See `useSessionCommentInbox`.
  const comments = useSessionCommentInbox({
    sessionId,
    sessionTopic: lc.session?.topic,
    comments: messageComments.comments,
    displayItems,
    ownerName: sessionOwnerLabel(lc.session),
    viewerIsOwner: viewer.viewerAccess === 'owner',
    viewerId,
  });
  const { describeCommentedMessage } = comments;
  const commentInbox = comments.items;
  const commentCounts = comments.counts;
  const unresolvedCommentCount = comments.unresolvedCount;

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
    messages: lc.messages,
    targetMessageId,
    targetMessageTimestamp,
    onTargetMessageConsumed,
    onJump: closeTimeline,
  });

  const animatedUserMsgIds = useAnimatedUserMessages(lc.messages);

  /** Lazy-load tool content for a compact-mode tool call card. */
  const handleLoadToolContent = useCallback(
    (messageId: string): Promise<ToolCallContentItem[]> =>
      loadToolCallContent(projectId, sessionId, messageId),
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

  // Only pass a file-click handler through when the session can serve files to this viewer;
  // hoisted so `renderConversationItem` has a stable dependency instead of rebuilding the
  // ternary (and therefore the callback) on every render.
  const fileClickHandler =
    lc.session?.workspaceId && lc.sessionState === 'active' && viewer.canBrowseWorkspace
      ? lc.handleFileClick
      : undefined;
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

  /*
   * One read of the chat's linked work, shared by the header chip, the rail's Related badge
   * and the Related drawer. Called here rather than in each of them so there is a single
   * derivation and a single memoised identity (rule 64), and so opening the drawer costs no
   * request.
   */
  const linkedWork = useSessionLinkedWork({
    projectId,
    sessionId,
    outputPrUrl: lc.taskEmbed?.outputPrUrl ?? null,
  });

  const isMobile = useIsMobile();
  const sessionTools = useSessionTools({
    projectId,
    session: lc.session,
    sessionState: lc.sessionState,
    taskEmbed: lc.taskEmbed,
    unresolvedCommentCount,
    needsAttentionCommentCount: commentCounts.needs_you,
    relatedCount: linkedWork.totalCount,
    relatedCountIsLowerBound: linkedWork.totalIsLowerBound,
    onSessionMutated,
    onOpenFiles: lc.handleOpenFileBrowser,
    onOpenGit: lc.handleOpenGitChanges,
    onOpenTimeline: openTimeline,
    onOpenResources: openResources,
    onOpenAutomation: openAutomation,
    onOpenRelated: openRelated,
    onOpenComments: openComments,
    onRetry,
    onFork,
    onOpenShare: lc.session?.access ? openShare : undefined,
    sharedWithCount: lc.session?.access?.grants.length ?? 0,
    canManageShare: viewer.canManageAccess,
    canBrowseWorkspace: viewer.canBrowseWorkspace,
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
      linkedWork={linkedWork}
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
        accessNoticeRef={accessNoticeRef}
      />
      <p role="status" className="sr-only">
        {filePanelNotice}
      </p>

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
        onCloseResources={closeResources}
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
        showAutomation={showAutomation}
        onCloseAutomation={closeAutomation}
        showRelated={showRelated}
        onCloseRelated={closeRelated}
        linkedWork={linkedWork}
        showShare={showShare}
        onCloseShare={closeShare}
        onAccessChanged={lc.applySessionAccess}
      />
    </div>
  );
};

/** The annotated message's author, or null when it is not loaded (older history). */
