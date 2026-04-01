import { expect, type Page, type Route,test } from '@playwright/test';

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
  name: 'My Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const GCP_CONNECTED_CRED = {
  connected: true,
  provider: 'gcp',
  gcpProjectId: 'my-gcp-project-id',
  serviceAccountEmail: 'sam-deploy@my-gcp-project-id.iam.gserviceaccount.com',
  createdAt: '2026-01-01T00:00:00Z',
};

const GCP_DISCONNECTED_CRED = {
  connected: false,
};

const GCP_LONG_EMAIL_CRED = {
  ...GCP_CONNECTED_CRED,
  serviceAccountEmail:
    'sam-oidc-deployment-service-account-very-long@really-long-project-id-that-goes-on-and-on.iam.gserviceaccount.com',
};

const MOCK_GCP_PROJECTS = [
  { projectId: 'proj-alpha', name: 'Alpha Project' },
  { projectId: 'proj-beta', name: 'Beta Service' },
  { projectId: 'a-very-long-gcp-project-id-that-might-overflow-on-mobile-screens', name: 'Long Name Project With Many Words' },
];

// ---------------------------------------------------------------------------
// API Mock Setup (mirrors ideas-ui-audit.spec.ts pattern)
// ---------------------------------------------------------------------------

type MockOptions = {
  gcpCredential?: typeof GCP_CONNECTED_CRED | typeof GCP_DISCONNECTED_CRED | typeof GCP_LONG_EMAIL_CRED;
  gcpProjects?: typeof MOCK_GCP_PROJECTS;
  setupError?: boolean;
  credentialLoadError?: boolean;
  slowCredentialLoad?: boolean;
  slowSetup?: boolean;
};

async function setupApiMocks(page: Page, options: MockOptions = {}) {
  const {
    gcpCredential = GCP_DISCONNECTED_CRED,
    gcpProjects = MOCK_GCP_PROJECTS,
    setupError = false,
    credentialLoadError = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth — BetterAuth calls /api/auth/get-session (and related paths)
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Credentials list (for configured cloud providers)
    if (path.startsWith('/api/credentials')) {
      return respond(200, []);
    }

    // Provider catalog
    if (path.startsWith('/api/provider-catalog')) {
      return respond(200, {
        catalogs: [
          {
            provider: 'hetzner',
            sizes: {
              small: { vcpu: 2, ramGb: 4, price: '$0.01/hr' },
              medium: { vcpu: 4, ramGb: 8, price: '$0.02/hr' },
              large: { vcpu: 8, ramGb: 16, price: '$0.04/hr' },
            },
          },
        ],
      });
    }

    // Project-scoped routes — must come before the generic /api/projects handler
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // GCP deployment — projects list (subPath starts with /deployment/gcp/projects)
      if (subPath.startsWith('/deployment/gcp/projects')) {
        return respond(200, { projects: gcpProjects });
      }

      // GCP deployment — setup
      if (subPath === '/deployment/gcp/setup' && method === 'POST') {
        if (setupError) {
          return respond(500, { code: 'SETUP_FAILED', message: 'GCP setup failed: insufficient permissions' });
        }
        return respond(200, { success: true, credential: GCP_CONNECTED_CRED });
      }

      // GCP deployment — delete
      if (subPath === '/deployment/gcp' && method === 'DELETE') {
        return respond(200, { success: true });
      }

      // GCP deployment — get
      if (subPath === '/deployment/gcp' && method === 'GET') {
        if (credentialLoadError) {
          return respond(500, { code: 'INTERNAL', message: 'Internal error' });
        }
        return respond(200, gcpCredential);
      }

      // Runtime config
      if (subPath === '/runtime-config') {
        return respond(200, { envVars: [], files: [] });
      }

      // Sessions
      if (subPath.startsWith('/sessions')) {
        return respond(200, { sessions: [], total: 0 });
      }

      // Project detail
      if (!subPath || subPath === '/') {
        return respond(200, MOCK_PROJECT);
      }

      // Tasks
      if (subPath.startsWith('/tasks')) {
        return respond(200, { tasks: [], nextCursor: null });
      }
    }

    // Projects list
    if (path === '/api/projects') {
      return respond(200, { projects: [MOCK_PROJECT] });
    }

    // Dashboard
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
    }

    // GitHub
    if (path.startsWith('/api/github')) {
      return respond(200, []);
    }

    // Catch-all
    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow, 'No horizontal overflow expected').toBe(false);
}

