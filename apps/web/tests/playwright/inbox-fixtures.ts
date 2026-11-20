/**
 * Inbox mock data and routes for the Playwright audits (slice C). Stress data per the task:
 * 40 items across 4 projects, a three-line title, a 12-step task, a 10-option question, an
 * expiring permission, every item kind, and the empty inbox.
 */
import type { Page } from '@playwright/test';

import { makeMockUser, setupAuditRoutes } from './audit-helpers';
import { respondToAppShellRoute } from './audit-routes';

export const INBOX_USER = makeMockUser({
  email: 'inbox@example.com',
  name: 'Inbox Tester',
  sessionId: 'session-inbox',
  userId: 'user-inbox',
});

const NOW = Date.now();
const MIN = 60_000;

export const PROJECTS = [
  { id: 'p-billing', name: 'Acme Billing' },
  { id: 'p-site', name: 'Marketing site with a very long project name that will not fit' },
  { id: 'p-infra', name: 'Infra' },
  { id: 'p-x', name: 'X' },
];

type Item = Record<string, unknown> & { ref: string; projectId: string };

function base(overrides: Partial<Item> & { ref: string }): Item {
  const project = PROJECTS.find((p) => p.id === overrides.projectId) ?? PROJECTS[0]!;
  return {
    store: 'ask',
    kind: 'question',
    projectId: project.id,
    projectName: project.name,
    sessionId: `s-${overrides.ref.replace(/[^a-z0-9]/gi, '')}`,
    topic: 'Ship billing',
    taskId: 't-1',
    stackKey: `stack-${overrides.ref}`,
    title: 'Should EU prices include VAT?',
    body: 'The pricing page and the checkout total both depend on it. I wrote both versions; I will delete the one you do not pick.',
    blocking: true,
    agentState: 'waiting',
    status: 'open',
    createdAt: new Date(NOW - 12 * MIN).toISOString(),
    expiresAt: null,
    dueAt: null,
    answerSpec: {
      type: 'options',
      options: ['Include VAT', 'Show VAT separately', 'Ask the accountant first'],
      allowText: true,
    },
    links: [],
    canAct: true,
    // Items with a source chat take replies (the backend sets this for open, actable items).
    canReply: true,
    untrustedContent: true,
    ...overrides,
  } as Item;
}

const TEN_OPTIONS = [
  'Falkenstein (fsn1)',
  'Nuremberg (nbg1)',
  'Helsinki (hel1)',
  'Ashburn (ash)',
  'Hillsboro (hil)',
  'Singapore (sin)',
  'Paris (par1)',
  'Amsterdam (ams1)',
  'Warsaw (waw1)',
  'Frankfurt (fra1)',
];

const TWELVE_STEPS = Array.from(
  { length: 12 },
  (_, i) => `${i + 1}. Step ${i + 1}: rotate the restricted key in environment ${i + 1}`
).join('\n');

