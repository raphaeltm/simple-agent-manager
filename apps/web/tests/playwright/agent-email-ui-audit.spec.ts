/**
 * Visual and layout audit for the agent email (preview) feature: the "Email" automation start,
 * an email trigger's detail page (address, copy button, allowed senders, no Run now), and the
 * admin "Agent email" status/loopback panel. Runs at 375x667 and 1280x800 with stress data: a
 * very long trigger name, a long address, 15+ allowed senders, and empty-state fallbacks.
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const PROJECT_ID = 'proj-agent-email';
const OWNER_ID = 'owner-agent-email';
const BASE = `/projects/${PROJECT_ID}/automation`;

function onlyOn(names: string[]) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(!names.includes(testInfo.project.name), 'audited on phone and desktop only');
  };
}
test.beforeEach(onlyOn(['iPhone SE (375x667)', 'Desktop (1280x800)']));

const LONG_NAME =
  'Nightly support inbox triage across every regional mailbox, including escalations, billing disputes and partner integration questions, summarized for the on-call rotation';

/** 18 addresses on a long company domain: stresses wrapping, not just count. */
function manySenders(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `person-${i + 1}@a-genuinely-long-partner-company-domain-name.example`
  );
}

const USER = makeMockUser({
  email: `${OWNER_ID}@example.com`,
  name: 'Owner User',
  sessionId: `session-${OWNER_ID}`,
  userId: OWNER_ID,
});

const PROJECT = {
  id: PROJECT_ID,
  name: 'Support Automations',
  repository: 'acme/support-automations',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: OWNER_ID,
  installationId: 'inst-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  multiplayerActive: false,
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};

const PROFILES = [
  { id: 'profile-support', name: 'Support Agent', model: 'claude-opus-5-5', effort: 'auto' },
];

function emailTrigger(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trg-email-stress',
    projectId: PROJECT_ID,
    userId: OWNER_ID,
    name: LONG_NAME,
    description: null,
    status: 'active',
    sourceType: 'email',
    cronExpression: null,
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate:
      'You received an email at your SAM address.\n\nFrom: {{email.fromName}} <{{email.from}}>\nSubject: {{email.subject}}\n\n{{email.text}}\n\nDo what the email asks. When you are done, reply to the sender with the reply_to_email tool.',
    agentProfileId: 'profile-support',
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 7,
    nextFireAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    emailConfig: {
      address: 'agent+k3j2h7m9q2xw4n8p@mail.a-really-long-self-hosted-staging-domain.example',
      allowedSenders: manySenders(18),
    },
    ...overrides,
  };
}

interface MockOptions {
  /** Whether `/api/config/agent-email` reports this deployment as configured. */
  agentEmailEnabled?: boolean;
  /** Triggers list; defaults to just the stress email trigger. */
  triggers?: Array<Record<string, unknown>>;
}

async function setupAgentEmailMocks(page: Page, options: MockOptions = {}) {
  const agentEmailEnabled = options.agentEmailEnabled ?? true;
  const triggers = options.triggers ?? [emailTrigger()];

  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, OWNER_ID);

  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.startsWith('/api/auth/')) return respond(200, USER);
    if (path === '/api/config/agent-email') {
      return respond(200, {
        enabled: agentEmailEnabled,
        domain: agentEmailEnabled ? 'mail.a-really-long-self-hosted-staging-domain.example' : null,
      });
    }
    if (path === '/api/projects') return respond(200, { projects: [PROJECT] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/credentials/'))
      return respond(200, { consumers: [], credentials: [] });
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });

    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return respond(200, {});
    const sub = match[2] ?? '';
    if (sub === '') return respond(200, PROJECT);
    if (sub === '/members')
      return respond(200, { members: [], inviteLinks: [], accessRequests: [] });
    if (sub.startsWith('/agent-profiles')) return respond(200, { items: PROFILES });
    if (sub.startsWith('/skills')) return respond(200, { items: [] });
    if (sub.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
    if (sub === '/credential-attribution-health')
      return respond(200, {
        projectId: PROJECT_ID,
        multiplayerActive: false,
        counts: {
          resources: 0,
          personalResources: 0,
          personalCredentials: 0,
          projectCoveredCredentials: 0,
          unknownCredentials: 0,
        },
        resources: [],
      });
    if (sub === '/triggers') return respond(200, { triggers });
    const runs = sub.match(/^\/triggers\/([^/]+)\/executions/);
    if (runs) return respond(200, { executions: [], nextCursor: null });
    const single = sub.match(/^\/triggers\/([^/]+)$/);
    if (single) {
      const found = triggers.find((item) => item.id === single[1]);
      return found
        ? respond(200, found)
        : respond(404, { error: 'NOT_FOUND', message: 'Trigger not found' });
    }
    if (sub === '/schedules') return respond(200, { schedules: [], nextCursor: null });
    if (sub === '/standing-watches') return respond(200, { watches: [], nextCursor: null });
    if (sub === '/subscriptions') return respond(200, { subscriptions: [], hasMore: false });
    return respond(200, {});
  });
}

