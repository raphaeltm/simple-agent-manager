/**
 * Marketing screenshots — the project Automation page: the overview, a webhook
 * automation's page and its one-time credential, what agents are waiting for, a
 * watch, and agent channels. Renders the REAL production components with mocked
 * API data and captures the images embedded in the public marketing site
 * (apps/www/src/data/features/events.json -> apps/www/public/images/features).
 * The homepage scene (apps/www/src/data/scenes/events.json) crops
 * sam-triggers-sources; re-check its boxes after re-capturing it.
 *
 * Run with the marketing output flag to write committed images:
 *   MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-events.spec.ts \
 *     --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in the gitignored tmp dir, so the
 * spec is safe to run as part of the normal visual-audit sweep.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, type AuditResponder, setupAuditRoutes } from './audit-helpers';
import {
  dismissOnboarding,
  MARKETING_USER,
  MARKETING_VIEWPORT,
  marketingShot,
  NORTHWIND,
  OPAQUE_BACKDROP_COLOR,
} from './marketing-shots-helpers';

test.use(MARKETING_VIEWPORT);
test.describe.configure({ timeout: 90_000 });

// ---------------------------------------------------------------------------
// Shared Northwind world
// ---------------------------------------------------------------------------

const PROJECT_ID = NORTHWIND.projectId;
const BASE = `/api/projects/${PROJECT_ID}`;
const ts = (iso: string) => Date.parse(iso);
/** The fixtures' "now": relative times on the page are measured from here. */
const NOW = '2026-09-14T09:45:00Z';

const PROJECT = {
  id: PROJECT_ID,
  name: NORTHWIND.projectName,
  description: 'Payments ingestion, reconciliation, and the merchant-facing API.',
  repository: NORTHWIND.repository,
  defaultBranch: NORTHWIND.defaultBranch,
  userId: NORTHWIND.owner.id,
  installationId: 'inst-northwind',
  githubInstallationId: 'inst-northwind',
  repoProvider: 'github',
  status: 'active',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultWorkspaceProfile: null,
  defaultProvider: null,
  defaultLocation: null,
  agentDefaults: null,
  createdAt: '2026-01-05T00:00:00Z',
  updatedAt: '2026-09-14T00:00:00Z',
  summary: {
    activeWorkspaceCount: 2,
    activeSessionCount: 3,
    lastActivityAt: '2026-09-14T08:12:00Z',
    taskCountsByStatus: { in_progress: 2, completed: 41 },
    linkedWorkspaces: 2,
  },
};

const MEMBERS = [
  {
    userId: NORTHWIND.owner.id,
    role: 'owner',
    status: 'active',
    user: { ...NORTHWIND.owner, image: null },
  },
  ...NORTHWIND.members.map((m) => ({
    userId: m.id,
    role: 'member',
    status: 'active',
    user: { ...m, image: null },
  })),
];

