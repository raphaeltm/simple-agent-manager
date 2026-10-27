/**
 * Documentation screenshots for Admin → Settings (the Admin Settings guide), on a desktop and
 * a phone.
 *
 * Drives the REAL page with a mocked `GET /api/admin/settings` and asserts on what rendered, so
 * a page that stops rendering fails the capture instead of shipping a stale image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The stress cases (long values,
 * markup, conflicts, failures) live in `admin-settings-audit.spec.ts`; this fixture mirrors the
 * real settings registry (`apps/api/src/services/admin-settings-registry.ts`) with ordinary
 * values, because it is what a reader compares their own page against.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-admin-settings \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import { makeMockUser, seedTheme, setupAuditRoutes } from './audit-helpers';
import { docsShot } from './docs-shot';

const ADMIN_USER = makeMockUser({
  email: 'operator@example.com',
  name: 'Operator',
  role: 'superadmin',
  sessionId: 'session-docs-admin-settings',
  userId: 'user-docs-admin-settings',
});

type Source = 'database' | 'environment' | 'kv' | 'default';

interface SettingFixture {
  name: string;
  type: 'boolean' | 'integer' | 'string' | 'string-list' | 'enum';
  category:
    | 'OAuth'
    | 'Connector'
    | 'Operations'
    | 'Trials'
    | 'Collaboration'
    | 'Chat'
    | 'AI models'
    | 'Email';
  description: string;
  defaultValue: boolean | number | string | string[] | null;
  value: boolean | number | string | string[] | null;
  source?: Source;
  secret?: boolean;
  risky?: boolean;
  range?: { min: number; max: number };
  choices?: string[];
}

function setting(fixture: SettingFixture) {
  const source = fixture.source ?? 'default';
  return {
    secret: false,
    risky: true,
    ...fixture,
    source,
    // As `resolved()` in `apps/api/src/services/admin-settings.ts` reports it: only a value
    // from somewhere other than the code default counts as configured.
    configured: source !== 'default',
    updatedAt: source === 'database' ? '2026-10-17T09:12:00Z' : null,
    updatedBy: source === 'database' ? ADMIN_USER.user.id : null,
  };
}

function oauth(name: string, description: string, value: string | null, source: Source) {
  const secret = name.endsWith('clientSecret');
  return setting({
    name,
    type: 'string',
    category: 'OAuth',
    description,
    defaultValue: null,
    value: secret ? null : value,
    source: value === null ? 'default' : source,
    secret,
  });
}

/**
 * A representative subset of the registry (`admin-settings-registry.ts`), at least one setting
 * from every group, with the values a typical self-host would show. The page renders whatever the
 * API returns, so the captures show the groups and cards a reader meets; the setting count is the
 * fixture's, not the registry's.
 */