async function audit(page: Page, name: string) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  // Grouped under its own subdirectory per the agent-email task's evidence convention.
  await screenshot(page, `agent-email/${name}`);
}

test.describe('Agent email — create flow', () => {
  test('the Email start is offered and defaults the prompt + allowed senders', async ({ page }) => {
    await setupAgentEmailMocks(page);
    await page.goto(`${BASE}/new`);
    const card = await page.getByRole('radio', { name: /By email/ });
    await expect(card).toBeVisible();
    await expect(card).not.toBeDisabled();
    await card.click();
    await audit(page, 'agent-email-create-start-enabled');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Allowed senders')).toHaveValue(`${OWNER_ID}@example.com`);
    await audit(page, 'agent-email-create-when-prefilled');
    // Empty state: clear the field entirely.
    await page.getByLabel('Allowed senders').fill('');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Add at least one allowed sender.')).toBeVisible();
    await audit(page, 'agent-email-create-when-empty-error');
  });

  test('the Email start is hidden on a deployment that has not configured it', async ({ page }) => {
    await setupAgentEmailMocks(page, { agentEmailEnabled: false });
    await page.goto(`${BASE}/new`);
    // Liveness beside the absence check (rule 62): the other start cards did render.
    await expect(page.getByRole('radio', { name: /On a schedule/ })).toBeEnabled();
    await expect(page.getByRole('radio', { name: /When another service calls SAM/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /By email/ })).toHaveCount(0);
    await audit(page, 'agent-email-create-start-hidden');
  });
});

test.describe('Agent email — trigger detail', () => {
  test('shows the long address with a copy button, 18 allowed senders, and no Run now', async ({
    page,
  }) => {
    await setupAgentEmailMocks(page);
    await page.goto(`${BASE}/trigger/trg-email-stress`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(LONG_NAME.slice(0, 40));
    const address = page.getByTestId('email-trigger-address');
    await expect(address).toContainText('agent+k3j2h7m9q2xw4n8p@mail.');
    await expect(page.getByRole('button', { name: 'Copy email address' })).toBeVisible();
    const senders = page.getByTestId('email-allowed-senders');
    await expect(senders.locator('li')).toHaveCount(18);
    await expect(
      page.getByText(/Email triggers run when an email arrives at their address/)
    ).toBeVisible();
    await expect(
      page.getByTestId('automation-actions').getByRole('button', { name: /Run now/ })
    ).toHaveCount(0);
    // Liveness: the primary action bar still renders Pause + Edit (rule 62 absence+liveness pair).
    await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Edit/ })).toBeVisible();
    // Top of page first: the long name wraps and no Run now sits in the action bar.
    await audit(page, 'agent-email-detail-stress-top');
    // The address + 18 senders live in the side panel, below the fold on mobile (same trap as
    // `auditAdminPanel`) — scroll to it for the evidence this test exists to capture.
    await address.scrollIntoViewIfNeeded();
    await audit(page, 'agent-email-detail-stress-address');
  });

  test('falls back to "No senders allowed yet" when the list is empty', async ({ page }) => {
    await setupAgentEmailMocks(page, {
      triggers: [
        emailTrigger({
          id: 'trg-email-empty',
          name: 'Empty inbox automation',
          emailConfig: {
            address: 'agent+a1b2c3d4e5f6g7h8@mail.example.com',
            allowedSenders: [],
          },
        }),
      ],
    });
    await page.goto(`${BASE}/trigger/trg-email-empty`);
    const address = page.getByTestId('email-trigger-address');
    await expect(address).toContainText('agent+a1b2c3d4e5f6g7h8');
    await expect(page.getByText('No senders allowed yet.')).toBeVisible();
    await address.scrollIntoViewIfNeeded();
    await audit(page, 'agent-email-detail-empty-senders');
  });
});

