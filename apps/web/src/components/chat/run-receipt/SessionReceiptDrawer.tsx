/**
 * The chat tool rail's "Receipt" panel (Insights slice R): a side panel on desktop, a full sheet
 * on a phone. Reads the task's Run receipt, plus the session resource timeline index the
 * Resources panel already caches, for the CPU line.
 */
import { Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useMemo, useRef } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { runReceiptQueryOptions } from '../../../lib/query-options';
import { GlassSheet, GlassSheetHeader } from '../../shell/GlassSheet';
import { apiResourceHistorySource } from '../resource-timeline/resource-source';
import { useResourceTimelineIndex } from '../resource-timeline/useResourceTimelineData';
import { useDialogFocusTrap } from '../useDialogFocusTrap';
import { RunReceiptView } from './RunReceiptView';

interface SessionReceiptDrawerProps {
  projectId: string;
  sessionId: string;
  taskId: string;
  onClose: () => void;
}

function ErrorState({ onRetry, retrying }: Readonly<{ onRetry: () => void; retrying: boolean }>) {
  return (
    <div className="px-1 py-8 text-center" role="alert" data-testid="run-receipt-error">
      <p className="m-0 text-sm font-semibold text-fg-primary">Couldn&apos;t load the receipt</p>
      <p className="m-0 mt-1.5 text-[13px] text-fg-muted">
        The rest of the chat is unaffected. Try again in a moment.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-3 inline-flex disabled:cursor-default disabled:opacity-70 min-h-11 cursor-pointer items-center rounded-md border border-border-default bg-transparent px-3 text-xs font-medium text-fg-primary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
      >
        {retrying ? 'Trying…' : 'Try again'}
      </button>
    </div>
  );
}

export function SessionReceiptDrawer({
  projectId,
  sessionId,
  taskId,
  onClose,
}: SessionReceiptDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);
  const queryScope = useQueryScope();
  const receipt = useQuery({
    ...runReceiptQueryOptions(queryScope, projectId, taskId),
    enabled: Boolean(queryScope),
  });
  // Same source and cache key as the Resources panel, so opening both reads the index once.
  const resourceSource = useMemo(
    () => apiResourceHistorySource(projectId, sessionId),
    [projectId, sessionId]
  );
  const resourceIndex = useResourceTimelineIndex(resourceSource);

  return (
    <GlassSheet
      label="Run receipt"
      panelRef={panelRef}
      onBackdropClick={onClose}
      backdrop="desktop"
      mobile="full"
      widthClassName="w-full md:w-[440px] lg:w-[480px]"
      zClassName="z-50"
      backdropZClassName="z-40"
      animated={false}
      testId="session-receipt-drawer"
    >
      <GlassSheetHeader
        icon={<ReceiptText size={20} strokeWidth={1.75} />}
        title="Receipt"
        onClose={onClose}
        closeLabel="Close receipt"
      />
      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Spinner only before the first result; a refetch keeps the receipt on screen
            (`.claude/rules/48-stale-while-revalidate-ui.md`). */}
        {receipt.data ? (
          <RunReceiptView
            receipt={receipt.data}
            resourceIndex={resourceIndex.data}
            cpuHistory={resourceIndex.data ? 'ready' : resourceIndex.isError ? 'error' : 'loading'}
          />
        ) : receipt.isError ? (
          <ErrorState onRetry={() => void receipt.refetch()} retrying={receipt.isFetching} />
        ) : (
          <div className="flex items-center justify-center py-10" data-testid="run-receipt-loading">
            <Spinner size="sm" />
          </div>
        )}
      </div>
    </GlassSheet>
  );
}
