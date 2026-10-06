/**
 * Marketing screenshots — Agent Context (overview/memory/policies/actions) and
 * two project-chat composer surfaces (new-chat + a live tool stream). Renders
 * the REAL production components with mocked API data. Companion to
 * `marketing-shots-platform.spec.ts` / `marketing-shots-events.spec.ts`; see
 * `marketing-shots-helpers.ts` for the shared fictional world (Northwind Labs
 * / Payments API), viewport, and capture helper.
 *
 * Run with the marketing output flag to write committed images:
 *   cd apps/web && MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-context.spec.ts --project="Desktop (1280x800)"
 *   cd apps/web && MARKETING_SHOTS=1 MARKETING_THEME=light PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-context.spec.ts --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in `.codex/tmp/playwright-screenshots/`.
 *
 * Covered surfaces:
 *   A. sam-context-overview  — Agent Context overview (summary cards + context stack)
 *   B. sam-context-memory    — Memory tab, 4 entities expanded to show observations
 *   C. sam-context-policies  — Policies tab, 12 durable instruction-only policies
 *   D. sam-context-actions   — Agent actions tab, timestamped activity feed
 *   E. sam-chat-new-session  — project chat "new chat" composer + profile selector
 *   F. sam-chat-tool-stream  — live session mid-task with a rich tool stream
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';
import {
  AGENT_PROFILES,
  dismissOnboarding,
  MARKETING_USER,
  MARKETING_VIEWPORT,
  marketingShot,
  NORTHWIND,
} from './marketing-shots-helpers';

test.use(MARKETING_VIEWPORT);
test.describe.configure({ timeout: 90_000 });

const PROJECT_ID = NORTHWIND.projectId;

async function respond(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: NORTHWIND.projectName,
  repository: NORTHWIND.repository,
  defaultBranch: NORTHWIND.defaultBranch,
  userId: NORTHWIND.owner.id,
  githubInstallationId: 'inst-northwind',
  defaultVmSize: 'medium',
  defaultAgentType: 'claude-code',
  defaultProvider: 'hetzner',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-09-14T09:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Agent Context fixtures — Memory (Knowledge)
// ---------------------------------------------------------------------------

const MEANINGFUL_ENTITIES = [
  {
    id: 'ent-architecture',
    name: 'Architecture',
    entityType: 'context',
    description: 'System architecture and structural conventions for the payments service.',
  },
  {
    id: 'ent-code-quality',
    name: 'Code Quality',
    entityType: 'preference',
    description: 'Coding standards and review expectations for this repo.',
  },
  {
    id: 'ent-user-preferences',
    name: 'User Preferences',
    entityType: 'preference',
    description: "Individual working preferences for the project's owner.",
  },
  {
    id: 'ent-payments-domain',
    name: 'Payments Domain',
    entityType: 'expertise',
    description: 'Domain knowledge specific to refunds, the ledger, and PCI scope.',
  },
];

const OBSERVATIONS_BY_ENTITY: Record<
  string,
  Array<{
    id: string;
    entityId: string;
    content: string;
    confidence: number;
    sourceType: 'explicit' | 'inferred';
    sourceSessionId: string | null;
    createdAt: number;
    lastConfirmedAt: number;
    supersededBy: null;
    isActive: true;
  }>
> = {
  'ent-architecture': [
    {
      id: 'obs-1',
      entityId: 'ent-architecture',
      content: 'Ledger writes must be double-entry; never update balances in place.',
      confidence: 0.97,
      sourceType: 'explicit',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-02T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-12T10:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
    {
      id: 'obs-2',
      entityId: 'ent-architecture',
      content: 'Webhook handlers must be idempotent — dedupe on the provider event ID.',
      confidence: 0.9,
      sourceType: 'inferred',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-04T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-10T09:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
  ],
  'ent-code-quality': [
    {
      id: 'obs-3',
      entityId: 'ent-code-quality',
      content: 'Prefer Valibot at API boundaries over hand-rolled validation.',
      confidence: 0.93,
      sourceType: 'explicit',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-06T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-11T14:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
    {
      id: 'obs-4',
      entityId: 'ent-code-quality',
      content: 'Keep route handlers under 80 lines; extract service functions for business logic.',
      confidence: 0.88,
      sourceType: 'inferred',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-08T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-09T16:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
  ],
  'ent-user-preferences': [
    {
      id: 'obs-5',
      entityId: 'ent-user-preferences',
      content: 'Priya prefers PRs under 400 lines; split larger changes.',
      confidence: 0.95,
      sourceType: 'explicit',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-10T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-13T08:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
    {
      id: 'obs-6',
      entityId: 'ent-user-preferences',
      content: 'Priya wants a Slack summary posted after every deploy to production.',
      confidence: 0.85,
      sourceType: 'inferred',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-12T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-08T12:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
  ],
  'ent-payments-domain': [
    {
      id: 'obs-7',
      entityId: 'ent-payments-domain',
      content: 'Refund events must reconcile against the Stripe balance transaction within 24 hours.',
      confidence: 0.98,
      sourceType: 'explicit',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-14T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-12T18:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
    {
      id: 'obs-8',
      entityId: 'ent-payments-domain',
      content: 'PCI scope is limited to the tokenization service; the payments API never touches raw card data.',
      confidence: 0.91,
      sourceType: 'inferred',
      sourceSessionId: null,
      createdAt: Date.parse('2026-06-16T00:00:00Z'),
      lastConfirmedAt: Date.parse('2026-09-07T11:00:00Z'),
      supersededBy: null,
      isActive: true,
    },
  ],
};

const MEANINGFUL_ENTITY_RECORDS = MEANINGFUL_ENTITIES.map((entity) => {
  const observations = OBSERVATIONS_BY_ENTITY[entity.id] ?? [];
  const updatedAt = observations.reduce((max, o) => Math.max(max, o.lastConfirmedAt), 0);
  return {
    ...entity,
    observationCount: observations.length,
    createdAt: Date.parse('2026-06-01T00:00:00Z'),
    updatedAt: updatedAt || Date.parse('2026-06-01T00:00:00Z'),
  };
});

// Filler entities push the visible count to a realistic "well-used knowledge
// base" total (rule 65: a capped/long list should look genuinely busy, not
// padded) without needing individually-crafted observations — they render
// below the fold of the Memory screenshot's viewport.
const FILLER_ENTITY_TOPICS: Array<[string, string, string]> = [
  ['Deploy pipeline', 'workflow', 'Guardrails for staging and production deploys.'],
  ['Testing conventions', 'workflow', 'How the team writes and organizes tests.'],
  ['Incident response', 'workflow', 'Steps taken when a payments incident is declared.'],
  ['API versioning', 'context', 'How breaking changes are rolled out to merchants.'],
  ['Observability', 'context', 'Logging, tracing, and alerting conventions.'],
  ['Merchant onboarding', 'expertise', 'How new merchants are provisioned.'],
  ['Refund policy', 'expertise', 'Business rules governing refund eligibility.'],
  ['Code review style', 'preference', 'What reviewers look for before approving.'],
  ['Release cadence', 'workflow', 'How often changes ship to production.'],
  ['Secrets rotation', 'context', 'Rotation cadence for API keys and webhook secrets.'],
  ['Webhook retries', 'context', 'Retry/backoff policy for outbound webhooks.'],
  ['Rate limiting', 'context', 'Per-merchant rate limit tiers and overrides.'],
  ['Database migrations', 'workflow', 'How schema changes are reviewed and rolled out.'],
  ['Feature flags', 'preference', 'When to gate a change behind a flag.'],
  ['On-call rotation', 'workflow', 'Who is paged and in what order.'],
  ['Currency rounding', 'expertise', 'Rounding rules for multi-currency ledger entries.'],
  ['Fraud scoring', 'expertise', 'Signals used to flag suspicious refund requests.'],
  ['Chargeback handling', 'expertise', 'Evidence collection process for disputes.'],
  ['Settlement reconciliation', 'expertise', 'Daily reconciliation against the processor report.'],
  ['Sandbox environments', 'context', 'How sandbox credentials differ from production.'],
  ['Support escalation', 'workflow', 'When to loop in engineering from support.'],
];

const FILLER_ENTITIES = FILLER_ENTITY_TOPICS.map(([name, entityType, description], i) => ({
  id: `ent-filler-${i}`,
  name,
  entityType,
  description,
  observationCount: 1 + (i % 4),
  createdAt: Date.parse('2026-06-01T00:00:00Z') + i * 86_400_000,
  updatedAt: Date.parse('2026-08-15T00:00:00Z') + i * 86_400_000,
}));

const KNOWLEDGE_ENTITIES = [...MEANINGFUL_ENTITY_RECORDS, ...FILLER_ENTITIES];

// ---------------------------------------------------------------------------
// Agent Context fixtures — Policies
// ---------------------------------------------------------------------------

function policy(overrides: {
  id: string;
  title: string;
  content: string;
  category: 'rule' | 'constraint' | 'delegation' | 'preference';
  confidence: number;
  source: 'explicit' | 'inferred';
  createdAt: number;
  updatedAt: number;
}) {
  return {
    active: true,
    scope: 'always' as const,
    sourceSessionId: null,
    expiresAt: null,
    ...overrides,
  };
}

const MEANINGFUL_POLICIES = [
  policy({
    id: 'pol-no-main-push',
    title: 'Never push to main',
    content: 'Never push to main; open a PR from a sam/ branch instead.',
    category: 'rule',
    confidence: 0.96,
    source: 'explicit',
    createdAt: Date.parse('2026-06-01T00:00:00Z'),
    updatedAt: Date.parse('2026-09-10T00:00:00Z'),
  }),
  policy({
    id: 'pol-shared-hetzner-cred',
    title: 'Use the shared Hetzner credential for triggers',
    content: 'Use the shared project Hetzner credential for triggers — do not attribute scheduled runs to a personal token.',
    category: 'delegation',
    confidence: 0.88,
    source: 'explicit',
    createdAt: Date.parse('2026-06-05T00:00:00Z'),
    updatedAt: Date.parse('2026-09-01T00:00:00Z'),
  }),
  policy({
    id: 'pol-refund-test-replay',
    title: 'Refund changes require a Stripe replay test',
    content: 'Refund code changes require a test that replays a Stripe event before merge.',
    category: 'constraint',
    confidence: 0.93,
    source: 'explicit',
    createdAt: Date.parse('2026-06-10T00:00:00Z'),
    updatedAt: Date.parse('2026-09-12T00:00:00Z'),
  }),
  policy({
    id: 'pol-webhook-idempotency-suite',
    title: 'Run the idempotency suite before merging refund changes',
    content: 'Always run the webhook idempotency test suite before merging any refund-handler change.',
    category: 'rule',
    confidence: 0.91,
    source: 'inferred',
    createdAt: Date.parse('2026-06-15T00:00:00Z'),
    updatedAt: Date.parse('2026-09-11T00:00:00Z'),
  }),
  policy({
    id: 'pol-feature-flags',
    title: 'Prefer feature flags over long-lived branches',
    content: 'Prefer feature flags over long-lived branches for payments features.',
    category: 'preference',
    confidence: 0.86,
    source: 'inferred',
    createdAt: Date.parse('2026-06-20T00:00:00Z'),
    updatedAt: Date.parse('2026-09-05T00:00:00Z'),
  }),
  policy({
    id: 'pol-rotate-webhook-secret',
    title: 'Rotate the Stripe webhook signing secret quarterly',
    content: 'Rotate the Stripe webhook signing secret quarterly and confirm both environments validate before closing out.',
    category: 'constraint',
    confidence: 0.89,
    source: 'explicit',
    createdAt: Date.parse('2026-06-25T00:00:00Z'),
    updatedAt: Date.parse('2026-09-13T00:00:00Z'),
  }),
];

const FILLER_POLICIES = [
  policy({
    id: 'pol-pr-length',
    title: 'Keep PR descriptions under 400 words',
    content: 'Keep PR descriptions under 400 words; link to the task file for full context.',
    category: 'preference',
    confidence: 0.8,
    source: 'inferred',
    createdAt: Date.parse('2026-07-01T00:00:00Z'),
    updatedAt: Date.parse('2026-08-20T00:00:00Z'),
  }),
  policy({
    id: 'pol-pci-tag-tomas',
    title: 'Tag Tomás on PCI-scope changes',
    content: 'Tag Tomás Alvarez on any change that touches PCI scope.',
    category: 'delegation',
    confidence: 0.82,
    source: 'explicit',
    createdAt: Date.parse('2026-07-05T00:00:00Z'),
    updatedAt: Date.parse('2026-08-22T00:00:00Z'),
  }),
  policy({
    id: 'pol-squash-merge',
    title: 'Squash-merge feature branches',
    content: 'Squash-merge feature branches to keep main history linear.',
    category: 'preference',
    confidence: 0.78,
    source: 'inferred',
    createdAt: Date.parse('2026-07-10T00:00:00Z'),
    updatedAt: Date.parse('2026-08-25T00:00:00Z'),
  }),
  policy({
    id: 'pol-two-reviewers-migrations',
    title: 'Require two reviewers for schema migrations',
    content: 'Require two reviewers for any schema migration that touches the ledger tables.',
    category: 'rule',
    confidence: 0.9,
    source: 'explicit',
    createdAt: Date.parse('2026-07-15T00:00:00Z'),
    updatedAt: Date.parse('2026-08-28T00:00:00Z'),
  }),
  policy({
    id: 'pol-utc-logs',
    title: 'Use UTC timestamps in all logs',
    content: 'Use UTC timestamps in all logs and structured events.',
    category: 'constraint',
    confidence: 0.84,
    source: 'inferred',
    createdAt: Date.parse('2026-07-20T00:00:00Z'),
    updatedAt: Date.parse('2026-08-30T00:00:00Z'),
  }),
  policy({
    id: 'pol-fx-cache',
    title: 'Cache exchange rates for at most 15 minutes',
    content: 'Cache exchange rates for at most 15 minutes to avoid stale FX conversions.',
    category: 'constraint',
    confidence: 0.87,
    source: 'explicit',
    createdAt: Date.parse('2026-07-25T00:00:00Z'),
    updatedAt: Date.parse('2026-09-02T00:00:00Z'),
  }),
];

const POLICIES = [...MEANINGFUL_POLICIES, ...FILLER_POLICIES];

// ---------------------------------------------------------------------------
// Agent Context fixtures — Activity (Actions)
// ---------------------------------------------------------------------------

const MEANINGFUL_ACTIVITY_EVENTS = [
  {
    id: 'evt-1',
    eventType: 'task.agent_completed',
    actorType: 'agent',
    actorId: null,
    workspaceId: 'ws-refund-idempotency',
    sessionId: 'sess-refund-idempotency',
    taskId: 'task-refund-idempotency',
    payload: { summary: 'Completed "Ship refund idempotency" — opened PR #482 with the backfill migration and updated tests.' },
    createdAt: Date.parse('2026-09-14T09:40:00Z'),
  },
  {
    id: 'evt-2',
    eventType: 'task.execution_step',
    actorType: 'agent',
    actorId: null,
    workspaceId: 'ws-refund-idempotency',
    sessionId: 'sess-refund-idempotency',
    taskId: 'task-refund-idempotency',
    payload: { summary: 'Workspace provisioned on payments-vm-07 (cx33, nbg1).' },
    createdAt: Date.parse('2026-09-14T09:09:00Z'),
  },
  {
    id: 'evt-3',
    eventType: 'session.started',
    actorType: 'user',
    actorId: NORTHWIND.owner.id,
    workspaceId: null,
    sessionId: 'sess-refund-idempotency',
    taskId: null,
    payload: { summary: 'Priya started "Add idempotency keys to refund webhook".' },
    createdAt: Date.parse('2026-09-14T09:08:00Z'),
  },
  {
    id: 'evt-4',
    eventType: 'comment.created',
    actorType: 'user',
    actorId: NORTHWIND.members[1]?.id ?? null,
    workspaceId: null,
    sessionId: 'sess-refund-idempotency',
    taskId: null,
    payload: { summary: 'Elena commented: "Run the backfill in chunks so we don’t lock refund_events."' },
    createdAt: Date.parse('2026-09-14T09:20:00Z'),
  },
  {
    id: 'evt-5',
    eventType: 'session.stopped',
    actorType: 'system',
    actorId: null,
    workspaceId: 'ws-webhook-rotation',
    sessionId: 'sess-webhook-signature-rotation',
    taskId: null,
    payload: { summary: '"Stripe webhook signature rotation" went to sleep after 100 minutes idle.' },
    createdAt: Date.parse('2026-09-14T08:20:00Z'),
  },
  {
    id: 'evt-6',
    eventType: 'task.agent_completed',
    actorType: 'agent',
    actorId: null,
    workspaceId: 'ws-ledger-migration',
    sessionId: 'sess-ledger-migration',
    taskId: null,
    payload: { summary: 'Completed "Migrate ledger to double-entry schema" — 6 files changed, all tests passing.' },
    createdAt: Date.parse('2026-09-13T22:05:00Z'),
  },
  {
    id: 'evt-7',
    eventType: 'comment.created',
    actorType: 'user',
    actorId: NORTHWIND.members[2]?.id ?? null,
    workspaceId: null,
    sessionId: 'sess-refund-idempotency',
    taskId: null,
    payload: { summary: 'Tomás commented: "Confirm this guard also short-circuits on refund.updated."' },
    createdAt: Date.parse('2026-09-13T21:40:00Z'),
  },
  {
    id: 'evt-8',
    eventType: 'session.started',
    actorType: 'user',
    actorId: NORTHWIND.members[0]?.id ?? null,
    workspaceId: 'ws-rate-limit-payouts',
    sessionId: 'sess-rate-limit-payouts',
    taskId: null,
    payload: { summary: 'Marcus started "Rate-limit the payouts endpoint".' },
    createdAt: Date.parse('2026-09-13T18:12:00Z'),
  },
];

const FILLER_EVENT_TEMPLATES: Array<{
  type: string;
  actor: string;
  summary: (topic: string) => string;
}> = [
  { type: 'task.agent_completed', actor: 'agent', summary: (t) => `Completed "${t}" — output branch pushed and ready for review.` },
  { type: 'task.execution_step', actor: 'agent', summary: (t) => `Agent session step: workspace provisioned for "${t}".` },
  { type: 'session.started', actor: 'user', summary: (t) => `A session was started: "${t}".` },
  { type: 'session.stopped', actor: 'system', summary: (t) => `Session "${t}" stopped after going idle.` },
  { type: 'comment.created', actor: 'user', summary: (t) => `A reviewer left a comment on "${t}".` },
];

const FILLER_ACTIVITY_TOPICS = [
  'Nightly dependency audit',
  'PCI evidence bundle',
  'Timezone backfill',
  'Flaky test triage',
  'Rate limit tuning',
  'Webhook retry backoff',
  'Sandbox seed data',
  'Currency rounding fix',
  'Chargeback dashboard',
  'Settlement export',
  'Refund policy doc',
  'Merchant onboarding checklist',
  'On-call runbook',
  'Fraud scoring model',
  'Support escalation macro',
];

function fillerActivityEvents(count: number, baseTs: number) {
  return Array.from({ length: count }, (_, i) => {
    const template = FILLER_EVENT_TEMPLATES[i % FILLER_EVENT_TEMPLATES.length]!;
    const topic = FILLER_ACTIVITY_TOPICS[i % FILLER_ACTIVITY_TOPICS.length]!;
    return {
      id: `evt-filler-${i}`,
      eventType: template.type,
      actorType: template.actor,
      actorId: null,
      workspaceId: null,
      sessionId: null,
      taskId: null,
      payload: { summary: template.summary(topic) },
      createdAt: baseTs - (i + 1) * 3_600_000,
    };
  });
}

const ACTIVITY_EVENTS = [
  ...MEANINGFUL_ACTIVITY_EVENTS,
  ...fillerActivityEvents(42, Date.parse('2026-09-13T18:12:00Z')),
];

// ---------------------------------------------------------------------------
// Chat fixtures — agent catalog + profiles
// ---------------------------------------------------------------------------

const AGENT_INFO = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's coding agent.",
    supportsAcp: true,
    configured: true,
    credentialHelpUrl: 'https://docs.claude.com',
    fallbackCredentialSource: null,
  },
  {
    id: 'openai-codex',
    name: 'Codex',
    description: "OpenAI's coding agent.",
    supportsAcp: true,
    configured: true,
    credentialHelpUrl: 'https://platform.openai.com',
    fallbackCredentialSource: null,
  },
  {
    id: 'google-gemini',
    name: 'Gemini CLI',
    description: "Google's coding agent.",
    supportsAcp: true,
    configured: true,
    credentialHelpUrl: 'https://ai.google.dev',
    fallbackCredentialSource: null,
  },
];


// ---------------------------------------------------------------------------
// Chat fixtures — sessions
// ---------------------------------------------------------------------------

/**
 * Session recency drives real UI behavior — see the identical note in
 * `marketing-shots-platform.spec.ts`. Anchor everything to the real run time
 * so sessions don't silently collapse into the sidebar's "Older" bucket.
 */
