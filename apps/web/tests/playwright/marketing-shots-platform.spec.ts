/**
 * Marketing screenshots — the SAM control-plane UI ("the platform") rendered with
 * mocked API data. Companion to `marketing-shots-collab.spec.ts`; see
 * `marketing-shots-helpers.ts` for the shared fictional world (Northwind Labs /
 * Payments API), viewport, and capture helper.
 *
 * Run with the marketing output flag to write committed images:
 *   cd apps/web && MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-platform.spec.ts --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in `.codex/tmp/playwright-screenshots/`.
 *
 * Covered surfaces:
 *   A. sam-hero-live-session      — busy active project chat session (hero image)
 *   B. sam-session-sleeping       — sleeping session, Archive lifecycle control
 *      sam-session-waking         — same session mid-wake, phase progress banner
 *   C. sam-agents-orchestration   — task hierarchy modal (parent + dispatched subtasks)
 *   D. sam-app-deployments        — deployment environments list
 *      sam-app-deployment-detail  — staging environment overview
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';
import {
  AGENT_PROFILES,
  dismissOnboarding,
  MARKETING_THEME,
  MARKETING_USER,
  MARKETING_VIEWPORT,
  marketingShot,
  NORTHWIND,
  OPAQUE_BACKDROP_COLOR,
} from './marketing-shots-helpers';

test.use(MARKETING_VIEWPORT);

/**
 * Element-crops a modal panel with padding, writing to the same output
 * location `marketingShot` uses. `marketingShot` only accepts a `Locator`
 * (whose `.screenshot()` has no padding option), and an unpadded crop of
 * `.glass-panel-container` alone loses the card's drop shadow / breathing
 * room, so this mirrors its directory logic with `page.screenshot({ clip })`
 * instead of duplicating any behavior from the shared helper file.
 */
