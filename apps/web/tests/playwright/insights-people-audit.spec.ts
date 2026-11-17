/**
 * Visual and behaviour audit for Insights · People (slice P) at 375×667 and 1280×800. The People
 * read is served exactly as the API answers it (`insights-people-fixtures.ts`). Scenes: a
 * realistic project, a stressed one (long and hostile names and titles, eight people, 30+ open
 * items each, a capped review scan), an empty project, a failed read, and a reassign through the
 * Inbox's own route that refreshes the list.
 */
import { expect, type Page, test } from '@playwright/test';
import { isInsightsRange } from '@simple-agent-manager/shared';

import {
  auditOnPhoneAndDesktop,
  BASE,
  capture,
  PROJECT_ID,
  routeInsightsApi,
  USER_ID,
} from './insights-audit-support';
import { makePeople, type PeopleScene } from './insights-people-fixtures';

const MEMBERS = [
  { userId: USER_ID, name: 'Dana Reyes', email: 'dana@example.com' },
  { userId: 'user-priya', name: 'Priya Natarajan', email: 'priya@example.com' },
  { userId: 'user-sam', name: 'Sam Okafor', email: 'sam@example.com' },
].map((m) => ({
  projectId: PROJECT_ID,
  userId: m.userId,
  role: 'member',
  status: 'active',
  user: { id: m.userId, name: m.name, email: m.email, avatarUrl: null, image: null },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}));

interface Recorder {
  people: string[];
  reassigns: Array<{ path: string; body: unknown }>;
  /** How the reassign route answers: move the task (default) or refuse it. */
  reassign?: 'move' | 'refuse';
}

async function setupScene(page: Page, scene: PeopleScene | 'error', rec?: Recorder) {
  let current: PeopleScene | 'error' = scene;
  await routeInsightsApi(
    page,
    (url, route, respond) => {
      const path = url.pathname;
      if (path === `/api/projects/${PROJECT_ID}/insights/people`) {
        const range = url.searchParams.get('range');
        rec?.people.push(range ?? '');
        if (current === 'error')
          return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
        return respond(
          200,
          makePeople(PROJECT_ID, isInsightsRange(range) ? range : '30d', current)
        );
      }
      if (
        path.startsWith(`/api/projects/${PROJECT_ID}/inbox/items/`) &&
        path.endsWith('/reassign')
      ) {
        rec?.reassigns.push({ path, body: route.request().postDataJSON() });
        if (rec?.reassign === 'refuse')
          return respond(400, {
            error: 'BAD_REQUEST',
            message: 'The assignee is not an active project member',
          });
        // After the move the task waits on Sam: serve that state next.
        current = current === 'single' ? 'single-moved' : 'moved';
        return respond(200, { ref: 'ask:t-2', status: 'open', agentNotified: true });
      }
      return undefined;
    },
    MEMBERS
  );
}

auditOnPhoneAndDesktop();

