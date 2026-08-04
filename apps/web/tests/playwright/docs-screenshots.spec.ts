/**
 * Documentation screenshots — renders the REAL production components with mocked
 * API data and captures the images embedded in the public docs site
 * (apps/www/src/content/docs).
 *
 * Run with the docs output flag to write committed images:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots --project="Desktop (1280x800)"
 *
 * Without DOCS_SHOTS the images land in the gitignored tmp dir, so the spec is
 * safe to run as part of the normal visual-audit sweep.
 *
 * Covered surfaces:
 *   1. Guided subscription sign-in modal (Claude Code) — /settings/agents
 *   2. Cloud provider connect picker (all seven providers) — /settings/connections
 *   3. Report an Issue dialog with consent expanded — project chat session header
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import { type AuditResponder, makeMockUser, seedTheme, setupAuditRoutes } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'docs@example.com',
  name: 'Docs User',
  role: 'superadmin',
  sessionId: 'docs-session',
  userId: 'docs-user',
});

const DOCS_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/docs');

/**
 * Capture a focused element (or the full page) into the docs image directory when
 * DOCS_SHOTS is set, otherwise into the gitignored tmp dir with a viewport suffix.
 */
async function docsShot(page: Page, name: string, locator?: ReturnType<Page['locator']>) {
  await page.waitForTimeout(500);
  const target = locator ?? page;
  if (process.env.DOCS_SHOTS) {
    mkdirSync(DOCS_IMAGE_DIR, { recursive: true });
    await target.screenshot({ path: `${DOCS_IMAGE_DIR}/${name}.png` });
    return;
  }
  const suffix = page.viewportSize()?.width ?? 'x';
  const tmp = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
  mkdirSync(tmp, { recursive: true });
  await target.screenshot({ path: `${tmp}/${name}-${suffix}.png` });
}

async function dismissOnboarding(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
}

// ---------------------------------------------------------------------------
// 1. Guided subscription sign-in (Claude Code)
// ---------------------------------------------------------------------------

const CLAUDE_AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  description: "Anthropic's AI coding agent",
  supportsAcp: true,
  configured: false,
  credentialHelpUrl: 'https://console.anthropic.com/settings/keys',
  fallbackCredentialSource: null,
};

const SETUP_SESSION = {
  id: 'docs-guided-claude',
  status: 'waiting_for_user',
  agentType: 'claude-code',
  expiresAt: new Date(Date.now() + 1_200_000).toISOString(),
  verificationUrl: 'https://claude.ai/oauth/device?client_id=sam-docs&code=' + 'x'.repeat(48),
  userCode: 'SAMD-4821',
  errorCode: null,
  errorMessage: null,
};

async function setupGuidedMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/agents') return respond(200, { agents: [CLAUDE_AGENT] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/agent-credential-setup-sessions/config') {
      return respond(200, {
        enabled: true,
        agentType: 'openai-codex',
        agentTypes: ['openai-codex', 'claude-code'],
      });
    }
    if (path === '/api/agent-credential-setup-sessions' && method === 'POST') {
      return respond(201, SETUP_SESSION);
    }
    if (path === `/api/agent-credential-setup-sessions/${SETUP_SESSION.id}`) {
      return respond(200, SETUP_SESSION);
    }
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.startsWith('/api/github')) return respond(200, []);
    return respond(200, {});
  });
}

