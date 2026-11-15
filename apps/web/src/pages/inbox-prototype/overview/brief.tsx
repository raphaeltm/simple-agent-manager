/**
 * PROTOTYPE ONLY — the generated Brief (idea section 11.3). The prose stands in for model
 * output. Rules it follows: two or three sentences, every claim links to the thing it is
 * about, and no number appears in the prose at all (the tiles carry every number, so a stale
 * brief cannot contradict them). One muted line says how old it is and what it read.
 */
import { IconButton } from '@simple-agent-manager/ui';
import { ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import type { ProjectState } from './data';

export type BriefState = 'fresh' | 'stale' | 'off';

/** A claim's target. Opening an inbox item is wired; the rest are links to real pages. */
export type BriefTarget =
  | { kind: 'item'; id: string }
  | { kind: 'chat'; label: string }
  | { kind: 'automation' }
  | { kind: 'budget' }
  | { kind: 'pr'; number: number };

type Part = string | { text: string; to: BriefTarget };
type Sentence = Part[];

const BRIEFS: Record<ProjectState, { fresh: Sentence[]; stale: Sentence[] }> = {
  normal: {
    fresh: [
      [
        { text: 'Ship billing', to: { kind: 'chat', label: 'Ship billing' } },
        ' needs ',
        { text: 'the VAT decision', to: { kind: 'item', id: 'q-vat' } },
        ' and ',
        { text: 'the Stripe live secret', to: { kind: 'item', id: 'secret-stripe' } },
        ' before checkout goes live.',
      ],
      [
        { text: 'A staging migration', to: { kind: 'item', id: 'perm-migrate' } },
        ' is waiting for your permission and expires soon.',
      ],
      [
        { text: 'Dunning emails', to: { kind: 'chat', label: 'Dunning emails' } },
        ' and ',
        { text: 'the rounding fix', to: { kind: 'chat', label: 'Fix rounding' } },
        ' are moving; ',
        { text: 'issue triage', to: { kind: 'automation' } },
        ' stopped.',
      ],
    ],
    // Written before the VAT question and the secret request were filed: it is wrong now,
    // which is exactly what a stale brief looks like. The tiles below it are live.
    stale: [
      [
        'Checkout and ',
        { text: 'Stripe webhooks', to: { kind: 'pr', number: 86 } },
        ' merged this morning.',
      ],
      [
        { text: 'Ship billing', to: { kind: 'chat', label: 'Ship billing' } },
        ' is building the trial logic and has ',
        { text: 'a question about trials', to: { kind: 'item', id: 'q-trial' } },
        ' that does not block it.',
      ],
    ],
  },
  quiet: {
    fresh: [
      ['Nothing needs you and no agents are running.'],
      [
        { text: 'The pricing page', to: { kind: 'pr', number: 90 } },
        ' merged this morning, and ',
        { text: 'invoice reconciliation', to: { kind: 'automation' } },
        ' runs tonight.',
      ],
    ],
    stale: [['Quiet since the pricing page merged.']],
  },
  busy: {
    fresh: [
      [
        { text: 'Ship billing', to: { kind: 'chat', label: 'Ship billing' } },
        ' and ',
        { text: 'Invoice PDF export', to: { kind: 'chat', label: 'Invoice PDF export' } },
        ' are blocked on you, and ',
        { text: 'a migration permission', to: { kind: 'item', id: 'busy-6' } },
        ' expires in minutes.',
      ],
      [
        { text: 'Personal Max', to: { kind: 'budget' } },
        ' is nearly out for the week, so new Opus runs will stop soon.',
      ],
      [
        { text: 'Issue triage', to: { kind: 'automation' } },
        ' and ',
        { text: 'the dispute webhook', to: { kind: 'automation' } },
        ' are failing.',
      ],
    ],
    stale: [
      [
        { text: 'Ship billing', to: { kind: 'chat', label: 'Ship billing' } },
        ' is blocked on you; the rest is moving.',
      ],
    ],
  },
};

function Claim({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] text-fg-primary underline decoration-[var(--sam-hairline-strong,rgba(255,255,255,0.35))] decoration-1 underline-offset-[3px] hover:decoration-current"
    >
      {text}
    </button>
  );
}

