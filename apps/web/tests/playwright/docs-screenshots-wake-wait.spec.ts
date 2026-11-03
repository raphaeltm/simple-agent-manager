/**
 * Documentation screenshots for a waking chat that says why it is waiting (Session
 * troubleshooting guide, "Recovery is in progress"), on a desktop and a phone.
 *
 * Mounts the REAL project chat route with a sleeping session whose state carries
 * `recoveryStatus: 'waking'`, `wakePhase: 'waiting_for_node_capacity'` and a wait reason,
 * the shape `routes/chat/wake-state.ts` returns while a claimed wake waits for a machine.
 * Every reason and phase is audited in `wake-progress-audit.spec.ts`; this fixture uses one
 * ordinary, fictional chat.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-wake-wait \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import {
  makeIdleSessionState,
  makeMockProject,
  makeMockUser,
  setupSleepingChatMocks,
} from './audit-helpers';
import { docsShot } from './docs-shot';

const NOW = Date.parse('2026-11-02T14:30:00Z');
const MIN = 60_000;

const USER = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-wake',
  userId: 'user-dana',
});

const PROJECT = makeMockProject({
  id: 'proj-payments',
  name: 'acme/payments-api',
  repository: 'acme/payments-api',
  userId: USER.user.id,
});

const SESSION = {
  id: 'sess-receipts',
  projectId: 'proj-payments',
  taskId: 'task-receipts',
  topic: 'Add tax columns to receipts',
  status: 'sleeping',
  workspaceId: 'ws-receipts',
  nodeId: 'node-receipts',
  branch: 'sam/receipts-tax-columns',
  createdAt: new Date(NOW - 3 * 60 * MIN).toISOString(),
  updatedAt: new Date(NOW - 2 * MIN).toISOString(),
  stoppedAt: null,
  viewerAccess: 'owner',
  isMine: true,
};

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: SESSION.id,
    role: 'user',
    content:
      'Add currency and tax columns to receipts so the invoice export stops recomputing them.',
    messageIndex: 0,
    createdAt: new Date(NOW - 3 * 60 * MIN).toISOString(),
  },
  {
    id: 'msg-2',
    sessionId: SESSION.id,
    role: 'assistant',
    content:
      'Done: the migration adds both columns with defaults, the backfill ran in batches, and the export reads the stored values now. The branch is pushed.',
    messageIndex: 1,
    createdAt: new Date(NOW - 2 * 60 * MIN).toISOString(),
  },
  {
    id: 'msg-3',
    sessionId: SESSION.id,
    role: 'user',
    content: 'Thanks. Can you also add a test for receipts created before the migration?',
    messageIndex: 2,
    createdAt: new Date(NOW - 2 * MIN).toISOString(),
  },
];

async function openWakingChat(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((userId) => {
    window.localStorage.setItem('sam-theme', 'dark');
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupSleepingChatMocks(page, {
    user: USER,
    project: PROJECT,
    session: SESSION,
    messages: MESSAGES,
    state: makeIdleSessionState({
      recoveryStatus: 'waking',
      wakePhase: 'waiting_for_node_capacity',
      waitReason: 'provider_transient_capacity',
      waitRetryAt: new Date(NOW + 4 * MIN).toISOString(),
    }),
    ownTask: {
      id: SESSION.taskId,
      status: 'queued',
      executionStep: 'node_selection',
      errorMessage: null,
      outputBranch: SESSION.branch,
      startedAt: SESSION.createdAt,
      workspaceId: null,
    },
  });
  await page.goto(`/projects/${PROJECT.id}/chat/${SESSION.id}`);
  await expect(page.getByTestId('wake-progress-label')).toHaveText(
    /^Your cloud provider has no capacity right now\. Retrying\.\.\. Next try at .+\.$/
  );
  await expect(page.getByText(/test for receipts created before the migration/)).toBeVisible();
  // The owner's own chat: the composer, not the read-only notice teammates see.
  await expect(page.getByText('Only the creator can message this agent')).toHaveCount(0);
  await page.mouse.move(2, 2);
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: a waking chat says why it is waiting', async ({ page }) => {
  await openWakingChat(page);
  if (isMobile(page)) {
    await docsShot(page, 'chat-wake-waiting-mobile');
    return;
  }
  // The chat column only: the app navigation and session list are not what the guide is about.
  const log = await page.getByRole('log', { name: 'Conversation' }).boundingBox();
  const viewport = page.viewportSize();
  if (!log || !viewport) throw new Error('conversation or viewport has no geometry');
  await docsShot(page, 'chat-wake-waiting', {
    clip: { x: log.x, y: 0, width: viewport.width - log.x, height: viewport.height },
  });
});
