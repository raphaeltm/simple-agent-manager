/**
 * Mock data for the Automation page audits: production-shaped records with long text, every
 * attention case, agent waits next to SAM's own relays, and private agent-dm channels.
 */
import type { Page } from '@playwright/test';

import { makeMockUser, setupAuditRoutes } from './audit-helpers';

export const PROJECT_ID = 'proj-automation';
export const OWNER_ID = 'owner-user';
export const VIEWER_ID = 'viewer-user';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const zone = 'UTC';

export const LONG_NAME =
  'Nightly dependency audit across every package in the monorepo, including the marketing site, the VM agent and all shared libraries, with a summary for the release channel';

/** The next weekday 09:00 UTC, so "Weekdays at 9:00 AM" and its next run agree. */
function nextWeekdayNineUtc() {
  const next = new Date(NOW);
  next.setUTCHours(9, 0, 0, 0);
  while (next.getTime() <= NOW || next.getUTCDay() === 0 || next.getUTCDay() === 6)
    next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

const CHAT_RELEASE = 'chat-release-shepherd';
const CHAT_DOCS = 'chat-docs-refresh';

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trg-morning',
    projectId: PROJECT_ID,
    userId: OWNER_ID,
    name: 'Morning pull request summary',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * 1,2,3,4,5',
    cronHumanReadable: 'Every weekday at 9:00 AM UTC',
    cronTimezone: zone,
    skipIfRunning: true,
    promptTemplate:
      'Summarize the open pull requests: what is ready to merge, what is blocked, and what needs a review. Today is {{schedule.dayOfWeek}}.',
    agentProfileId: 'profile-codex',
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    maxConcurrent: 1,
    lastTriggeredAt: iso(-3 * HOUR),
    triggerCount: 42,
    nextFireAt: nextWeekdayNineUtc(),
    createdAt: iso(-40 * DAY),
    updatedAt: iso(-2 * DAY),
    ...overrides,
  };
}

export const TRIGGERS = {
  morning: trigger(),
  failing: trigger({
    id: 'trg-deps',
    name: LONG_NAME,
    status: 'paused',
    cronExpression: '30 2 * * *',
    cronTimezone: 'America/Toronto',
    nextFireAt: null,
    lastTriggeredAt: iso(-26 * HOUR),
    triggerCount: 11,
  }),
  github: trigger({
    id: 'trg-sam-command',
    name: 'Answer /sam comments',
    sourceType: 'github',
    cronExpression: null,
    nextFireAt: null,
    lastTriggeredAt: iso(-50 * MIN),
    githubConfig: {
      eventType: 'issue_comment',
      filters: { actions: ['created'], commandPrefix: '/sam', ignoreActors: ['dependabot[bot]'] },
    },
    promptTemplate:
      '{{github.actor}} asked on {{github.repository}}#{{github.number}}: {{github.comment}}',
  }),
  webhook: trigger({
    id: 'trg-alerts',
    name: 'Investigate production alerts',
    sourceType: 'webhook',
    cronExpression: null,
    nextFireAt: null,
    lastTriggeredAt: iso(-5 * HOUR),
    webhookConfig: {
      sourceLabel: 'PagerDuty',
      filterMode: 'all',
      filters: [{ path: 'event.severity', operator: 'equals', value: 'critical' }],
      includedHeaders: ['x-request-id'],
      tokenLastFour: 'a9f2',
      tokenCreatedAt: iso(-30 * DAY),
      tokenRotatedAt: null,
    },
    promptTemplate: 'Look into this alert and report what broke: {{webhook.payload}}',
    credentialAttribution: {
      multiplayerActive: true,
      hasPersonalWarning: true,
      checks: [
        {
          consumerKind: 'agent',
          consumerTarget: 'claude-code',
          label: 'Agent credential (claude-code)',
          source: 'personal',
          owner: { id: OWNER_ID, name: 'Owner User', email: 'owner@example.com', avatarUrl: null },
          projectCredential: null,
          fixHref: `/projects/${PROJECT_ID}/settings/connections`,
          warning: 'This runs on Owner User’s personal key.',
        },
      ],
    },
  }),
  off: trigger({
    id: 'trg-off',
    name: 'Weekly docs check',
    status: 'disabled',
    cronExpression: '0 5 * * 1',
    nextFireAt: null,
    lastTriggeredAt: iso(-12 * DAY),
  }),
};