/** One open item of every kind, in server order (live deadlines first). */
export const KIND_ITEMS: Item[] = [
  base({
    ref: 'attention:s-perm:m-perm',
    store: 'attention',
    kind: 'permission',
    sessionId: 's-perm',
    topic: 'Invoice PDF export',
    title: 'Allow running the invoices migration on staging',
    body: 'The PDF export needs one new column. The agent is holding the terminal open until you answer.',
    expiresAt: new Date(NOW + 4 * MIN).toISOString(),
    answerSpec: { type: 'interaction', interactionId: 'int-1', interactionKind: 'permission' },
    links: [
      { kind: 'pr', id: 'https://github.com/acme/billing/pull/91', label: 'PR #91 (draft)' },
      { kind: 'file', id: 'f-1', label: 'invoice-pdf.md' },
    ],
  }),
  base({
    ref: 'approval:ap-1',
    store: 'approval',
    kind: 'approval',
    topic: 'Clean up staging',
    title: 'Approve deleting a stuck staging workspace',
    body: 'The workspace has been unreachable for 6 hours and holds a node. Deleting it frees the node.',
    createdAt: new Date(NOW - 40 * MIN).toISOString(),
    answerSpec: {
      type: 'approval',
      action: 'delete_workspace',
      targetType: 'workspace',
      targetId: 'ws-01HZZZZZZZZZZZZZZZZZZZZZZZ',
    },
  }),
  base({
    ref: 'ask:q-vat',
    stackKey: 'stack-ship',
    topic: 'Ship billing',
    links: [
      { kind: 'idea', id: 'i-1', label: 'EU pricing' },
      { kind: 'url', id: 'https://example.com/pricing', label: 'Preview: /pricing' },
      { kind: 'policy', id: 'pol-1', label: 'Pricing policy' },
    ],
  }),
  base({
    ref: 'secret:sr-1',
    store: 'secret',
    kind: 'secret',
    stackKey: 'stack-ship',
    title: 'Add the Stripe live webhook secret',
    body: 'Production webhooks are rejected until this exists. I cannot read or create live Stripe secrets.',
    answerSpec: { type: 'secret', envKey: 'STRIPE_WEBHOOK_SECRET', requestId: 'sr-1' },
  }),
  base({
    ref: 'ask:q-regions',
    stackKey: 'stack-ship',
    title: 'Which region should new staging nodes default to?',
    body: 'Placement falls back to this when a pool has no preference. Prices differ by up to 30%.',
    answerSpec: { type: 'options', options: TEN_OPTIONS, allowText: true },
  }),
  base({
    ref: 'ask:task-1',
    kind: 'task',
    blocking: false,
    agentState: 'finished',
    topic: 'Security follow-up',
    title: 'Roll the Stripe restricted API key',
    body: TWELVE_STEPS,
    createdAt: new Date(NOW - 120 * MIN).toISOString(),
    answerSpec: { type: 'acknowledge' },
  }),
  base({
    ref: 'ask:review-1',
    kind: 'review',
    blocking: false,
    agentState: 'finished',
    topic: 'Pricing page rewrite',
    title: 'Please check the new pricing page before I open the PR',
    body: null,
    createdAt: new Date(NOW - 60 * MIN).toISOString(),
    answerSpec: { type: 'acknowledge' },
  }),
  base({
    ref: 'ask:result-1',
    kind: 'result',
    blocking: false,
    agentState: 'finished',
    topic: 'Hosting cost comparison',
    title: 'Hetzner is the cheapest place for the staging nodes, by about two thirds',
    // A result's context is markdown, as agents are told to write it; long to stress the layout.
    body:
      'Same 4 vCPU / 8 GB machine, per month:\n\n' +
      '- **Hetzner**: €7.90\n- Scaleway: €21.50\n- DigitalOcean: $48\n\n' +
      'Hetzner placement failed twice in Falkenstein last week, so I would **keep the fallback chain**. ' +
      'The full table with every region is in the linked file. '.repeat(3),
    createdAt: new Date(NOW - 30 * MIN).toISOString(),
    answerSpec: { type: 'acknowledge' },
  }),
  base({
    ref: 'ask:err-1',
    kind: 'error',
    blocking: false,
    agentState: 'not_started',
    topic: 'Fix rounding in tax totals',
    // The shape SAM files (`taskFailureError`): the quoted task name, never the error text, and
    // the classified explanation as the body.
    title: '“Fix rounding in tax totals” couldn’t start',
    body: 'The workspace or VM did not finish starting up.',
    // Slice E's error actions (first is primary; Open chat only navigates).
    answerSpec: {
      type: 'actions',
      actions: [
        { id: 'retry', label: 'Retry' },
        { id: 'open_chat', label: 'Open chat' },
      ],
    },
  }),
  base({
    ref: 'ask:long',
    projectId: 'p-site',
    topic:
      'A chat topic that is also extremely long so the meta line has to wrap or truncate without overflowing',
    title:
      'This is a deliberately long question title that runs to three lines on a phone so we can see how wrapping behaves: https://example.com/a/very/long/unbroken/url/segment/that/should/never/push/the/layout/sideways/at/all',
    body: 'A'.repeat(600),
    answerSpec: { type: 'text' },
  }),
];

