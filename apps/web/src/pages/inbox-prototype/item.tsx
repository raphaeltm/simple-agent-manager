/** PROTOTYPE ONLY — one inbox item's body for /prototype/inbox. */
import {
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  GitPullRequest,
  Globe,
  Lightbulb,
  MessageSquare,
  Scale,
} from 'lucide-react';

import { ApprovalItem } from '../../components/operations-approvals/ApprovalItem';
import { TaskSteps } from './answers';
import { approvalFor, type InboxItem, type LinkKind } from './mock-data';
import type { State } from './model';
import { agentStateText, KIND_META, TeamLine } from './rows';

const LINK_ICONS: Record<LinkKind, typeof Globe> = {
  idea: Lightbulb,
  file: FileText,
  policy: Scale,
  pr: GitPullRequest,
  preview: Globe,
  chat: MessageSquare,
  knowledge: BookOpen,
};

/** Agent-chosen links as one scrolling row of chips (wrapping costs a line per 2 chips). */
export function LinkChips({ item }: { item: InboxItem }) {
  if (item.links.length === 0) return null;
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
      {item.links.map((link) => {
        const Icon = LINK_ICONS[link.kind];
        return (
          <button
            type="button"
            key={link.label}
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)] px-3 text-[13px] text-fg-primary"
          >
            <Icon size={13} aria-hidden="true" className="text-fg-muted" />
            {link.label}
          </button>
        );
      })}
    </div>
  );
}

/** Before / since, collapsed to one line by default. */
export function ContextDisclosure({
  item,
  open,
  onToggle,
}: {
  item: InboxItem;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const summary = `${item.before.length} message${item.before.length === 1 ? '' : 's'} before${
    item.since.length
      ? ` · ${item.since.length} thing${item.since.length === 1 ? '' : 's'} done since`
      : ''
  }`;
  return (
    <div className="rounded-xl border border-[var(--sam-hairline)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left text-sm text-fg-secondary"
      >
        <span className="font-medium text-fg-primary">Context</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{summary}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--sam-hairline)] px-3 py-3">
          <div className="flex flex-col gap-2">
            {item.before.map((m, i) => (
              <p key={i} className="m-0 text-sm break-words text-fg-secondary">
                <span className="font-medium text-fg-primary">
                  {m.from === 'you' ? 'You' : 'Agent'}:{' '}
                </span>
                {m.text}
              </p>
            ))}
          </div>
          <div>
            <p className="m-0 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">
              Since it asked
            </p>
            {item.since.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Nothing. It is paused on this.</p>
            ) : (
              <ul className="m-0 flex flex-col gap-1 pl-4">
                {item.since.map((s) => (
                  <li key={s} className="text-sm text-fg-secondary">
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "2 of 3 from Ship billing" with a dot per member; answered members are ticked. */
export function GroupStepper({
  state,
  members,
  current,
}: {
  state: State;
  members: InboxItem[];
  current: InboxItem;
}) {
  if (members.length < 2) return null;
  const index = members.findIndex((m) => m.id === current.id);
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="flex items-center gap-1" aria-hidden="true">
        {members.map((m) =>
          state.resolved[m.id] ? (
            <span
              key={m.id}
              className="grid h-3.5 w-3.5 place-items-center rounded-full bg-[var(--sam-status-success-fg)] text-[var(--sam-void-core,#000)]"
            >
              <Check size={9} strokeWidth={3} />
            </span>
          ) : (
            <span
              key={m.id}
              className={`h-2 w-2 rounded-full ${m.id === current.id ? 'bg-fg-primary' : 'bg-[var(--sam-hairline-strong,rgba(255,255,255,0.25))]'}`}
            />
          )
        )}
      </span>
      <span>
        {index + 1} of {members.length} from{' '}
        <span className="text-fg-secondary">{current.chat}</span>
      </span>
    </div>
  );
}

export function ReceiptLine({ text }: { text: string }) {
  return (
    <p
      role="status"
      className="m-0 flex items-center gap-2 text-sm text-[var(--sam-status-success-fg)]"
    >
      <Check size={15} strokeWidth={2.5} aria-hidden="true" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

/**
 * The ask: kind and state on one muted line, the title, the agent's "why", any body, then
 * links and the collapsed context. Answer controls are NOT here: the owner pins them.
 */
export function ItemBody({
  item,
  state,
  onContext,
  showMeta = true,
  showTitle = true,
}: {
  item: InboxItem;
  state: State;
  onContext: (open: boolean) => void;
  showMeta?: boolean;
  /** Direction C's expanded row already shows the title in the row itself. */
  showTitle?: boolean;
}) {
  const kind = KIND_META[item.kind];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {showMeta && (
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
          <span className="font-medium text-fg-secondary">{kind.label}</span>
          <span aria-hidden="true">·</span>
          <span>{item.project}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{item.chat}</span>
          <span aria-hidden="true">·</span>
          <span className={item.agent === 'paused' ? 'text-warning-fg' : ''}>
            {item.deadlineMin !== undefined
              ? `Expires in ${item.deadlineMin}m`
              : agentStateText(item)}
          </span>
        </p>
      )}
      {showTitle && (
        <h2 className="m-0 text-lg leading-snug font-semibold break-words text-fg-primary">
          {item.title}
        </h2>
      )}
      <TeamLine item={item} />
      {item.body ? (
        <blockquote className="m-0 border-l-2 border-[var(--sam-hairline)] pl-3 text-[15px] break-words text-fg-secondary">
          {item.body}
        </blockquote>
      ) : null}
      <p className="m-0 text-[15px] leading-relaxed break-words text-fg-secondary">{item.why}</p>
      {item.kind === 'approval' && item.approval && (
        <div className="-mx-4 rounded-xl border border-[var(--sam-hairline)] sm:mx-0">
          <ApprovalItem
            approval={approvalFor(item)}
            canDecide={false}
            deciding={null}
            onDecide={() => {}}
          />
        </div>
      )}
      {item.kind === 'task' && <TaskSteps key={item.id} item={item} />}
      <LinkChips item={item} />
      <ContextDisclosure item={item} open={state.contextOpen} onToggle={onContext} />
    </div>
  );
}
