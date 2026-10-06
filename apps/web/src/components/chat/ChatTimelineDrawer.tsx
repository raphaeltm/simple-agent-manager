import {
  Button,
  Spinner,
  TimelineItem,
  TimelineSeparator,
  TimelineStem,
} from '@simple-agent-manager/ui';
import { AlignLeft, Check, Clock, MessageSquareQuote, X } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';

import { COMMENT_BUCKET_COLORS } from '../project-message-view/comments/comment-inbox';
import type { TimelineEntry, TimelineJumpTarget } from '../project-message-view/timeline-types';
import { useDialogFocusTrap } from './useDialogFocusTrap';

const SEVERITY_COLORS: Record<string, string> = {
  info: '#3b82f6',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
};

const DOT_COLOR_USER = '#22c55e';
const DOT_COLOR_PROGRESS = '#60a5fa';

// Comment dots key to the triage BUCKET rather than the raw status, and reuse
// the inbox's own token map, so the timeline and the comments drawer cannot
// disagree about the same thread. Tokens rather than hex literals also means
// they re-theme in light mode, which the surrounding hardcoded dot colours
// above (pre-existing) do not.

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface ChatTimelineDrawerProps {
  entries: TimelineEntry[];
  loading: boolean;
  showContext: boolean;
  onToggleContext: () => void;
  onClose: () => void;
  onJump: (target: TimelineJumpTarget) => void;
}

export function ChatTimelineDrawer({
  entries,
  loading,
  showContext,
  onToggleContext,
  onClose,
  onJump,
}: ChatTimelineDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);

  const renderEntry = useCallback(
    (index: number, entry: TimelineEntry) => (
      <TimelineEntryRow
        entry={entry}
        previousEntry={index > 0 ? entries[index - 1] : undefined}
        onJump={onJump}
      />
    ),
    [entries, onJump]
  );

  return createPortal(
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
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
            aria-pressed={showContext}
            className={showContext ? 'text-fg-primary' : 'text-fg-muted'}
          >
            <AlignLeft size={14} className="mr-1" />
            Context
          </Button>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close timeline"
          >
            <X size={16} />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 min-h-0 px-3">
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-8 text-fg-muted text-sm">No timeline entries yet</div>
          ) : (
            // The stem sits on a wrapper AROUND the scroller rather than on
            // Virtuoso's own List slot. Wrapping the rows in an extra element
            // inside `components.List` breaks Virtuoso's height measurement —
            // it then renders a single row into a full-height panel.
            //
            // Consequence worth knowing: the stem's gradient fade is now
            // anchored to the visible panel rather than to the ends of the full
            // scrollable list. The base colour is very low-alpha, so the
            // difference is subtle, but it is a real semantic change and not
            // merely a refactor.
            <div className="relative h-full py-3">
              <TimelineStem />
              <Virtuoso
                data={entries}
                style={{ height: '100%' }}
                overscan={TIMELINE_OVERSCAN_PX}
                itemContent={renderEntry}
              />
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}

/**
 * Overscan (px) for the virtualized timeline. Matches the message list's budget
 * so both scrollers keep a comparable off-screen buffer.
 */
const TIMELINE_OVERSCAN_PX = 200;

/** One virtualized timeline row, including its date separator when the day changes. */
function TimelineEntryRow({
  entry,
  previousEntry,
  onJump,
}: Readonly<{
  entry: TimelineEntry;
  previousEntry: TimelineEntry | undefined;
  onJump: (target: TimelineJumpTarget) => void;
}>) {
  // Insert date separator when the day changes. The separator belongs to the row
  // that starts the new day, so it stays correct under virtualization (a row is
  // rendered without its predecessors being mounted).
  const showDateSep =
    previousEntry !== undefined &&
    new Date(previousEntry.timestamp).toDateString() !== new Date(entry.timestamp).toDateString();
  const entryContent = renderTimelineEntryContent(entry, onJump);

  return (
    <div>
      {showDateSep && (
        <TimelineSeparator
          label={new Date(entry.timestamp).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
          })}
        />
      )}
      {entryContent}
    </div>
  );
}

