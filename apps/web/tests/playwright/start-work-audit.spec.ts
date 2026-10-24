/**
 * Visual audit for the Start work sheet (replaces Execute on the idea page).
 *
 * Scenarios: closed, open with a task profile, the profile picker open, a chat-only
 * profile, long titles and names, many profiles, empty linked work, and a failed start.
 * Captured at 375x667 and 1280x800 with no-overflow and no-clipped-overflow assertions.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultWorkspaceProfile: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const LONG_TITLE =
  'Retry failed webhook deliveries for three days with exponential backoff, matching the window Stripe uses, without touching the refunds path or the existing replay tooling';

function makeIdea(overrides: Record<string, unknown> = {}) {
  return {
    id: 'idea-1',
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    parentTaskId: null,
    workspaceId: null,
    title: 'Retry failed webhook deliveries',
    description: 'Use the same 3-day window Stripe uses. Leave the refunds path alone.',
    status: 'draft',
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: null,
    blocked: false,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    finalizedAt: null,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
    dependencies: [],
    ...overrides,
  };
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-builder',
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    name: 'Opus 5.5',
    description: 'Plans and builds carefully, opens a pull request',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: 'full',
    runtime: 'vm',
    devcontainerConfigName: null,
    taskMode: 'task',
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const CHAT_PROFILE = makeProfile({
  id: 'profile-chat',
  name: 'Brainstormer',
  description: 'Talks it through with you before anything is built',
  runtime: 'cf-container',
  workspaceProfile: 'lightweight',
  taskMode: 'conversation',
  model: null,
});

const LONG_NAME_PROFILE = makeProfile({
  id: 'profile-long',
  name: 'Opus 5.5 Extended Thinking With A Deliberately Unreasonable Profile Name For Layout',
  description:
    'A description that keeps going well past any sensible width so the row has to truncate rather than push the sheet sideways',
});

const MANY_PROFILES = [
  makeProfile(),
  CHAT_PROFILE,
  LONG_NAME_PROFILE,
  ...Array.from({ length: 27 }, (_, index) =>
    makeProfile({
      id: `profile-${index}`,
      name: `Profile ${index + 1}`,
      description: `Does thing number ${index + 1}`,
      taskMode: index % 2 === 0 ? 'task' : 'conversation',
      runtime: index % 3 === 0 ? 'cf-container' : 'vm',
    })
  ),
];

const SKILLS = [
  {
    ...makeProfile(),
    id: 'skill-plan',
    name: 'plan-and-build',
    description: 'Plan, build, test and open a pull request',
    agentType: null,
    resourceRequirementsJson: null,
    defaultProfileId: null,
  },
];

function cappedList(total: number, lowerBound = false) {
  return { items: [], total, truncated: false, totalIsLowerBound: lowerBound };
}

interface MockOptions {
  idea?: Record<string, unknown>;
  profiles?: Record<string, unknown>[];
  skills?: unknown[];
  links?: Record<string, unknown>;
  submitStatus?: number;
  submitBody?: unknown;
}

async function setupMocks(page: Page, options: MockOptions = {}) {
  const {
    idea = makeIdea(),
    profiles = [makeProfile(), CHAT_PROFILE],
    skills = [],
    links = {
      sessions: cappedList(2),
      files: cappedList(1),
      pullRequests: cappedList(3, true),
      relatedIdeas: cappedList(0),
    },
    submitStatus = 202,
    submitBody = {
      taskId: 'task-new',
      sessionId: 'session-new',
      branchName: 'sam/retry',
      status: 'queued',
    },
  } = options;

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/workspaces')) return respond(200, []);
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.endsWith('/health')) return respond(200, { status: 'ok' });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: profiles });
      if (subPath === '/agent-profiles/picker') {
        return respond(200, {
          hiddenProfileIds: [],
          usage: [{ profileId: 'profile-builder', lastUsedAt: Date.now(), count: 4 }],
          windowDays: 30,
        });
      }
      if (subPath === '/skills') return respond(200, { items: skills });
      if (subPath.match(/^\/ideas\/[^/]+\/links$/)) return respond(200, links);
      if (subPath === '/tasks/submit') return respond(submitStatus, submitBody);
      if (subPath.match(/^\/tasks\/[^/]+\/sessions$/)) {
        return respond(200, { sessions: [], count: 0 });
      }
      if (subPath.match(/^\/tasks\/[^/]+$/)) return respond(200, idea);
      if (subPath.startsWith('/tasks')) return respond(200, { tasks: [], nextCursor: null });
      if (subPath.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (!subPath || subPath === '/') return respond(200, MOCK_PROJECT);
    }
    return respond(200, {});
  });
}

async function openIdea(page: Page, title: string) {
  await page.goto('/projects/proj-test-1/ideas/idea-1');
  await page.waitForSelector(`text=${title.slice(0, 40)}`);
}

async function openSheet(page: Page, title = 'Retry failed webhook deliveries') {
  await openIdea(page, title);
  await page.getByRole('button', { name: /Start work on this idea/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** The sheet must sit inside the viewport, not just render somewhere. */
