/**
 * PROTOTYPE ONLY: mock data for /prototype/inbox-thread. Never ship to production.
 * Stress cases: long titles, long agent replies with markdown, finished agents, follow-ups in
 * several states, a stack, an item with no side-chat at all.
 */
import type { InboxItem } from '@simple-agent-manager/shared';

const PROJECT = 'proj-sam';
const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);
export const PROTO_NOW = NOW;

function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function item(partial: Partial<InboxItem> & Pick<InboxItem, 'ref' | 'kind' | 'title'>): InboxItem {
  return {
    store: 'ask',
    projectId: PROJECT,
    projectName: 'SAM',
    sessionId: 'sess-1',
    topic: 'Node reuse after deploy',
    taskId: 'task-1',
    stackKey: partial.ref,
    body: null,
    blocking: false,
    agentState: 'working',
    status: 'open',
    createdAt: ago(40),
    updatedAt: ago(40),
    failureCount: null,
    expiresAt: null,
    dueAt: null,
    answerSpec: { type: 'text' },
    links: [],
    canAct: true,
    untrustedContent: true,
    ...partial,
  };
}

export const QUESTION = item({
  ref: 'ask:q1',
  kind: 'question',
  title: 'Should the retry cap apply per node or per project?',
  body:
    'Workspace deletion retries are capped at **5 per node** today. A project with many nodes can ' +
    'still hammer the provider when they all fail together.\n\n' +
    '- **Per node**: keeps today’s behavior, simplest.\n' +
    '- **Per project**: protects the provider account, but one bad node can starve the others.',
  blocking: true,
  agentState: 'waiting',
  topic: 'Workspace deletion retries',
  answerSpec: { type: 'options', options: ['Per node', 'Per project'], allowText: true },
  links: [
    {
      kind: 'pr',
      id: 'https://github.com/raphaeltm/simple-agent-manager/pull/2911',
      label: 'PR #2911',
    },
  ],
  createdAt: ago(25),
});

export const RESULT = item({
  ref: 'ask:r1',
  kind: 'result',
  title: 'The flaky deploy test is fixed and merged; production deploy succeeded.',
  body:
    'The test raced the staging lease release. It now waits on the lease event instead of a ' +
    '30s sleep. **Ran it 40 times locally, 0 failures.**',
  agentState: 'finished',
  topic: 'Flaky deploy test',
  answerSpec: { type: 'acknowledge' },
  links: [
    {
      kind: 'pr',
      id: 'https://github.com/raphaeltm/simple-agent-manager/pull/2905',
      label: 'PR #2905',
    },
  ],
  createdAt: ago(130),
});

export const REVIEW = item({
  ref: 'ask:v1',
  kind: 'review',
  title: 'Check the new Insights “This week” pane before I ship it.',
  body: 'Screenshots at phone and desktop sizes are in the Library. The empty-week state is new.',
  agentState: 'working',
  topic: 'Insights this-week pane',
  answerSpec: { type: 'acknowledge' },
  links: [{ kind: 'file', id: 'f1', label: 'this-week screenshots' }],
  createdAt: ago(55),
});

export const LONG_QUESTION = item({
  ref: 'ask:q2',
  kind: 'question',
  title:
    'The GCP workload identity pool in the staging2 project is owned by a deleted service account; do you want me to recreate it under the installation’s own account, or keep it and re-grant the old one?',
  body: 'Either works. Recreating it changes the pool ID, so any self-hoster following the old guide will need to update one value.',
  blocking: false,
  agentState: 'working',
  topic: 'GCP workload identity ownership',
  answerSpec: { type: 'options', options: ['Recreate it', 'Keep and re-grant'], allowText: true },
  createdAt: ago(8),
});

export const STACKED_A = item({
  ref: 'ask:s1',
  kind: 'question',
  title: 'Keep the old Admin Analytics signup funnel until Health & cost ships?',
  agentState: 'waiting',
  blocking: true,
  topic: 'Retire SaaS analytics',
  stackKey: 'stack-analytics',
  answerSpec: { type: 'options', options: ['Keep it', 'Remove now'], allowText: false },
  createdAt: ago(90),
});

export const STACKED_B = item({
  ref: 'ask:s2',
  kind: 'review',
  title: 'Review the migration that drops the geo columns.',
  agentState: 'waiting',
  topic: 'Retire SaaS analytics',
  stackKey: 'stack-analytics',
  answerSpec: { type: 'acknowledge' },
  createdAt: ago(88),
});

export const LIST_ITEMS: InboxItem[] = [
  LONG_QUESTION,
  QUESTION,
  REVIEW,
  STACKED_A,
  STACKED_B,
  RESULT,
];

/** Side-chat entries on an item. Agent text is untrusted markdown, like the item body. */
export type ThreadEntry =
  | { kind: 'you'; id: string; text: string; at: string }
  | { kind: 'agent'; id: string; text: string; at: string }
  | { kind: 'activity'; id: string; text: string; at: string }
  | {
      kind: 'followup';
      id: string;
      text: string;
      at: string;
      state: 'queued' | 'sent' | 'started' | 'done';
      route: 'this-agent' | 'new-task';
      chatLabel?: string;
    }
  | { kind: 'answer'; id: string; text: string; at: string };

export const QUESTION_THREAD: ThreadEntry[] = [
  {
    kind: 'you',
    id: 't1',
    text: 'What happens to nodes that are already mid-retry if we switch to per project?',
    at: ago(12),
  },
  { kind: 'activity', id: 't2', text: 'Read 3 files · ran 1 query on staging', at: ago(11) },
  {
    kind: 'agent',
    id: 't3',
    text:
      'They keep their current count. The cap would be checked **before the next attempt**, so a ' +
      'node at 3/5 just becomes one of the project’s 5. Worst case the first sweep after deploy ' +
      'skips ~2 retries per project, then normal.\n\n' +
      'I checked staging: the most nodes any project had retrying at once this month was **4**.',
    at: ago(10),
  },
];

export const RESULT_THREAD: ThreadEntry[] = [
  {
    kind: 'you',
    id: 'r1',
    text: 'Nice. Did the other two flaky tests have the same race?',
    at: ago(70),
  },
  {
    kind: 'agent',
    id: 'r2',
    text: 'One did (`staging-lease.test.ts`). The other is a real timeout on a slow runner, different cause.',
    at: ago(64),
  },
  {
    kind: 'followup',
    id: 'r3',
    text: 'Fix the same race in staging-lease.test.ts',
    at: ago(60),
    state: 'started',
    route: 'new-task',
    chatLabel: 'Fix lease race in staging-lease test',
  },
  {
    kind: 'followup',
    id: 'r4',
    text: 'Add a note to the CI troubleshooting guide about waiting on lease events, not sleeps',
    at: ago(2),
    state: 'queued',
    route: 'this-agent',
  },
];

export const REVIEW_THREAD: ThreadEntry[] = [
  {
    kind: 'you',
    id: 'v1',
    text: 'What does it show for a brand new project with zero tasks?',
    at: ago(20),
  },
];
