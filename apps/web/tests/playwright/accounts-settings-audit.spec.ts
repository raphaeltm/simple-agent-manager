/**
 * Visual audit for the unified accounts surfaces:
 *   - Settings → Agents (agent accounts by provider / by project, per-agent defaults)
 *   - Settings → Infrastructure (cloud accounts)
 *   - Project settings → Accounts (default vs pinned, blocked, compute)
 *   - The connect sheet (provider grid and a provider's connect step)
 *
 * Data comes from the real cc_* row shapes the API returns, built with the same
 * fixtures the unit tests use, so role, pin and coverage rendering are driven by
 * `buildAccountsModel` rather than by hand-written view models.
 */
import { expect, type Page, test } from '@playwright/test';

import { type AccountRows, accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import { NORMAL_CATALOG_RESPONSE } from './agent-models-fixtures';
import {
  assertNoOverflow,
  type AuditResponder,
  makeMockProject,
  makeMockUser,
  respondToAppShellRoute,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël',
  sessionId: 'session-accounts',
  userId: 'user-accounts',
});

const LONG =
  'Acme-Corporation-Client-Engagement-Anthropic-Max-Plan-Seat-For-The-Platform-Team-'.repeat(3);

const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-api', name: 'Billing API' },
  { id: 'p-client', name: 'Acme client portal' },
  { id: 'p-labs', name: 'Labs' },
];

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', description: 'Anthropic', configured: true },
  { id: 'openai-codex', name: 'Codex', description: 'OpenAI', configured: true },
  { id: 'opencode', name: 'OpenCode', description: 'OpenCode', configured: true },
  { id: 'google-gemini', name: 'Gemini CLI', description: 'Google', configured: false },
];

const NORMAL_ROWS = mergeRows(
  accountRows({
    id: 'work',
    name: 'Work Max plan',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  }),
  accountRows({
    id: 'acme',
    name: 'Acme API key',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-client'],
    createdAt: '2026-09-02T00:00:00.000Z',
  }),
  accountRows({
    id: 'old',
    name: 'Old personal key',
    kind: 'agent',
    target: 'claude-code',
    createdAt: '2026-06-03T00:00:00.000Z',
  }),
  accountRows({
    id: 'chatgpt',
    name: 'ChatGPT Plus',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'auth-json',
    isDefault: true,
  }),
  accountRows({
    id: 'zen',
    name: 'OpenCode Go',
    kind: 'agent',
    target: 'opencode',
    isDefault: true,
  }),
  accountRows({
    id: 'hz',
    name: 'Hetzner — Personal',
    kind: 'compute',
    target: 'hetzner',
    isDefault: true,
  }),
  accountRows({
    id: 'scw',
    name: 'Scaleway — Acme',
    kind: 'compute',
    target: 'scaleway',
    pins: ['p-client'],
  })
);

const LONG_ROWS = mergeRows(
  accountRows({
    id: 'long-default',
    name: LONG,
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'long-pinned',
    name: `${LONG} <script>alert("x")</script> 🚀`,
    kind: 'agent',
    target: 'claude-code',
    pins: PROJECTS.map((project) => project.id).slice(1),
  }),
  accountRows({ id: 'x', name: 'x', kind: 'agent', target: 'opencode', isDefault: true })
);

const MANY_PROJECTS = Array.from({ length: 32 }, (_, index) => ({
  id: `p-${index}`,
  name: index % 7 === 0 ? `Project ${index} — ${LONG.slice(0, 90)}` : `Project ${index}`,
}));

const MANY_ROWS = mergeRows(
  accountRows({
    id: 'many-default',
    name: 'Team default',
    kind: 'agent',
    target: 'claude-code',
    isDefault: true,
  }),
  ...Array.from({ length: 12 }, (_, index) =>
    accountRows({
      id: `many-${index}`,
      name: `Client ${index} key`,
      kind: 'agent',
      target: 'claude-code',
      pins: index < 6 ? [`p-${index * 2}`, `p-${index * 2 + 1}`] : [],
      createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    })
  ),
  accountRows({
    id: 'paused',
    name: 'Paused contractor key',
    kind: 'agent',
    target: 'claude-code',
    pins: [{ id: 'p-30', active: false }],
  })
);

interface Scenario {
  rows: AccountRows;
  projects?: Array<{ id: string; name: string }>;
  agents?: typeof AGENTS;
  failAccounts?: boolean;
}

