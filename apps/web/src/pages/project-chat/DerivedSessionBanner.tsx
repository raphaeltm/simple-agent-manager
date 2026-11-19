import { Spinner } from '@simple-agent-manager/ui';
import { GitFork, RotateCcw } from 'lucide-react';

import { NoticeMeta, NoticeSlab, NoticeTextButton } from '../../components/chat-notices/NoticeSlab';
import type { PendingDerived } from './useProjectChatState';

export function DerivedSessionBanner({
  derived,
  onDismiss,
}: {
  derived: PendingDerived;
  onDismiss: () => void;
}) {
  const isFork = derived.type === 'fork';
  const Icon = isFork ? GitFork : RotateCcw;

  return (
    <div role="status" aria-live="polite" className="shrink-0">
      <NoticeSlab
        tone={isFork ? 'info' : 'warning'}
        icon={<Icon size={15} />}
        title={`${isFork ? 'Forking from' : 'Retrying'}: ${derived.parentSessionLabel}`}
        meta={derived.parentBranch ? <NoticeMeta>Branch: {derived.parentBranch}</NoticeMeta> : null}
        detail={
          derived.errorMessage || derived.promptLoading ? (
            <>
              {derived.errorMessage && (
                <span className="block text-[var(--sam-status-danger-fg)]">
                  Error: {derived.errorMessage}
                </span>
              )}
              {derived.promptLoading && (
                <span className="mt-1 flex items-center gap-1.5">
                  <Spinner size="sm" />
                  Loading original prompt...
                </span>
              )}
            </>
          ) : undefined
        }
        inlineActions
        actions={
          <NoticeTextButton onClick={onDismiss} aria-label="Cancel fork/retry">
            Cancel
          </NoticeTextButton>
        }
      />
    </div>
  );
}
