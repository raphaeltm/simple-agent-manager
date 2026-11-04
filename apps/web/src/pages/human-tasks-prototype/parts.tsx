/** PROTOTYPE ONLY — building blocks for /prototype/human-tasks. Never ship to production. */
import {
  Button,
  Chip,
  Pane,
  PaneSeparator,
  PersonAvatar,
  type PersonSlot,
} from '@simple-agent-manager/ui';
import {
  Archive,
  ArrowLeft,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  Hand,
  MessageSquare,
  RotateCcw,
  Send,
  Users,
  Zap,
} from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';

import {
  type Activity,
  AGENTS,
  type AgentId,
  type HumanTask,
  PEOPLE,
  type PersonId,
} from './mock-data';
import type { Action, Delivery, State } from './model';

export function slotFor(person: PersonId, viewer: PersonId): PersonSlot {
  if (person === viewer) return 'you';
  const others = (Object.keys(PEOPLE) as PersonId[]).filter((p) => p !== viewer);
  return (others.indexOf(person) + 1) as 1 | 2;
}

export function nameFor(person: PersonId, viewer: PersonId): string {
  return person === viewer ? 'You' : PEOPLE[person].name.split(' ')[0]!;
}

export function AgentAvatar({ size = 20 }: { size?: 14 | 20 | 26 }) {
  const px = size === 14 ? 'h-3.5 w-3.5' : size === 20 ? 'h-5 w-5' : 'h-[26px] w-[26px]';
  return (
    <span
      aria-hidden="true"
      className={`inline-grid ${px} shrink-0 place-items-center rounded-full bg-[var(--sam-person-auto)] text-[var(--sam-person-ink)] shadow-[0_0_0_2px_var(--sam-separator)]`}
    >
      <Bot size={size === 14 ? 9 : size === 20 ? 12 : 15} strokeWidth={2.25} />
    </span>
  );
}

export function AssigneeLabel({ task, viewer }: { task: HumanTask; viewer: PersonId }) {
  if (task.assignee.kind === 'team') {
    if (task.claimedBy) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <PersonAvatar
            name={PEOPLE[task.claimedBy].name}
            person={slotFor(task.claimedBy, viewer)}
            size={14}
            decorative
          />
          {nameFor(task.claimedBy, viewer)} took it
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--sam-color-warning)]">
        <Users size={13} /> Anyone on the team
      </span>
    );
  }
  const id = task.assignee.id;
  return (
    <span className="inline-flex items-center gap-1.5">
      <PersonAvatar name={PEOPLE[id].name} person={slotFor(id, viewer)} size={14} decorative />
      {nameFor(id, viewer)}
    </span>
  );
}

/** One row in the human task list. */
export function TaskRow({
  task,
  state,
  dispatch,
}: {
  task: HumanTask;
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const selected = state.selected === task.id;
  const done = task.status !== 'open';
  const comments = task.activity.filter((a) => a.kind === 'comment').length;
  const stepsDone = task.steps.filter((s) => s.done).length;
  return (
    <div
      data-testid={`task-row-${task.id}`}
      className={`group flex items-start gap-3 rounded-[var(--sam-radius-control)] px-3 py-3 transition-colors ${
        selected ? 'sam-raised' : 'hover:bg-[var(--sam-glass-v2-raised)]'
      }`}
    >
      <button
        type="button"
        aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
        onClick={() => dispatch({ type: done ? 'reopen' : 'complete', id: task.id })}
        className="mt-0.5 inline-grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-fg-muted hover:text-[var(--sam-status-success-fg)]"
      >
        {done ? (
          <CheckCircle2 size={20} className="text-[var(--sam-status-success-fg)]" />
        ) : (
          <Circle size={20} />
        )}
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: 'select', id: task.id })}
        className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left"
      >
        <span
          className={`block text-[14.5px] font-medium leading-snug [overflow-wrap:anywhere] ${done ? 'text-fg-muted line-through' : 'text-fg-primary'}`}
        >
          {task.title}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <AgentAvatar size={14} />
            {AGENTS[task.from].chat}
          </span>
          {state.mode === 'team' && <AssigneeLabel task={task} viewer={state.viewer} />}
          {task.steps.length > 0 && (
            <span className="font-mono">
              {stepsDone}/{task.steps.length} steps
            </span>
          )}
          {comments > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare size={12} /> {comments}
            </span>
          )}
          {task.due && !done && <span className="font-mono">{task.due}</span>}
        </span>
      </button>
    </div>
  );
}

