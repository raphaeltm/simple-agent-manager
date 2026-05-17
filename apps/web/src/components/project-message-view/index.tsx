/**
 * ProjectMessageView — DO-only chat component for project sessions.
 *
 * All messages flow through a single source: the Durable Object WebSocket.
 * Prompts are sent via the REST API. Agent state is derived from message flow.
 * TypewriterText animates the latest assistant message; historical messages
 * render instantly.
 */
import type { ConversationItem, PlanItem, SlashCommand, ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { mapToolCallContent, PlanModal, StickyPlanButton } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { ChevronDown, Clock } from 'lucide-react';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { getMessageToolContent } from '../../lib/api/sessions';
import { ChatFilePanel } from '../chat/ChatFilePanel';
import { TruncatedSummary } from '../chat/TruncatedSummary';
import { AcpConversationItemView } from './AcpConversationItemView';
import { FollowUpInput } from './FollowUpInput';
import { ConnectionBanner } from './MessageBanners';
import { SessionHeader } from './SessionHeader';
import { chatMessagesToConversationItems } from './types';
import { useSessionLifecycle } from './useSessionLifecycle';

// Re-export utilities used by external consumers
export { chatMessagesToConversationItems, groupMessages } from './types';

/** Floating session header with optional error banner and summary. */
function FloatingHeader({
  projectId, lc, onSessionMutated, onRetry, onFork, lineageText,
}: {
  projectId: string;
  lc: ReturnType<typeof useSessionLifecycle>;
  onSessionMutated?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
  lineageText?: string;
}) {
  if (!lc.session) return null;
  return (
    <div className="absolute top-0 left-0 right-0 z-10">
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
        onRetry={onRetry}
        onFork={onFork}
        lineageText={lineageText}
        hasContentBelow={!!lc.taskEmbed?.errorMessage}
      />
      {lc.taskEmbed?.errorMessage && (
        <ErrorBanner message={lc.taskEmbed.errorMessage} />
      )}
      {lc.taskEmbed?.outputSummary && (
        <TruncatedSummary summary={lc.taskEmbed.outputSummary} taskId={lc.taskEmbed.id} />
      )}
    </div>
  );
}

/** Glass-chrome error banner with red accents, used below the session header. */
function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="glass-chrome glass-composited px-4 py-2 rounded-b-2xl relative after:content-[''] after:absolute after:bottom-0 after:left-[8%] after:right-[8%] after:h-[3px] after:bg-[radial-gradient(ellipse_at_center,rgba(239,68,68,0.55)_0%,transparent_70%)] after:blur-[2px] after:pointer-events-none after:z-10"
      style={{
        backgroundColor: 'rgba(15, 8, 8, 0.68)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(239, 68, 68, 0.08)',
      }}
    >
      <span className="sam-type-caption text-danger font-medium">Task failed:</span>{' '}
      <span className="sam-type-caption text-danger break-words">{message}</span>
    </div>
  );
}

