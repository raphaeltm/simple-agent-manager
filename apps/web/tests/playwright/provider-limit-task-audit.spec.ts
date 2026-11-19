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
    providerLimitVersion: `wait-${i}`,
    providerLimitReason:
      i === 1
        ? 'Blocked: provider limit wait budget exhausted. Review the provider limit before resuming.'
        : stress && i === 0
          ? `Waiting for provider limit reset at 13:00 UTC (2026-10-12). ${'unbroken'.repeat(35)}`
          : 'Waiting for provider limit reset at 13:00 UTC (2026-10-12).',
  }));
}
for (const theme of ['sam', 'sam-light'] as const) {
  for (const scenario of ['normal', 'stress', 'empty', 'error'] as const) {
    test(`provider limit dashboard ${scenario} ${theme}`, async ({ page }) => {
      await page.addInitScript(
        (value) => {
          localStorage.setItem('sam-theme', value);
        },
        theme === 'sam-light' ? 'light' : 'dark'
      );
      let resumeRequests = 0;
      await setupAuditRoutes(page, (path, respond) => {
        if (path === '/api/projects/provider-project/tasks/task-1/provider-limit/resume') {
          resumeRequests++;
          return respond(202, { status: 'waking', taskId: 'task-1' });
        }
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
      await page.evaluate((value) => {
        document.documentElement.dataset.uiTheme = value;
      }, theme);
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
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2
            );
            if (hit === element || element.contains(hit)) return true;
            // A native navigation overlay intentionally owns the card's noninteractive text.
            // Require this exact card's named control so a sticky header or another card still fails.
            const card = element.parentElement;
            const title = card?.querySelector('.sam-type-card-title')?.textContent;
            const navigation = card?.querySelector('button[aria-label]');
            return (
              hit === navigation &&
              navigation instanceof HTMLButtonElement &&
              navigation.getAttribute('aria-label') === `Open task: ${title}` &&
              !navigation.contains(element)
            );
          })
        ).toBe(true);
        await screenshot(page, `provider-limit-dashboard-${scenario}-${theme}`, {
          scopeToProject: true,
        });
        const resume = page.getByRole('button', { name: 'Resume task', exact: true });
        await resume.scrollIntoViewIfNeeded();
        expect(
          await resume.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2
            );
            return hit === element || element.contains(hit);
          })
        ).toBe(true);
        const pointerRequest = page.waitForRequest(
          (request) =>
            request.url().endsWith('/tasks/task-1/provider-limit/resume') &&
            request.method() === 'POST'
        );
        await resume.click();
        await pointerRequest;
        await expect(page.getByRole('button', { name: 'Waking…', exact: true })).toBeDisabled();
        await expect(page).toHaveURL(/\/dashboard$/);
        expect(resumeRequests).toBe(1);
        // Reload the same blocked fixture to exercise the independent native keyboard action.
        await page.reload();
        await page.evaluate((value) => {
          document.documentElement.dataset.uiTheme = value;
        }, theme);
        const keyboardResume = page.getByRole('button', { name: 'Resume task', exact: true });
        await keyboardResume.focus();
        await expect(keyboardResume).toBeFocused();
        const keyboardRequest = page.waitForRequest(
          (request) =>
            request.url().endsWith('/tasks/task-1/provider-limit/resume') &&
            request.method() === 'POST'
        );
        await keyboardResume.press('Space');
        await keyboardRequest;
        await expect(page.getByRole('button', { name: 'Waking…', exact: true })).toBeDisabled();
        await expect(page).toHaveURL(/\/dashboard$/);
        expect(resumeRequests).toBe(2);
      }
      if (scenario === 'empty') await expect(page.getByText('No active tasks')).toBeVisible();
      if (scenario === 'error')
        await expect(page.getByRole('alert')).toContainText('Try again later', { timeout: 20_000 });
      await assertNoOverflow(page);
      await screenshot(page, `provider-limit-dashboard-${scenario}-${theme}-after-action`, {
        scopeToProject: true,
      });
    });
  }
}
