/**
 * PROTOTYPE ONLY — state for /prototype/human-tasks.
 *
 * Every human action becomes a task event. Agents subscribed to that event are "woken" and
 * their scripted reply lands in the task thread and in their chat, which is what the real
 * system would do through project event subscriptions with existing-session delivery.
 */
import {
  type Activity,
  type AgentId,
  type ChatMessage,
  type HumanTask,
  type HumanTaskEvent,
  PEOPLE,
  type PersonId,
  SOLO_CHAT,
  SOLO_TASKS,
  TEAM_CHAT,
  TEAM_TASKS,
} from './mock-data';

export type Mode = 'solo' | 'team';
export type View = 'chat' | 'tasks' | 'home';
export type Filter = 'mine' | 'team' | 'done';

export interface Delivery {
  id: string;
  event: HumanTaskEvent;
  taskTitle: string;
  actor: PersonId;
  agents: AgentId[];
}

export interface State {
  mode: Mode;
  view: View;
  viewer: PersonId;
  filter: Filter;
  selected: string | null;
  tasks: HumanTask[];
  chat: ChatMessage[];
  deliveries: Delivery[];
  seq: number;
}

export type Action =
  | { type: 'view'; view: View }
  | { type: 'viewer'; viewer: PersonId }
  | { type: 'filter'; filter: Filter }
  | { type: 'select'; id: string | null }
  | { type: 'comment'; id: string; text: string }
  | { type: 'step'; id: string; step: string }
  | { type: 'claim'; id: string }
  | { type: 'complete'; id: string }
  | { type: 'archive'; id: string }
  | { type: 'reopen'; id: string };

export function initialState(mode: Mode): State {
  const solo = mode === 'solo';
  return {
    mode,
    view: 'chat',
    viewer: 'raph',
    filter: 'mine',
    selected: null,
    tasks: structuredClone(solo ? SOLO_TASKS : TEAM_TASKS),
    chat: structuredClone(solo ? SOLO_CHAT : TEAM_CHAT),
    deliveries: [],
    seq: 1,
  };
}

/** What a woken agent says back. Keyed by `${taskId}:${event}`. */
const REPLIES: Record<string, { agent: AgentId; thread?: string; chat?: string }[]> = {
  'ht-stripe-secret:commented': [
    {
      agent: 'release',
      thread:
        'Live. Test mode is already wired up on staging. The production endpoint is the one ending in /api/stripe/webhook.',
    },
  ],
  'ht-stripe-secret:completed': [
    {
      agent: 'release',
      thread: 'Verified: production received a signed test event and accepted it. Thanks!',
      chat: 'The webhook secret is in. I sent a signed test event to production and it was accepted, so billing is ready for Friday. Back to the refund flow.',
    },
  ],
  'ht-tax-review:completed': [
    { agent: 'release', chat: 'Got it, keeping the VAT-inclusive copy and deleting the other.' },
  ],
  'ht-pricing-copy:commented': [
    {
      agent: 'launch',
      thread: 'Changed "unlimited" to "up to 10 seats" in the draft. Anything else?',
    },
  ],
  'ht-pricing-copy:completed': [
    {
      agent: 'launch',
      thread: 'Thanks Maya. Publishing the copy to the pricing page now.',
      chat: "Maya approved the pricing copy. I've published it and moved the launch post to final review.",
    },
    { agent: 'docs', chat: 'Pricing copy is final, so I updated the pricing docs to match it.' },
  ],
  'ht-dns:claimed': [
    {
      agent: 'launch',
      thread: 'Thanks Jonas. The record is ready in the DNS tab whenever you are.',
    },
  ],
  'ht-dns:completed': [
    {
      agent: 'launch',
      chat: 'Jonas applied the DNS change. billing.acme.com resolves and the certificate is live.',
    },
  ],
  'ht-demo:claimed': [
    {
      agent: 'launch',
      thread: 'Great. Drop the file in the Library under /launch/ and tick this off.',
    },
  ],
};

const EVENT_FOR: Record<
  Exclude<Action['type'], 'view' | 'viewer' | 'filter' | 'select'>,
  HumanTaskEvent
> = {
  comment: 'commented',
  step: 'step_checked',
  claim: 'claimed',
  complete: 'completed',
  archive: 'archived',
  reopen: 'reopened',
};