async function marketingShotPadded(
  page: Page,
  name: string,
  box: { x: number; y: number; width: number; height: number },
  pad = 32
) {
  await page.waitForTimeout(700);
  const viewport = page.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const maxWidth = (viewport?.width ?? box.x + box.width + pad) - x;
  const maxHeight = (viewport?.height ?? box.y + box.height + pad) - y;
  const clip = {
    x,
    y,
    width: Math.min(box.width + pad * 2, maxWidth),
    height: Math.min(box.height + pad * 2, maxHeight),
  };
  const dir = process.env.MARKETING_SHOTS
    ? resolve(process.cwd(), '../www/public/images/features')
    : resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}${MARKETING_THEME === 'light' ? '-light' : ''}.png`, clip });
}

const PROJECT_ID = NORTHWIND.projectId;

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
// Shared session/task world for screenshots A, B, and C — one project chat
// timeline. The hero session's own task ("Ship refund idempotency") is the
// root of the hierarchy shown in screenshot C, so the two surfaces read as
// the same story.
// ---------------------------------------------------------------------------

const HERO_SESSION_ID = 'sess-refund-idempotency';
const HERO_TASK_ID = 'task-refund-idempotency';
const SLEEPING_SESSION_ID = 'sess-webhook-signature-rotation';
const CHILD_MIGRATION_TASK_ID = 'task-refund-migration';
const CHILD_MIGRATION_SESSION_ID = 'sess-refund-migration';
const CHILD_TESTS_TASK_ID = 'task-refund-tests';
const CHILD_TESTS_SESSION_ID = 'sess-refund-tests';
const CHILD_SIGNOFF_TASK_ID = 'task-refund-signoff';

/**
 * Session recency drives real UI behavior: `isStaleSession()`
 * (`lib/chat-session-utils.ts`) compares `lastMessageAt` against `Date.now()`
 * with a 3-hour window (`STALE_SESSION_THRESHOLD_MS`) and collapses anything
 * older into a click-to-expand "Older" bucket in the sidebar. Fixed
 * `2026-09-14T09:40` timestamps looked deterministic but silently fell
 * outside that window whenever the suite ran later in the day (the sandbox
 * clock is real — `date -u` returns the actual current time) — every
 * requested sidebar session collapsed into "Older (8)" and only the exempt
 * sleeping session stayed visible. Anchor everything to the real run time.
 */
const NOW = Date.now();
function agoMs(minutes: number): number {
  return NOW - minutes * 60_000;
}
function agoIso(minutes: number): string {
  return new Date(agoMs(minutes)).toISOString();
}

/** Sidebar session list — the hero session plus 8 realistic others (rule 65: a
 *  capped selection should look like a genuinely busy team, not padding). */
const SESSION_LIST = [
  {
    id: HERO_SESSION_ID,
    workspaceId: 'ws-refund-idempotency',
    taskId: HERO_TASK_ID,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: {
      id: NORTHWIND.owner.id,
      name: NORTHWIND.owner.name,
      email: NORTHWIND.owner.email,
      image: null,
      avatarUrl: null,
    },
    isMine: true,
    topic: 'Add idempotency keys to refund webhook',
    status: 'active',
    messageCount: 8,
    startedAt: agoMs(32),
    endedAt: null,
    createdAt: agoMs(32),
    agentCompletedAt: null,
    lastMessageAt: agoMs(1),
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-refund-idempotency',
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: SLEEPING_SESSION_ID,
    workspaceId: 'ws-webhook-rotation',
    taskId: null,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: {
      id: NORTHWIND.owner.id,
      name: NORTHWIND.owner.name,
      email: NORTHWIND.owner.email,
      image: null,
      avatarUrl: null,
    },
    isMine: true,
    topic: 'Stripe webhook signature rotation',
    status: 'sleeping',
    messageCount: 14,
    // Sleeping sessions are exempt from the staleness cutoff (they stay
    // discoverable so the same-chat wake gesture keeps working), so this can
    // stay narratively "older" without falling into the sidebar's Older bucket.
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
    id: 'sess-ledger-migration',
    workspaceId: 'ws-ledger-migration',
    taskId: null,
    createdByUserId: NORTHWIND.members[0]?.id ?? null,
    createdBy: {
      id: NORTHWIND.members[0]?.id ?? 'user-marcus',
      name: NORTHWIND.members[0]?.name ?? 'Marcus Chen',
      email: NORTHWIND.members[0]?.email ?? null,
      image: null,
      avatarUrl: null,
    },
    isMine: false,
    topic: 'Migrate ledger to double-entry schema',
    status: 'idle',
    messageCount: 26,
    startedAt: agoMs(150),
    endedAt: null,
    createdAt: agoMs(150),
    agentCompletedAt: agoMs(95),
    lastMessageAt: agoMs(95),
    isIdle: true,
    isTerminated: false,
    agentSessionId: 'acp-ledger-migration',
    agentType: 'openai-codex',
    attention: null,
  },
  {
    id: 'sess-flaky-triage',
    workspaceId: 'ws-flaky-triage',
    taskId: null,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: {
      id: NORTHWIND.owner.id,
      name: NORTHWIND.owner.name,
      email: NORTHWIND.owner.email,
      image: null,
      avatarUrl: null,
    },
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
    createdBy: {
      id: NORTHWIND.members[2]?.id ?? 'user-tomas',
      name: NORTHWIND.members[2]?.name ?? 'Tomás Alvarez',
      email: NORTHWIND.members[2]?.email ?? null,
      image: null,
      avatarUrl: null,
    },
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
    createdBy: {
      id: NORTHWIND.members[3]?.id ?? 'user-aisha',
      name: NORTHWIND.members[3]?.name ?? 'Aisha Okafor',
      email: NORTHWIND.members[3]?.email ?? null,
      image: null,
      avatarUrl: null,
    },
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
  {
    id: 'sess-rate-limit-payouts',
    workspaceId: 'ws-rate-limit-payouts',
    taskId: null,
    createdByUserId: NORTHWIND.members[1]?.id ?? null,
    createdBy: {
      id: NORTHWIND.members[1]?.id ?? 'user-elena',
      name: NORTHWIND.members[1]?.name ?? 'Elena Rossi',
      email: NORTHWIND.members[1]?.email ?? null,
      image: null,
      avatarUrl: null,
    },
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
  // Dispatched subtasks of the hero session's task — appear in the sidebar
  // like any other session, and are what screenshot C's hierarchy modal shows.
  {
    id: CHILD_MIGRATION_SESSION_ID,
    workspaceId: null,
    taskId: CHILD_MIGRATION_TASK_ID,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: {
      id: NORTHWIND.owner.id,
      name: NORTHWIND.owner.name,
      email: NORTHWIND.owner.email,
      image: null,
      avatarUrl: null,
    },
    isMine: true,
    topic: 'Idempotency migration + tests (PR #482 opened)',
    status: 'stopped',
    messageCount: 11,
    startedAt: agoMs(30),
    endedAt: agoMs(15),
    createdAt: agoMs(30),
    agentCompletedAt: agoMs(15),
    lastMessageAt: agoMs(15),
    isIdle: false,
    isTerminated: true,
    agentSessionId: null,
    agentType: 'claude-code',
    attention: null,
  },
  {
    id: CHILD_TESTS_SESSION_ID,
    workspaceId: 'ws-refund-tests',
    taskId: CHILD_TESTS_TASK_ID,
    createdByUserId: NORTHWIND.owner.id,
    createdBy: {
      id: NORTHWIND.owner.id,
      name: NORTHWIND.owner.name,
      email: NORTHWIND.owner.email,
      image: null,
      avatarUrl: null,
    },
    isMine: true,
    topic: 'Update webhook signature verification tests',
    status: 'active',
    messageCount: 6,
    startedAt: agoMs(10),
    endedAt: null,
    createdAt: agoMs(10),
    agentCompletedAt: null,
    lastMessageAt: agoMs(2),
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-refund-tests',
    agentType: 'claude-code',
    attention: null,
  },
];

/** Task rows behind the hierarchy modal — parent + 3 dispatched subtasks. */
const TASKS = [
  {
    id: HERO_TASK_ID,
    projectId: PROJECT_ID,
    userId: NORTHWIND.owner.id,
    parentTaskId: null,
    workspaceId: 'ws-refund-idempotency',
    title: 'Ship refund idempotency',
    description: null,
    status: 'in_progress',
    executionStep: 'agent_session',
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: 'Claude Code — Opus 5',
    skillId: null,
    skillHint: null,
    blocked: false,
    triggeredBy: 'user',
    triggerId: null,
    triggerExecutionId: null,
    requestedVmSize: 'medium',
    requestedVmSizeSource: 'explicit',
    provisionedVmSize: 'medium',
    resourceRequirementsJson: null,
    resourceRequirementsSource: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    admissionState: null,
    admissionReason: null,
    admissionNextRetryAt: null,
    startedAt: agoIso(32),
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: 'sam/idempotency-keys-refund-webhook',
    outputPrUrl: null,
    completionEvidence: null,
    finalizedAt: null,
    createdAt: agoIso(32),
    updatedAt: agoIso(1),
  },
  {
    id: CHILD_MIGRATION_TASK_ID,
    projectId: PROJECT_ID,
    userId: NORTHWIND.owner.id,
    parentTaskId: HERO_TASK_ID,
    workspaceId: null,
    title: 'Add idempotency_key migration + backfill (PR #482 opened)',
    description: null,
    status: 'completed',
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 1,
    agentProfileHint: 'Claude Code — Opus 5',
    skillId: null,
    skillHint: null,
    blocked: false,
    triggeredBy: 'mcp',
    triggerId: null,
    triggerExecutionId: null,
    requestedVmSize: 'small',
    requestedVmSizeSource: 'explicit',
    provisionedVmSize: 'small',
    resourceRequirementsJson: null,
    resourceRequirementsSource: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    admissionState: null,
    admissionReason: null,
    admissionNextRetryAt: null,
    startedAt: agoIso(30),
    completedAt: agoIso(15),
    errorMessage: null,
    outputSummary: 'Added idempotency_key column + unique index; backfilled 30 days of refund_events.',
    outputBranch: 'sam/idempotency-migration',
    outputPrUrl: 'https://github.com/northwind-labs/payments-api/pull/482',
    completionEvidence: null,
    finalizedAt: agoIso(15),
    createdAt: agoIso(30),
    updatedAt: agoIso(15),
  },
  {
    id: CHILD_TESTS_TASK_ID,
    projectId: PROJECT_ID,
    userId: NORTHWIND.owner.id,
    parentTaskId: HERO_TASK_ID,
    workspaceId: 'ws-refund-tests',
    title: 'Update webhook signature verification tests',
    description: null,
    status: 'in_progress',
    executionStep: 'agent_session',
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 1,
    agentProfileHint: 'Codex 5.5 High',
    skillId: null,
    skillHint: null,
    blocked: false,
    triggeredBy: 'mcp',
    triggerId: null,
    triggerExecutionId: null,
    requestedVmSize: 'small',
    requestedVmSizeSource: 'explicit',
    provisionedVmSize: 'small',
    resourceRequirementsJson: null,
    resourceRequirementsSource: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    admissionState: null,
    admissionReason: null,
    admissionNextRetryAt: null,
    startedAt: agoIso(10),
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: 'sam/idempotency-signature-tests',
    outputPrUrl: null,
    completionEvidence: null,
    finalizedAt: null,
    createdAt: agoIso(10),
    updatedAt: agoIso(2),
  },
  {
    id: CHILD_SIGNOFF_TASK_ID,
    projectId: PROJECT_ID,
    userId: NORTHWIND.owner.id,
    parentTaskId: HERO_TASK_ID,
    workspaceId: null,
    title: 'Get sign-off before rotating prod idempotency keys',
    description: null,
    status: 'queued',
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 1,
    agentProfileHint: null,
    skillId: null,
    skillHint: null,
    blocked: true,
    triggeredBy: 'mcp',
    triggerId: null,
    triggerExecutionId: null,
    requestedVmSize: null,
    requestedVmSizeSource: null,
    provisionedVmSize: null,
    resourceRequirementsJson: null,
    resourceRequirementsSource: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    admissionState: null,
    admissionReason: null,
    admissionNextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    completionEvidence: null,
    finalizedAt: null,
    createdAt: agoIso(31),
    updatedAt: agoIso(31),
  },
];

const HERO_WORKSPACE = {
  id: 'ws-refund-idempotency',
  nodeId: 'node-payments-vm-07',
  projectId: PROJECT_ID,
  name: 'ws-refund-idempotency',
  displayName: 'refund-idempotency',
  repository: NORTHWIND.repository,
  branch: 'sam/idempotency-keys-refund-webhook',
  status: 'running',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  workspaceProfile: 'full',
  vmIp: '10.20.4.11',
  url: 'https://ws-refund-idempotency.sammy.party',
  lastActivityAt: agoIso(1),
  errorMessage: null,
  hardware: null,
  resolvedReservationJson: null,
  resourceRequirementsJson: null,
  placementExplanationJson: null,
  createdAt: agoIso(32),
  updatedAt: agoIso(1),
};

const HERO_NODE = {
  id: 'node-payments-vm-07',
  name: 'payments-vm-07',
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

const HERO_MESSAGES = [
  {
    id: 'msg-1-user',
    sessionId: HERO_SESSION_ID,
    role: 'user',
    content:
      "Add idempotency keys to the refund webhook handler so a retried Stripe event can't double-refund a customer. Also backfill the last 30 days of refund events.",
    toolMetadata: null,
    createdAt: agoMs(32),
    sequence: 1,
  },
  {
    id: 'msg-3-assistant',
    sessionId: HERO_SESSION_ID,
    role: 'assistant',
    content:
      "I'll add idempotency protection in four steps — schema first, then guard the handler, update the tests, and verify with the suite.",
    toolMetadata: null,
    createdAt: agoMs(31),
    sequence: 2,
  },
  // The tracked plan (mirrors the prose above into a live checklist) is placed
  // right before the tool calls, deliberately close to the bottom of the
  // conversation — Virtuoso aligns to bottom, so the marketing capture keeps
  // this panel in frame alongside the most recent tool activity.
  {
    id: 'msg-2-plan',
    sessionId: HERO_SESSION_ID,
    role: 'plan',
    content: JSON.stringify([
      {
        content: 'Add a unique idempotency_key column + index on refund_events',
        priority: 'high',
        status: 'completed',
      },
      {
        content: 'Guard the refund webhook handler with an idempotency check',
        priority: 'high',
        status: 'completed',
      },
      {
        content: 'Update signature + replay tests to cover the new guard',
        priority: 'medium',
        status: 'in_progress',
      },
      {
        content: 'Run the full webhook test suite and fix any regressions',
        priority: 'medium',
        status: 'pending',
      },
    ]),
    toolMetadata: null,
    createdAt: agoMs(30),
    sequence: 3,
  },
  {
    id: 'msg-4-tool-read',
    sessionId: HERO_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-read-handler',
      title: 'Read payments/webhooks/refund_handler.py',
      kind: 'read',
      status: 'completed',
      locations: [{ path: 'payments/webhooks/refund_handler.py', line: null }],
    },
    createdAt: agoMs(25),
    sequence: 4,
  },
  {
    id: 'msg-5-tool-edit-handler',
    sessionId: HERO_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-edit-handler',
      title: 'Edit payments/webhooks/refund_handler.py',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'payments/webhooks/refund_handler.py', line: 142 }],
    },
    createdAt: agoMs(14),
    sequence: 5,
  },
  {
    id: 'msg-7-tool-bash-tests',
    sessionId: HERO_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-bash-tests',
      title: 'Bash: pytest tests/webhooks/test_refund_idempotency.py -q',
      kind: 'execute',
      status: 'in_progress',
      contentSize: 640,
    },
    createdAt: agoMs(1),
    sequence: 7,
  },
];

const HERO_TOOL_CONTENT = [
  {
    type: 'terminal',
    output:
      'collected 9 items\n\n' +
      'tests/webhooks/test_refund_idempotency.py::test_duplicate_event_short_circuits PASSED\n' +
      'tests/webhooks/test_refund_idempotency.py::test_new_event_processes_normally PASSED\n' +
      'tests/webhooks/test_refund_idempotency.py::test_missing_signature_rejected PASSED\n' +
      'tests/webhooks/test_refund_idempotency.py::test_backfill_marks_existing_events PASSED\n' +
      'tests/webhooks/test_refund_idempotency.py::test_concurrent_retries_single_refund ...',
  },
];

/** Two open review comments on the hero session — drives the header's "2" chip. */
const HERO_COMMENT_THREADS = [
  {
    id: 'comment-1',
    projectId: PROJECT_ID,
    sessionId: HERO_SESSION_ID,
    anchor: { messageId: 'msg-3-assistant', quote: null },
    author: {
      id: NORTHWIND.members[1]?.id ?? 'user-elena',
      kind: 'user',
      name: NORTHWIND.members[1]?.name ?? 'Elena Rossi',
      email: NORTHWIND.members[1]?.email ?? null,
      avatarUrl: null,
    },
    body: 'Double check the backfill batches — run it in chunks so we don’t lock refund_events for the whole 30 days at once.',
    createdAt: agoIso(20),
    updatedAt: agoIso(20),
    status: 'open',
    replies: [],
  },
  {
    id: 'comment-2',
    projectId: PROJECT_ID,
    sessionId: HERO_SESSION_ID,
    anchor: { messageId: 'msg-5-tool-edit-handler', quote: null },
    author: {
      id: NORTHWIND.members[2]?.id ?? 'user-tomas',
      kind: 'user',
      name: NORTHWIND.members[2]?.name ?? 'Tomás Alvarez',
      email: NORTHWIND.members[2]?.email ?? null,
      avatarUrl: null,
    },
    body: 'Confirm this guard also short-circuits on refund.updated, not just refund.created.',
    createdAt: agoIso(12),
    updatedAt: agoIso(12),
    status: 'open',
    replies: [],
  },
];

function makeSleepingSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SLEEPING_SESSION_ID,
    projectId: PROJECT_ID,
    taskId: null,
    topic: 'Stripe webhook signature rotation',
    status: 'sleeping',
    workspaceId: 'ws-webhook-rotation',
    nodeId: 'node-payments-vm-03',
    branch: 'sam/rotate-webhook-signing-secret',
    isMine: true,
    createdAt: agoIso(170),
    updatedAt: agoIso(100),
    stoppedAt: null,
    ...overrides,
  };
}

const SLEEPING_MESSAGES = [
  {
    id: 'msg-sleep-1',
    sessionId: SLEEPING_SESSION_ID,
    role: 'user',
    content: 'Rotate the Stripe webhook signing secret and update the deployed config.',
    toolMetadata: null,
    createdAt: agoMs(170),
    sequence: 1,
  },
  {
    id: 'msg-sleep-2',
    sessionId: SLEEPING_SESSION_ID,
    role: 'assistant',
    content:
      "I'll roll the signing secret with Stripe, push it to both environments, and confirm the next inbound webhook validates before wrapping up.",
    toolMetadata: null,
    createdAt: agoMs(165),
    sequence: 2,
  },
  {
    id: 'msg-sleep-3-tool-bash',
    sessionId: SLEEPING_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-stripe-webhook-update',
      title: 'Bash: stripe webhook_endpoints update we_1Nx... --enabled-events refund.updated,refund.created',
      kind: 'execute',
      status: 'completed',
      contentSize: 256,
    },
    createdAt: agoMs(140),
    sequence: 3,
  },
  {
    id: 'msg-sleep-4-tool-edit',
    sessionId: SLEEPING_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-edit-staging-env',
      title: 'Edit deploy/staging.env',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'deploy/staging.env', line: 8 }],
    },
    createdAt: agoMs(120),
    sequence: 4,
  },
  {
    id: 'msg-sleep-5',
    sessionId: SLEEPING_SESSION_ID,
    role: 'user',
    content: 'Did the staging endpoint pick up the new secret?',
    toolMetadata: null,
    createdAt: agoMs(105),
    sequence: 5,
  },
  {
    id: 'msg-sleep-6',
    sessionId: SLEEPING_SESSION_ID,
    role: 'assistant',
    content:
      'Yes — staging validated a live webhook against the new secret at 16:38 UTC, and production is confirmed on the same value. Going to sleep — send a message if you need anything else.',
    toolMetadata: null,
    createdAt: agoMs(100),
    sequence: 6,
  },
];

// ---------------------------------------------------------------------------
// Common chrome mocks shared by every project-chat screenshot (A, B, C).
// ---------------------------------------------------------------------------

async function respond(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));

async function setupChatChromeMocks(page: Page) {
  await dismissOnboarding(page);
  // Accept every WebSocket connection without forwarding — avoids the
  // "Reconnecting..." banner that would otherwise appear ~3s after a failed
  // real WS handshake against the static preview server.
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
    if (path === '/api/credentials') {
      return respond(route, 200, [{ provider: 'hetzner', status: 'valid' }]);
    }
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path === '/api/agents') return respond(route, 200, { agents: [] });
    if (path === '/api/trial-status' || path === '/api/trial/status') {
      return respond(route, 200, { available: false });
    }
    if (path === '/api/providers/catalog') return respond(route, 200, { catalogs: [] });
    if (path === '/api/report-issue/config') return respond(route, 200, { enabled: false });
    if (path === '/api/terminal/token') return respond(route, 200, { token: 'marketing-token' });
    if (path === '/api/nodes') return respond(route, 200, [HERO_NODE]);
    if (path === '/api/dashboard/active-tasks') return respond(route, 200, { tasks: [] });
    if (path === '/api/chats' || path === '/api/chats/recent') return respond(route, 200, { chats: [] });
    if (path === '/api/account-map') return respond(route, 200, {});

    if (path === `/api/nodes/${HERO_NODE.id}`) return respond(route, 200, HERO_NODE);
    if (path === `/api/workspaces/${HERO_WORKSPACE.id}`) return respond(route, 200, HERO_WORKSPACE);
    if (path.startsWith(`/api/workspaces/${HERO_WORKSPACE.id}/ports`)) {
      return respond(route, 200, { ports: [] });
    }
    if (path.startsWith('/api/workspaces/ws-webhook-rotation')) {
      return respond(route, 200, { ports: [] });
    }
    if (path === '/api/workspaces/ws-webhook-rotation') {
      return respond(route, 200, { ...HERO_WORKSPACE, id: 'ws-webhook-rotation', nodeId: null });
    }

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
      if (subPath === '/sessions') {
        return respond(route, 200, { sessions: SESSION_LIST, total: SESSION_LIST.length });
      }
      if (subPath === '/tasks') return respond(route, 200, { tasks: TASKS, total: TASKS.length });
      if (subPath.match(/^\/tasks\/[^/]+$/)) {
        // Must return a real (non-terminal, non-"undefined") task status —
        // an empty `{}` here fakes an undefined-status task, which
        // `useProjectChatState`'s provisioning-restore effect treats as
        // "still provisioning" and renders ProvisioningIndicator forever
        // over the real chat (rule 24: no duplicate progress UI).
        const taskId = subPath.split('/').pop();
        const found = taskId ? TASK_BY_ID.get(taskId) : undefined;
        return respond(route, 200, found ? { ...found, trigger: null } : {});
      }
      if (subPath === '/agent-profiles') return respond(route, 200, { items: AGENT_PROFILES });
      if (subPath === '/cached-commands') return respond(route, 200, { commands: [] });
      if (subPath === '/commands') return respond(route, 200, { commands: [] });
      if (subPath === '/skills') return respond(route, 200, { skills: [] });
      if (subPath === '/credential-attribution-health') return respond(route, 200, {});
      if (subPath === '' && method === 'GET') return respond(route, 200, MOCK_PROJECT);
      // Session detail — handled per-test below via a more specific route
      // registered afterward (Playwright matches most-recently-registered first).
      return respond(route, 200, {});
    }

    if (path === '/api/projects') {
      return respond(route, 200, { projects: [MOCK_PROJECT], nextCursor: null });
    }

    return respond(route, 200, {});
  });
}

async function gotoChat(page: Page, sessionId: string, hash = '') {
  await page.goto(`/projects/${PROJECT_ID}/chat/${sessionId}${hash}`);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Something went wrong');
}

// ---------------------------------------------------------------------------
// A. Hero — busy active session
// ---------------------------------------------------------------------------

/** The hero session row, shared by the live-session and task-hierarchy captures. */
const HERO_SESSION = {
  id: HERO_SESSION_ID,
  projectId: PROJECT_ID,
  taskId: HERO_TASK_ID,
  topic: 'Add idempotency keys to refund webhook',
  status: 'active',
  workspaceId: HERO_WORKSPACE.id,
  nodeId: HERO_NODE.id,
  branch: 'sam/idempotency-keys-refund-webhook',
  isMine: true,
  agentType: 'claude-code',
  startedAt: agoMs(32),
  createdAt: agoIso(32),
  updatedAt: agoIso(1),
  task: {
    id: HERO_TASK_ID,
    status: 'in_progress',
    executionStep: 'agent_session',
    errorMessage: null,
    outputBranch: 'sam/idempotency-keys-refund-webhook',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'Claude Code — Opus 5',
  },
};

test('sam-hero-live-session', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console:error]', msg.text());
  });
  page.on('requestfailed', (req) => console.log('[requestfailed]', req.url()));

  // The full stack (header + 8-session sidebar + tool rail + plan panel +
  // 3 tool cards with the running Bash row fully clear of the completion
  // dock) does not fit the shared 900px marketing viewport without either
  // hiding the sidebar or clipping the last tool card — use a taller
  // viewport for this capture only.
  await page.setViewportSize({ width: 1440, height: 1050 });

  await setupChatChromeMocks(page);

  await page.route(
    new RegExp(`/api/projects/${PROJECT_ID}/sessions/${HERO_SESSION_ID}(?:\\?.*)?$`),
    (route: Route) =>
      respond(route, 200, {
        session: HERO_SESSION,
        messages: HERO_MESSAGES,
        hasMore: false,
        state: {
          activity: 'prompting',
          activityAt: agoMs(1),
          statusError: null,
          currentPlan: [
            { content: 'Add a unique idempotency_key column + index on refund_events', status: 'completed' },
            { content: 'Guard the refund webhook handler with an idempotency check', status: 'completed' },
            { content: 'Update signature + replay tests to cover the new guard', status: 'in_progress' },
            { content: 'Run the full webhook test suite and fix any regressions', status: 'pending' },
          ],
          planUpdatedAt: agoMs(31),
          promptStartedAt: agoMs(1),
          agentType: 'claude-code',
          lastStopReason: null,
        },
      })
  );

  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${HERO_SESSION_ID}/messages/msg-7-tool-bash-tests/tool-content`,
    (route: Route) => respond(route, 200, { content: HERO_TOOL_CONTENT })
  );

  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${HERO_SESSION_ID}/comments*`,
    (route: Route) => respond(route, 200, { comments: HERO_COMMENT_THREADS })
  );

  await gotoChat(page, HERO_SESSION_ID);

  // Load-bearing content checks before capture — a crashed/empty page must not
  // silently pass through to the screenshot (rule 56 / rule 62).
  await expect(
    page.getByText("Add idempotency keys to the refund webhook handler", { exact: false })
  ).toBeVisible();
  await expect(page.getByText("I'll add idempotency protection in four steps", { exact: false })).toBeVisible();
  await expect(page.getByText('Bash: pytest tests/webhooks/test_refund_idempotency.py -q')).toBeVisible();
  await expect(page.getByText('Read payments/webhooks/refund_handler.py')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  // Two open review comments drive the header's "2" discovery chip.
  await expect(page.getByRole('button', { name: /2 unresolved comments?/ })).toBeVisible();

  // Verify the session header's expandable infra/task-status panel renders
  // correctly, then collapse it again. Left open, its absolutely-positioned
  // FloatingHeader panel (~700px expanded) covers almost the entire
  // conversation — proven once here rather than left open for the capture,
  // which otherwise produces a screenshot of infra details and nothing else.
  const detailsButton = page.getByTestId('session-tool-details').first();
  await detailsButton.click();
  await expect(page.getByText('Agent running')).toBeVisible();
  await expect(page.getByText('cx33', { exact: false }).first()).toBeVisible();
  await detailsButton.click();
  await expect(page.getByText('Agent running')).toHaveCount(0);

  // The composer stays empty with its normal placeholder — the conversation
  // itself (plan + tool cards) is the subject of this shot, not the mention
  // palette, which would hide the bottom third of the chat.
  await expect(page.getByPlaceholder(/Agent is working|Send a message/)).toBeVisible();
  await expect(page.getByPlaceholder(/Agent is working|Send a message/)).toHaveValue('');

  // The CompletionDock's floating "bump" (the red Interrupt button) is
  // deliberately positioned to poke up over the bottom of the scrollable
  // conversation area (see CompletionDock.tsx). Pad the Virtuoso scroller so
  // the last row — the running Bash tool call — clears it for the capture.
  const bashRow = page
    .getByRole('button', { name: /Bash: pytest tests\/webhooks\/test_refund_idempotency\.py/ })
    .first();
  await expect(bashRow).toBeVisible();
  // Fully clear of the dock, not merely present in the DOM — the viewport
  // height above is tuned so the (trimmed) conversation renders without
  // needing to scroll at all, which sidesteps Virtuoso's virtualized-window
  // recycling entirely (manual scrollTop writes and scrollIntoViewIfNeeded
  // were both observed to destabilize/detach the row mid-scroll).
  //
  // Virtuoso measures/settles row heights asynchronously, so a single
  // snapshot of both boxes is a race: it was observed to pass or fail by a
  // few px depending on incidental timing (isolated run vs. full-suite run,
  // font-cache warmth). Poll instead of asserting once, so the check waits
  // out that settling rather than depending on when this line happens to run.
  await expect
    .poll(
      async () => {
        const [rowBox, dockBox] = await Promise.all([
          bashRow.boundingBox(),
          page.getByRole('button', { name: 'Interrupt agent' }).boundingBox(),
        ]);
        if (!rowBox || !dockBox) return Number.POSITIVE_INFINITY;
        return rowBox.y + rowBox.height - dockBox.y;
      },
      {
        message: 'Bash tool row must clear the CompletionDock button',
        timeout: 5_000,
      }
    )
    .toBeLessThan(0);

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-hero-live-session');
});

// ---------------------------------------------------------------------------
// B. Sleeping / waking session
// ---------------------------------------------------------------------------

function sleepingSessionDetailRoute(
  page: Page,
  opts: { wakePhase: string | null; recoveryStatus?: string }
) {
  return page.route(
    new RegExp(`/api/projects/${PROJECT_ID}/sessions/${SLEEPING_SESSION_ID}(?:\\?.*)?$`),
    (route: Route) =>
      respond(route, 200, {
        session: makeSleepingSession(),
        messages: SLEEPING_MESSAGES,
        hasMore: false,
        state: {
          activity: 'idle',
          activityAt: agoMs(100),
          statusError: null,
          currentPlan: null,
          planUpdatedAt: null,
          promptStartedAt: null,
          agentType: 'claude-code',
          lastStopReason: null,
          runtimeWorkState: null,
          runtimeWorkCount: null,
          runtimeWorkSource: null,
          runtimeWorkUpdatedAt: null,
          runtimeWorkProgressAt: null,
          recoveryStatus: opts.recoveryStatus ?? null,
          wakePhase: opts.wakePhase,
        },
      })
  );
}

test('sam-session-sleeping', async ({ page }) => {
  await setupChatChromeMocks(page);
  await sleepingSessionDetailRoute(page, { wakePhase: null, recoveryStatus: null });

  await gotoChat(page, SLEEPING_SESSION_ID);
  await expect(page.getByText('Rotate the Stripe webhook signing secret')).toBeVisible();
  await expect(page.getByText('Bash: stripe webhook_endpoints update', { exact: false })).toBeVisible();
  await expect(page.getByText('Edit deploy/staging.env')).toBeVisible();
  await expect(page.getByText('Did the staging endpoint pick up the new secret?')).toBeVisible();
  await expect(page.getByText('Going to sleep', { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder('Send a message to wake the agent...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive conversation' })).toBeVisible();

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-session-sleeping');
});

test('sam-session-waking', async ({ page }) => {
  await setupChatChromeMocks(page);
  await sleepingSessionDetailRoute(page, {
    wakePhase: 'workspace_creation',
    recoveryStatus: 'waking',
  });

  await page.goto(`/projects/${PROJECT_ID}/chat/${SLEEPING_SESSION_ID}`);
  await page.waitForSelector('[data-testid="wake-progress-banner"]', { timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Something went wrong');
  await expect(page.getByTestId('wake-progress-label')).toHaveText('Recreating your workspace...');
  await expect(page.getByText('Bash: stripe webhook_endpoints update', { exact: false })).toBeVisible();
  await expect(page.getByText('Did the staging endpoint pick up the new secret?')).toBeVisible();
  await expect(page.getByText('Going to sleep', { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder(/Waking the agent/)).toBeVisible();
  // While waking, `agentActivity` is 'recovering' (not idle), so the lifecycle
  // dock's center button morphs to Interrupt — the same "agent is doing
  // something" state as a running prompt. Archive only reappears once the
  // wake settles back to idle.
  await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-session-waking');
});

// ---------------------------------------------------------------------------
// C. Agents orchestration — task hierarchy modal
// ---------------------------------------------------------------------------

test('sam-agents-orchestration', async ({ page }) => {
  await setupChatChromeMocks(page);

  await page.route(
    new RegExp(`/api/projects/${PROJECT_ID}/sessions/${HERO_SESSION_ID}(?:\\?.*)?$`),
    (route: Route) =>
      respond(route, 200, {
        session: HERO_SESSION,
        messages: HERO_MESSAGES,
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

  // Navigating straight to the `#hierarchy-<taskId>` hash opens the modal
  // immediately (ProjectChat derives modal state from the URL hash).
  // Don't use the shared `gotoChat` helper here: the hierarchy modal opens on
  // first render (URL hash already present) and its dialog correctly marks
  // the rest of the page `aria-hidden` while open, so a `role=log` query
  // against the (now inert) chat behind it would never resolve.
  await page.goto(`/projects/${PROJECT_ID}/chat/${HERO_SESSION_ID}#hierarchy-${HERO_TASK_ID}`);
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  // The Dialog primitive's accessible name is generic ("Dialog"); the
  // "Task Hierarchy" title is a visible heading inside it rather than the
  // dialog's aria-label, so match on the dialog role alone and assert content.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Task Hierarchy')).toBeVisible();
  await expect(dialog.getByText('Ship refund idempotency')).toBeVisible();
  await expect(dialog.getByText(/Add idempotency_key migration/)).toBeVisible();
  await expect(dialog.getByText('Update webhook signature verification tests')).toBeVisible();
  await expect(dialog.getByText(/Get sign-off before rotating prod idempotency keys/)).toBeVisible();
  await expect(dialog.getByText('BLOCKED')).toBeVisible();

  await assertNoOverflow(page);

  // A full-viewport capture of a centered ~1000x700 card on an otherwise
  // dimmed/empty backdrop wastes most of the frame. Make the backdrop
  // opaque (same override docs-screenshots.spec.ts uses for dialog crops)
  // and element-crop the panel itself with padding, instead of the page.
  await page.addStyleTag({
    content:
      `.glass-backdrop-dim{background:${OPAQUE_BACKDROP_COLOR} !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`,
  });
  const panel = dialog.locator('.glass-panel-container');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error('Task Hierarchy panel has no bounding box to crop');
  await marketingShotPadded(page, 'sam-agents-orchestration', panelBox);
});

