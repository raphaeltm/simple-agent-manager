/**
 * Documentation screenshots for reading and answering an agent's question from a
 * notification (Notifications guide, "Read and answer an agent's question").
 *
 * Drives the REAL notification bell and question reader with mocked API data. The
 * stress, failure and free-text cases live in `notification-question-audit.spec.ts`;
 * this fixture uses an ordinary, fictional question.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-notifications \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import { docsShot } from './docs-shot';

const NOW = Date.parse('2026-11-02T14:30:00Z');
const MIN = 60_000;

const QUESTION = [
  '## Migrate receipts in place, or add a new table?',
  '',
  'The `receipts` table has 4.2 million rows, and two services read it directly. I can either:',
  '',
  '1. **Migrate in place**: add the new columns with defaults and backfill them in batches of 10,000. No reader changes, but the backfill runs for about 40 minutes.',
  '2. **Add a new table**: write to both tables, move each reader over, then drop the old one. Easier to roll back, but it touches both services.',
  '',
  'I would migrate in place unless you expect to roll back. Which do you prefer?',
].join('\n');

const OPTIONS = ['Migrate in place', 'Add a new table'];

const NOTIFICATION = {
  id: 'n-question',
  type: 'needs_input',
  urgency: 'high',
  title: 'Input needed: add tax columns to receipts',
  body: 'Migrate receipts in place, or add a new table? The receipts table has 4.2 million rows…',
  projectId: 'p-payments',
  sessionId: 's-receipts',
  taskId: 't-receipts',
  actionUrl: '/projects/p-payments/chat/s-receipts',
  metadata: { projectName: 'payments-api', attentionMarkerId: 'att-1', options: OPTIONS },
  createdAt: new Date(NOW - 4 * MIN).toISOString(),
  readAt: null,
  dismissedAt: null,
};

const UPDATES = [
  {
    ...NOTIFICATION,
    id: 'n-done',
    type: 'task_complete',
    urgency: 'medium',
    title: 'Finished: fix webhook retries',
    body: 'Duplicate deliveries now return 200 and write nothing.',
    sessionId: 's-webhooks',
    metadata: { projectName: 'payments-api' },
    createdAt: new Date(NOW - 50 * MIN).toISOString(),
  },
];

const USER = {
  id: 'user-dana',
  name: 'Dana Reyes',
  email: 'dana@example.com',
  role: 'user',
  status: 'active',
  emailVerified: true,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

async function setup(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((userId) => {
    localStorage.setItem('sam-theme', 'dark');
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.id);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.includes('/api/auth/')) {
      return route.fulfill({
        json: {
          user: USER,
          session: { id: 'auth', userId: USER.id, expiresAt: '2099-01-01T00:00:00.000Z' },
        },
      });
    }
    if (path.endsWith('/attention/att-1')) {
      return route.fulfill({
        json: {
          request: {
            id: 'att-1',
            reason: QUESTION,
            options: OPTIONS,
            createdAt: NOW - 4 * MIN,
            resolvedAt: null,
            resolvedAnswer: null,
            expired: false,
            canAnswer: true,
          },
          session: { id: 's-receipts', topic: 'Add tax columns to receipts' },
          messages: url.searchParams.has('context')
            ? [
                {
                  id: 'm-1',
                  role: 'user',
                  createdAt: NOW - 20 * MIN,
                  content:
                    'Add currency and tax columns to receipts so the invoice export can stop recomputing them.',
                },
                {
                  id: 'm-2',
                  role: 'assistant',
                  createdAt: NOW - 6 * MIN,
                  content:
                    'I read the schema and both readers. The export service and the refunds worker query receipts directly, so the migration choice affects both.',
                },
              ]
            : [],
        },
      });
    }
    if (path.includes('/api/notifications/unread-count')) {
      return route.fulfill({ json: { count: 1 } });
    }
    if (path.includes('/api/notifications')) {
      return route.fulfill({
        json: { notifications: [NOTIFICATION, ...UPDATES], nextCursor: null, unreadCount: 1 },
      });
    }
    if (path.includes('/api/projects')) {
      return route.fulfill({ json: { projects: [], sessions: [], tasks: [], total: 0 } });
    }
    if (path.includes('/api/credentials')) return route.fulfill({ json: [] });
    return route.fulfill({
      json: { tasks: [], agents: [], nodes: [], profiles: [], sessions: [], total: 0 },
    });
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

async function openBell(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /notifications/i }).click();
  const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole('button', { name: 'Read question & context' })).toBeVisible();
  return inbox;
}

test('docs: an agent question in the notification bell', async ({ page }) => {
  test.skip(isMobile(page), 'The bell item reads the same on a phone');
  await setup(page);
  const inbox = await openBell(page);
  await expect(inbox.getByRole('button', { name: 'Migrate in place', exact: true })).toBeVisible();
  await page.mouse.move(2, 2);
  await docsShot(page, 'notification-question-bell', inbox);
});

test('docs: the question reader, with earlier context on a desktop', async ({ page }) => {
  await setup(page);
  const inbox = await openBell(page);
  await inbox.getByRole('button', { name: 'Read question & context' }).click();
  const dialog = page.getByRole('dialog', { name: 'Question from your agent' });
  await expect(
    dialog.getByRole('heading', { name: 'Migrate receipts in place, or add a new table?' })
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Migrate in place', exact: true })).toBeVisible();
  await page.mouse.move(2, 2);
  // On a phone the earlier context would push the question off screen, so show the question.
  if (isMobile(page)) {
    await expect(dialog.getByRole('button', { name: 'Show earlier context' })).toBeVisible();
    await docsShot(page, 'notification-question-reader-mobile');
    return;
  }
  await dialog.getByRole('button', { name: 'Show earlier context' }).click();
  await expect(dialog.getByText(/Add currency and tax columns/)).toBeVisible();
  await docsShot(page, 'notification-question-reader', dialog);
});