function agentSettings(agentType: string) {
  return {
    agentType,
    model: null,
    permissionMode: 'bypassPermissions',
    allowedTools: null,
    deniedTools: null,
    additionalEnv: null,
    opencodeProvider: agentType === 'opencode' ? 'opencode-go' : null,
    opencodeBaseUrl: null,
    providerMode: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function emptyPool(scope: 'project' | 'user') {
  return {
    effective: null,
    effectiveScope: null,
    defaults: (['project', 'user', 'installation'] as const).map((each) => ({
      scope: each,
      visibility: each === 'installation' ? 'hidden' : 'visible',
      visibilityReason: each === 'installation' ? 'superadmin-required' : 'authenticated-user',
      canReconcile: each !== 'installation',
      summary: null,
    })),
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: [scope, 'user'],
    policyMutationSupported: true,
  };
}

function accountsHandler(scenario: Scenario) {
  const projects = scenario.projects ?? PROJECTS;
  return (path: string, respond: AuditResponder): Promise<void> | undefined => {
    if (path === '/api/cc/credentials') {
      return scenario.failAccounts
        ? respond(500, { error: 'INTERNAL_ERROR', message: 'Accounts are unavailable right now' })
        : respond(200, { credentials: scenario.rows.credentials });
    }
    if (path === '/api/cc/configurations') {
      return respond(200, { configurations: scenario.rows.configurations });
    }
    if (path === '/api/cc/attachments') {
      return respond(200, { attachments: scenario.rows.attachments });
    }
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits') return respond(200, { credentials: [] });
    if (path === '/api/agents') return respond(200, { agents: scenario.agents ?? AGENTS });
    if (path.startsWith('/api/agent-settings/')) {
      return respond(200, agentSettings(path.split('/').pop() ?? ''));
    }
    if (path.startsWith('/api/model-catalog/')) {
      return respond(200, { agentType: 'x', source: 'static', updatedAt: null, groups: [] });
    }
    if (path.startsWith('/api/capacity-pools/defaults')) return respond(200, emptyPool('user'));
    if (path.match(/^\/api\/projects\/[^/]+\/capacity-pools\/defaults/)) {
      return respond(200, emptyPool('project'));
    }
    // Project settings → Agents also renders the profile list and the model-usage panel.
    if (path === '/api/agent-models/catalog') return respond(200, NORMAL_CATALOG_RESPONSE);
    if (/^\/api\/projects\/[^/]+\/agent-models$/.test(path)) {
      return respond(200, {
        featureEnabled: false,
        models: null,
        effectiveModelIds: NORMAL_CATALOG_RESPONSE.defaultModelIds,
        effectiveSource: 'default',
        monthlyBudgetUsd: null,
        effectiveMonthlyBudgetUsd: 20,
        defaultMonthlyBudgetUsd: 20,
        maxMonthlyBudgetUsd: 200,
        usage: {
          month: '2026-10',
          spentUsd: 0,
          reservedUsd: 0,
          callCount: 0,
          resetsAt: '2026-11-01T00:00:00.000Z',
          byModel: [],
        },
        canEdit: true,
      });
    }
    if (/^\/api\/projects\/[^/]+\/(agent-profiles|skills)$/.test(path)) {
      return respond(200, { items: [] });
    }
    if (/^\/api\/projects\/[^/]+\/agent-profiles\/picker$/.test(path)) {
      return respond(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
    }
    if (path === '/api/projects') return respond(200, { projects });
    const project = path.match(/^\/api\/projects\/([^/]+)$/);
    if (project) {
      const found = projects.find((candidate) => candidate.id === project[1]);
      return respond(200, makeMockProject({ ...found, userId: USER.user.id }));
    }
    return respondToAppShellRoute(path, respond, { user: USER, projects });
  };
}

async function openPage(page: Page, path: string, scenario: Scenario) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, accountsHandler(scenario));
  await page.goto(path);
}

/**
 * Pages scroll inside the app shell (`<main>`, or the project page's own
 * wrapper), so a full-page capture stops at the first screen. Grow the viewport
 * by the deepest scroll container's hidden height for the capture, then restore
 * it; the file name records the height that was captured.
 */
async function fullShot(page: Page, name: string) {
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => {
    let hidden = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        hidden = Math.max(hidden, element.scrollHeight - element.clientHeight);
      }
    }
    return window.innerHeight + hidden;
  });
  await page.setViewportSize({ width: size.width, height: Math.min(height + 120, 6000) });
  await screenshot(page, name);
  await page.setViewportSize(size);
}

