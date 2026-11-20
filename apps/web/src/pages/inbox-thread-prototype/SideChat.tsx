/**
 * PROTOTYPE ONLY: an inbox item as a short conversation. Never ship to production.
 *
 * - The ask is the agent's first message. Its answer controls (options, Looks good, the secure
 *   secret field) sit inside that message, not pinned to the bottom.
 * - When the agent replies and still needs the decision, the controls move down to its latest
 *   message: there is only ever one copy, on the newest turn that offers it.
 * - One plain message box. Whether a message is a question, an answer in words or a follow-up
 *   is read from the message itself; a small note under it says what SAM understood, with Undo.
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { Button, Chip } from '@simple-agent-manager/ui';
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  CircleDashed,
  KeyRound,
  ListPlus,
  Loader2,
  Sparkles,
  Undo2,
  Wrench,
} from 'lucide-react';
import { type ReactNode } from 'react';

import { InboxItemBody } from '../../components/inbox/InboxItemView';
import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import { PROTO_NOW, type ThreadEntry } from './mock-data';

function age(at: string): string {
  const minutes = Math.max(1, Math.round((PROTO_NOW - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function AgentAvatar() {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--sam-person-auto)] text-[var(--sam-separator)] ring-2 ring-[var(--sam-separator)]"
    >
      <Bot size={15} strokeWidth={2.2} />
    </span>
  );
}

/** An agent turn: avatar in the gutter, content, then the controls it offers, if any. */
function AgentTurn({
  children,
  offers,
  meta,
}: {
  children: ReactNode;
  offers?: ReactNode;
  meta?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <AgentAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {children}
        {offers && <div className="min-w-0 pt-0.5">{offers}</div>}
        {meta && <span className="text-[11px] text-fg-muted">{meta}</span>}
      </div>
    </div>
  );
}

/** The ask itself, as the opening agent message. */
export function AskTurn({ item, offers }: { item: InboxItem; offers?: ReactNode }) {
  return (
    <AgentTurn offers={offers}>
      <InboxItemBody item={item} context={null} now={PROTO_NOW} stackPosition={null} />
    </AgentTurn>
  );
}

const FOLLOWUP_STATE: Record<
  Extract<ThreadEntry, { kind: 'followup' }>['state'],
  { label: string; tone: 'neutral' | 'success'; icon: ReactNode }
> = {
  queued: { label: 'Queued', tone: 'neutral', icon: <CircleDashed size={12} /> },
  started: { label: 'Working', tone: 'success', icon: <Loader2 size={12} /> },
  done: { label: 'Done', tone: 'success', icon: <CheckCircle2 size={12} /> },
};

function FollowupCard({ entry }: { entry: Extract<ThreadEntry, { kind: 'followup' }> }) {
  const state = FOLLOWUP_STATE[entry.state];
  return (
    <div className="ml-9 flex min-w-0 flex-col gap-1.5 rounded-xl border border-[var(--sam-hairline)] px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
        <ListPlus size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {entry.route === 'new-task' ? 'New task' : 'Next for this agent'}
        </span>
        <Chip tone={state.tone} size="sm" icon={state.icon}>
          {state.label}
        </Chip>
      </div>
      <p className="m-0 text-sm break-words text-fg-primary [overflow-wrap:anywhere]">
        {entry.text}
      </p>
      {entry.chatLabel && (
        <span className="flex min-h-9 w-fit max-w-full items-center gap-1.5 text-[13px] text-accent">
          <Sparkles size={13} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">Open “{entry.chatLabel}”</span>
        </span>
      )}
    </div>
  );
}

/**
 * The conversation after the ask. `offers` renders on the latest agent turn that has
 * `offers: true`; earlier copies are not drawn.
 */