test('docs: guided subscription sign-in modal (Claude Code)', async ({ page }) => {
  await dismissOnboarding(page);
  await seedTheme(page, 'dark');
  await setupGuidedMocks(page);

  await page.goto('/settings/agents');
  await expect(page.getByTestId('agent-card-claude-code')).toBeVisible();

  await page.getByRole('button', { name: 'OAuth Token (Pro/Max)' }).click();
  await page.getByRole('button', { name: 'Connect with Claude Code' }).click();

  const dialog = page.getByRole('dialog', { name: 'Connect with Claude Code' });
  await expect(dialog.getByRole('link', { name: 'Open Claude sign-in' })).toBeVisible();
  await expect(dialog.locator('code')).toHaveText(SETUP_SESSION.userCode);
  await expect(dialog.getByRole('button', { name: 'Copy code' })).toBeVisible();

  // Make the backdrop fully opaque so the settings page behind the modal does not
  // bleed through the card's rounded corners in the docs screenshot.
  await page.addStyleTag({
    content:
      '.glass-backdrop-dim{background:#0a0e0c !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  });

  // Screenshot just the modal card (not the full-viewport backdrop overlay).
  await docsShot(page, 'agent-guided-login', dialog.locator('.glass-panel-container'));
});

// ---------------------------------------------------------------------------
// 2. Cloud provider connect picker (all seven providers)
// ---------------------------------------------------------------------------

const RESOLUTION_CONSUMERS = [
  {
    consumerId: 'claude-code',
    consumerName: 'Claude Code',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Claude default key',
    credentialKind: 'api-key',
    configurationName: 'Claude Code default',
    statusReason: null,
    halted: false,
    validation: { status: 'valid', message: 'Credential format is valid' },
  },
  {
    consumerId: 'hetzner',
    consumerName: 'Hetzner Cloud',
    consumerKind: 'compute',
    source: 'unresolved',
    credentialName: null,
    credentialKind: null,
    configurationName: null,
    statusReason: null,
    halted: false,
    validation: undefined,
  },
];

async function setupCloudConnectMocks(page: Page) {
  await setupAuditRoutes(page, (path: string, respond: AuditResponder) => {
    if (path.includes('/api/auth')) return respond(200, MOCK_USER);
    if (path === '/api/credentials/resolution-status') {
      return respond(200, { consumers: RESOLUTION_CONSUMERS });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path === '/api/github/installations') return respond(200, []);
    return undefined;
  });
}

test('docs: cloud provider connect picker', async ({ page }) => {
  await dismissOnboarding(page);
  await seedTheme(page, 'dark');
  await setupCloudConnectMocks(page);

  await page.goto('/settings/connections');
  await page.waitForSelector('.glass-surface', { state: 'visible', timeout: 20000 });

  // The unresolved Hetzner (compute) row exposes a "Make default" action (its
  // onConnect handler) that opens the cloud provider picker.
  await page.getByRole('button', { name: 'Make default' }).click();

  // The picker renders a card for every provider; wait for the ones added most
  // recently so we know the full list is on screen.
  await expect(page.getByText('DigitalOcean', { exact: true })).toBeVisible();
  await expect(page.getByText('UpCloud', { exact: true })).toBeVisible();
  await expect(page.getByText('Infomaniak Public Cloud', { exact: true })).toBeVisible();

  const card = page.locator('.glass-surface').filter({ hasText: 'UpCloud' }).first();
  await docsShot(page, 'cloud-provider-connect', card);
});

// ---------------------------------------------------------------------------
// 3. Report an Issue dialog (consent expanded, showing attachable refs)
// ---------------------------------------------------------------------------

const REPORT_PROJECT = {
  id: 'proj-1',
  name: 'acme/checkout-service',
  repository: 'acme/checkout-service',
  defaultBranch: 'main',
  userId: MOCK_USER.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const REPORT_WORKSPACE = {
  id: 'ws-1',
  nodeId: '01K9NODE7QM3D0PXR4TVYB2K5A',
  projectId: 'proj-1',
  name: 'ws-checkout-1',
  displayName: 'Checkout workspace',
  repository: 'acme/checkout-service',
  branch: 'sam/fix-checkout-retry',
  status: 'running',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  workspaceProfile: 'full',
  vmIp: '10.0.0.1',
  url: 'https://ws-ws-1.example.com',
  lastActivityAt: '2026-07-01T00:10:00Z',
  errorMessage: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:10:00Z',
};

const REPORT_SESSION = {
  id: '01K9CHAT5EFJ8TW0N6RQZD3M2X',
  workspaceId: 'ws-1',
  taskId: '01K9TASKB2YH7VC1KG8XPMR40D',
  topic: 'Fix the checkout retry loop',
  status: 'active',
  messageCount: 12,
  startedAt: Date.parse('2026-07-01T00:02:00Z'),
  endedAt: null,
  createdAt: Date.parse('2026-07-01T00:00:00Z'),
  lastMessageAt: Date.parse('2026-07-01T00:10:00Z'),
  isIdle: false,
  isTerminated: false,
  agentSessionId: 'acp-1',
  agentType: 'claude-code',
  task: {
    id: '01K9TASKB2YH7VC1KG8XPMR40D',
    status: 'in_progress',
    executionStep: 'agent_session',
    errorMessage: null,
    outputBranch: 'sam/fix-checkout-retry',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'default',
  },
};

async function setupReportIssueMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/report-issue/config') return respond(200, { enabled: true });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/workspaces/ws-1') return respond(200, REPORT_WORKSPACE);
    if (path.startsWith('/api/workspaces/ws-1/ports')) return respond(200, { ports: [] });
    if (path === `/api/nodes/${REPORT_WORKSPACE.nodeId}`) {
      return respond(200, {
        id: REPORT_WORKSPACE.nodeId,
        status: 'running',
        healthStatus: 'healthy',
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') return respond(200, { sessions: [REPORT_SESSION], total: 1 });
      if (subPath.match(/\/sessions\/[^/]+\/messages/))
        return respond(200, { messages: [], hasMore: false });
      if (subPath.match(/\/sessions\/[^/]+$/)) {
        return respond(200, { session: REPORT_SESSION, messages: [], hasMore: false });
      }
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      return respond(200, REPORT_PROJECT);
    }
    if (path === '/api/projects')
      return respond(200, { projects: [REPORT_PROJECT], nextCursor: null });
    return respond(200, {});
  });
}

test('docs: report an issue dialog with consent expanded', async ({ page }) => {
  await dismissOnboarding(page);
  await seedTheme(page, 'dark');
  await setupReportIssueMocks(page);

  await page.goto(`/projects/proj-1/chat/${REPORT_SESSION.id}`);

  // The Report action lives in the expanded session-header action row.
  const expand = page.locator('button[aria-label="Show session details"]').first();
  await expand.waitFor({ state: 'visible', timeout: 20000 });
  await expand.click();
  await page.getByRole('button', { name: 'Report' }).click();

  const dialog = page.getByRole('dialog', { name: 'Report an issue' });
  await expect(dialog).toBeVisible();

  await page
    .getByPlaceholder('Brief summary of the issue')
    .fill('Agent stopped responding mid-task');
  await page
    .getByPlaceholder(/What happened/)
    .fill(
      'The agent was editing the retry handler, then went quiet for 20 minutes with no output. ' +
        'I expected it to either finish or report an error.'
    );

  // Consent is off by default; check it so the docs image shows exactly which
  // identifiers SAM offers to attach.
  await page.getByRole('checkbox').check();
  await expect(page.getByText(REPORT_SESSION.id)).toBeVisible();

  await page.addStyleTag({
    content:
      '.glass-backdrop-dim{background:#0a0e0c !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  });

  await docsShot(page, 'report-issue-dialog', dialog.locator('.glass-panel-container'));
});

// ---------------------------------------------------------------------------
// 4. Instant runtime interrupted-delivery banner
//
// The banner a user has to act on: their message was saved, but SAM cannot tell
// whether the agent already executed it. The message text below is the real
// server default (RUNTIME_REQUEST_INTERRUPTED_MESSAGE in
// apps/api/src/durable-objects/vm-agent-container-recovery.ts) so the docs image
// matches what a user actually sees.
// ---------------------------------------------------------------------------

const RECOVERY_PROJECT_ID = 'proj-1';
const RECOVERY_SESSION_ID = '01K9CHAT5EFJ8TW0N6RQZD3M2X';
const RECOVERY_WORKSPACE_ID = 'ws-1';

const RUNTIME_REQUEST_INTERRUPTED_MESSAGE =
  'Your message is saved, but delivery was interrupted and its execution outcome is unknown. ' +
  'It was not replayed automatically. After restore finishes, check the transcript and partial ' +
  'output before deciding whether to send it again.';

const RECOVERY_MESSAGES = [
  {
    id: 'msg-1',
    sessionId: RECOVERY_SESSION_ID,
    role: 'user',
    content: 'Add a retry with backoff to the checkout webhook handler.',
    toolMetadata: null,
    createdAt: Date.parse('2026-07-01T00:02:00Z'),
    sequence: 1,
  },
  {
    id: 'msg-2',
    sessionId: RECOVERY_SESSION_ID,
    role: 'assistant',
    content:
      'I added an exponential backoff wrapper around the webhook dispatch and updated the tests. ' +
      'Running the suite now.',
    toolMetadata: null,
    createdAt: Date.parse('2026-07-01T00:04:00Z'),
    sequence: 2,
  },
];

async function setupRecoveryMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/report-issue/config') return respond(200, { enabled: false });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/terminal/token') return respond(200, { token: 'docs-token' });
    if (path === `/api/workspaces/${RECOVERY_WORKSPACE_ID}`) {
      return respond(200, { ...REPORT_WORKSPACE, status: 'running' });
    }
    if (path.startsWith(`/api/workspaces/${RECOVERY_WORKSPACE_ID}/ports`))
      return respond(200, { ports: [] });
    if (path === `/api/nodes/${REPORT_WORKSPACE.nodeId}`) {
      return respond(200, {
        id: REPORT_WORKSPACE.nodeId,
        status: 'running',
        healthStatus: 'healthy',
      });
    }

    // The follow-up prompt is rejected with the interrupted-delivery code.
    if (path === `/api/projects/${RECOVERY_PROJECT_ID}/sessions/${RECOVERY_SESSION_ID}/prompt`) {
      return respond(409, {
        error: 'RUNTIME_REQUEST_INTERRUPTED',
        message: RUNTIME_REQUEST_INTERRUPTED_MESSAGE,
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') {
        return respond(200, { sessions: [REPORT_SESSION], total: 1, hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, { messages: RECOVERY_MESSAGES, hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+$/)) {
        return respond(200, {
          session: REPORT_SESSION,
          messages: RECOVERY_MESSAGES,
          hasMore: false,
          state: {
            activity: 'idle',
            activityAt: Date.parse('2026-07-01T00:04:00Z'),
            statusError: null,
            currentPlan: [],
            planUpdatedAt: null,
            promptStartedAt: null,
            agentType: 'claude-code',
            lastStopReason: null,
          },
        });
      }
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      if (subPath === '/tasks') return respond(200, { tasks: [], total: 0 });
      return respond(200, REPORT_PROJECT);
    }
    if (path === '/api/projects')
      return respond(200, { projects: [REPORT_PROJECT], nextCursor: null });
    return respond(200, {});
  });
}

test('docs: instant runtime interrupted-delivery banner', async ({ page }) => {
  await dismissOnboarding(page);
  await seedTheme(page, 'dark');
  await setupRecoveryMocks(page);

  await page.goto(`/projects/${RECOVERY_PROJECT_ID}/chat/${RECOVERY_SESSION_ID}`);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible({ timeout: 20000 });

  const composer = page.getByPlaceholder(/send a message/i);
  await composer.fill('Did the tests pass?');
  await page.getByRole('button', { name: /^send$/i }).click();

  const banner = page.getByRole('alert').filter({ hasText: 'delivery was interrupted' });
  await expect(banner).toBeVisible();

  await docsShot(page, 'instant-recovery-interrupted', banner);
});
