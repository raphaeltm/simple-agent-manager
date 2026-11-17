/**
 * Visual and layout audit for the Insights page (Insights slice F) at 375×667 and 1280×800.
 * The Flow read is served exactly as the API answers it (`insights-fixtures.ts`). Scenes: a
 * realistic month, a stressed project (long names, every stop reason, 13 weeks, a capped idea
 * sample), an empty project, a failed read and the range switch.
 * Accounts (slice A, `insights-accounts-fixtures.ts`): a realistic month, a stressed project
 * (long and hostile names, eight accounts, 13 weeks, a capped stall scan), an empty project, a
 * failed read, a failed stall section, and a range switch held mid-flight.
 * Agent setups (slice S, `insights-setups-fixtures.ts`): a realistic month with suggestions, a
 * stressed project (long and hostile names, 30 setups, every missing measure), an empty project,
 * a failed read, the grouping switch, and applying a suggestion through PATCH skill.
 */
import { expect, type Page, test } from '@playwright/test';
import { isInsightsRange } from '@simple-agent-manager/shared';

import { docsShot } from './docs-shot';
import { type AccountsScene, makeAccounts } from './insights-accounts-fixtures';
import {
  auditOnPhoneAndDesktop,
  BASE,
  capture,
  PROJECT_ID,
  routeInsightsApi,
} from './insights-audit-support';
import { type FlowScene, makeFlow } from './insights-fixtures';
import { makeSetups, type SetupsScene } from './insights-setups-fixtures';

async function setupScene(
  page: Page,
  scene: FlowScene | 'error',
  requests: string[] = [],
  accountsScene: AccountsScene | 'error' = 'realistic',
  setupsScene: SetupsScene | 'error' = 'realistic',
  skillPatches: Array<{ skillId: string; body: unknown }> = []
) {
  const applied = new Set<string>();
  await routeInsightsApi(page, (url, route, respond) => {
    const range = url.searchParams.get('range');
    if (url.pathname === `/api/projects/${PROJECT_ID}/insights/flow`) {
      requests.push(range ?? '');
      if (scene === 'error')
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
      return respond(200, makeFlow(PROJECT_ID, isInsightsRange(range) ? range : '30d', scene));
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/insights/accounts`) {
      requests.push(`accounts:${range ?? ''}`);
      if (accountsScene === 'error')
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
      return respond(
        200,
        makeAccounts(PROJECT_ID, isInsightsRange(range) ? range : '30d', accountsScene)
      );
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/insights/setups`) {
      const groupBy = url.searchParams.get('groupBy');
      requests.push(`setups:${range ?? ''}:${groupBy ?? ''}`);
      if (setupsScene === 'error')
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
      const body = makeSetups(
        PROJECT_ID,
        isInsightsRange(range) ? range : '30d',
        groupBy === 'skill' || groupBy === 'model' ? groupBy : 'profile',
        setupsScene
      );
      // A skill that was changed no longer has its suggestion, as the real read behaves.
      body.suggestions = body.suggestions.filter((s) => !applied.has(s.apply.skillId));
      return respond(200, body);
    }
    const skillPatch = url.pathname.match(
      new RegExp(`^/api/projects/${PROJECT_ID}/skills/([^/]+)$`)
    );
    if (skillPatch && route.request().method() === 'PATCH') {
      const skillId = skillPatch[1] ?? '';
      skillPatches.push({ skillId, body: route.request().postDataJSON() });
      applied.add(skillId);
      return respond(200, { id: skillId, projectId: PROJECT_ID, name: skillId });
    }
    return undefined;
  });
}

auditOnPhoneAndDesktop();

const isPhoneViewport = (page: Page) => (page.viewportSize()?.width ?? 0) < 640;

