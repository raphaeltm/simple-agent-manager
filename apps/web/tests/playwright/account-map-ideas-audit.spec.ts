import { expect, type Page, type Route, test } from '@playwright/test';

const user = {
  user: {
    id: 'map-user',
    email: 'map@example.com',
    name: 'Map user',
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
  },
  session: {
    id: 'map-session',
    userId: 'map-user',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock',
  },
};
const project = {
  id: 'map-project',
  name: 'Map project',
  repository: 'owner/repo',
  status: 'active',
  lastActivityAt: null,
  activeSessionCount: 4,
};
const longTitle =
  'Improve the account onboarding flow for people with several active projects and many related chats — '.repeat(
    3
  );
const ideaTitles = [
  'Improve onboarding',
  longTitle,
  'Review API access 🔐',
  '<script>alert(1)</script>',
];
const ideas = ideaTitles.map((title, index) => ({
  id: `idea-${index}`,
  projectId: project.id,
  title,
  status: 'draft',
}));
const sessions = ideas.map((idea, index) => ({
  id: `chat-${index}`,
  projectId: project.id,
  topic: `Chat for ${idea.title}`,
  status: 'active',
  messageCount: 2,
  workspaceId: null,
  taskId: null,
}));
const map = {
  projects: [project],
  nodes: [],
  workspaces: [],
  sessions,
  tasks: [],
  ideas,
  ideaScan: { projectLimit: 10, candidateLimit: 100 },
  truncation: { projects: false, ideas: true, sessions: false, links: false },
  relationships: [
    ...sessions.map((session) => ({
      source: project.id,
      target: session.id,
      type: 'has_session',
      active: true,
    })),
    ...ideas.flatMap((idea, index) => [
      { source: project.id, target: idea.id, type: 'has_idea', active: true },
      {
        source: idea.id,
        target: sessions[index]!.id,
        type: 'idea_session',
        active: true,
        primary: index === 0,
      },
    ]),
  ],
};

async function setup(page: Page, response: unknown = map, error = false) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-map-user', 'true')
  );
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      error && path === '/api/account-map'
        ? { error: 'MAP_UNAVAILABLE', message: 'Map temporarily unavailable' }
        : path.includes('/api/auth/')
          ? user
          : path === '/api/account-map'
            ? response
            : path === '/api/projects'
              ? { projects: [project] }
              : path === '/api/dashboard/active-tasks'
                ? { tasks: [] }
                : path === '/api/notifications'
                  ? { notifications: [], unreadCount: 0 }
                  : path === '/api/agents' ||
                      path === '/api/nodes' ||
                      path === '/api/workspaces' ||
                      path === '/api/credentials' ||
                      path === '/api/github/installations'
                    ? []
                    : {};
    const status = error && path === '/api/account-map' ? 500 : 200;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.describe('Account Map ideas', () => {
  test('shows linked ideas, supports filtering, and offers a real idea link', async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    await setup(page);
    await page.goto('/account-map');
    const ideaNodes = page.locator('.react-flow__node-ideaNode');
    await expect(ideaNodes).toHaveCount(4);
    await expect(
      page.getByText('Only the 100 newest ideas were checked for chat links.')
    ).toBeVisible();
    const ideaLink = page.locator('a[href="/projects/map-project/ideas/idea-1"]');
    await expect(ideaLink).toHaveAttribute('aria-label', `Open idea: ${longTitle}`);
    await assertNoOverflow(page);
    await page.waitForTimeout(600);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/account-map-ideas-${viewport}.png`,
      fullPage: true,
    });
    const toggle = page.getByRole('button', { name: 'Ideas filter' });
    await expect(toggle).toBeInViewport();
    await toggle.click();
    await expect(ideaNodes).toHaveCount(0);
    await expect(page.locator('.react-flow__edge')).toHaveCount(4);
    await assertNoOverflow(page);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/account-map-ideas-filtered-${viewport}.png`,
      fullPage: true,
    });
    await toggle.click();
    await expect(ideaNodes).toHaveCount(4);
    await ideaLink.click();
    await expect(page).toHaveURL(/\/projects\/map-project\/ideas\/idea-1$/);
  });

  test('handles an empty map and a retryable error', async ({ page }) => {
    await setup(page, {
      projects: [],
      nodes: [],
      workspaces: [],
      sessions: [],
      tasks: [],
      ideas: [],
      relationships: [],
      truncation: { projects: false, ideas: false, sessions: false, links: false },
    });
    await page.goto('/account-map');
    await expect(page.getByText(/No resources|nothing to show|empty/i).first()).toBeVisible();
    await assertNoOverflow(page);
  });

  test('keeps a 30-idea graph usable', async ({ page }, testInfo) => {
    const manyIdeas = Array.from({ length: 30 }, (_, index) => ({
      id: `many-idea-${index}`,
      projectId: project.id,
      title: index === 15 ? longTitle : `Idea ${index}`,
      status: 'draft',
    }));
    const manySessions = manyIdeas.map((idea, index) => ({
      id: `many-chat-${index}`,
      projectId: project.id,
      topic: `Chat ${index}`,
      status: 'active',
      messageCount: 1,
      workspaceId: null,
      taskId: null,
    }));
    await setup(page, {
      ...map,
      ideas: manyIdeas,
      sessions: manySessions,
      relationships: manyIdeas.flatMap((idea, index) => [
        { source: project.id, target: idea.id, type: 'has_idea', active: true },
        { source: idea.id, target: manySessions[index]!.id, type: 'idea_session', active: true },
      ]),
    });
    await page.goto('/account-map');
    await expect(page.locator('.react-flow__node-ideaNode')).toHaveCount(30);
    await assertNoOverflow(page);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/account-map-ideas-30-${testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
    });
    const toggle = page.getByRole('button', { name: 'Ideas filter' });
    await toggle.click();
    await expect(page.locator('.react-flow__node-ideaNode')).toHaveCount(0);
    await assertNoOverflow(page);
  });

  test('shows a retry control after an API error', async ({ page }) => {
    await setup(page, map, true);
    await page.goto('/account-map');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await assertNoOverflow(page);
  });
});
