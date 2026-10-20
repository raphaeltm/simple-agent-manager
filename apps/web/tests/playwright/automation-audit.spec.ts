/**
 * Visual and layout audit for the project Automation page (replaces the Events and Triggers
 * audits). Runs at 375×667 and 1280×800 with production-shaped mock data: normal, long text,
 * empty, many items, failing lists and a read-only viewer. Every surface is checked for
 * horizontal overflow (including clipped overflow) and for tap targets under 44 px.
 */
import { expect, type Page, test, type TestInfo } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';
import { PROJECT_ID, setupAutomationMocks, VIEWER_ID } from './automation-fixtures';

const BASE = `/projects/${PROJECT_ID}/automation`;

function onlyOn(names: string[]) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(!names.includes(testInfo.project.name), 'audited on iPhone SE and desktop');
  };
}
test.beforeEach(onlyOn(['iPhone SE (375x667)', 'Desktop (1280x800)']));

/** Interactive elements inside the page content that are shorter than 44 px. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root =
      document.querySelector('[data-testid="automation-root"]') ?? document.querySelector('main');
    if (!root) return ['no page root'];
    const found: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>(
      'a[href], button, select, input:not([type="checkbox"]):not([type="hidden"]), summary, [role="radio"]'
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || (style.position === 'absolute' && box.width <= 1))
        continue;
      if (box.height < 43.5)
        found.push(
          `${element.tagName.toLowerCase()} "${(element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 40)}" ${Math.round(box.height)}px`
        );
    }
    return found;
  });
}

/**
 * The app scrolls inside its own containers, so a full-page screenshot only shows the first
 * screen. Let every scrolling ancestor of the page grow to its content before capturing, so the
 * image shows the whole page (and two different pages can never produce the same image).
 */
async function expandScrollContainers(page: Page) {
  await page.evaluate(() => {
    // Every ancestor sizes to its content: no scrolling, no fixed screen height, no flex
    // shrinking (the phone layout fits its columns to the screen with flex-1 + min-h-0).
    let node = document.querySelector<HTMLElement>(
      '[data-testid="automation-root"]'
    )?.parentElement;
    while (node) {
      node.style.overflow = 'visible';
      node.style.height = 'auto';
      node.style.maxHeight = 'none';
      node.style.flex = '0 0 auto';
      node = node.parentElement;
    }
    // A sticky footer would freeze where the screen used to end; show it after the content.
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-testid="automation-root"] *'
    ))
      if (getComputedStyle(element).position === 'sticky') element.style.position = 'static';
  });
}

async function audit(page: Page, name: string) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  // Layout checks run on the real, scrolling layout; only the capture is expanded.
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  expect(await smallTargets(page)).toEqual([]);
  await expandScrollContainers(page);
  await screenshot(page, name);
}