function act(
  state: State,
  id: string,
  event: HumanTaskEvent,
  mutate: (t: HumanTask) => Activity[]
): State {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return state;
  let seq = state.seq;
  const next = structuredClone(task);
  const now = `11:${String(10 + seq).padStart(2, '0')}`;
  const added = mutate(next).map((a) => ({ ...a, id: `act-${seq++}`, at: now }));
  next.activity.push(...added);

  const woken = next.subscribers.filter((s) => s.on.includes(event)).map((s) => s.agent);
  const chat = [...state.chat];
  const deliveries = [...state.deliveries];
  if (woken.length > 0) {
    deliveries.push({
      id: `d-${seq++}`,
      event,
      taskTitle: next.title,
      actor: state.viewer,
      agents: woken,
    });
    for (const agent of woken) {
      next.activity.push({
        id: `act-${seq++}`,
        actor: { type: 'agent', id: agent },
        kind: 'woke',
        text: event,
        at: now,
      });
    }
    for (const reply of REPLIES[`${id}:${event}`] ?? []) {
      if (reply.thread) {
        next.activity.push({
          id: `act-${seq++}`,
          actor: { type: 'agent', id: reply.agent },
          kind: 'comment',
          text: reply.thread,
          at: now,
        });
      }
      if (reply.chat) {
        chat.push({
          id: `m-${seq++}`,
          from: 'agent',
          agent: reply.agent,
          text: reply.chat,
          wake: `Woke because ${state.viewer === 'raph' ? 'you' : PEOPLE[state.viewer].name.split(' ')[0]} ${event.replace('_', ' ')} “${next.title}”`,
        });
      }
    }
  }
  return {
    ...state,
    seq,
    chat,
    deliveries,
    tasks: state.tasks.map((t) => (t.id === id ? next : t)),
  };
}

export function reducer(state: State, action: Action): State {
  const me = { type: 'person' as const, id: state.viewer };
  switch (action.type) {
    case 'view':
      return { ...state, view: action.view };
    case 'viewer':
      return { ...state, viewer: action.viewer, selected: null };
    case 'filter':
      return { ...state, filter: action.filter };
    case 'select':
      return { ...state, selected: action.id, view: 'tasks' };
    case 'comment':
      return act(state, action.id, EVENT_FOR.comment, () => [
        { id: '', actor: me, kind: 'comment', text: action.text, at: '' },
      ]);
    case 'step':
      return act(state, action.id, EVENT_FOR.step, (t) => {
        const step = t.steps.find((s) => s.id === action.step);
        if (!step) return [];
        step.done = !step.done;
        return [{ id: '', actor: me, kind: 'step', text: step.text, at: '' }];
      });
    case 'claim':
      return act(state, action.id, EVENT_FOR.claim, (t) => {
        t.claimedBy = state.viewer;
        return [{ id: '', actor: me, kind: 'claimed', at: '' }];
      });
    case 'complete':
      return act(state, action.id, EVENT_FOR.complete, (t) => {
        t.status = 'done';
        t.steps.forEach((s) => (s.done = true));
        return [{ id: '', actor: me, kind: 'completed', at: '' }];
      });
    case 'archive':
      return act(state, action.id, EVENT_FOR.archive, (t) => {
        t.status = 'archived';
        return [{ id: '', actor: me, kind: 'archived', at: '' }];
      });
    case 'reopen':
      return act(state, action.id, EVENT_FOR.reopen, (t) => {
        t.status = 'open';
        return [{ id: '', actor: me, kind: 'reopened', at: '' }];
      });
  }
}