function ActivityLine({ item, viewer }: { item: Activity; viewer: PersonId }) {
  const who =
    item.actor.type === 'person'
      ? nameFor(item.actor.id, viewer)
      : item.actor.type === 'agent'
        ? AGENTS[item.actor.id].chat
        : 'SAM';
  const avatar =
    item.actor.type === 'person' ? (
      <PersonAvatar
        name={PEOPLE[item.actor.id].name}
        person={slotFor(item.actor.id, viewer)}
        size={20}
        decorative
      />
    ) : (
      <AgentAvatar />
    );

  if (item.kind === 'woke') {
    return (
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1 pl-7 text-xs text-[var(--sam-status-success-fg)]">
        <Zap size={12} /> <span className="font-medium">{who}</span>
        <span className="text-fg-muted">woke up on</span>
        <span className="font-mono">human_task.{item.text}</span>
      </div>
    );
  }
  if (item.kind === 'comment') {
    return (
      <div className="flex gap-2 py-2">
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-semibold text-fg-primary">{who}</span>
            <span className="font-mono text-fg-muted">{item.at}</span>
          </div>
          <p className="m-0 mt-0.5 text-[13.5px] leading-relaxed text-fg-primary [overflow-wrap:anywhere]">{item.text}</p>
        </div>
      </div>
    );
  }
  const verb: Record<Activity['kind'], string> = {
    created: 'assigned this',
    step: `ticked “${item.text ?? ''}”`,
    claimed: 'took this',
    completed: 'marked this done',
    archived: 'archived this',
    reopened: 'reopened this',
    comment: '',
    woke: '',
  };
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-fg-muted">
      {avatar}
      <span>
        <span className="font-medium text-fg-primary">{who}</span> {verb[item.kind]}
      </span>
      <span className="ml-auto font-mono">{item.at}</span>
    </div>
  );
}