// ---------------------------------------------------------------------------
// D. App deployments
// ---------------------------------------------------------------------------

const DEPLOY_NODE = {
  id: 'node-payments-deploy-staging',
  name: 'payments-deploy-staging',
  status: 'running',
  healthStatus: 'healthy',
  nodeRole: 'deployment',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  ipAddress: '10.30.6.4',
  cloudProvider: 'hetzner',
  providerInstanceType: 'cx33',
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 80,
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: '2026-09-14T10:05:00.000Z',
  errorMessage: null,
  createdAt: '2026-08-01T08:00:00.000Z',
  updatedAt: '2026-09-14T10:05:00.000Z',
  lastMetrics: { cpuLoadAvg1: 0.31, memoryPercent: 38, diskPercent: 24 },
  deploymentEnvironments: [
    { id: 'env-staging', projectId: PROJECT_ID, name: 'staging' },
  ],
};

const DEPLOY_NODE_PROD = {
  ...DEPLOY_NODE,
  id: 'node-payments-deploy-prod',
  name: 'payments-deploy-prod',
  vmSize: 'large',
  ipAddress: '10.30.6.9',
  deploymentEnvironments: [{ id: 'env-production', projectId: PROJECT_ID, name: 'production' }],
};

const STAGING_ENV = {
  id: 'env-staging',
  projectId: PROJECT_ID,
  name: 'staging',
  status: 'active',
  nodeId: DEPLOY_NODE.id,
  provider: 'hetzner',
  location: 'nbg1',
  createdAt: '2026-08-01T08:20:00.000Z',
  updatedAt: '2026-09-14T10:05:00.000Z',
  secretsUpdatedAt: '2026-09-10T09:00:00.000Z',
  observedDeployment: {
    appliedSeq: 14,
    status: 'applied',
    errorMessage: null,
    services: [{ name: 'web', status: 'running', health: 'healthy' }],
    deployStatus: {
      appHealth: 'healthy',
      nodeHealth: 'healthy',
      providerManageability: 'managed',
      routeCertState: 'issued',
      diskPressure: 'normal',
      configDrift: 'none',
    },
    diskTelemetry: { rootDisk: { usedPercent: 27.4 } },
    observedAt: '2026-09-14T10:05:00.000Z',
  },
  agentPolicy: {
    agentDeployEnabled: true,
    agentDeployEnabledBy: NORTHWIND.owner.id,
    agentDeployEnabledAt: '2026-08-01T08:30:00.000Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: ['profile-opus', 'profile-codex'],
  },
  latestRelease: {
    id: 'release-14',
    environmentId: 'env-staging',
    version: 14,
    status: 'applied',
    createdBy: 'Claude Code — Opus 5 / task-ship-refund-idempotency',
    createdAt: '2026-09-14T09:58:00.000Z',
  },
  routeHostnames: ['staging.payments.northwindlabs.dev'],
  node: DEPLOY_NODE,
};

