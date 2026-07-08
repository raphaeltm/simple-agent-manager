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
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  description: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  summary: {
    workspaceCount: 0,
    nodeCount: 0,
    taskCount: 0,
    activeSessionCount: 0,
  },
};

const MOCK_BRANCHES = {
  branches: [
    { name: 'main', isDefault: true },
    { name: 'feature/file-browser-rework', isDefault: false },
    { name: 'fix/login-redirect', isDefault: false },
    { name: 'sam/deploy-v2-migration-with-a-very-long-branch-name-that-might-overflow', isDefault: false },
  ],
};

function makeTreeEntry(
  path: string,
  type: 'blob' | 'tree' = 'blob',
  size: number | null = null,
) {
  return { path, type, size, sha: `sha-${path.replace(/[^a-z0-9]/g, '')}` };
}

const MOCK_TREE = {
  entries: [
    makeTreeEntry('.github', 'tree'),
    makeTreeEntry('.github/workflows', 'tree'),
    makeTreeEntry('.github/workflows/ci.yml', 'blob', 2048),
    makeTreeEntry('.github/workflows/deploy.yml', 'blob', 4096),
    makeTreeEntry('apps', 'tree'),
    makeTreeEntry('apps/api', 'tree'),
    makeTreeEntry('apps/api/src', 'tree'),
    makeTreeEntry('apps/api/src/index.ts', 'blob', 512),
    makeTreeEntry('apps/api/package.json', 'blob', 1024),
    makeTreeEntry('apps/web', 'tree'),
    makeTreeEntry('apps/web/src', 'tree'),
    makeTreeEntry('apps/web/src/App.tsx', 'blob', 3200),
    makeTreeEntry('apps/web/src/main.tsx', 'blob', 256),
    makeTreeEntry('apps/web/package.json', 'blob', 2048),
    makeTreeEntry('packages', 'tree'),
    makeTreeEntry('packages/shared', 'tree'),
    makeTreeEntry('packages/shared/src/index.ts', 'blob', 1024),
    makeTreeEntry('packages/ui', 'tree'),
    makeTreeEntry('packages/ui/src/tokens/theme.css', 'blob', 8192),
    makeTreeEntry('CLAUDE.md', 'blob', 15360),
    makeTreeEntry('README.md', 'blob', 4096),
    makeTreeEntry('package.json', 'blob', 2048),
    makeTreeEntry('pnpm-lock.yaml', 'blob', 512000),
    makeTreeEntry('tsconfig.json', 'blob', 512),
    makeTreeEntry('.gitignore', 'blob', 256),
    makeTreeEntry('Dockerfile', 'blob', 1024),
    makeTreeEntry('docker-compose.yml', 'blob', 768),
    makeTreeEntry('vitest.config.ts', 'blob', 512),
    makeTreeEntry('screenshot-with-a-really-long-filename-that-should-definitely-overflow.png', 'blob', 1048576),
  ],
  truncated: false,
};