test.describe('Insights', () => {
  test('flow with a realistic month', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(BASE);
    await expect(page).toHaveURL(new RegExp(`${BASE}/flow`));
    await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
    await expect(page.getByText('Acme Billing · how work moves from idea to merged')).toBeVisible();
    await expect(page.getByTestId('insights-tile-idea-to-merged')).toContainText('1.6 days');
    await expect(page.getByTestId('insights-tile-ci-first-try')).toContainText('64%');
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('22 min');
    await expect(page.getByTestId('insights-tile-rework')).toContainText('11%');
    await expect(page.getByTestId('insights-runs-chart')).toBeVisible();
    await expect(page.getByTestId('insights-stop-reasons')).toContainText(
      'Pull request waiting to merge'
    );
    await expect(page.getByTestId('insights-flaky-checks')).toContainText(
      'apps/api › snapshot-retry.test.ts'
    );
    await expect(
      page.getByTestId('insights-waiting-ideas').getByRole('link', { name: /Tax ID validation/ })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-c`);
    await expect(page.getByTestId('insights-waiting-ideas')).toContainText('PR open, CI red');
    // Docs image (insights.md): the first screen, before capture() grows the scrollers.
    await docsShot(page, isPhoneViewport(page) ? 'insights-flow-mobile' : 'insights-flow');
    await capture(page, 'insights-flow-realistic');
  });

  test('flow under stress', async ({ page }) => {
    await setupScene(page, 'stress');
    await page.goto(`${BASE}/flow?range=90d`);
    await expect(page.getByTestId('insights-stop-reasons').locator('li')).toHaveCount(13);
    await expect(page.getByText('Showing 5 of 14 flaky checks.')).toBeVisible();
    await expect(page.getByText(/34 more open ideas/)).toBeVisible();
    await expect(page.getByText(/looked at the 100 most recently updated ideas/)).toBeVisible();
    // Untrusted text renders as text, never as markup.
    await expect(
      page.getByText('<script>alert("x")</script> Tax ID validation for UK 🇬🇧')
    ).toBeVisible();
    await capture(page, 'insights-flow-stress');
  });

  test('flow for an empty project', async ({ page }) => {
    await setupScene(page, 'empty');
    await page.goto(`${BASE}/flow`);
    await expect(page.getByTestId('insights-tile-ci-first-try')).toContainText('Not recorded');
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('No asks');
    await expect(page.getByText('No run stopped before finishing.')).toBeVisible();
    await expect(page.getByText(/No flaky checks/)).toBeVisible();
    await expect(page.getByText('No open ideas filed in this range.')).toBeVisible();
    await capture(page, 'insights-flow-empty');
  });

  test('a pull request with no check result yet is not called a running check', async ({
    page,
  }) => {
    // Staging found this shape: a repository without CI reports no checks at all, so the
    // pull request stays undecided and the tile must not claim checks are running.
    await setupScene(page, 'undecided');
    await page.goto(`${BASE}/flow`);
    const tile = page.getByTestId('insights-tile-ci-first-try');
    await expect(tile).toContainText('No result yet');
    await expect(tile).toContainText('1 pull request recorded, checks not reported yet');
    await expect(tile).not.toContainText('running');
    await capture(page, 'insights-flow-undecided');
  });

  test('a failed read says so and offers a retry', async ({ page }) => {
    await setupScene(page, 'error');
    await page.goto(`${BASE}/flow`);
    await expect(page.getByRole('alert')).toContainText('Could not load Insights');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'insights-flow-error');
  });

  test('switching range reads that range and keeps the numbers on screen', async ({ page }) => {
    const requests: string[] = [];
    await setupScene(page, 'realistic', requests);
    await page.goto(`${BASE}/flow`);
    await expect(page.getByTestId('insights-tile-ci-first-try')).toContainText('64%');
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByText('Runs per day by outcome')).toBeVisible();
    expect(requests).toEqual(['30d', '7d']);
    await capture(page, 'insights-flow-7d');
  });

  test('agent setups with a realistic month', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/flow`);
    await page.getByRole('tab', { name: 'Agent setups', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/agent-setups`));
    const section = page.getByTestId('insights-section-setups');
    // The table on a wide screen, cards on a phone: whichever is shown carries the numbers.
    const visible = section.locator(
      '[data-testid="insights-setups-table"]:visible, [data-testid="insights-setups-cards"]:visible'
    );
    await expect(visible).toHaveCount(1);
    await expect(visible).toContainText('Opus 5.5 Chat');
    await expect(visible).toContainText('78%');
    await expect(visible).toContainText('34 merged');
    // A measure that covers only some runs says so in words.
    await expect(visible).toContainText('2.4M· partial');
    await expect(visible).toContainText('3.1M');
    await expect(visible).toContainText('3.4 / 8 GB');
    await expect(visible).toContainText('No profile');
    await expect(visible).toContainText('Not reported');
    await expect(page.getByTestId('insights-setups-compare')).toBeVisible();
    await expect(page.getByTestId('insights-setups-suggestion')).toHaveCount(2);
    await expect(page.getByText('Use Sonnet 5.5 Fast for fix')).toBeVisible();
    await expect(page.getByText('do asks for 8 GB but peaks at 3.4 GB')).toBeVisible();
    await capture(page, 'insights-setups-realistic');
  });

  test('agent setups at a tablet width uses cards, not a squeezed table', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop (1280x800)', 'one extra width is enough');
    await page.setViewportSize({ width: 900, height: 800 });
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/agent-setups`);
    await expect(page.getByTestId('insights-setups-cards')).toBeVisible();
    await expect(page.getByTestId('insights-setups-table')).toBeHidden();
    await capture(page, 'insights-setups-tablet-900');
  });

  test('switching the grouping asks for it and keeps the URL', async ({ page }) => {
    const requests: string[] = [];
    await setupScene(page, 'realistic', requests);
    await page.goto(`${BASE}/agent-setups`);
    await expect(page.getByTestId('insights-section-setups')).toBeVisible();
    await page.getByRole('button', { name: 'Skill', exact: true }).click();
    await expect(page).toHaveURL(/groupBy=skill/);
    await expect(page.getByRole('button', { name: 'Skill', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect
      .poll(() => requests.filter((r) => r.startsWith('setups:')))
      .toEqual(['setups:30d:profile', 'setups:30d:skill']);
  });

  test('applying a suggestion updates the skill through PATCH and the suggestion goes', async ({
    page,
  }) => {
    const patches: Array<{ skillId: string; body: unknown }> = [];
    await setupScene(page, 'realistic', [], 'realistic', 'realistic', patches);
    await page.goto(`${BASE}/agent-setups`);
    const button = page.getByRole('button', { name: 'Make Sonnet 5.5 Fast the default for fix' });
    await expect(button).toBeVisible();
    await button.click();
    await expect
      .poll(() => patches)
      .toEqual([{ skillId: 'sk-fix', body: { defaultProfileId: 'p-sonnet' } }]);
    await expect(page.getByText(/Sonnet 5\.5 Fast is now the default for fix/)).toBeVisible();
    await expect(page.getByTestId('insights-setups-suggestion')).toHaveCount(1);
    // Liveness: the other suggestion is still offered.
    await expect(page.getByRole('button', { name: 'Request 4.5 GB for do' })).toBeVisible();
  });

  test('agent setups under stress', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'realistic', 'stress');
    await page.goto(`${BASE}/agent-setups`);
    await expect(page.getByText(/Showing the newest \d+ runs/)).toBeVisible();
    const section = page.getByTestId('insights-section-setups');
    const visible = section.locator(
      '[data-testid="insights-setups-table"]:visible, [data-testid="insights-setups-cards"]:visible'
    );
    await expect(visible).toContainText('A teammate’s profile');
    await expect(visible).toContainText('Removed profile');
    await expect(visible).toContainText('3 out of memory');
    await expect(visible).toContainText('No merge');
    // Hostile text renders as text.
    await expect(visible).toContainText('<script>alert("x")</script>');
    await capture(page, 'insights-setups-stress');
  });

  test('agent setups for an empty project', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'realistic', 'empty');
    await page.goto(`${BASE}/agent-setups`);
    await expect(page.getByTestId('insights-setups-empty')).toContainText('No runs in this range');
    await expect(page.getByTestId('insights-section-setups-suggestions')).toContainText(
      'at least 10 finished runs'
    );
    // Liveness: the grouping control renders above the empty state.
    await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
    await capture(page, 'insights-setups-empty');
  });

  test('a failed agent setups read says so and offers a retry', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'realistic', 'error');
    await page.goto(`${BASE}/agent-setups`);
    await expect(page.getByRole('button', { name: /retry|try again/i })).toBeVisible();
    await capture(page, 'insights-setups-error');
  });

  test('accounts with a realistic month', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/flow`);
    await page.getByRole('tab', { name: 'Accounts', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/accounts`));
    const own = page.getByTestId('insights-account-cred:cc-max');
    await expect(own).toContainText('Personal Max');
    await expect(own).toContainText('3× · 1.9 h');
    await expect(own).toContainText('Paused now');
    // Your own account shows its current limits through the shared chip.
    await expect(own.getByTestId('credential-limit-chip')).toBeVisible();
    // A teammate's accounts are described, never named.
    await expect(
      page.getByTestId('insights-account-teammate:openai-codex:subscription')
    ).toContainText('Teammates’ accounts (2)');
    const key = page.getByTestId('insights-account-cred:cc-key');
    await expect(key).toContainText('API key · pay as you go');
    // An API key's spend: an estimate, and per merged pull request.
    await expect(key.getByTestId('insights-usage-spend')).toContainText('~$41.27');
    await expect(key.getByTestId('insights-usage-spend')).toContainText('~$3.44 per merged PR');
    await expect(key.getByTestId('insights-usage-spend')).toContainText(
      'Estimated at SAM’s model prices.'
    );
    await expect(key.getByTestId('insights-usage-tokens')).toContainText('21.6M');
    await expect(key.getByTestId('insights-usage-tokens')).toContainText('1.8M per merged PR');
    // A subscription shows tokens, never money.
    await expect(own.getByTestId('insights-usage-tokens')).toContainText('48.2M');
    await expect(own.getByTestId('insights-usage-spend')).toHaveCount(0);
    // A teammate's key: tokens, spend private. A key with no usage: not reported.
    const mates = page.getByTestId('insights-account-teammate:claude-code:api_key');
    await expect(mates.getByTestId('insights-usage-tokens')).toContainText('2.3M');
    await expect(mates.getByTestId('insights-usage-spend')).toContainText('Private');
    const spare = page.getByTestId('insights-account-cred:cc-key2');
    await expect(spare.getByTestId('insights-usage-spend')).toContainText('Not reported');
    await expect(spare.getByTestId('insights-usage-tokens')).toHaveCount(0);
    await expect(page.getByTestId('insights-accounts-chart')).toBeVisible();
    await expect(page.getByTestId('insights-stall-list').locator('li')).toHaveCount(6);
    await expect(page.getByTestId('insights-stall-list')).toContainText(
      'the run ended while it waited'
    );
    await expect(page.getByTestId('insights-stall-list')).toContainText(
      'stopped retrying, needs a person'
    );
    await capture(page, 'insights-accounts-realistic');
  });

  test('accounts under stress', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'stress');
    await page.goto(`${BASE}/accounts?range=90d`);
    await expect(page.locator('[data-testid^="insights-account-"]')).toHaveCount(8);
    // Partial spend names every unpriced model and reads as a floor; capped usage says so too.
    const key = page.getByTestId('insights-account-cred:cc-x');
    await expect(key.getByTestId('insights-usage-spend')).toContainText('At least ~$12,345.68');
    await expect(key.getByTestId('insights-usage-spend')).toContainText(
      'mystery-model-with-an-extremely-long-name-that-has-no-catalog-price-at-all'
    );
    await expect(key.getByTestId('insights-usage-tokens')).toContainText('412M+');
    await expect(
      page
        .getByTestId('insights-account-project:openai-codex:api_key')
        .getByTestId('insights-usage-spend')
    ).toContainText('No estimate');
    await expect(key.getByTestId('insights-usage-tokens')).toContainText(
      'Cut at the usage row limit, so this is a floor.'
    );
    // A long unpriced list is cut after three names.
    await expect(key.getByTestId('insights-usage-spend')).not.toContainText(' more.');
    // Untrusted names render as text, never as markup.
    await expect(page.getByText('<script>alert("x")</script> 🔑 key').first()).toBeVisible();
    // Five accounts get a colour; the other three fold into "Other".
    await expect(page.getByTestId('insights-accounts-chart')).toContainText('Other (3)');
    await expect(
      page.getByText('Showing the 10 most recent of 47. Older limit waits were not examined.')
    ).toBeVisible();
    await capture(page, 'insights-accounts-stress');
  });

  test('accounts for an empty project', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'empty');
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByTestId('insights-accounts-empty')).toContainText(
      'No runs in this range'
    );
    await expect(page.getByText('No agent waited on a usage limit in this range.')).toBeVisible();
    await capture(page, 'insights-accounts-empty');
  });

  test('a failed accounts read says so and offers a retry', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'error');
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByRole('alert')).toContainText('Could not load account insights');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'insights-accounts-error');
  });

  test('accounts with the stall read unavailable says so instead of "none"', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'partial');
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByText('Some numbers could not be loaded: limit stalls.')).toBeVisible();
    await expect(page.getByText('Limit stalls could not be loaded.')).toBeVisible();
    await expect(page.getByText('No agent waited on a usage limit in this range.')).toHaveCount(0);
    // Liveness: the accounts still show, and their pause counts say they were not loaded.
    const own = page.getByTestId('insights-account-cred:cc-max');
    await expect(own).toBeVisible();
    await expect(own).toContainText('Not loaded');
    await expect(own).not.toContainText('Never');
    await capture(page, 'insights-accounts-partial');
  });

  test('accounts with the token read unavailable say "Not loaded", not nothing', async ({
    page,
  }) => {
    await setupScene(page, 'realistic', [], 'tokens-failed');
    await page.goto(`${BASE}/accounts`);
    await expect(
      page.getByText('Some numbers could not be loaded: tokens and spend.')
    ).toBeVisible();
    const key = page.getByTestId('insights-account-cred:cc-key');
    await expect(key.getByTestId('insights-usage-tokens')).toContainText('Not loaded');
    await expect(key.getByTestId('insights-usage-spend')).toContainText('Not loaded');
    // A subscription has no spend row to fail; its runs still show (liveness).
    const own = page.getByTestId('insights-account-cred:cc-max');
    await expect(own.getByTestId('insights-usage-spend')).toHaveCount(0);
    await expect(own).toContainText('64');
    await capture(page, 'insights-accounts-tokens-failed');
  });

  test('switching range on accounts keeps the cards on screen until the new range arrives', async ({
    page,
  }) => {
    const requests: string[] = [];
    await setupScene(page, 'realistic', requests);
    // Hold the 7-day answer so the in-between state is observable.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/insights\/accounts\?range=7d/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByText('Runs per week by account')).toBeVisible();
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7d/);
    // In flight: the 30-day cards and chart stay, nothing blanks.
    await expect(page.getByTestId('insights-account-cred:cc-max')).toBeVisible();
    await expect(page.getByText('Runs per week by account')).toBeVisible();
    await expect(page.getByText('Loading accounts…')).toHaveCount(0);
    release();
    await expect(page.getByText('Runs per day by account')).toBeVisible();
    await expect(page.getByTestId('insights-account-cred:cc-max')).toBeVisible();
    expect(requests.filter((r) => r.startsWith('accounts:'))).toEqual([
      'accounts:30d',
      'accounts:7d',
    ]);
  });

  test('the nav item opens Insights', async ({ page }, testInfo) => {
    await setupScene(page, 'realistic');
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    if (testInfo.project.name.startsWith('iPhone')) {
      // The phone drawer lists the same PROJECT_NAV_ITEMS as the sidebar, as buttons.
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      const drawer = page.getByTestId('mobile-nav-panel');
      await expect(drawer).toBeVisible();
      await drawer.getByRole('button', { name: /^Insights/ }).click();
    } else {
      await page
        .getByRole('link', { name: /^Insights/ })
        .first()
        .click();
    }
    await expect(page).toHaveURL(new RegExp(`${BASE}/flow`));
    await expect(page.getByTestId('insights-flow')).toBeVisible();
  });
});