function Prose({
  sentences,
  onTarget,
}: {
  sentences: Sentence[];
  onTarget: (t: BriefTarget) => void;
}): ReactNode {
  return sentences.map((sentence, i) => (
    <span key={i}>
      {i > 0 ? ' ' : ''}
      {sentence.map((part, j) =>
        typeof part === 'string' ? (
          <span key={j}>{part}</span>
        ) : (
          <Claim key={j} text={part.text} onOpen={() => onTarget(part.to)} />
        )
      )}
    </span>
  ));
}

function SourceLine({ state }: { state: BriefState }) {
  return (
    <div className="flex min-h-9 items-center gap-1.5 text-xs text-fg-muted">
      <Sparkles size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1">
        {state === 'stale' ? (
          <>
            3h ago · <span className="text-fg-secondary">refreshing…</span>
          </>
        ) : (
          '4m ago · from inbox, chats, automations, budgets'
        )}
      </span>
      <IconButton
        size="sm"
        label={state === 'stale' ? 'Refreshing the summary' : 'Refresh the summary'}
        icon={
          <RefreshCw
            size={15}
            aria-hidden="true"
            className={state === 'stale' ? 'motion-safe:animate-spin' : ''}
          />
        }
        disabled={state === 'stale'}
        showTooltip={false}
        className="-my-1 -mr-1.5"
      />
    </div>
  );
}

/** The full brief: prose, then its source line. Renders nothing when generation is off. */
export function Brief({
  project,
  state,
  onTarget,
  heading,
}: {
  project: ProjectState;
  state: BriefState;
  onTarget: (t: BriefTarget) => void;
  /** Desktop: the project's name sits above the brief (there is no page header). */
  heading?: ReactNode;
}) {
  if (state === 'off') return null;
  const sentences = BRIEFS[project][state === 'stale' ? 'stale' : 'fresh'];
  return (
    <section aria-label="How the project is going" className="flex flex-col gap-1.5">
      {heading}
      <p
        className={`m-0 text-[15px] leading-[1.55] break-words md:text-base ${state === 'stale' ? 'text-fg-muted' : 'text-fg-secondary'}`}
      >
        <Prose sentences={sentences} onTarget={onTarget} />
      </p>
      <SourceLine state={state} />
    </section>
  );
}

/** Variant 2: the brief folded to one line under Needs you; tapping unfolds it in place. */
export function BriefLine({
  project,
  state,
  onTarget,
}: {
  project: ProjectState;
  state: BriefState;
  onTarget: (t: BriefTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  if (state === 'off') return null;
  const sentences = BRIEFS[project][state === 'stale' ? 'stale' : 'fresh'];
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-expanded
          className="flex min-h-9 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs font-medium text-fg-muted"
        >
          <Sparkles size={13} aria-hidden="true" /> How it’s going
          <ChevronDown size={14} aria-hidden="true" className="rotate-180" />
        </button>
        <Brief project={project} state={state} onTarget={onTarget} />
      </div>
    );
  }
  const first = sentences[0] ?? [];
  const text = first.map((p) => (typeof p === 'string' ? p : p.text)).join('');
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-expanded={false}
      aria-label={`Summary: ${text} Show the whole summary`}
      className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
    >
      <Sparkles
        size={14}
        aria-hidden="true"
        className={`shrink-0 ${state === 'stale' ? 'text-fg-muted motion-safe:animate-pulse' : 'text-accent'}`}
      />
      <span
        className={`min-w-0 flex-1 truncate text-sm ${state === 'stale' ? 'text-fg-muted' : 'text-fg-secondary'}`}
      >
        {text}
      </span>
      <span className="shrink-0 text-xs text-fg-muted">{state === 'stale' ? '3h' : '4m'}</span>
      <ChevronDown size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
    </button>
  );
}
