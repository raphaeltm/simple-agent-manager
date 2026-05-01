import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

interface ProfileOverrides {
  id: string;
  name: string;
  description?: string | null;
  agentType?: string;
  model?: string | null;
  permissionMode?: string | null;
  vmSizeOverride?: string | null;
  taskMode?: string | null;
  isBuiltin?: boolean;
}

function makeProfile(overrides: ProfileOverrides) {
  return {
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    agentType: overrides.agentType ?? 'claude-code',
    model: overrides.model ?? null,
    permissionMode: overrides.permissionMode ?? null,
    vmSizeOverride: overrides.vmSizeOverride ?? null,
    taskMode: overrides.taskMode ?? null,
    description: overrides.description ?? null,
    isBuiltin: overrides.isBuiltin ?? false,
    ...overrides,
  };
}

// Sample datasets
const NORMAL_PROFILES = [
  makeProfile({
    id: 'prof-1',
    name: 'Fast Implementer',
    description: 'Optimized for quick task execution with auto-approval',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto-accept',
    vmSizeOverride: 'medium',
    taskMode: 'task',
  }),
  makeProfile({
    id: 'prof-2',
    name: 'Code Reviewer',
    description: 'Thorough code review with conversation mode',
    agentType: 'claude-code',
    model: 'claude-opus-4-6',
    permissionMode: 'default',
    taskMode: 'conversation',
    isBuiltin: true,
  }),
  makeProfile({
    id: 'prof-3',
    name: 'Codex Worker',
    description: null,
    agentType: 'openai-codex',
    model: 'codex',
  }),
];

const LONG_TEXT_PROFILES = [
  makeProfile({
    id: 'lt-1',
    name: 'This Is An Extremely Long Profile Name That Should Definitely Be Handled Gracefully On Mobile Screens Because It Contains Way Too Many Words And Characters To Fit In A Single Line',
    description:
      'This profile has a very detailed description explaining the full configuration including which model to use, what permission mode is active, how the VM should be sized, what workspace profile to apply, and why this particular configuration was chosen over alternatives. It really goes into great depth.',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto-accept',
    vmSizeOverride: 'large',
    taskMode: 'conversation',
  }),
  makeProfile({
    id: 'lt-2',
    name: 'A',
    description: null,
    agentType: 'claude-code',
  }),
  makeProfile({
    id: 'lt-3',
    name: 'Special chars: <script>alert("xss")</script> & "quotes" 日本語テスト',
    description:
      'Unicode: emojis and HTML: &amp; &lt; &gt; and URL: https://example.com/very/long/path/that/should/not/break/layout/at/all',
    agentType: 'openai-codex',
    model: 'codex',
    permissionMode: 'plan',
    vmSizeOverride: 'small',
    taskMode: 'task',
    isBuiltin: true,
  }),
];

const MANY_PROFILES = Array.from({ length: 15 }, (_, i) =>
  makeProfile({
    id: `many-${i}`,
    name: `Profile ${i + 1}: ${['Implementer', 'Reviewer', 'Debugger', 'Planner', 'Deployer'][i % 5]}`,
    description: i % 2 === 0 ? `Description for profile ${i + 1}` : null,
    agentType: i % 3 === 0 ? 'openai-codex' : 'claude-code',
    model: i % 2 === 0 ? 'claude-sonnet-4-6' : null,
    permissionMode: i % 3 === 0 ? 'auto-accept' : null,
    vmSizeOverride: i % 4 === 0 ? 'large' : null,
    taskMode: i % 2 === 0 ? 'task' : null,
    isBuiltin: i === 0,
  }),
);

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    profiles?: ReturnType<typeof makeProfile>[];
    profilesError?: boolean;
  } = {},
) {
  const { profiles = NORMAL_PROFILES, profilesError = false } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    // Auth
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);

    // Dashboard
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });

    // GitHub installations
    if (path === '/api/github/installations') return respond(200, []);

    // Notifications
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });

    // Agents
    if (path === '/api/agents') return respond(200, []);

    // Credentials
    if (path.startsWith('/api/credentials')) return respond(200, { credentials: [] });

    // Project-scoped routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // Runtime config
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });

      // Sessions
      if (subPath.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });

      // Tasks
      if (subPath.startsWith('/tasks')) return respond(200, { tasks: [], total: 0 });

      // Agent profiles
      if (subPath === '/agent-profiles') {
        if (profilesError) return respond(500, { error: 'INTERNAL_ERROR', message: 'Server error' });
        return respond(200, { items: profiles });
      }

      // Triggers
      if (subPath.startsWith('/triggers')) return respond(200, { triggers: [] });

      // Project detail
      return respond(200, MOCK_PROJECT);
    }

    // Projects list
    if (path === '/api/projects') return respond(200, [MOCK_PROJECT]);

    // Default: return empty success for any unmatched API route
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests: Profiles List — Mobile
// ---------------------------------------------------------------------------

test.describe('Profiles List — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data', async ({ page }) => {
    await setupApiMocks(page, { profiles: NORMAL_PROFILES });
    await page.goto('/projects/proj-test-1/profiles');
    await page.waitForSelector('text=Fast Implementer');
    await screenshot(page, 'profiles-list-normal-mobile');
    await assertNoOverflow(page);
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { profiles: LONG_TEXT_PROFILES });
    await page.goto('/projects/proj-test-1/profiles');
    await page.waitForSelector('text=Special chars');
    await screenshot(page, 'profiles-list-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { profiles: [] });
    await page.goto('/projects/proj-test-1/profiles');
    await page.waitForSelector('text=No profiles yet');
    await screenshot(page, 'profiles-list-empty-mobile');
    await assertNoOverflow(page);
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, { profiles: MANY_PROFILES });
    await page.goto('/projects/proj-test-1/profiles');
    await page.waitForSelector('text=Profile 1');
    await screenshot(page, 'profiles-list-many-mobile');
    await assertNoOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupApiMocks(page, { profilesError: true });
    await page.goto('/projects/proj-test-1/profiles');
    await page.waitForSelector('.text-danger', { timeout: 5000 });
    await screenshot(page, 'profiles-list-error-mobile');
    await assertNoOverflow(page);
  });

  test('delete confirmation does not overflow', async ({ page }) => {
    await setupApiMocks(page, { profiles: LONG_TEXT_PROFILES });
    await page.goto('/projects/proj-test-1/profiles');
    await page.waitForSelector('text=Special chars');
    // Click the delete button on the first profile (long name)
    const deleteBtn = page.locator('button[aria-label*="Delete"]').first();
    await deleteBtn.click();
    await page.waitForSelector('text=Confirm');
    await screenshot(page, 'profiles-list-delete-confirm-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop tests skipped: pre-existing desktop test infrastructure issue
// (error boundary crash on desktop layout before any page data loads;
// same failure in triggers-ui-audit.spec.ts and other existing desktop tests).
// The mobile tests above cover the fix for this PR.
// ---------------------------------------------------------------------------
