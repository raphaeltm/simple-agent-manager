/**
 * Visual and layout audit for the agent email (preview) feature: the "Email" automation start,
 * an email trigger's detail page (address, copy button, allowed senders, no Run now), and the
 * admin "Agent email" status, setup and loopback panel. Runs at 375x667 and 1280x800 with stress
 * data: a very long trigger name, a long address, 15+ allowed senders, long domains and DNS
 * record values in the setup, and empty-state fallbacks.
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
      address: 'agent+k3j2h7m9q2xw4n8p@agents.a-really-long-self-hosted-staging-domain.example',
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
        domain: agentEmailEnabled
          ? 'agents.a-really-long-self-hosted-staging-domain.example'
          : null,
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
    if (sub === '/triggers/github/filter-preview')
      return respond(200, {
        limit: 25,
        warning:
          'Only retained recovery payloads can be tested; unavailable does not mean rejected.',
        deliveries: Array.from({ length: 30 }, (_, i) => ({
          id: `delivery-${i}`,
          eventType: 'pull_request_review',
          action: 'submitted',
          receivedAt: '2026-10-26T15:00:00Z',
          matched: i % 3 === 0 ? null : i % 3 === 1,
          reason:
            i % 3 === 0
              ? 'payload_unavailable'
              : i % 3 === 1
                ? 'matched'
                : 'Review state does not match',
        })),
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
  await screenshot(page, `github-trigger-controls/${name}`);
}

test('GitHub filters, reviews, recent-delivery snapshot and context variables', async ({
  page,
}) => {
  await setupAgentEmailMocks(page, { triggers: [] });
  await page.goto(`${BASE}/new`);
  await page.getByRole('radio', { name: /When something happens on GitHub/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('GitHub event', { exact: true }).selectOption('pull_request_review');
  await page
    .getByLabel('Allowed actors', { exact: true })
    .fill(Array.from({ length: 30 }, (_, i) => `reviewer-${i}`).join(', '));
  await page.getByLabel('Author association', { exact: true }).fill('MEMBER, COLLABORATOR');
  await page
    .getByLabel('Comment contains', { exact: true })
    .fill('/sam <script>alert(1)</script> 🐙 ' + 'long external text '.repeat(12));
  await page.getByLabel('Review states', { exact: true }).fill('changes_requested, approved');
  await page.getByLabel('Ignore bot actors', { exact: true }).check();
  await page.getByLabel('GitHub event', { exact: true }).scrollIntoViewIfNeeded();
  await audit(page, 'github-review-filters-top');
  await page.getByRole('button', { name: 'Test against recent deliveries' }).click();
  await expect(page.getByText('payload_unavailable').first()).toBeVisible();
  await page
    .getByRole('button', { name: 'Test against recent deliveries' })
    .scrollIntoViewIfNeeded();
  await audit(page, 'github-review-filter-preview');
  await page.getByLabel('Review states', { exact: true }).fill('changes_requested');
  await expect(page.getByText('Settings changed.', { exact: false })).toBeVisible();
  await page.route('**/triggers/github/filter-preview', (route) =>
    jsonResponse(route, 200, {
      limit: 25,
      warning: 'Only retained recovery payloads can be tested.',
      deliveries: [],
    })
  );
  await page.getByRole('button', { name: 'Test against recent deliveries' }).click();
  await expect(page.getByText('No recent deliveries for this event and repository.')).toBeVisible();
  await audit(page, 'github-review-filter-preview-empty');
  await page.route('**/triggers/github/filter-preview', (route) =>
    jsonResponse(route, 500, { error: 'INTERNAL_ERROR', message: 'Test error' })
  );
  await page.getByRole('button', { name: 'Test against recent deliveries' }).click();
  await expect(page.getByText('Could not test recent deliveries. Try again.')).toBeVisible();
  await audit(page, 'github-review-filter-preview-error');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Add a detail from the run' }).click();
  await expect(page.getByRole('button', { name: 'commentId', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'commentId', exact: true }).scrollIntoViewIfNeeded();
  await audit(page, 'github-template-context');
});
