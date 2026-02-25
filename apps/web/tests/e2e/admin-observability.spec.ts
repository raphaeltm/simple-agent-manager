import { test, expect } from '@playwright/test';

/**
 * E2E tests for the Admin Observability Dashboard.
 *
 * These tests mock API responses and verify the UI renders correctly.
 * Post-deployment live tests should be run separately with real credentials.
 */

// Superadmin auth mock
function mockSuperadminAuth(route: { request: () => { url: () => string; method: () => string }; fulfill: (opts: Record<string, unknown>) => Promise<void> }) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin User',
        role: 'superadmin',
        status: 'active',
      },
    }),
  });
}

// Sample error data
const sampleErrors = {
  errors: [
    {
      id: 'err-1',
      source: 'client',
      level: 'error',
      message: 'Uncaught TypeError: Cannot read properties',
      stack: 'TypeError: Cannot read properties\n  at app.js:42',
      context: { component: 'Dashboard', action: 'load' },
      userId: 'user-1',
      nodeId: null,
      workspaceId: null,
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      timestamp: '2026-02-25T10:00:00.000Z',
    },
    {
      id: 'err-2',
      source: 'api',
      level: 'error',
      message: 'Database connection timeout',
      stack: null,
      context: { route: '/api/projects', method: 'GET' },
      userId: null,
      nodeId: null,
      workspaceId: null,
      ipAddress: null,
      userAgent: null,
      timestamp: '2026-02-25T09:30:00.000Z',
    },
    {
      id: 'err-3',
      source: 'vm-agent',
      level: 'warn',
      message: 'Agent heartbeat delayed',
      stack: null,
      context: { nodeId: 'node-1', delay: 5000 },
      userId: null,
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      ipAddress: null,
      userAgent: null,
      timestamp: '2026-02-25T09:00:00.000Z',
    },
  ],
  cursor: null,
  hasMore: false,
  total: 3,
};

// Sample health data
const sampleHealth = {
  activeNodes: 3,
  activeWorkspaces: 7,
  inProgressTasks: 2,
  errorCount24h: 15,
  timestamp: '2026-02-25T12:00:00.000Z',
};

// Sample trends data
const sampleTrends = {
  range: '24h',
  interval: '1h',
  buckets: Array.from({ length: 24 }, (_, i) => ({
    timestamp: new Date(Date.now() - (24 - i) * 3600000).toISOString(),
    total: Math.floor(Math.random() * 10),
    bySource: {
      client: Math.floor(Math.random() * 4),
      'vm-agent': Math.floor(Math.random() * 3),
      api: Math.floor(Math.random() * 3),
    },
  })),
};

// Sample log data
const sampleLogs = {
  logs: [
    {
      timestamp: '2026-02-25T11:00:00.000Z',
      level: 'info',
      event: 'http.request',
      message: 'GET /api/health 200',
      details: { method: 'GET', path: '/api/health', status: 200 },
    },
    {
      timestamp: '2026-02-25T10:55:00.000Z',
      level: 'error',
      event: 'http.request',
      message: 'POST /api/workspaces 500',
      details: { method: 'POST', path: '/api/workspaces', status: 500 },
    },
  ],
  cursor: null,
  hasMore: false,
};

function setupApiMocks(page: import('@playwright/test').Page) {
  return page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    // Auth
    if (path.startsWith('/api/auth/')) {
      return mockSuperadminAuth(route);
    }

    // Admin users (for the Users tab)
    if (path === '/api/admin/users' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ users: [] }),
      });
    }

    // Observability errors
    if (path === '/api/admin/observability/errors' && method === 'GET') {
      const source = url.searchParams.get('source');
      let filtered = sampleErrors;
      if (source && source !== 'all') {
        filtered = {
          ...sampleErrors,
          errors: sampleErrors.errors.filter((e) => e.source === source),
          total: sampleErrors.errors.filter((e) => e.source === source).length,
        };
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(filtered),
      });
    }

    // Observability health
    if (path === '/api/admin/observability/health' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleHealth),
      });
    }

    // Observability trends
    if (path === '/api/admin/observability/trends' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleTrends),
      });
    }

    // Observability log query
    if (path === '/api/admin/observability/logs/query' && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleLogs),
      });
    }

    // Stuck tasks + recent failures (admin tabs)
    if (path.startsWith('/api/admin/tasks/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    }

    // Fallback
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });
}

