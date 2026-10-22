import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import {
  CUSTOM_SELECTION_IDS,
  EMPTY_CATALOG_RESPONSE,
  LONG_TEXT_CATALOG_RESPONSE,
  LONG_TEXT_MODEL,
  NORMAL_CATALOG_RESPONSE,
} from './agent-models-fixtures';
import {
  assertNoClippedOverflow,
  assertNoOverflow,
  jsonResponse,
  makeMockUser,
  screenshotSectionNearHeading,
  setupAuditRoutes,
} from './audit-helpers';

/**
 * The Project Settings "Agents" tab heading our new section renders under.
 * Plain `fullPage` screenshots on this page are unreliable: AppShell scrolls
 * inside a nested container rather than the document (`.claude/rules/56`),
 * so a `fullPage: true` capture silently stops at one viewport height and two
 * scenarios that differ only in content below the fold — e.g. "recommended
 * defaults" vs. "custom selection", which differ in the selection-summary
 * line near the bottom of the section — produced byte-identical screenshots.
 * `screenshotSectionNearHeading` scrolls to and crops the section itself,
 * which is immune to that and also keeps the shot focused on what changed.
 */
async function screenshotAgentModelsSection(page: Page, name: string) {
  await screenshotSectionNearHeading(page, 'AI Models', name, { outputDir: SCREENSHOT_DIR });
}

