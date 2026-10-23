/** Ideas redesign prototype: the list (throwaway; never merge to main). */
import { Button } from '@simple-agent-manager/ui';
import { Bot, ChevronDown, ChevronRight, Lightbulb, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { type Attention, DONE_RECENTLY, FILED_BY_AGENTS, type IdeaRowData, type ListScene } from './mock-data';
import { AttentionCard, Card, IdeaRow, SectionHeading, StateIcon } from './parts';

function hasAttention(idea: IdeaRowData): idea is IdeaRowData & { attention: Attention } {
  return Boolean(idea.attention);
}

function Header({ isMobile }: { isMobile: boolean }) {
  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg-primary">
            Ideas
          </h1>
          <p className="m-0 text-[15px] text-fg-muted">
            Things you want done. Start work on one when it’s ready.
          </p>
        </div>
        <Button className="shrink-0">
          <Plus size={18} aria-hidden />
          {isMobile ? 'New' : 'New idea'}
        </Button>
      </div>
      <label className="relative block min-w-0">
        <span className="sr-only">Search ideas</span>
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
        />
        <input
          type="search"
          placeholder="Search ideas"
          className="min-h-11 w-full rounded-lg border border-[var(--sam-form-border)] bg-inset py-2 pl-9 pr-3 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
        />
      </label>
    </header>
  );
}

/** Shown before folding the rest, so a bad day cannot push the whole list off a phone screen. */
const NEEDS_YOU_VISIBLE = 3;

function NeedsYou({ ideas }: { ideas: IdeaRowData[] }) {
  const cards = ideas.filter(hasAttention);
  if (cards.length === 0) return null;
  const hidden = cards.length - NEEDS_YOU_VISIBLE;
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="Needs you" count={cards.length} />
      {cards.slice(0, NEEDS_YOU_VISIBLE).map((idea) => (
        <AttentionCard key={idea.id} idea={idea} />
      ))}
      {hidden > 0 && (
        <a
          href="#more"
          className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-dashed border-border-default text-sm font-semibold text-accent no-underline hover:bg-surface-hover"
        >
          {hidden} more need you
          <ChevronDown size={16} aria-hidden />
        </a>
      )}
    </div>
  );
}

function RowsSection({
  title,
  hint,
  ideas,
}: {
  title: string;
  hint?: string;
  ideas: IdeaRowData[];
}) {
  if (ideas.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title={title} count={ideas.length} hint={hint} />
      <Card label={title}>
        {ideas.map((idea) => (
          <IdeaRow key={`${title}-${idea.id}`} idea={idea} />
        ))}
      </Card>
    </div>
  );
}

/** Collapsed groups: there when you want them, out of the way otherwise. */
function Folded({ title, hint, icon }: { title: string; hint: string; icon: ReactNode }) {
  return (
    <a
      href="#folded"
      className="group flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-border-default px-4 py-3 no-underline glass-surface hover:bg-surface-hover"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold text-fg-primary">{title}</span>
        <span className="line-clamp-2 text-[13px] text-fg-muted">{hint}</span>
      </span>
      <ChevronDown size={18} aria-hidden className="shrink-0 text-fg-muted" />
    </a>
  );
}

function AgentIcon() {
  return (
    <span
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
      style={{
        background: 'color-mix(in srgb, var(--sam-color-fg-muted) 14%, transparent)',
        color: 'var(--sam-color-fg-muted)',
      }}
      aria-hidden
    >
      <Bot size={18} />
    </span>
  );
}

function FiledByAgents() {
  return (
    <Folded
      title={`Filed by agents · ${FILED_BY_AGENTS.count}`}
      hint={`Errors and findings agents noticed. Newest: ${FILED_BY_AGENTS.newest}`}
      icon={<AgentIcon />}
    />
  );
}

function DonePanel({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="Done recently" count={count} hint="Last 30 days" />
      <Card label="Done recently">
        {DONE_RECENTLY.map((idea) => (
          <IdeaRow key={idea.id} idea={idea} />
        ))}
        <a
          href="#done"
          className="flex min-h-11 items-center justify-center gap-1 text-sm font-semibold text-accent no-underline hover:bg-surface-hover"
        >
          See all {count}
          <ChevronRight size={16} aria-hidden />
        </a>
      </Card>
    </div>
  );
}

function HowItMoves() {
  const steps: Array<[Parameters<typeof StateIcon>[0]['state'], string]> = [
    ['not-started', 'Not started until someone starts work'],
    ['working', 'In progress while a chat works on it'],
    ['review', 'In review when a pull request is open'],
    ['merged', 'Merged: you decide if it’s done'],
  ];
  return (
    <Card label="How ideas move" className="flex flex-col gap-3 p-4">
      <p className="m-0 text-[15px] font-semibold text-fg-primary">Ideas move on their own</p>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {steps.map(([state, text]) => (
          <li key={state} className="flex items-center gap-3 text-[13px] text-fg-muted">
            <StateIcon state={state} size="sm" />
            {text}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EmptyIdeas() {
  return (
    <Card label="No ideas yet" className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-tint text-accent">
        <Lightbulb size={26} aria-hidden />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="m-0 text-[19px] font-semibold text-fg-primary">No ideas yet</h2>
        <p className="m-0 text-[15px] text-fg-muted">
          Ideas hold what you want done until you start work on it. Agents add them from chats, and
          you can add one any time.
        </p>
      </div>
      <Button>
        <Plus size={18} aria-hidden /> New idea
      </Button>
    </Card>
  );
}

export function IdeasListScene({ scene }: { scene: ListScene }) {
  const isMobile = useIsMobile();
  const isEmpty =
    scene.needsYou.length + scene.inProgress.length + scene.notStarted.length + scene.doneCount === 0;
  if (isEmpty) {
    return (
      <div className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-6 pb-16">
        <Header isMobile={isMobile} />
        <EmptyIdeas />
      </div>
    );
  }
  const main = (
    <>
      <NeedsYou ideas={scene.needsYou} />
      <RowsSection title="In progress" ideas={scene.inProgress} />
      <RowsSection title="Not started" hint="Newest first" ideas={scene.notStarted} />
    </>
  );
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-6 pb-16">
      <Header isMobile={isMobile} />
      {isMobile ? (
        <>
          {main}
          <Folded
            title={`Done recently · ${scene.doneCount}`}
            hint="Shipped in the last 30 days"
            icon={<StateIcon state="done" />}
          />
          <FiledByAgents />
        </>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8">
          <div className="flex min-w-0 flex-col gap-6">{main}</div>
          <div className="flex min-w-0 flex-col gap-6">
            <HowItMoves />
            <DonePanel count={scene.doneCount} />
            <FiledByAgents />
          </div>
        </div>
      )}
    </div>
  );
}