/** The right-hand detail pane for one human task. */
export function TaskDetail({
  task,
  state,
  dispatch,
  onBack,
}: {
  task: HumanTask;
  state: State;
  dispatch: Dispatch<Action>;
  onBack?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const done = task.status !== 'open';
  // Keep the newest activity (an agent's reply after it woke) in view.
  const seen = useRef(task.activity.length);
  useEffect(() => {
    if (task.activity.length > seen.current) {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    }
    seen.current = task.activity.length;
  }, [task.activity.length]);
  const canClaim = task.assignee.kind === 'team' && !task.claimedBy && !done;
  return (
    <Pane className="flex min-h-0 min-w-0 flex-col" data-testid="task-detail">
      <div className="flex items-start gap-2 px-5 pt-5 pb-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to list"
            className="-ml-2 inline-grid h-9 w-9 place-items-center rounded-full border-0 bg-transparent text-fg-muted"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {done ? (
              <Chip tone="success" size="sm" icon={<Check size={11} />}>
                {task.status === 'archived' ? 'Archived' : 'Done'}
              </Chip>
            ) : (
              <Chip tone="warning" size="sm" dot>
                Waiting on{' '}
                {task.assignee.kind === 'team' && !task.claimedBy ? 'the team' : 'a person'}
              </Chip>
            )}
            <Chip tone="muted" size="sm">
              Not blocking
            </Chip>
            {task.due && (
              <Chip tone="neutral" size="sm">
                {task.due}
              </Chip>
            )}
          </div>
          <h2 className="m-0 text-lg font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]">{task.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="inline-flex items-center gap-1.5">
              <AgentAvatar size={14} /> from {AGENTS[task.from].chat}
            </span>
            <span>→</span>
            <AssigneeLabel task={task} viewer={state.viewer} />
          </div>
        </div>
      </div>
      <PaneSeparator className="mx-5" />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="m-0 text-[13.5px] leading-relaxed text-fg-muted [overflow-wrap:anywhere]">{task.why}</p>
        {task.steps.length > 0 && (
          <ul className="m-0 mt-4 list-none space-y-1 p-0">
            {task.steps.map((step) => (
              <li key={step.id}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-[13.5px] hover:bg-[var(--sam-glass-v2-raised)]">
                  <input
                    type="checkbox"
                    checked={step.done}
                    onChange={() => dispatch({ type: 'step', id: task.id, step: step.id })}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--sam-color-accent-primary)]"
                  />
                  <span className={`min-w-0 [overflow-wrap:anywhere] ${step.done ? 'text-fg-muted line-through' : 'text-fg-primary'}`}>
                    {step.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 rounded-[var(--sam-radius-control)] sam-well px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            <Bell size={12} /> Watching this task
          </div>
          {task.subscribers.map((s) => (
            <div key={s.agent} className="py-1 text-xs">
              <div className="flex items-center gap-2">
                <AgentAvatar size={14} />
                <span className="font-medium text-fg-primary">{AGENTS[s.agent].chat}</span>
              </div>
              <div className="mt-1 pl-[22px] font-mono text-[11px] leading-relaxed text-fg-muted">
                wakes on {s.on.join(' · ')}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Activity
        </div>
        <div className="mt-1">
          {task.activity.map((item) => (
            <ActivityLine key={item.id} item={item} viewer={state.viewer} />
          ))}
        </div>
      </div>
      <PaneSeparator className="mx-5" />
      <div className="space-y-3 px-5 pt-3 pb-5">
        <form
          className="sam-well flex items-center gap-2 rounded-[var(--sam-radius-control)] pl-3 pr-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            dispatch({ type: 'comment', id: task.id, text: draft.trim() });
            setDraft('');
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Comment — the agent will see it"
            aria-label="Comment"
            className="h-10 min-w-0 flex-1 border-0 bg-transparent text-base text-fg-primary outline-none placeholder:text-fg-muted md:text-sm"
          />
          <button
            type="submit"
            aria-label="Send comment"
            className="inline-grid h-8 w-8 place-items-center rounded-[10px] border-0 bg-transparent text-fg-muted hover:text-fg-primary"
          >
            <Send size={16} />
          </button>
        </form>
        <div className="flex flex-wrap gap-2">
          {canClaim && (
            <Button
              variant="raised"
              size="sm"
              onClick={() => dispatch({ type: 'claim', id: task.id })}
            >
              <Hand size={15} /> I'll take it
            </Button>
          )}
          {done ? (
            <Button
              variant="raised"
              size="sm"
              onClick={() => dispatch({ type: 'reopen', id: task.id })}
            >
              <RotateCcw size={15} /> Reopen
            </Button>
          ) : (
            <Button
              variant="accent"
              size="sm"
              onClick={() => dispatch({ type: 'complete', id: task.id })}
            >
              <Check size={15} /> Mark done
            </Button>
          )}
          {task.status !== 'archived' && (
            <Button
              variant="raised"
              size="sm"
              onClick={() => dispatch({ type: 'archive', id: task.id })}
            >
              <Archive size={15} /> Archive
            </Button>
          )}
        </div>
      </div>
    </Pane>
  );
}

/** Inline chat card: "I put N things on someone's list" (the agent keeps going). */
export function AssignedCard({
  ids,
  state,
  dispatch,
}: {
  ids: string[];
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const tasks = state.tasks.filter((t) => ids.includes(t.id));
  return (
    <div
      className="mt-3 rounded-[var(--sam-radius-control)] sam-well p-2"
      data-testid="assigned-card"
    >
      <div className="flex items-center gap-2 px-2 pt-1 pb-2 text-xs text-fg-muted">
        <CircleDot size={13} className="text-[var(--sam-color-warning)]" />
        <span className="font-mono">assign_human_task</span>
        <span>·</span>
        <span>{tasks.length} added to task lists · not blocking</span>
      </div>
      {tasks.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dispatch({ type: 'select', id: t.id })}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-2 py-2 text-left hover:bg-[var(--sam-glass-v2-raised)]"
        >
          {t.status === 'open' ? (
            <Circle size={16} className="shrink-0 text-fg-muted" />
          ) : (
            <CheckCircle2 size={16} className="shrink-0 text-[var(--sam-status-success-fg)]" />
          )}
          <span
            className={`min-w-0 flex-1 truncate text-[13.5px] ${t.status === 'open' ? 'text-fg-primary' : 'text-fg-muted line-through'}`}
          >
            {t.title}
          </span>
          <span className="shrink-0 text-xs text-fg-muted">
            <AssigneeLabel task={t} viewer={state.viewer} />
          </span>
        </button>
      ))}
    </div>
  );
}

/** Shows the latest event delivery so the "agent woke" moment is visible. */
export function DeliveryToast({
  delivery,
  viewer,
}: {
  delivery: Delivery | undefined;
  viewer: PersonId;
}) {
  if (!delivery) return null;
  return (
    <div
      key={delivery.id}
      data-testid="delivery-toast"
      className="sam-glass sam-glass--slab sam-glass-rim pointer-events-none flex items-center gap-3 rounded-[var(--sam-radius-slab)] px-4 py-3 text-[13px] text-fg-primary"
    >
      <span className="inline-grid h-7 w-7 place-items-center rounded-full bg-[var(--sam-count-active)] text-[var(--sam-count-active-ink)]">
        <Zap size={15} />
      </span>
      <span className="min-w-0">
        <span className="font-mono text-xs text-fg-muted">human_task.{delivery.event}</span>
        <span className="block">
          {nameFor(delivery.actor, viewer)} → woke{' '}
          {delivery.agents.map((a: AgentId) => AGENTS[a].chat).join(' and ')}
        </span>
      </span>
    </div>
  );
}
