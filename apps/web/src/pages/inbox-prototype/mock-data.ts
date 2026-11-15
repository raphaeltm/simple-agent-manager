/**
 * PROTOTYPE ONLY — mock data for /prototype/inbox. Never ship to production.
 *
 * One record per ask from an agent to a person (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 3).
 * Every direction (A, B, C) renders exactly this data, so the screenshots compare layout only.
 */
import type { OperationsActionApproval, RuntimeSecretRequest } from '@simple-agent-manager/shared';

/** Mock-data lookups that cannot miss; throws loudly if the fixtures change. */
export function must<T>(value: T | undefined | null, what = 'mock value'): T {
  if (value === undefined || value === null) throw new Error(`Prototype fixture missing: ${what}`);
  return value;
}

export type Kind = 'question' | 'permission' | 'secret' | 'approval' | 'task' | 'review';
export type PersonId = 'you' | 'maya' | 'jonas';
export type LinkKind = 'idea' | 'file' | 'policy' | 'pr' | 'preview' | 'chat' | 'knowledge';

export interface ItemLink {
  kind: LinkKind;
  label: string;
}
export interface ContextMessage {
  from: 'agent' | 'you';
  text: string;
}
export interface PermissionOption {
  id: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'custom';
  name: string;
}

export interface InboxItem {
  id: string;
  kind: Kind;
  /** One sentence, written by the agent. */
  title: string;
  /** "Why I need you", a few lines. */
  why: string;
  project: string;
  chat: string;
  /** Minutes since the ask was filed. */
  ageMin: number;
  /** paused = the agent is stopped on this; working = it carried on; done = turn finished. */
  agent: 'paused' | 'working' | 'done';
  blocking: boolean;
  /** Live-runtime deadline in minutes (ACP permissions), sorts first. */
  deadlineMin?: number;
  groupKey?: string;
  options?: string[];
  permission?: { title: string; description: string; options: PermissionOption[] };
  secret?: { envKey: string };
  approval?: Pick<
    OperationsActionApproval,
    'action' | 'targetType' | 'targetId' | 'reason' | 'evidenceSummary' | 'targetSummary'
  >;
  steps?: { text: string; done: boolean }[];
  /** review: what the agent wants evaluated. */
  body?: string;
  team?: { claimedBy?: PersonId };
  before: ContextMessage[];
  since: string[];
  links: ItemLink[];
}

export interface UpdateItem {
  id: string;
  text: string;
  project: string;
  ageMin: number;
  kind: 'pr' | 'done' | 'deploy' | 'progress';
}

export const PEOPLE: Record<PersonId, { name: string; slot: 'you' | 1 | 2 }> = {
  you: { name: 'Raphaël', slot: 'you' },
  maya: { name: 'Maya Chen', slot: 1 },
  jonas: { name: 'Jonas Weber', slot: 2 },
};

const BILLING_BEFORE: ContextMessage[] = [
  { from: 'you', text: 'Ship the Stripe billing flow this week. Live mode, EU customers first.' },
  {
    from: 'agent',
    text: 'Checkout, webhooks and the plans table are merged on staging. Two things only you can decide before I flip production.',
  },
];

