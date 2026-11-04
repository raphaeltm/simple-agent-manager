/** PROTOTYPE ONLY — screens for /prototype/human-tasks. Never ship to production. */
import {
  Chip,
  Count,
  NavItem,
  NavLabel,
  Pane,
  PaneSeparator,
  PersonAvatar,
  SegmentedControl,
} from '@simple-agent-manager/ui';
import {
  Bell,
  BookOpen,
  CheckSquare,
  Home,
  Lightbulb,
  MessageSquare,
  Moon,
  Sparkles,
  Zap,
} from 'lucide-react';
import { type Dispatch, useEffect, useRef } from 'react';

import { AGENTS, type HumanTask, PEOPLE, type PersonId } from './mock-data';
import { type Action, type Filter, mineCount, type State, visibleTasks } from './model';
import { AgentAvatar, AssignedCard, AssigneeLabel, slotFor, TaskDetail, TaskRow } from './parts';

export function Sidebar({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const mine = mineCount(state);
  const agent = state.mode === 'solo' ? AGENTS.release : AGENTS.launch;
  return (
    <Pane className="flex min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <img src="/sam-head.png" alt="SAM" className="h-8 w-8 object-contain" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg-primary">Acme Billing</div>
          <div className="text-xs text-fg-muted">
            {state.mode === 'team' ? '3 members' : 'Just you'}
          </div>
        </div>
      </div>
      <div className="space-y-0.5 px-3">
        <NavItem
          label="Home"
          icon={<Home size={18} />}
          current={state.view === 'home'}
          onClick={() => dispatch({ type: 'view', view: 'home' })}
        />
        <NavItem
          label="Chat"
          icon={<MessageSquare size={18} />}
          current={state.view === 'chat'}
          onClick={() => dispatch({ type: 'view', view: 'chat' })}
        />
        <NavItem
          label="Your tasks"
          icon={<CheckSquare size={18} />}
          current={state.view === 'tasks'}
          count={mine || undefined}
          countTone="attention"
          onClick={() => dispatch({ type: 'view', view: 'tasks' })}
        />
        <NavItem label="Ideas" icon={<Lightbulb size={18} />} onClick={() => undefined} />
        <NavItem label="Library" icon={<BookOpen size={18} />} onClick={() => undefined} />
        <NavItem label="Notifications" icon={<Bell size={18} />} onClick={() => undefined} />
      </div>
      <PaneSeparator className="mx-4 my-3" />
      <div className="px-4">
        <NavLabel>Chats</NavLabel>
        <button
          type="button"
          onClick={() => dispatch({ type: 'view', view: 'chat' })}
          className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-transparent px-2 py-2 text-left text-[13px] text-fg-primary hover:bg-[var(--sam-glass-v2-raised)]"
        >
          <Sparkles size={15} className="shrink-0 text-[var(--sam-status-success-fg)]" />
          <span className="truncate">{agent.chat}</span>
        </button>
        {state.mode === 'team' && (
          <div className="flex items-center gap-2 px-2 py-2 text-[13px] text-fg-muted">
            <Moon size={15} className="shrink-0" />
            <span className="truncate">{AGENTS.docs.chat}</span>
          </div>
        )}
      </div>
      {state.mode === 'team' && (
        <div className="mt-auto px-4 pt-4 pb-4">
          <NavLabel>Viewing as</NavLabel>
          <div className="mt-2 flex gap-1.5" data-testid="viewer-switch">
            {(Object.keys(PEOPLE) as PersonId[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => dispatch({ type: 'viewer', viewer: p })}
                aria-label={`View as ${PEOPLE[p].name}`}
                className="inline-grid h-11 w-11 cursor-pointer place-items-center rounded-full border-0 bg-transparent"
              >
                <PersonAvatar
                  name={PEOPLE[p].name}
                  person={slotFor(p, state.viewer)}
                  size={32}
                  selected={p === state.viewer}
                  decorative
                />
              </button>
            ))}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            {PEOPLE[state.viewer].name} · {PEOPLE[state.viewer].role}
          </div>
        </div>
      )}
    </Pane>
  );
}

export function ChatView({
  state,
  dispatch,
  compact,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  compact: boolean;
}) {
  const agent = state.mode === 'solo' ? AGENTS.release : AGENTS.launch;
  const fromChat = state.tasks.filter((t) => t.from === agent.id);
  const open = fromChat.filter((t) => t.status === 'open').length;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [state.chat.length]);
  return (
    <div
      className={`grid min-h-0 gap-[var(--sam-space-gutter)] ${compact ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_320px]'}`}
    >
      <div className="flex min-h-0 flex-col gap-[var(--sam-space-gutter)]">
        <Pane variant="slab" className="flex items-center gap-3 px-5 py-3.5">
          <AgentAvatar size={26} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-fg-primary">{agent.chat}</div>
            <div className="text-xs text-fg-muted">{agent.profile}</div>
          </div>
          <Chip tone="success" size="sm" dot>
            Working
          </Chip>
        </Pane>
        <Pane variant="quiet" className="flex min-h-0 flex-1 flex-col" data-testid="chat-pane">
          <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-[720px] space-y-5">
              {state.chat.map((m) =>
                m.from === 'human' ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="sam-raised max-w-[80%] rounded-[18px] px-4 py-2.5 text-[14.5px] text-fg-primary">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="text-[14.5px] leading-relaxed text-fg-primary">
                    {m.wake && (
                      <div
                        data-testid="wake-chip"
                        className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--sam-chip-bg)] px-2.5 py-1 text-xs text-[var(--sam-status-success-fg)]"
                      >
                        <Zap size={12} /> {m.wake}
                      </div>
                    )}
                    {m.text.split('\n\n').map((p, i) => (
                      <p key={i} className="m-0 mb-2">
                        {p}
                      </p>
                    ))}
                    {m.assigned && (
                      <AssignedCard ids={m.assigned} state={state} dispatch={dispatch} />
                    )}
                  </div>
                )
              )}
            </div>
          </div>
        </Pane>
        <Pane variant="slab" className="px-4 py-3">
          <div className="sam-well flex h-11 items-center rounded-[var(--sam-radius-control)] px-3 text-sm text-fg-muted">
            Message {agent.chat}…
          </div>
        </Pane>
      </div>
      {!compact && (
        <Pane className="flex min-h-0 flex-col overflow-y-auto">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <span className="text-[13px] font-semibold text-fg-primary">Handed to people</span>
            {open > 0 && <Count value={open} tone="attention" />}
          </div>
          <div className="px-4 pb-2 text-xs leading-relaxed text-fg-muted">
            The agent keeps working. It wakes when anyone comments, ticks a step or finishes one of
            these.
          </div>
          <PaneSeparator className="mx-4" />
          <div className="px-1 py-1">
            {fromChat.map((t) => (
              <TaskRow key={t.id} task={t} state={state} dispatch={dispatch} />
            ))}
          </div>
        </Pane>
      )}
    </div>
  );
}