/** 40 items across 4 projects: the kinds above plus filler questions. */
export const MANY_ITEMS: Item[] = [
  ...KIND_ITEMS,
  ...Array.from({ length: 40 - KIND_ITEMS.length }, (_, i) =>
    base({
      ref: `ask:filler-${i}`,
      projectId: PROJECTS[i % 4]!.id,
      topic: `Chat ${i}`,
      title: `Filler question ${i}: pick one`,
      blocking: i % 3 === 0,
      agentState: i % 3 === 0 ? 'waiting' : 'working',
      createdAt: new Date(NOW - (200 + i) * MIN).toISOString(),
      answerSpec: { type: 'options', options: ['Yes', 'No'], allowText: false },
    })
  ),
];

const agentResponse = (id: string, body: string, minutesAgo: number) => ({
  id,
  itemId: 'conv',
  author: { kind: 'agent', id: 'agent', name: 'Agent' },
  body,
  status: 'open',
  createdAt: NOW - minutesAgo * MIN,
  updatedAt: NOW - minutesAgo * MIN,
  replies: [],
});
const personReply = (
  id: string,
  content: string,
  minutesAgo: number,
  attachments: Record<string, unknown>[] = [],
  userId = INBOX_USER.user.id
) => ({ id, content, createdAt: NOW - minutesAgo * MIN, userId, attachments });

/**
 * Items that have been replied to (inbox replies, idea 01M7N16AF5HDPH1ZND4D4RJ00J): a long
 * conversation, a settled declined permission, one back from the agent, one still with it.
 */
export const REPLY_ITEMS: Item[] = [
  base({
    ref: 'ask:conv',
    projectId: 'p-billing',
    topic: 'Workspace deletion retries',
    title: 'Should the retry cap apply per node or per project?',
    body: 'Retries are now capped and logged per attempt. **Per node** keeps noisy nodes from starving others; **per project** is simpler to reason about.',
    answerSpec: { type: 'options', options: ['Per node', 'Per project'], allowText: false },
    latestReply: {
      userId: 'user-dana',
      name: 'Dana Reyes',
      messageId: 'r-3',
      repliedAt: new Date(NOW - 6 * MIN).toISOString(),
    },
    withAgent: false,
    createdAt: new Date(NOW - 90 * MIN).toISOString(),
  }),
  base({
    ref: 'attention:s-perm:m-settled',
    store: 'attention',
    kind: 'permission',
    projectId: 'p-infra',
    topic: 'Database cleanup',
    title: 'Allow dropping the legacy_sessions table on production?',
    body: 'You declined this from the inbox.',
    status: 'done',
    canAct: false,
    canReply: true,
    blocking: false,
    agentState: 'working',
    answerSpec: {
      type: 'interaction',
      interactionId: 'int-settled',
      interactionKind: 'permission',
    },
    latestReply: {
      userId: INBOX_USER.user.id,
      name: 'Inbox Tester',
      messageId: 'p-1',
      repliedAt: new Date(NOW - 20 * MIN).toISOString(),
    },
  }),
  base({
    ref: 'ask:with-agent',
    projectId: 'p-site',
    kind: 'review',
    topic: 'Pricing page rewrite',
    title:
      'Check the new pricing page copy before it ships, especially the enterprise tier wording that legal flagged last quarter',
    answerSpec: { type: 'acknowledge' },
    blocking: false,
    withAgent: true,
    latestReply: {
      userId: INBOX_USER.user.id,
      name: 'Inbox Tester',
      messageId: 'w-1',
      repliedAt: new Date(NOW - 2 * MIN).toISOString(),
    },
  }),
];

const LONG_REPLY =
  'What happens to nodes that are already mid-retry if we switch to per project? Here is the graph from last week, and the raw log line: https://logs.example.com/a/very/long/unbroken/path/segment/that/should/never/push/the/layout/sideways';

