/**
 * PROTOTYPE — SAM notice rows in project chat. Throwaway; never merge to main.
 * See apps/web/.claude/rules/37-prototype-development.md and idea 01M6R6N2KGQSDZ8DQE3P1XRVC0.
 */
import { MessageBubble } from '@simple-agent-manager/acp-client';
import { Button, Chip, Dialog, Pane } from '@simple-agent-manager/ui';
import {
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  Hourglass,
  Lightbulb,
  ListTodo,
  type LucideIcon,
  MessageSquare,
  MessagesSquare,
  Server,
  ShieldCheck,
  Sunrise,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';

import {
  type Notice,
  type NoticeType,
  type RefKind,
  type ResolvedRef,
  TASK_QUICK_LOOK,
  TRANSCRIPT,
} from './mock-data';

const NOTICE_ICON: Record<NoticeType, LucideIcon> = {
  'subtask.completed': CheckCircle2,
  'subtask.failed': XCircle,
  'agent.message': MessagesSquare,
  'comment.sent': MessageSquare,
  'schedule.due': CalendarClock,
  'ops.decision': ShieldCheck,
  'checkin.stalled': Hourglass,
  'github.event': GitPullRequest,
  'session.resumed': Sunrise,
};

const REF_ICON: Record<RefKind, LucideIcon> = {
  task: ListTodo,
  session: MessagesSquare,
  idea: Lightbulb,
  pull_request: GitPullRequest,
  commit: GitCommitHorizontal,
  approval: BadgeCheck,
  node: Server,
  schedule: CalendarClock,
  comment_thread: MessageSquare,
};

const REF_LABEL: Record<RefKind, string> = {
  task: 'Task',
  session: 'Chat',
  idea: 'Idea',
  pull_request: 'Pull request',
  commit: 'Commit',
  approval: 'Approval',
  node: 'Machine',
  schedule: 'Schedule',
  comment_thread: 'Comment',
};

const SEVERITY_COLOR: Record<Notice['severity'], string> = {
  success: 'var(--sam-status-success-fg)',
  error: 'var(--sam-status-danger-fg)',
  warning: 'var(--sam-status-warning-fg)',
  info: 'var(--sam-color-fg-muted)',
};

/** The one ref worth naming on the collapsed row, so it reads without expanding. */
function primaryRefLabel(notice: Notice): string | null {
  const pr = notice.refs.find((r) => r.kind === 'pull_request');
  if (pr) return `#${pr.id}`;
  return null;
}

function RefCard({
  refItem,
  onOpenModal,
}: {
  refItem: ResolvedRef;
  onOpenModal: (m: 'task' | 'approval') => void;
}) {
  const Icon = REF_ICON[refItem.kind];
  const content = (
    <>
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
        style={{ background: 'var(--sam-glass-v2-raised, rgba(255,255,255,0.06))' }}
        aria-hidden="true"
      >
        <Icon size={16} strokeWidth={1.75} className="text-fg-muted" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
          {REF_LABEL[refItem.kind]}
          {refItem.open.type === 'external' && (
            <ExternalLink size={11} aria-label="Opens on GitHub" />
          )}
        </span>
        <span className="block truncate text-[13.5px] text-fg-primary">{refItem.title}</span>
        {refItem.meta && (
          <span className="block truncate font-mono text-[11px] text-fg-muted">{refItem.meta}</span>
        )}
        {refItem.status && (
          <span className="mt-1.5 flex sm:hidden">
            <Chip size="sm" tone={refItem.status.tone}>
              {refItem.status.label}
            </Chip>
          </span>
        )}
      </span>
      {refItem.status && (
        <span className="hidden self-center sm:flex">
          <Chip size="sm" tone={refItem.status.tone}>
            {refItem.status.label}
          </Chip>
        </span>
      )}
      <ChevronRight size={16} className="shrink-0 self-center text-fg-muted" aria-hidden="true" />
    </>
  );
  const className =
    'sam-well flex w-full min-w-0 min-h-11 items-start gap-3 rounded-[12px] px-3 py-2.5 text-left no-underline transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';
  if (refItem.open.type === 'modal') {
    const modal = refItem.open.modal;
    return (
      <button
        type="button"
        className={className}
        onClick={() => onOpenModal(modal)}
        data-testid={`ref-${refItem.kind}`}
      >
        {content}
      </button>
    );
  }
  return (
    <a
      className={className}
      href={refItem.open.href}
      {...(refItem.open.type === 'external' ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {content}
    </a>
  );
}

function NoticeRow({
  notice,
  expanded,
  onToggle,
  onOpenModal,
}: {
  notice: Notice;
  expanded: boolean;
  onToggle: () => void;
  onOpenModal: (m: 'task' | 'approval') => void;
}) {
  const Icon = NOTICE_ICON[notice.type];
  const tag = primaryRefLabel(notice);
  return (
    <div className="mb-1.5" data-testid={`notice-${notice.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group flex w-full min-h-11 items-center gap-2.5 rounded-[12px] px-2 py-1.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Icon
          size={16}
          strokeWidth={1.75}
          style={{ color: SEVERITY_COLOR[notice.severity] }}
          className="shrink-0"
          aria-label={`SAM: ${notice.type}`}
        />
        <span
          className={`min-w-0 flex-1 text-[13px] group-hover:text-fg-primary ${
            expanded ? 'break-words text-fg-primary' : 'truncate text-fg-muted'
          }`}
        >
          {notice.headline}
        </span>
        {tag && (
          <span className="hidden sm:inline-flex">
            <Chip size="sm" tone="neutral">
              {tag}
            </Chip>
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-fg-muted">{notice.time}</span>
        <ChevronRight
          size={15}
          className={`shrink-0 text-fg-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div
          className="mb-3 ml-[15px] mt-1 min-w-0 border-l pl-4"
          style={{ borderColor: 'var(--sam-hairline, rgba(255,255,255,0.1))' }}
        >
          {notice.detail && (
            <p className="m-0 mb-2 text-[13.5px] leading-relaxed text-fg-muted">{notice.detail}</p>
          )}

          {notice.quoted && (
            <figure className="m-0 mb-3 rounded-[12px] border border-border-default px-3 py-2">
              <figcaption className="mb-1 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
                {notice.quoted.from} · not written by SAM
              </figcaption>
              <blockquote className="m-0 text-[13.5px] leading-relaxed text-fg-primary">
                {notice.quoted.text}
              </blockquote>
            </figure>
          )}

          {notice.refs.length > 0 && (
            <div
              className="mb-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
              data-testid="ref-grid"
            >
              {notice.refs.map((r) => (
                <RefCard key={`${r.kind}-${r.id}`} refItem={r} onOpenModal={onOpenModal} />
              ))}
            </div>
          )}

          {notice.actions && (
            <div className="mb-2 flex flex-wrap gap-2">
              {notice.actions.map((a) => (
                <Button key={a.label} size="sm" variant={a.primary ? 'accent' : 'raised'}>
                  {a.label}
                </Button>
              ))}
            </div>
          )}

          <details className="group/raw mb-1">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs text-fg-muted">
              <ChevronRight
                size={13}
                className="transition-transform group-open/raw:rotate-90"
                aria-hidden="true"
              />
              Show what the agent saw
            </summary>
            <pre className="m-0 mt-1 whitespace-pre-wrap break-words rounded-[10px] border border-border-default px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-muted">
              {notice.agentText}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function TaskQuickLook({ onClose }: { onClose: () => void }) {
  const t = TASK_QUICK_LOOK;
  return (
    <div className="p-5">
      <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
        <ListTodo size={13} aria-hidden="true" /> Subtask
      </div>
      <h2 className="m-0 mb-3 text-lg font-semibold text-fg-primary">{t.title}</h2>
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip size="sm" tone="success" dot>
          {t.status}
        </Chip>
        <Chip size="sm" tone="neutral">
          {t.duration}
        </Chip>
        <Chip size="sm" tone="neutral">
          {t.pr}
        </Chip>
      </div>
      <dl className="m-0 mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-fg-muted">Profile</dt>
        <dd className="m-0 text-fg-primary">{t.profile}</dd>
        <dt className="text-fg-muted">Branch</dt>
        <dd className="m-0 font-mono text-fg-primary">{t.branch}</dd>
      </dl>
      <h3 className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        What it did
      </h3>
      <p className="m-0 mb-5 text-[13.5px] leading-relaxed text-fg-primary">{t.summary}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="raised" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button variant="raised" size="sm">
          Open its chat
        </Button>
        <Button variant="accent" size="sm">
          View pull request
        </Button>
      </div>
    </div>
  );
}

function ApprovalQuickLook({ onClose }: { onClose: () => void }) {
  return (
    <div className="p-5">
      <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
        <BadgeCheck size={13} aria-hidden="true" /> Approval
      </div>
      <h2 className="m-0 mb-3 text-lg font-semibold text-fg-primary">Delete node web-pool-3</h2>
      <Chip size="sm" tone="success" dot>
        Approved by you at 15:20
      </Chip>
      <p className="m-0 my-4 text-[13.5px] leading-relaxed text-fg-primary">
        The agent asked to delete this machine because it stopped sending heartbeats and runs no
        workspaces. It can run the action once.
      </p>
      <div className="flex justify-end">
        <Button variant="raised" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

export function NoticeRowsPrototype() {
  const params = new URLSearchParams(window.location.search);
  const initialExpanded = (params.get('expand') ?? '').split(',').filter(Boolean);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(initialExpanded));
  const [modal, setModal] = useState<'task' | 'approval' | null>(
    (params.get('modal') as 'task' | 'approval' | null) ?? null
  );

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="sam-void" style={{ height: '100vh', overflow: 'auto' }}>
      <div className="mx-auto flex min-h-full max-w-[880px] flex-col gap-2.5 p-2.5 sm:gap-3.5 sm:p-4">
        <Pane variant="slab" as="header" className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-fg-primary">
              Auth cleanup: redirect loop + billing migration
            </div>
            <div className="font-mono text-[11px] text-fg-muted">Prototype · SAM notice rows</div>
          </div>
        </Pane>
        <Pane variant="quiet" className="flex-1 px-3 py-4 sm:px-6">
          {TRANSCRIPT.map((item) => {
            if (item.kind === 'notice') {
              return (
                <NoticeRow
                  key={item.notice.id}
                  notice={item.notice}
                  expanded={expanded.has(item.notice.id)}
                  onToggle={() => toggle(item.notice.id)}
                  onOpenModal={setModal}
                />
              );
            }
            return (
              <div key={item.id} className="mb-4">
                {item.kind === 'user' ? (
                  <MessageBubble text={item.text} role="user" bubbleClassName="glass-msg-user" />
                ) : (
                  <MessageBubble
                    text={item.text}
                    role="agent"
                    layout="flush"
                    bubbleClassName="glass-msg-agent"
                  />
                )}
              </div>
            );
          })}
        </Pane>
      </div>
      <Dialog isOpen={modal !== null} onClose={() => setModal(null)} aria-label="Quick look">
        {modal === 'task' && <TaskQuickLook onClose={() => setModal(null)} />}
        {modal === 'approval' && <ApprovalQuickLook onClose={() => setModal(null)} />}
      </Dialog>
    </div>
  );
}
