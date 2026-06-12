import { Button, Spinner, Timeline, TimelineItem, TimelineSeparator } from '@simple-agent-manager/ui';
import { AlignLeft, Clock, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { TimelineEntry } from '../project-message-view/timeline-types';

const SEVERITY_COLORS: Record<string, string> = {
  info: '#3b82f6',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
};

const DOT_COLOR_USER = '#22c55e';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface ChatTimelineDrawerProps {
  entries: TimelineEntry[];
  loading: boolean;
  showContext: boolean;
  onToggleContext: () => void;
  onClose: () => void;
  onJumpToMessage: (messageIndex: number) => void;
}

export function ChatTimelineDrawer({
  entries,
  loading,
  showContext,
  onToggleContext,
  onClose,
  onJumpToMessage,
}: ChatTimelineDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key closes the drawer
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Focus panel on mount
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return createPortal(
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className="glass-panel-container glass-composited fixed z-50 glass-modal rounded-l-[20px] rounded-r-none border-y-0 border-r-0 flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[min(400px,50vw)]
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(34,197,94,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Session timeline"
      >
        {/* Header */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          <Clock size={16} className="text-fg-muted shrink-0" />
          <h2 className="text-sm font-medium text-fg-primary flex-1 min-w-0">Timeline</h2>

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleContext}
            className={showContext ? 'text-fg-primary' : 'text-fg-muted'}
          >
            <AlignLeft size={14} className="mr-1" />
            Context
          </Button>

          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close timeline"
          >
            <X size={16} />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-3 min-h-0">
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-8 text-fg-muted text-sm">
              No timeline entries yet
            </div>
          ) : (
            <Timeline>
              {entries.map((entry, i) => {
                // Insert date separator when the day changes
                const prevEntry = i > 0 ? entries[i - 1] : null;
                const showDateSep =
                  prevEntry &&
                  new Date(prevEntry.timestamp).toDateString() !==
                    new Date(entry.timestamp).toDateString();

                return (
                  <div key={entry.id}>
                    {showDateSep && (
                      <TimelineSeparator
                        label={new Date(entry.timestamp).toLocaleDateString([], {
                          month: 'short',
                          day: 'numeric',
                        })}
                      />
                    )}
                    {entry.kind === 'user_message' ? (
                      <TimelineItem dot={{ color: DOT_COLOR_USER }}>
                        <button
                          type="button"
                          className="w-full text-left py-1.5 px-1 rounded hover:bg-bg-hover transition-colors group cursor-pointer"
                          onClick={() => onJumpToMessage(entry.messageIndex)}
                        >
                          <div className="text-xs text-fg-muted mb-0.5">
                            {formatTime(entry.timestamp)}
                          </div>
                          <div className="text-sm text-fg-primary leading-snug line-clamp-2 group-hover:text-fg-accent transition-colors">
                            {entry.text}
                          </div>
                        </button>
                      </TimelineItem>
                    ) : (
                      <TimelineItem
                        dot={{
                          color: SEVERITY_COLORS[entry.severity] ?? SEVERITY_COLORS.info,
                          muted: entry.severity === 'info',
                        }}
                      >
                        <div className="py-1.5 px-1">
                          <div className="text-xs text-fg-muted mb-0.5">
                            {formatTime(entry.timestamp)}
                          </div>
                          <div className="text-xs text-fg-muted leading-snug">
                            {entry.title}
                          </div>
                        </div>
                      </TimelineItem>
                    )}
                  </div>
                );
              })}
            </Timeline>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