async function assertSheetWithinViewport(page: Page) {
  const box = await page.getByRole('dialog').first().boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'sheet has a layout box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
}

function suffix(page: Page): string {
  return (page.viewportSize()?.width ?? 0) <= 500 ? 'mobile' : 'desktop';
}

test.describe('Start work sheet', () => {
  test('idea page shows Start work, not Execute', async ({ page }) => {
    await setupMocks(page);
    await openIdea(page, 'Retry failed webhook deliveries');
    await expect(page.getByRole('button', { name: /Start work on this idea/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /execute/i })).toHaveCount(0);
    await screenshot(page, `start-work-${suffix(page)}-closed`);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('open sheet with a task profile', async ({ page }) => {
    await setupMocks(page);
    await openSheet(page);
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: 'Start work' })).toBeVisible();
    await expect(sheet.getByText('Does the work')).toBeVisible();
    await expect(sheet.getByText('The idea', { exact: true })).toBeVisible();
    await expect(sheet.getByText('2 earlier chats')).toBeVisible();
    await expect(sheet.getByText('3+ pull requests')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Start work' })).toBeVisible();
    await screenshot(page, `start-work-${suffix(page)}-open`);
    await assertSheetWithinViewport(page);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('profile picker opens over the sheet', async ({ page }) => {
    await setupMocks(page, { profiles: MANY_PROFILES });
    await openSheet(page);
    await page.getByRole('button', { name: /Who works on it/i }).click();
    const picker = page.getByRole('dialog', { name: /Choose a profile/i });
    await expect(picker).toBeVisible();
    await expect(picker.getByText('Brainstormer')).toBeVisible();

    // `toBeVisible` says nothing about stacking order, and the picker makes every other
    // body child `inert` while it is open, so a hit test cannot see the sheet on top of
    // it either. The picker's default drawer layer (41) sits BELOW the dialog layer this
    // sheet uses (50), which would paint it behind the sheet that opened it while every
    // interaction assertion still passed. Compare the painted stacking levels.
    const stacking = await page.evaluate(() => {
      const level = (element: Element | null): number => {
        for (let node = element as HTMLElement | null; node; node = node.parentElement) {
          const value = getComputedStyle(node).zIndex;
          if (value !== 'auto') return Number(value);
        }
        return 0;
      };
      return {
        picker: level(document.querySelector('[role="dialog"][aria-label="Choose a profile"]')),
        sheet: level(document.querySelector('[data-testid="start-work-sheet"]')),
      };
    });
    expect(
      stacking.picker,
      `picker paints at ${stacking.picker}, sheet at ${stacking.sheet}`
    ).toBeGreaterThan(stacking.sheet);

    // And it is the picker, not the sheet, that receives a tap on one of its rows.
    const row = picker.getByRole('button', { name: /Brainstormer/i }).first();
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    expect(box, 'picker row has a layout box').not.toBeNull();
    const onTop = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return Boolean(element?.closest('[role="dialog"][aria-label="Choose a profile"]'));
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    );
    expect(onTop, 'a tap on a picker row reaches the picker').toBe(true);

    await screenshot(page, `start-work-${suffix(page)}-picker`);
    await assertNoOverflow(page);
  });

  test('a chat profile turns the sheet into Talk it through', async ({ page }) => {
    await setupMocks(page);
    await openSheet(page);
    await page.getByRole('button', { name: /Who works on it/i }).click();
    await page
      .getByRole('dialog', { name: /Choose a profile/i })
      .getByRole('button', { name: /Brainstormer/i })
      .click();

    const sheet = page.getByRole('dialog', { name: /Talk it through/i });
    await expect(sheet.getByRole('heading', { name: 'Talk it through' })).toBeVisible();
    await expect(sheet.getByText('Talks it through', { exact: true })).toBeVisible();
    await expect(sheet.getByText(/starts a chat about the idea instead/i)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Start chat' })).toBeVisible();
    await screenshot(page, `start-work-${suffix(page)}-chat-only`);
    await assertSheetWithinViewport(page);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('long idea title, long profile name and a skill hold the layout', async ({ page }) => {
    await setupMocks(page, {
      idea: makeIdea({ title: LONG_TITLE }),
      profiles: [LONG_NAME_PROFILE, CHAT_PROFILE],
      skills: SKILLS,
    });
    await openSheet(page, LONG_TITLE);
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('Skill')).toBeVisible();
    await sheet
      .getByLabel('Note for the agent')
      .fill('Match the 3-day window. Leave the refunds path alone. '.repeat(4));
    await screenshot(page, `start-work-${suffix(page)}-long-text`);
    await assertSheetWithinViewport(page);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('empty linked work shows only the idea', async ({ page }) => {
    await setupMocks(page, {
      links: {
        sessions: cappedList(0),
        files: cappedList(0),
        pullRequests: cappedList(0),
        relatedIdeas: cappedList(0),
      },
    });
    await openSheet(page);
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('The idea', { exact: true })).toBeVisible();
    await expect(sheet.getByText(/can look them up with its SAM tools/i)).toHaveCount(0);
    await screenshot(page, `start-work-${suffix(page)}-empty-links`);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('a rejected start shows the reason in the sheet', async ({ page }) => {
    await setupMocks(page, {
      submitStatus: 409,
      submitBody: {
        error: 'CONFLICT',
        message: 'That idea is done. Reopen it before starting work on it.',
      },
    });
    await openSheet(page);
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Start work' }).click();
    await expect(sheet.getByRole('alert')).toContainText('That idea is done');
    // Still on the idea page: a failed start must not navigate away.
    await expect(page).toHaveURL(/\/ideas\/idea-1$/);
    await screenshot(page, `start-work-${suffix(page)}-error`);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('starting work opens the new chat', async ({ page }) => {
    await setupMocks(page);
    await openSheet(page);
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Note for the agent').fill('Match the 3-day window.');
    const submitted = page.waitForRequest(
      (request) => request.url().includes('/tasks/submit') && request.method() === 'POST'
    );
    await sheet.getByRole('button', { name: 'Start work' }).click();
    const request = await submitted;
    expect(request.postDataJSON()).toMatchObject({
      message: 'Match the 3-day window.',
      agentProfileId: 'profile-builder',
      taskMode: 'task',
      sourceIdeaId: 'idea-1',
    });
    await expect(page).toHaveURL(/\/chat\/session-new$/);
  });

  test('Escape closes the sheet and returns focus to the trigger', async ({ page }) => {
    await setupMocks(page);
    await openSheet(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Start work on this idea/i })).toBeFocused();
  });
});