/** Deterministic presets so screenshots and the video can jump straight to a moment. */
export const SCENES: Record<string, { mode: Mode; actions: Action[] }> = {
  'solo-chat': { mode: 'solo', actions: [] },
  'solo-list': { mode: 'solo', actions: [{ type: 'select', id: 'ht-stripe-secret' }] },
  'solo-comment': {
    mode: 'solo',
    actions: [
      { type: 'select', id: 'ht-stripe-secret' },
      { type: 'comment', id: 'ht-stripe-secret', text: 'Live or test mode secret?' },
    ],
  },
  'solo-done': {
    mode: 'solo',
    actions: [
      { type: 'select', id: 'ht-stripe-secret' },
      { type: 'comment', id: 'ht-stripe-secret', text: 'Live or test mode secret?' },
      { type: 'step', id: 'ht-stripe-secret', step: 's1' },
      { type: 'step', id: 'ht-stripe-secret', step: 's2' },
      { type: 'step', id: 'ht-stripe-secret', step: 's3' },
      { type: 'complete', id: 'ht-stripe-secret' },
    ],
  },
  'solo-done-chat': {
    mode: 'solo',
    actions: [
      { type: 'select', id: 'ht-stripe-secret' },
      { type: 'comment', id: 'ht-stripe-secret', text: 'Live or test mode secret?' },
      { type: 'complete', id: 'ht-stripe-secret' },
      { type: 'view', view: 'chat' },
    ],
  },
  'team-chat': { mode: 'team', actions: [] },
  'team-list': {
    mode: 'team',
    actions: [
      { type: 'filter', filter: 'team' },
      { type: 'select', id: 'ht-dns' },
    ],
  },
  'team-maya': {
    mode: 'team',
    actions: [
      { type: 'viewer', viewer: 'maya' },
      { type: 'select', id: 'ht-pricing-copy' },
      {
        type: 'comment',
        id: 'ht-pricing-copy',
        text: '"Unlimited seats" isn\'t true on the Team plan. Can you fix that line?',
      },
    ],
  },
  'team-claim': {
    mode: 'team',
    actions: [
      { type: 'viewer', viewer: 'jonas' },
      { type: 'filter', filter: 'team' },
      { type: 'select', id: 'ht-dns' },
      { type: 'claim', id: 'ht-dns' },
    ],
  },
  'team-done': {
    mode: 'team',
    actions: [
      { type: 'viewer', viewer: 'maya' },
      { type: 'select', id: 'ht-pricing-copy' },
      {
        type: 'comment',
        id: 'ht-pricing-copy',
        text: '"Unlimited seats" isn\'t true on the Team plan. Can you fix that line?',
      },
      { type: 'complete', id: 'ht-pricing-copy' },
    ],
  },
  'team-done-chat': {
    mode: 'team',
    actions: [
      { type: 'viewer', viewer: 'maya' },
      { type: 'select', id: 'ht-pricing-copy' },
      { type: 'complete', id: 'ht-pricing-copy' },
      { type: 'viewer', viewer: 'jonas' },
      { type: 'filter', filter: 'team' },
      { type: 'select', id: 'ht-dns' },
      { type: 'claim', id: 'ht-dns' },
      { type: 'complete', id: 'ht-dns' },
      { type: 'viewer', viewer: 'raph' },
      { type: 'view', view: 'chat' },
    ],
  },
  'team-raph-list': {
    mode: 'team',
    actions: [
      { type: 'viewer', viewer: 'maya' },
      { type: 'select', id: 'ht-pricing-copy' },
      { type: 'complete', id: 'ht-pricing-copy' },
      { type: 'viewer', viewer: 'jonas' },
      { type: 'select', id: 'ht-dns' },
      { type: 'claim', id: 'ht-dns' },
      { type: 'viewer', viewer: 'raph' },
      { type: 'filter', filter: 'team' },
      { type: 'select', id: 'ht-dns' },
    ],
  },
  home: { mode: 'solo', actions: [{ type: 'view', view: 'home' }] },
};

/** Stress data: many tasks, long unbroken text, empty optional fields. */
function stressState(): State {
  const base = initialState('solo');
  const extra: HumanTask[] = Array.from({ length: 28 }, (_, i) => ({
    id: `ht-stress-${i}`,
    project:
      i % 3 === 0 ? 'A project with an unusually long name that keeps going' : 'Acme Billing',
    title:
      i === 0
        ? 'Confirm https://billing.acme.example.com/api/v2/webhooks/stripe/production/endpoint-signing-secret-rotation is the right URL before the agent rotates it'
        : i === 1
          ? 'X'
          : `Follow-up ${i + 1}: check the <script>alert(1)</script> & émoji-free copy for région ${i}`,
    why: i === 0 ? 'A'.repeat(400) : '',
    steps:
      i % 4 === 0
        ? [{ id: 's1', text: 'Step with a very long instruction '.repeat(6), done: false }]
        : [],
    assignee: { kind: 'person', id: 'raph' },
    status: i % 7 === 6 ? 'done' : 'open',
    from: i % 2 ? 'release' : 'docs',
    due: i % 5 === 0 ? undefined : 'Nov 30',
    subscribers: [{ agent: 'release', on: ['completed'] }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'release' }, kind: 'created', at: '10:42' }],
  }));
  return { ...base, view: 'tasks', selected: 'ht-stress-0', tasks: [...base.tasks, ...extra] };
}

export function sceneState(name: string | null): State {
  if (name === 'stress') return stressState();
  const scene = (name ? SCENES[name] : undefined) ?? { mode: 'solo' as const, actions: [] };
  return scene.actions.reduce(reducer, initialState(scene.mode));
}

/** Which tasks a viewer sees under each filter. */
export function visibleTasks(state: State): HumanTask[] {
  const { tasks, viewer, filter } = state;
  if (filter === 'done') return tasks.filter((t) => t.status !== 'open');
  const open = tasks.filter((t) => t.status === 'open');
  if (filter === 'team') return open;
  return open.filter(
    (t) => (t.assignee.kind === 'person' && t.assignee.id === viewer) || t.claimedBy === viewer
  );
}

export function mineCount(state: State): number {
  return state.tasks.filter(
    (t) =>
      t.status === 'open' &&
      ((t.assignee.kind === 'person' && t.assignee.id === state.viewer) ||
        t.claimedBy === state.viewer)
  ).length;
}
