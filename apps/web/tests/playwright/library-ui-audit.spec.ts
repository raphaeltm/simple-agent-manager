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

function makeFile(overrides: {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  directory?: string;
  uploadSource?: string;
  tags?: string[];
}) {
  const tags = (overrides.tags ?? []).map((tag, i) => ({
    id: `tag-${overrides.id}-${i}`,
    fileId: overrides.id,
    tag,
    createdAt: '2026-04-01T00:00:00Z',
  }));
  return {
    id: overrides.id,
    projectId: 'proj-test-1',
    filename: overrides.filename,
    mimeType: overrides.mimeType ?? 'text/plain',
    sizeBytes: overrides.sizeBytes ?? 1024,
    directory: overrides.directory ?? '/',
    uploadSource: overrides.uploadSource ?? 'user',
    description: null,
    status: 'active',
    r2Key: `files/${overrides.id}`,
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-04-01T10:00:00Z',
    tags,
  };
}

function makeDirectory(overrides: { name: string; path: string; fileCount: number }) {
  return {
    name: overrides.name,
    path: overrides.path,
    fileCount: overrides.fileCount,
  };
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

const NORMAL_DIRS = [
  makeDirectory({ name: 'docs', path: '/docs', fileCount: 5 }),
  makeDirectory({ name: 'images', path: '/images', fileCount: 12 }),
  makeDirectory({ name: 'configs', path: '/configs', fileCount: 3 }),
];

const NORMAL_FILES = [
  makeFile({ id: 'f1', filename: 'README.md', mimeType: 'text/markdown', sizeBytes: 2048, tags: ['docs', 'important'] }),
  makeFile({ id: 'f2', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 45000, tags: ['branding'] }),
  makeFile({ id: 'f3', filename: 'config.json', mimeType: 'application/json', sizeBytes: 512 }),
  makeFile({ id: 'f4', filename: 'notes.txt', sizeBytes: 150, uploadSource: 'agent', tags: ['ai-generated'] }),
];

const LONG_TEXT_DIRS = [
  makeDirectory({ name: 'this-is-a-very-long-directory-name-that-should-be-truncated-properly', path: '/long-dir-1', fileCount: 42 }),
  makeDirectory({ name: 'another-extremely-long-folder-name-for-testing-overflow', path: '/long-dir-2', fileCount: 7 }),
];

const LONG_TEXT_FILES = [
  makeFile({ id: 'lt1', filename: 'this-is-a-very-long-filename-that-should-truncate-without-causing-horizontal-overflow.md', mimeType: 'text/markdown', sizeBytes: 99999, tags: ['tag-one', 'tag-two', 'really-long-tag-name', 'another-tag'] }),
  makeFile({ id: 'lt2', filename: 'another-extremely-long-filename-for-testing-text-overflow.json', mimeType: 'application/json', sizeBytes: 512 }),
];

const MANY_DIRS = Array.from({ length: 8 }, (_, i) =>
  makeDirectory({ name: `folder-${i + 1}`, path: `/folder-${i + 1}`, fileCount: i * 3 + 1 }),
);

const MANY_FILES = Array.from({ length: 25 }, (_, i) =>
  makeFile({
    id: `many-${i}`,
    filename: `file-${String(i + 1).padStart(2, '0')}.txt`,
    sizeBytes: (i + 1) * 100,
    uploadSource: i % 3 === 0 ? 'agent' : 'user',
    tags: i % 4 === 0 ? ['auto'] : [],
  }),
);

const DIRECTORY_NAV_DIRS = [
  makeDirectory({ name: 'Nebula', path: '/Nebula/', fileCount: 1 }),
];

const DIRECTORY_NAV_FILES = [
  makeFile({
    id: 'nebula-thesis',
    filename: 'nebula-thesis.md',
    mimeType: 'text/markdown',
    sizeBytes: 18132,
    directory: '/Nebula/',
    tags: ['strategy'],
  }),
];

// ---------------------------------------------------------------------------
// Single route handler for all API calls (follows existing pattern)
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    files?: ReturnType<typeof makeFile>[];
    directories?: ReturnType<typeof makeDirectory>[];
    total?: number;
    errorOnFiles?: boolean;
  } = {},
) {
  const {
    files = NORMAL_FILES,
    directories = NORMAL_DIRS,
    total = files.length,
    errorOnFiles = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Dashboard active tasks
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
    }

    // GitHub installations
    if (path === '/api/github/installations') {
      return respond(200, []);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Agents
    if (path === '/api/agents') {
      return respond(200, []);
    }

    // Credentials
    if (path.startsWith('/api/credentials')) {
      return respond(200, []);
    }

    // Projects list
    if (path === '/api/projects') {
      return respond(200, { projects: [MOCK_PROJECT] });
    }

    // Single project
    if (path === '/api/projects/proj-test-1') {
      return respond(200, MOCK_PROJECT);
    }

    // Library directories
    if (path.includes('/library/directories')) {
      const parentDirectory = url.searchParams.get('parentDirectory') ?? '/';
      const parentDepth = parentDirectory === '/' ? 0 : parentDirectory.split('/').filter(Boolean).length;
      const scopedDirectories = directories.filter((directory) => {
        const segments = directory.path.split('/').filter(Boolean);
        if (segments.length !== parentDepth + 1) return false;
        return parentDirectory === '/' || directory.path.startsWith(parentDirectory);
      });
      return respond(200, { directories: scopedDirectories });
    }

    // Library files. Match the API contract closely enough to catch regressions:
    // root-only by default, recursive only when explicitly requested.
    if (path.includes('/library') && !path.includes('/library/')) {
      if (errorOnFiles) {
        return respond(500, { message: 'Internal server error' });
      }
      const directory = url.searchParams.get('directory');
      const recursive = url.searchParams.get('recursive') === 'true';
      const search = url.searchParams.get('search');
      const scopedFiles = files.filter((file) => {
        if (directory) {
          return recursive ? file.directory.startsWith(directory) : file.directory === directory;
        }
        if (!recursive && !search) return file.directory === '/';
        return true;
      });
      const responseTotal = total === files.length ? scopedFiles.length : total;
      return respond(200, { files: scopedFiles, total: responseTotal, cursor: null });
    }

    // Sessions
    if (path.includes('/sessions')) {
      return respond(200, { sessions: [] });
    }

    // Tasks
    if (path.includes('/tasks')) {
      return respond(200, { tasks: [], total: 0 });
    }

    // Catch-all
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Screenshot Helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(800);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}${suffix}.png`,
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
// Tests — Mobile (default from config: 375x667)
// ---------------------------------------------------------------------------

test.describe('Library — Mobile', () => {
  test('normal data with directories and files', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-normal-mobile');
    await assertNoOverflow(page);
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { files: LONG_TEXT_FILES, directories: LONG_TEXT_DIRS });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { files: [], directories: [], total: 0 });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-empty-mobile');
    await assertNoOverflow(page);
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, { files: MANY_FILES, directories: MANY_DIRS, total: MANY_FILES.length });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-many-items-mobile');
    await assertNoOverflow(page);
  });

  test('filter panel open', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await page.click('button[aria-label="Toggle filters"]');
    await page.waitForTimeout(300);
    await screenshot(page, 'library-filters-open-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests — Desktop
// ---------------------------------------------------------------------------

test.describe('Library — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('normal data — directories are square cards', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-normal-desktop');
    await assertNoOverflow(page);

    // Verify directory cards exist and are roughly square
    const dirButtons = page.locator('button[aria-label^="Folder:"]');
    const count = await dirButtons.count();
    expect(count).toBe(NORMAL_DIRS.length);

    if (count > 0) {
      const box = await dirButtons.first().boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        const ratio = box.width / box.height;
        // Should be roughly square (between 0.7 and 1.3)
        expect(ratio).toBeGreaterThan(0.7);
        expect(ratio).toBeLessThan(1.3);
      }
    }
  });

  test('directory navigation uses the recursive client index', async ({ page }) => {
    await setupApiMocks(page, {
      files: DIRECTORY_NAV_FILES,
      directories: DIRECTORY_NAV_DIRS,
      total: DIRECTORY_NAV_FILES.length,
    });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');

    await expect(page.getByRole('button', { name: 'Folder: Nebula, 1 file' })).toBeVisible();
    await page.getByRole('button', { name: 'Folder: Nebula, 1 file' }).click();

    await expect(page).toHaveURL(/dir=%2FNebula%2F|dir=\/Nebula\//);
    await expect(page.getByText('nebula-thesis.md')).toBeVisible();
    await screenshot(page, 'library-directory-navigation-desktop');
    await assertNoOverflow(page);
  });

  test('grid view — directories separate from files', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await page.click('button[aria-label="Grid view"]');
    await page.waitForTimeout(300);
    await screenshot(page, 'library-grid-view-desktop');
    await assertNoOverflow(page);
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, { files: LONG_TEXT_FILES, directories: LONG_TEXT_DIRS });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-long-text-desktop');
    await assertNoOverflow(page);
  });

  test('many items with directories', async ({ page }) => {
    await setupApiMocks(page, { files: MANY_FILES, directories: MANY_DIRS, total: MANY_FILES.length });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-many-items-desktop');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { files: [], directories: [], total: 0 });
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await screenshot(page, 'library-empty-desktop');
    await assertNoOverflow(page);
  });

  test('filter panel with search input', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/library');
    await page.waitForSelector('h1:has-text("Library")');
    await page.click('button[aria-label="Toggle filters"]');
    await page.waitForTimeout(300);
    await page.fill('input[placeholder*="Search"]', 'test');
    await page.waitForTimeout(100);
    await screenshot(page, 'library-search-typing-desktop');
    await assertNoOverflow(page);
  });
});
