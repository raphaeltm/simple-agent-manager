/**
 * ProjectMessageView — DO-only chat component for project sessions.
 *
 * All messages flow through a single source: the Durable Object WebSocket.
 * Prompts are sent via the REST API. Agent state is derived from message flow.
 * TypewriterText animates the latest assistant message; historical messages
 * render instantly.
 */
import type {
  ConversationItem,
  PlanItem,
  SlashCommand,
  ToolCallContentItem,
} from '@simple-agent-manager/acp-client';
import { mapToolCallContent, PlanModal } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { ChevronDown } from 'lucide-react';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { getMessageToolContent } from '../../lib/api/sessions';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { ChatFilePanel } from '../chat/ChatFilePanel';
import { ChatTimelineDrawer } from '../chat/ChatTimelineDrawer';
import { TruncatedSummary } from '../chat/TruncatedSummary';
import { AcpConversationItemView } from './AcpConversationItemView';
import { CompletionDock } from './CompletionDock';
import { FollowUpInput, ReadOnlyFollowUp } from './FollowUpInput';
import { ConnectionBanner } from './MessageBanners';
import { SessionHeader } from './SessionHeader';
import type { TimelineJumpTarget } from './timeline-types';
import { chatMessagesToConversationItems } from './types';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionTimeline } from './useSessionTimeline';

/**
 * Resolve the id of the loaded conversation item nearest to (at or just before)
 * a timestamp. Used to anchor timeline entries that have no exact message id
 * (status updates, activity events) to a message in the list.
 */
function nearestItemId(items: ConversationItem[], timestamp: number): string | undefined {
  if (items.length === 0) return undefined;
  let candidateId = items[0]!.id;
  for (const item of items) {
    const ts = 'timestamp' in item && typeof item.timestamp === 'number' ? item.timestamp : 0;
    if (ts <= timestamp) candidateId = item.id;
    else break;
  }
  return candidateId;
}

// Re-export utilities used by external consumers
export { chatMessagesToConversationItems, groupMessages } from './types';

/**
 * Measures the floating header's rendered height so the message list can pad
 * itself by the real value. The header stack (title wrapping to two lines,
 * status badges, error banner, output summary) varies from ~56px to several
 * hundred px — a fixed spacer leaves messages hidden behind the glass.
 */
function useFloatingHeaderHeight(): [(el: HTMLDivElement | null) => void, number] {
  // Callback ref (not useRef + mount effect): FloatingHeader renders null until
  // the session loads, so the element attaches AFTER mount — an []-deps effect
  // would run before the ref exists and never observe anything.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(56);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setHeight((prev) => {
        const next = Math.ceil(el.getBoundingClientRect().height);
        return next > 0 && next !== prev ? next : prev;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, height];
}

/** Floating session header with optional error banner and summary. */
function FloatingHeader({
  projectId,
  lc,
  onSessionMutated,
  onRetry,
  onFork,
  onOpenTimeline,
  sourceContext,
  onShowHierarchy,
  containerRef,
}: {
  projectId: string;
  lc: ReturnType<typeof useSessionLifecycle>;
  onSessionMutated?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
  onOpenTimeline?: () => void;
  sourceContext?: SessionSourceContext;
  onShowHierarchy?: (taskId: string) => void;
  containerRef?: (el: HTMLDivElement | null) => void;
}) {
  if (!lc.session) return null;
  const initialPromptFallback = !lc.hasMore
    ? (lc.messages.find((msg) => msg.role === 'user')?.content ?? null)
    : null;
  const taskStatus = lc.taskEmbed?.status;
  const hasRecoverableTaskError = Boolean(
    lc.taskEmbed?.errorMessage &&
    lc.taskEmbed?.taskMode === 'conversation' &&
    taskStatus !== 'failed' &&
    taskStatus !== 'cancelled' &&
    taskStatus !== 'completed'
  );

  return (
    <div ref={containerRef} className="absolute top-0 left-0 right-0 z-10">
      <SessionHeader
        projectId={projectId}
        session={lc.session}
        sessionState={lc.sessionState}
        loading={lc.loading}
        idleCountdownMs={lc.idleCountdownMs}
        taskEmbed={lc.taskEmbed}
        workspace={lc.workspace}
        node={lc.node}
        detectedPorts={lc.detectedPorts}
        onSessionMutated={onSessionMutated}
        onOpenFiles={lc.handleOpenFileBrowser}
        onOpenGit={lc.handleOpenGitChanges}
        onOpenTimeline={onOpenTimeline}
        onRetry={onRetry}
        onFork={onFork}
        lineageText={sourceContext?.lineageText}
        initialPromptFallback={initialPromptFallback}
        sourceContext={sourceContext}
        hasContentBelow={!!lc.taskEmbed?.errorMessage}
        onShowHierarchy={onShowHierarchy}
      />
      {lc.taskEmbed?.errorMessage && (
        <ErrorBanner message={lc.taskEmbed.errorMessage} recoverable={hasRecoverableTaskError} />
      )}
      {lc.taskEmbed?.outputSummary && (
        <TruncatedSummary summary={lc.taskEmbed.outputSummary} taskId={lc.taskEmbed.id} />
      )}
    </div>
  );
}