test.describe('Automation overview', () => {
  test('normal: problems first, coming up, grouped list, relays hidden', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(BASE);
    await expect(page.getByRole('heading', { name: 'Automation', level: 1 })).toBeVisible();
    const attention = page.getByTestId('automation-attention');
    await expect(attention.getByText('Paused · its last 3 runs failed')).toBeVisible();
    await expect(attention.getByText('Could not confirm it ran')).toBeVisible();
    await expect(attention.getByText(/Used all 20 of its runs/)).toBeVisible();
    await expect(attention.getByText('Paused by SAM')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Coming up' })).toBeVisible();
    await expect(page.getByText('Morning pull request summary').first()).toBeVisible();
    // A schedule a watch started is one of the watch's runs, not an automation of its own.
    await expect(
      page.getByTestId('automation-row').filter({ hasText: 'A release failed. Read the logs.' })
    ).toHaveCount(0);
    await expect(page.getByText(/Agents are waiting on 2 things/)).toBeVisible();
    await audit(page, 'automation-overview');
  });

  test('filter chips narrow the list and survive a reload', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}?filter=reacting`);
    await expect(page.getByRole('radio', { name: /Reactions/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(
      page.getByTestId('automation-row').filter({ hasText: 'Answer /sam comments' })
    ).toBeVisible();
    await expect(
      page.getByTestId('automation-row').filter({ hasText: 'Morning pull request summary' })
    ).toHaveCount(0);
  });

  test('empty project shows examples', async ({ page }) => {
    await setupAutomationMocks(page, { empty: true });
    await page.goto(BASE);
    await expect(page.getByText('Nothing runs on its own yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Use this' })).toHaveCount(3);
    await audit(page, 'automation-empty');
  });

  test('many items and long names', async ({ page }) => {
    await setupAutomationMocks(page, { many: true, long: true });
    await page.goto(BASE);
    await expect(page.getByTestId('automation-row').first()).toBeVisible();
    expect(await page.getByTestId('automation-row').count()).toBeGreaterThan(30);
    await audit(page, 'automation-many-long');
  });

  test('failing lists say what failed and keep what loaded', async ({ page }) => {
    await setupAutomationMocks(page, { failLists: true });
    await page.goto(BASE);
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await audit(page, 'automation-error');
  });

  test('viewer sees everything read-only', async ({ page }) => {
    await setupAutomationMocks(page, { userId: VIEWER_ID });
    await page.goto(BASE);
    await expect(
      page.getByText(/Only people who can edit this project can change automation/)
    ).toBeVisible();
    await expect(page.getByText('Morning pull request summary').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /New/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await audit(page, 'automation-viewer');
  });
});

test.describe('Automation detail pages', () => {
  test('paused trigger with failed runs', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/trigger/trg-deps`);
    await expect(page.getByRole('region', { name: 'Needs your attention' })).toContainText(
      'Paused · its last 3 runs failed'
    );
    await expect(
      page.getByTestId('automation-actions').getByRole('button', { name: /Resume/ })
    ).toBeVisible();
    await expect(page.getByTestId('trigger-run')).toHaveCount(3);
    await audit(page, 'automation-trigger-paused');
  });

  test('webhook shows its URL, sample check and calls received', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/trigger/trg-alerts`);
    await expect(page.getByTestId('webhook-url')).toContainText('/api/webhooks/ingest');
    await expect(page.getByText('Personal credential attribution')).toBeVisible();
    await expect(page.getByText('Ignored: did not match the filters')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear stuck runs' })).toBeVisible();
    await audit(page, 'automation-webhook');
  });

  test('one-time message that could not be confirmed', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/schedule/sch-ambiguous`);
    await expect(page.getByText('Could not confirm it ran').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check the result again' })).toBeVisible();
    await audit(page, 'automation-schedule-unconfirmed');
  });

  test('pending one-time automation offers run now, change time and cancel', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/schedule/sch-release`);
    const actions = page.getByTestId('automation-actions');
    await expect(actions.getByRole('button', { name: /Run now/ })).toBeVisible();
    await expect(actions.getByRole('button', { name: /Change time/ })).toBeVisible();
    await actions.getByRole('button', { name: /Change time/ }).click();
    await expect(page.getByRole('dialog', { name: 'Change when it runs' })).toBeVisible();
    await audit(page, 'automation-schedule-change-time');
  });

  test('watch at its run limit, created by someone else', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/watch/wat-release-failed`);
    await expect(page.getByText('Used all 20 of its runs')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Give it more runs' })).toBeVisible();
    await expect(page.getByText(/can change what this watch does/)).toBeVisible();
    await expect(
      page
        .getByRole('link', { name: 'A release failed. Read the logs.' })
        .or(page.getByText('Started a chat'))
    ).toBeVisible();
    await audit(page, 'automation-watch-limit');
  });

  test('watch SAM paused offers no one-tap resume as the fix', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/watch/wat-issues`);
    const card = page.getByRole('region', { name: 'Needs your attention' });
    await expect(card).toContainText('Paused by SAM');
    await expect(card.getByRole('button')).toHaveCount(0);
    await audit(page, 'automation-watch-paused');
  });
});

test.describe('Create and edit', () => {
  test('four steps from start to review', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/new`);
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
    await audit(page, 'automation-new-1-start');
    await page.getByRole('radio', { name: /On a schedule/ }).click();
    await page.getByTestId('automation-editor-next').click();
    await expect(page.getByText('Step 2 of 4')).toBeVisible();
    await expect(page.getByText('Next runs, in your time')).toBeVisible();
    await audit(page, 'automation-new-2-when');
    await page.getByTestId('automation-editor-next').click();
    await expect(page.getByText('Step 3 of 4')).toBeVisible();
    await page.getByTestId('automation-editor-next').click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Say what the agent should do.' })
    ).toBeVisible();
    await page
      .getByLabel('What should it do?')
      .fill('Summarize open pull requests and flag anything blocked.');
    await audit(page, 'automation-new-3-what');
    await page.getByTestId('automation-editor-next').click();
    await expect(page.getByTestId('automation-sentence')).toContainText('Weekdays at 9:00 AM');
    await audit(page, 'automation-new-4-review');
  });

  test('remind this chat later opens a one-time message to that chat', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/new?sessionId=chat-release-shepherd`);
    await expect(page.getByText('Step 2 of 4')).toBeVisible();
    await expect(page.getByLabel('Date and time')).toBeVisible();
    await page.getByTestId('automation-editor-next').click();
    await expect(page.getByRole('radio', { name: /Message a chat/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(page.getByLabel('Which chat?')).toHaveValue('chat-release-shepherd');
    await audit(page, 'automation-remind-chat');
  });

  test('editing a watch someone else made locks what it does', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/watch/wat-release-failed/edit`);
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await page.getByTestId('automation-editor-next').click();
    await expect(page.getByText(/can change what this watch does/)).toBeVisible();
    await expect(page.getByLabel('What should it do?')).toHaveCount(0);
    await audit(page, 'automation-edit-watch-locked');
  });
});