const NOW = Date.now();
function agoMs(minutes: number): number {
  return NOW - minutes * 60_000;
}
function agoIso(minutes: number): string {
  return new Date(agoMs(minutes)).toISOString();
}

const LEDGER_SESSION_ID = 'sess-ledger-migration';

function person(member: { id: string; name: string; email: string | null } | undefined, fallback: { id: string; name: string; email: string }) {
  const m = member ?? fallback;
  return { id: m.id, name: m.name, email: m.email, image: null, avatarUrl: null };
}

const OWNER_PERSON = { id: NORTHWIND.owner.id, name: NORTHWIND.owner.name, email: NORTHWIND.owner.email, image: null, avatarUrl: null };

const SESSION_LIST = [
  {
    id: 'sess-refund-idempotency',
    workspaceId: 'ws-refund-idempotency',
    taskId: null,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: OWNER_PERSON,
    isMine: true,
    topic: 'Add idempotency keys to refund webhook',
    status: 'active',
    messageCount: 8,
    startedAt: agoMs(50),
    endedAt: null,
    createdAt: agoMs(50),
    agentCompletedAt: null,
    lastMessageAt: agoMs(5),
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-refund-idempotency',
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: LEDGER_SESSION_ID,
    workspaceId: 'ws-ledger-migration',
    taskId: null,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: OWNER_PERSON,
    isMine: true,
    topic: 'Migrate ledger to double-entry schema',
    status: 'active',
    messageCount: 8,
    startedAt: agoMs(35),
    endedAt: null,
    createdAt: agoMs(35),
    agentCompletedAt: null,
    lastMessageAt: agoMs(1),
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-ledger-migration',
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: 'sess-webhook-signature-rotation',
    workspaceId: 'ws-webhook-rotation',
    taskId: null,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: OWNER_PERSON,
    isMine: true,
    topic: 'Stripe webhook signature rotation',
    status: 'sleeping',
    messageCount: 14,
    startedAt: agoMs(170),
    endedAt: null,
    createdAt: agoMs(170),
    agentCompletedAt: null,
    lastMessageAt: agoMs(100),
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-webhook-rotation',
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: 'sess-rate-limit-payouts',
    workspaceId: 'ws-rate-limit-payouts',
    taskId: null,
    createdByUserId: NORTHWIND.members[1]?.id ?? null,
    createdBy: person(NORTHWIND.members[1], { id: 'user-elena', name: 'Elena Rossi', email: 'elena@northwindlabs.dev' }),
    isMine: false,
    topic: 'Rate-limit the payouts endpoint',
    status: 'active',
    messageCount: 5,
    startedAt: agoMs(20),
    endedAt: null,
    createdAt: agoMs(20),
    agentCompletedAt: null,
    lastMessageAt: agoMs(8),
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-rate-limit-payouts',
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: 'sess-flaky-triage',
    workspaceId: 'ws-flaky-triage',
    taskId: null,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: OWNER_PERSON,
    isMine: true,
    topic: 'Flaky test triage: payment-retry.spec',
    status: 'idle',
    messageCount: 9,
    startedAt: agoMs(80),
    endedAt: null,
    createdAt: agoMs(80),
    agentCompletedAt: agoMs(45),
    lastMessageAt: agoMs(45),
    isIdle: true,
    isTerminated: false,
    agentSessionId: 'acp-flaky-triage',
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: 'sess-pci-evidence',
    workspaceId: null,
    taskId: null,
    createdByUserId: NORTHWIND.members[2]?.id ?? null,
    createdBy: person(NORTHWIND.members[2], { id: 'user-tomas', name: 'Tomás Alvarez', email: 'tomas@northwindlabs.dev' }),
    isMine: false,
    topic: 'PCI evidence bundle for Q3',
    status: 'stopped',
    messageCount: 31,
    startedAt: agoMs(165),
    endedAt: agoMs(160),
    createdAt: agoMs(165),
    agentCompletedAt: agoMs(160),
    lastMessageAt: agoMs(160),
    isIdle: false,
    isTerminated: true,
    agentSessionId: null,
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: 'sess-timezone-backfill',
    workspaceId: null,
    taskId: null,
    createdByUserId: NORTHWIND.members[3]?.id ?? null,
    createdBy: person(NORTHWIND.members[3], { id: 'user-aisha', name: 'Aisha Okafor', email: 'aisha@northwindlabs.dev' }),
    isMine: false,
    topic: 'Backfill merchant timezone column',
    status: 'stopped',
    messageCount: 17,
    startedAt: agoMs(70),
    endedAt: agoMs(65),
    createdAt: agoMs(70),
    agentCompletedAt: agoMs(65),
    lastMessageAt: agoMs(65),
    isIdle: false,
    isTerminated: true,
    agentSessionId: null,
    agentType: 'openai-codex',
    attention: null,
  },
];