export function Thread({
  entries,
  offers,
  pending,
}: {
  entries: ThreadEntry[];
  offers?: ReactNode;
  /** The agent is answering right now: what it is doing, in one line. */
  pending?: string;
}) {
  let lastOffer = -1;
  entries.forEach((entry, index) => {
    if (entry.kind === 'agent' && entry.offers) lastOffer = index;
  });
  return (
    <>
      {entries.map((entry, index) => {
        switch (entry.kind) {
          case 'you':
            return (
              <div key={entry.id} className="flex min-w-0 flex-col items-end gap-1">
                <div className="sam-raised max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[15px] break-words text-fg-primary [overflow-wrap:anywhere]">
                  {entry.text}
                </div>
                {entry.note ? (
                  <span className="flex max-w-[85%] items-center justify-end gap-2 text-[11px]">
                    <span className="min-w-0 text-right text-[var(--sam-status-success-fg)]">
                      <CheckCircle2
                        size={12}
                        aria-hidden="true"
                        className="mr-1 inline-block align-[-2px]"
                      />
                      {entry.note.text}
                    </span>
                    {entry.note.undo && (
                      <button
                        type="button"
                        className="flex min-h-8 shrink-0 cursor-pointer items-center gap-0.5 border-0 bg-transparent px-1 font-semibold text-fg-primary"
                      >
                        <Undo2 size={12} aria-hidden="true" /> Undo
                      </button>
                    )}
                  </span>
                ) : (
                  <span className="text-[11px] text-fg-muted">{age(entry.at)}</span>
                )}
              </div>
            );
          case 'agent':
            return (
              <AgentTurn
                key={entry.id}
                offers={index === lastOffer ? offers : undefined}
                meta={age(entry.at)}
              >
                <div className="min-w-0 text-[15px] text-fg-secondary">
                  <RenderedMarkdown content={entry.text} inline />
                </div>
              </AgentTurn>
            );
          case 'activity':
            return (
              <p
                key={entry.id}
                className="m-0 flex items-center gap-1.5 pl-9 text-xs text-fg-muted"
              >
                <Wrench size={12} aria-hidden="true" /> {entry.text}
              </p>
            );
          case 'followup':
            return <FollowupCard key={entry.id} entry={entry} />;
        }
      })}
      {pending && (
        <div className="flex min-w-0 items-start gap-2.5" role="status">
          <AgentAvatar />
          <div className="flex min-w-0 flex-col gap-1.5 pt-1">
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted [animation-delay:300ms]" />
            </span>
            <span className="text-xs text-fg-muted">{pending}</span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The one message box. No modes: SAM reads the message. `guard` replaces the send action when
 * the draft looks like a secret, so a key never lands in the chat.
 */
export function MessageBox({
  draft = '',
  placeholder = 'Message the agent about this…',
  guard = false,
}: {
  draft?: string;
  placeholder?: string;
  guard?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {guard && (
        <div
          role="alert"
          className="flex min-w-0 flex-col gap-2 rounded-xl bg-warning-tint px-3 py-2.5 text-sm text-warning-fg"
        >
          <p className="m-0 flex items-start gap-1.5">
            <KeyRound size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              That looks like a key. Messages are kept in the chat, so send it through the secure
              field instead.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" size="sm">
              Move it to the secure field
            </Button>
            <Button variant="raised" size="sm">
              It isn’t a secret
            </Button>
          </div>
        </div>
      )}
      <div className="sam-well flex min-w-0 items-end gap-1.5 rounded-2xl p-1.5">
        <textarea
          aria-label={placeholder}
          rows={1}
          defaultValue={guard ? '' : draft}
          placeholder={guard ? '' : placeholder}
          className={`min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-base text-fg-primary outline-none placeholder:text-fg-muted md:text-[15px] ${guard ? 'hidden' : ''}`}
        />
        {guard && (
          <span className="flex min-h-10 min-w-0 flex-1 items-center px-2 text-base text-fg-secondary md:text-[15px]">
            <span className="min-w-0 truncate">here it is: ••••••••••••••••</span>
          </span>
        )}
        <Button
          variant="accent"
          size="sm"
          aria-label="Send"
          className="h-10 w-10 shrink-0 !px-0"
          disabled={guard || !draft}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** Under an inbox row: the conversation's latest state at a glance. */
export function ThreadRowHint({
  text,
  unread,
  tone = 'muted',
}: {
  text: string;
  unread?: boolean;
  tone?: 'muted' | 'active';
}) {
  return (
    <div className="-mt-1 flex min-w-0 items-center gap-1.5 pr-3 pb-2.5 pl-14 text-xs">
      {unread && (
        <span
          aria-label="New reply"
          className="h-2 w-2 shrink-0 rounded-full bg-[var(--sam-count-active)]"
        />
      )}
      <span
        className={`min-w-0 truncate ${tone === 'active' ? 'font-medium text-fg-primary' : 'text-fg-muted'}`}
      >
        {text}
      </span>
    </div>
  );
}
