/**
 * PROTOTYPE ONLY — mock data for /prototype/human-tasks. Never ship to production.
 *
 * Models "agents assign work to humans": non-blocking to-dos an agent hands to a person (or to
 * the whole project team), which the agent subscribes to so a comment, a checked step, a
 * completion or an archive wakes it back up.
 */

export type PersonId = 'raph' | 'maya' | 'jonas';
export type AgentId = 'release' | 'launch' | 'docs';

export interface Person {
  id: PersonId;
  name: string;
  role: string;
  /** Join order on the project: 0 = owner. Drives the stable person colour. */
  joinOrder: number;
}

export interface Agent {
  id: AgentId;
  /** The chat this agent is working in. */
  chat: string;
  profile: string;
}

export type HumanTaskEvent =
  'commented' | 'step_checked' | 'claimed' | 'completed' | 'archived' | 'reopened';

export type Assignee = { kind: 'person'; id: PersonId } | { kind: 'team' };

export type Actor =
  { type: 'person'; id: PersonId } | { type: 'agent'; id: AgentId } | { type: 'system' };

export interface Activity {
  id: string;
  actor: Actor;
  kind: 'created' | 'comment' | 'step' | 'claimed' | 'completed' | 'archived' | 'reopened' | 'woke';
  text?: string;
  at: string;
}

export interface HumanTask {
  id: string;
  project: string;
  title: string;
  why: string;
  steps: { id: string; text: string; done: boolean }[];
  assignee: Assignee;
  claimedBy?: PersonId;
  status: 'open' | 'done' | 'archived';
  from: AgentId;
  due?: string;
  /** Agents woken by events on this task. */
  subscribers: { agent: AgentId; on: HumanTaskEvent[] }[];
  activity: Activity[];
}

export interface ChatMessage {
  id: string;
  from: 'human' | 'agent';
  person?: PersonId;
  agent?: AgentId;
  text: string;
  /** Inline "assigned to a human" card listing these task ids. */
  assigned?: string[];
  /** Small system line ("Woke on: Maya completed …"). */
  wake?: string;
}

export const PEOPLE: Record<PersonId, Person> = {
  raph: { id: 'raph', name: 'Raphaël', role: 'Owner', joinOrder: 0 },
  maya: { id: 'maya', name: 'Maya Chen', role: 'Marketing', joinOrder: 1 },
  jonas: { id: 'jonas', name: 'Jonas Weber', role: 'Admin · infra', joinOrder: 2 },
};

export const AGENTS: Record<AgentId, Agent> = {
  release: { id: 'release', chat: 'Stripe billing release', profile: 'Opus 5.5 Chat' },
  launch: { id: 'launch', chat: 'Launch week checklist', profile: 'Sol' },
  docs: { id: 'docs', chat: 'Pricing docs refresh', profile: 'Codex' },
};

const ALL_EVENTS: HumanTaskEvent[] = [
  'commented',
  'step_checked',
  'claimed',
  'completed',
  'archived',
  'reopened',
];

/** Solo flow: one person, one agent, two tasks only a human can do. */
export const SOLO_TASKS: HumanTask[] = [
  {
    id: 'ht-stripe-secret',
    project: 'Acme Billing',
    title: 'Add the Stripe webhook secret to production',
    why: "I can't read or write production secrets. Billing is merged and live on staging, but production webhooks will be rejected until this secret exists.",
    steps: [
      { id: 's1', text: 'Open Stripe → Developers → Webhooks → Production endpoint', done: false },
      { id: 's2', text: 'Copy the signing secret (starts with whsec_)', done: false },
      { id: 's3', text: 'Paste it as STRIPE_WEBHOOK_SECRET in Settings → Accounts', done: false },
    ],
    assignee: { kind: 'person', id: 'raph' },
    status: 'open',
    from: 'release',
    due: 'Before Friday deploy',
    subscribers: [{ agent: 'release', on: ['commented', 'completed', 'archived', 'reopened'] }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'release' }, kind: 'created', at: '10:42' }],
  },
  {
    id: 'ht-tax-review',
    project: 'Acme Billing',
    title: 'Decide whether EU prices include VAT',
    why: 'Pricing page copy depends on it. I wrote both versions; pick one and I will delete the other.',
    steps: [],
    assignee: { kind: 'person', id: 'raph' },
    status: 'open',
    from: 'release',
    due: 'This week',
    subscribers: [{ agent: 'release', on: ['commented', 'completed', 'archived'] }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'release' }, kind: 'created', at: '10:42' }],
  },
  {
    id: 'ht-old-domain',
    project: 'Marketing site',
    title: 'Renew acme-old.com or let it lapse',
    why: 'Registrar emailed about renewal. Nothing links to it any more.',
    steps: [],
    assignee: { kind: 'person', id: 'raph' },
    status: 'open',
    from: 'docs',
    due: 'Nov 20',
    subscribers: [{ agent: 'docs', on: ['completed', 'commented'] }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'docs' }, kind: 'created', at: 'Mon' }],
  },
];