const SETTINGS = [
  setting({
    name: 'connector.enabled',
    type: 'boolean',
    category: 'Connector',
    description: 'Allow authenticated external clients to use the SAM Connector.',
    defaultValue: true,
    value: true,
  }),
  setting({
    name: 'connector.writeEnabled',
    type: 'boolean',
    category: 'Connector',
    description: 'Allow external Connector clients to perform write operations.',
    defaultValue: true,
    value: false,
    source: 'database',
  }),
  setting({
    name: 'connector.clientRegistration',
    type: 'enum',
    category: 'Connector',
    description: 'Choose open or allowlisted OAuth client registration.',
    defaultValue: 'open',
    value: 'open',
    choices: ['open', 'allowlist'],
  }),
  setting({
    name: 'connector.allowedRedirectHosts',
    type: 'string-list',
    category: 'Connector',
    description: 'Allowed OAuth redirect hosts; loopback allows local clients.',
    defaultValue: ['claude.ai', 'chatgpt.com', 'loopback'],
    value: ['claude.ai', 'chatgpt.com', 'loopback'],
  }),
  setting({
    name: 'connector.accessTokenTtlSeconds',
    type: 'integer',
    category: 'Connector',
    description: 'Connector access token lifetime in seconds.',
    defaultValue: 3600,
    value: 3600,
    range: { min: 60, max: 2147483647 },
  }),
  setting({
    name: 'connector.refreshTokenTtlSeconds',
    type: 'integer',
    category: 'Connector',
    description: 'Connector refresh token lifetime in seconds.',
    defaultValue: 2592000,
    value: 2592000,
    range: { min: 60, max: 2147483647 },
  }),
  setting({
    name: 'connector.readRateLimitPerMinute',
    type: 'integer',
    category: 'Connector',
    description: 'Maximum Connector reads per minute.',
    defaultValue: 120,
    value: 120,
    range: { min: 1, max: 2147483647 },
  }),
  setting({
    name: 'connector.writeRateLimitPerMinute',
    type: 'integer',
    category: 'Connector',
    description: 'Maximum Connector writes per minute.',
    defaultValue: 30,
    value: 30,
    range: { min: 1, max: 2147483647 },
  }),
  setting({
    name: 'connector.maxStartsPerUserPerHour',
    type: 'integer',
    category: 'Connector',
    description: 'Maximum Connector task starts per user per hour.',
    defaultValue: 10,
    value: 10,
    range: { min: 1, max: 2147483647 },
  }),
  setting({
    name: 'connector.maxStartsPerUserPerDay',
    type: 'integer',
    category: 'Connector',
    description: 'Maximum Connector task starts per user per day.',
    defaultValue: 50,
    value: 50,
    range: { min: 1, max: 2147483647 },
  }),
  oauth(
    'integration.github.clientId',
    'GitHub login OAuth client ID.',
    'Iv23liQ7xK2mPz8RtW4a',
    'environment'
  ),
  oauth(
    'integration.github.clientSecret',
    'GitHub login OAuth client secret.',
    'set',
    'environment'
  ),
  oauth(
    'integration.google.clientId',
    'Google login OAuth client ID; separate from infrastructure access.',
    '412785390613-q2v8e1kfs0b7c4nd9wm3rj6h5tlpx0ga.apps.googleusercontent.com',
    'database'
  ),
  oauth('integration.google.clientSecret', 'Google login OAuth client secret.', 'set', 'database'),
  oauth(
    'integration.googleInfrastructure.clientId',
    'Google infrastructure OAuth client ID; separate from login.',
    null,
    'default'
  ),
  oauth(
    'integration.googleInfrastructure.clientSecret',
    'Google infrastructure OAuth client secret.',
    null,
    'default'
  ),
  oauth('integration.gitlab.clientId', 'GitLab login OAuth client ID.', null, 'default'),
  oauth('integration.gitlab.clientSecret', 'GitLab login OAuth client secret.', null, 'default'),
  oauth(
    'integration.gitlab.host',
    'GitLab OAuth host, without paths or credentials.',
    null,
    'default'
  ),
  setting({
    name: 'operations.cronSweepsEnabled',
    type: 'boolean',
    category: 'Operations',
    description: 'Allow recurring cron recovery and cleanup sweeps.',
    defaultValue: true,
    value: true,
  }),
  setting({
    name: 'operations.doAlarmsEnabled',
    type: 'boolean',
    category: 'Operations',
    description: 'Allow Durable Object alarm work; disabled alarms re-arm for later.',
    defaultValue: true,
    value: true,
  }),
  setting({
    name: 'trials.enabled',
    type: 'boolean',
    category: 'Trials',
    description: 'Allow anonymous trials. Fresh installs remain disabled.',
    defaultValue: false,
    value: false,
    source: 'kv',
  }),
  setting({
    name: 'collaboration.sessionAccessMaxGrants',
    type: 'integer',
    category: 'Collaboration',
    description: 'Maximum people one chat session can be shared with at a time.',
    defaultValue: 10,
    value: 10,
    risky: false,
    range: { min: 1, max: 100 },
  }),
  setting({
    name: 'collaboration.commentMentionsMax',
    type: 'integer',
    category: 'Collaboration',
    description: 'Maximum people one comment can @mention.',
    defaultValue: 10,
    value: 10,
    risky: false,
    range: { min: 1, max: 50 },
  }),
  setting({
    name: 'collaboration.commentNotificationWindowSeconds',
    type: 'integer',
    category: 'Collaboration',
    description:
      'Seconds in which repeated comments on one session send one notification per person. Mentions always notify.',
    defaultValue: 600,
    value: 600,
    risky: false,
    range: { min: 60, max: 86400 },
  }),
  setting({
    name: 'operations.stalledTaskClassifierEnabled',
    type: 'boolean',
    category: 'Operations',
    description: 'Allow stalled-task classification; existing liveness checks remain active.',
    defaultValue: true,
    value: true,
  }),
  setting({
    name: 'workflow.maxParallelSteps',
    type: 'integer',
    category: 'Operations',
    description: 'Steps of one workflow running at once.',
    defaultValue: 2,
    value: 2,
    risky: false,
    range: { min: 1, max: 10 },
  }),
  setting({
    name: 'chat.profileUsageWindowDays',
    type: 'integer',
    category: 'Chat',
    description: "Days of each person's own new chats used to order their new-chat profile picker.",
    defaultValue: 30,
    value: 30,
    risky: false,
    range: { min: 1, max: 365 },
  }),
  setting({
    name: 'aiModels.defaultMonthlyBudgetCents',
    type: 'integer',
    category: 'AI models',
    description:
      'Monthly spending limit per project, in US cents, when the project has not set one.',
    defaultValue: 500,
    value: 500,
    range: { min: 0, max: 10000000 },
  }),
  setting({
    name: 'agentEmail.maxRepliesPerRun',
    type: 'integer',
    category: 'Email',
    description: 'Replies one email-started run can send. Failed attempts count.',
    defaultValue: 5,
    value: 5,
    risky: false,
    range: { min: 1, max: 50 },
  }),
];

