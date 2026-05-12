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
      className="mx-4 mb-2 px-3 py-2 rounded-md border flex items-start gap-2 text-sm"
      style={{
        backgroundColor: isFork
          ? 'var(--sam-color-info-tint)'
          : 'var(--sam-color-warning-tint)',
        borderColor: isFork
          ? 'color-mix(in srgb, var(--sam-color-info) 25%, transparent)'
          : 'color-mix(in srgb, var(--sam-color-warning, #f59e0b) 25%, transparent)',
      }}
    >
      <Icon
        size={14}
        className="shrink-0 mt-0.5"
        style={{
          color: isFork
            ? 'var(--sam-color-info)'
            : 'var(--sam-color-warning, #f59e0b)',
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-fg-primary text-xs">
          {isFork ? 'Forking from' : 'Retrying'}: {derived.parentSessionLabel}
        </div>
        {derived.parentBranch && (
          <div className="text-[11px] text-fg-muted font-mono truncate">
            Branch: {derived.parentBranch}
          </div>
        )}
        {derived.errorMessage && (
          <div
            className="text-[11px] mt-0.5"
            style={{ color: 'var(--sam-color-danger)' }}
          >
            Error: {derived.errorMessage}
          </div>
        )}
        {derived.summaryLoading && (
          <div className="flex items-center gap-1.5 mt-1 text-[11px] text-fg-muted">
            <Spinner size="sm" />
            Loading context...
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cancel fork/retry"
        className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded-sm transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