/** Glass-chrome error banner with red accents, used below the session header. */
function ErrorBanner({ message, recoverable }: { message: string; recoverable: boolean }) {
  return (
    <div
      className="glass-chrome px-4 py-2 rounded-b-2xl relative after:content-[''] after:absolute after:bottom-0 after:left-[8%] after:right-[8%] after:h-[3px] after:bg-[radial-gradient(ellipse_at_center,rgba(239,68,68,0.55)_0%,transparent_70%)] after:blur-[2px] after:pointer-events-none after:z-10"
      style={{
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(239, 68, 68, 0.08)',
      }}
    >
      {/* Same opacity scrim as SessionHeader — backdrop blur does not sample
          the composited message scroller, so rely on opacity for legibility. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-[inherit] -z-10 pointer-events-none"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas) 78%, transparent)',
        }}
      />
      <span className="sam-type-caption text-danger font-medium">
        {recoverable ? 'Agent error:' : 'Task failed:'}
      </span>{' '}
      <span className="sam-type-caption text-danger break-words">{message}</span>
      {recoverable && (
        <span className="sam-type-caption text-danger break-words">
          {' '}
          You can send another message to retry; your session and workspace are preserved.
        </span>
      )}
    </div>
  );
}

/** Convert session state plan array to PlanItem for the CompletionDock plan pill / PlanModal. */
function currentPlanToPlanItem(plan: Array<{ content: string; status: string }>): PlanItem {
  return {
    kind: 'plan',
    id: 'session-plan',
    entries: plan.map((e) => ({
      content: e.content,
      priority: 'medium' as const,
      status: (e.status === 'completed'
        ? 'completed'
        : e.status === 'in_progress'
          ? 'in_progress'
          : 'pending') as 'pending' | 'in_progress' | 'completed',
    })),
    timestamp: Date.now(),
  };
}

/** Live elapsed-time display since prompt started. */
const ElapsedTime: FC<{ startedAt: number }> = ({ startedAt }) => {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    const update = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      setElapsed(m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return (
    <span className="text-xs text-fg-muted tabular-nums" aria-hidden="true">
      ({elapsed})
    </span>
  );
};

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
  /** Called when the user clicks "End session" on an idle conversation-mode session. */
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
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
  isProvisioning = false,
  onSessionMutated,
  onRetry,
  onFork,
  sourceContext,
  onCloseConversation,
  closingConversation,
  closeError,
  agentProfiles = [],
  slashCommands = [],
  onShowHierarchy,
  onNewChat,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [floatingHeaderRef, floatingHeaderHeight] = useFloatingHeaderHeight();
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  const lc = useSessionLifecycle(projectId, sessionId, isProvisioning, onSessionMutated);

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

  const timeline = useSessionTimeline(projectId, sessionId, lc.messages, showTimeline);

  // Jump-to-message from the timeline. A jump targets either an exact message
  // (user message) or the nearest message to a timestamp (status/activity
  // entries). Because the full conversation loads on open, the target is almost
  // always already rendered. For the rare oversized/guard-trimmed session the
  // target may predate the loaded window — we set a pending jump and load older
  // pages until it resolves, so a jump never dead-clicks.
  const [pendingJump, setPendingJump] = useState<TimelineJumpTarget | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

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

  const planItem = useMemo(
    () =>
      lc.currentPlan && lc.currentPlan.length > 0 ? currentPlanToPlanItem(lc.currentPlan) : null,
    [lc.currentPlan]
  );
  const canWriteSession = lc.session?.isMine !== false;
  const sessionOwnerLabel =
    lc.session?.createdBy?.name?.trim() ||
    lc.session?.createdBy?.email?.split('@')[0] ||
    'the creator';
  const canArchiveSession = Boolean(
    onCloseConversation &&
    (lc.taskEmbed?.taskMode === 'conversation' ||
      (!lc.taskEmbed?.id && lc.session?.status === 'active'))
  );

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

  const isActive = lc.sessionState === 'active' || lc.sessionState === 'idle';

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

      {/* Resume error banner */}
      {lc.resumeError && (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs"
        >
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            {lc.resumeError}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer hover:bg-surface-raised"
            onClick={lc.clearResumeError}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Messages area — virtualized, DO-only */}
      {conversationItems.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col relative">
          <FloatingHeader
            projectId={projectId}
            lc={lc}
            onSessionMutated={onSessionMutated}
            onRetry={onRetry}
            onFork={onFork}
            onOpenTimeline={() => setShowTimeline(true)}
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
      ) : (
        <div
          className="flex-1 min-h-0 min-w-0 relative flex flex-col"
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
              itemContent={(index, item) => (
                <div
                  className={`sam-message-entry px-4 pb-3${highlightedItemId === item.id ? ' sam-message-highlight' : ''}`}
                >
                  <AcpConversationItemView
                    item={item}
                    projectId={projectId}
                    onFileClick={
                      lc.session?.workspaceId && lc.sessionState === 'active'
                        ? lc.handleFileClick
                        : undefined
                    }
                    onLoadToolContent={handleLoadToolContent}
                    animateText={
                      item.kind === 'agent_message' &&
                      index - lc.firstItemIndex === animationTargetIdx &&
                      lc.agentActivity === 'responding'
                    }
                    animateUserMessage={
                      item.kind === 'user_message' && animatedUserMsgIds.has(item.id)
                    }
                  />
                </div>
              )}
              components={{
                Header: () => (
                  <>
                    {/* Spacer for absolutely-positioned FloatingHeader so messages aren't hidden
                        behind it — tracks the measured header height (title wrap, badges, error
                        banner, and summary all change it). The extra 8px keeps the first message
                        clear of the glass edge. */}
                    <div style={{ height: floatingHeaderHeight + 8 }} />
                    {lc.hasMore && (
                      <div className="text-center py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={lc.loadMore}
                          loading={lc.loadingMore}
                        >
                          Load earlier messages
                        </Button>
                      </div>
                    )}
                  </>
                ),
              }}
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
        </div>
      )}

      {/* Lifecycle control — a single always-mounted dock while the session is
          active. Its center button morphs between a red Interrupt (working) and
          a grey Archive (idle), so the control never disappears even when the
          `agentActivity` signal is stale. Archive is wired for
          conversation-mode tasks and taskless instant sessions the caller can close. */}
      {isActive && canWriteSession && (canArchiveSession || lc.agentActivity !== 'idle') && (
        <CompletionDock
          working={lc.agentActivity !== 'idle'}
          hasPlan={!!planItem}
          onInterrupt={lc.handleCancelPrompt}
          onArchive={() => onCloseConversation?.()}
          onOpenPlan={() => setShowPlanModal(true)}
          archiving={closingConversation}
          archiveError={closeError}
          elapsed={lc.promptStartedAt ? <ElapsedTime startedAt={lc.promptStartedAt} /> : undefined}
        />
      )}
      {planItem && (
        <PlanModal plan={planItem} isOpen={showPlanModal} onClose={() => setShowPlanModal(false)} />
      )}

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
            lc.agentActivity === 'prompting' || lc.agentActivity === 'responding'
              ? 'Agent is working...'
              : lc.sessionState === 'idle'
                ? 'Send a message to resume the agent...'
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

      {/* Timeline drawer */}
      {showTimeline && (
        <ChatTimelineDrawer
          entries={timeline.entries}
          loading={timeline.loading}
          showContext={timeline.showContext}
          onToggleContext={() => timeline.setShowContext(!timeline.showContext)}
          onClose={() => setShowTimeline(false)}
          onJump={handleTimelineJump}
        />
      )}
    </div>
  );
};