// ---------------------------------------------------------------------------
// Admin "Agent email" panel on /admin/integrations
// ---------------------------------------------------------------------------

const ADMIN_USER = makeMockUser({
  email: 'operator@example.com',
  name: 'Operator',
  role: 'superadmin',
  sessionId: 'session-agent-email-admin',
  userId: 'admin-agent-email',
});

/**
 * `PlatformIntegrationConfigForm` (rendered above the Agent email panel on the same page) reads
 * nested `integrations.*.fields.*` unconditionally — an empty `{}` status throws during render
 * and would silently prevent every sibling section, including Agent email, from ever mounting.
 * Mirrors the known-working shape in `platform-config-audit.spec.ts`.
 */
const PLATFORM_STATUS = {
  setupCompleted: true,
  setupForced: false,
  integrations: {
    githubOAuth: {
      configured: true,
      source: 'environment',
      label: 'set via environment fallback',
      fields: {
        clientId: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
        clientSecret: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
      },
    },
    githubApp: {
      configured: true,
      source: 'environment',
      label: 'set via environment fallback',
      fields: {
        appId: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
        appPrivateKey: {
          configured: true,
          source: 'environment',
          updatedAt: null,
          updatedBy: null,
        },
        appSlug: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
      },
    },
    githubWebhook: {
      configured: false,
      source: 'unset',
      label: 'not configured',
      fields: {
        webhookSecret: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      },
    },
    googleOAuth: {
      configured: false,
      source: 'unset',
      label: 'not configured',
      fields: {
        clientId: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
        clientSecret: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      },
    },
    googleInfrastructureOAuth: {
      configured: false,
      source: 'unset',
      label: 'not configured',
      fields: {
        clientId: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
        clientSecret: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      },
    },
    gitlabOAuth: {
      configured: false,
      source: 'unset',
      label: 'not configured',
      fields: {
        host: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
        clientId: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
        clientSecret: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      },
    },
  },
  feedbackProject: {
    configured: false,
    source: 'unset',
    label: 'not configured',
    state: 'unset',
    projectId: null,
    project: null,
    message: 'Not configured.',
    fields: { projectId: { configured: false, source: 'unset', updatedAt: null, updatedBy: null } },
  },
};

interface AdminMockOptions {
  enabled?: boolean;
  domain?: string | null;
  lastSent?: { to: string; sentAt: string; providerMessageId: string } | null;
  lastReceived?: {
    from: string;
    subject: string;
    autoSubmitted: string | null;
    receivedAt: string;
  } | null;
}

async function setupAdminAgentEmailMocks(page: Page, options: AdminMockOptions = {}) {
  const enabled = options.enabled ?? true;
  const domain = options.domain ?? (enabled ? 'mail.example.com' : null);
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-admin-agent-email', 'true')
  );
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);
    if (path === '/api/auth/get-session') return respond(200, ADMIN_USER);
    if (path === '/api/admin/platform-config') return respond(200, { status: PLATFORM_STATUS });
    // The Connector panel (the Agent email panel's sibling on this tab) reads `.connections`
    // unconditionally; an empty `{}` fallback crashes it (and everything after it) with
    // "Cannot read properties of undefined (reading 'revokedAt')".
    if (path === '/api/admin/connector/connections')
      return respond(200, { connections: [], nextCursor: null });
    if (path === '/api/admin/connector/settings') return respond(200, { settings: {} });
    if (path === '/api/admin/connector/clients')
      return respond(200, { clients: [], nextCursor: null });
    if (path === '/api/admin/agent-email') {
      return respond(200, {
        enabled,
        domain,
        loopback: {
          lastSent: options.lastSent ?? null,
          lastReceived: options.lastReceived ?? null,
        },
      });
    }
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/credentials' || path === '/api/github/installations')
      return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    return respond(200, {});
  });
}

