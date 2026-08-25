import { classifyFailure } from '@simple-agent-manager/shared';

import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { TruncatedSummary } from '../chat/TruncatedSummary';
import { FailureCard } from '../debug/FailureCard';
import { SessionHeader } from './SessionHeader';
import type { useSessionLifecycle } from './useSessionLifecycle';

interface FloatingHeaderProps {
  projectId: string;
  lc: ReturnType<typeof useSessionLifecycle>;
  onSessionMutated?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
  onOpenTimeline?: () => void;
  onOpenComments?: () => void;
  unresolvedCommentCount?: number;
  needsAttentionCommentCount?: number;
  sourceContext?: SessionSourceContext;
  onShowHierarchy?: (taskId: string) => void;
  containerRef?: (el: HTMLDivElement | null) => void;
}

/** Floating session header with optional error banner and summary. */
export function FloatingHeader({
  projectId,
  lc,
  onSessionMutated,
  onRetry,
  onFork,
  onOpenTimeline,
  onOpenComments,
  unresolvedCommentCount,
  needsAttentionCommentCount,
  sourceContext,
  onShowHierarchy,
  containerRef,
}: FloatingHeaderProps) {
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
  const failureClassification = lc.taskEmbed?.errorMessage
    ? classifyFailure(lc.taskEmbed.errorMessage, lc.taskEmbed.executionStep ?? undefined)
    : null;
  const failureShellClassName = failureClassification?.diagnosable
    ? "glass-chrome px-3 py-2 rounded-b-2xl relative after:content-[''] after:absolute after:bottom-0 after:left-[8%] after:right-[8%] after:h-[3px] after:bg-[radial-gradient(ellipse_at_center,rgba(239,68,68,0.55)_0%,transparent_70%)] after:blur-[2px] after:pointer-events-none after:z-10"
    : 'glass-chrome px-3 py-2 rounded-b-2xl relative';
  const failureShellBoxShadow = failureClassification?.diagnosable
    ? '0 4px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(239, 68, 68, 0.08)'
    : '0 4px 24px rgba(0, 0, 0, 0.4)';

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
        onOpenComments={onOpenComments}
        unresolvedCommentCount={unresolvedCommentCount}
        needsAttentionCommentCount={needsAttentionCommentCount}
        onRetry={onRetry}
        onFork={onFork}
        lineageText={sourceContext?.lineageText}
        initialPromptFallback={initialPromptFallback}
        sourceContext={sourceContext}
        hasContentBelow={!!lc.taskEmbed?.errorMessage}
        onShowHierarchy={onShowHierarchy}
      />
      {lc.taskEmbed?.errorMessage && (
        <div
          data-testid="failure-card-shell"
          className={failureShellClassName}
          style={{ boxShadow: failureShellBoxShadow }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-[inherit] -z-10 pointer-events-none"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas) 78%, transparent)',
            }}
          />
          <FailureCard
            projectId={projectId}
            taskEmbed={lc.taskEmbed}
            sessionId={lc.session?.id}
            workspaceId={lc.workspace?.id ?? lc.session?.workspaceId}
            nodeId={lc.node?.id ?? lc.workspace?.nodeId}
            recoverable={hasRecoverableTaskError}
          />
        </div>
      )}
      {lc.taskEmbed?.outputSummary && (
        <TruncatedSummary summary={lc.taskEmbed.outputSummary} taskId={lc.taskEmbed.id} />
      )}
    </div>
  );
}
