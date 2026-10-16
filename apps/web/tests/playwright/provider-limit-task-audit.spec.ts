import { expect, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const USER = makeMockUser({
  email: 'provider-test@example.test',
  name: 'Provider tester',
  sessionId: 'provider-session',
  userId: 'provider-user',
});
const now = new Date().toISOString();
function tasks(stress: boolean) {
  return Array.from({ length: stress ? 30 : 3 }, (_, i) => ({
    id: `task-${i}`,
    title: stress && i === 0 ? 'Long task 日本語 🚀 <script> '.repeat(15) : `Provider task ${i}`,
    status: i === 1 ? 'queued' : 'sleeping',
    executionStep: null,
    projectId: 'provider-project',
    projectName: 'Provider recovery',
    sessionId: `chat-${i}`,
    createdAt: now,
    startedAt: now,
    lastMessageAt: Date.now(),
    messageCount: 2,
    isActive: true,
    agentActivityState: 'sleeping',
    providerLimitReason:
      i === 1
        ? 'Blocked: provider limit wait budget exhausted. Review the provider limit before resuming.'
        : stress && i === 0
          ? `Waiting for provider limit reset at 13:00 UTC (2026-10-12). ${'unbroken'.repeat(35)}`
          : 'Waiting for provider limit reset at 13:00 UTC (2026-10-12).',
  }));
}
for (const scenario of ['normal', 'stress', 'empty', 'error'] as const) {
  test(`provider limit dashboard ${scenario}`, async ({ page }) => {
    await setupAuditRoutes(page, (path, respond) => {
      if (path.includes('/api/auth/')) return respond(200, USER);
      if (path === '/api/dashboard/active-tasks')
        return scenario === 'error'
          ? respond(500, { error: 'INTERNAL_ERROR', message: 'Try again later' })
          : respond(200, { tasks: scenario === 'empty' ? [] : tasks(scenario === 'stress') });
      if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
      if (path === '/api/credentials')
        return respond(200, [{ id: 'already-configured', provider: 'hetzner', status: 'valid' }]);
      if (path === '/api/github/installations')
        return respond(200, [{ id: 'existing', account: { login: 'provider-test' } }]);
      if (path === '/api/credentials/agent')
        return respond(200, {
          credentials: [
            { agentType: 'openai-codex', isActive: true, credentialKind: 'oauth-token' },
          ],
        });
      if (path === '/api/nodes' || path === '/api/workspaces') return respond(200, []);
      if (path.startsWith('/api/notifications'))
        return respond(200, { notifications: [], unreadCount: 0 });
      if (path === '/api/agents') return respond(200, []);
      return undefined;
    });
    await page.goto('/dashboard');
    const wizard = page.getByTestId('onboarding-wizard');
    if (await wizard.isVisible()) await page.getByRole('button', { name: 'Exit setup' }).click();
    await expect(wizard).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active Tasks' })).toBeVisible();
    if (scenario === 'normal' || scenario === 'stress') {
      await expect(
        page.getByRole('status').filter({ hasText: 'Waiting for provider limit reset' }).first()
      ).toBeVisible();
      await expect(
        page.getByText('Blocked: provider limit wait budget exhausted.', { exact: false }).first()
      ).toBeVisible();
      await expect(page.getByText('Provider recovery').first()).toBeVisible();
      const reason = page
        .getByRole('status')
        .filter({ hasText: 'Waiting for provider limit reset' })
        .first();
      await reason.scrollIntoViewIfNeeded();
      expect(
        await reason.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit === element || element.contains(hit);
        })
      ).toBe(true);
    }
    if (scenario === 'empty') await expect(page.getByText('No active tasks')).toBeVisible();
    if (scenario === 'error')
      await expect(page.getByRole('alert')).toContainText('Try again later', { timeout: 20_000 });
    await assertNoOverflow(page);
    await screenshot(page, `provider-limit-dashboard-${scenario}`, { scopeToProject: true });
  });
}