/**
 * `/admin/integrations` is long, and `<main>` scrolls internally (the fixed sidebar/topbar
 * shell), so a bare `fullPage` screenshot only captures the first viewport-height of content —
 * the Agent email panel sits well below the fold. Scroll it into view first, the same technique
 * `platform-config-audit.spec.ts` already uses for its own below-the-fold section. Without this,
 * every admin screenshot here was byte-identical: the OAuth cards at the top of the page, with
 * the panel under test never actually captured (rule 56 / rule 62).
 */
async function auditAdminPanel(page: Page, name: string, focus?: string) {
  await page.getByRole('heading', { name: 'Agent email' }).scrollIntoViewIfNeeded();
  // On mobile the evidence sits below the form, past the first screen of the panel.
  if (focus) await page.getByTestId(focus).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await audit(page, name);
}

test.describe('Agent email — admin panel', () => {
  test('shows "Off" and hides the loopback form when this deployment has not configured it', async ({
    page,
  }) => {
    await setupAdminAgentEmailMocks(page, { enabled: false, domain: null });
    await page.goto('/admin/integrations');
    const status = page.getByTestId('agent-email-status');
    await expect(status).toContainText('Off — not configured on this deployment');
    await expect(page.getByLabel('Send loopback test to')).toHaveCount(0);
    // Liveness: the rest of the Integrations tab still rendered around it.
    await expect(page.getByRole('heading', { name: 'Connector' })).toBeVisible();
    await auditAdminPanel(page, 'agent-email-admin-off');
  });

  test('shows the domain and the loopback form with nothing sent yet', async ({ page }) => {
    await setupAdminAgentEmailMocks(page, {
      enabled: true,
      domain: 'mail.a-really-long-self-hosted-staging-domain.example',
    });
    await page.goto('/admin/integrations');
    const status = page.getByTestId('agent-email-status');
    await expect(status).toContainText('On');
    await expect(status).toContainText('mail.a-really-long-self-hosted-staging-domain.example');
    await expect(page.getByLabel('Send loopback test to')).toBeVisible();
    await expect(page.getByTestId('agent-email-last-sent')).toContainText('Not sent yet');
    await expect(page.getByTestId('agent-email-last-received')).toContainText('None received yet');
    await auditAdminPanel(page, 'agent-email-admin-on-empty');
  });

  test('shows the last sent and last received loopback evidence, including Auto-Submitted', async ({
    page,
  }) => {
    await setupAdminAgentEmailMocks(page, {
      enabled: true,
      domain: 'mail.example.com',
      lastSent: {
        to: 'agent+k3j2h7m9q2xw4n8p@mail.example.com',
        sentAt: '2026-10-22T09:00:00Z',
        providerMessageId: 'msg-abc123',
      },
      lastReceived: {
        from: 'agent+k3j2h7m9q2xw4n8p@mail.example.com',
        subject: 'Re: SAM agent email loopback test',
        autoSubmitted: 'auto-replied',
        receivedAt: '2026-10-22T09:00:42Z',
      },
    });
    await page.goto('/admin/integrations');
    await expect(page.getByTestId('agent-email-last-sent')).toContainText(
      'agent+k3j2h7m9q2xw4n8p@mail.example.com'
    );
    await expect(page.getByTestId('agent-email-last-received')).toContainText(
      'Re: SAM agent email loopback test'
    );
    await expect(page.getByTestId('agent-email-last-received')).toContainText('Auto-Submitted');
    await auditAdminPanel(page, 'agent-email-admin-on-with-data', 'agent-email-last-received');
  });
});
