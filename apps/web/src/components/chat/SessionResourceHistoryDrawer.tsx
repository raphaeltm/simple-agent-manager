import { Spinner } from '@simple-agent-manager/ui';
import { Activity } from 'lucide-react';
import { lazy, Suspense, useRef } from 'react';

import { importWithRetry } from '../../lib/lazy-with-retry';
import { GlassSheet, GlassSheetHeader } from '../shell/GlassSheet';
import type { ResourceHistorySource } from './resource-timeline/resource-source';
import { useDialogFocusTrap } from './useDialogFocusTrap';

/** Loaded on first open so the chat route never downloads the charting code. */
const ResourceTimeline = lazy(() =>
  importWithRetry(() => import('./resource-timeline/ResourceTimeline')).then((module) => ({
    default: module.ResourceTimeline,
  }))
);

interface SessionResourceHistoryDrawerProps {
  source: ResourceHistorySource;
  onClose: () => void;
}

export function SessionResourceHistoryDrawer({ source, onClose }: SessionResourceHistoryDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);

  return (
    <GlassSheet
      label="Session resources"
      panelRef={panelRef}
      onBackdropClick={onClose}
      backdrop="desktop"
      mobile="full"
      widthClassName="w-full md:w-[min(460px,55vw)]"
      zClassName="z-50"
      backdropZClassName="z-40"
      animated={false}
    >
        <GlassSheetHeader
          icon={<Activity size={20} strokeWidth={1.75} />}
          title="Resources"
          onClose={onClose}
          closeLabel="Close resources"
        />

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-10">
                <Spinner size="sm" />
              </div>
            }
          >
            <ResourceTimeline source={source} />
          </Suspense>
        </div>
    </GlassSheet>
  );
}