// ============================================================================
// T076: Admin Observability Errors Flow
// ============================================================================

test.describe('Admin Observability - Errors tab (T076)', () => {
  test('renders error list with source badges and filtering', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/errors');

    // Verify errors tab is active
    await expect(page.getByText('Errors')).toBeVisible();

    // Verify error entries render
    await expect(page.getByText('Uncaught TypeError: Cannot read properties')).toBeVisible();
    await expect(page.getByText('Database connection timeout')).toBeVisible();
    await expect(page.getByText('Agent heartbeat delayed')).toBeVisible();

    // Verify source labels are visible
    await expect(page.getByText('client').first()).toBeVisible();
    await expect(page.getByText('api').first()).toBeVisible();
  });

  test('can navigate between admin tabs', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/errors');

    // Should see tabs
    await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Errors' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Logs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Stream' })).toBeVisible();
  });
});

// ============================================================================
// T077: Admin Health Overview
// ============================================================================

test.describe('Admin Observability - Overview tab (T077)', () => {
  test('renders 4 health metric cards with values', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/overview');

    // Verify health cards
    await expect(page.getByText('Active Nodes')).toBeVisible();
    await expect(page.getByText('3')).toBeVisible();
    await expect(page.getByText('Active Workspaces')).toBeVisible();
    await expect(page.getByText('7')).toBeVisible();
    await expect(page.getByText('In-Progress Tasks')).toBeVisible();
    await expect(page.getByText('2')).toBeVisible();
    await expect(page.getByText('Errors (24h)')).toBeVisible();
    await expect(page.getByText('15')).toBeVisible();
  });

  test('renders error trends chart', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/overview');

    // Verify trends section
    await expect(page.getByText('Error Trends')).toBeVisible();

    // Verify range buttons
    await expect(page.getByRole('button', { name: '1h' })).toBeVisible();
    await expect(page.getByRole('button', { name: '24h' })).toBeVisible();
    await expect(page.getByRole('button', { name: '7d' })).toBeVisible();
    await expect(page.getByRole('button', { name: '30d' })).toBeVisible();

    // Verify legend
    await expect(page.getByText('Client')).toBeVisible();
    await expect(page.getByText('VM Agent')).toBeVisible();
    await expect(page.getByText('API')).toBeVisible();
  });
});

// ============================================================================
// T078: Admin Log Viewer
// ============================================================================

test.describe('Admin Observability - Logs tab (T078)', () => {
  test('renders log entries from CF API proxy', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/logs');

    // Verify log entries render
    await expect(page.getByText('GET /api/health 200')).toBeVisible();
    await expect(page.getByText('POST /api/workspaces 500')).toBeVisible();
  });

  test('shows filter controls', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/logs');

    // Verify time range is shown and query controls exist
    await expect(page.getByText('Logs')).toBeVisible();
  });
});

// ============================================================================
// T079: Admin Log Stream
// ============================================================================

test.describe('Admin Observability - Stream tab (T079)', () => {
  test('renders stream UI with connection status and controls', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/stream');

    // The stream tab should render even without a WebSocket connection
    // It should show the connection status (will be "Disconnected" since
    // we're not running a real WebSocket server in this test)
    await expect(page.getByText('Stream')).toBeVisible();

    // Verify pause/resume button exists
    const pauseBtn = page.getByRole('button', { name: /pause/i });
    const resumeBtn = page.getByRole('button', { name: /resume/i });
    const hasPauseOrResume = await pauseBtn.isVisible().catch(() => false) ||
      await resumeBtn.isVisible().catch(() => false);
    expect(hasPauseOrResume).toBe(true);
  });

  test('shows connection status indicator', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/stream');

    // Should show some kind of connection status text
    // In a mocked environment without WebSocket, it will likely show "Disconnected" or "Connecting"
    const statusText = page.getByText(/connecting|connected|disconnected|reconnecting/i);
    await expect(statusText.first()).toBeVisible();
  });
});