function run(id: string, status: string, ago: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    triggerId: 'trg',
    projectId: PROJECT_ID,
    status,
    skipReason: status === 'skipped' ? 'still_running' : null,
    taskId: status === 'skipped' ? null : `task-${id}`,
    eventType: 'cron',
    renderedPrompt: null,
    errorMessage: null,
    scheduledAt: iso(-ago),
    startedAt: iso(-ago),
    completedAt: status === 'running' || status === 'queued' ? null : iso(-ago + 4 * MIN),
    sequenceNumber: 1,
    createdAt: iso(-ago),
    ...extra,
  };
}

export const RUNS: Record<string, unknown[]> = {
  'trg-morning': [
    run('m3', 'completed', 3 * HOUR),
    run('m2', 'completed', 27 * HOUR),
    run('m1', 'skipped', 51 * HOUR),
  ],
  'trg-deps': [
    run('d3', 'failed', 26 * HOUR, {
      errorMessage:
        'The GitHub token for this project expired. Reconnect GitHub in project settings and resume the automation.',
    }),
    run('d2', 'failed', 50 * HOUR, { errorMessage: 'GitHub token expired' }),
    run('d1', 'failed', 74 * HOUR, { errorMessage: 'GitHub token expired' }),
  ],
  'trg-sam-command': [run('g2', 'running', 50 * MIN), run('g1', 'completed', 5 * HOUR)],
  'trg-alerts': [run('w2', 'queued', 5 * HOUR), run('w1', 'completed', 2 * DAY)],
  'trg-off': [],
};

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sch-release',
    projectId: PROJECT_ID,
    creatorUserId: OWNER_ID,
    creatorChatSessionId: CHAT_RELEASE,
    reason: 'Check the release went out',
    action: {
      kind: 'message_session',
      sessionId: CHAT_RELEASE,
      prompt: 'Check that release 2026.10.20 is live and the smoke tests passed.',
    },
    state: 'pending',
    dueAt: NOW + 95 * MIN,
    displayTimezone: zone,
    expiresAt: NOW + 95 * MIN + DAY,
    version: 2,
    idempotencyKey: 'key-release',
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    nextAttemptAt: null,
    attemptCount: 0,
    lastError: null,
    eventId: null,
    deliveryId: null,
    resultTaskId: null,
    resultSessionId: null,
    watchId: null,
    sourceEventId: null,
    execution: {
      kind: 'message_session',
      status: 'not_started',
      checkedAt: NOW,
      deliveryId: null,
      taskId: null,
      sessionId: null,
      receiptState: null,
      error: null,
      retrySubmissionAllowed: false,
      submissionDeadline: null,
    },
    ...overrides,
  };
}

export const SCHEDULES = [
  schedule(),
  schedule({
    id: 'sch-ambiguous',
    reason: 'Remind the docs chat to publish',
    action: { kind: 'message_session', sessionId: CHAT_DOCS, prompt: 'Publish the docs refresh.' },
    state: 'ambiguous',
    dueAt: NOW - 4 * HOUR,
    updatedAt: NOW - 3 * HOUR,
    lastError: 'The chat did not confirm the message before the delivery window ended.',
    execution: {
      kind: 'message_session',
      status: 'unavailable',
      checkedAt: NOW - 3 * HOUR,
      deliveryId: 'del-1',
      taskId: null,
      sessionId: CHAT_DOCS,
      receiptState: null,
      error: null,
      retrySubmissionAllowed: false,
      submissionDeadline: null,
    },
  }),
  schedule({
    id: 'sch-late',
    reason: null,
    action: {
      kind: 'start_session',
      prompt: 'Rerun the flaky end-to-end suite and file what still fails',
      agentProfileId: null,
      skillId: null,
    },
    dueAt: NOW - 20 * MIN,
    attemptCount: 2,
    nextAttemptAt: NOW + 5 * MIN,
    lastError: 'No machine was free',
  }),
  schedule({
    id: 'sch-done',
    reason: 'Tidy up stale branches',
    action: {
      kind: 'start_session',
      prompt: 'Delete merged branches older than a month.',
      agentProfileId: null,
      skillId: null,
    },
    state: 'admitted',
    dueAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    resultSessionId: 'chat-branches',
  }),
  schedule({
    id: 'sch-by-watch',
    reason: null,
    watchId: 'wat-release-failed',
    action: {
      kind: 'start_session',
      prompt: 'A release failed. Read the logs.',
      agentProfileId: null,
      skillId: null,
    },
    state: 'admitted',
    dueAt: NOW - 6 * HOUR,
    createdAt: NOW - 6 * HOUR,
    updatedAt: NOW - 6 * HOUR,
  }),
];

