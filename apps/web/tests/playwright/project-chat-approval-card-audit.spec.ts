import { expect, type Page, type Route, test } from '@playwright/test';
import type { OperationsActionApproval } from '@simple-agent-manager/shared';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

/**
 * In-chat approval cards: an Operations agent's `ops_request_action` call renders as the
 * approval it created, and a superadmin approves or denies it from the conversation.
 */

const PROJECT_ID = 'proj-ops-approvals';
const SESSION_ID = 'sess-ops-approvals';

const ADMIN = { id: 'user-admin', name: 'Admin', email: 'admin@example.com', role: 'superadmin' };
const MEMBER = { id: 'user-member', name: 'Member', email: 'member@example.com', role: 'user' };

const LONG_REASON =
  'Node 01M6GW2S351QXF780VNGNCY4ZP has had zero active workspaces for 3h 12m, well past the warm timeout. ' +
  'ops_why_is_node_alive shows the sweep skipped it 38 times <script>alert(1)</script> 🚨 — see ' +
  'https://app.example.com/admin/infrastructure/nodes/01M6GW2S351QXF780VNGNCY4ZP/very/long/path/that/must/wrap-properly-on-mobile';

const IDS = {
  pending: '01M6H0000000000000000000P1',
  executed: '01M6H0000000000000000000E1',
  expired: '01M6H0000000000000000000X1',
  missing: '01M6H0000000000000000000M1',
};

function approval(overrides: Partial<OperationsActionApproval>): OperationsActionApproval {
  return {
    id: IDS.pending,
    action: 'delete_node',
    targetType: 'node',
    targetId: '01M6GW2S351QXF780VNGNCY4ZP',
    reason: LONG_REASON,
    evidenceSummary: 'ops_why_is_node_alive: kept_active, 0 workspaces; 38 skipped sweeps',
    targetSummary: { status: 'running', healthStatus: 'healthy', nodeRole: 'workspace' },
    requestingProjectId: PROJECT_ID,
    requestingTaskId: '01M6GW2GNDQWT8T9CZPHGT7EFZ',
    requestingSessionId: SESSION_ID,
    requesterUserId: ADMIN.id,
    status: 'pending',
    autoApproved: false,
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    executionResult: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Operations',
  repository: 'user/ops',
  repoProvider: 'github',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Why is node 01M6GW2S alive?',
  status: 'stopped',
  messageCount: 6,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  viewerAccess: 'owner',
  agentType: 'claude-code',
};

/** The compact tool row the API returns for an ops_request_action call. */
function requestRow(id: string, sequence: number) {
  return {
    id: `tool-${id}`,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: `tc-${id}`,
      status: 'completed',
      title: 'mcp__sam-mcp__ops_request_action',
      toolName: 'mcp__sam-mcp__ops_request_action',
      kind: 'other',
      rawOutput: [{ type: 'text', text: JSON.stringify({ approval: { id } }) }],
      contentSize: 900,
    },
    createdAt: Date.now() - 40_000 + sequence * 1000,
    sequence,
  };
}

/**
 * Two short conversations, because the chat list is virtualized and only mounts the rows near
 * the bottom: one with a pending request, one with every settled and failure state.
 */
const PENDING_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Node 01M6GW2S has been up for hours with nothing on it. Clean it up.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  requestRow(IDS.pending, 2),
  {
    id: 'msg-assistant-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'I asked for approval to delete the node. Ending my turn until you decide.',
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 3,
  },
];

const STATE_MESSAGES = [
  requestRow(IDS.executed, 1),
  requestRow(IDS.expired, 2),
  requestRow(IDS.missing, 3),
];

