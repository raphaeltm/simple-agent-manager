import { Button, Spinner } from '@simple-agent-manager/ui';
import { ChevronDown } from 'lucide-react';
import { type FC, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { ChatFilePanel } from '../chat/ChatFilePanel';
import { TruncatedSummary } from '../chat/TruncatedSummary';
import { AcpConversationItemView } from './AcpConversationItemView';
import { FollowUpInput } from './FollowUpInput';
import { AgentErrorBanner, ConnectionBanner } from './MessageBanners';
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
}

export const ProjectMessageView: FC<ProjectMessageViewProps> = ({
  projectId,
  sessionId,
  isProvisioning = false,
  onSessionMutated,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const lc = useSessionLifecycle(projectId, sessionId, isProvisioning, onSessionMutated);

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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Inline error when session already loaded */}
      {lc.error && lc.session && (
        <div className="px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs">
          {lc.error}
        </div>
      )}

      {/* Connection indicator (TDF-8) */}
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

      {/* ACP agent error / disconnect warning */}
      {lc.sessionState === 'active' && lc.connectionState === 'connected' && lc.session?.workspaceId &&
        !lc.agentSession.isAgentActive && !lc.agentSession.isConnecting && !isProvisioning && !lc.isResuming && (
        <AgentErrorBanner session={lc.agentSession.session} />
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

      {/* Messages area — virtualized */}
      {(() => {
        const acpItems = lc.agentSession.messages.items;
        const convertedItems = chatMessagesToConversationItems(lc.messages);

        const useFullAcpView = acpItems.length > 0 && !lc.committedToDoViewRef.current && (
          convertedItems.length === 0 || lc.agentSession.isPrompting || lc.acpGrace
        );

        const displayItems = useFullAcpView ? acpItems : convertedItems;

        if (displayItems.length === 0) {
          return (
            <div className="flex-1 min-h-0 flex items-center justify-center">
              <span className="text-fg-muted text-sm">
                {lc.sessionState === 'active' ? 'Waiting for messages...' : 'No messages in this session.'}
              </span>
            </div>
          );
        }

        return (
          <div className="flex-1 min-h-0 min-w-0 relative" role="log" aria-live="polite" aria-label="Conversation">
            <Virtuoso
              ref={virtuosoRef}
              key={useFullAcpView ? 'acp' : 'do'}
              style={{ height: '100%' }}
              data={displayItems}
              firstItemIndex={useFullAcpView ? 0 : lc.firstItemIndex}
              initialTopMostItemIndex={displayItems.length - 1}
              followOutput={(isAtBottom: boolean) => isAtBottom ? 'smooth' : false}
              alignToBottom
              atBottomThreshold={50}
              atBottomStateChange={(atBottom) => lc.setShowScrollButton(!atBottom)}
              overscan={200}
              itemContent={(_index, item) => (
                <div className="px-4 pb-3">
                  <AcpConversationItemView item={item} onFileClick={lc.session?.workspaceId && lc.sessionState === 'active' ? lc.handleFileClick : undefined} />
                </div>
              )}
              components={{
                Header: (!useFullAcpView && lc.hasMore) ? () => (
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
                className={`absolute right-4 z-10 flex items-center justify-center w-11 h-11 rounded-full border border-border-default bg-surface shadow-md cursor-pointer hover:bg-page transition-[bottom] duration-200 ${lc.agentSession.isPrompting ? 'bottom-14' : 'bottom-3'}`}
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} className="text-fg-muted" />
              </button>
            )}
          </div>
        );
      })()}

      {/* Agent working indicator */}
      {lc.agentSession.isPrompting && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border-default bg-surface shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Agent is working...</span>
          <button
            type="button"
            onClick={lc.agentSession.cancelPrompt}
            className="ml-auto px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer"
            style={{ color: 'var(--sam-color-danger)' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ACP connecting indicator */}
      {lc.agentSession.isConnecting && lc.session?.workspaceId && (
        <div className="flex items-center gap-2 px-4 py-1 border-t border-border-default bg-surface shrink-0">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Connecting to agent...</span>
        </div>
      )}

      {/* Input area — varies by session state */}
      {lc.sessionState === 'active' && (
        <FollowUpInput
          value={lc.followUp}
          onChange={lc.setFollowUp}
          onSend={lc.handleSendFollowUp}
          onUploadFiles={(files) => lc.handleUploadFiles(files)}
          sending={lc.sendingFollowUp}
          uploading={lc.uploading}
          placeholder="Send a message..."
          transcribeApiUrl={lc.transcribeApiUrl}
        />
      )}
      {lc.sessionState === 'idle' && (
        <FollowUpInput
          value={lc.followUp}
          onChange={lc.setFollowUp}
          onSend={lc.handleSendFollowUp}
          onUploadFiles={(files) => lc.handleUploadFiles(files)}
          sending={lc.sendingFollowUp}
          uploading={lc.uploading}
          placeholder="Send a message to resume the agent..."
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
