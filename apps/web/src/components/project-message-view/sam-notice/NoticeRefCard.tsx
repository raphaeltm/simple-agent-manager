import type { SamNoticeRef } from '@simple-agent-manager/shared';
import { Chip, type ChipTone } from '@simple-agent-manager/ui';
import {
  BadgeCheck,
  Bell,
  CalendarClock,
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  Lightbulb,
  ListTodo,
  type LucideIcon,
  MessagesSquare,
  Server,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

const REF_ICON: Record<SamNoticeRef['kind'], LucideIcon> = {
  task: ListTodo,
  session: MessagesSquare,
  idea: Lightbulb,
  pull_request: GitPullRequest,
  commit: GitCommitHorizontal,
  approval: BadgeCheck,
  node: Server,
  schedule: CalendarClock,
  event: Bell,
};

const REF_LABEL: Record<SamNoticeRef['kind'], string> = {
  task: 'Task',
  session: 'Chat',
  idea: 'Idea',
  pull_request: 'Pull request',
  commit: 'Commit',
  approval: 'Approval',
  node: 'Machine',
  schedule: 'Schedule',
  event: 'Event',
};

/** Shown when the notice carries no label for the thing it points at. */
const REF_FALLBACK_TITLE: Record<SamNoticeRef['kind'], string> = {
  task: 'A task in this project',
  session: 'Another chat',
  idea: 'An idea',
  pull_request: 'A pull request',
  commit: 'A commit',
  approval: 'An operations approval',
  node: 'A machine',
  schedule: 'A scheduled message',
  event: 'A project event',
};

function statusTone(status: string): ChipTone {
  const value = status.toLowerCase();
  if (/(completed|approved|passing|healthy|merged|finished)/.test(value)) return 'success';
  if (/(failed|denied|failing|error)/.test(value)) return 'danger';
  if (/(running|in progress|started)/.test(value)) return 'info';
  return 'neutral';
}

/** Where tapping a card goes: a quick-look modal, a page in the app, an external page, or nowhere. */
export type NoticeRefTarget =
  | { type: 'modal' }
  | { type: 'page'; to: string }
  | { type: 'external'; href: string }
  | { type: 'none' };

export function noticeRefTarget(ref: SamNoticeRef, projectId: string | undefined): NoticeRefTarget {
  const id = encodeURIComponent(ref.id);
  if (ref.url) return { type: 'external', href: ref.url };
  if (!projectId)
    return ref.kind === 'node' ? { type: 'page', to: `/nodes/${id}` } : { type: 'none' };
  switch (ref.kind) {
    case 'task':
      return { type: 'modal' };
    case 'session':
      return { type: 'page', to: `/projects/${projectId}/chat/${id}` };
    case 'idea':
      return { type: 'page', to: `/projects/${projectId}/ideas/${id}` };
    case 'node':
      return { type: 'page', to: `/nodes/${id}` };
    case 'approval':
      return { type: 'page', to: '/admin/approvals' };
    default:
      return { type: 'none' };
  }
}

const CARD_CLASS =
  'sam-well flex w-full min-w-0 min-h-11 items-start gap-3 rounded-[12px] px-3 py-2.5 text-left no-underline';
const INTERACTIVE_CLASS =
  'cursor-pointer transition-[filter] hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

export function NoticeRefCard({
  noticeRef,
  projectId,
  onOpenTask,
}: {
  noticeRef: SamNoticeRef;
  projectId: string | undefined;
  onOpenTask: (taskId: string) => void;
}) {
  const Icon = REF_ICON[noticeRef.kind];
  const target = noticeRefTarget(noticeRef, projectId);
  const statusChip = (className: string) =>
    noticeRef.status ? (
      <span className={className}>
        <Chip size="sm" tone={statusTone(noticeRef.status)}>
          {noticeRef.status}
        </Chip>
      </span>
    ) : null;

  const content: ReactNode = (
    <>
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--sam-glass-v2-raised)]"
        aria-hidden="true"
      >
        <Icon size={16} strokeWidth={1.75} className="text-fg-muted" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
          {REF_LABEL[noticeRef.kind]}
          {target.type === 'external' && <ExternalLink size={11} aria-label="Opens in a new tab" />}
        </span>
        <span className="line-clamp-2 break-words text-[13.5px] text-fg-primary">
          {noticeRef.label ?? REF_FALLBACK_TITLE[noticeRef.kind]}
        </span>
        {statusChip('mt-1.5 flex sm:hidden')}
      </span>
      {statusChip('hidden self-center sm:flex')}
      {target.type !== 'none' && (
        <ChevronRight size={16} className="shrink-0 self-center text-fg-muted" aria-hidden="true" />
      )}
    </>
  );

  switch (target.type) {
    case 'modal':
      return (
        <button
          type="button"
          className={`${CARD_CLASS} ${INTERACTIVE_CLASS}`}
          onClick={() => onOpenTask(noticeRef.id)}
          data-testid="sam-notice-ref"
        >
          {content}
        </button>
      );
    case 'page':
      return (
        <Link
          to={target.to}
          className={`${CARD_CLASS} ${INTERACTIVE_CLASS}`}
          data-testid="sam-notice-ref"
        >
          {content}
        </Link>
      );
    case 'external':
      return (
        <a
          href={target.href}
          target="_blank"
          rel="noopener noreferrer"
          className={`${CARD_CLASS} ${INTERACTIVE_CLASS}`}
          data-testid="sam-notice-ref"
        >
          {content}
        </a>
      );
    default:
      return (
        <div className={CARD_CLASS} data-testid="sam-notice-ref">
          {content}
        </div>
      );
  }
}