const MOCK_COMPARE = {
  filesChanged: 4,
  totalAdditions: 127,
  totalDeletions: 42,
  truncated: false,
  files: [
    {
      path: 'apps/web/src/components/project-files/BrowseView.tsx',
      status: 'modified' as const,
      additions: 45,
      deletions: 12,
      isBinary: false,
      patchTruncated: false,
      patch: `@@ -10,6 +10,8 @@\n import { Spinner } from '@simple-agent-manager/ui';\n+import { ChevronRight } from 'lucide-react';\n \n export const BrowseView: FC = () => {\n-  const [loading, setLoading] = useState(true);\n+  const [loading, setLoading] = useState(false);\n+  const [query, setQuery] = useState('');`,
    },
    {
      path: 'apps/api/src/routes/files.ts',
      status: 'added' as const,
      additions: 72,
      deletions: 0,
      isBinary: false,
      patchTruncated: false,
      patch: `@@ -0,0 +1,72 @@\n+import { Hono } from 'hono';\n+\n+export const fileRoutes = new Hono();\n+\n+fileRoutes.get('/tree', async (c) => {\n+  return c.json({ entries: [] });\n+});`,
    },
    {
      path: 'README.md',
      status: 'modified' as const,
      additions: 8,
      deletions: 28,
      isBinary: false,
      patchTruncated: false,
      patch: `@@ -1,5 +1,5 @@\n-# Old Title\n+# New Title\n \n-Old description.\n+Updated description with more details.`,
    },
    {
      path: 'assets/logo.png',
      status: 'modified' as const,
      additions: 0,
      deletions: 0,
      isBinary: true,
      patchTruncated: false,
      patch: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page, options?: { emptyTree?: boolean; emptyCompare?: boolean }) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);

    // Branches (before project detail to avoid substring match)
    if (path.includes('/branches')) return respond(200, MOCK_BRANCHES);

    // Tree
    if (path.includes('/repo/tree')) {
      return respond(200, options?.emptyTree ? { entries: [], truncated: false } : MOCK_TREE);
    }

    // Compare
    if (path.includes('/repo/compare')) {
      return respond(200, options?.emptyCompare
        ? { filesChanged: 0, totalAdditions: 0, totalDeletions: 0, truncated: false, files: [] }
        : MOCK_COMPARE);
    }

    // Project detail (exact path — no trailing sub-resource)
    if (path.match(/\/api\/projects\/[^/]+$/) && !path.includes('/repo')) {
      return respond(200, MOCK_PROJECT);
    }

    // Project sub-resources
    if (path.match(/\/api\/projects\/[^/]+\//)) {
      if (path.includes('/sessions')) return respond(200, { sessions: [] });
      if (path.includes('/tasks')) return respond(200, { tasks: [] });
      if (path.includes('/activity')) return respond(200, { events: [] });
      if (path.includes('/members')) return respond(200, { members: [] });
      if (path.includes('/ideas')) return respond(200, { ideas: [] });
      if (path.includes('/skills')) return respond(200, { skills: [] });
      if (path.includes('/triggers')) return respond(200, { triggers: [] });
      if (path.includes('/policies')) return respond(200, { policies: [] });
      if (path.includes('/profiles')) return respond(200, []);
      if (path.includes('/knowledge')) return respond(200, { items: [] });
      if (path.includes('/workspaces')) return respond(200, []);
      if (path.includes('/deployments')) return respond(200, []);
    }

    // Notifications
    if (path.includes('/notifications')) return respond(200, { notifications: [], unreadCount: 0 });

    // Agents
    if (path === '/api/agents') return respond(200, []);

    // Dashboard tasks
    if (path.includes('/dashboard')) return respond(200, { tasks: [] });

    // GitHub installations
    if (path.includes('/installations')) return respond(200, []);

    // Catch-all — return empty array for list endpoints, empty object otherwise
    return respond(200, []);
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ---------------------------------------------------------------------------
// Mobile Tests (375px — iPhone SE)
// ---------------------------------------------------------------------------

test.describe('ProjectFiles — Mobile Light', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, colorScheme: 'light' });

  test('browse view — normal data', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/files?mode=browse');
    await page.waitForTimeout(2000);
    await screenshot(page, 'files-browse-mobile-light');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('changes view — normal data', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/files?mode=changes&ref=feature/file-browser-rework');
    await page.waitForTimeout(2000);
    await screenshot(page, 'files-changes-mobile-light');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('empty tree', async ({ page }) => {
    await setupApiMocks(page, { emptyTree: true });
    await page.goto('/projects/proj-test-1/files?mode=browse');
    await page.waitForTimeout(2000);
    await screenshot(page, 'files-empty-mobile-light');
  });
});

test.describe('ProjectFiles — Mobile Dark', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, colorScheme: 'dark' });

  test('browse view — normal data', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/files?mode=browse');
    await page.waitForTimeout(2000);
    await screenshot(page, 'files-browse-mobile-dark');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('changes view — normal data', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/files?mode=changes&ref=feature/file-browser-rework');
    await page.waitForTimeout(2000);
    await screenshot(page, 'files-changes-mobile-dark');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

// Desktop tests omitted — the desktop layout's app shell requires extensive
// mock data across many sidebar/navigation components that are outside the
// scope of the file browser changes. Mobile is the primary target.