const PROJECT = {
  id: '01KDXC7M2Q9V4T8R6N3B5W1Y0Z',
  name: 'acme/checkout-service',
  repository: 'acme/checkout-service',
  defaultBranch: 'main',
  userId: ADMIN_USER.user.id,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-10-17T09:00:00Z',
};

const HISTORY = [
  {
    name: 'connector.writeEnabled',
    action: 'set',
    actorUserId: ADMIN_USER.user.id,
    createdAt: '2026-10-17T09:12:00Z',
    revision: 3,
  },
  {
    name: 'integration.google.clientSecret',
    action: 'set',
    actorUserId: ADMIN_USER.user.id,
    createdAt: '2026-10-17T08:40:00Z',
    revision: 2,
  },
  {
    name: 'integration.google.clientId',
    action: 'set',
    actorUserId: ADMIN_USER.user.id,
    createdAt: '2026-10-17T08:40:00Z',
    revision: 2,
  },
];

async function openSettingsPage(page: Page) {
  await seedTheme(page, 'dark');
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, ADMIN_USER.user.id);
  await setupAuditRoutes(page, (path, respond) => {
    if (path === '/api/auth/get-session') return respond(200, ADMIN_USER);
    if (path === '/api/admin/settings') {
      return respond(200, { revision: 3, settings: SETTINGS, history: HISTORY });
    }
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    // A configured account, so the shell shows what an operator normally sees rather than
    // the onboarding prompt and an empty project list.
    if (path === '/api/projects') {
      return respond(200, { projects: [PROJECT], total: 1, nextCursor: null });
    }
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path === '/api/credentials/agent') {
      return respond(200, { credentials: [{ agentType: 'claude-code', isActive: true }] });
    }
    if (path.startsWith('/api/credentials')) {
      return respond(200, [{ id: 'cred-docs-hetzner', provider: 'hetzner', name: 'Hetzner' }]);
    }
    if (path === '/api/github/installations') {
      return respond(200, [{ id: 'inst-docs', accountName: 'acme', accountType: 'Organization' }]);
    }
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/setup/status') {
      return respond(200, { completed: true, open: false, forced: false, tokenConfigured: true });
    }
    return undefined;
  });

  await page.goto('/admin/settings');
  // Liveness: without this, every capture below would happily screenshot a crash page.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible({
    timeout: 20000,
  });
  // Every registry entry rendered as a card, under the groups the guide names.
  await expect(page.locator('article')).toHaveCount(SETTINGS.length);
  for (const group of ['OAuth', 'Connector', 'Operations', 'Trials', 'Collaboration']) {
    await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
  }
  await expect(page.getByText(`${SETTINGS.length} settings · Revision 3`)).toBeVisible();
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: admin settings page', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettingsPage(page);
  // The first group the guide's Source explanation points at: one value from the
  // environment, one saved in the app, and providers nobody has set up.
  await expect(page.getByText('Source: environment · Configured').first()).toBeVisible();
  await expect(page.getByText('Source: database · Configured').first()).toBeVisible();
  await docsShot(page, 'admin-settings');
});

test('docs: admin settings page on mobile', async ({ page }) => {
  test.skip(!isMobile(page), 'mobile capture');
  await openSettingsPage(page);
  // Show a switch and where its value comes from: the Connector's write switch was saved
  // in the app, so its card offers Reset override.
  const card = page.locator('article').filter({ hasText: 'connector · write Enabled' });
  await card.scrollIntoViewIfNeeded();
  await expect(
    card.getByText('Source: database · Configured · Requires confirmation')
  ).toBeVisible();
  await expect(card.getByRole('button', { name: 'Reset override' })).toBeEnabled();
  // Start the frame at the group heading, so the switch with its default value and the
  // saved switch below it are both in view.
  await page
    .getByRole('heading', { name: 'Connector', exact: true })
    .evaluate((heading) => heading.scrollIntoView({ block: 'start' }));
  await expect(card.getByRole('button', { name: 'Reset override' })).toBeInViewport();
  await docsShot(page, 'admin-settings-mobile');
});