const PROFILE_CODEX_HIGH = {
  id: 'profile-codex-high',
  projectId: PROJECT_ID,
  userId: NORTHWIND.owner.id,
  name: 'Codex 5.5 High',
  description: 'High-effort reasoning for dependency and security sweeps.',
  model: 'gpt-5.5-codex',
  agentType: 'openai-codex',
  effort: 'high',
  isDefault: false,
  isArchived: false,
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

const PROFILE_BRAINSTORMER = {
  id: 'profile-brainstormer',
  projectId: PROJECT_ID,
  userId: NORTHWIND.owner.id,
  name: 'Brainstormer',
  description: 'Explores options before committing to an approach.',
  model: 'claude-opus-4-6',
  agentType: 'claude-code',
  effort: 'medium',
  isDefault: false,
  isArchived: false,
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

const PROFILE_INVESTIGATOR = {
  id: 'profile-investigator',
  projectId: PROJECT_ID,
  userId: NORTHWIND.owner.id,
  name: 'Investigator',
  description: 'Focused incident and alert triage.',
  model: 'claude-sonnet-4-6',
  agentType: 'claude-code',
  effort: 'medium',
  isDefault: false,
  isArchived: false,
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

const AGENT_PROFILES = [PROFILE_CODEX_HIGH, PROFILE_BRAINSTORMER, PROFILE_INVESTIGATOR];

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

interface TriggerOverrides {
  id: string;
  name: string;
  sourceType: 'cron' | 'github' | 'webhook';
  [key: string]: unknown;
}

function trigger(overrides: TriggerOverrides) {
  return {
    projectId: PROJECT_ID,
    userId: NORTHWIND.owner.id,
    description: null,
    status: 'active',
    cronExpression: null,
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Run the task.',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextFireAt: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

const WEBHOOK_DATADOG_ID = 'trig-webhook-datadog';

const TRIGGERS = [
  trigger({
    id: 'trig-nightly-audit',
    name: 'Nightly dependency audit',
    description: 'Scans dependencies nightly and opens a PR for known CVEs.',
    sourceType: 'cron',
    status: 'active',
    cronExpression: '0 4 * * 1-5',
    cronTimezone: 'UTC',
    cronHumanReadable: 'Weekdays at 4:00 AM UTC',
    nextFireAt: '2026-09-15T04:00:00Z',
    lastTriggeredAt: '2026-09-13T04:00:00Z',
    triggerCount: 118,
    agentProfileId: PROFILE_CODEX_HIGH.id,
    promptTemplate:
      'Audit dependencies for {{project.name}} and open a PR for anything with a known CVE.',
    credentialAttribution: {
      multiplayerActive: true,
      hasPersonalWarning: true,
      checks: [
        {
          consumerKind: 'agent',
          consumerTarget: PROFILE_CODEX_HIGH.id,
          label: 'Codex 5.5 High',
          source: 'personal',
          owner: {
            id: NORTHWIND.owner.id,
            name: NORTHWIND.owner.name,
            email: NORTHWIND.owner.email,
          },
          projectCredential: null,
          fixHref: `/projects/${PROJECT_ID}/settings/credentials`,
          warning: "This agent path runs on Priya's personal OpenAI key.",
        },
      ],
    },
  }),
  trigger({
    id: 'trig-pci-bundle',
    name: 'Weekly PCI evidence bundle',
    description: 'Collects weekly audit evidence for compliance review.',
    sourceType: 'cron',
    status: 'paused',
    cronExpression: '0 7 * * 1',
    cronTimezone: 'UTC',
    cronHumanReadable: 'Mondays at 7:00 AM UTC',
    nextFireAt: '2026-09-21T07:00:00Z',
    lastTriggeredAt: '2026-09-07T07:00:00Z',
    triggerCount: 36,
    agentProfileId: PROFILE_INVESTIGATOR.id,
    promptTemplate: "Assemble this week's PCI evidence bundle for {{project.name}}.",
  }),
  trigger({
    id: 'trig-triage-issues',
    name: 'Issue triage',
    description: 'Labels and routes new GitHub issues automatically.',
    sourceType: 'github',
    status: 'active',
    triggerCount: 64,
    lastTriggeredAt: '2026-09-14T09:30:00Z',
    agentProfileId: PROFILE_BRAINSTORMER.id,
    promptTemplate: 'Triage this issue and suggest a next step: {{github.title}}',
    githubConfig: {
      eventType: 'issues',
      filters: { actions: ['opened'], ignoreActors: ['dependabot[bot]'] },
    },
  }),
  trigger({
    id: 'trig-review-prs',
    name: 'Review PRs labelled needs-review',
    description: 'Runs a focused review when a PR needs review.',
    sourceType: 'github',
    status: 'active',
    triggerCount: 27,
    lastTriggeredAt: '2026-09-13T18:05:00Z',
    agentProfileId: PROFILE_INVESTIGATOR.id,
    promptTemplate: 'Review PR #{{github.number}} for correctness and test coverage.',
    githubConfig: {
      eventType: 'pull_request',
      filters: { actions: ['labeled'], labels: ['needs-review'] },
    },
  }),
  trigger({
    id: WEBHOOK_DATADOG_ID,
    name: 'Datadog critical alert → investigate',
    description:
      'Starts an investigation session whenever Datadog reports a critical alert for the payments service.',
    sourceType: 'webhook',
    status: 'active',
    triggerCount: 19,
    lastTriggeredAt: '2026-09-14T08:12:00Z',
    agentProfileId: PROFILE_INVESTIGATOR.id,
    promptTemplate: 'Triage this untrusted alert: {{webhook.payload}}',
    webhookConfig: {
      sourceLabel: 'Datadog',
      filterMode: 'all',
      filters: [
        { path: 'alert.severity', operator: 'equals', value: 'critical' },
        { path: 'alert.service', operator: 'exists' },
      ],
      includedHeaders: ['x-datadog-event-type'],
      tokenLastFour: '7k2q',
      tokenCreatedAt: '2026-06-01T00:00:00Z',
      tokenRotatedAt: null,
    },
  }),
  trigger({
    id: 'trig-webhook-stripe',
    name: 'Stripe deploy failed',
    description:
      'Notifies an agent session when a Stripe deploy check fails in the payments integration.',
    sourceType: 'webhook',
    status: 'active',
    triggerCount: 5,
    lastTriggeredAt: '2026-09-11T13:47:00Z',
    agentProfileId: PROFILE_INVESTIGATOR.id,
    promptTemplate: 'Investigate this failed Stripe deploy check: {{webhook.payload}}',
    webhookConfig: {
      sourceLabel: 'Stripe',
      filterMode: 'any',
      filters: [{ path: 'type', operator: 'equals', value: 'deploy.check.failed' }],
      includedHeaders: [],
      tokenLastFour: '3xa9',
      tokenCreatedAt: '2026-05-14T00:00:00Z',
      tokenRotatedAt: '2026-08-01T00:00:00Z',
    },
  }),
];

const DATADOG_DELIVERIES = [
  {
    id: 'delivery-1',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'accepted',
    httpStatus: 202,
    bodyBytes: 842,
    executionId: 'exec-datadog-9',
    errorCode: null,
    receivedAt: '2026-09-14T08:12:00Z',
    processedAt: '2026-09-14T08:12:01Z',
  },
  {
    id: 'delivery-2',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'filtered',
    httpStatus: 202,
    bodyBytes: 210,
    executionId: null,
    errorCode: null,
    receivedAt: '2026-09-14T07:58:00Z',
    processedAt: '2026-09-14T07:58:00Z',
  },
  {
    id: 'delivery-3',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'accepted',
    httpStatus: 202,
    bodyBytes: 901,
    executionId: 'exec-datadog-8',
    errorCode: null,
    receivedAt: '2026-09-14T02:03:00Z',
    processedAt: '2026-09-14T02:03:01Z',
  },
  {
    id: 'delivery-4',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'duplicate',
    httpStatus: 202,
    bodyBytes: 901,
    executionId: null,
    errorCode: null,
    receivedAt: '2026-09-14T02:03:05Z',
    processedAt: '2026-09-14T02:03:05Z',
  },
  {
    id: 'delivery-5',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'still_running',
    httpStatus: 202,
    bodyBytes: 733,
    executionId: 'exec-datadog-7',
    errorCode: null,
    receivedAt: '2026-09-13T22:41:00Z',
    processedAt: '2026-09-13T22:41:01Z',
  },
  {
    id: 'delivery-6',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'concurrent_limit',
    httpStatus: 202,
    bodyBytes: 690,
    executionId: null,
    errorCode: null,
    receivedAt: '2026-09-13T22:40:40Z',
    processedAt: '2026-09-13T22:40:41Z',
  },
  {
    id: 'delivery-7',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'accepted',
    httpStatus: 202,
    bodyBytes: 1024,
    executionId: 'exec-datadog-6',
    errorCode: null,
    receivedAt: '2026-09-13T16:12:00Z',
    processedAt: '2026-09-13T16:12:02Z',
  },
  {
    id: 'delivery-8',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'rate_limited',
    httpStatus: 429,
    bodyBytes: 88,
    executionId: null,
    errorCode: 'rate_limited',
    receivedAt: '2026-09-13T09:05:00Z',
    processedAt: '2026-09-13T09:05:00Z',
  },
  {
    id: 'delivery-9',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'accepted',
    httpStatus: 202,
    bodyBytes: 812,
    executionId: 'exec-datadog-5',
    errorCode: null,
    receivedAt: '2026-09-12T20:31:00Z',
    processedAt: '2026-09-12T20:31:01Z',
  },
  {
    id: 'delivery-10',
    triggerId: WEBHOOK_DATADOG_ID,
    outcome: 'configuration_error',
    httpStatus: 503,
    bodyBytes: 150,
    executionId: null,
    errorCode: 'missing_agent_profile',
    receivedAt: '2026-09-12T05:00:00Z',
    processedAt: '2026-09-12T05:00:00Z',
  },
];

const DATADOG_EXECUTIONS = [
  {
    id: 'exec-datadog-9',
    triggerId: WEBHOOK_DATADOG_ID,
    projectId: PROJECT_ID,
    status: 'completed',
    skipReason: null,
    taskId: 'task-datadog-9',
    eventType: 'webhook',
    renderedPrompt:
      'Triage this untrusted alert: {"alert":{"severity":"critical","service":"payments-api"}}',
    errorMessage: null,
    scheduledAt: '2026-09-14T08:12:00Z',
    startedAt: '2026-09-14T08:12:03Z',
    completedAt: '2026-09-14T08:21:40Z',
    sequenceNumber: 19,
    createdAt: '2026-09-14T08:12:00Z',
  },
  {
    id: 'exec-datadog-8',
    triggerId: WEBHOOK_DATADOG_ID,
    projectId: PROJECT_ID,
    status: 'completed',
    skipReason: null,
    taskId: 'task-datadog-8',
    eventType: 'webhook',
    renderedPrompt:
      'Triage this untrusted alert: {"alert":{"severity":"critical","service":"payments-api"}}',
    errorMessage: null,
    scheduledAt: '2026-09-14T02:03:00Z',
    startedAt: '2026-09-14T02:03:04Z',
    completedAt: '2026-09-14T02:11:12Z',
    sequenceNumber: 18,
    createdAt: '2026-09-14T02:03:00Z',
  },
  {
    id: 'exec-datadog-7',
    triggerId: WEBHOOK_DATADOG_ID,
    projectId: PROJECT_ID,
    status: 'running',
    skipReason: null,
    taskId: 'task-datadog-7',
    eventType: 'webhook',
    renderedPrompt:
      'Triage this untrusted alert: {"alert":{"severity":"critical","service":"payments-api"}}',
    errorMessage: null,
    scheduledAt: '2026-09-13T22:41:00Z',
    startedAt: '2026-09-13T22:41:02Z',
    completedAt: null,
    sequenceNumber: 17,
    createdAt: '2026-09-13T22:41:00Z',
  },
  {
    id: 'exec-datadog-6',
    triggerId: WEBHOOK_DATADOG_ID,
    projectId: PROJECT_ID,
    status: 'completed',
    skipReason: null,
    taskId: 'task-datadog-6',
    eventType: 'webhook',
    renderedPrompt:
      'Triage this untrusted alert: {"alert":{"severity":"critical","service":"payments-api"}}',
    errorMessage: null,
    scheduledAt: '2026-09-13T16:12:00Z',
    startedAt: '2026-09-13T16:12:05Z',
    completedAt: '2026-09-13T16:19:30Z',
    sequenceNumber: 16,
    createdAt: '2026-09-13T16:12:00Z',
  },
  {
    id: 'exec-datadog-5',
    triggerId: WEBHOOK_DATADOG_ID,
    projectId: PROJECT_ID,
    status: 'failed',
    skipReason: null,
    taskId: 'task-datadog-5',
    eventType: 'webhook',
    renderedPrompt:
      'Triage this untrusted alert: {"alert":{"severity":"critical","service":"payments-api"}}',
    errorMessage: 'Workspace provisioning failed: ETIMEDOUT contacting the compute provider.',
    scheduledAt: '2026-09-12T20:31:00Z',
    startedAt: '2026-09-12T20:31:04Z',
    completedAt: '2026-09-12T20:32:10Z',
    sequenceNumber: 15,
    createdAt: '2026-09-12T20:31:00Z',
  },
];

const ROTATED_CREDENTIAL = {
  endpointUrl: 'https://api.northwindlabs.dev/api/webhooks/ingest',
  token: `sam_wh_${'7f3ac91b2e6d4508fa1c9b3e7d2f4a8c1b6e9d3f5a2c7b8e1d4f6a9c3b5e8d2f'}`,
  headerName: 'Authorization' as const,
};

// ---------------------------------------------------------------------------
// Project Events: subscriptions, schedules, standing watches, channels
// ---------------------------------------------------------------------------

const SESSION_LEDGER = '01K9LDGRMIGR8TWNQXCVD4H7A2';
const TASK_LEDGER = '01K9LDGRTASKW8TWNQXCVD4H8B';
const SESSION_STRIPE_ROTATION = '01K9STRPROTATNW8TWQXCVD41C';
const TASK_STRIPE_ROTATION = '01K9STRPTASKNW8TWQXCVD42BD';
const SESSION_PCI_BUNDLE = '01K9PCIBNDLEW8TWNQXCVD43C9';
const TASK_PCI_BUNDLE = '01K9PCIBNDLTASKW8TWNQXCV44E';

/** Subscription row with the bookkeeping fields every fixture shares. */
function subscription<T extends object>(fixture: T) {
  return {
    projectId: PROJECT_ID,
    contractVersion: 1,
    matchKeyCount: 1,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    ...fixture,
  };
}

const SUBSCRIPTIONS = [
  subscription({
    id: 'sub-ledger-pr',
    owner: { type: 'agent', id: SESSION_LEDGER, name: 'Migrate ledger to double-entry schema' },
    idempotencyKey: 'idem-sub-ledger-pr',
    filter: {
      version: 1,
      source: 'github',
      eventType: 'pull_request',
      subjectId: 'northwind-labs/payments-api#482',
    },
    filterFingerprint: 'fp-ledger-pr',
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: SESSION_LEDGER, taskId: TASK_LEDGER },
    },
    state: 'active',
    reason: 'Watch PR #482 (ledger migration) for review activity',
    createdAt: ts('2026-09-10T09:00:00Z'),
    updatedAt: ts('2026-09-14T08:00:00Z'),
    expiresAt: ts('2026-09-24T09:00:00Z'),
    lastMatchedAt: ts('2026-09-14T08:00:00Z'),
  }),
  subscription({
    id: 'sub-stripe-webhook',
    owner: {
      type: 'agent',
      id: SESSION_STRIPE_ROTATION,
      name: 'Stripe webhook signature rotation',
    },
    idempotencyKey: 'idem-sub-stripe',
    filter: {
      version: 1,
      source: 'webhook',
      eventType: 'webhook.accepted',
      subjectType: 'webhook_trigger',
      subjectId: 'trig-webhook-stripe',
    },
    filterFingerprint: 'fp-stripe',
    deliveryPreference: {
      requested: 'runtime_steer',
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: SESSION_STRIPE_ROTATION, taskId: TASK_STRIPE_ROTATION },
    },
    state: 'active',
    reason: 'Resume signature rotation when Stripe redelivers',
    createdAt: ts('2026-09-11T13:00:00Z'),
    updatedAt: ts('2026-09-11T13:47:00Z'),
    expiresAt: ts('2026-09-18T13:00:00Z'),
    lastMatchedAt: ts('2026-09-11T13:47:00Z'),
  }),
  subscription({
    id: 'sub-flaky-tests',
    owner: { type: 'standing_watch', id: 'watch-flaky-tests', name: 'Flaky test triage' },
    idempotencyKey: 'idem-sub-flaky',
    filter: { version: 1, source: 'github', eventType: 'check_suite.completed' },
    filterFingerprint: 'fp-flaky',
    deliveryPreference: { requested: 'spawn_task', resolved: 'spawn_task', target: {} },
    state: 'active',
    reason: 'Flaky test triage',
    createdAt: ts('2026-08-20T10:00:00Z'),
    updatedAt: ts('2026-09-13T22:00:00Z'),
    expiresAt: null,
    lastMatchedAt: ts('2026-09-13T22:00:00Z'),
  }),
  subscription({
    id: 'sub-marcus-comments',
    owner: { type: 'human', id: 'user-marcus', name: 'Marcus Chen' },
    idempotencyKey: 'idem-sub-marcus',
    filter: { version: 1, source: 'github', eventType: 'issue_comment.created' },
    filterFingerprint: 'fp-marcus',
    deliveryPreference: { requested: 'record_only', resolved: 'record_only', target: {} },
    state: 'active',
    reason: 'Keep a record of issue comment activity',
    createdAt: ts('2026-09-05T12:00:00Z'),
    updatedAt: ts('2026-09-12T09:00:00Z'),
    expiresAt: ts('2026-10-05T12:00:00Z'),
    lastMatchedAt: ts('2026-09-12T09:00:00Z'),
  }),
  subscription({
    id: 'sub-pci-bundle',
    owner: { type: 'agent', id: SESSION_PCI_BUNDLE, name: 'Weekly PCI evidence bundle' },
    idempotencyKey: 'idem-sub-pci',
    filter: {
      version: 1,
      source: 'cron',
      eventType: 'trigger.execution_completed',
      subjectId: 'trig-pci-bundle',
    },
    filterFingerprint: 'fp-pci',
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: SESSION_PCI_BUNDLE, taskId: TASK_PCI_BUNDLE },
    },
    state: 'expired',
    reason: 'Notify the compliance session when the weekly bundle completes',
    createdAt: ts('2026-08-31T07:00:00Z'),
    updatedAt: ts('2026-09-07T07:05:00Z'),
    expiresAt: ts('2026-09-08T07:00:00Z'),
    lastMatchedAt: ts('2026-09-07T07:05:00Z'),
  }),
  subscription({
    id: 'sub-old-deploy-watch',
    owner: { type: 'human', id: NORTHWIND.owner.id, name: NORTHWIND.owner.name },
    idempotencyKey: 'idem-sub-old-deploy',
    filter: {
      version: 1,
      source: 'webhook',
      eventType: 'webhook.accepted',
      subjectId: 'trig-old-deploy',
    },
    filterFingerprint: 'fp-old-deploy',
    deliveryPreference: { requested: 'record_only', resolved: 'record_only', target: {} },
    state: 'cancelled',
    reason: 'Old deploy webhook watch (superseded)',
    createdAt: ts('2026-07-01T09:00:00Z'),
    updatedAt: ts('2026-09-01T09:00:00Z'),
    expiresAt: ts('2026-10-01T09:00:00Z'),
    cancelledAt: ts('2026-09-01T09:00:00Z'),
    cancelledBy: { type: 'human', id: NORTHWIND.owner.id, name: NORTHWIND.owner.name },
    cancelReason: 'Replaced by the Datadog webhook trigger.',
    lastMatchedAt: ts('2026-08-15T09:00:00Z'),
  }),
];