test.describe('Insights · People', () => {
  test('a realistic project', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/people`);
    await expect(page.getByRole('tab', { name: 'People', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('6');
    await expect(page.getByTestId('insights-tile-oldest')).toContainText('3.2 days');
    await expect(page.getByTestId('insights-tile-review-pickup')).toContainText('2.4 h');
    await expect(page.getByTestId('insights-tile-first-person')).toContainText('83%');
    const priya = page.getByTestId('insights-waiting-group-user-priya');
    await expect(priya).toContainText('Priya Natarajan');
    await expect(priya).toContainText('3 open · oldest 3.2 days · 1 blocking');
    // Another member's private items show their age only.
    await expect(priya.getByText('An item you cannot open')).toHaveCount(2);
    // Reassign is offered only on the three human tasks the viewer may hand on.
    await expect(page.getByRole('button', { name: /^Reassign / })).toHaveCount(3);
    await expect(page.getByTestId('insights-waiting-group-user-insights')).toContainText('You');
    await expect(page.getByTestId('insights-waiting-group-unassigned')).toContainText(
      'Not taken yet'
    );
    await expect(page.getByTestId('insights-review-pickup')).toContainText('19 h');
    // No per-person output count anywhere: groups say what waits, not what anyone did.
    await expect(page.getByTestId('insights-people')).not.toContainText(
      /merged|produced|completed by/i
    );
    await capture(page, 'insights-people-realistic');
  });

  test('reassign hands a task on through the Inbox route and the list shows where it went', async ({
    page,
  }) => {
    const rec: Recorder = { people: [], reassigns: [] };
    await setupScene(page, 'realistic', rec);
    await page.goto(`${BASE}/people`);
    const own = page.getByTestId('insights-waiting-group-user-insights');
    await own
      .getByRole('button', { name: 'Reassign Confirm the new tax table with accounting' })
      .click();
    const form = page.getByTestId('insights-reassign-form-ask:t-2');
    await expect(form).toBeVisible();
    const select = form.getByRole('combobox');
    // The form takes focus, and does not offer the person who already has the task.
    await expect(select).toBeFocused();
    await expect(select.locator('option')).toHaveText([
      'Choose who…',
      'Priya Natarajan',
      'Sam Okafor',
      'Back to the team',
    ]);
    await capture(page, 'insights-people-reassign-open');
    await select.selectOption({ label: 'Sam Okafor' });
    await form.getByRole('button', { name: 'Hand it on' }).click();
    await expect(page.getByTestId('insights-reassign-status')).toHaveText(
      'Handed on to Sam Okafor.'
    );
    await expect(page.getByTestId('insights-waiting-group-user-sam')).toContainText(
      'Confirm the new tax table with accounting'
    );
    await expect(own).not.toContainText('Confirm the new tax table with accounting');
    expect(rec.reassigns).toEqual([
      {
        path: `/api/projects/${PROJECT_ID}/inbox/items/ask%3At-2/reassign`,
        body: { assigneeUserId: 'user-sam' },
      },
    ]);
    expect(rec.people.length).toBeGreaterThanOrEqual(2);
  });

  test('handing on the last movable task keeps the announcement and focus', async ({ page }) => {
    const rec: Recorder = { people: [], reassigns: [] };
    await setupScene(page, 'single', rec);
    await page.goto(`${BASE}/people`);
    await expect(page.getByRole('button', { name: /^Reassign / })).toHaveCount(1);
    await page
      .getByRole('button', { name: 'Reassign Confirm the new tax table with accounting' })
      .click();
    const form = page.getByTestId('insights-reassign-form-ask:t-2');
    await form.getByRole('combobox').selectOption({ label: 'Sam Okafor' });
    await form.getByRole('button', { name: 'Hand it on' }).click();
    await expect(page.getByTestId('insights-waiting-group-user-sam')).toContainText(
      'Confirm the new tax table with accounting'
    );
    // Nothing movable is left, yet the region that announced and took focus is still mounted.
    await expect(page.getByRole('button', { name: /^Reassign / })).toHaveCount(0);
    await expect(page.getByTestId('insights-reassign-status')).toHaveText(
      'Handed on to Sam Okafor.'
    );
    await expect(page.getByTestId('insights-waiting-region')).toBeFocused();
  });

  test('the light theme', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/people`);
    await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'sam-light'));
    await page
      .getByRole('button', { name: 'Reassign Check the EU VAT report renders for Belgium' })
      .click();
    await expect(page.getByTestId('insights-reassign-form-ask:t-3')).toBeVisible();
    await capture(page, 'insights-people-light');
  });

  test('a refused reassign says why and keeps the form open; cancel returns focus', async ({
    page,
  }) => {
    const rec: Recorder = { people: [], reassigns: [], reassign: 'refuse' };
    await setupScene(page, 'realistic', rec);
    await page.goto(`${BASE}/people`);
    const trigger = page.getByRole('button', {
      name: 'Reassign Check the EU VAT report renders for Belgium',
    });
    await trigger.click();
    const form = page.getByTestId('insights-reassign-form-ask:t-3');
    // A task nobody took is already the team's: "Back to the team" is not offered.
    await expect(form.getByRole('combobox').locator('option')).toHaveText([
      'Choose who…',
      'Dana Reyes',
      'Priya Natarajan',
      'Sam Okafor',
    ]);
    await form.getByRole('combobox').selectOption({ label: 'Priya Natarajan' });
    await form.getByRole('button', { name: 'Hand it on' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'The assignee is not an active project member'
    );
    await expect(form).toBeVisible();
    await capture(page, 'insights-people-reassign-refused');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('a stressed project wraps and stays in bounds', async ({ page }) => {
    await setupScene(page, 'stress');
    await page.goto(`${BASE}/people?range=90d`);
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('290');
    await expect(page.getByTestId('insights-waiting-group-user-0')).toContainText(
      'Maximiliana Wolfeschlegelsteinhausenbergerdorff'
    );
    await expect(page.getByTestId('insights-waiting-group-user-0')).toContainText(
      '24 more, the oldest are shown.'
    );
    await expect(page.getByTestId('insights-review-pickup')).toContainText(
      'only the most recent requests were examined'
    );
    // Hostile titles render as text.
    await expect(page.getByText('<script>alert(3)</script> & “quotes” 🚀 3').first()).toBeVisible();
    await capture(page, 'insights-people-stress');
  });

  test('an empty project', async ({ page }) => {
    await setupScene(page, 'empty');
    await page.goto(`${BASE}/people`);
    await expect(page.getByTestId('insights-section-waiting')).toContainText(
      'Nothing is waiting on anyone'
    );
    await expect(page.getByTestId('insights-review-pickup')).toContainText('Not recorded yet');
    await expect(page.getByTestId('insights-tile-first-person')).toContainText('—');
    await capture(page, 'insights-people-empty');
  });

  test('a failed read offers a retry', async ({ page }) => {
    await setupScene(page, 'error');
    await page.goto(`${BASE}/people`);
    await expect(page.getByText(/could not load people insights/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'insights-people-error');
  });
});