const PRODUCTION_ENV = {
  ...STAGING_ENV,
  id: 'env-production',
  name: 'production',
  nodeId: DEPLOY_NODE_PROD.id,
  observedDeployment: {
    ...STAGING_ENV.observedDeployment,
    appliedSeq: 13,
    diskTelemetry: { rootDisk: { usedPercent: 33.1 } },
  },
  latestRelease: {
    id: 'release-13',
    environmentId: 'env-production',
    version: 13,
    status: 'applied',
    createdBy: 'Claude Code — Opus 5 / task-ship-refund-idempotency',
    createdAt: '2026-09-13T18:20:00.000Z',
  },
  routeHostnames: ['payments.northwindlabs.dev'],
  node: DEPLOY_NODE_PROD,
};

const DEPLOY_CONFIG_VARS = {
  environmentId: 'env-staging',
  updatedAt: '2026-09-10T09:00:00.000Z',
  envVars: [
    { key: 'PUBLIC_APP_DOMAIN', value: 'staging.payments.northwindlabs.dev', isSecret: false, updatedAt: '2026-09-10T09:00:00.000Z' },
    { key: 'LOG_LEVEL', value: 'info', isSecret: false, updatedAt: '2026-09-05T12:00:00.000Z' },
    { key: 'STRIPE_WEBHOOK_SECRET', isSecret: true, updatedAt: '2026-09-13T16:18:00.000Z' },
    { key: 'DATABASE_URL', isSecret: true, updatedAt: '2026-08-01T08:25:00.000Z' },
  ],
};

