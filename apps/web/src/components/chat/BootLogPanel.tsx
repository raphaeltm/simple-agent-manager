import { type FC, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { BootLogEntry } from '@simple-agent-manager/shared';
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
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className="fixed z-50 bg-canvas flex flex-col shadow-xl
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,50vw)]
          md:border-l md:border-border-default"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Boot logs"
      >
        {/* Header */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default bg-surface shrink-0 min-h-[44px]">
          <span className="sam-type-secondary font-medium text-fg-primary flex-1">
            Boot Logs
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close boot logs"
            className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
          >
            <X size={16} />
          </button>
        </header>

        {/* Log list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {logs.length === 0 ? (
            <p className="sam-type-secondary text-fg-muted text-center mt-8">
              Waiting for boot logs...
            </p>
          ) : (
            <BootLogList logs={logs} maxWidthClass="max-w-full" />
          )}
        </div>
      </div>
    </>
  );
};
