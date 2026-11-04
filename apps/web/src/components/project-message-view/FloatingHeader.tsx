import { classifyFailure } from '@simple-agent-manager/shared';
import { paneClassName } from '@simple-agent-manager/ui';

import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { TruncatedSummary } from '../chat/TruncatedSummary';
import { FailureCard } from '../debug/FailureCard';
import { SessionHeader } from './SessionHeader';
import type { useSessionLifecycle } from './useSessionLifecycle';
import type { SessionLinkedWork } from './useSessionLinkedWork';

interface FloatingHeaderProps {
  projectId: string;
  lc: ReturnType<typeof useSessionLifecycle>;
  onSessionMutated?: () => void;
  onOpenComments?: () => void;
  unresolvedCommentCount?: number;
  needsAttentionCommentCount?: number;
  sourceContext?: SessionSourceContext;
  onShowHierarchy?: (taskId: string) => void;
  /** Details-panel visibility, owned by `useSessionTools` alongside the tool rail. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  completeError?: string | null;
  onDismissCompleteError?: () => void;
  /** What this chat is related to — the header's "Working on" chip and the PR's state. */
  linkedWork?: SessionLinkedWork | null;
}

/** Floating session header with optional error banner and summary. */
export function FloatingHeader({
  projectId,
  lc,
  onSessionMutated,
  onOpenComments,
  unresolvedCommentCount,
  needsAttentionCommentCount,
  sourceContext,
  onShowHierarchy,
  expanded,
  onExpandedChange,
  completeError,
  onDismissCompleteError,
  linkedWork,
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
  // A diagnosable failure lights the slab's lower edge red, the way the session slab's lower
  // edge is lit green. The shell scrolls itself so a long report cannot push the
  // conversation off screen.
  // The failure card scrolls, so it gives up height before the session header does, down to
  // its first line.
  const failureShellClassName = `${paneClassName('slab')} min-h-11 max-h-[40vh] shrink overflow-y-auto px-3 py-2 ${
    failureClassification?.diagnosable
      ? 'shadow-[inset_0_-1px_0_var(--sam-danger-edge),var(--sam-glass-v2-depth-slab)]'
      : ''
  }`;

  return (
    <div
      // Shrinks (with the details panel scrolling inside the slab) rather than squeezing the
      // conversation below its minimum height on a short phone screen.
      className="relative z-10 flex min-h-0 shrink flex-col gap-2"
      data-testid="session-floating-header"
      data-immersive-chrome="session-header"
    >
      <SessionHeader
        projectId={projectId}
        session={lc.session}
        sessionState={lc.sessionState}
        idleCountdownMs={lc.idleCountdownMs}
        taskEmbed={lc.taskEmbed}
        workspace={lc.workspace}
        node={lc.node}
        detectedPorts={lc.detectedPorts}
        onSessionMutated={onSessionMutated}
        onOpenComments={onOpenComments}
        unresolvedCommentCount={unresolvedCommentCount}
        needsAttentionCommentCount={needsAttentionCommentCount}
        lineageText={sourceContext?.lineageText}
        initialPromptFallback={initialPromptFallback}
        sourceContext={sourceContext}
        onShowHierarchy={onShowHierarchy}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        completeError={completeError}
        onDismissCompleteError={onDismissCompleteError}
        linkedWork={linkedWork}
      />
      {lc.taskEmbed?.errorMessage && (
        <div data-testid="failure-card-shell" className={failureShellClassName}>
          <FailureCard
            projectId={projectId}
            taskEmbed={lc.taskEmbed}
            sessionId={lc.session?.id}
            workspaceId={lc.workspace?.id ?? lc.session?.workspaceId}
            nodeId={lc.node?.id ?? lc.workspace?.nodeId}
            recoverable={hasRecoverableTaskError}
            isSessionCreator={lc.session.isMine === true}
          />
        </div>
      )}
      {lc.taskEmbed?.outputSummary && (
        <TruncatedSummary summary={lc.taskEmbed.outputSummary} taskId={lc.taskEmbed.id} />
      )}
    </div>
  );
}
