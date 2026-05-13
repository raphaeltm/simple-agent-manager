/**
 * ProjectMessageView — DO-only chat component for project sessions.
 *
 * All messages flow through a single source: the Durable Object WebSocket.
 * Prompts are sent via the REST API. Agent state is derived from message flow.
 * TypewriterText animates the latest assistant message; historical messages
 * render instantly.
 */
import type { ConversationItem, ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { mapToolCallContent } from '@simple-agent-manager/acp-client';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { ChevronDown, Clock } from 'lucide-react';
import { type FC, useCallback, useMemo, useRef } from 'react';
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
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const lc = useSessionLifecycle(projectId, sessionId, isProvisioning, onSessionMutated);

  /** Lazy-load tool content for a compact-mode tool call card. */
  const handleLoadToolContent = useCallback(async (messageId: string): Promise<ToolCallContentItem[]> => {
    const { content } = await getMessageToolContent(projectId, sessionId, messageId);
    return (content as Array<{ type: string } & Record<string, unknown>>).map((c) => mapToolCallContent(c));
  }, [projectId, sessionId]);

  // Convert DO messages to conversation items (single source)
  const conversationItems = useMemo<ConversationItem[]>(() => {
    return chatMessagesToConversationItems(lc.messages);
  }, [lc.messages]);

  // Identify the last assistant message for TypewriterText animation
  const lastAssistantIdx = useMemo(() => {
    for (let i = conversationItems.length - 1; i >= 0; i--) {
      if (conversationItems[i]?.kind === 'agent_message') return i;
    }
    return -1;
  }, [conversationItems]);

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

      {/* Session header */}
      {lc.session && (
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
        />
      )}

      {/* Task error/summary display */}
      {lc.taskEmbed?.errorMessage && (
        <div className="px-4 py-2 bg-danger-tint border-b border-border-default">
          <span className="sam-type-caption text-danger font-medium">Task failed:</span>{' '}
          <span className="sam-type-caption text-danger break-words">{lc.taskEmbed.errorMessage}</span>
        </div>
      )}
      {lc.taskEmbed?.outputSummary && (
        <TruncatedSummary summary={lc.taskEmbed.outputSummary} taskId={lc.taskEmbed.id} />
      )}

      {/* Messages area — virtualized, DO-only */}
      {conversationItems.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="text-fg-muted text-sm">
            {lc.sessionState === 'active' ? 'Waiting for messages...' : 'No messages in this session.'}
          </span>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 relative" role="log" aria-live="polite" aria-label="Conversation">
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
              <div className="px-4 pb-3">
                <AcpConversationItemView
                  item={item}
                  onFileClick={lc.session?.workspaceId && lc.sessionState === 'active' ? lc.handleFileClick : undefined}
                  onLoadToolContent={handleLoadToolContent}
                  animateText={item.kind === 'agent_message' && index === lastAssistantIdx && lc.agentActivity === 'responding'}
                />
              </div>
            )}
            components={{
              Header: lc.hasMore ? () => (
                <div className="text-center py-3">
                  <Button variant="ghost" size="sm" onClick={lc.loadMore} loading={lc.loadingMore}>
                    Load earlier messages
                  </Button>
                </div>
              ) : undefined,
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
              className={`absolute right-4 z-10 flex items-center justify-center w-11 h-11 rounded-full border border-border-default bg-surface shadow-md cursor-pointer hover:bg-page transition-[bottom] duration-200 ${lc.agentActivity !== 'idle' ? 'bottom-14' : 'bottom-3'}`}
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

      {/* Agent working indicator */}
      {lc.agentActivity !== 'idle' && isActive && (
        <div role="status" className="flex items-center gap-2 px-4 py-2 border-t border-border-default bg-surface shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Agent is working...</span>
          <button
            type="button"
            onClick={lc.handleCancelPrompt}
            aria-label="Cancel agent"
            className="ml-auto flex-shrink-0 px-2 py-2.5 min-h-[44px] text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer text-danger hover:bg-danger-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Cancel
          </button>
        </div>
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