const LEDGER_DELIVERIES = [
  {
    id: 'del-1',
    state: 'acked',
    deliveryChannel: 'prompt_queue',
    deliveredVia: 'prompt_queue',
    requestedDelivery: 'existing_session_prompt',
    resolvedDelivery: 'queued_for_prompt_delivery',
    createdAt: ts('2026-09-14T08:00:01Z'),
    updatedAt: ts('2026-09-14T08:00:05Z'),
    deliveredAt: ts('2026-09-14T08:00:02Z'),
    ackedAt: ts('2026-09-14T08:00:05Z'),
    terminalAt: ts('2026-09-14T08:00:05Z'),
    terminalReason: null,
  },
  {
    id: 'del-2',
    state: 'delivered',
    deliveryChannel: 'prompt_queue',
    deliveredVia: 'prompt_queue',
    requestedDelivery: 'existing_session_prompt',
    resolvedDelivery: 'queued_for_prompt_delivery',
    createdAt: ts('2026-09-12T10:15:00Z'),
    updatedAt: ts('2026-09-12T10:15:04Z'),
    deliveredAt: ts('2026-09-12T10:15:04Z'),
    ackedAt: null,
    terminalAt: null,
    terminalReason: null,
  },
  {
    id: 'del-3',
    state: 'failed',
    deliveryChannel: 'prompt_queue',
    deliveredVia: null,
    requestedDelivery: 'existing_session_prompt',
    resolvedDelivery: 'queued_for_prompt_delivery',
    createdAt: ts('2026-09-11T16:40:00Z'),
    updatedAt: ts('2026-09-11T16:41:00Z'),
    deliveredAt: null,
    ackedAt: null,
    terminalAt: ts('2026-09-11T16:41:00Z'),
    terminalReason: 'Target session was stopped before delivery completed.',
  },
];

