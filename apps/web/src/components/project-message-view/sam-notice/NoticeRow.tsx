import type { SamNotice } from '@simple-agent-manager/shared';
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  GitPullRequest,
  Hourglass,
  Info,
  type LucideIcon,
  MessagesSquare,
  ShieldCheck,
  Sunrise,
  XCircle,
} from 'lucide-react';
import { memo, useCallback, useId, useState } from 'react';

import { NoticeRefCard } from './NoticeRefCard';
import { TaskQuickLookDialog } from './TaskQuickLookDialog';

const SEVERITY_COLOR: Record<SamNotice['severity'], string> = {
  success: 'var(--sam-status-success-fg)',
  error: 'var(--sam-status-danger-fg)',
  // Amber: reserved for notices that wait on the human (SAM Glass).
  warning: 'var(--sam-status-warning-fg)',
  info: 'var(--sam-color-fg-muted)',
};

function noticeIcon(notice: SamNotice): LucideIcon {
  const family = notice.type.split('.')[0];
  switch (family) {
    case 'subtask':
      return notice.severity === 'error' ? XCircle : CheckCircle2;
    case 'agent':
      return MessagesSquare;
    case 'ops':
      return ShieldCheck;
    case 'schedule':
      return CalendarClock;
    case 'github':
      return GitPullRequest;
    case 'session':
      return Sunrise;
    case 'checkin':
      return Hourglass;
    case 'event':
      return notice.severity === 'error' ? XCircle : Bell;
    default:
      return Info;
  }
}

/** A pull request number is the one reference worth naming on the collapsed row. */
function collapsedTag(notice: SamNotice): string | null {
  const pr = notice.refs.find((ref) => ref.kind === 'pull_request');
  if (!pr) return null;
  return /^\d+$/.test(pr.id) ? `#${pr.id}` : 'PR';
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface NoticeRowProps {
  notice: SamNotice;
  /** The transcript text: what the agent received, or a system row's full text. */
  rawText: string;
  rawLabel: string;
  timestamp: number;
  projectId?: string;
}

/**
 * A message SAM put in the chat, as one quiet line that expands on tap into the notice's
 * detail, any quoted text from outside SAM, a card per thing it refers to, and the raw text.
 */
function NoticeRowImpl({ notice, rawText, rawLabel, timestamp, projectId }: NoticeRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const bodyId = useId();
  const Icon = noticeIcon(notice);
  const tag = collapsedTag(notice);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const closeTask = useCallback(() => setOpenTaskId(null), []);
  // The quote is often exactly what the agent received (a peer's message), and a one-line
  // system row is its own headline; say each thing once.
  const raw = rawText.trim();
  const showRaw = raw !== '' && raw !== notice.quote?.text.trim() && raw !== notice.headline;

  return (
    <div className="min-w-0" data-testid="sam-notice-row" data-notice-type={notice.type}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="group flex w-full min-h-9 min-w-0 items-center gap-2.5 rounded-[12px] px-2 py-1 text-left transition-colors hover:bg-[var(--sam-glass-v2-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Icon
          size={16}
          strokeWidth={1.75}
          style={{ color: SEVERITY_COLOR[notice.severity] }}
          className="shrink-0"
          aria-label="From SAM"
        />
        <span
          className={`min-w-0 flex-1 text-[13px] group-hover:text-fg-primary ${
            expanded ? 'break-words text-fg-primary' : 'truncate text-fg-muted'
          }`}
        >
          {notice.headline}
        </span>
        {tag && (
          <span className="hidden shrink-0 rounded-full border border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)] px-2 py-0.5 font-mono text-[11px] text-fg-primary sm:inline-flex">
            {tag}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-fg-muted">
          {formatTime(timestamp)}
        </span>
        <ChevronRight
          size={15}
          className={`shrink-0 text-fg-muted transition-transform motion-reduce:transition-none ${
            expanded ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div
          id={bodyId}
          className="mb-3 ml-[15px] mt-1 min-w-0 border-l border-[var(--sam-hairline)] pl-4"
          data-testid="sam-notice-body"
        >
          {notice.detail && (
            <p className="m-0 mb-2 break-words text-[13.5px] leading-relaxed text-fg-muted">
              {notice.detail}
            </p>
          )}

          {notice.quote && (
            <figure className="m-0 mb-3 rounded-[12px] border border-border-default px-3 py-2">
              <figcaption className="mb-1 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
                {notice.quote.from} · not written by SAM
              </figcaption>
              <blockquote className="m-0 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-fg-primary">
                {notice.quote.text}
              </blockquote>
            </figure>
          )}

          {notice.refs.length > 0 && (
            <div className="mb-3 grid min-w-0 max-w-2xl grid-cols-[minmax(0,1fr)] gap-2">
              {notice.refs.map((ref) => (
                <NoticeRefCard
                  key={`${ref.kind}:${ref.id}`}
                  noticeRef={ref}
                  projectId={projectId}
                  onOpenTask={setOpenTaskId}
                />
              ))}
            </div>
          )}

          {showRaw && (
            <details className="group/raw mb-1">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
                <ChevronRight
                  size={13}
                  className="transition-transform group-open/raw:rotate-90 motion-reduce:transition-none"
                  aria-hidden="true"
                />
                {rawLabel}
              </summary>
              <pre className="m-0 mt-1 whitespace-pre-wrap break-words rounded-[10px] border border-border-default px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-muted">
                {rawText}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Mounted only while open, so a row never reads auth or the query cache until asked. */}
      {projectId && openTaskId && (
        <TaskQuickLookDialog projectId={projectId} taskId={openTaskId} onClose={closeTask} />
      )}
    </div>
  );
}

export const NoticeRow = memo(NoticeRowImpl);