// A third environment mid-provisioning — makes the list page read as a
// lifecycle (production serving, staging serving, preview still coming up)
// instead of two identical "done" cards.
const DEPLOY_NODE_PREVIEW = {
  ...DEPLOY_NODE,
  id: 'node-payments-deploy-preview',
  name: 'payments-deploy-preview',
  status: 'creating',
  healthStatus: null,
  vmSize: 'small',
  ipAddress: '10.30.6.14',
  lastMetrics: null,
  deploymentEnvironments: [{ id: 'env-preview-pr-482', projectId: PROJECT_ID, name: 'preview-pr-482' }],
};

const PREVIEW_ENV = {
  id: 'env-preview-pr-482',
  projectId: PROJECT_ID,
  name: 'preview-pr-482',
  status: 'starting',
  nodeId: DEPLOY_NODE_PREVIEW.id,
  provider: 'hetzner',
  location: 'nbg1',
  createdAt: agoIso(6),
  updatedAt: agoIso(1),
  secretsUpdatedAt: null,
  observedDeployment: {
    appliedSeq: null,
    status: null,
    errorMessage: null,
    services: null,
    deployStatus: null,
    diskTelemetry: null,
    observedAt: null,
  },
  agentPolicy: {
    agentDeployEnabled: true,
    agentDeployEnabledBy: NORTHWIND.owner.id,
    agentDeployEnabledAt: agoIso(6),
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: ['profile-opus', 'profile-codex'],
  },
  latestRelease: {
    id: 'release-preview-1',
    environmentId: 'env-preview-pr-482',
    version: 1,
    status: 'created',
    createdBy: 'Claude Code — Opus 5 / task-ship-refund-idempotency',
    createdAt: agoIso(5),
  },
  routeHostnames: [],
  node: DEPLOY_NODE_PREVIEW,
};

