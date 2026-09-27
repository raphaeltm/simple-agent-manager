import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

const SCREENSHOT_DIR = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');
const NOW = Date.now();
const projectId = 'proj-wake-failed';
const userId = 'user-wake-failed';

const json = (status: number, body: unknown) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const sessionUser = {
  user: {
    id: userId,
    email: 'wake-failed@example.com',
    name: 'Wake Failed Reviewer',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
  },
  session: {
    id: 'session-wake-failed-review',
    userId,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
  },
};

const project = {
  id: projectId,
  name: 'Wake Failure Visibility',
  repository: 'sam/example',
  defaultBranch: 'main',
  userId,
  githubInstallationId: 'installation-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
};

const task = (id: string, title: string, status: string) => ({
  id,
  title,
  description: null,
  projectId,
  userId,
  parentTaskId: null,
  status,
  blocked: false,
  triggeredBy: 'user',
  dispatchDepth: 0,
  taskMode: 'conversation',
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
});

const tasks = [
  task(
    'task-wake-failed',
    'Investigate durable wake refusal with a long enough task title to prove compact sidebar wrapping',
    'pending'
  ),
  task('task-active', 'Healthy control session', 'in_progress'),
];

const sessions = [
  {
    id: 'session-wake-failed',
    workspaceId: 'workspace-old',
    taskId: 'task-wake-failed',
    topic:
      'Wake failed after snapshot expiry — unicode 🚨 and a deliberately long title that must truncate',
    status: 'sleeping',
    messageCount: 18,
    startedAt: NOW - 3_600_000,
    endedAt: null,
    createdAt: NOW - 3_600_000,
    lastMessageAt: NOW - 60_000,
    isIdle: false,
    isTerminated: false,
    attention: {
      markerId: 'marker-wake-failed',
      kind: 'wake_failed',
      createdAt: NOW - 30_000,
      expiresAt: null,
      reason: 'ttl_expired',
      options: [],
    },
    task: { id: 'task-wake-failed', status: 'pending' },
  },
  {
    id: 'session-control',
    workspaceId: 'workspace-active',
    taskId: 'task-active',
    topic: 'Healthy active control session',
    status: 'active',
    messageCount: 4,
    startedAt: NOW - 600_000,
    endedAt: null,
    createdAt: NOW - 600_000,
    lastMessageAt: NOW - 10_000,
    isIdle: false,
    isTerminated: false,
    task: { id: 'task-active', status: 'in_progress' },
  },
];

function projectResponse(path: string) {
  const subPath = path.match(/^\/api\/projects\/[^/]+(\/.*)?$/)?.[1] || '';
  if (subPath === '/sessions') return { sessions, total: sessions.length };
  if (subPath.match(/\/sessions\/[^/]+\/messages/)) return [];
  if (subPath === '/tasks') return { tasks, nextCursor: null };
  if (['/agents', '/agent-profiles', '/cached-commands', '/triggers'].includes(subPath)) {
    return subPath === '/agents' ? { agents: [] } : { items: [] };
  }
  if (subPath === '/knowledge') return { entities: [], total: 0 };
  return project;
}

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/api/auth/')) return route.fulfill(json(200, sessionUser));
    if (path.startsWith('/api/notifications')) {
      return route.fulfill(json(200, { notifications: [], unreadCount: 0 }));
    }
    if (path.startsWith('/api/projects')) return route.fulfill(json(200, projectResponse(path)));
    if (path === '/api/projects')
      return route.fulfill(json(200, { projects: [project], nextCursor: null }));
    if (path.startsWith('/api/trial-status')) {
      return route.fulfill(
        json(200, {
          available: false,
          agentType: null,
          hasInfraCredential: false,
          hasAgentCredential: false,
          dailyTokenBudget: null,
          dailyTokenUsage: null,
        })
      );
    }
    const emptyArrayPaths = ['/api/credentials', '/api/github/installations'];
    if (emptyArrayPaths.some((prefix) => path.startsWith(prefix)))
      return route.fulfill(json(200, []));
    return route.fulfill(json(200, path === '/api/provider-catalog' ? { catalogs: [] } : {}));
  });
}

async function renderWakeFailedSidebar(page: Page, screenshotName: string) {
  await setupApiMocks(page);
  await page.addInitScript((id) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, userId);
  await page.goto(`/projects/${projectId}`);
  await page.waitForTimeout(1500);

  const button = page.getByRole('button', { name: 'Open chat list' });
  if (await button.count()) await button.first().click();

  const wakeFailedRow = page.getByRole('button', {
    name: /Wake failed Wake failed after snapshot expiry/,
  });
  await expect(wakeFailedRow).toBeVisible();
  await expect(wakeFailedRow.locator('.text-danger-fg', { hasText: 'Wake failed' })).toBeVisible();
  await expect(page.getByText('Healthy active control session')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false
  );

  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${screenshotName}${suffix}.png`,
    fullPage: true,
  });
}

test.describe('Wake failed session sidebar audit', () => {
  test('mobile renders the wake_failed attention state without overflow', async ({
    page,
  }, info) => {
    test.skip(
      !info.project.name.includes('iPhone SE'),
      `Mobile evidence skipped on ${info.project.name}`
    );
    await renderWakeFailedSidebar(page, 'wake-failed-session-sidebar-mobile');
  });

  test('desktop renders the wake_failed attention state without overflow', async ({
    page,
  }, info) => {
    test.skip(
      !info.project.name.includes('Desktop'),
      `Desktop evidence skipped on ${info.project.name}`
    );
    await renderWakeFailedSidebar(page, 'wake-failed-session-sidebar-desktop');
  });
});