// Navigate to settings and wait for the Deploy to Cloud section to be visible
async function gotoSettings(page: Page, extraParams = '') {
  await page.goto(`/projects/proj-test-1/settings${extraParams}`);
  await page.waitForSelector('text=Deploy to Cloud', { timeout: 10000 });
}

// ---------------------------------------------------------------------------
// Mobile tests (default viewport: 375x667)
// ---------------------------------------------------------------------------

test.describe('DeploymentSettings — Mobile', () => {
  test('disconnected state — idle', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED });
    await gotoSettings(page);
    await screenshot(page, 'deployment-settings-disconnected-mobile');
    await assertNoHorizontalOverflow(page);

    // Primary CTA must be visible and accessible
    const connectBtn = page.getByRole('button', { name: 'Connect Google Cloud' });
    await expect(connectBtn).toBeVisible();

    // Touch target check: Button uses min-h-9 (36px) for size="sm"
    const box = await connectBtn.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(36);
  });

  test('connected state shows project id and service account', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_CONNECTED_CRED });
    await gotoSettings(page);
    await page.waitForSelector('text=GCP Connected');
    await screenshot(page, 'deployment-settings-connected-mobile');
    await assertNoHorizontalOverflow(page);

    await expect(page.getByText('my-gcp-project-id')).toBeVisible();
    await expect(page.getByText('sam-deploy@my-gcp-project-id.iam.gserviceaccount.com')).toBeVisible();

    const disconnectBtn = page.getByRole('button', { name: 'Disconnect' });
    await expect(disconnectBtn).toBeVisible();
  });

  test('connected state — long service account email does not overflow', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_LONG_EMAIL_CRED });
    await gotoSettings(page);
    await page.waitForSelector('text=GCP Connected');
    await screenshot(page, 'deployment-settings-long-email-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('project selection phase after OAuth callback', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED, gcpProjects: MOCK_GCP_PROJECTS });
    await gotoSettings(page, '?gcp_deploy_setup=mock-oauth-handle-abc123');
    await page.waitForSelector('text=Select GCP Project', { timeout: 10000 });
    await screenshot(page, 'deployment-settings-project-select-mobile');
    await assertNoHorizontalOverflow(page);

    // The select has an explicit id for accessibility
    const select = page.locator('#gcp-deploy-project');
    await expect(select).toBeVisible();

    await expect(page.getByRole('button', { name: 'Set Up Deployment' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('project select dropdown with long project ids does not overflow', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED, gcpProjects: MOCK_GCP_PROJECTS });
    await gotoSettings(page, '?gcp_deploy_setup=mock-handle');
    await page.waitForSelector('#gcp-deploy-project');
    await screenshot(page, 'deployment-settings-long-project-id-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('empty GCP projects list — Set Up Deployment disabled', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED, gcpProjects: [] });
    await gotoSettings(page, '?gcp_deploy_setup=mock-handle');
    await page.waitForSelector('text=Select GCP Project', { timeout: 10000 });
    await screenshot(page, 'deployment-settings-no-projects-mobile');
    await assertNoHorizontalOverflow(page);

    // "Set Up Deployment" must be disabled when selectedGcpProject is empty
    const setupBtn = page.getByRole('button', { name: 'Set Up Deployment' });
    await expect(setupBtn).toBeDisabled();
  });

  test('error state on credential load failure falls back to disconnected', async ({ page }) => {
    await setupApiMocks(page, { credentialLoadError: true });
    await gotoSettings(page);
    await screenshot(page, 'deployment-settings-load-error-mobile');
    await assertNoHorizontalOverflow(page);

    // On catch, setDeploymentCred({ connected: false }) — shows Connect button
    await expect(page.getByRole('button', { name: 'Connect Google Cloud' })).toBeVisible();
  });

  test('OAuth error param shows error toast and removes param from URL', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED });
    await page.goto('/projects/proj-test-1/settings?gcp_deploy_error=access_denied');
    await page.waitForSelector('text=Deploy to Cloud');
    // Small wait to let the effect clean the URL
    await page.waitForTimeout(300);
    const url = page.url();
    expect(url).not.toContain('gcp_deploy_error');
    await screenshot(page, 'deployment-settings-oauth-error-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('setup API error returns to project-select phase', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED, gcpProjects: MOCK_GCP_PROJECTS, setupError: true });
    await gotoSettings(page, '?gcp_deploy_setup=mock-handle');
    await page.waitForSelector('#gcp-deploy-project');
    await page.getByRole('button', { name: 'Set Up Deployment' }).click();
    // After error, phase should revert to project-select (selector still visible)
    await page.waitForSelector('text=Select GCP Project', { timeout: 10000 });
    await screenshot(page, 'deployment-settings-setup-error-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('loading state is shown while credential loads', async ({ page }) => {
    // Use a slow response for /deployment/gcp to catch the loading skeleton
    await page.route('**/api/projects/proj-test-1/deployment/gcp', async (route) => {
      const url = new URL(route.request().url());
      // Only delay the GET (not the /projects sub-path)
      if (!url.pathname.includes('/projects') && route.request().method() === 'GET') {
        await new Promise((r) => setTimeout(r, 2000));
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(GCP_DISCONNECTED_CRED),
      });
    });
    await setupApiMocks(page, {});
    await page.goto('/projects/proj-test-1/settings');
    // Look for the loading text inside DeploymentSettings
    await page.waitForSelector('text=Loading deployment config...', { timeout: 8000 });
    await screenshot(page, 'deployment-settings-loading-mobile');
    await assertNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('DeploymentSettings — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('disconnected state', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED });
    await gotoSettings(page);
    await screenshot(page, 'deployment-settings-disconnected-desktop');
    await assertNoHorizontalOverflow(page);

    await expect(page.getByRole('button', { name: 'Connect Google Cloud' })).toBeVisible();
  });

  test('connected state', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_CONNECTED_CRED });
    await gotoSettings(page);
    await page.waitForSelector('text=GCP Connected');
    await screenshot(page, 'deployment-settings-connected-desktop');
    await assertNoHorizontalOverflow(page);

    await expect(page.getByText('my-gcp-project-id')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  test('project selection phase', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED, gcpProjects: MOCK_GCP_PROJECTS });
    await gotoSettings(page, '?gcp_deploy_setup=mock-handle');
    await page.waitForSelector('text=Select GCP Project', { timeout: 10000 });
    await screenshot(page, 'deployment-settings-project-select-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('section placement between Runtime Config and Danger Zone', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_DISCONNECTED_CRED });
    await gotoSettings(page);
    await expect(page.getByText('Runtime Config')).toBeVisible();
    await expect(page.getByText('Danger Zone')).toBeVisible();
    await screenshot(page, 'deployment-settings-placement-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('connected state — long service account email does not overflow', async ({ page }) => {
    await setupApiMocks(page, { gcpCredential: GCP_LONG_EMAIL_CRED });
    await gotoSettings(page);
    await page.waitForSelector('text=GCP Connected');
    await screenshot(page, 'deployment-settings-long-email-desktop');
    await assertNoHorizontalOverflow(page);
  });
});