function watch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wat-release-failed',
    projectId: PROJECT_ID,
    creatorUserId: 'coworker-user',
    reason: 'Look into failed releases',
    filter: { version: 1, source: 'sam.lifecycle', eventType: 'deployment.release.failed' },
    action: {
      kind: 'start_session',
      prompt: 'A release failed. Read its logs, explain what went wrong, and suggest a fix.',
      agentProfileId: null,
      skillId: null,
    },
    state: 'active',
    version: 4,
    idempotencyKey: 'key-w1',
    cooldownMs: 10 * MIN,
    maxConcurrent: 1,
    maxExecutions: 20,
    executionCount: 20,
    nextEligibleAt: 0,
    subscriptionId: 'sub-watch-1',
    createdAt: NOW - 20 * DAY,
    updatedAt: NOW - 6 * HOUR,
    lastError: null,
    ...overrides,
  };
}

export const WATCHES = [
  watch(),
  watch({
    id: 'wat-issues',
    reason: null,
    filter: { version: 1, source: 'github', eventType: 'issues.opened' },
    action: {
      kind: 'message_session',
      sessionId: CHAT_RELEASE,
      prompt: 'A new issue was opened; check whether it blocks the release.',
    },
    executionCount: 3,
    maxExecutions: 100,
    state: 'paused',
    lastError: 'Standing watch creator does not own the target chat',
  }),
];

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-ci',
    projectId: PROJECT_ID,
    contractVersion: 1,
    owner: { type: 'agent', id: `${PROJECT_ID}:${CHAT_RELEASE}`, name: '01M5AGENTSESSION' },
    idempotencyKey: 'key-sub',
    filter: {
      version: 1,
      source: 'github',
      eventType: 'check_suite.completed',
      subjectType: 'commit',
      subjectId: '9f8e7d6c5b4a39281706',
    },
    filterFingerprint: 'fp',
    matchKeyCount: 1,
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: CHAT_RELEASE, taskId: 'task-release', runtimeId: null, agentId: null },
    },
    state: 'active',
    reason: 'Wake me when CI finishes on the release commit',
    createdAt: NOW - 40 * MIN,
    updatedAt: NOW - 40 * MIN,
    expiresAt: NOW + 5 * HOUR,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    lastMatchedAt: null,
    ...overrides,
  };
}

export const SUBSCRIPTIONS = [
  subscription(),
  subscription({
    id: 'sub-review',
    filter: {
      version: 1,
      source: 'github',
      eventType: 'pull_request_review.submitted',
      subjectType: 'pull_request',
      subjectId: '2387',
    },
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: CHAT_DOCS, taskId: 'task-docs', runtimeId: null, agentId: null },
    },
    createdAt: NOW - 3 * HOUR,
  }),
  subscription({
    id: 'sub-relay',
    owner: { type: 'agent', id: `${PROJECT_ID}:${CHAT_RELEASE}`, name: 'SAM agent messaging' },
    filter: {
      version: 1,
      source: 'sam.agent_channel',
      eventType: 'agent.channel.published',
      subjectType: 'agent_channel',
      subjectId: 'agent-dm.e6b43d314ae9e2200871128392c560bd1a021357',
    },
    reason:
      'SAM agent messaging on agent-dm.e6b43d314ae9e2200871128392c560bd1a021357 with task 01M5D3GGDGYVPN0XBE9V1QX4XB',
  }),
  subscription({
    id: 'sub-watch',
    owner: { type: 'standing_watch', id: 'wat-release-failed', name: null },
    filter: { version: 1, source: 'sam.lifecycle', eventType: 'deployment.release.failed' },
    deliveryPreference: { requested: 'spawn_task', resolved: 'spawn_task', target: {} },
  }),
];

