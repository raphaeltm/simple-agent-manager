/**
 * PROTOTYPE ONLY: mock data for /prototype/inbox-thread. Never ship to production.
 * Stress cases: long titles, long agent replies with markdown and links, a secret request the
 * person does not know how to fulfil, a finished agent, follow-ups in several states, a stack.
 */
import type { InboxItem, RuntimeSecretRequest } from '@simple-agent-manager/shared';

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
    'still hammer the provider when they all fail together.',
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

export const SECRET = item({
  ref: 'secret:s1',
  store: 'secret',
  kind: 'secret',
  title: 'I need a Hetzner API token to test the new firewall rules on a real server.',
  body: 'Read and write access. I only use it for this task and it expires in 24 hours.',
  blocking: true,
  agentState: 'waiting',
  topic: 'Hetzner firewall rules',
  answerSpec: { type: 'secret', envKey: 'HETZNER_API_TOKEN', requestId: 'req-1' },
  createdAt: ago(18),
});

export const SECRET_REQUEST: RuntimeSecretRequest = {
  id: 'req-1',
  projectId: PROJECT,
  envKey: 'HETZNER_API_TOKEN',
  reason: SECRET.body ?? '',
  ttlSeconds: 86_400,
  status: 'pending',
  requestingTaskId: 'task-2',
  requestingChatSessionId: 'sess-2',
  expiresAt: new Date(NOW + 6 * 3_600_000).toISOString(),
  createdAt: ago(18),
  resolvedAt: null,
  resolvedByName: null,
  secretExpiresAt: null,
  replacedExisting: false,
};

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
  SECRET,
  QUESTION,
  REVIEW,
  STACKED_A,
  STACKED_B,
  RESULT,
];

/**
 * One turn in an item's conversation. The ask itself is the first agent turn (rendered from the
 * item). `offers` puts the item's answer controls on this turn: the decision follows the
 * conversation down instead of being pinned. `note` is what SAM understood the person's message
 * to be, inferred from the message itself (no mode switch).
 */
export type ThreadEntry =
  | {
      kind: 'you';
      id: string;
      text: string;
      at: string;
      note?: { text: string; undo?: boolean };
    }
  | { kind: 'agent'; id: string; text: string; at: string; offers?: boolean }
  | { kind: 'activity'; id: string; text: string; at: string }
  | {
      kind: 'followup';
      id: string;
      text: string;
      at: string;
      state: 'queued' | 'started' | 'done';
      route: 'this-agent' | 'new-task';
      chatLabel?: string;
    };

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
      'They keep their count. The cap is checked **before the next attempt**, so a node at 3/5 ' +
      'just becomes one of the project’s 5. The most nodes any project had retrying at once this ' +
      'month was **4**, so per project costs almost nothing. I’d go per project.',
    at: ago(10),
    offers: true,
  },
];

export const ANSWERED_THREAD: ThreadEntry[] = [
  ...QUESTION_THREAD,
  {
    kind: 'you',
    id: 't4',
    text: 'Ok, per project. But log a warning whenever a project hits the cap.',
    at: ago(1),
    note: { text: 'Answered: Per project, and log a warning at the cap', undo: true },
  },
];

export const SECRET_THREAD: ThreadEntry[] = [
  {
    kind: 'you',
    id: 'k1',
    text: 'Where do I get this? I can’t find API tokens anywhere in the Hetzner console.',
    at: ago(6),
  },
  {
    kind: 'agent',
    id: 'k2',
    text:
      'They live per project, not on your account:\n\n' +
      '1. Open [console.hetzner.cloud](https://console.hetzner.cloud) and pick the **SAM staging** project.\n' +
      '2. **Security → API tokens → Generate API token**.\n' +
      '3. Name it `sam-firewall-test`, choose **Read & Write**, and copy it. Hetzner shows it only once.\n\n' +
      'Paste it below. It goes straight to the project’s secret store, never into this chat.',
    at: ago(5),
    offers: true,
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
    kind: 'you',
    id: 'r3',
    text: 'Fix the lease one too, separately.',
    at: ago(61),
    note: { text: 'Started as a new task' },
  },
  {
    kind: 'followup',
    id: 'r4',
    text: 'Fix the same race in staging-lease.test.ts',
    at: ago(60),
    state: 'started',
    route: 'new-task',
    chatLabel: 'Fix lease race in staging-lease test',
  },
  {
    kind: 'you',
    id: 'r5',
    text: 'And add a note to the CI troubleshooting guide: wait on lease events, never sleep.',
    at: ago(2),
    note: { text: 'Follow-up for this agent. It was finished, so this wakes it.' },
  },
  {
    kind: 'followup',
    id: 'r6',
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

/** What the person pasted into the message box in the secret-guard scene (fake). */
export const PASTED_TOKEN = 'here it is: hc_test_0000000000000000000000000000000000';