const TIMESTAMP = '2026-10-22T00:00:00.000Z';
const SCREENSHOT_DIR = '../../.tmp/playwright-screenshots/agent-models';

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  const dir = resolve(process.cwd(), SCREENSHOT_DIR);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}${suffix}.png`, fullPage: true });
}

const user = makeMockUser({
  email: 'agent-models@example.com',
  name: 'Agent Models Test User',
  sessionId: 'session-agent-models-1',
  userId: 'user-agent-models-1',
});

const MOCK_PROJECT = {
  id: 'proj-agent-models-1',
  name: 'Agent Models Test Project',
  repository: 'acme/agent-models-project',
  defaultBranch: 'main',
  userId: user.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

interface ProjectAgentModelSettingsOverrides {
  featureEnabled?: boolean;
  models?: string[] | null;
  effectiveModelIds?: string[];
  effectiveSource?: 'project' | 'default';
  monthlyBudgetUsd?: number | null;
  effectiveMonthlyBudgetUsd?: number;
  maxMonthlyBudgetUsd?: number;
  spentUsd?: number;
  reservedUsd?: number;
  canEdit?: boolean;
}

function makeProjectAgentModelSettings(overrides: ProjectAgentModelSettingsOverrides = {}) {
  const effectiveMonthlyBudgetUsd = overrides.effectiveMonthlyBudgetUsd ?? 20;
  return {
    featureEnabled: overrides.featureEnabled ?? true,
    models: overrides.models ?? null,
    effectiveModelIds: overrides.effectiveModelIds ?? NORMAL_CATALOG_RESPONSE.defaultModelIds,
    effectiveSource: overrides.effectiveSource ?? 'default',
    monthlyBudgetUsd: overrides.monthlyBudgetUsd ?? null,
    effectiveMonthlyBudgetUsd,
    maxMonthlyBudgetUsd: overrides.maxMonthlyBudgetUsd ?? 200,
    usage: {
      month: '2026-10',
      spentUsd: overrides.spentUsd ?? 2.47,
      reservedUsd: overrides.reservedUsd ?? 0,
      callCount: 142,
      resetsAt: '2026-11-01T00:00:00.000Z',
      byModel: [
        {
          modelId: NORMAL_CATALOG_RESPONSE.defaultModelIds[0] ?? '@cf/cloudflare/clef',
          callCount: 98,
          errorCount: 1,
          spentUsd: 1.8,
          lastCalledAt: '2026-10-21T18:00:00.000Z',
        },
        {
          modelId: NORMAL_CATALOG_RESPONSE.defaultModelIds[1] ?? '@cf/cloudflare/clairic',
          callCount: 44,
          errorCount: 0,
          spentUsd: 0.67,
          lastCalledAt: '2026-10-21T12:00:00.000Z',
        },
      ],
    },
    canEdit: overrides.canEdit ?? true,
  };
}

interface MockOptions {
  catalog?: typeof NORMAL_CATALOG_RESPONSE;
  catalogStatus?: number;
  settings?: ReturnType<typeof makeProjectAgentModelSettings>;
  profiles?: unknown[];
  skills?: unknown[];
}

async function setupProjectSettingsMocks(page: Page, options: MockOptions = {}) {
  const catalog = options.catalog ?? NORMAL_CATALOG_RESPONSE;
  let settingsState = options.settings ?? makeProjectAgentModelSettings();
  const profiles = options.profiles ?? [];
  const skills = options.skills ?? [];

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, user.user.id);

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, user);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';
      if (subPath === '/credentials') return respond(200, { credentials: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: profiles });
      if (subPath === '/agent-profiles/picker') {
        return respond(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
      }
      if (subPath === '/skills') return respond(200, { items: skills });
      if (subPath === '/members') return respond(200, { members: [] });
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath === '') return respond(200, MOCK_PROJECT);
      return undefined;
    }

    return undefined;
  });

  await page.route('**/api/agent-models/catalog', (route: Route) => {
    if (options.catalogStatus && options.catalogStatus >= 400) {
      return jsonResponse(route, options.catalogStatus, {
        error: 'CATALOG_ERROR',
        message: 'Could not reach Cloudflare',
      });
    }
    return jsonResponse(route, 200, catalog);
  });

  await page.route(`**/api/projects/${MOCK_PROJECT.id}/agent-models`, (route: Route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as {
        models?: string[] | null;
        monthlyBudgetUsd?: number | null;
      };
      if ('models' in body) settingsState = { ...settingsState, models: body.models ?? null };
      if ('monthlyBudgetUsd' in body) {
        settingsState = {
          ...settingsState,
          monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
          effectiveMonthlyBudgetUsd:
            body.monthlyBudgetUsd ?? settingsState.effectiveMonthlyBudgetUsd,
        };
      }
      if (settingsState.models !== null) {
        settingsState = {
          ...settingsState,
          effectiveSource: 'project',
          effectiveModelIds: settingsState.models,
        };
      } else {
        settingsState = {
          ...settingsState,
          effectiveSource: 'default',
          effectiveModelIds: catalog.defaultModelIds,
        };
      }
      return jsonResponse(route, 200, settingsState);
    }
    return jsonResponse(route, 200, settingsState);
  });
}

test.describe('Agent model calls — Project Settings', () => {
  test.setTimeout(60_000);

  test('recommended defaults with normal usage render budget, used-this-month, and selection summary', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page, { settings: makeProjectAgentModelSettings() });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByText('AI Models')).toBeVisible();
    await expect(page.getByText(/\$2\.47 of \$20\.00 used this month/)).toBeVisible();
    await expect(page.getByText(/Recommended models · /)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Used this month' })).toBeVisible();

    await screenshotAgentModelsSection(page, 'project-settings-defaults');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('custom selection with a retired model id — opens the picker and shows "No longer available"', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page, {
      settings: makeProjectAgentModelSettings({
        models: CUSTOM_SELECTION_IDS,
        effectiveModelIds: CUSTOM_SELECTION_IDS,
        effectiveSource: 'project',
      }),
    });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByText(/Your selection · /)).toBeVisible();
    await screenshotAgentModelsSection(page, 'project-settings-custom-selection');

    await page.getByRole('button', { name: 'Choose models' }).click();
    await expect(page.getByText('Choose AI models')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No longer available' })).toBeVisible();
    await expect(page.getByText(CUSTOM_SELECTION_IDS.at(-1)!)).toBeVisible();

    await screenshot(page, 'project-settings-picker-stale-ids');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  test('budget nearly used shows a cautionary bar and percentage without an alert box', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page, {
      settings: makeProjectAgentModelSettings({ effectiveMonthlyBudgetUsd: 20, spentUsd: 18.7 }),
    });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByText(/\(94%\)/)).toBeVisible();
    await expect(page.getByText(/limit is used up/)).toHaveCount(0);

    await screenshotAgentModelsSection(page, 'project-settings-budget-nearly-used');
    await assertNoOverflow(page);
  });

  test('budget fully used shows a needs-attention alert with a Raise-limit fix', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page, {
      settings: makeProjectAgentModelSettings({ effectiveMonthlyBudgetUsd: 20, spentUsd: 20 }),
    });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByText(/limit is used up/)).toBeVisible();
    const raiseLimit = page.getByRole('button', { name: 'Raise limit' });
    await expect(raiseLimit).toBeVisible();
    await raiseLimit.click();
    await expect(page.getByLabel('Monthly limit (USD)')).toBeFocused();

    await screenshotAgentModelsSection(page, 'project-settings-budget-fully-used');
    await assertNoOverflow(page);
  });

  test('read-only hides the edit controls and states the reason', async ({ page }) => {
    await setupProjectSettingsMocks(page, {
      settings: makeProjectAgentModelSettings({ canEdit: false }),
    });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByLabel('Monthly limit (USD)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose models' })).toHaveCount(0);
    await expect(
      page.getByText('Only project owners and admins can change the limit.')
    ).toBeVisible();

    await screenshotAgentModelsSection(page, 'project-settings-read-only');
    await assertNoOverflow(page);
  });

  test('feature disabled shows a calm banner', async ({ page }) => {
    await setupProjectSettingsMocks(page, {
      settings: makeProjectAgentModelSettings({ featureEnabled: false }),
    });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByText('Turned off by your SAM administrator.')).toBeVisible();

    await screenshotAgentModelsSection(page, 'project-settings-feature-disabled');
    await assertNoOverflow(page);
  });

  test('catalog error inside the picker shows Retry, and retry recovers', async ({ page }) => {
    await setupProjectSettingsMocks(page, { catalogStatus: 500 });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);
    await page.getByRole('button', { name: 'Choose models' }).click();

    await expect(page.getByText(/Couldn.t load the model list/)).toBeVisible();
    await screenshot(page, 'picker-catalog-error');

    await page.route('**/api/agent-models/catalog', (route: Route) =>
      jsonResponse(route, 200, NORMAL_CATALOG_RESPONSE)
    );
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(
      page.getByRole('button', { name: /^Decision \d+ of \d+ on(?: Recommended)?$/ })
    ).toBeVisible();

    await assertNoOverflow(page);
  });

  test('empty catalog shows a calm empty state in the picker', async ({ page }) => {
    await setupProjectSettingsMocks(page, {
      catalog: EMPTY_CATALOG_RESPONSE,
      settings: makeProjectAgentModelSettings({ effectiveModelIds: [] }),
    });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);

    await expect(page.getByText('No models')).toBeVisible();
    await page.getByRole('button', { name: 'Choose models' }).click();
    await expect(page.getByText('No models are available right now.')).toBeVisible();

    await screenshot(page, 'picker-empty-catalog');
    await assertNoOverflow(page);
  });
});

test.describe('Agent model calls — Model Picker (realistic catalog)', () => {
  test.setTimeout(60_000);

  test('the full 73-model catalog renders grouped and searchable without overflow', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page);
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);
    await page.getByRole('button', { name: 'Choose models' }).click();
    await expect(page.getByText('Choose AI models')).toBeVisible();
    const textGenHeader = page.getByRole('button', {
      name: /^Text generation \d+ of \d+ on(?: Recommended)?$/,
    });
    await expect(textGenHeader).toBeVisible();

    await screenshot(page, 'picker-realistic-catalog-default');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

    await page.getByPlaceholder('Search models').fill('embed');
    await expect(
      page.getByRole('button', { name: /^Embeddings \d+ of \d+ on(?: Recommended)?$/ })
    ).toBeVisible();
    await expect(textGenHeader).toHaveCount(0);

    await screenshot(page, 'picker-realistic-catalog-search');
    await assertNoOverflow(page);
  });

  test('a 300+ character description and a very long name wrap without horizontal overflow', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page, { catalog: LONG_TEXT_CATALOG_RESPONSE });
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/agents`);
    await page.getByRole('button', { name: 'Choose models' }).click();
    await page.getByPlaceholder('Search models').fill('stress-test-author');
    await expect(page.getByText(LONG_TEXT_MODEL.name)).toBeVisible();

    await screenshot(page, 'picker-long-text-model');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

    // The discriminating assertion for this class of bug: a nested flex row
    // can paint text past its own box without ever growing an ancestor's
    // `scrollWidth` (the mechanism `assertNoClippedOverflow` detects), so the
    // author text's own measured right edge must be checked directly against
    // the viewport. This caught a real bug during development: the author
    // span lacked `min-w-0`/`break-words`, so at 375px its 67-character value
    // rendered as one unbroken line that ran off the edge of the dialog.
    const viewportWidth = (await page.viewportSize())!.width;
    const authorBox = await page.getByText(LONG_TEXT_MODEL.author).boundingBox();
    expect(authorBox).not.toBeNull();
    expect(authorBox!.x + authorBox!.width).toBeLessThanOrEqual(viewportWidth + 1);

    const root = page.getByRole('dialog', { name: 'Choose AI models' });
    const rootBox = await root.boundingBox();
    expect(rootBox).not.toBeNull();
    expect(rootBox!.width).toBeLessThanOrEqual(viewportWidth + 1);
  });
});