export const CHANNELS = [
  {
    id: 'ch-dm',
    name: 'agent-dm.0b1c2d3e4f5061728394a5b6c7d8e9f001122334',
    lifetimeCount: 14,
    lastPublishedAt: NOW - 5 * MIN,
  },
  { id: 'ch-release', name: 'release-train', lifetimeCount: 128, lastPublishedAt: NOW - 12 * MIN },
  { id: 'ch-docs', name: 'docs-refresh', lifetimeCount: 9, lastPublishedAt: NOW - 3 * DAY },
];

export const CHATS = [
  {
    id: CHAT_RELEASE,
    topic: 'PR #2387 release shepherd',
    status: 'active',
    createdAt: NOW - DAY,
    updatedAt: NOW - HOUR,
  },
  {
    id: CHAT_DOCS,
    topic: 'Refresh the public docs for the Automation page',
    status: 'sleeping',
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 3 * HOUR,
  },
];

export const PROFILES = [
  {
    id: 'profile-codex',
    name: 'Codex 5.5 High',
    model: 'gpt-5.5',
    effort: 'high',
    agentType: 'openai-codex',
  },
  {
    id: 'profile-claude',
    name: 'Claude Opus',
    model: 'claude-opus-5-5',
    effort: 'auto',
    agentType: 'claude-code',
  },
];

function member(userId: string, name: string, role: string) {
  return {
    projectId: PROJECT_ID,
    userId,
    role,
    status: 'active',
    invitedBy: null,
    createdAt: iso(-90 * DAY),
    updatedAt: iso(-90 * DAY),
    user: { id: userId, name, email: `${userId}@example.com`, image: null, avatarUrl: null },
  };
}

export interface AutomationMockOptions {
  userId?: string;
  empty?: boolean;
  many?: boolean;
  failLists?: boolean;
  long?: boolean;
}

/** Thirty extra recurring automations, to see how long lists and filters behave. */
function manyTriggers() {
  return Array.from({ length: 30 }, (_, index) =>
    trigger({
      id: `trg-many-${index}`,
      name: `Repository chore ${String(index + 1).padStart(2, '0')}: ${index % 3 === 0 ? LONG_NAME : 'rotate logs and prune caches'}`,
      cronExpression: `${index % 60} ${index % 24} * * *`,
      nextFireAt: iso((index + 1) * HOUR),
      status: index % 7 === 0 ? 'paused' : 'active',
    })
  );
}