const SCHEDULES = [
  {
    id: 'sched-payment-retry',
    projectId: PROJECT_ID,
    creatorUserId: 'user-elena',
    creatorChatSessionId: null,
    reason: 'Re-run the payment-retry suite once CI settles',
    action: {
      kind: 'message_session',
      sessionId: '01K9PAYRETRYW8TWNQXCVD45E2F',
      prompt: 'Re-run the payment-retry suite once CI settles.',
    },
    state: 'pending',
    dueAt: ts('2026-09-14T18:00:00Z'),
    displayTimezone: 'UTC',
    expiresAt: ts('2026-09-14T19:00:00Z'),
    version: 1,
    idempotencyKey: 'idem-sched-payment-retry',
    createdAt: ts('2026-09-14T09:00:00Z'),
    updatedAt: ts('2026-09-14T09:00:00Z'),
    nextAttemptAt: ts('2026-09-14T18:00:00Z'),
    attemptCount: 0,
    lastError: null,
    eventId: null,
    deliveryId: null,
    resultTaskId: null,
    resultSessionId: null,
    watchId: null,
    sourceEventId: null,
  },
  {
    id: 'sched-nightly-audit-followup',
    projectId: PROJECT_ID,
    creatorUserId: NORTHWIND.owner.id,
    creatorChatSessionId: null,
    reason: 'Nightly dependency audit follow-up',
    action: {
      kind: 'start_session',
      prompt: 'Re-run the nightly dependency audit and file any newly disclosed CVEs.',
      agentProfileId: PROFILE_CODEX_HIGH.id,
      skillId: null,
    },
    state: 'admitted',
    dueAt: ts('2026-09-14T04:05:00Z'),
    displayTimezone: 'UTC',
    expiresAt: ts('2026-09-14T05:05:00Z'),
    version: 2,
    idempotencyKey: 'idem-sched-nightly',
    createdAt: ts('2026-09-13T20:00:00Z'),
    updatedAt: ts('2026-09-14T04:06:00Z'),
    nextAttemptAt: null,
    attemptCount: 1,
    lastError: null,
    eventId: null,
    deliveryId: 'delivery-nightly-followup',
    resultTaskId: 'task-nightly-audit-119',
    resultSessionId: 'session-nightly-audit-119',
    watchId: null,
    sourceEventId: null,
    execution: {
      kind: 'start_session',
      status: 'completed',
      checkedAt: ts('2026-09-14T04:20:00Z'),
      deliveryId: 'delivery-nightly-followup',
      taskId: 'task-nightly-audit-119',
      sessionId: 'session-nightly-audit-119',
      receiptState: 'submitted',
      error: null,
      retrySubmissionAllowed: false,
      submissionDeadline: ts('2026-09-14T05:05:00Z'),
    },
  },
  {
    id: 'sched-pci-confirm',
    projectId: PROJECT_ID,
    creatorUserId: 'user-tomas',
    creatorChatSessionId: null,
    reason: 'Confirm the PCI evidence bundle reached compliance',
    action: {
      kind: 'message_session',
      sessionId: SESSION_PCI_BUNDLE,
      prompt: "Confirm the compliance inbox received this week's PCI evidence bundle.",
    },
    state: 'ambiguous',
    dueAt: ts('2026-09-13T20:00:00Z'),
    displayTimezone: 'UTC',
    expiresAt: ts('2026-09-13T21:00:00Z'),
    version: 1,
    idempotencyKey: 'idem-sched-pci-confirm',
    createdAt: ts('2026-09-13T10:00:00Z'),
    updatedAt: ts('2026-09-13T20:05:00Z'),
    nextAttemptAt: null,
    attemptCount: 1,
    lastError: null,
    eventId: null,
    deliveryId: null,
    resultTaskId: null,
    resultSessionId: null,
    watchId: null,
    sourceEventId: null,
    execution: {
      kind: 'message_session',
      status: 'unavailable',
      checkedAt: ts('2026-09-13T20:10:00Z'),
      deliveryId: null,
      taskId: null,
      sessionId: null,
      receiptState: 'pending',
      error: 'No submission receipt was found before the delivery deadline.',
      retrySubmissionAllowed: true,
      submissionDeadline: ts('2026-09-14T20:00:00Z'),
    },
  },
];