async function setupMocks(page: Page, user: typeof ADMIN, messages: unknown[]) {
  const records = new Map<string, OperationsActionApproval>([
    [IDS.pending, approval({})],
    [
      IDS.executed,
      approval({
        id: IDS.executed,
        action: 'retry_snapshot',
        targetType: 'chat_session',
        targetId: 'chat-9',
        reason: 'x',
        evidenceSummary: null,
        targetSummary: null,
        status: 'executed',
        autoApproved: true,
        decidedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        executedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        executionResult: { message: 'Background snapshot queued' },
      }),
    ],
    [
      IDS.expired,
      approval({
        id: IDS.expired,
        action: 'restart_vm_agent',
        reason: 'VM agent stopped heartbeating.',
        status: 'expired',
        requestingProjectId: 'proj-someone-else',
      }),
    ],
  ]);

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
    user,
  });

  await page.route(
    /\/api\/admin\/operations\/approvals\/[^/?]+(\/decision)?(\?.*)?$/,
    (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      const segments = path.split('/');
      const isDecision = segments[segments.length - 1] === 'decision';
      const id = isDecision ? segments[segments.length - 2]! : segments[segments.length - 1]!;
      const record = records.get(id);
      if (!record)
        return route.fulfill({
          status: 404,
          json: { error: 'NOT_FOUND', message: 'Approval not found' },
        });
      if (isDecision) {
        const { decision } = route.request().postDataJSON() as { decision: 'approve' | 'deny' };
        const decided = {
          ...record,
          status: decision === 'approve' ? 'approved' : 'denied',
          decidedAt: new Date().toISOString(),
          decidedBy: ADMIN.id,
        } as OperationsActionApproval;
        records.set(id, decided);
        return route.fulfill({ status: 200, json: { approval: decided, delivered: true } });
      }
      return route.fulfill({ status: 200, json: { approval: record } });
    }
  );
}

async function auditStates(page: Page, name: string) {
  await setupMocks(page, ADMIN, STATE_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  const cards = page.getByTestId('approval-card');
  const foreign = cards.filter({ hasText: 'Restart VM agent' });
  await expect(foreign.getByText(/requested from another project/)).toBeVisible();
  await expect(foreign.getByText('expired', { exact: true })).toBeVisible();
  // The unknown approval shows a retryable error rather than an empty card.
  await expect(page.getByText(/Couldn't load this approval/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await assertNoOverflow(page);

  // The first card sits above the virtualized window on a phone; scroll up to mount it.
  await page.getByRole('log', { name: 'Conversation' }).hover();
  await page.mouse.wheel(0, -3000);
  await expect(
    cards.filter({ hasText: 'Retry snapshot' }).getByText('executed', { exact: true })
  ).toBeVisible();
  await screenshot(page, `${name}-states`);
  await assertNoOverflow(page);
}

async function auditAdmin(page: Page, name: string) {
  await setupMocks(page, ADMIN, PENDING_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  const pendingCard = page.getByTestId('approval-card');
  await expect(pendingCard).toHaveCount(1);
  await expect(pendingCard.getByText('Delete node')).toBeVisible();
  await expect(pendingCard.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(pendingCard.getByText(/Cannot be undone/)).toBeVisible();
  // Agent-supplied markup in the reason renders as text.
  await expect(pendingCard.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();

  await screenshot(page, `${name}-pending`);
  await assertNoOverflow(page);

  await pendingCard.getByRole('button', { name: 'Approve' }).click();
  await expect(pendingCard.getByText('approved', { exact: true })).toBeVisible();
  await expect(pendingCard.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await screenshot(page, `${name}-approved`);
  await assertNoOverflow(page);
}

test.describe('Project chat approval cards — Mobile', () => {
  test('superadmin approves from the conversation', async ({ page }) => {
    await auditAdmin(page, 'project-chat-approval-cards-mobile');
  });

  test('settled, foreign and missing approvals', async ({ page }) => {
    await auditStates(page, 'project-chat-approval-cards-mobile');
  });

  test('a non-superadmin sees a notice and no decision buttons', async ({ page }) => {
    await setupMocks(page, MEMBER, PENDING_MESSAGES);
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
    await expect(page.getByText(/A superadmin decides/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await screenshot(page, 'project-chat-approval-cards-member-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('Project chat approval cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('superadmin approves from the conversation', async ({ page }) => {
    await auditAdmin(page, 'project-chat-approval-cards-desktop');
  });

  test('settled, foreign and missing approvals', async ({ page }) => {
    await auditStates(page, 'project-chat-approval-cards-desktop');
  });
});