export const CONVERSATIONS: Record<string, Record<string, unknown>> = {
  'ask:conv': {
    replies: [
      personReply(
        'r-1',
        'Per node sounds right, but how many nodes hit the cap today?',
        80,
        [],
        'user-dana'
      ),
      personReply(
        'r-2',
        `${LONG_REPLY}\n\n## Attached Files\n\nThe following files have been uploaded…`,
        40,
        [
          {
            uploadId: 'u-1',
            filename: 'retry-graph-week-46.png',
            size: 240_000,
            contentType: 'image/png',
          },
          {
            uploadId: 'u-2',
            filename: 'a-very-long-attachment-file-name-from-the-ops-export-2026-11-19.csv',
            size: 1_800_000,
            contentType: 'text/csv',
          },
        ]
      ),
      personReply('r-3', 'Ok, go with per node.', 6, [], 'user-dana'),
    ],
    responses: [
      agentResponse('c-1', 'Three nodes hit it today, all on the same flaky provider region.', 70),
      agentResponse(
        'c-2',
        'Mid-retry nodes **keep their current count**; the new cap applies from their next attempt. Nothing is reset.\n\n- per node: 3 nodes affected\n- per project: 1 project affected\n\n```\nretry_cap{scope="node",node="01M7WXC7W20AZRP11K9YB3QCSZ-very-long-node-identifier"} 3 attempts_remaining=0 next_attempt_at=2026-11-20T17:05:00Z\n```',
        30
      ),
      agentResponse('c-3', 'Noted. One last check before I push: per node it is?', 4),
    ],
    nextReplyCursor: null,
    nextResponseCursor: null,
    hasMore: false,
  },
  'attention:s-perm:m-settled': {
    replies: [personReply('p-1', 'Not on production. Use the staging copy first.', 20)],
    responses: [
      agentResponse(
        'c-p',
        'Understood. I ran it on staging instead; nothing on production changed.',
        12
      ),
    ],
    nextReplyCursor: null,
    nextResponseCursor: null,
    hasMore: false,
  },
};

export const UPDATES = [
  {
    id: 'n-1',
    projectId: 'p-billing',
    taskId: null,
    sessionId: 's-1',
    type: 'pr_created',
    urgency: 'low',
    title: 'PR #93 opened: tax totals',
    body: 'Rounding fix for EU invoices',
    actionUrl: '/projects/p-billing/chat/s-1',
    metadata: { projectName: 'Acme Billing' },
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(NOW - 5 * MIN).toISOString(),
  },
  {
    id: 'n-2',
    projectId: 'p-site',
    taskId: null,
    sessionId: 's-2',
    type: 'mention',
    urgency: 'medium',
    title: 'Sam mentioned you in Pricing page rewrite',
    body: null,
    actionUrl: '/projects/p-site/chat/s-2',
    metadata: { projectName: 'Marketing site' },
    readAt: new Date(NOW).toISOString(),
    dismissedAt: null,
    createdAt: new Date(NOW - 90 * MIN).toISOString(),
  },
  {
    id: 'n-3',
    projectId: 'p-billing',
    taskId: null,
    sessionId: 's-3',
    type: 'needs_input',
    urgency: 'high',
    title: 'Input needed (an inbox item, not an update)',
    body: null,
    actionUrl: null,
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(NOW - 2 * MIN).toISOString(),
  },
];

export interface InboxMockState {
  items: Item[];
  /** Fail the list read (error state). */
  listStatus?: number;
  answered: string[];
  archived: string[];
  /** Refs replied to this run: they leave Needs you and list under Archived as with the agent. */
  replied?: string[];
  /** Reply request bodies, in order. */
  replyBodies?: unknown[];
}