export const BASE_ITEMS: InboxItem[] = [
  {
    id: 'perm-migrate',
    kind: 'permission',
    title: 'Allow running the database migration on staging',
    why: 'The fix adds one column. The agent is holding the terminal open until you answer.',
    project: 'SAM',
    chat: 'Fix orphan sweep on GCP',
    ageMin: 3,
    deadlineMin: 4,
    agent: 'paused',
    blocking: true,
    permission: {
      title: 'Run pnpm db:migrate --env staging',
      description:
        'Applies migration 0214_add_sweep_owner.sql to the staging D1 database. Adds a nullable column, no data is rewritten.',
      options: [
        { id: 'once', kind: 'allow_once', name: 'Allow once' },
        { id: 'always', kind: 'allow_always', name: 'Always allow in this chat' },
        { id: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
    },
    before: [
      {
        from: 'you',
        text: 'The orphan sweep is deleting nothing on GCP. Find out why and fix it.',
      },
      {
        from: 'agent',
        text: 'Found it: the sweep never authenticates against GCP, so the list call returns empty. Fix is ready; it needs one migration.',
      },
    ],
    since: [],
    links: [
      { kind: 'pr', label: 'PR #2757' },
      { kind: 'file', label: 'sweep-trace.md' },
    ],
  },
  {
    id: 'q-vat',
    kind: 'question',
    title: 'Should EU prices include VAT?',
    why: 'The pricing page and the checkout total both depend on it. I wrote both versions; I will delete the one you do not pick.',
    project: 'Acme Billing',
    chat: 'Ship billing',
    ageMin: 14,
    agent: 'paused',
    blocking: true,
    groupKey: 'ship-billing',
    options: ['Include VAT', 'Show VAT separately', 'Ask the accountant first'],
    before: BILLING_BEFORE,
    since: [],
    links: [
      { kind: 'idea', label: 'EU pricing' },
      { kind: 'preview', label: 'Preview: /pricing' },
      { kind: 'policy', label: 'Pricing copy rules' },
    ],
  },
  {
    id: 'secret-stripe',
    kind: 'secret',
    title: 'Add the Stripe live webhook secret',
    why: 'Production webhooks are rejected until this exists. I cannot read or create live Stripe secrets.',
    project: 'Acme Billing',
    chat: 'Ship billing',
    ageMin: 12,
    agent: 'paused',
    blocking: true,
    groupKey: 'ship-billing',
    secret: { envKey: 'STRIPE_WEBHOOK_SECRET' },
    before: BILLING_BEFORE,
    since: [],
    links: [{ kind: 'file', label: 'stripe-setup.md' }],
  },
  {
    id: 'q-trial',
    kind: 'question',
    title: 'Which plans get the 14-day free trial?',
    why: 'Not blocking: I am building with "Starter only" and will switch if you pick something else.',
    project: 'Acme Billing',
    chat: 'Ship billing',
    ageMin: 15,
    agent: 'working',
    blocking: false,
    groupKey: 'ship-billing',
    options: ['Starter only', 'Starter and Pro', 'No trial'],
    before: BILLING_BEFORE,
    since: ['Wrote trial logic for Starter', 'Added 6 tests', 'Opened draft PR #88'],
    links: [{ kind: 'pr', label: 'PR #88 (draft)' }],
  },
  {
    id: 'approval-ws',
    kind: 'approval',
    title: 'Approve deleting a stuck staging workspace',
    why: 'It has held a node for 3 days after its chat ended. Deleting it frees the node; nothing in it is unpushed.',
    project: 'SAM',
    chat: 'Clean up staging nodes',
    ageMin: 40,
    agent: 'paused',
    blocking: true,
    approval: {
      action: 'delete_workspace',
      targetType: 'workspace',
      targetId: '01M7C2Y9W4ZQ8H3N5KD0XJ6TRB',
      reason:
        'Workspace has been running for 74 hours with no chat activity; its branch is pushed and its PR merged.',
      evidenceSummary:
        'Last heartbeat 2 min ago. Last message 3 days ago. Branch pushed at 4f1c2e9.',
      targetSummary: { owner: 'raphael', status: 'running', node: 'node-hel1-07' },
    },
    before: [
      { from: 'you', text: 'Staging has run out of nodes again. Clean it up.' },
      { from: 'agent', text: 'Two nodes freed. One workspace needs your approval to delete.' },
    ],
    since: [],
    links: [{ kind: 'chat', label: 'Original chat' }],
  },
  {
    id: 'task-key',
    kind: 'task',
    title: 'Rotate the GitHub App private key',
    why: 'The advisory fix is merged, but the old key was in a log for 2 hours. Only an org owner can rotate it.',
    project: 'SAM',
    chat: 'Security advisory follow-up',
    ageMin: 125,
    agent: 'working',
    blocking: false,
    steps: [
      { text: 'Open GitHub → Settings → Developer settings → GitHub Apps → SAM', done: true },
      { text: 'Generate a new private key and download it', done: false },
      { text: 'Paste it as GH_APP_PRIVATE_KEY in the production environment', done: false },
      { text: 'Delete the old key in GitHub', done: false },
    ],
    before: [{ from: 'agent', text: 'Advisory fix merged (#2748). One manual step left.' }],
    since: ['Checked staging still works with the old key', 'Wrote the rotation runbook'],
    links: [
      { kind: 'pr', label: 'PR #2748' },
      { kind: 'file', label: 'key-rotation.md' },
      { kind: 'knowledge', label: 'GH_* vs GITHUB_*' },
    ],
  },
  {
    id: 'review-pricing',
    kind: 'review',
    title: 'Please check the new pricing page before I open the PR',
    why: 'Copy and layout are done. I want your eyes on the plan comparison table before Maya reviews the wording.',
    body: 'Three plans, monthly and yearly toggle, VAT shown separately. Mobile layout checked at 375px.',
    project: 'Kiln website',
    chat: 'Pricing page rewrite',
    ageMin: 62,
    agent: 'paused',
    blocking: false,
    before: [{ from: 'you', text: 'Rewrite the pricing page around the three plans.' }],
    since: [],
    links: [
      { kind: 'preview', label: 'Preview: kiln-pr-91' },
      { kind: 'file', label: 'pricing-copy.md' },
    ],
  },
  {
    id: 'q-cover',
    kind: 'question',
    title: 'Which cover photo for the weekend post?',
    why: 'The other two go further down the post.',
    options: ['Harbour at dawn', 'Market stall', 'Bike on the ferry'],
    project: 'Field Notes',
    chat: 'Weekend photos post',
    ageMin: 300,
    agent: 'paused',
    blocking: true,
    before: [{ from: 'you', text: 'Make a field-notes post from today’s photos.' }],
    since: [],
    links: [{ kind: 'file', label: 'covers/ (3 images)' }],
  },
  {
    id: 'review-sweep',
    kind: 'review',
    title: 'Check the staging node list after the orphan sweep fix',
    why: 'The sweep deletes cloud resources, so I want a person to confirm it kept the right ones.',
    body: 'Merged #2757 and deployed. The sweep removed 3 orphaned GCP disks on staging and kept 2 that still had owners.',
    project: 'SAM',
    chat: 'GCP sweep follow-up',
    ageMin: 25,
    agent: 'done',
    blocking: false,
    before: [{ from: 'you', text: 'Tell me when the sweep fix is deployed.' }],
    since: ['Deployed to production', 'Verified 3 disks deleted, 2 kept'],
    links: [
      { kind: 'pr', label: 'PR #2757' },
      { kind: 'preview', label: 'Staging nodes' },
    ],
  },
];

export const TEAM_ITEMS: InboxItem[] = [
  {
    id: 'team-invoice',
    kind: 'task',
    title: 'Check the Hetzner invoice matches the cost report',
    why: 'Anyone with billing access can do this. The report says €212; I cannot open the invoice.',
    project: 'SAM',
    chat: 'Monthly cost review',
    ageMin: 180,
    agent: 'working',
    blocking: false,
    team: {},
    steps: [
      { text: 'Open the November invoice in Hetzner', done: false },
      { text: 'Compare the total with cost-report.md', done: false },
    ],
    before: [{ from: 'agent', text: 'Cost report for November is ready.' }],
    since: ['Started the December forecast'],
    links: [{ kind: 'file', label: 'cost-report.md' }],
  },
  {
    id: 'team-video',
    kind: 'task',
    title: 'Record the 30-second launch demo video',
    why: 'Needs a real screen and a voice. Script and shot list are attached.',
    project: 'Kiln website',
    chat: 'Launch week checklist',
    ageMin: 1440,
    agent: 'working',
    blocking: false,
    team: { claimedBy: 'maya' },
    steps: [
      { text: 'Read the script', done: true },
      { text: 'Record the screen at 1280×720', done: true },
      { text: 'Record the voiceover', done: false },
      { text: 'Upload to the Library under /launch/', done: false },
    ],
    before: [{ from: 'agent', text: 'Launch checklist: 6 of 8 done.' }],
    since: ['Maya ticked 2 steps'],
    links: [
      { kind: 'file', label: 'demo-script.md' },
      { kind: 'idea', label: 'Launch week' },
    ],
  },
];

export const ARCHIVED_ITEMS: InboxItem[] = [
  {
    ...must(BASE_ITEMS[7]),
    id: 'arch-1',
    title: 'Use the green or the dark hero on the landing page?',
    ageMin: 2880,
  },
  {
    ...must(BASE_ITEMS[6]),
    id: 'arch-2',
    title: 'Please check the nightly backup restore test',
    ageMin: 4320,
  },
];

export const UPDATES: UpdateItem[] = [
  {
    id: 'u1',
    kind: 'pr',
    text: 'PR #2757 merged: orphan sweep authenticates on GCP',
    project: 'SAM',
    ageMin: 30,
  },
  { id: 'u2', kind: 'deploy', text: 'Production deploy succeeded', project: 'SAM', ageMin: 28 },
  {
    id: 'u3',
    kind: 'done',
    text: 'Task complete: security advisory setup check',
    project: 'SAM',
    ageMin: 95,
  },
  {
    id: 'u4',
    kind: 'progress',
    text: 'Ship billing: 4 of 6 steps done',
    project: 'Acme Billing',
    ageMin: 16,
  },
];

export function secretRequestFor(item: InboxItem): RuntimeSecretRequest {
  const now = Date.now();
  return {
    id: `sr-${item.id}`,
    projectId: 'proj-proto',
    envKey: item.secret?.envKey ?? 'SECRET',
    reason: item.why,
    ttlSeconds: null,
    status: 'pending',
    requestingTaskId: 'task-proto',
    requestingChatSessionId: 'chat-proto',
    expiresAt: new Date(now + 3_600_000).toISOString(),
    createdAt: new Date(now - item.ageMin * 60_000).toISOString(),
    resolvedAt: null,
    resolvedByName: null,
    secretExpiresAt: null,
    replacedExisting: false,
  } as RuntimeSecretRequest;
}

export function approvalFor(item: InboxItem): OperationsActionApproval {
  const now = Date.now();
  return {
    id: `ap-${item.id}`,
    ...must(item.approval, 'approval'),
    requestingProjectId: 'proj-proto',
    requestingTaskId: '01M7C2Y9TASKPROTO00000000',
    requestingSessionId: 'chat-proto',
    requesterUserId: 'user-you',
    status: 'pending',
    autoApproved: false,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    executionResult: null,
    createdAt: new Date(now - item.ageMin * 60_000).toISOString(),
  };
}