const LEDGER_WORKSPACE = {
  id: 'ws-ledger-migration',
  nodeId: 'node-payments-vm-03',
  projectId: PROJECT_ID,
  name: 'ws-ledger-migration',
  displayName: 'ledger-migration',
  repository: NORTHWIND.repository,
  branch: 'sam/ledger-double-entry-migration',
  status: 'running',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  workspaceProfile: 'full',
  vmIp: '10.20.4.15',
  url: 'https://ws-ledger-migration.sammy.party',
  lastActivityAt: agoIso(1),
  errorMessage: null,
  hardware: null,
  resolvedReservationJson: null,
  resourceRequirementsJson: null,
  placementExplanationJson: null,
  createdAt: agoIso(35),
  updatedAt: agoIso(1),
};

const LEDGER_NODE = {
  id: 'node-payments-vm-03',
  name: 'payments-vm-03',
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  cloudProvider: 'hetzner',
  providerInstanceType: 'cx33',
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 80,
  observedProviderInstanceType: 'cx33',
  observedProviderInstanceVcpuCount: 4,
  observedProviderInstanceMemoryMb: 8192,
  observedProviderInstanceDiskGb: 80,
};

const LEDGER_SESSION = {
  id: LEDGER_SESSION_ID,
  projectId: PROJECT_ID,
  taskId: null,
  topic: 'Migrate ledger to double-entry schema',
  status: 'active',
  workspaceId: LEDGER_WORKSPACE.id,
  nodeId: LEDGER_NODE.id,
  branch: 'sam/ledger-double-entry-migration',
  isMine: true,
  agentType: 'claude-code',
  startedAt: agoMs(35),
  createdAt: agoIso(35),
  updatedAt: agoIso(1),
  task: null,
};