function renderTimelineEntryContent(entry: TimelineEntry, onJump: (target: TimelineJumpTarget) => void) {
  switch (entry.kind) {
    case 'user_message':
      return (
        <TimelineItem dot={{ color: DOT_COLOR_USER }}>
          <button
            type="button"
            className="w-full text-left py-1.5 px-1 rounded hover:bg-bg-hover transition-colors group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => onJump({ messageId: entry.messageId, timestamp: entry.timestamp })}
          >
            <div className="text-xs text-fg-muted mb-0.5">{formatTime(entry.timestamp)}</div>
            <div className="text-sm text-fg-primary leading-snug line-clamp-2 group-hover:text-fg-accent transition-colors">
              {entry.text}
            </div>
          </button>
        </TimelineItem>
      );

    case 'comment_thread':
      return (
        <TimelineItem
          dot={{
            color: COMMENT_BUCKET_COLORS[entry.bucket],
            muted: entry.bucket === 'resolved',
          }}
        >
          <button
            type="button"
            aria-label={`Jump to the message ${entry.actorName} commented on`}
            data-timeline-comment-id={entry.threadId}
            className="w-full text-left py-1.5 px-1 rounded hover:bg-bg-hover transition-colors group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => onJump({ messageId: entry.messageId, timestamp: entry.timestamp })}
          >
            <div className="text-xs text-fg-muted mb-0.5">{formatTime(entry.timestamp)}</div>
            {/*
              Not uppercased, unlike the fixed "Status update" eyebrow above:
              this one contains a person's name, and a full name in caps reads
              as shouting rather than as a label.
            */}
            <div className="flex items-center gap-1 text-[11px] mb-1 text-fg-muted">
              <MessageSquareQuote size={11} className="shrink-0" />
              <span className="truncate">
                {entry.actorName} {entry.isReply ? 'replied' : 'commented'}
              </span>
              {entry.status === 'resolved' && <Check size={11} className="shrink-0" />}
            </div>
            {entry.quote && (
              <div className="mb-1 border-l-2 border-tn-blue pl-2 text-xs italic text-fg-muted line-clamp-1">
                {entry.quote}
              </div>
            )}
            <div className="text-sm text-fg-primary leading-snug line-clamp-2 group-hover:text-fg-accent transition-colors">
              {entry.text}
            </div>
            {entry.replyCount > 0 && (
              <div className="mt-0.5 text-[11px] text-fg-muted">
                {entry.replyCount} {entry.replyCount === 1 ? 'reply' : 'replies'}
              </div>
            )}
          </button>
        </TimelineItem>
      );

    case 'progress_notification':
      return (
        <TimelineItem dot={{ color: DOT_COLOR_PROGRESS, muted: true }}>
          <button
            type="button"
            aria-label={`Jump to conversation near status update: ${entry.title}`}
            className="w-full text-left py-1.5 px-1 rounded hover:bg-bg-hover transition-colors group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => onJump({ timestamp: entry.timestamp })}
          >
            <div className="text-xs text-fg-muted mb-0.5">{formatTime(entry.timestamp)}</div>
            <div className="text-[11px] uppercase text-fg-muted mb-1">Status update</div>
            <div className="text-sm text-fg-primary leading-snug line-clamp-3 group-hover:text-fg-accent transition-colors">
              {entry.text}
            </div>
          </button>
        </TimelineItem>
      );

    case 'system_event':
      return (
        <TimelineItem
          dot={{
            color: SEVERITY_COLORS[entry.severity] ?? SEVERITY_COLORS.info,
            muted: entry.severity === 'info',
          }}
        >
          <button
            type="button"
            aria-label={`Jump to conversation near activity: ${entry.title}`}
            className="w-full text-left py-1.5 px-1 rounded hover:bg-bg-hover transition-colors group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => onJump({ timestamp: entry.timestamp })}
          >
            <div className="text-xs text-fg-muted mb-0.5">{formatTime(entry.timestamp)}</div>
            <div className="text-xs text-fg-muted leading-snug group-hover:text-fg-accent transition-colors">
              {entry.title}
            </div>
          </button>
        </TimelineItem>
      );
  }
}
