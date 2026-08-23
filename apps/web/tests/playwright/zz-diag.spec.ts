import { expect, test } from '@playwright/test';

import { makeMockUser } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-1',
  userId: 'user-1',
});

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

test('diagnose: which unmocked endpoint breaks the agent-context page', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message).slice(0, 600)));

  const fellThrough: string[] = [];

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/api/auth/')) return route.fulfill({ json: MOCK_USER });
    if (path === '/api/report-issue/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/config/vapid-public-key') return route.fulfill({ json: { publicKey: null } });
    if (path === '/api/dashboard/active-tasks') return route.fulfill({ json: { tasks: [] } });
    if (path === '/api/github/installations') return route.fulfill({ json: [] });
    if (path.startsWith('/api/notifications')) {
      return route.fulfill({ json: { notifications: [], unreadCount: 0, count: 0 } });
    }
    if (path === '/api/agents') return route.fulfill({ json: [] });
    if (path.startsWith('/api/credentials')) return route.fulfill({ json: { credentials: [] } });
    if (path.includes('/api/projects/proj-1/knowledge')) {
      return route.fulfill({ json: { entities: [], total: 0 } });
    }
    if (path.includes('/api/projects/proj-1/policies')) {
      return route.fulfill({ json: { policies: [], total: 0 } });
    }
    if (path.includes('/api/projects/proj-1/activity')) {
      return route.fulfill({ json: { events: [], hasMore: false } });
    }
    if (path.includes('/api/projects/proj-1')) return route.fulfill({ json: MOCK_PROJECT });
    if (path.startsWith('/api/projects')) {
      return route.fulfill({ json: { projects: [MOCK_PROJECT], total: 1 } });
    }
    if (path.startsWith('/api/workspaces')) return route.fulfill({ json: [] });
    fellThrough.push(route.request().method() + ' ' + path);
    return route.fulfill({ json: {} });
  });

  await page.goto('/projects/proj-1/agent-context');
  await page.waitForTimeout(5000);

  const body = (await page.locator('body').innerText()).slice(0, 400);
  console.log('=== FELL THROUGH TO {} ===\n' + [...new Set(fellThrough)].join('\n'));
  console.log('=== ERRORS ===\n' + errors.slice(0, 5).join('\n---\n'));
  console.log('=== BODY ===\n' + body);
  expect(true).toBe(true);
});