function surfaceTests(viewport: 'mobile' | 'desktop') {
  const shot = (page: Page, name: string) => fullShot(page, `accounts-${name}-${viewport}`);

  test('agent accounts: default, pinned and unattached with coverage', async ({ page }) => {
    await openPage(page, '/settings/agents', { rows: NORMAL_ROWS });
    const claude = page.getByTestId('provider-row-claude-code');
    // The bar is decorative; the legend beside it states the counts as text.
    await expect(claude.getByTestId('coverage-bar')).toBeVisible();
    await expect(claude.getByRole('button', { expanded: true })).toContainText(
      /Work Max plan\s*3.*Acme API key\s*1.*1 unattached/
    );
    await expect(claude.getByTestId('account-card-cfg-work')).toContainText('Used by 3 of 4');
    await expect(claude.getByTestId('account-card-cfg-acme')).toContainText('Acme client portal');
    await expect(claude.getByTestId('account-card-cfg-old')).toContainText(
      'Connected, but nothing uses it.'
    );
    await expect(page.getByTestId('agent-settings-claude-code')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'agents-normal');

    await page.getByRole('radio', { name: 'By project' }).click();
    // A table from md up, one card per project on phones: assert the visible one.
    await expect(
      page.getByText('Acme client portal').locator('visible=true').first()
    ).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'agents-by-project');
  });

  test('long names, markup and emoji wrap inside their cards', async ({ page }) => {
    await openPage(page, '/settings/agents', { rows: LONG_ROWS });
    const pinned = page.getByTestId('account-card-cfg-long-pinned');
    await expect(pinned).toContainText('<script>alert("x")</script> 🚀');
    await assertNoOverflow(page);
    const card = await pinned.boundingBox();
    const viewportWidth = page.viewportSize()!.width;
    expect(card!.x + card!.width).toBeLessThanOrEqual(viewportWidth);
    await shot(page, 'agents-long-text');
  });

  test('no accounts yet shows connect chips and an empty defaults state', async ({ page }) => {
    await openPage(page, '/settings/agents', {
      rows: mergeRows(),
      agents: AGENTS.map((agent) => ({ ...agent, configured: false })),
    });
    await expect(page.getByText('Connect your first account:')).toBeVisible();
    await expect(
      page.getByText('Connect an agent account and its settings appear here.')
    ).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'agents-empty');
  });

  test('many accounts and projects, with a blocked project', async ({ page }) => {
    await openPage(page, '/settings/agents', { rows: MANY_ROWS, projects: MANY_PROJECTS });
    const claude = page.getByTestId('provider-row-claude-code');
    await expect(claude).toContainText('1 project can’t use Claude Code');
    await expect(claude.getByTestId('account-card-cfg-paused')).toContainText(
      'Paused for 1 project'
    );
    await expect(claude.getByTestId('account-card-cfg-many-11')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'agents-many');
  });

  test('a failed load offers Retry instead of an empty list', async ({ page }) => {
    await openPage(page, '/settings/agents', { rows: NORMAL_ROWS, failAccounts: true });
    await expect(page.getByText('Accounts are unavailable right now')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'agents-error');
  });

  test('connect sheet: provider grid, then the Claude connect step', async ({ page }) => {
    await openPage(page, '/settings/agents', { rows: NORMAL_ROWS });
    await page.getByRole('button', { name: 'Connect account' }).click();
    const sheet = page.getByRole('dialog', { name: 'Connect an agent account' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('3 connected')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'connect-providers');

    await sheet.getByRole('button', { name: /Claude Code/ }).click();
    const step = page.getByRole('dialog', { name: 'Connect Claude Code' });
    await expect(step.getByRole('radio', { name: /Claude subscription/ })).toBeChecked();
    await expect(step).toContainText('Work Max plan stays connected and moves to Unattached');
    const box = await step.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await assertNoOverflow(page);
    await shot(page, 'connect-claude');

    await step.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('');
  });

  for (const scope of ['user', 'project'] as const) {
    test(`guided login keeps the same controls for ${scope} accounts`, async ({ page }) => {
      await openPage(
        page,
        scope === 'project' ? '/projects/p-client/settings/accounts' : '/settings/agents',
        { rows: NORMAL_ROWS }
      );
      let submitted: unknown;
      await page.route('**/api/agent-credential-setup-sessions/**', async (route) => {
        await route.fulfill({
          json: {
            enabled: true,
            agentType: 'openai-codex',
            agentTypes: ['openai-codex', 'claude-code'],
            scopes: ['user', 'project'],
          },
        });
      });
      await page.route(
        scope === 'project'
          ? '**/api/agent-credential-setup-sessions/project'
          : '**/api/agent-credential-setup-sessions',
        async (route) => {
          submitted = route.request().postDataJSON();
          await route.fulfill({
            status: 201,
            json: {
              id: 'guided-project',
              agentType: 'claude-code',
              status: 'waiting_for_user',
              expiresAt: '2099-01-01T00:00:00Z',
              verificationUrl: 'https://claude.ai/oauth/authorize?mock=true',
            },
          });
        }
      );
      if (scope === 'project') {
        await page
          .getByTestId('project-account-row-claude-code')
          .getByRole('button', { name: /Use a different account here/ })
          .click();
      } else {
        await page.getByRole('button', { name: 'Connect account' }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: /Claude Code/ })
          .click();
      }
      await expect(page.getByRole('button', { name: 'Connect with Claude Code' })).toBeVisible();
      await expect(page.getByText('Or paste a setup token manually')).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `accounts-guided-${scope}-form-${viewport}`);
      await page.getByRole('button', { name: 'Connect with Claude Code' }).click();
      const modal = page.getByRole('dialog', { name: 'Connect with Claude Code' });
      await expect(modal.getByRole('link', { name: 'Open Claude sign-in' })).toBeVisible();
      expect(submitted).toEqual({
        agentType: 'claude-code',
        ...(scope === 'project' ? { projectId: 'p-client' } : {}),
      });
      await expect(modal).toContainText(
        scope === 'project'
          ? 'Your personal default stays unchanged'
          : 'saved as your personal default'
      );
      await assertNoOverflow(page);
      await screenshot(page, `accounts-guided-${scope}-modal-${viewport}`);
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: 320, height: 667 });
      await assertNoOverflow(page);
      await page.setViewportSize(size);
    });
  }

  test('cloud accounts on Infrastructure', async ({ page }) => {
    await openPage(page, '/settings/infrastructure', { rows: NORMAL_ROWS });
    await expect(page.getByTestId('provider-row-hetzner')).toBeVisible();
    // Pins are per provider: the Scaleway pin leaves every project on the Hetzner default.
    await expect(page.getByTestId('account-card-cfg-hz')).toContainText('Used by 4 of 4');
    // Single-account providers start collapsed after the first one.
    await page
      .getByTestId('provider-row-scaleway')
      .getByRole('button', { expanded: false })
      .click();
    await expect(page.getByTestId('account-card-cfg-scw')).toContainText('Acme client portal');
    await assertNoOverflow(page);
    await shot(page, 'infrastructure');
  });

  test('project accounts: pinned, default, blocked and compute', async ({ page }) => {
    const rows = mergeRows(
      NORMAL_ROWS,
      accountRows({
        id: 'oc-paused',
        name: 'Client OpenCode key',
        kind: 'agent',
        target: 'opencode',
        pins: [{ id: 'p-client', active: false }],
      })
    );
    await openPage(page, '/projects/p-client/settings/accounts', { rows });
    const claude = page.getByTestId('project-account-row-claude-code');
    await expect(claude).toContainText('Pinned for this project');
    await expect(claude.getByTestId('account-card-cfg-acme')).toBeVisible();
    await expect(page.getByTestId('project-account-row-openai-codex')).toContainText(
      'Your default'
    );
    await expect(page.getByTestId('project-account-row-opencode')).toContainText(
      'Can’t run — its pinned account is paused'
    );
    await expect(page.getByTestId('project-account-row-scaleway')).toContainText('Scaleway — Acme');
    await assertNoOverflow(page);
    await shot(page, 'project');

    await claude.getByRole('button', { name: /Use a different account here/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Connect Claude Code' });
    await expect(sheet).toContainText('Only Acme client portal will use this account');
    await expect(sheet.getByRole('button', { name: 'Use for this project' })).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'project-connect');
  });
}

function projectAgentsTest(viewport: 'mobile' | 'desktop') {
  test('project agents tab summarises each agent’s account from the same resolution', async ({
    page,
  }) => {
    await openPage(page, '/projects/p-client/settings/agents', {
      rows: NORMAL_ROWS,
      agents: AGENTS.map((agent) => ({ ...agent, supportsAcp: true })),
    });
    const claude = page.getByTestId('project-agent-card-claude-code');
    await expect(claude).toContainText('This project uses Acme API key, pinned to it.');
    await expect(claude).toContainText('Pinned account');
    await expect(page.getByTestId('project-agent-card-openai-codex')).toContainText(
      'This project uses your default account, ChatGPT Plus.'
    );
    await expect(page.getByTestId('project-agent-card-google-gemini')).toContainText('No account');
    await assertNoOverflow(page);
    await fullShot(page, `accounts-project-agents-${viewport}`);
  });
}

test.describe('Accounts — Mobile', () => {
  projectAgentsTest('mobile');
  surfaceTests('mobile');
});

test.describe('Accounts — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  surfaceTests('desktop');
  projectAgentsTest('desktop');
});
