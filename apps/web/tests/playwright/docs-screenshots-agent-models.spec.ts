/**
 * Documentation screenshot for "Choose the models for a project" in the AI models guide
 * (apps/www/src/content/docs/docs/guides/ai-models-for-agents.md): the AI Models section of
 * Project settings → Agents, with this month's spend, the models used and the monthly limit.
 *
 * Drives the REAL project settings page with mocked API data and asserts on what rendered before
 * capturing (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). It uses the real
 * Workers AI catalog fixture and the shipped defaults ($5 a month, at most $50). Edge cases
 * (retired models, exhausted budget, read-only, errors) live in `agent-models-audit.spec.ts`.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-agent-models \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import { NORMAL_CATALOG_RESPONSE } from './agent-models-fixtures';
import { makeMockUser, seedTheme } from './audit-helpers';
import { setupAuditRoutes } from './audit-routes';
import { docsShot } from './docs-shot';

const USER = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-agent-models',
  userId: 'user-docs-agent-models',
});

const PROJECT = {
  id: 'proj-docs-agent-models',
  name: 'Payments API',
  repository: 'acme/payments-api',
  defaultBranch: 'main',
  userId: USER.user.id,
  githubInstallationId: 'inst-docs',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

// The decision and extraction models the guide's examples use, both in SAM's recommended set.
const DECISION_MODEL = '@cf/cloudflare/clef-flash';
const EXTRACTION_MODEL = '@cf/cloudflare/clairic';

/** SAM's recommended models, $1.20 of the default $5.00 used this month. */
const SETTINGS = {
  featureEnabled: true,
  models: null,
  effectiveModelIds: NORMAL_CATALOG_RESPONSE.defaultModelIds,
  effectiveSource: 'default',
  monthlyBudgetUsd: null,
  effectiveMonthlyBudgetUsd: 5,
  defaultMonthlyBudgetUsd: 5,
  maxMonthlyBudgetUsd: 50,
  usage: {
    month: '2026-10',
    spentUsd: 1.2,
    reservedUsd: 0,
    callCount: 86,
    resetsAt: '2026-11-01T00:00:00.000Z',
    byModel: [
      {
        modelId: DECISION_MODEL,
        callCount: 61,
        errorCount: 0,
        spentUsd: 0.84,
        lastCalledAt: '2026-10-26T16:00:00.000Z',
      },
      {
        modelId: EXTRACTION_MODEL,
        callCount: 25,
        errorCount: 1,
        spentUsd: 0.36,
        lastCalledAt: '2026-10-25T09:00:00.000Z',
      },
    ],
  },
  canEdit: true,
};

async function setupMocks(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [PROJECT], nextCursor: null });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/credentials/agent')
      return respond(200, { credentials: [{ agentType: 'claude-code', isActive: true }] });
    if (path === '/api/credentials')
      return respond(200, [{ id: 'cred-docs', provider: 'hetzner', createdAt: '2026-09-01' }]);
    if (path === '/api/github/installations')
      return respond(200, [{ id: 'inst-docs', accountName: 'acme', accountType: 'Organization' }]);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agent-models/catalog') return respond(200, NORMAL_CATALOG_RESPONSE);
    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return undefined;
    const sub = match[2] ?? '';
    if (sub === '/agent-models') return respond(200, SETTINGS);
    if (sub === '/credentials') return respond(200, { credentials: [] });
    if (sub === '/agent-profiles') return respond(200, { items: [] });
    if (sub === '/agent-profiles/picker')
      return respond(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
    if (sub === '/skills') return respond(200, { items: [] });
    if (sub === '/members') return respond(200, { members: [] });
    if (sub === '/runtime-config') return respond(200, { envVars: [], files: [] });
    if (sub === '') return respond(200, PROJECT);
    return undefined;
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: a project’s AI Models settings', async ({ page }) => {
  expect(NORMAL_CATALOG_RESPONSE.defaultModelIds).toEqual(
    expect.arrayContaining([DECISION_MODEL, EXTRACTION_MODEL])
  );
  await seedTheme(page, 'dark');
  // At 1280px the section is about 1,030px wide and the docs column would shrink its text; at
  // 1024px it is close to the column's width, so the image shows near its real size.
  if (!isMobile(page)) await page.setViewportSize({ width: 1024, height: 800 });
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT.id}/settings/agents`);

  const heading = page.getByRole('heading', { name: 'AI Models' });
  await expect(heading).toBeVisible();
  const section = heading.locator('xpath=ancestor::section[1]');
  await expect(section.getByText(/\$1\.20 of \$5\.00 used this month/)).toBeVisible();
  await expect(section.getByText(/Recommended · /)).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Used this month' })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  await section.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2);
  await docsShot(
    page,
    isMobile(page) ? 'agent-models-settings-mobile' : 'agent-models-settings',
    section
  );
});
