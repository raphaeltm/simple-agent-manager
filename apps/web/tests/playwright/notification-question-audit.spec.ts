import { expect, type Page, test } from '@playwright/test';

const now = Date.now();
const text = `## How should we handle existing conversations?\n\n${'We can fetch a small window around the question and preserve your scroll position, including when the question is much older than the latest chat page. '.repeat(5)}\n\n**Choose an approach below.**\n\nLiteral content: <script>alert("preview")</script> & Unicode ✓`;
const notif = {
  id: 'n1',
  type: 'needs_input',
  urgency: 'high',
  title: 'Input needed: improve conversation loading',
  body: 'The shortened preview of a much longer question…',
  projectId: 'p1',
  sessionId: 's1',
  taskId: 't1',
  actionUrl: '/projects/p1/chat/s1',
  metadata: {
    projectName: 'SAM',
    attentionMarkerId: 'a1',
    options: ['Use a message window', 'Load the whole conversation'],
  },
  createdAt: new Date(now).toISOString(),
  readAt: null,
  dismissedAt: null,
};
const user = {
  id: 'u1',
  name: 'Raphaël',
  email: 'test@example.com',
  role: 'superadmin',
  status: 'active',
  emailVerified: true,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
async function setup(
  page: Page,
  state: 'normal' | 'error' | 'empty-context' | 'free-text' | 'expired' = 'normal'
) {
  let answered = false;
  const sent: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('sam-theme', 'dark');
    localStorage.setItem('sam-onboarding-wizard-dismissed-u1', 'true');
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path.includes('/api/auth/'))
      return route.fulfill({
        json: {
          user,
          session: { id: 'auth', userId: 'u1', expiresAt: new Date(now + 86400000).toISOString() },
        },
      });
    if (path.includes('/attention/a1/resolve')) {
      const body = route.request().postDataJSON();
      sent.push(body.answer);
      answered = true;
      return route.fulfill({
        json: { resolved: true, alreadyResolved: false, answer: body.answer },
      });
    }
    if (path.endsWith('/attention/a1'))
      return route.fulfill(
        state === 'error'
          ? { status: 404, json: { message: 'Question unavailable' } }
          : {
              json: {
                request: {
                  id: 'a1',
                  reason: text,
                  options: state === 'free-text' ? [] : notif.metadata.options,
                  createdAt: now - 60000,
                  resolvedAt: answered ? now : null,
                  resolvedAnswer: answered ? sent[0] : null,
                  expired: state === 'expired',
                  canAnswer: !answered && state !== 'expired',
                },
                session: { id: 's1', topic: 'Improve conversation loading' },
                messages:
                  url.searchParams.has('context') && state !== 'empty-context'
                    ? [
                        {
                          id: 'm1',
                          role: 'user',
                          createdAt: now - 120000,
                          content:
                            'Please keep quick answers, but let me read the whole message first.',
                        },
                        {
                          id: 'm2',
                          role: 'assistant',
                          createdAt: now - 90000,
                          content:
                            'I compared the conversation loader and notification links. The full request is saved separately from the current message page.',
                        },
                      ]
                    : [],
              },
            }
      );
    if (path.includes('/api/notifications/unread-count'))
      return route.fulfill({ json: { count: 1 } });
    if (path.includes('/api/notifications'))
      return route.fulfill({
        json: {
          notifications: [
            notif,
            ...Array.from({ length: 30 }, (_, i) => ({
              ...notif,
              id: `n${i + 2}`,
              type: 'progress',
              title: `Update ${i + 1}`,
              metadata: { projectName: 'SAM' },
              sessionId: null,
            })),
          ],
          nextCursor: null,
          unreadCount: 1,
        },
      });
    if (path === '/api/projects/p1')
      return route.fulfill({
        json: {
          id: 'p1',
          name: 'SAM',
          userId: 'u1',
          repository: 'raphaeltm/simple-agent-manager',
          defaultBranch: 'main',
          status: 'active',
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          workspaces: [],
          tasks: [],
          sessions: [],
        },
      });
    if (path.includes('/api/projects'))
      return route.fulfill({ json: { projects: [], sessions: [], tasks: [], total: 0 } });
    if (path.includes('/api/credentials')) return route.fulfill({ json: [] });
    return route.fulfill({
      json: { tasks: [], agents: [], nodes: [], profiles: [], sessions: [], total: 0 },
    });
  });
  return sent;
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const dialog = page.getByRole('dialog', { name: 'Question from your agent' });
  if (await dialog.count()) {
    const header = await dialog.locator('header').boundingBox();
    const link = await dialog.getByRole('button', { name: 'Open in conversation' }).boundingBox();
    expect(header?.y, 'header remains in viewport').toBeGreaterThanOrEqual(0);
    expect(link, 'conversation link exists').not.toBeNull();
    expect(
      (link?.y ?? 0) + (link?.height ?? 0),
      'conversation link remains in viewport'
    ).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await page.screenshot({ path: `../../.codex/tmp/playwright-screenshots/${name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function open(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /notifications/i }).click();
  const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(inbox).toBeVisible();
  return inbox;
}
const suffix = () => (test.info().project.name.startsWith('Desktop') ? 'desktop' : 'mobile');
test('bell reader: full question, context, pinned answers and real answer payload', async ({
  page,
}) => {
  const sent = await setup(page);
  const inbox = await open(page);
  await shot(page, `question-inbox-${suffix()}`);
  await inbox.getByRole('button', { name: 'Read question & context' }).click();
  const dialog = page.getByRole('dialog', { name: 'Question from your agent' });
  await expect(
    dialog.getByRole('heading', { name: 'How should we handle existing conversations?' })
  ).toBeVisible();
  await shot(page, `question-reader-${suffix()}`);
  const body = dialog.getByTestId('notification-question-body');
  const answer = dialog.getByRole('button', { name: 'Use a message window', exact: true });
  const before = await answer.boundingBox();
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const after = await answer.boundingBox();
  expect(after!.y).toBe(before!.y);
  await expect(dialog.getByText('Choose an approach below.')).toBeVisible();
  await shot(page, `question-read-end-${suffix()}`);
  await body.evaluate((e) => (e.scrollTop = 0));
  await dialog.getByRole('button', { name: 'Show earlier context' }).click();
  await expect(
    dialog.getByText('Please keep quick answers, but let me read the whole message first.')
  ).toBeVisible();
  await shot(page, `question-context-${suffix()}`);
  await answer.click();
  await expect(dialog.getByText('Answered: Use a message window')).toBeVisible();
  expect(sent).toEqual(['Use a message window']);
  await shot(page, `question-answered-${suffix()}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
test('question load failure is readable and does not offer answers', async ({ page }) => {
  await setup(page, 'error');
  const inbox = await open(page);
  await inbox.getByRole('button', { name: 'Read question & context' }).click();
  const dialog = page.getByRole('dialog', { name: 'Question from your agent' });
  await expect(dialog.getByText('Notification preview · may be incomplete')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Use a message window', exact: true })
  ).toHaveCount(0);
  await shot(page, `question-error-${suffix()}`);
});
test('project notification opens same reader with an empty context', async ({ page }) => {
  await setup(page, 'empty-context');
  await page.goto('/projects/p1/notifications');
  await page.getByRole('button', { name: /Input needed: improve conversation loading/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Question from your agent' });
  await expect(
    dialog.getByRole('heading', { name: 'How should we handle existing conversations?' })
  ).toBeVisible();
  await shot(page, `question-project-${suffix()}`);
  await dialog.getByRole('button', { name: 'Show earlier context' }).click();
  await expect(dialog.getByText('No earlier messages are available.')).toBeVisible();
  await shot(page, `question-empty-context-${suffix()}`);
});
test('free-text requests submit a typed answer', async ({ page }) => {
  const sent = await setup(page, 'free-text');
  const inbox = await open(page);
  await inbox.getByRole('button', { name: 'Read question & context' }).click();
  const dialog = page.getByRole('dialog', { name: 'Question from your agent' });
  await dialog
    .getByRole('textbox', { name: 'Your answer' })
    .fill('Keep the message window and stable scrolling.');
  await shot(page, `question-free-text-${suffix()}`);
  await dialog.getByRole('button', { name: 'Send answer' }).click();
  await expect(
    dialog.getByText('Answered: Keep the message window and stable scrolling.')
  ).toBeVisible();
  expect(sent).toEqual(['Keep the message window and stable scrolling.']);
});

test('quick answers stay in the bell and normal updates keep navigating', async ({ page }) => {
  const sent = await setup(page);
  const inbox = await open(page);
  await inbox.getByRole('button', { name: 'Use a message window', exact: true }).click();
  await expect(inbox.getByText('Answered: Use a message window')).toBeVisible();
  expect(sent).toEqual(['Use a message window']);
  await expect(page.getByRole('dialog', { name: 'Question from your agent' })).toHaveCount(0);
  await inbox.getByRole('tab', { name: /Updates/ }).click();
  await inbox.getByRole('button', { name: /^Update 1 The shortened/ }).click();
  await expect(page).toHaveURL(/\/projects\/p1\/chat\/s1/);
});