const FILTER_LABEL: Record<Filter, string> = { mine: 'Mine', team: 'Everyone', done: 'Done' };

export function TasksView({
  state,
  dispatch,
  compact,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  compact: boolean;
}) {
  const list = visibleTasks(state);
  const selected = state.tasks.find((t) => t.id === state.selected);
  const counts: Record<Filter, number> = {
    mine: visibleTasks({ ...state, filter: 'mine' }).length,
    team: visibleTasks({ ...state, filter: 'team' }).length,
    done: visibleTasks({ ...state, filter: 'done' }).length,
  };
  const filters: Filter[] = state.mode === 'team' ? ['mine', 'team', 'done'] : ['mine', 'done'];

  if (compact && selected) {
    return (
      <TaskDetail
        task={selected}
        state={state}
        dispatch={dispatch}
        onBack={() => dispatch({ type: 'select', id: null })}
      />
    );
  }
  return (
    <div
      className={`grid min-h-0 gap-[var(--sam-space-gutter)] ${compact ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_440px]'}`}
    >
      <div className="flex min-h-0 flex-col gap-[var(--sam-space-gutter)]">
        <Pane variant="slab" className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[17px] font-semibold text-fg-primary">Your tasks</h1>
            <div className="text-xs text-fg-muted">
              Things agents need a person for. Nothing here is blocking them.
            </div>
          </div>
          <SegmentedControl
            className={`shrink-0 ${filters.length === 3 ? 'w-[300px]' : 'w-[170px]'}`}
            label="Filter tasks"
            value={state.filter}
            onChange={(f) => dispatch({ type: 'filter', filter: f })}
            options={filters.map((f) => ({ value: f, label: FILTER_LABEL[f], count: counts[f] }))}
          />
        </Pane>
        <Pane className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="task-list">
          {list.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-fg-muted">
              Nothing waiting on you. Agents will add things here when they need a person.
            </div>
          ) : (
            list.map((t) => <TaskRow key={t.id} task={t} state={state} dispatch={dispatch} />)
          )}
        </Pane>
      </div>
      {!compact &&
        (selected ? (
          <TaskDetail key={selected.id} task={selected} state={state} dispatch={dispatch} />
        ) : (
          <Pane className="grid place-items-center p-8 text-center text-sm text-fg-muted">
            Pick a task to see why the agent needs you.
          </Pane>
        ))}
    </div>
  );
}

/** Cross-project home: everything agents handed to you, grouped by project. */
export function HomeView({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const mine = state.tasks.filter(
    (t) => t.status === 'open' && t.assignee.kind === 'person' && t.assignee.id === state.viewer
  );
  const byProject = mine.reduce<Record<string, HumanTask[]>>((acc, t) => {
    (acc[t.project] ??= []).push(t);
    return acc;
  }, {});
  return (
    <div className="flex min-h-0 flex-col gap-[var(--sam-space-gutter)] overflow-y-auto">
      <Pane variant="slab" className="px-5 py-4">
        <h1 className="m-0 text-[17px] font-semibold text-fg-primary">
          Good morning, {PEOPLE[state.viewer].name.split(' ')[0]}
        </h1>
        <div className="text-xs text-fg-muted">
          Agents handed you {mine.length} things across {Object.keys(byProject).length} projects.
          None of them are blocking work.
        </div>
      </Pane>
      {Object.entries(byProject).map(([project, tasks]) => (
        <Pane key={project} className="p-2" data-testid="home-project">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <span className="text-[13px] font-semibold text-fg-primary">{project}</span>
            <Count value={tasks.length} tone="attention" />
          </div>
          {tasks.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 rounded-[var(--sam-radius-control)] px-3 py-2.5"
            >
              <button
                type="button"
                onClick={() => dispatch({ type: 'select', id: t.id })}
                className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-[14px] text-fg-primary"
              >
                {t.title}
              </button>
              <span className="hidden shrink-0 text-xs text-fg-muted sm:inline">
                <AssigneeLabel task={t} viewer={state.viewer} />
              </span>
              <span className="shrink-0 font-mono text-xs text-fg-muted">{t.due}</span>
            </div>
          ))}
        </Pane>
      ))}
      <Pane
        variant="quiet"
        className="px-5 py-4 text-xs leading-relaxed text-fg-muted"
        data-testid="home-note"
      >
        No push notification was sent for these. You get one quiet daily digest; agents only ping
        you directly with
        <span className="font-mono"> request_human_input</span> when they are actually stuck.
      </Pane>
    </div>
  );
}