async function setupDeploymentMocks(page: Page) {
  await dismissOnboarding(page);

  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path.includes('/api/auth/')) return respond(route, 200, MARKETING_USER);
    if (path === '/api/github/installations') return respond(route, 200, []);
    if (path === '/api/notifications') return respond(route, 200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials') return respond(route, 200, [{ provider: 'hetzner', status: 'valid' }]);
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path === '/api/agents') return respond(route, 200, { agents: [] });
    if (path === '/api/trial-status' || path === '/api/trial/status') {
      return respond(route, 200, { available: false });
    }
    if (path === '/api/providers/catalog') return respond(route, 200, { catalogs: [] });
    if (path === '/api/projects') {
      return respond(route, 200, { projects: [MOCK_PROJECT], nextCursor: null });
    }
    if (path === `/api/projects/${PROJECT_ID}` && method === 'GET') {
      return respond(route, 200, MOCK_PROJECT);
    }
    if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      return respond(route, 200, { items: AGENT_PROFILES });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments` && method === 'GET') {
      return respond(route, 200, { environments: [STAGING_ENV, PRODUCTION_ENV, PREVIEW_ENV] });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/env-staging/runtime-config`) {
      return respond(route, 200, DEPLOY_CONFIG_VARS);
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/env-staging/public-routes`) {
      return respond(route, 200, {
        publicRoutes: [
          { id: 'web:8080:0', service: 'web', port: 8080, hostname: 'r1-web-8080-env-staging.apps.sammy.party', hostPort: 36120, routeIndex: 0 },
        ],
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/env-staging/custom-domains`) {
      return respond(route, 200, { customDomains: [] });
    }
    if (path.match(/\/environments\/[^/]+\/(logs|containers|metrics)$/)) {
      return respond(route, 200, { entries: [], containers: [], systemInfo: null, fallbackMetrics: null });
    }
    if (path === `/api/nodes/${DEPLOY_NODE.id}`) return respond(route, 200, DEPLOY_NODE);
    if (path === `/api/nodes/${DEPLOY_NODE_PROD.id}`) return respond(route, 200, DEPLOY_NODE_PROD);
    if (path === `/api/nodes/${DEPLOY_NODE_PREVIEW.id}`) return respond(route, 200, DEPLOY_NODE_PREVIEW);
    if (path === '/api/nodes') return respond(route, 200, [DEPLOY_NODE, DEPLOY_NODE_PROD, DEPLOY_NODE_PREVIEW]);
    if (path === '/api/workspaces') return respond(route, 200, []);

    return respond(route, 200, {});
  });
}

test('deployments list renders the environment lifecycle', async ({ page }) => {
  await setupDeploymentMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/deployments`);

  await expect(page.getByRole('heading', { name: 'staging', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'production', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'preview-pr-482', exact: true })).toBeVisible();
  await expect(page.getByText('v14 · applied')).toBeVisible();
  await expect(page.getByText('v13 · applied')).toBeVisible();
  // The preview card reads as still coming up, not a third "done" clone —
  // pending release, "starting" env status, and an Unknown service state
  // (deriveServiceState() returns 'unknown' for a starting environment).
  await expect(page.getByText('v1 · created')).toBeVisible();
  await expect(page.getByText('starting', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await assertNoOverflow(page);
});

test('sam-app-deployment-detail', async ({ page }) => {
  await setupDeploymentMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/deployments/env-staging`);

  await expect(page.getByRole('heading', { name: 'staging', exact: true })).toBeVisible();
  await expect(page.getByText('Release v14').first()).toBeVisible();
  await expect(page.getByText('staging.payments.northwindlabs.dev')).toBeVisible();
  await expect(page.getByText('Serving', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  await assertNoOverflow(page);
  await marketingShot(page, 'sam-app-deployment-detail');
});
