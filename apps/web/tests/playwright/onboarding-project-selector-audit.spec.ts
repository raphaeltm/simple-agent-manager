/**
 * Visual and payload audit for the onboarding project selector.
 *
 * Regression target: selecting a GitHub repository displayed `owner/repo` in
 * the dropdown, but project creation submitted a generated Git URL. The
 * projects API accepts `owner/repo`, so new-user onboarding failed after a
 * valid dropdown selection.
 *
 * Run with:
 *   npx playwright test onboarding-project-selector-audit \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'demo@example.com',
  name: 'Demo User',
  role: 'superadmin',
  sessionId: 'session-demo-1',
  userId: 'user-demo-1',
});

const INSTALLATION = {
  id: 'inst-1',
  userId: 'user-demo-1',
  installationId: '100',
  accountType: 'organization',
  accountName: 'serverspresentation2025',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const REPOSITORY = {
  id: 123,
  fullName: 'serverspresentation2025/VoyajApp',
  name: 'VoyajApp',
  private: true,
  defaultBranch: 'main',
  installationId: 'inst-1',
};

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const isGet = route.request().method() === 'GET';
    const isPost = route.request().method() === 'POST';

    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return jsonResponse(route, 200, []);

    // Existing user setup tags make agent/cloud/GitHub steps optional, so the
    // execution phase lands directly on "Create your first project".
    if (p === '/api/credentials/agent' && isGet)
      return jsonResponse(route, 200, { credentials: [{ id: 'agent-cred-1', isActive: true }] });
    if (p === '/api/credentials' && isGet)
      return jsonResponse(route, 200, [{ id: 'cred-1', provider: 'hetzner' }]);
    if (p === '/api/github/installations') return jsonResponse(route, 200, [INSTALLATION]);

    if (p === '/api/github/repositories')
      return jsonResponse(route, 200, { repositories: [REPOSITORY] });

    if (p === '/api/projects' && isGet) return jsonResponse(route, 200, { projects: [] });
    if (p === '/api/projects' && isPost) {
      const body = route.request().postDataJSON() as { repository?: string };
      expect(body.repository).toBe(REPOSITORY.fullName);
      return jsonResponse(route, 201, {
        id: 'project-1',
        name: 'VoyajApp',
        repository: REPOSITORY.fullName,
        defaultBranch: 'main',
        repoProvider: 'github',
        installationId: 'inst-1',
        userId: 'user-demo-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    }

    if (p === '/api/trial-status' || p === '/api/trial/status')
      return jsonResponse(route, 200, { available: false });
    if (p.startsWith('/api/workspaces')) return jsonResponse(route, 200, []);

    return jsonResponse(route, 200, {});
  });
}

async function reachProjectSelector(page: Page) {
  await page.goto('/dashboard?onboarding');

  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await expect(wizard).toBeVisible({ timeout: 3000 });

  await wizard.getByRole('button', { name: 'Claude Pro or Max subscription' }).click();
  await wizard.getByRole('button', { name: 'I have Hetzner' }).click();
  await wizard.getByRole('button', { name: 'Yes, I have a repo' }).click();
  await wizard.getByRole('button', { name: /Start setup/ }).click();

  const repoSelect = wizard.locator('#onboarding-repo-select');
  await expect(repoSelect).toBeVisible({ timeout: 3000 });
  await repoSelect.selectOption(REPOSITORY.fullName);
  return wizard;
}

test('onboarding project selector submits owner/repo without overflow', async ({ page }) => {
  await setupMocks(page);

  const wizard = await reachProjectSelector(page);
  await expect(wizard.locator('#onboarding-repo-select')).toHaveValue(REPOSITORY.fullName);

  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-project-selector-selected');

  await wizard.getByRole('button', { name: /Create Project/ }).click();
  await page.waitForURL('**/projects/project-1', { timeout: 3000 });
});