export async function setupInboxMocks(page: Page, state: InboxMockState) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, INBOX_USER.user.id);
  const open = () =>
    state.items.filter(
      (item) =>
        !state.answered.includes(item.ref) &&
        !state.archived.includes(item.ref) &&
        !(state.replied ?? []).includes(item.ref) &&
        item.withAgent !== true
    );
  const withAgent = (item: Item) =>
    item.withAgent === true || (state.replied ?? []).includes(item.ref);
  await setupAuditRoutes(page, (path, respond, route) => {
    const method = route.request().method();
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: UPDATES, unreadCount: 1, nextCursor: null });
    }
    const shell = respondToAppShellRoute(path, respond, {
      user: INBOX_USER,
      projects: PROJECTS.map((p) => ({
        ...p,
        repository: 'acme/repo',
        defaultBranch: 'main',
        userId: INBOX_USER.user.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    });
    if (shell) return shell;

    const inbox = path.match(/^\/api(?:\/projects\/([^/]+))?\/inbox(\/count)?$/);
    if (inbox && method === 'GET') {
      const projectId = inbox[1];
      const scoped = open().filter((item) => !projectId || item.projectId === projectId);
      if (inbox[2]) {
        return respond(200, {
          needsYou: scoped.length,
          blocking: scoped.filter((item) => item.blocking).length,
        });
      }
      if (state.listStatus)
        return respond(state.listStatus, { error: 'INTERNAL', message: 'Inbox is unavailable' });
      const filter = new URL(route.request().url()).searchParams.get('filter') ?? 'needs_you';
      const items =
        filter === 'blocking'
          ? scoped.filter((item) => item.blocking)
          : filter === 'tasks'
            ? scoped.filter((item) => item.kind === 'task')
            : filter === 'reviews'
              ? scoped.filter((item) => item.kind === 'review')
              : filter === 'archived'
                ? state.items
                    .filter((item) => state.archived.includes(item.ref) || withAgent(item))
                    .map((item) =>
                      withAgent(item)
                        ? { ...item, withAgent: true }
                        : { ...item, status: 'archived' }
                    )
                : scoped;
      return respond(200, { items, nextCursor: null, skipped: 0 });
    }

    const itemRoute = path.match(
      /^\/api\/projects\/([^/]+)\/inbox\/items\/([^/]+)(\/answer|\/archive|\/reply)?$/
    );
    if (itemRoute) {
      const ref = decodeURIComponent(itemRoute[2]!);
      const item = state.items.find((candidate) => candidate.ref === ref);
      if (!item) return respond(404, { error: 'NOT_FOUND', message: 'Inbox item not found' });
      if (itemRoute[3] === '/answer') {
        state.answered.push(ref);
        return respond(200, { ref, outcome: 'answered', agentNotified: true });
      }
      if (itemRoute[3] === '/archive') {
        state.archived.push(ref);
        return respond(200, { ref, outcome: 'archived', agentNotified: true });
      }
      if (itemRoute[3] === '/reply') {
        (state.replied ??= []).push(ref);
        (state.replyBodies ??= []).push(route.request().postDataJSON());
        return respond(202, {
          ref,
          sessionId: item.sessionId,
          status: 'queued',
          messageId: `msg-${state.replied.length}`,
          deliveryId: `del-${state.replied.length}`,
        });
      }
      return respond(200, {
        item: withAgent(item) ? { ...item, withAgent: true } : item,
        conversation: CONVERSATIONS[ref] ?? {
          replies: [],
          responses: [],
          nextReplyCursor: null,
          nextResponseCursor: null,
          hasMore: false,
        },
        context: {
          before: [
            {
              id: 'm1',
              role: 'user',
              content: 'Ship the Stripe billing flow this week. Live mode, EU customers first.',
              createdAt: NOW - 30 * MIN,
              truncated: false,
            },
            {
              id: 'm2',
              role: 'assistant',
              content:
                'Checkout, webhooks and the plans table are merged on staging. Two things only you can decide before I flip production.',
              createdAt: NOW - 20 * MIN,
              truncated: false,
            },
          ],
          since: { messages: [], activityCount: 3, truncated: false },
        },
      });
    }

    if (/\/interactions\/int-1$/.test(path)) {
      return respond(200, {
        summary: { interactionId: 'int-1', state: 'pending' },
        detail: {
          title: 'Run pnpm db:migrate --env staging',
          description:
            'Applies migration 0031_invoice_pdf_url.sql to the staging database. Adds a nullable column, no data is rewritten.',
          options: [
            { id: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { id: 'allow-always', name: 'Always allow in this chat', kind: 'allow_always' },
            { id: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    }

    if (/\/secret-requests\/sr-1$/.test(path)) {
      return respond(200, {
        request: {
          id: 'sr-1',
          projectId: 'p-billing',
          envKey: 'STRIPE_WEBHOOK_SECRET',
          reason: 'Production webhooks are rejected until this exists.',
          ttlSeconds: null,
          status: 'pending',
          requestingTaskId: 't-1',
          requestingChatSessionId: 's-1',
          expiresAt: new Date(NOW + 60 * MIN).toISOString(),
          createdAt: new Date(NOW - 10 * MIN).toISOString(),
          resolvedAt: null,
          resolvedByName: null,
          secretExpiresAt: null,
        },
        existing: null,
        canResolve: true,
      });
    }
    return undefined;
  });
}