const LEDGER_MESSAGES = [
  {
    id: 'msg-1-user',
    sessionId: LEDGER_SESSION_ID,
    role: 'user',
    content: 'Migrate the ledger to double-entry accounting — no more updating balances in place. Backfill existing rows too.',
    toolMetadata: null,
    createdAt: agoMs(35),
    sequence: 1,
  },
  {
    id: 'msg-2-assistant',
    sessionId: LEDGER_SESSION_ID,
    role: 'assistant',
    content: "I'll convert the ledger in three passes — schema first, then the service layer, then verify with the full test suite.",
    toolMetadata: null,
    createdAt: agoMs(34),
    sequence: 2,
  },
  {
    id: 'msg-3-tool-mcp',
    sessionId: LEDGER_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-mcp-instructions',
      title: 'sam-mcp/get_instructions',
      kind: 'mcp',
      status: 'completed',
    },
    createdAt: agoMs(33),
    sequence: 3,
  },
  {
    id: 'msg-4-tool-read-entry',
    sessionId: LEDGER_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-read-entry',
      title: 'Read payments/ledger/entry.py',
      kind: 'read',
      status: 'completed',
      locations: [{ path: 'payments/ledger/entry.py', line: null }],
    },
    createdAt: agoMs(28),
    sequence: 4,
  },
  {
    id: 'msg-5-tool-edit-entry',
    sessionId: LEDGER_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-edit-entry',
      title: 'Edit payments/ledger/entry.py',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'payments/ledger/entry.py', line: 58 }],
    },
    createdAt: agoMs(20),
    sequence: 5,
  },
  {
    id: 'msg-6-tool-bash-migrate',
    sessionId: LEDGER_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-bash-migrate',
      title: 'Bash: alembic upgrade head',
      kind: 'execute',
      status: 'completed',
      contentSize: 320,
    },
    createdAt: agoMs(14),
    sequence: 6,
  },
  {
    id: 'msg-7-tool-edit-balance',
    sessionId: LEDGER_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-edit-balance',
      title: 'Edit payments/ledger/balance_service.py',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'payments/ledger/balance_service.py', line: 112 }],
    },
    createdAt: agoMs(6),
    sequence: 7,
  },
  {
    id: 'msg-8-tool-bash-tests',
    sessionId: LEDGER_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-bash-tests',
      title: 'Bash: pytest tests/ledger/test_double_entry.py -q',
      kind: 'execute',
      status: 'in_progress',
      contentSize: 480,
    },
    createdAt: agoMs(1),
    sequence: 8,
  },
];

