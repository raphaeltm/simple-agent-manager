import { Spinner } from '@simple-agent-manager/ui';
import { GitFork, RotateCcw, X } from 'lucide-react';

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
    <div
      role="status"
      aria-live="polite"
      className={`mx-4 mb-2 px-3 py-2 rounded-md border flex items-start gap-2 text-sm ${
        isFork
          ? 'bg-info-tint border-info/25'
          : 'bg-warning-tint border-warning/25'
      }`}
    >
      <Icon
        size={14}
        className={`shrink-0 mt-0.5 ${isFork ? 'text-info' : 'text-warning'}`}
      />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-fg-primary text-xs">
          {isFork ? 'Forking from' : 'Retrying'}: {derived.parentSessionLabel}
        </div>
        {derived.parentBranch && (
          <div className="text-xs text-fg-muted font-mono truncate">
            Branch: {derived.parentBranch}
          </div>
        )}
        {derived.errorMessage && (
          <div className="text-xs mt-0.5 text-danger">
            Error: {derived.errorMessage}
          </div>
        )}
        {derived.summaryLoading && (
          <div className="flex items-center gap-1.5 mt-1 text-xs text-fg-muted">
            <Spinner size="sm" />
            Loading context...
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cancel fork/retry"
        className="shrink-0 min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}