/** Convert session state plan array to PlanItem for StickyPlanButton/PlanModal. */
function currentPlanToPlanItem(plan: Array<{ content: string; status: string }>): PlanItem {
  return {
    kind: 'plan',
    id: 'session-plan',
    entries: plan.map((e) => ({
      content: e.content,
      priority: 'medium' as const,
      status: (e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending') as 'pending' | 'in_progress' | 'completed',
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
  return <span className="text-xs text-fg-muted tabular-nums" aria-hidden="true">({elapsed})</span>;
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
  /** Lineage subtitle for retries/forks (e.g., "↩ attempt 3"). */
  lineageText?: string;
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
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
  isProvisioning = false,
  onSessionMutated,
  onRetry,
  onFork,
  lineageText,
  onCloseConversation,
  closingConversation,
  closeError,
  agentProfiles = [],
  slashCommands = [],
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);

  const lc = useSessionLifecycle(projectId, sessionId, isProvisioning, onSessionMutated);

  // Close plan modal when agent transitions to idle
  useEffect(() => {
    if (lc.agentActivity === 'idle') setShowPlanModal(false);
  }, [lc.agentActivity]);

  // Track IDs of user messages that should animate (freshly submitted optimistic messages)
  const [animatedUserMsgIds] = useState(() => new Set<string>());
  const prevMsgCountRef = useRef(0);

  /** Lazy-load tool content for a compact-mode tool call card. */
  const handleLoadToolContent = useCallback(async (messageId: string): Promise<ToolCallContentItem[]> => {
    const { content } = await getMessageToolContent(projectId, sessionId, messageId);
    return (content as Array<{ type: string } & Record<string, unknown>>).map((c) => mapToolCallContent(c));
  }, [projectId, sessionId]);

  // Convert DO messages to conversation items (single source)
  const conversationItems = useMemo<ConversationItem[]>(() => {
    return chatMessagesToConversationItems(lc.messages);
  }, [lc.messages]);

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
          setTimeout(() => { animatedUserMsgIds.delete(msg.id); }, 2000);
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
    () => lc.currentPlan && lc.currentPlan.length > 0 ? currentPlanToPlanItem(lc.currentPlan) : null,
    [lc.currentPlan],
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
    return (
      <div className="p-4 text-danger text-sm">
        {lc.error}
      </div>
    );
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
      {lc.sessionState === 'active' && lc.connectionState !== 'connected' && lc.showConnectionBanner && (
        <ConnectionBanner state={lc.connectionState} onRetry={lc.retryWs} />
      )}

      {/* Resuming agent banner */}
      {lc.isResuming && (
        <div role="status" aria-label="Agent resume status" className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-surface text-xs text-fg-muted">
          <Spinner size="sm" />
          <span>Resuming agent...</span>
          <button
            type="button"
            className="ml-auto px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer hover:bg-surface-raised"
            onClick={() => { lc.setError(null); }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Resume error banner */}
      {lc.resumeError && (
        <div role="alert" className="flex items-center gap-2 px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs">
          <span>{lc.resumeError}</span>
          <button
            type="button"
            className="ml-auto px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer hover:bg-surface-raised"
            onClick={() => { lc.setError(null); }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Messages area — virtualized, DO-only */}
      {conversationItems.length === 0 ? (
        <div className="flex-1 min-h-0 relative">
          <FloatingHeader projectId={projectId} lc={lc} onSessionMutated={onSessionMutated} onRetry={onRetry} onFork={onFork} lineageText={lineageText} />
          <div className="flex items-center justify-center h-full">
            <span className="text-fg-muted text-sm">
              {lc.sessionState === 'active' ? 'Waiting for messages...' : 'No messages in this session.'}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 relative" role="log" aria-live="polite" aria-label="Conversation">
          <FloatingHeader projectId={projectId} lc={lc} onSessionMutated={onSessionMutated} onRetry={onRetry} onFork={onFork} lineageText={lineageText} />
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={conversationItems}
            firstItemIndex={lc.firstItemIndex}
            initialTopMostItemIndex={conversationItems.length - 1}
            followOutput={(isAtBottom: boolean) => isAtBottom ? 'smooth' : false}
            alignToBottom
            atBottomThreshold={50}
            atBottomStateChange={(atBottom) => lc.setShowScrollButton(!atBottom)}
            overscan={200}
            itemContent={(index, item) => (
              <div className="sam-message-entry px-4 pb-3">
                <AcpConversationItemView
                  item={item}
                  onFileClick={lc.session?.workspaceId && lc.sessionState === 'active' ? lc.handleFileClick : undefined}
                  onLoadToolContent={handleLoadToolContent}
                  animateText={item.kind === 'agent_message' && (index - lc.firstItemIndex) === animationTargetIdx && lc.agentActivity === 'responding'}
                  animateUserMessage={item.kind === 'user_message' && animatedUserMsgIds.has(item.id)}
                />
              </div>
            )}
            components={{
              Header: () => (
                <div style={{ paddingTop: lc.session ? '48px' : undefined }}>
                  {lc.hasMore && (
                    <div className="text-center py-3">
                      <Button variant="ghost" size="sm" onClick={lc.loadMore} loading={lc.loadingMore}>
                        Load earlier messages
                      </Button>
                    </div>
                  )}
                </div>
              ),
            }}
          />

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
              className="sam-scroll-button absolute right-4 z-10 flex items-center justify-center w-11 h-11 rounded-full border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)] shadow-md cursor-pointer hover:bg-page"
              data-agent-active={lc.agentActivity !== 'idle'}
              aria-label="Scroll to bottom"
            >
              <ChevronDown size={16} className="text-fg-muted" />
            </button>
          )}
        </div>
      )}

      {/* Inline idle indicator — subtle "Agent idle | End session" for conversation-mode sessions */}
      {lc.sessionState === 'idle' && lc.taskEmbed?.taskMode === 'conversation' && onCloseConversation && (
        <div role="status" className="shrink-0 flex items-center gap-3 px-4 py-1.5 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} aria-hidden="true" style={{ color: 'var(--sam-color-warning)' }} />
            Agent idle
          </span>
          <span aria-hidden="true" style={{ color: 'var(--sam-color-border-default)' }}>|</span>
          <button
            type="button"
            onClick={onCloseConversation}
            disabled={closingConversation}
            className="min-h-[44px] flex items-center bg-transparent border-none text-xs cursor-pointer px-2 underline decoration-from-font underline-offset-2 text-fg-muted hover:text-fg-primary disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)] rounded-sm"
          >
            {closingConversation ? 'Ending...' : 'End session'}
          </button>
          {closeError && <span role="alert" className="text-danger text-xs">{closeError}</span>}
        </div>
      )}

      {/* Agent working indicator with plan button */}
      {lc.agentActivity !== 'idle' && isActive && (
        <div role="status" className="flex flex-wrap items-center gap-2 px-4 py-2 glass-chrome border-x-0 border-b-0 shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Agent is working...</span>
          {lc.promptStartedAt && <ElapsedTime startedAt={lc.promptStartedAt} />}
          {planItem && (
            <StickyPlanButton
              plan={planItem}
              onClick={() => setShowPlanModal(true)}
            />
          )}
          <button
            type="button"
            onClick={lc.handleCancelPrompt}
            aria-label="Cancel agent"
            className="ml-auto flex-shrink-0 px-2 py-2.5 min-h-[44px] text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer text-danger hover:bg-danger-tint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
          >
            Cancel
          </button>
        </div>
      )}
      {planItem && (
        <PlanModal
          plan={planItem}
          isOpen={showPlanModal}
          onClose={() => setShowPlanModal(false)}
        />
      )}

      {/* Input area */}
      {isActive && (
        <FollowUpInput
          value={lc.followUp}
          onChange={lc.setFollowUp}
          onSend={() => { void lc.handleSendFollowUp(); }}
          onUploadFiles={(files) => { void lc.handleUploadFiles(files); }}
          sending={lc.sendingFollowUp}
          uploading={lc.uploading}
          placeholder={lc.agentActivity === 'prompting' || lc.agentActivity === 'responding'
            ? 'Agent is working...'
            : lc.sessionState === 'idle'
              ? 'Send a message to resume the agent...'
              : 'Send a message...'}
          transcribeApiUrl={lc.transcribeApiUrl}
          agentProfiles={agentProfiles}
          slashCommands={slashCommands}
        />
      )}
      {lc.sessionState === 'terminated' && (
        <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface text-center">
          <span className="sam-type-secondary text-fg-muted">
            This session has ended.
          </span>
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
    </div>
  );
};