const LEDGER_MIGRATE_TOOL_CONTENT = [
  {
    type: 'terminal',
    output:
      'Running upgrade 3f9a2c1e4b7d -> 7c1e9a4f2b8d, add double_entry ledger tables\n' +
      'Backfilled 41,208 historical rows into ledger_entries\n' +
      'Upgrade complete.',
  },
];

const LEDGER_RUNNING_TOOL_CONTENT = [
  {
    type: 'terminal',
    output:
      'collected 12 items\n\n' +
      'tests/ledger/test_double_entry.py::test_debit_credit_balance PASSED\n' +
      'tests/ledger/test_double_entry.py::test_backfill_matches_legacy_balances PASSED\n' +
      'tests/ledger/test_double_entry.py::test_negative_balance_rejected PASSED\n' +
      'tests/ledger/test_double_entry.py::test_concurrent_writes_serialize ...',
  },
];

// ---------------------------------------------------------------------------
// Shared chrome mocks (auth, project shell, agent context, chat)
// ---------------------------------------------------------------------------

async function setupMocks(page: Page) {
  await dismissOnboarding(page);
  // Accept every WebSocket connection without forwarding — avoids the
  // "Reconnecting..." banner from a failed real WS handshake against the
  // static preview server.
  await page.routeWebSocket(/.*/, () => {
    /* accepted, never echoed */
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.includes('/api/auth/')) return respond(route, 200, MARKETING_USER);
    if (path === '/api/github/installations') return respond(route, 200, []);
    if (path === '/api/notifications') {
      return respond(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path === '/api/credentials') return respond(route, 200, [{ provider: 'hetzner', status: 'valid' }]);
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path === '/api/agents') return respond(route, 200, { agents: AGENT_INFO });
    if (path === '/api/trial-status' || path === '/api/trial/status') {
      return respond(route, 200, { available: false });
    }
    if (path === '/api/providers/catalog') return respond(route, 200, { catalogs: [] });
    if (path === '/api/report-issue/config') return respond(route, 200, { enabled: false });
    if (path === '/api/terminal/token') return respond(route, 200, { token: 'marketing-token' });
    if (path === '/api/dashboard/active-tasks') return respond(route, 200, { tasks: [] });
    if (path === '/api/chats' || path === '/api/chats/recent') return respond(route, 200, { chats: [] });
    if (path === '/api/account-map') return respond(route, 200, {});
    if (path === '/api/nodes') return respond(route, 200, [LEDGER_NODE]);
    if (path === `/api/nodes/${LEDGER_NODE.id}`) return respond(route, 200, LEDGER_NODE);
    if (path === `/api/workspaces/${LEDGER_WORKSPACE.id}`) return respond(route, 200, LEDGER_WORKSPACE);
    if (path.startsWith(`/api/workspaces/${LEDGER_WORKSPACE.id}/ports`)) return respond(route, 200, { ports: [] });

    if (path === `/api/projects/${PROJECT_ID}/capacity-pools/defaults`) {
      return respond(route, 200, {
        effectiveSummary: {
          scope: 'project',
          state: 'configured-ready',
          strategy: 'balanced',
          exhaustionPolicy: 'queue',
          availableCandidateCount: 6,
        },
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      if (subPath === '/knowledge') {
        return respond(route, 200, { entities: KNOWLEDGE_ENTITIES, total: KNOWLEDGE_ENTITIES.length });
      }
      const knowledgeDetailMatch = subPath.match(/^\/knowledge\/([^/]+)$/);
      if (knowledgeDetailMatch) {
        const entityId = knowledgeDetailMatch[1]!;
        const entity = KNOWLEDGE_ENTITIES.find((e) => e.id === entityId);
        const observations = OBSERVATIONS_BY_ENTITY[entityId] ?? [];
        return respond(route, 200, { entity, observations, relations: [] });
      }
      if (subPath === '/policies') return respond(route, 200, { policies: POLICIES, total: POLICIES.length });
      if (subPath === '/activity') return respond(route, 200, { events: ACTIVITY_EVENTS, hasMore: false });

      if (subPath === '/sessions') return respond(route, 200, { sessions: SESSION_LIST, total: SESSION_LIST.length });
      if (subPath === '/tasks') return respond(route, 200, { tasks: [], total: 0 });
      if (subPath === '/agent-profiles') return respond(route, 200, { items: AGENT_PROFILES });
      if (subPath === '/cached-commands') return respond(route, 200, { commands: [] });
      if (subPath === '/commands') return respond(route, 200, { commands: [] });
      if (subPath === '/skills') return respond(route, 200, { items: [] });
      if (subPath === '/credential-attribution-health') return respond(route, 200, {});
      if (subPath === '' && method === 'GET') return respond(route, 200, MOCK_PROJECT);
      // Session detail / comments / tool-content — handled per-test via a more
      // specific route registered afterward (Playwright matches the
      // most-recently-registered route first).
      return respond(route, 200, {});
    }

    if (path === '/api/projects') return respond(route, 200, { projects: [MOCK_PROJECT], nextCursor: null });

    return respond(route, 200, {});
  });
}

// =============================================================================
// A–D. Agent Context — overview / memory / policies / actions
// =============================================================================

test('sam-context-overview', async ({ page }) => {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/agent-context`);

  await expect(page.getByRole('tablist', { name: 'Agent context' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await expect(page.getByText('Memory entities')).toBeVisible();
  await expect(page.getByText('25', { exact: true })).toBeVisible();
  await expect(page.getByText('Active policies')).toBeVisible();
  await expect(page.getByText('12', { exact: true })).toBeVisible();
  await expect(page.getByText('Recent actions')).toBeVisible();
  await expect(page.getByText('50', { exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Context stack' })).toBeVisible();
  await expect(page.getByText('Repository instructions')).toBeVisible();
  await expect(page.getByText('25 high-confidence entities')).toBeVisible();
  await expect(page.getByText('12 active instruction-only policies')).toBeVisible();
  await expect(page.getByText('Linked from project profile settings')).toBeVisible();

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-context-overview');
});

test('sam-context-memory', async ({ page }) => {
  // 4 expanded entities (2 observations each) need more vertical room than the
  // shared marketing viewport gives — use a taller viewport for this capture
  // only, matching the pattern `marketing-shots-platform.spec.ts` uses for its
  // hero capture.
  await page.setViewportSize({ width: 1440, height: 1150 });
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/agent-context`);

  await expect(page.getByRole('tablist', { name: 'Agent context' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Memory', level: 2 })).toBeVisible();

  for (const name of ['Architecture', 'Code Quality', 'User Preferences', 'Payments Domain']) {
    await page.getByRole('heading', { name, level: 3 }).click();
  }

  await expect(page.getByText('Ledger writes must be double-entry', { exact: false })).toBeVisible();
  await expect(page.getByText('Prefer Valibot at API boundaries', { exact: false })).toBeVisible();
  await expect(page.getByText('Priya prefers PRs under 400 lines', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Refund events must reconcile against the Stripe balance transaction', { exact: false })
  ).toBeVisible();
  await expect(page.getByText('explicit').first()).toBeVisible();
  await expect(page.getByText('inferred').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-context-memory');
});

test('sam-context-policies', async ({ page }) => {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/agent-context`);

  await expect(page.getByRole('tablist', { name: 'Agent context' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Policies' }).click();
  await expect(page.getByRole('heading', { name: 'Policies', level: 2 })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Never push to main', exact: true })).toBeVisible();
  await expect(page.getByText('Use the shared project Hetzner credential', { exact: false })).toBeVisible();
  await expect(page.getByText('Refund code changes require a test that replays a Stripe event')).toBeVisible();
  await expect(page.getByText('rule').first()).toBeVisible();
  await expect(page.getByText('preference').first()).toBeVisible();
  await expect(page.getByText('delegation').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-context-policies');
});

test('sam-context-actions', async ({ page }) => {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/agent-context`);

  await expect(page.getByRole('tablist', { name: 'Agent context' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Agent actions' }).click();
  await expect(page.getByRole('heading', { name: 'Recent agent actions', level: 2 })).toBeVisible();

  await expect(page.getByText('task.agent_completed').first()).toBeVisible();
  await expect(page.getByText('session.started').first()).toBeVisible();
  await expect(page.getByText('comment.created').first()).toBeVisible();
  await expect(page.getByText('Completed "Ship refund idempotency"', { exact: false })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-context-actions');
});

// =============================================================================
// E–F. Project chat — new session composer + a live tool stream
// =============================================================================

async function gotoChat(page: Page, sessionId: string) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${sessionId}`);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Something went wrong');
}

test('sam-chat-new-session', async ({ page }) => {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/chat`);

  await expect(page.getByText('What do you want to build?')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Something went wrong');
  await expect(page.getByPlaceholder('Describe what you want the agent to do...')).toBeVisible();

  // Quick-start prompt suggestions
  await expect(page.getByRole('button', { name: 'Run the tests and summarize what fails.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix the most recent open issue.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find one small improvement I can ship today.' })).toBeVisible();

  // Agent profile selector — 5 profiles. Each toggle button carries a `title`
  // attribute equal to the plain profile name; the adjacent "Edit <name>"
  // icon button's aria-label contains the same text as a substring, so match
  // on the `title` attribute rather than accessible name to avoid ambiguity.
  const profileRow = page.locator('[aria-label="Agent profiles and skills"]');
  await expect(profileRow).toBeVisible();
  await expect(profileRow.locator('button[title="Claude Code — Opus 5"]')).toBeVisible();
  await expect(profileRow.locator('button[title="Codex 5.5 High"]')).toBeVisible();
  await expect(profileRow.locator('button[title="Gemini CLI Reviewer"]')).toBeVisible();
  await expect(profileRow.locator('button[title="Brainstormer"]')).toBeVisible();
  await expect(profileRow.locator('button[title="Picky CTO"]')).toBeVisible();

  // Sidebar — existing sessions with Northwind topics
  await expect(page.getByText('Add idempotency keys to refund webhook')).toBeVisible();
  await expect(page.getByText('Migrate ledger to double-entry schema')).toBeVisible();
  await expect(page.getByText('Stripe webhook signature rotation')).toBeVisible();
  await expect(page.getByText('Rate-limit the payouts endpoint')).toBeVisible();

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-chat-new-session');
});

test('sam-chat-tool-stream', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console:error]', msg.text());
  });

  // 6 tool rows + a short assistant message need more vertical room than the
  // shared marketing viewport, and the running row must stay clear of the
  // CompletionDock — same reasoning as the hero capture in
  // `marketing-shots-platform.spec.ts`.
  await page.setViewportSize({ width: 1440, height: 1300 });
  await setupMocks(page);

  await page.route(
    new RegExp(`/api/projects/${PROJECT_ID}/sessions/${LEDGER_SESSION_ID}(?:\\?.*)?$`),
    (route: Route) =>
      respond(route, 200, {
        session: LEDGER_SESSION,
        messages: LEDGER_MESSAGES,
        hasMore: false,
        state: {
          activity: 'prompting',
          activityAt: agoMs(1),
          statusError: null,
          currentPlan: null,
          planUpdatedAt: null,
          promptStartedAt: agoMs(1),
          agentType: 'claude-code',
          lastStopReason: null,
        },
      })
  );
  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${LEDGER_SESSION_ID}/messages/msg-6-tool-bash-migrate/tool-content`,
    (route: Route) => respond(route, 200, { content: LEDGER_MIGRATE_TOOL_CONTENT })
  );
  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${LEDGER_SESSION_ID}/messages/msg-8-tool-bash-tests/tool-content`,
    (route: Route) => respond(route, 200, { content: LEDGER_RUNNING_TOOL_CONTENT })
  );
  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${LEDGER_SESSION_ID}/comments*`,
    (route: Route) => respond(route, 200, { comments: [] })
  );

  await gotoChat(page, LEDGER_SESSION_ID);

  await expect(
    page.getByText('Migrate the ledger to double-entry accounting', { exact: false })
  ).toBeVisible();
  await expect(page.getByText("I'll convert the ledger in three passes", { exact: false })).toBeVisible();
  await expect(page.getByText('sam-mcp/get_instructions')).toBeVisible();
  await expect(page.getByText('Read payments/ledger/entry.py')).toBeVisible();
  await expect(page.getByText('Edit payments/ledger/entry.py')).toBeVisible();
  await expect(page.getByText('Bash: alembic upgrade head')).toBeVisible();
  await expect(page.getByText('Edit payments/ledger/balance_service.py')).toBeVisible();

  const runningRow = page
    .getByRole('button', { name: /Bash: pytest tests\/ledger\/test_double_entry\.py/ })
    .first();
  await expect(runningRow).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();

  // The running tool row must clear the CompletionDock's floating Interrupt
  // button — poll rather than assert once, since Virtuoso settles row heights
  // asynchronously (see the identical reasoning in the hero capture).
  await expect
    .poll(
      async () => {
        const [rowBox, dockBox] = await Promise.all([
          runningRow.boundingBox(),
          page.getByRole('button', { name: 'Interrupt agent' }).boundingBox(),
        ]);
        if (!rowBox || !dockBox) return Number.POSITIVE_INFINITY;
        return rowBox.y + rowBox.height - dockBox.y;
      },
      { message: 'Running tool row must clear the CompletionDock button', timeout: 5_000 }
    )
    .toBeLessThan(0);

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-chat-tool-stream');
});
