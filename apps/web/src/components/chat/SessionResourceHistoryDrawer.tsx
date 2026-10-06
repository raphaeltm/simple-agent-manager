import { Spinner } from '@simple-agent-manager/ui';
import { Activity, X } from 'lucide-react';
import { lazy, Suspense, useRef } from 'react';
import { createPortal } from 'react-dom';

import { importWithRetry } from '../../lib/lazy-with-retry';
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
  const panelRef = useRef<HTMLDialogElement>(null);
  useDialogFocusTrap(panelRef, onClose);

  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <dialog
        open
        className="glass-panel-container glass-composited fixed z-50 glass-modal m-0 box-border h-[100dvh] w-[100dvw] max-h-[100dvh] max-w-[100dvw] rounded-none border-0 p-0 text-inherit backdrop:bg-transparent flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:h-auto md:w-[min(460px,55vw)] md:max-w-[min(460px,55vw)] md:rounded-l-[20px] md:rounded-r-none md:border-y-0 md:border-r-0 md:border-l
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(96,165,250,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        ref={panelRef}
        tabIndex={-1}
        aria-modal="true"
        aria-label="Session resources"
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          <Activity size={16} className="text-fg-muted shrink-0" />
          <h2 className="text-sm font-medium text-fg-primary flex-1 min-w-0">Resources</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-surface-hover text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close resources"
          >
            <X size={16} />
          </button>
        </header>

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
      </dialog>
    </>,
    document.body
  );
}