/** Runs the flaky-test watch started: one-time actions carrying its watchId. */
function watchRun(id: string, at: string, sequence: number) {
  return {
    id,
    projectId: PROJECT_ID,
    creatorUserId: 'user-aisha',
    creatorChatSessionId: null,
    reason: 'Flaky test triage',
    action: {
      kind: 'start_session',
      prompt:
        'If this check suite failed, decide whether the failure is flaky or a real regression.',
      agentProfileId: PROFILE_INVESTIGATOR.id,
      skillId: 'skill-flaky-test-triage',
    },
    state: 'admitted',
    dueAt: ts(at),
    displayTimezone: 'UTC',
    expiresAt: ts(at) + 3_600_000,
    version: 2,
    idempotencyKey: `idem-${id}`,
    createdAt: ts(at),
    updatedAt: ts(at) + 60_000,
    nextAttemptAt: null,
    attemptCount: 1,
    lastError: null,
    eventId: `evt-ci-${sequence}`,
    deliveryId: null,
    resultTaskId: `task-flaky-${sequence}`,
    resultSessionId: `session-flaky-${sequence}`,
    watchId: 'watch-flaky-tests',
    sourceEventId: `evt-ci-${sequence}`,
  };
}

const WATCH_RUNS = [
  watchRun('sched-flaky-7', '2026-09-13T22:00:00Z', 7),
  watchRun('sched-flaky-6', '2026-09-12T15:30:00Z', 6),
  watchRun('sched-flaky-5', '2026-09-11T09:10:00Z', 5),
];

