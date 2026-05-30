import type { BootLogEntry } from '@simple-agent-manager/shared';
import { X } from 'lucide-react';
import { type FC, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { BootLogList } from '../shared/BootLogList';

interface BootLogPanelProps {
  logs: BootLogEntry[];
  onClose: () => void;
}

/**
 * Slide-over drawer that shows real-time boot/provisioning logs.
 * Uses the same drawer pattern as ChatFilePanel.
 */
export const BootLogPanel: FC<BootLogPanelProps> = ({ logs, onClose }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Focus panel on mount for keyboard accessibility
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return createPortal(
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="glass-panel-container glass-composited fixed z-50 glass-modal rounded-l-[20px] rounded-r-none border-y-0 border-r-0 flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,50vw)]
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(34,197,94,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Boot logs"
      >
        {/* Header */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          <span className="sam-type-secondary font-medium text-fg-primary flex-1">
            Boot Logs
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close boot logs"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
          >
            <X size={16} />
          </button>
        </header>

        {/* Log list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 bg-canvas">
          {logs.length === 0 ? (
            <p className="sam-type-secondary text-fg-muted text-center mt-8">
              Waiting for boot logs...
            </p>
          ) : (
            <BootLogList logs={logs} maxWidthClass="max-w-full" />
          )}
        </div>
      </div>
    </>,
    document.body,
  );
};
