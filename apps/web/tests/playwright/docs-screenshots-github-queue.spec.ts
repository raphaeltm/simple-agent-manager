/**
 * Documentation screenshot for a busy GitHub automation (Triggers guide, "When a GitHub trigger is
 * busy"): its Recent runs, with events waiting their turn, a follow-up delivered to the chat that
 * is working on the issue, and events that were dropped.
 *
 * Drives the REAL automation page with the shared automation mocks and asserts on what rendered
 * before capturing (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The stress and
 * failure cases live in `github-trigger-queue-audit.spec.ts`; these rows are ordinary, one of each
 * kind a reader is likely to meet.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-github-queue \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import { expandScrollContainers } from './automation-audit-helpers';
import { NOW, PROJECT_ID, setupAutomationMocks, TRIGGERS } from './automation-fixtures';
import { docsShot } from './docs-shot';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const TRIGGER = {
  ...TRIGGERS.github,
  triggerCount: 23,
  githubConfig: { ...TRIGGERS.github.githubConfig, subjectAffinity: true },
  queueStats: { queued: 2, routed: 3, dropped: 3, unconfirmed: 1, retentionDays: 90 },
};

/** One row of `GET …/triggers/:id/executions`, newest first. */
function event(
  sequenceNumber: number,
  status: string,
  issue: number,
  arrivedAgo: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id: `event-docs-${sequenceNumber}`,
    triggerId: TRIGGER.id,
    projectId: PROJECT_ID,
    status,
    skipReason: null,
    taskId: null,
    queueExpiresAt: null,
    routedTaskId: null,
    subjectKey: `github:42:${issue}`,
    routedSessionId: null,
    eventType: 'github.issue_comment.created',
    renderedPrompt: 'Answer the new /sam comment',
    errorMessage: null,
    scheduledAt: iso(-arrivedAgo),
    startedAt: null,
    completedAt: null,
    sequenceNumber,
    createdAt: iso(-arrivedAgo),
    ...extra,
  };
}

// One of each outcome a reader is likely to meet, newest first. Dropped events show when they were
// dropped, which for an expired one is a day after it arrived.
const EVENTS = [
  event(23, 'waiting', 118, 2 * MIN),
  event(22, 'waiting', 121, 4 * MIN),
  event(21, 'routing', 112, 6 * MIN, {
    routedTaskId: 'task-docs-112',
    routedSessionId: 'chat-docs-112',
  }),
  event(20, 'routed', 109, 25 * MIN, {
    routedTaskId: 'task-docs-109',
    routedSessionId: 'chat-docs-109',
    completedAt: iso(-24 * MIN),
  }),
  event(16, 'dropped', 104, 3 * HOUR, {
    skipReason: 'delivery_uncertain',
    routedTaskId: 'task-docs-104',
    routedSessionId: 'chat-docs-104',
    completedAt: iso(-3 * HOUR),
  }),
  event(12, 'dropped', 84, 49 * HOUR, {
    skipReason: 'queue_expired',
    completedAt: iso(-25 * HOUR),
  }),
  event(9, 'dropped', 79, 50 * HOUR, { skipReason: 'queue_full', completedAt: iso(-50 * HOUR) }),
];

async function openTrigger(page: Page) {
  await setupAutomationMocks(page);
  await page.route(`**/api/projects/${PROJECT_ID}/triggers/${TRIGGER.id}`, (route) =>
    route.fulfill({ json: TRIGGER })
  );
  await page.route(`**/api/projects/${PROJECT_ID}/triggers/${TRIGGER.id}/executions*`, (route) =>
    route.fulfill({ json: { executions: EVENTS, nextCursor: '20' } })
  );
  await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${TRIGGER.id}`);
  const runs = page.locator('#runs');
  await expect(runs.getByTestId('github-event-queue')).toContainText(
    'GitHub events: 2 waiting now · History (up to 90 days): 3 delivered · 3 dropped · 1 unconfirmed'
  );
  await expect(runs.getByTestId('trigger-run')).toHaveCount(EVENTS.length);
  await expect(runs.getByText('Queued until a run finishes').first()).toBeVisible();
  await expect(runs.getByText('Delivered to the running chat')).toBeVisible();
  await expect(runs.getByText('Waiting for the running chat to take it')).toBeVisible();
  await expect(runs.getByText('Dropped: queue was full')).toBeVisible();
  await expect(runs.getByText('Dropped: waiting time expired')).toBeVisible();
  await expect(
    runs.getByText('May have reached the chat, but SAM could not confirm it')
  ).toBeVisible();
  await expect(runs.getByText('Event 21 · #112', { exact: false })).toBeVisible();
  await expect(runs.getByRole('button', { name: 'Show older runs' })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  return runs;
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: a busy GitHub automation’s recent runs', async ({ page }) => {
  const runs = await openTrigger(page);
  await page.mouse.move(2, 2);
  // The list is taller than a phone screen: size the page to its content so nothing is cut off,
  // and give the list a margin so the image doesn't end at the panel's border.
  await expandScrollContainers(page);
  await runs.evaluate((element) => {
    element.style.padding = '12px';
  });
  await docsShot(page, isMobile(page) ? 'github-queue-runs-mobile' : 'github-queue-runs', runs);
});
