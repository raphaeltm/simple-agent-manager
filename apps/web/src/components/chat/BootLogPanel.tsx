import type { BootLogEntry } from '@simple-agent-manager/shared';
import { type FC, useEffect, useRef } from 'react';

import { BootLogList } from '../shared/BootLogList';
import { GlassSheet, GlassSheetHeader } from '../shell/GlassSheet';

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

  return (
    <GlassSheet
      label="Boot logs"
      panelRef={panelRef}
      onBackdropClick={onClose}
      backdrop="desktop"
      mobile="full"
      widthClassName="w-full md:w-[min(560px,50vw)]"
      zClassName="z-50"
      backdropZClassName="z-40"
      animated={false}
    >
      <GlassSheetHeader title="Boot Logs" onClose={onClose} closeLabel="Close boot logs" />

        {/* Log list */}
        <div ref={scrollRef} className="sam-well mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded-[14px] p-4">
          {logs.length === 0 ? (
            <p className="sam-type-secondary text-fg-muted text-center mt-8">
              Waiting for boot logs...
            </p>
          ) : (
            <BootLogList logs={logs} maxWidthClass="max-w-full" />
          )}
        </div>
    </GlassSheet>
  );
};
