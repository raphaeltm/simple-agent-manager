/**
 * Documentation screenshot for Admin → Storage's Abandon dialog (self-hosting guide),
 * taken at phone width because that is where operators most often use it.
 *
 * Drives the REAL page with mocked admin API data and opens the dialog the way an
 * operator does, asserting on what rendered so a component that stops rendering fails
 * the capture instead of shipping a stale image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The stress cases for this
 * page (long text, markup in reasons, empty and error states) live in
 * `admin-storage-audit.spec.ts`; these fixtures are deliberately ordinary, because they
 * are what a reader will compare their own page against.
 *
 * Write the committed image with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-admin-storage --project="iPhone SE (375x667)"
 *
 * The committed PNGs were then palette-compressed (about 5x smaller, no visible change), from
 * apps/www: sharp(file).png({ palette: true, quality: 90, effort: 10, dither: 0.6 }).
 */
import { expect, type Page, test } from '@playwright/test';

import { makeMockUser, seedTheme, setupAuditRoutes } from './audit-helpers';
import { docsShot, opaqueBackdrop } from './docs-shot';

const ADMIN_USER = makeMockUser({
  email: 'operator@example.com',
  name: 'Operator',
  role: 'superadmin',
  sessionId: 'session-docs-admin-storage',
  userId: 'user-docs-admin-storage',
});

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PROJECT_ID = '01KDOCSCHECKOUTSERVICE00001';

const PROBLEM_MIGRATIONS = {
  migrations: [
    {
      migrationId: '9c41e2d7',
      projectId: PROJECT_ID,
      sessionId: 'b7f3c2a1-5e8d-4c6b-9a0f-2d1e3c4b5a69',
      state: 'poisoned',
      sourceOwnerName: 'g1:s12',
      targetOwnerName: 'g1:a3',
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 3,
      errorCode: 'compact_archive_deadline_exceeded',
      errorMessage: 'Compact archive R2 deadline exceeded after 3 attempts',
      frozenAt: null,
      poisonedAt: NOW - 6 * HOUR,
      updatedAt: NOW - 6 * HOUR,
    },
    {
      migrationId: '3f0a8b55',
      projectId: PROJECT_ID,
      sessionId: 'e2c9a4f0-1b7d-4e3a-8c5f-6d0b9a1e2f38',
      state: 'frozen',
      sourceOwnerName: 'g1:s4',
      targetOwnerName: 'g1:a1',
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      errorCode: 'precopy_refused',
      errorMessage: 'Session was still active when the sweep tried to copy it',
      frozenAt: NOW - 2 * DAY,
      poisonedAt: null,
      updatedAt: NOW - 2 * DAY,
    },
    {
      migrationId: 'a17d6c90',
      projectId: PROJECT_ID,
      sessionId: '4d8e1f2a-9b3c-4a5d-8e6f-0a1b2c3d4e5f',
      state: 'failed',
      sourceOwnerName: 'g1:s7',
      targetOwnerName: 'g1:a2',
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      errorCode: 'copy_chunk_failed',
      errorMessage: 'Copy chunk 3/12 failed: R2 put returned 503',
      frozenAt: null,
      poisonedAt: null,
      updatedAt: NOW - 40 * 60_000,
    },
  ],
  warnings: [],
  limit: 25,
};

const BREAKERS = {
  breakers: [
    {
      projectId: PROJECT_ID,
      projectName: 'acme/checkout-service',
      repository: 'acme/checkout-service',
      state: 'open',
      reason: 'attempts_exhausted: compact archive R2 deadline exceeded',
      openedAt: NOW - 6 * HOUR,
      updatedAt: NOW - 6 * HOUR,
    },
  ],
  skippedRows: 0,
  limit: 25,
};

const TELEMETRY = {
  telemetry: [
    {
      project_id: PROJECT_ID,
      project_name: 'acme/checkout-service',
      repository: 'acme/checkout-service',
      measured_at: NOW - 5 * 60_000,
      database_size_bytes: 8_412_000_000,
      limit_bytes: 10_000_000_000,
      usage_ratio: 0.8412,
      status: 'warning',
      growth_rate_bytes_per_day: 42_000_000,
      estimated_days_to_limit: 37,
      cleanup_health: 'running',
      last_error: null,
      updated_at: NOW - 5 * 60_000,
    },
  ],
};

async function openStoragePage(page: Page) {
  await seedTheme(page, 'dark');
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, ADMIN_USER.user.id);
  await setupAuditRoutes(page, (path, respond) => {
    if (path === '/api/auth/get-session') return respond(200, ADMIN_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/admin/project-data/storage/archive-sharding/problem-migrations') {
      return respond(200, PROBLEM_MIGRATIONS);
    }
    if (path === '/api/admin/project-data/storage/archive-sharding/circuit-breakers') {
      return respond(200, BREAKERS);
    }
    if (path === '/api/admin/project-data/storage') return respond(200, TELEMETRY);
    return undefined;
  });

  await page.goto('/admin/storage');
  // Liveness: without this, every capture below would happily screenshot a crash page.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Problem migrations' }) });
  await expect(section).toBeVisible({ timeout: 20000 });
  // One card per state the guide's badge table explains, each wearing its own badge.
  // (`span`: the card's "Poisoned"/"Frozen" timestamp labels repeat the word as a `dt`.)
  const badges: Record<string, string> = {
    '9c41e2d7': 'Poisoned',
    '3f0a8b55': 'Frozen',
    a17d6c90: 'Failed',
  };
  for (const [migrationId, badge] of Object.entries(badges)) {
    await expect(
      section
        .getByTestId(`migration-${migrationId}`)
        .locator('span')
        .filter({ hasText: new RegExp(`^${badge}$`) })
    ).toBeVisible();
  }
  await expect(section.getByRole('button', { name: 'Abandon' })).toHaveCount(3);
  return section;
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: admin storage abandon dialog on mobile', async ({ page }) => {
  test.skip(!isMobile(page), 'mobile capture');
  const section = await openStoragePage(page);

  // Open the dialog from the frozen migration's own button, as an operator would.
  await section.getByTestId('migration-3f0a8b55').getByRole('button', { name: 'Abandon' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Abandon migration' })).toBeVisible();
  await expect(dialog).toContainText('3f0a8b55');
  // The guide says a reason is required: the submit is disabled until one is typed.
  const submit = dialog.getByRole('button', { name: 'Abandon migration' });
  await expect(submit).toBeDisabled();
  await dialog
    .getByPlaceholder('Why is this migration being abandoned?')
    .fill('Session ended before any copy');
  await expect(submit).toBeEnabled();

  // The page behind the dialog would otherwise bleed through its translucent backdrop.
  await opaqueBackdrop(page);
  await docsShot(page, 'admin-storage-abandon-dialog-mobile');
});