test.describe('Agent model calls — Profile and Skill dialogs', () => {
  test.setTimeout(60_000);

  test('profile dialog: AI Models section — inherit summary, then switching to custom', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page);
    await page.goto(`/projects/${MOCK_PROJECT.id}/profiles`);
    await page.getByRole('button', { name: 'New Profile' }).click();
    await expect(page.getByText('Create Agent Profile')).toBeVisible();

    await page.getByRole('button', { name: /AI Models/ }).click();
    const inheritSummary = page.getByText(/Uses the project's models/);
    await expect(inheritSummary).toBeVisible();
    // The dialog body scrolls internally (`Dialog.tsx`'s `overflow-y-auto`),
    // so a screenshot without scrolling first can silently miss content below
    // the fold — exactly the bug this task already found once on the project
    // settings page.
    await inheritSummary.scrollIntoViewIfNeeded();
    await screenshot(page, 'profile-dialog-ai-models-inherit');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

    await page
      .getByRole('combobox', { name: /AI models this profile can call/i })
      .selectOption('custom');
    await expect(page.getByText('Choose AI models')).toBeVisible();

    await screenshot(page, 'profile-dialog-ai-models-custom-picker');
    await assertNoOverflow(page);
  });

  test('skill dialog: AI Models field renders and lets the user open the picker', async ({
    page,
  }) => {
    await setupProjectSettingsMocks(page);
    await page.goto(`/projects/${MOCK_PROJECT.id}/skills`);
    await page.getByRole('button', { name: 'New Skill' }).click();
    await expect(page.getByRole('heading', { name: 'Create Skill' })).toBeVisible();
    await expect(page.getByText(/AI models this skill can call/)).toBeVisible();
    const inheritSummary = page.getByText(/Uses the profile's models/);
    await expect(inheritSummary).toBeVisible();

    await inheritSummary.scrollIntoViewIfNeeded();
    await screenshot(page, 'skill-dialog-ai-models-inherit');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });
});