const WATCHES = [
  {
    id: 'watch-flaky-tests',
    projectId: PROJECT_ID,
    creatorUserId: 'user-aisha',
    reason: 'Flaky test triage',
    filter: { version: 1, source: 'github', eventType: 'check_suite.completed' },
    action: {
      kind: 'start_session',
      prompt:
        'If this check suite failed, decide whether the failure is flaky or a real regression.',
      agentProfileId: PROFILE_INVESTIGATOR.id,
      skillId: 'skill-flaky-test-triage',
    },
    state: 'active',
    version: 3,
    idempotencyKey: 'idem-watch-flaky',
    cooldownMs: 30 * 60_000,
    maxConcurrent: 1,
    maxExecutions: 20,
    executionCount: 7,
    nextEligibleAt: ts('2026-09-14T09:00:00Z'),
    subscriptionId: 'sub-flaky-tests',
    createdAt: ts('2026-08-20T10:00:00Z'),
    updatedAt: ts('2026-09-13T22:00:00Z'),
    lastError: null,
  },
  {
    id: 'watch-security-labels',
    projectId: PROJECT_ID,
    creatorUserId: NORTHWIND.owner.id,
    reason: 'Security-labelled issue watch',
    filter: { version: 1, source: 'github', eventType: 'issues.labeled', subjectId: 'security' },
    action: {
      kind: 'start_session',
      prompt: 'Assess this security-labelled issue and draft a remediation plan.',
      agentProfileId: PROFILE_BRAINSTORMER.id,
      skillId: null,
    },
    state: 'paused',
    version: 2,
    idempotencyKey: 'idem-watch-security',
    cooldownMs: 60 * 60_000,
    maxConcurrent: 1,
    maxExecutions: 10,
    executionCount: 3,
    nextEligibleAt: ts('2026-09-20T00:00:00Z'),
    subscriptionId: 'sub-security-labels',
    createdAt: ts('2026-07-15T10:00:00Z'),
    updatedAt: ts('2026-09-05T11:00:00Z'),
    lastError: null,
  },
];

const CHANNELS = [
  {
    id: 'chan-release-train',
    name: 'release-train',
    lifetimeCount: 58,
    lastPublishedAt: ts('2026-09-14T09:05:00Z'),
  },
  {
    id: 'chan-incidents',
    name: 'incidents',
    lifetimeCount: 21,
    lastPublishedAt: ts('2026-09-13T22:00:00Z'),
  },
  {
    id: 'chan-ledger-migration',
    name: 'ledger-migration',
    lifetimeCount: 34,
    lastPublishedAt: ts('2026-09-14T08:05:00Z'),
  },
];

const RELEASE_TRAIN_HISTORY = {
  channel: CHANNELS[0],
  events: [
    {
      sequence: 58,
      event: {
        id: 'evt-58',
        receivedAt: ts('2026-09-14T09:05:00Z'),
        display: { title: 'v2026.37.0 promoted to canary', untrusted: true },
        metadata: {
          message:
            'Migrate ledger to double-entry schema session published: staging soak passed, promoting build 2026.37.0 to canary (5%).',
        },
      },
    },
    {
      sequence: 57,
      event: {
        id: 'evt-57',
        receivedAt: ts('2026-09-14T08:40:00Z'),
        display: { title: 'Staging soak started', untrusted: true },
        metadata: {
          message:
            'Nightly dependency audit session published: staging deploy is green, starting a 30 minute soak before canary.',
        },
      },
    },
    {
      sequence: 56,
      event: {
        id: 'evt-56',
        receivedAt: ts('2026-09-13T21:15:00Z'),
        display: { title: 'Rollback: v2026.36.2', untrusted: true },
        metadata: {
          message:
            'Stripe webhook signature rotation session published: reverted v2026.36.2 after elevated 5xx on /v1/charges; root cause under investigation.',
        },
      },
    },
    {
      sequence: 55,
      event: {
        id: 'evt-55',
        receivedAt: ts('2026-09-13T20:50:00Z'),
        display: { title: 'v2026.36.2 deployed to production', untrusted: true },
        metadata: {
          message:
            'Migrate ledger to double-entry schema session published: production deploy complete, watching error budget.',
        },
      },
    },
  ],
  cursor: 'release-train-cursor-2',
  hasMore: true,
  watermark: 58,
  retentionGap: false,
};