export async function setupAutomationMocks(page: Page, options: AutomationMockOptions = {}) {
  const userId = options.userId ?? OWNER_ID;
  const user = makeMockUser({
    userId,
    sessionId: `session-${userId}`,
    email: `${userId}@example.com`,
    name: userId === OWNER_ID ? 'Owner User' : 'Viewer User',
  });
  const project = {
    id: PROJECT_ID,
    name: 'simple-agent-manager',
    repository: 'acme/simple-agent-manager',
    repoProvider: 'github',
    defaultBranch: 'main',
    userId: OWNER_ID,
    installationId: 'inst-1',
    createdAt: iso(-90 * DAY),
    updatedAt: iso(-1 * DAY),
    multiplayerActive: true,
    summary: {
      activeWorkspaceCount: 0,
      activeSessionCount: 0,
      lastActivityAt: null,
      taskCountsByStatus: {},
      linkedWorkspaces: 0,
    },
  };
  const triggers = options.empty
    ? []
    : [...Object.values(TRIGGERS), ...(options.many ? manyTriggers() : [])].map((item) =>
        options.long ? { ...item, name: `${item.name} ${LONG_NAME}` } : item
      );
  const schedules = options.empty ? [] : SCHEDULES;
  const watches = options.empty ? [] : WATCHES;
  const members = {
    members: [
      member(OWNER_ID, 'Owner User', 'owner'),
      member('coworker-user', 'Coworker With A Long Display Name', 'admin'),
      member(VIEWER_ID, 'Viewer User', 'viewer'),
    ],
    inviteLinks: [],
    accessRequests: [],
  };

  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, userId);

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, user);
    if (path === '/api/projects') return respond(200, { projects: [project] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/credentials/'))
      return respond(200, { consumers: [], credentials: [] });
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });

    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return undefined;
    const sub = match[2] ?? '';
    if (sub === '') return respond(200, project);
    if (sub === '/members') return respond(200, members);
    if (sub.startsWith('/agent-profiles')) return respond(200, { items: PROFILES });
    if (sub.startsWith('/skills'))
      return respond(200, { items: [{ id: 'skill-release', name: 'Release checklist' }] });
    if (sub.startsWith('/sessions')) return respond(200, { sessions: CHATS, total: CHATS.length });
    if (sub === '/credential-attribution-health')
      return respond(200, {
        projectId: PROJECT_ID,
        multiplayerActive: true,
        counts: {
          resources: 0,
          personalResources: 0,
          personalCredentials: 0,
          projectCoveredCredentials: 0,
          unknownCredentials: 0,
        },
        resources: [],
      });
    if (
      options.failLists &&
      (sub === '/triggers' || sub === '/schedules' || sub === '/standing-watches')
    )
      return respond(500, {
        error: 'INTERNAL_ERROR',
        message: 'The project store did not answer in time.',
      });
    if (sub === '/triggers') return respond(200, { triggers });
    const runs = sub.match(/^\/triggers\/([^/]+)\/executions/);
    if (runs) return respond(200, { executions: RUNS[runs[1] ?? ''] ?? [], nextCursor: null });
    const deliveries = sub.match(/^\/triggers\/([^/]+)\/webhook\/deliveries/);
    if (deliveries)
      return respond(200, {
        deliveries: [
          {
            id: 'dl-2',
            triggerId: 'trg-alerts',
            outcome: 'filtered',
            httpStatus: 202,
            bodyBytes: 812,
            executionId: null,
            errorCode: null,
            receivedAt: iso(-2 * HOUR),
            processedAt: iso(-2 * HOUR),
          },
          {
            id: 'dl-1',
            triggerId: 'trg-alerts',
            outcome: 'accepted',
            httpStatus: 202,
            bodyBytes: 1440,
            executionId: 'w1-execution-id',
            errorCode: null,
            receivedAt: iso(-5 * HOUR),
            processedAt: iso(-5 * HOUR),
          },
        ],
        nextCursor: null,
      });
    const single = sub.match(/^\/triggers\/([^/]+)$/);
    if (single) {
      const found = triggers.find((item) => item.id === single[1]);
      return found
        ? respond(200, found)
        : respond(404, { error: 'NOT_FOUND', message: 'Trigger not found' });
    }
    if (sub === '/schedules') return respond(200, { schedules, nextCursor: null });
    const oneSchedule = sub.match(/^\/schedules\/([^/]+)$/);
    if (oneSchedule) {
      const found = schedules.find((item) => item.id === oneSchedule[1]);
      return found
        ? respond(200, { schedule: found })
        : respond(404, { error: 'NOT_FOUND', message: 'Schedule not found' });
    }
    if (sub === '/standing-watches') return respond(200, { watches, nextCursor: null });
    const oneWatch = sub.match(/^\/standing-watches\/([^/]+)$/);
    if (oneWatch) {
      const found = watches.find((item) => item.id === oneWatch[1]);
      return found
        ? respond(200, { watch: found })
        : respond(404, { error: 'NOT_FOUND', message: 'Standing watch not found' });
    }
    if (sub.startsWith('/event-subscriptions'))
      return respond(200, { subscriptions: options.empty ? [] : SUBSCRIPTIONS, hasMore: false });
    if (sub.match(/^\/event-channels\/[^/]+\/history/))
      return respond(200, {
        channel: CHANNELS[1],
        events: [
          {
            sequence: 128,
            event: {
              id: 'evt-128',
              receivedAt: NOW - 12 * MIN,
              display: { title: 'Release 2026.10.20 is rolling out', untrusted: true },
              metadata: {
                message:
                  'Production deploy started. Smoke tests next; I will post again when they pass.',
                actor: { chatSessionId: CHAT_RELEASE },
              },
            },
          },
        ],
        cursor: 'c1',
        hasMore: false,
        watermark: 128,
        retentionGap: false,
      });
    if (sub.startsWith('/event-channels'))
      return respond(200, { channels: options.empty ? [] : CHANNELS, nextCursor: null });
    return respond(200, {});
  });
}
