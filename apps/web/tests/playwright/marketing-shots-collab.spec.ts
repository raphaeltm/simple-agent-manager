/**
 * Marketing screenshots for the collaboration + comments surfaces.
 *
 * Renders the REAL production components (project members/access, invite
 * recipient card, multiplayer session list, credential attribution health,
 * and the comments inbox/rail/library-file panel) against mocked API data for
 * the shared Northwind fictional project (see marketing-shots-helpers.ts).
 *
 * Run with the marketing output flag to write committed images:
 *   cd apps/web && MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-collab.spec.ts --project="Desktop (1280x800)"
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, seedTheme, setupAuditRoutes } from './audit-helpers';
import {
  dismissOnboarding,
  MARKETING_THEME,
  MARKETING_USER,
  MARKETING_VIEWPORT,
  marketingShot,
  NORTHWIND,
  OPAQUE_BACKDROP_COLOR,
} from './marketing-shots-helpers';

test.use(MARKETING_VIEWPORT);

const PROJECT_ID = NORTHWIND.projectId;
const PRIYA = NORTHWIND.owner;
const [MARCUS, ELENA, TOMAS, AISHA] = NORTHWIND.members;

// Relative-time text ("6m ago", "2h ago") on sessions/comments is computed by
// the app from the real wall clock, not from any mocked clock — so session
// and comment timestamps are anchored to the actual run time (matches the
// pattern in shared-session-ux-audit.spec.ts). Only calendar-date strings
// (member joined dates, invite link expiry) are fixed ISO literals below.
const NOW = Date.now();
const MIN = 60_000;

const AGENT_AUTHOR = { id: 'agent-claude-opus5', kind: 'agent' as const, name: 'Claude Code — Opus 5' };

function humanAuthor(member: { id: string; name: string; email: string }) {
  return { id: member.id, kind: 'human' as const, name: member.name, email: member.email, avatarUrl: null };
}

function userRef(member: { id: string; name: string; email: string }) {
  return { id: member.id, name: member.name, email: member.email, avatarUrl: null };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const PROJECT = {
  id: PROJECT_ID,
  name: NORTHWIND.projectName,
  repository: NORTHWIND.repository,
  repoProvider: 'github' as const,
  defaultBranch: NORTHWIND.defaultBranch,
  userId: PRIYA.id,
  installationId: 'inst-northwind',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultLocation: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: null,
  multiplayerActive: true,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  summary: {
    activeWorkspaceCount: 2,
    activeSessionCount: 5,
    lastActivityAt: NOW - 5 * MIN,
    taskCountsByStatus: {},
    linkedWorkspaces: 2,
  },
};

// ---------------------------------------------------------------------------
// A. Members & access
// ---------------------------------------------------------------------------

function member(m: { id: string; name: string; email: string }, role: 'owner' | 'admin') {
  return {
    projectId: PROJECT_ID,
    userId: m.id,
    role,
    status: 'active' as const,
    invitedBy: role === 'owner' ? null : PRIYA.id,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    user: { id: m.id, name: m.name, email: m.email, image: null, avatarUrl: null },
  };
}

function accessRequest(options: {
  id: string;
  requesterUserId: string;
  name: string;
  email: string;
  githubAccessStatus: 'verified' | 'no-access';
  githubAccessMessage?: string | null;
}) {
  return {
    id: options.id,
    projectId: PROJECT_ID,
    inviteLinkId: 'invite-northwind-1',
    requesterUserId: options.requesterUserId,
    status: 'pending' as const,
    githubAccessStatus: options.githubAccessStatus,
    githubAccessCheckedAt: '2026-09-13T00:00:00.000Z',
    githubAccessMessage: options.githubAccessMessage ?? null,
    requestedAt: '2026-09-13T00:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    requester: { id: options.requesterUserId, name: options.name, email: options.email, image: null, avatarUrl: null },
  };
}

const MEMBERS_RESPONSE = {
  members: [
    member(PRIYA, 'owner'),
    member(MARCUS, 'admin'),
    member(ELENA, 'admin'),
    member(TOMAS, 'admin'),
    member(AISHA, 'admin'),
  ],
  inviteLinks: [] as unknown[],
  accessRequests: [
    accessRequest({
      id: 'req-jordan',
      requesterUserId: 'user-jordan',
      name: 'Jordan Lee',
      email: 'jordan@northwindlabs.dev',
      githubAccessStatus: 'verified',
    }),
    accessRequest({
      id: 'req-sam',
      requesterUserId: 'user-sam-whitfield',
      name: 'Sam Whitfield',
      email: 'sam.whitfield@example.com',
      githubAccessStatus: 'no-access',
      githubAccessMessage: 'Requester does not have GitHub access to the project repository.',
    }),
  ],
};

const INVITE_TOKEN = 'sam_inv_northwind';

const CREATED_INVITE_LINK = {
  id: 'invite-northwind-1',
  projectId: PROJECT_ID,
  status: 'active' as const,
  expiresAt: '2026-09-24T00:00:00.000Z',
  revokedAt: null,
  createdBy: PRIYA.id,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
  lastUsedAt: '2026-09-13T18:00:00.000Z',
  useCount: 6,
  token: INVITE_TOKEN,
};

const EMPTY_CREDENTIAL_HEALTH = {
  projectId: PROJECT_ID,
  multiplayerActive: true,
  counts: {
    resources: 0,
    personalResources: 0,
    personalCredentials: 0,
    projectCoveredCredentials: 0,
    unknownCredentials: 0,
  },
  resources: [] as unknown[],
};

// ---------------------------------------------------------------------------
// B. Invite preview (recipient view)
// ---------------------------------------------------------------------------

const INVITE_PREVIEW = {
  token: INVITE_TOKEN,
  status: 'active' as const,
  expiresAt: '2026-09-24T00:00:00.000Z',
  project: {
    id: PROJECT_ID,
    name: NORTHWIND.projectName,
    repository: NORTHWIND.repository,
    repoProvider: 'github' as const,
  },
  membershipStatus: 'can-request' as const,
  accessRequest: null,
};

// ---------------------------------------------------------------------------
// C. Sessions (project chat, "All sessions")
// ---------------------------------------------------------------------------

function chatSession(options: {
  id: string;
  topic: string;
  createdBy: { id: string; name: string; email: string } | null;
  minutesAgo: number;
  status: 'active' | 'sleeping' | 'stopped';
  agentType?: string;
}) {
  const startedAt = NOW - options.minutesAgo * MIN;
  const isMine = options.createdBy?.id === PRIYA.id;
  const isTerminated = options.status === 'stopped';
  return {
    id: options.id,
    workspaceId: null,
    taskId: null,
    createdByUserId: options.createdBy?.id ?? null,
    createdBy: options.createdBy
      ? { id: options.createdBy.id, name: options.createdBy.name, email: options.createdBy.email, image: null, avatarUrl: null }
      : null,
    isMine,
    topic: options.topic,
    status: options.status,
    messageCount: 6,
    startedAt,
    endedAt: isTerminated ? startedAt + 6 * MIN : null,
    createdAt: startedAt,
    agentCompletedAt: isTerminated ? startedAt + 6 * MIN : null,
    lastMessageAt: startedAt + 4 * MIN,
    isIdle: false,
    isTerminated,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: `acp-${options.id}`,
    agentType: options.agentType ?? 'claude-code',
  };
}

const SESSION_IDEMPOTENCY_ID = 'chat-idempotency-keys';
const SESSION_LEDGER_ID = 'chat-ledger-migration';

const SESSIONS = [
  chatSession({
    id: SESSION_IDEMPOTENCY_ID,
    topic: 'Add idempotency keys to refund webhook',
    createdBy: PRIYA,
    minutesAgo: 5,
    status: 'active',
  }),
  chatSession({
    id: SESSION_LEDGER_ID,
    topic: 'Migrate ledger to double-entry schema',
    createdBy: MARCUS,
    minutesAgo: 18,
    status: 'active',
  }),
  chatSession({
    id: 'chat-flaky-test-triage',
    topic: 'Flaky test triage: payment-retry.spec',
    createdBy: ELENA,
    minutesAgo: 32,
    status: 'sleeping',
  }),
  chatSession({
    id: 'chat-pci-evidence-bundle',
    topic: 'PCI evidence bundle for Q3',
    createdBy: TOMAS,
    minutesAgo: 47,
    status: 'active',
  }),
  chatSession({
    id: 'chat-webhook-signature-rotation',
    topic: 'Stripe webhook signature rotation',
    createdBy: AISHA,
    minutesAgo: 61,
    status: 'sleeping',
    agentType: 'openai-codex',
  }),
  chatSession({
    id: 'chat-timezone-backfill',
    topic: 'Backfill merchant timezone column',
    createdBy: MARCUS,
    minutesAgo: 90,
    status: 'stopped',
  }),
  chatSession({
    id: 'chat-rate-limit-payouts',
    topic: 'Rate-limit the payouts endpoint',
    createdBy: PRIYA,
    minutesAgo: 110,
    status: 'active',
  }),
  chatSession({
    id: 'chat-nightly-dependency-audit',
    topic: 'Nightly dependency audit run',
    createdBy: null,
    minutesAgo: 150,
    status: 'stopped',
    agentType: 'openai-codex',
  }),
];

const MESSAGES_IDEMPOTENCY = [
  {
    id: 'msg-idem-1',
    sessionId: SESSION_IDEMPOTENCY_ID,
    role: 'user',
    content:
      "Add idempotency keys to the refund webhook handler so retried Stripe events don't double-refund a customer.",
    toolMetadata: null,
    createdAt: NOW - 5 * MIN,
    sequence: 1,
  },
  {
    id: 'msg-idem-2',
    sessionId: SESSION_IDEMPOTENCY_ID,
    role: 'assistant',
    content:
      "I'll add an idempotency key derived from the Stripe event ID, store it in the webhook_idempotency table, and short-circuit if we've already processed that event. Let me check the current handler first.",
    toolMetadata: null,
    createdAt: NOW - 4 * MIN,
    sequence: 2,
  },
  {
    id: 'msg-idem-3',
    sessionId: SESSION_IDEMPOTENCY_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-idem-search',
      title: 'Bash: rg "handleRefundWebhook" src/webhooks/',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 'term-idem-search' }],
    },
    createdAt: NOW - 3 * MIN,
    sequence: 3,
  },
  {
    id: 'msg-idem-4',
    sessionId: SESSION_IDEMPOTENCY_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-idem-edit',
      title: 'Edit: src/webhooks/refunds.ts',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 'term-idem-edit' }],
    },
    createdAt: NOW - 2 * MIN,
    sequence: 4,
  },
  {
    id: 'msg-idem-5',
    sessionId: SESSION_IDEMPOTENCY_ID,
    role: 'assistant',
    content:
      'Added the idempotency check and a unique index on webhook_idempotency.event_id. Re-ran the refund webhook test suite — all green. Diff is on this branch; let me know if you want me to open a PR.',
    toolMetadata: null,
    createdAt: NOW - 1 * MIN,
    sequence: 5,
  },
];

// ---------------------------------------------------------------------------
// D. Credential attribution health
// ---------------------------------------------------------------------------

const SHARED_HETZNER_CREDENTIAL = {
  configurationId: 'cfg-compute-hetzner',
  configurationName: 'Northwind Shared Hetzner',
  credentialId: 'cred-hetzner-shared',
  credentialName: 'Northwind Hetzner key',
  owner: userRef(PRIYA),
};

const CREDENTIAL_HEALTH = {
  projectId: PROJECT_ID,
  multiplayerActive: true,
  counts: {
    resources: 4,
    personalResources: 2,
    personalCredentials: 2,
    projectCoveredCredentials: 2,
    unknownCredentials: 0,
  },
  resources: [
    {
      id: 'trigger-nightly-audit',
      projectId: PROJECT_ID,
      kind: 'trigger',
      title: 'Nightly dependency audit',
      subtitle: '0 3 * * *',
      href: `/projects/${PROJECT_ID}/triggers/trigger-nightly-audit`,
      createdBy: userRef(MARCUS),
      checks: [
        {
          consumerKind: 'agent',
          consumerTarget: 'claude-code',
          label: 'Agent credential (claude-code)',
          source: 'personal',
          owner: userRef(MARCUS),
          projectCredential: null,
          fixHref: `/projects/${PROJECT_ID}/settings/connections`,
          warning: "This runs on Marcus Chen's personal Claude Code key.",
        },
      ],
    },
    {
      id: 'task-timezone-backfill',
      projectId: PROJECT_ID,
      kind: 'task_tree',
      title: 'Backfill merchant timezone column',
      subtitle: 'running',
      href: `/projects/${PROJECT_ID}/tasks/task-timezone-backfill`,
      createdBy: userRef(ELENA),
      checks: [
        {
          consumerKind: 'agent',
          consumerTarget: 'openai-codex',
          label: 'Agent credential (openai-codex)',
          source: 'personal',
          owner: userRef(ELENA),
          projectCredential: null,
          fixHref: `/projects/${PROJECT_ID}/settings/connections`,
          warning: "This runs on Elena Rossi's personal Codex key.",
        },
      ],
    },
    {
      id: 'deploy-staging',
      projectId: PROJECT_ID,
      kind: 'deployment_environment',
      title: 'Staging deployment',
      subtitle: 'deployed',
      href: `/projects/${PROJECT_ID}/deployments/deploy-staging`,
      createdBy: userRef(PRIYA),
      checks: [
        {
          consumerKind: 'compute',
          consumerTarget: 'hetzner',
          label: 'Compute credential (hetzner)',
          source: 'project',
          owner: userRef(PRIYA),
          projectCredential: SHARED_HETZNER_CREDENTIAL,
          fixHref: `/projects/${PROJECT_ID}/settings/connections`,
          warning: null,
        },
      ],
    },
    {
      id: 'node-fsn1-payments-1',
      projectId: PROJECT_ID,
      kind: 'node',
      title: 'fsn1 workspace node',
      subtitle: 'running',
      href: `/projects/${PROJECT_ID}/workspaces/ws-payments-1`,
      createdBy: userRef(PRIYA),
      checks: [
        {
          consumerKind: 'compute',
          consumerTarget: 'hetzner',
          label: 'Compute credential (hetzner)',
          source: 'project',
          owner: userRef(PRIYA),
          projectCredential: SHARED_HETZNER_CREDENTIAL,
          fixHref: `/projects/${PROJECT_ID}/settings/connections`,
          warning: null,
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// F. Desktop comment rail (session-scoped threads for chat-idempotency-keys)
// ---------------------------------------------------------------------------

const RAIL_THREADS = [
  {
    id: 'ct-rail-1',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_IDEMPOTENCY_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-idem-2',
      quote:
        "I'll add an idempotency key derived from the Stripe event ID, store it in the webhook_idempotency table",
    },
    author: humanAuthor(ELENA),
    body: "Double check this survives Stripe's at-least-once redelivery — do we ever purge the table?",
    createdAt: NOW - 40 * MIN,
    updatedAt: NOW - 10 * MIN,
    status: 'open' as const,
    replies: [
      {
        id: 'cr-rail-1a',
        clientMutationId: null,
        author: humanAuthor(PRIYA),
        body: "Good question — let's add a TTL sweep.",
        createdAt: NOW - 25 * MIN,
        updatedAt: NOW - 25 * MIN,
        sentToAgent: true,
      },
      {
        id: 'cr-rail-1b',
        clientMutationId: null,
        author: AGENT_AUTHOR,
        body: 'Added a 30-day TTL sweep via a scheduled cleanup job.',
        createdAt: NOW - 10 * MIN,
        updatedAt: NOW - 10 * MIN,
        sentToAgent: false,
      },
    ],
  },
  {
    id: 'ct-rail-2',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_IDEMPOTENCY_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-idem-5',
      quote: 'Re-ran the refund webhook test suite — all green.',
    },
    author: humanAuthor(MARCUS),
    body: 'Prefer the retry helper in lib/http.ts instead of writing a bespoke backoff loop.',
    createdAt: NOW - 8 * MIN,
    updatedAt: NOW - 8 * MIN,
    status: 'open' as const,
    replies: [] as unknown[],
  },
];

// ---------------------------------------------------------------------------
// E + G. Comments inbox + library file comment panel
// ---------------------------------------------------------------------------

const FILE_LEDGER_ID = 'file-ledger-plan';
const FILE_REFUND_ID = 'file-refund-runbook';

const MESSAGE_THREADS = [
  {
    id: 'ct-1',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_LEDGER_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-ledger-1',
      quote: 'adopts a monotonic identifier for every ledger_entries row',
    },
    author: humanAuthor(MARCUS),
    body: 'Use a UUIDv7 here so keys sort by time instead of a random UUIDv4.',
    createdAt: NOW - 3 * 60 * MIN,
    updatedAt: NOW - 3 * 60 * MIN,
    status: 'open' as const,
    replies: [] as unknown[],
  },
  {
    id: 'ct-2',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_LEDGER_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-ledger-2',
      quote: 'drops the legacy ledger_id column once the backfill completes',
    },
    author: humanAuthor(ELENA),
    body: 'This migration drops the old index before the new one exists — can we keep both until the cutover finishes?',
    createdAt: NOW - 2.5 * 60 * MIN,
    updatedAt: NOW - 2 * 60 * MIN,
    status: 'open' as const,
    replies: [
      {
        id: 'cr-2a',
        clientMutationId: null,
        author: humanAuthor(PRIYA),
        body: 'Agreed — splitting into two migrations.',
        createdAt: NOW - 2 * 60 * MIN,
        updatedAt: NOW - 2 * 60 * MIN,
        sentToAgent: false,
      },
    ],
  },
  {
    id: 'ct-3',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_IDEMPOTENCY_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-idem-3',
      quote: 'retries the Stripe webhook with a fixed one-second backoff',
    },
    author: humanAuthor(MARCUS),
    body: 'Prefer the retry helper in lib/http.ts instead of a bespoke backoff loop.',
    createdAt: NOW - 35 * MIN,
    updatedAt: NOW - 35 * MIN,
    status: 'sent' as const,
    replies: [] as unknown[],
  },
  {
    id: 'ct-4',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_IDEMPOTENCY_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-idem-2',
      quote: 'the idempotency key is derived from the Stripe event ID',
    },
    author: humanAuthor(ELENA),
    body: "Double-check this survives Stripe's at-least-once redelivery after 24 hours.",
    createdAt: NOW - 4 * 60 * MIN,
    updatedAt: NOW - 90 * MIN,
    status: 'resolved' as const,
    replies: [
      {
        id: 'cr-4a',
        clientMutationId: null,
        author: AGENT_AUTHOR,
        body: 'Added a 30-day TTL sweep via a scheduled cleanup job.',
        createdAt: NOW - 100 * MIN,
        updatedAt: NOW - 100 * MIN,
        sentToAgent: false,
      },
      {
        id: 'cr-4b',
        clientMutationId: null,
        author: humanAuthor(ELENA),
        body: 'Nice, resolving.',
        createdAt: NOW - 90 * MIN,
        updatedAt: NOW - 90 * MIN,
        sentToAgent: false,
      },
    ],
  },
  {
    id: 'ct-5',
    clientMutationId: null,
    projectId: PROJECT_ID,
    sessionId: SESSION_LEDGER_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-ledger-3',
      quote: 'nightly job compares ledger balances against the Stripe balance transactions API',
    },
    author: humanAuthor(AISHA),
    body: 'Can we alert when reconciliation drift exceeds $0.01 instead of only logging it?',
    createdAt: NOW - 20 * MIN,
    updatedAt: NOW - 20 * MIN,
    status: 'open' as const,
    replies: [] as unknown[],
  },
];

const FILE_LEDGER_THREADS = [
  {
    id: 'ft-1',
    clientMutationId: null,
    projectId: PROJECT_ID,
    fileId: FILE_LEDGER_ID,
    anchor: {
      kind: 'library_file' as const,
      fileId: FILE_LEDGER_ID,
      quote: 'Backfill runs as a background job in batches of 5,000 rows.',
    },
    author: humanAuthor(TOMAS),
    body: 'The backfill batches of 5,000 rows will still lock big merchants for a while — can we throttle it further during business hours?',
    createdAt: NOW - 80 * MIN,
    updatedAt: NOW - 60 * MIN,
    status: 'open' as const,
    replies: [
      {
        id: 'fr-1a',
        clientMutationId: null,
        author: humanAuthor(PRIYA),
        body: "Let's cap it at 500 rows/batch during business hours and widen it back overnight.",
        createdAt: NOW - 60 * MIN,
        updatedAt: NOW - 60 * MIN,
        sentToAgent: false,
      },
    ],
  },
  {
    id: 'ft-2',
    clientMutationId: null,
    projectId: PROJECT_ID,
    fileId: FILE_LEDGER_ID,
    anchor: {
      kind: 'library_file' as const,
      fileId: FILE_LEDGER_ID,
      quote: 'Once verification passes, drop the legacy ledger_id column.',
    },
    author: humanAuthor(MARCUS),
    body: 'Should this doc mention the rollback plan if the backfill fails halfway?',
    createdAt: NOW - 5 * 60 * MIN,
    updatedAt: NOW - 3 * 60 * MIN,
    status: 'resolved' as const,
    replies: [
      {
        id: 'fr-2a',
        clientMutationId: null,
        author: AGENT_AUTHOR,
        body: 'Added a Rollback section with the exact revert migration command.',
        createdAt: NOW - 3 * 60 * MIN,
        updatedAt: NOW - 3 * 60 * MIN,
        sentToAgent: false,
      },
    ],
  },
];

const FILE_REFUND_THREADS = [
  {
    id: 'ft-3',
    clientMutationId: null,
    projectId: PROJECT_ID,
    fileId: FILE_REFUND_ID,
    anchor: {
      kind: 'library_file' as const,
      fileId: FILE_REFUND_ID,
      quote: 'Step 4: POST the refund to /v1/refunds and wait for the webhook confirmation.',
    },
    author: humanAuthor(ELENA),
    body: 'This runbook step 4 still references the old /v1/refunds endpoint.',
    createdAt: NOW - 45 * MIN,
    updatedAt: NOW - 45 * MIN,
    status: 'sent' as const,
    replies: [] as unknown[],
  },
  {
    id: 'ft-4',
    clientMutationId: null,
    projectId: PROJECT_ID,
    fileId: FILE_REFUND_ID,
    anchor: {
      kind: 'library_file' as const,
      fileId: FILE_REFUND_ID,
      quote: 'the webhook handler assumes the outbound POST already completed',
    },
    author: humanAuthor(MARCUS),
    body: 'Add a note about what happens when Stripe sends the refund webhook before our own POST /refunds call returns.',
    createdAt: NOW - 15 * MIN,
    updatedAt: NOW - 15 * MIN,
    status: 'open' as const,
    replies: [] as unknown[],
  },
];

const PROJECT_COMMENTS_RESPONSE = {
  messageThreads: MESSAGE_THREADS,
  fileThreads: [...FILE_LEDGER_THREADS, ...FILE_REFUND_THREADS],
  sessions: [
    { id: SESSION_LEDGER_ID, topic: 'Migrate ledger to double-entry schema' },
    { id: SESSION_IDEMPOTENCY_ID, topic: 'Add idempotency keys to refund webhook' },
  ],
  files: [
    { id: FILE_LEDGER_ID, filename: 'ledger-migration-plan.md' },
    { id: FILE_REFUND_ID, filename: 'refund-webhook-runbook.md' },
  ],
  hasMore: false,
  totalCount: MESSAGE_THREADS.length + FILE_LEDGER_THREADS.length + FILE_REFUND_THREADS.length,
};

// ---------------------------------------------------------------------------
// G. Library file (ledger-migration-plan.md)
// ---------------------------------------------------------------------------

const LEDGER_MARKDOWN_BODY = [
  '# Ledger Migration Plan',
  '',
  '## Overview',
  '',
  'The ledger_entries table adopts a monotonic identifier for every row so it sorts by creation time without a secondary index.',
  '',
  '## Backfill',
  '',
  'Backfill runs as a background job in batches of 5,000 rows.',
  '',
  '## Cutover',
  '',
  'Once verification passes, drop the legacy ledger_id column and point reads at the new schema.',
  '',
  '## Reconciliation',
  '',
  'A nightly job compares ledger balances against the Stripe balance transactions API and alerts on drift.',
  '',
].join('\n');

const LIBRARY_FILE_LEDGER = {
  id: FILE_LEDGER_ID,
  projectId: PROJECT_ID,
  filename: 'ledger-migration-plan.md',
  directory: '/design/',
  mimeType: 'text/markdown',
  sizeBytes: LEDGER_MARKDOWN_BODY.length,
  description: null,
  uploadedBy: MARCUS.id,
  uploadSource: 'agent',
  uploadSessionId: null,
  uploadTaskId: null,
  replacedAt: null,
  replacedBy: null,
  status: 'ready',
  extractedTextPreview: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
};

const LIBRARY_FILE_REFUND = {
  id: FILE_REFUND_ID,
  projectId: PROJECT_ID,
  filename: 'refund-webhook-runbook.md',
  directory: '/runbooks/',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  description: null,
  uploadedBy: PRIYA.id,
  uploadSource: 'user',
  uploadSessionId: null,
  uploadTaskId: null,
  replacedAt: null,
  replacedBy: null,
  status: 'ready',
  extractedTextPreview: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

const LIBRARY_FILES = [LIBRARY_FILE_LEDGER, LIBRARY_FILE_REFUND];

// ---------------------------------------------------------------------------
// Shared mock world
// ---------------------------------------------------------------------------

async function setupWorldMocks(page: Page) {
  await dismissOnboarding(page);
  await seedTheme(page, MARKETING_THEME);

  // Hold live-update sockets open with no server behind them (comments,
  // notifications, chat session ws) — accepting without echoing avoids a
  // "Reconnecting…" banner without needing per-endpoint ping/pong.
  await page.routeWebSocket(/.*/, () => {
    /* accepted, never echoed */
  });

  await setupAuditRoutes(page, (path, respond, route: Route) => {
    const method = route.request().method();

    // --- auth / shell --------------------------------------------------
    if (path.startsWith('/api/auth/')) return respond(200, MARKETING_USER);
    if (path === '/api/projects') return respond(200, { projects: [PROJECT], nextCursor: null });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });
    if (path === '/api/workspaces') return respond(200, []);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/chats') return respond(200, { sessions: [], total: 0 });
    if (path === '/api/chats/recent') return respond(200, { sessions: [] });
    if (path === '/api/account-map') return respond(200, { entries: [] });
    if (path === '/api/trial-status') {
      return respond(200, {
        available: false,
        agentType: null,
        hasInfraCredential: false,
        hasAgentCredential: false,
        dailyTokenBudget: null,
        dailyTokenUsage: null,
      });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    if (path === '/api/report-issue/config') return respond(200, { enabled: false });

    // --- invite preview (top-level, NOT project-scoped) -----------------
    if (path === `/api/projects/invite-links/${INVITE_TOKEN}`) return respond(200, INVITE_PREVIEW);
    if (path === `/api/projects/invite-links/${INVITE_TOKEN}/request`) {
      return respond(201, {
        id: 'req-marketing',
        projectId: PROJECT_ID,
        inviteLinkId: CREATED_INVITE_LINK.id,
        requesterUserId: 'user-marketing-visitor',
        status: 'pending',
        githubAccessStatus: 'unchecked',
        githubAccessCheckedAt: null,
        githubAccessMessage: null,
        requestedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        requester: null,
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';

      // --- members / access -------------------------------------------
      if (subPath === '/members') return respond(200, MEMBERS_RESPONSE);
      if (subPath === '/invite-links' && method === 'POST') return respond(201, CREATED_INVITE_LINK);
      if (subPath === '/credential-attribution-health') return respond(200, EMPTY_CREDENTIAL_HEALTH);
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath === '/repository-access') {
        return respond(200, { primaryRepository: PROJECT.repository, repositories: [] });
      }
      if (subPath === '/repository-access/available') return respond(200, { repositories: [] });
      if (subPath === '/repository-access/discover') return respond(200, { suggestions: [] });
      if (subPath === '/credentials') return respond(200, { credentials: [] });

      // --- comments (project-wide inbox) --------------------------------
      if (subPath === '/comments') return respond(200, PROJECT_COMMENTS_RESPONSE);

      // --- sessions ------------------------------------------------------
      if (subPath === '/sessions') return respond(200, { sessions: SESSIONS, total: SESSIONS.length });
      const sessionCommentsMatch = subPath.match(/^\/sessions\/([^/]+)\/comments$/);
      if (sessionCommentsMatch) {
        const comments = sessionCommentsMatch[1] === SESSION_IDEMPOTENCY_ID ? RAIL_THREADS : [];
        return respond(200, { comments });
      }
      const sessionMessagesMatch = subPath.match(/^\/sessions\/([^/]+)\/messages/);
      if (sessionMessagesMatch) {
        const messages = sessionMessagesMatch[1] === SESSION_IDEMPOTENCY_ID ? MESSAGES_IDEMPOTENCY : [];
        return respond(200, { messages, hasMore: false });
      }
      const sessionStateMatch = subPath.match(/^\/sessions\/([^/]+)\/state$/);
      if (sessionStateMatch) {
        return respond(200, {
          activity: 'idle',
          activityAt: NOW,
          statusError: null,
          currentPlan: null,
          planUpdatedAt: null,
          promptStartedAt: null,
          agentType: 'claude-code',
          lastStopReason: null,
        });
      }
      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        const found = SESSIONS.find((candidate) => candidate.id === sessionDetailMatch[1]) ?? SESSIONS[0]!;
        const messages = sessionDetailMatch[1] === SESSION_IDEMPOTENCY_ID ? MESSAGES_IDEMPOTENCY : [];
        return respond(200, {
          session: found,
          messages,
          hasMore: false,
          state: {
            activity: 'idle',
            activityAt: NOW,
            statusError: null,
            currentPlan: null,
            planUpdatedAt: null,
            promptStartedAt: null,
            agentType: found.agentType,
            lastStopReason: null,
          },
        });
      }
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/tasks') return respond(200, { tasks: [], total: 0 });
      if (subPath === '/cached-commands' || subPath === '/commands') return respond(200, { commands: [] });
      const toolContentMatch = subPath.match(/^\/sessions\/[^/]+\/messages\/[^/]+\/tool-content$/);
      if (toolContentMatch) return respond(200, { content: [] });

      // --- library ---------------------------------------------------------
      if (subPath === '/library' || subPath.startsWith('/library?')) {
        return respond(200, {
          files: LIBRARY_FILES.map((file) => ({ ...file, tags: [] })),
          cursor: null,
          total: LIBRARY_FILES.length,
        });
      }
      if (subPath === '/library/directories') return respond(200, { directories: [] });
      const libraryPreviewMatch = subPath.match(/^\/library\/([^/]+)\/preview$/);
      if (libraryPreviewMatch) {
        const body = libraryPreviewMatch[1] === FILE_LEDGER_ID ? LEDGER_MARKDOWN_BODY : '# File\n';
        return route.fulfill({ status: 200, contentType: 'text/markdown', body });
      }
      const libraryCommentsMatch = subPath.match(/^\/library\/([^/]+)\/comments$/);
      if (libraryCommentsMatch) {
        const threads =
          libraryCommentsMatch[1] === FILE_LEDGER_ID
            ? FILE_LEDGER_THREADS
            : libraryCommentsMatch[1] === FILE_REFUND_ID
              ? FILE_REFUND_THREADS
              : [];
        return respond(200, { threads, hasMore: false });
      }
      const libraryFileMatch = subPath.match(/^\/library\/([^/]+)$/);
      if (libraryFileMatch) {
        const file = LIBRARY_FILES.find((candidate) => candidate.id === libraryFileMatch[1]);
        if (file) return respond(200, { file, tags: [] });
        return respond(404, { error: 'NOT_FOUND', message: 'Library file not found' });
      }

      // --- project detail fallback ---------------------------------------
      if (subPath === '') return respond(200, PROJECT);
      return respond(200, PROJECT);
    }

    return undefined;
  });
}