/** Team flow: the agent routes work to a person, by role, or to the whole team. */
export const TEAM_TASKS: HumanTask[] = [
  {
    id: 'ht-pricing-copy',
    project: 'Acme Billing',
    title: 'Review the new pricing page copy',
    why: 'Tone and claims need a marketing eye before launch. Draft is in the Library: /launch/pricing-copy.md',
    steps: [
      { id: 's1', text: 'Read the draft', done: false },
      { id: 's2', text: 'Leave comments or approve', done: false },
    ],
    assignee: { kind: 'person', id: 'maya' },
    status: 'open',
    from: 'launch',
    due: 'Wed',
    subscribers: [
      { agent: 'launch', on: ALL_EVENTS },
      { agent: 'docs', on: ['completed'] },
    ],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'launch' }, kind: 'created', at: '09:15' }],
  },
  {
    id: 'ht-dns',
    project: 'Acme Billing',
    title: 'Approve the DNS change for billing.acme.com',
    why: 'Needs someone with admin on the Cloudflare account. The record is prepared; it only needs a human to apply it.',
    steps: [{ id: 's1', text: 'Apply CNAME billing → acme-billing.pages.dev', done: false }],
    assignee: { kind: 'team' },
    status: 'open',
    from: 'launch',
    due: 'Thu',
    subscribers: [{ agent: 'launch', on: ALL_EVENTS }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'launch' }, kind: 'created', at: '09:15' }],
  },
  {
    id: 'ht-demo',
    project: 'Acme Billing',
    title: 'Record a 60 second demo of checkout',
    why: 'Anyone can take this. Screen recording plus voice works; I will cut it into the launch post.',
    steps: [],
    assignee: { kind: 'team' },
    status: 'open',
    from: 'launch',
    due: 'Fri',
    subscribers: [{ agent: 'launch', on: ['claimed', 'completed', 'commented'] }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'launch' }, kind: 'created', at: '09:15' }],
  },
  {
    id: 'ht-stripe-live',
    project: 'Acme Billing',
    title: 'Switch Stripe to live mode',
    why: 'Owner-only: the Stripe account is in your name.',
    steps: [],
    assignee: { kind: 'person', id: 'raph' },
    status: 'open',
    from: 'launch',
    due: 'Fri',
    subscribers: [{ agent: 'launch', on: ['completed', 'commented'] }],
    activity: [{ id: 'a1', actor: { type: 'agent', id: 'launch' }, kind: 'created', at: '09:15' }],
  },
];

export const SOLO_CHAT: ChatMessage[] = [
  {
    id: 'm1',
    from: 'human',
    person: 'raph',
    text: 'Ship the Stripe billing work and get it ready for Friday.',
  },
  {
    id: 'm2',
    from: 'agent',
    agent: 'release',
    text: 'Billing is merged and running on staging. Checkout, invoices and webhooks pass end to end.\n\nTwo things need you, and neither blocks me right now, so I put them on your list instead of stopping to ask:',
    assigned: ['ht-stripe-secret', 'ht-tax-review'],
  },
  {
    id: 'm3',
    from: 'agent',
    agent: 'release',
    text: "Meanwhile I'm writing the refund flow. I'll pick these up the moment you comment or tick them off.",
  },
];

export const TEAM_CHAT: ChatMessage[] = [
  { id: 'm1', from: 'human', person: 'raph', text: 'Plan launch week. Use the team, not just me.' },
  {
    id: 'm2',
    from: 'agent',
    agent: 'launch',
    text: "Here's the plan. I'm doing the code and copy. Four things need people, so I've routed them:",
    assigned: ['ht-pricing-copy', 'ht-dns', 'ht-demo', 'ht-stripe-live'],
  },
  {
    id: 'm3',
    from: 'agent',
    agent: 'launch',
    text: 'Maya has the copy review (marketing). The DNS change and the demo go to the team: whoever claims one owns it. Stripe live mode is yours, since the account is in your name.',
  },
];
