/**
 * PROTOTYPE ONLY: the side-chat on one inbox item. Never ship to production.
 *
 * Three intents share one composer, picked with a segmented control:
 * - Ask: a clarifying question. The item stays open; the agent answers inside the item.
 * - Follow-up: more work. Goes to the same agent (waking it if it finished) or a new task.
 * - Answer: only for items that take a typed answer; closes the item like today.
 */
import { Button, Chip, SegmentedControl } from '@simple-agent-manager/ui';
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  CircleDashed,
  CornerDownRight,
  ListPlus,
  Loader2,
  Moon,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { type ReactNode } from 'react';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import { PROTO_NOW, type ThreadEntry } from './mock-data';

export type ComposerMode = 'ask' | 'followup' | 'answer';

function age(at: string): string {
  const minutes = Math.max(1, Math.round((PROTO_NOW - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function AgentAvatar() {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--sam-person-auto,#38bdf8)] text-[#04121b] ring-2 ring-[var(--sam-separator)]"
    >
      <Bot size={15} strokeWidth={2.2} />
    </span>
  );
}

const FOLLOWUP_STATE: Record<
  Extract<ThreadEntry, { kind: 'followup' }>['state'],
  { label: string; tone: 'neutral' | 'warning' | 'success' | 'info'; icon: ReactNode }
> = {
  queued: { label: 'Queued', tone: 'neutral', icon: <CircleDashed size={12} /> },
  sent: { label: 'Sent', tone: 'info', icon: <CornerDownRight size={12} /> },
  started: { label: 'Working', tone: 'success', icon: <Loader2 size={12} /> },
  done: { label: 'Done', tone: 'success', icon: <CheckCircle2 size={12} /> },
};

function FollowupCard({ entry }: { entry: Extract<ThreadEntry, { kind: 'followup' }> }) {
  const state = FOLLOWUP_STATE[entry.state];
  return (
    <div className="sam-well flex min-w-0 flex-col gap-2 rounded-xl px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
        <ListPlus size={14} aria-hidden="true" className="shrink-0" />
        <span className="shrink-0 font-medium whitespace-nowrap text-fg-secondary">
          {entry.route === 'new-task' ? 'Follow-up · new task' : 'Follow-up · this agent'}
        </span>
        <span className="ml-auto shrink-0">
          <Chip tone={state.tone} size="sm" icon={state.icon}>
            {state.label}
          </Chip>
        </span>
      </div>
      <p className="m-0 text-sm break-words text-fg-primary [overflow-wrap:anywhere]">
        {entry.text}
      </p>
      {entry.chatLabel && (
        <span className="flex min-h-9 w-fit max-w-full items-center gap-1.5 rounded-full border border-[var(--sam-chip-edge,var(--sam-hairline))] bg-[var(--sam-chip-bg,transparent)] px-3 text-[13px] text-fg-primary">
          <Sparkles size={13} aria-hidden="true" className="shrink-0 text-fg-muted" />
          <span className="min-w-0 truncate">{entry.chatLabel}</span>
        </span>
      )}
    </div>
  );
}

/** The conversation on one item, oldest first. */
export function ThreadView({
  entries,
  pending,
  heading = true,
}: {
  entries: ThreadEntry[];
  /** The agent is answering right now: what it is doing, one line. */
  pending?: string;
  heading?: boolean;
}) {
  return (
    <section aria-label="Conversation about this item" className="flex min-w-0 flex-col gap-3">
      {heading && (
        <div className="flex items-center gap-2 pt-1">
          <span className="h-px flex-1 bg-[var(--sam-hairline)]" />
          <span className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">
            About this item
          </span>
          <span className="h-px flex-1 bg-[var(--sam-hairline)]" />
        </div>
      )}
      {entries.map((entry) => {
        switch (entry.kind) {
          case 'you':
            return (
              <div key={entry.id} className="flex min-w-0 flex-col items-end gap-1">
                <div className="sam-raised max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[15px] break-words text-fg-primary [overflow-wrap:anywhere]">
                  {entry.text}
                </div>
                <span className="text-[11px] text-fg-muted">You · {age(entry.at)}</span>
              </div>
            );
          case 'agent':
            return (
              <div key={entry.id} className="flex min-w-0 items-start gap-2">
                <AgentAvatar />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="min-w-0 text-[15px] text-fg-secondary">
                    <RenderedMarkdown content={entry.text} inline />
                  </div>
                  <span className="text-[11px] text-fg-muted">Agent · {age(entry.at)}</span>
                </div>
              </div>
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
          case 'answer':
            return (
              <p key={entry.id} className="m-0 text-sm text-[var(--sam-status-success-fg)]">
                You answered: {entry.text}
              </p>
            );
        }
      })}
      {pending && (
        <div className="flex min-w-0 items-start gap-2" role="status">
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
    </section>
  );
}

const MODE_HINT: Record<ComposerMode, string> = {
  ask: 'The agent answers here. This item stays open.',
  followup: 'Adds work. Nothing here is lost when you close the item.',
  answer: 'Answers the question and closes the item.',
};

const MODE_PLACEHOLDER: Record<ComposerMode, string> = {
  ask: 'Ask about this (it stays open)…',
  followup: 'What else should be done?',
  answer: 'Type your answer (closes it)…',
};

/** One-tap prompts for the common clarifications. */
export const DEFAULT_SUGGESTIONS = [
  'Explain it simpler',
  'What do you recommend?',
  'Show me the evidence',
  'What could go wrong?',
];

/**
 * The pinned bottom of an item: the item's own answer (options, Looks good…), then one composer
 * for talking about it. The answer stays first: the side-chat never hides the decision.
 */
export function SideChatComposer({
  answer,
  mode,
  modes,
  draft = '',
  notice,
  routePicker,
  showHint = true,
}: {
  /** The item's existing answer controls. */
  answer?: ReactNode;
  mode: ComposerMode;
  modes: ComposerMode[];
  draft?: string;
  /** One line above the input, e.g. "This agent finished; sending wakes it". */
  notice?: ReactNode;
  /** Follow-up only: where it goes. */
  routePicker?: ReactNode;
  /** Narrow columns (the desktop side pane) drop the one-line hint. */
  showHint?: boolean;
}) {
  const labels: Record<ComposerMode, string> = {
    ask: 'Ask',
    followup: 'Follow-up',
    answer: 'Answer',
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {answer}
      {notice}
      {routePicker}
      <div className="flex min-w-0 items-center gap-2">
        <SegmentedControl
          label="What this message is"
          value={mode}
          onChange={() => undefined}
          className="w-full shrink-0 md:w-[280px]"
          options={modes.map((value) => ({ value, label: labels[value] }))}
        />
        {showHint && (
          <span className="hidden min-w-0 flex-1 truncate text-xs text-fg-muted md:block">
            {MODE_HINT[mode]}
          </span>
        )}
      </div>
      <div className="sam-well flex min-w-0 items-end gap-1.5 rounded-2xl p-1.5">
        <textarea
          aria-label={MODE_PLACEHOLDER[mode]}
          rows={draft ? 2 : 1}
          defaultValue={draft}
          placeholder={MODE_PLACEHOLDER[mode]}
          className="min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-base text-fg-primary outline-none placeholder:text-fg-muted md:text-[15px]"
        />
        <Button
          variant="accent"
          size="sm"
          aria-label="Send"
          className="h-10 w-10 shrink-0 !px-0"
          disabled={!draft}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** When nothing has been said about the item yet: an invitation with one-tap prompts. */
export function ThreadStarter({ suggestions }: { suggestions: string[] }) {
  return (
    <section aria-label="Ask about this item" className="flex min-w-0 flex-col gap-2 pt-1">
      <p className="m-0 text-xs text-fg-muted">Not sure yet? Ask the agent first:</p>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="flex h-9 shrink-0 cursor-pointer items-center rounded-full border border-[var(--sam-hairline)] bg-transparent px-3 text-[13px] text-fg-secondary"
          >
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Follow-up destination: this agent (queued or waking it) or a fresh task. */
export function FollowupRoutePicker({ agentFinished }: { agentFinished: boolean }) {
  const option =
    'flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-xl border-0 px-3 py-2 text-left';
  return (
    <div role="radiogroup" aria-label="Send the follow-up to" className="flex min-w-0 gap-2">
      <button type="button" role="radio" aria-checked="true" className={`${option} sam-raised`}>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
          {agentFinished && <Moon size={14} aria-hidden="true" />} This agent
        </span>
        <span className="text-xs text-fg-muted">
          {agentFinished ? 'Wakes it with the full context' : 'Queued after its current work'}
        </span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked="false"
        className={`${option} bg-transparent`}
      >
        <span className="flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
          <Sparkles size={14} aria-hidden="true" /> New task
        </span>
        <span className="text-xs text-fg-muted">A fresh agent, linked to this item</span>
      </button>
    </div>
  );
}

/** Under an inbox row: the side-chat's latest state at a glance. */
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
    <div className="flex min-w-0 items-center gap-1.5 pr-3 pb-2.5 pl-14 text-xs">
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