test.describe('History and behind the scenes', () => {
  test('history merges runs and one-time results', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/history`);
    await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
    await expect(page.getByText(/Failed: The GitHub token/).first()).toBeVisible();
    await page.getByRole('radio', { name: /Problems/ }).click();
    await expect(page.getByText('Finished').first()).toHaveCount(0);
    await audit(page, 'automation-history');
  });

  test('waiting: plain words, SAM relays behind a switch', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/behind`);
    await expect(
      page.getByText(/PR #2387 release shepherd is waiting for CI to finish on commit 9f8e7d6/)
    ).toBeVisible();
    await expect(page.getByText(/SAM manages this relay/)).toHaveCount(0);
    await page.getByLabel(/Show SAM’s own message relays/).check();
    await expect(page.getByText(/SAM manages this relay/)).toBeVisible();
    await audit(page, 'automation-behind-waiting');
  });

  test('channels: newest first, private threads hidden', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/behind?tab=channels`);
    await expect(page.getByText('release-train')).toBeVisible();
    await expect(page.getByText(/agent-dm\./)).toHaveCount(0);
    await page.getByRole('button', { name: /release-train/ }).click();
    await expect(page.getByText(/Production deploy started/)).toBeVisible();
    await expect(page.getByText(/from PR #2387 release shepherd/)).toBeVisible();
    await audit(page, 'automation-behind-channels');
  });

  test('one chat’s automation', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/behind?sessionId=chat-release-shepherd`);
    await expect(
      page.getByRole('heading', { name: /Automation for “PR #2387 release shepherd”/ })
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Remind this chat later/ })).toBeVisible();
    await audit(page, 'automation-chat-scope');
  });
});

test.describe('Old URLs', () => {
  test('land on the views that replaced them', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/events?section=channels`);
    await expect(page).toHaveURL(new RegExp(`${BASE}/behind\\?tab=channels$`));
    await page.goto(`/projects/${PROJECT_ID}/triggers/trg-morning`);
    await expect(page).toHaveURL(new RegExp(`${BASE}/trigger/trg-morning$`));
    await expect(page.getByRole('heading', { name: 'Morning pull request summary' })).toBeVisible();
    await page.goto(`/projects/${PROJECT_ID}/triggers?edit=new`);
    await expect(page).toHaveURL(new RegExp(`${BASE}/new$`));
  });
});