/**
 * Captures a locator's bounding box plus a fixed CSS-pixel margin on every
 * side, clamped to the viewport. `marketingShot` (marketing-shots-helpers.ts)
 * only exposes element-exact crops; some dialogs (e.g. the credential health
 * modal) sit directly against the app chrome, so a bare element crop leaves
 * zero breathing room around the card in the marketing image. Mirrors
 * `marketingShot`'s own output-directory logic so both land in the same
 * place under MARKETING_SHOTS.
 */
async function marketingShotPadded(
  page: Page,
  name: string,
  locator: ReturnType<Page['locator']>,
  paddingPx = 24,
) {
  await page.waitForTimeout(700);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`marketingShotPadded: no bounding box for "${name}"`);
  const viewport = page.viewportSize();
  const x = Math.max(0, box.x - paddingPx);
  const y = Math.max(0, box.y - paddingPx);
  const maxWidth = viewport ? viewport.width - x : box.width + paddingPx * 2;
  const maxHeight = viewport ? viewport.height - y : box.height + paddingPx * 2;
  const clip = {
    x,
    y,
    width: Math.min(box.width + paddingPx * 2, maxWidth),
    height: Math.min(box.height + paddingPx * 2, maxHeight),
  };

  const dir = process.env.MARKETING_SHOTS
    ? resolve(process.cwd(), '../www/public/images/features')
    : resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}${MARKETING_THEME === 'light' ? '-light' : ''}.png`, clip });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Marketing shots — collaboration & comments', () => {
  test('A. members & access panel', async ({ page }) => {
    await setupWorldMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/access`);

    const heading = page.getByRole('heading', { name: 'Members', exact: true });
    await expect(heading).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Pending Requests')).toBeVisible();
    await expect(page.getByText('Jordan Lee')).toBeVisible();
    await expect(page.getByText('Sam Whitfield')).toBeVisible();

    // Create the invite link so Copy / New Link / Revoke all render together.
    await page.getByRole('button', { name: 'Create Link' }).click();
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible();

    await heading.scrollIntoViewIfNeeded();
    await assertNoOverflow(page);

    // The rendered invite URL is built from window.location.origin, which in
    // this Playwright run is http://localhost:4173 — patch the DOM input's
    // .value (what the screenshot renders) to a realistic marketing domain.
    // This is a display-only DOM mutation after the last assertion; React
    // does not re-render the input's value from here, so it holds for the
    // capture below.
    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll('input')).find((el) =>
        el.value.includes('/projects/invite/')
      );
      if (input) {
        input.value = input.value.replace(/^https?:\/\/[^/]+/, 'https://app.northwindlabs.dev');
      }
    });

    const section = heading.locator('xpath=ancestor::section[1]').first();
    await marketingShot(page, 'sam-collab-members-access', section);
  });

  test('B. invite recipient card', async ({ page }) => {
    await setupWorldMocks(page);
    await page.goto(`/projects/invite/${INVITE_TOKEN}`);

    const requestButton = page.getByRole('button', { name: 'Request Access' });
    await expect(requestButton).toBeVisible({ timeout: 15000 });

    const card = page.locator('section').filter({ has: requestButton }).first();
    await expect(card.getByText(NORTHWIND.projectName)).toBeVisible();
    await expect(card.getByText(NORTHWIND.repository)).toBeVisible();
    await assertNoOverflow(page);

    await marketingShot(page, 'sam-collab-invite-request', card);
  });

  test('C. all sessions', async ({ page }) => {
    await setupWorldMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_IDEMPOTENCY_ID}`);

    await expect(page.getByRole('button', { name: 'All sessions' })).toHaveAttribute('aria-pressed', 'true');
    const sessionNav = page.getByRole('navigation', { name: 'Chat sessions' });
    await expect(sessionNav.getByText('Migrate ledger to double-entry schema')).toBeVisible({ timeout: 15000 });
    await expect(sessionNav.getByText('Nightly dependency audit run')).toBeVisible();
    await expect(page.getByText("I'll add an idempotency key derived from the Stripe event ID")).toBeVisible();
    await expect(page.getByText(/Re-ran the refund webhook test suite/)).toBeVisible();

    await assertNoOverflow(page);
    await marketingShot(page, 'sam-collab-all-sessions');
  });

  test('D. credential attribution', async ({ page }) => {
    await setupWorldMocks(page);
    // Override only for this test so the sidebar badge/banner stays quiet on
    // every other screenshot (later-registered route wins).
    await page.route(`**/api/projects/${PROJECT_ID}/credential-attribution-health`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CREDENTIAL_HEALTH) })
    );

    // The modal caps its resource list at 58vh internally. Four resource
    // groups (triggers, running tasks, deployments, nodes) still exceed that
    // band at the standard 900px marketing viewport, so use a taller
    // viewport just for this capture to fit every group without an internal
    // scroll cutting the bottom group off.
    await page.setViewportSize({ width: 1440, height: 1400 });

    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_IDEMPOTENCY_ID}`);
    const badge = page.getByRole('button', { name: /open credential attribution health/i });
    await expect(badge).toBeVisible({ timeout: 15000 });
    await badge.click();

    const dialog = page.getByRole('dialog', { name: /credential attribution/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("This runs on Marcus Chen's personal Claude Code key.")).toBeVisible();
    await expect(dialog.getByText("This runs on Elena Rossi's personal Codex key.")).toBeVisible();
    await expect(dialog.getByText('Northwind Shared Hetzner').first()).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await expect(dialog.getByText('fsn1 workspace node')).toBeVisible();

    // .glass-modal is a genuinely translucent surface (background-color +
    // backdrop-filter blur, see index.css) — an element-only crop still lets
    // page content behind it bleed through at the edges. Force it (and the
    // full-viewport backdrop button behind it) opaque before capturing, and
    // use the padded capture so the opaque card reads as a standalone panel
    // rather than a tight crop against the app chrome.
    await page.addStyleTag({
      content: `
        .glass-modal {
          background-color: ${OPAQUE_BACKDROP_COLOR} !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
        }
        [aria-label="Close credential health"] {
          background-color: ${OPAQUE_BACKDROP_COLOR} !important;
          opacity: 1 !important;
        }
      `,
    });

    await marketingShotPadded(page, 'sam-collab-credential-attribution', dialog);
  });

  test('E. comments inbox', async ({ page }) => {
    await setupWorldMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/comments`);

    await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15000 });
    await expect(page.locator('[data-comment-thread-id]').first()).toBeVisible();
    await expect(page.getByText('Use a UUIDv7 here so keys sort by time instead of a random UUIDv4.')).toBeVisible();
    await expect(page.getByText(/This runbook step 4 still references/)).toBeVisible();

    await assertNoOverflow(page);
    await marketingShot(page, 'sam-comments-inbox');
  });

  test('F. chat thread with desktop comment rail', async ({ page }) => {
    await setupWorldMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_IDEMPOTENCY_ID}`);
    await expect(page.getByText(/Re-ran the refund webhook test suite/)).toBeVisible({ timeout: 15000 });

    // The session tool rail can default to icon-only mode, where the button's
    // accessible name is "Open comment threads — N needs you" rather than the
    // literal label "Comments" (only shown in icons+labels mode).
    await page.getByRole('button', { name: /open comment threads/i }).click();
    const rail = page.getByRole('complementary', { name: 'Session comments' });
    await expect(rail).toBeVisible();
    await expect(
      rail.getByText("Double check this survives Stripe's at-least-once redelivery")
    ).toBeVisible();
    await expect(rail.getByText('Added a 30-day TTL sweep via a scheduled cleanup job.')).toBeVisible();
    await expect(
      rail.getByText('Prefer the retry helper in lib/http.ts instead of writing a bespoke backoff loop.')
    ).toBeVisible();

    // Thread 1 (Elena's comment, Priya's "Sent to agent" reply, and the
    // Claude Code — Opus 5 reply) already carries the Reply / Resolve
    // buttons and the "Sent to agent" label without expanding anything.
    // Leave thread 2's reply composer collapsed (just Reply / Resolve on
    // Marcus's open comment) so both threads fit inside the 900px marketing
    // frame — expanding either composer previously pushed thread 1's quoted
    // anchor and Elena's original comment out of frame.
    const firstThread = rail
      .locator('article')
      .filter({ hasText: "Double check this survives" })
      .first();
    await expect(firstThread.getByRole('button', { name: 'Reply' })).toBeVisible();
    await expect(firstThread.getByRole('button', { name: 'Resolve' })).toBeVisible();
    await expect(firstThread.getByText('Sent to agent')).toBeVisible();
    const secondThread = rail.locator('article').filter({ hasText: 'Prefer the retry helper' }).first();
    await expect(secondThread.getByRole('button', { name: 'Reply' })).toBeVisible();
    await expect(secondThread.getByRole('button', { name: 'Resolve' })).toBeVisible();
    await expect(secondThread.getByRole('radio', { name: 'Send to agent' })).toHaveCount(0);

    // Reset scroll to the very top of the rail so the anchored quote and
    // Elena's original comment on thread 1 are not cut off above the fold.
    await rail.getByRole('heading', { name: 'Comments' }).scrollIntoViewIfNeeded();

    await assertNoOverflow(page);
    await marketingShot(page, 'sam-comments-chat-thread');
  });

  test('G. library file comment panel', async ({ page }) => {
    await setupWorldMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/library?preview=${FILE_LEDGER_ID}`);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'ledger-migration-plan.md' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ledger Migration Plan' })).toBeVisible();

    await page.getByRole('button', { name: 'Show comments' }).click();
    const panel = dialog.filter({ has: page.getByRole('heading', { name: 'Comments' }) });
    await expect(panel.getByRole('heading', { name: 'Comments' })).toBeVisible();
    await expect(
      panel.getByText('The backfill batches of 5,000 rows will still lock big merchants for a while')
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: /Show resolved thread/ })).toBeVisible();

    await assertNoOverflow(page);
    await marketingShot(page, 'sam-comments-library-file', dialog);
  });
});