// ---------------------------------------------------------------------------
// Lookups and per-trigger runs
// ---------------------------------------------------------------------------

/** Chats the automations message or started, so pages show titles instead of IDs. */
const CHAT_SESSIONS = [
  { id: SESSION_LEDGER, topic: 'Migrate ledger to double-entry schema', status: 'active' },
  { id: SESSION_STRIPE_ROTATION, topic: 'Stripe webhook signature rotation', status: 'active' },
  { id: SESSION_PCI_BUNDLE, topic: 'Weekly PCI evidence bundle', status: 'active' },
  { id: '01K9PAYRETRYW8TWNQXCVD45E2F', topic: 'Payment retry suite', status: 'active' },
];

const SKILLS = [
  {
    id: 'skill-flaky-test-triage',
    projectId: PROJECT_ID,
    name: 'Flaky test triage',
    description: 'Re-runs a failing suite and compares it with recent history.',
  },
];

/** Recent runs per trigger; triggers not listed have not run in this window. */
const NIGHTLY_EXECUTIONS = [
  {
    ...DATADOG_EXECUTIONS[0],
    id: 'exec-nightly-118',
    triggerId: 'trig-nightly-audit',
    taskId: 'task-nightly-118',
    eventType: 'cron',
    renderedPrompt: null,
    scheduledAt: '2026-09-14T04:00:00Z',
    startedAt: '2026-09-14T04:00:02Z',
    completedAt: '2026-09-14T04:26:40Z',
    sequenceNumber: 118,
    createdAt: '2026-09-14T04:00:00Z',
  },
];
const EXECUTIONS_BY_TRIGGER: Record<string, unknown[]> = {
  [WEBHOOK_DATADOG_ID]: DATADOG_EXECUTIONS,
  'trig-nightly-audit': NIGHTLY_EXECUTIONS,
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function commonHandler(path: string, respond: AuditResponder): Promise<void> | undefined {
  if (path.includes('/api/auth/')) return respond(200, MARKETING_USER);
  if (path === '/api/projects') return respond(200, { projects: [PROJECT], nextCursor: null });
  if (path === `/api/projects/${PROJECT_ID}`) return respond(200, PROJECT);
  if (path === `${BASE}/members`)
    return respond(200, { members: MEMBERS, inviteLinks: [], accessRequests: [] });
  if (path === `${BASE}/agent-profiles`) return respond(200, { items: AGENT_PROFILES });
  if (path.startsWith('/api/notifications'))
    return respond(200, { notifications: [], unreadCount: 0 });
  if (path === '/api/github/installations') return respond(200, []);
  if (path === '/api/credentials') return respond(200, []);
  if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
  if (path === '/api/agents') return respond(200, { agents: [] });
  if (path === '/api/nodes') return respond(200, []);
  if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
  if (path === '/api/chats' || path === '/api/chats/recent')
    return respond(200, { sessions: [], total: 0, totalActive: 0, groups: [] });
  if (path === '/api/account-map')
    return respond(200, {
      projects: [],
      nodes: [],
      workspaces: [],
      sessions: [],
      tasks: [],
      relationships: [],
    });
  if (path === '/api/trial-status') return respond(200, { available: false });
  if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
  if (path === '/api/report-issue/config') return respond(200, { enabled: false });
  return undefined;
}

function triggerHandler(
  path: string,
  respond: AuditResponder,
  route: Route
): Promise<void> | undefined {
  const method = route.request().method();

  if (path === `${BASE}/triggers`) return respond(200, { triggers: TRIGGERS });

  const runsMatch = path.match(new RegExp(`^${BASE}/triggers/([^/]+)/executions`));
  if (runsMatch) {
    return respond(200, {
      executions: EXECUTIONS_BY_TRIGGER[runsMatch[1] ?? ''] ?? [],
      nextCursor: null,
    });
  }
  if (new RegExp(`^${BASE}/triggers/[^/]+/webhook/deliveries$`).test(path)) {
    return respond(200, { deliveries: DATADOG_DELIVERIES, nextCursor: null });
  }
  if (new RegExp(`^${BASE}/triggers/[^/]+/webhook/rotate$`).test(path) && method === 'POST') {
    return respond(200, { webhookCredential: ROTATED_CREDENTIAL });
  }
  const detailMatch = path.match(new RegExp(`^${BASE}/triggers/([^/]+)$`));
  if (detailMatch) {
    const found = TRIGGERS.find((t) => t.id === detailMatch[1]);
    return respond(found ? 200 : 404, found ?? { error: 'not_found' });
  }
  return undefined;
}

function eventsHandler(
  path: string,
  respond: AuditResponder,
  route: Route
): Promise<void> | undefined {
  if (path === `${BASE}/event-subscriptions`) {
    // The API filters by state; so must the mock, or ended waits count as waiting.
    const state = new URL(route.request().url()).searchParams.get('state') ?? 'any';
    const subscriptions =
      state === 'any' ? SUBSCRIPTIONS : SUBSCRIPTIONS.filter((item) => item.state === state);
    return respond(200, { subscriptions, hasMore: false, limit: 25 });
  }
  if (/\/event-subscriptions\/[^/]+\/deliveries$/.test(path))
    return respond(200, { deliveries: LEDGER_DELIVERIES, hasMore: false });
  if (path === `${BASE}/schedules`)
    return respond(200, { schedules: [...SCHEDULES, ...WATCH_RUNS], nextCursor: null });
  const scheduleMatch = path.match(new RegExp(`^${BASE}/schedules/([^/]+)$`));
  if (scheduleMatch) {
    const found = [...SCHEDULES, ...WATCH_RUNS].find((item) => item.id === scheduleMatch[1]);
    return respond(found ? 200 : 404, found ? { schedule: found } : { error: 'not_found' });
  }
  if (path === `${BASE}/standing-watches`)
    return respond(200, { watches: WATCHES, nextCursor: null });
  const watchMatch = path.match(new RegExp(`^${BASE}/standing-watches/([^/]+)$`));
  if (watchMatch) {
    const found = WATCHES.find((item) => item.id === watchMatch[1]);
    return respond(found ? 200 : 404, found ? { watch: found } : { error: 'not_found' });
  }
  if (path === `${BASE}/sessions`)
    return respond(200, { sessions: CHAT_SESSIONS, total: CHAT_SESSIONS.length });
  if (path === `${BASE}/skills`) return respond(200, { items: SKILLS });
  if (path === `${BASE}/event-channels`)
    return respond(200, { channels: CHANNELS, nextCursor: null });
  if (/\/event-channels\/[^/]+\/history$/.test(path)) return respond(200, RELEASE_TRAIN_HISTORY);
  return undefined;
}

async function setupMocks(
  page: Page,
  handler: (path: string, respond: AuditResponder, route: Route) => Promise<void> | undefined
) {
  await dismissOnboarding(page);
  await setupAuditRoutes(
    page,
    (path, respond, route) => handler(path, respond, route) ?? commonHandler(path, respond)
  );
}

function logPageErrors(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[console.error] ${msg.text()}`);
  });
  page.on('requestfailed', (request) => {
    console.log(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
}

async function assertNoCrash(page: Page) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// A. The Automation overview
// ---------------------------------------------------------------------------

/** Every Automation view reads triggers and the eventing lists together. */
function automationHandler(path: string, respond: AuditResponder, route: Route) {
  return triggerHandler(path, respond, route) ?? eventsHandler(path, respond, route);
}

async function openAutomation(page: Page, path: string) {
  logPageErrors(page);
  await page.clock.setFixedTime(NOW);
  await setupMocks(page, automationHandler);
  await page.goto(`/projects/${PROJECT_ID}/automation${path}`);
}

test('sam-triggers-sources', async ({ page }) => {
  // Taller than MARKETING_VIEWPORT so the overview's two columns fit in one frame.
  await page.setViewportSize({ width: 1440, height: 1180 });
  await openAutomation(page, '');
  await expect(page.getByRole('heading', { name: 'Automation', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your automations' })).toBeVisible();
  await expect(page.getByText('Nightly dependency audit').first()).toBeVisible();
  await expect(page.getByText('Datadog critical alert → investigate').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  await marketingShot(page, 'sam-triggers-sources');
});

// ---------------------------------------------------------------------------
// B + C. A webhook automation's page: its calls, and the one-time credential
// shown when the token is replaced.
// ---------------------------------------------------------------------------

test('sam-webhook-deliveries, sam-webhook-credential', async ({ page }) => {
  // Tall enough that the whole "Calls received" section renders inside the scroll area.
  await page.setViewportSize({ width: 1440, height: 1500 });
  await openAutomation(page, `/trigger/${WEBHOOK_DATADOG_ID}`);
  await expect(
    page.getByRole('heading', { name: /Datadog critical alert/, level: 1 })
  ).toBeVisible();
  await expect(page.getByLabel('Webhook connection').getByText('••••7k2q')).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  // The audit trail itself: every call, what SAM did with it, and the run it started or skipped.
  const calls = page.getByRole('region', { name: 'Calls received' });
  await expect(calls.getByText('Ignored: did not match the filters').first()).toBeVisible();
  await expect(calls.getByText('Skipped: the previous run was still going').first()).toBeVisible();
  const section = calls.locator('xpath=..');
  await section.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await marketingShot(page, 'sam-webhook-deliveries', section);

  // Replace the token to reveal the one-time credential dialog.
  await page.getByRole('button', { name: 'Get a new token' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace token' }).click();
  const dialog = page.getByRole('dialog', { name: /save your webhook credential/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ROTATED_CREDENTIAL.endpointUrl, { exact: true })).toBeVisible();
  await expect(dialog.getByText(ROTATED_CREDENTIAL.token, { exact: true })).toBeVisible();

  await page.addStyleTag({
    content: `.glass-backdrop-dim{background:${OPAQUE_BACKDROP_COLOR} !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`,
  });
  await marketingShot(page, 'sam-webhook-credential', dialog);
});

// ---------------------------------------------------------------------------
// D, E, F. What agents are waiting for, a watch, and agent channels.
// ---------------------------------------------------------------------------

test('sam-events-subscriptions', async ({ page }) => {
  await openAutomation(page, '/behind');
  await expect(page.getByRole('heading', { name: 'Behind the scenes', level: 1 })).toBeVisible();
  await expect(
    page.getByText('Migrate ledger to double-entry schema is waiting for', { exact: false })
  ).toBeVisible();
  await assertNoCrash(page);

  // Open one wait's details: the exact filter, both delivery modes, and what was delivered.
  const ledger = page.getByRole('region', { name: /^Migrate ledger to double-entry schema waits/ });
  await ledger.getByText('Details', { exact: true }).click();
  await expect(ledger.getByText('Read by the agent')).toBeVisible();
  await assertNoOverflow(page);
  await marketingShot(page, 'sam-events-subscriptions');
});

test('sam-events-watches', async ({ page }) => {
  await openAutomation(page, '/watch/watch-flaky-tests');
  await expect(page.getByRole('heading', { name: 'Flaky test triage', level: 1 })).toBeVisible();
  await expect(page.getByText('7 of 20 runs used', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent runs' })).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);
  await marketingShot(page, 'sam-events-watches');
});

test('sam-events-channels', async ({ page }) => {
  await openAutomation(page, '/behind?tab=channels');
  await expect(page.getByRole('radio', { name: 'Channels' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.getByRole('button', { name: /release-train/ }).click();
  await expect(page.getByText('v2026.37.0 promoted to canary', { exact: false })).toBeVisible();
  await expect(page.getByText('incidents', { exact: false }).first()).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);
  await marketingShot(page, 'sam-events-channels');
});
