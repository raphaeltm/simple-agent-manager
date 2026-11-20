/**
 * Inbox replies visual audit (idea 01M7N16AF5HDPH1ZND4D4RJ00J) at 375px and 1280px: an item as a
 * conversation (long text, many turns, attachments), writing a reply with an attachment, the
 * receipt, a pending permission's decline notice, a settled declined permission, the Archived
 * "With the agent" label, and the row of an item the agent responded on.
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';
import { type InboxMockState, KIND_ITEMS, REPLY_ITEMS, setupInboxMocks } from './inbox-fixtures';

function state(): InboxMockState {
  return { items: [...REPLY_ITEMS, ...KIND_ITEMS], answered: [], archived: [], replied: [] };
}

async function openItem(page: Page, mock: InboxMockState, ref: string, project: string) {
  await setupInboxMocks(page, mock);
  await page.goto(`/inbox?${new URLSearchParams({ item: ref, project }).toString()}`);
  await expect(page.getByTestId('inbox-conversation')).toBeVisible();
}

async function mockUploads(page: Page) {
  let upload = 0;
  await page.route('**/tasks/request-upload', (route) => {
    upload++;
    return route.fulfill({
      json: {
        uploadId: `upload-${upload}`,
        uploadUrl: `http://localhost:4173/mock-upload/${upload}`,
      },
    });
  });
  await page.route('**/mock-upload/*', (route) => route.fulfill({ status: 200 }));
}

/** The composer's bottom edge meets the item pane's: it is pinned, not pushed by the thread. */
async function expectComposerPinned(page: Page) {
  const area = (await page.getByTestId('inbox-reply-area').boundingBox())!;
  const pane = (await page.getByRole('region', { name: 'Inbox item' }).boundingBox())!;
  expect(Math.abs(area.y + area.height - (pane.y + pane.height))).toBeLessThanOrEqual(2);
  expect(area.y + area.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
}

async function check(page: Page, name: string) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  await screenshot(page, name);
}

for (const viewport of [
  { label: 'mobile', width: 375, height: 667, isMobile: true },
  { label: 'desktop', width: 1280, height: 800, isMobile: false },
] as const) {
  test.describe(`Inbox replies — ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
    });

    test('a long conversation: turns in order, controls on the latest response', async ({
      page,
    }) => {
      await openItem(page, state(), 'ask:conv', 'p-billing');
      const turns = page.locator(
        '[data-testid="inbox-ask"], [data-testid="inbox-reply"], [data-testid="inbox-response"]'
      );
      await expect(turns).toHaveCount(7);
      // One set of controls, on the newest agent turn, not in the ask.
      await expect(page.getByTestId('inbox-answer-controls')).toHaveCount(1);
      await expect(
        page.getByTestId('inbox-response').last().getByRole('button', { name: 'Per node' })
      ).toBeVisible();
      await expect(page.getByText('retry-graph-week-46.png')).toBeVisible();
      await expect(page.getByText(/Attached Files/)).toHaveCount(0);
      await expectComposerPinned(page);
      await check(page, `inbox-replies-conversation-top-${viewport.label}`);
      await page.getByTestId('inbox-response').last().scrollIntoViewIfNeeded();
      await check(page, `inbox-replies-conversation-bottom-${viewport.label}`);
    });

    test('writing a reply with an attachment, then the receipt', async ({ page }) => {
      const mock = state();
      await openItem(page, mock, 'ask:conv', 'p-billing');
      // After the inbox mocks: the latest registered route wins.
      await mockUploads(page);
      await page
        .getByRole('combobox', { name: 'Reply to the agent' })
        .fill(
          'What happens to nodes that are already mid-retry if we switch to per project? Screenshot of the retry graph from last week attached.'
        );
      await page.locator('[data-testid="inbox-reply-area"] input[type=file]').setInputFiles({
        name: 'retry-graph-week-46.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(2048, 1),
      });
      await expect(page.getByText('retry-graph-week-46.png').last()).toBeVisible();
      const send = page.getByRole('button', { name: /^Send/ });
      await expect(send).toBeEnabled();
      await expectComposerPinned(page);
      await check(page, `inbox-replies-compose-${viewport.label}`);
      await send.click();
      await expect(page.getByTestId('inbox-receipt')).toContainText(
        'Sent to the agent’s chat. This comes back if it responds.'
      );
      expect(mock.replyBodies?.[0]).toMatchObject({
        content: expect.stringContaining('mid-retry'),
        attachments: [expect.objectContaining({ uploadId: 'upload-1' })],
      });
      await check(page, `inbox-replies-sent-${viewport.label}`);
    });

    test('a pending permission says sending declines it', async ({ page }) => {
      const permission = KIND_ITEMS.find((item) => item.kind === 'permission')!;
      await openItem(page, state(), permission.ref, permission.projectId);
      await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
      await expect(page.getByTestId('inbox-reply-declines')).toContainText(
        'Sending declines this request'
      );
      await expectComposerPinned(page);
      await check(page, `inbox-replies-permission-pending-${viewport.label}`);
    });

    test('a settled, declined permission: its conversation, no buttons, still a composer', async ({
      page,
    }) => {
      await openItem(page, state(), 'attention:s-perm:m-settled', 'p-infra');
      await expect(page.getByText('Understood. I ran it on staging instead')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
      await expect(page.getByTestId('inbox-reply-declines')).toHaveCount(0);
      await expectComposerPinned(page);
      await check(page, `inbox-replies-permission-settled-${viewport.label}`);
    });

    test('Archived lists items with the agent', async ({ page }) => {
      await setupInboxMocks(page, state());
      await page.goto('/inbox?filter=archived');
      const hint = page.getByTestId('inbox-reply-hint').first();
      await expect(hint).toContainText('With the agent');
      await expect(hint).toContainText('You replied');
      await check(page, `inbox-replies-archived-${viewport.label}`);
    });

    test('Needs you shows the item the agent responded on', async ({ page }) => {
      await setupInboxMocks(page, state());
      await page.goto('/inbox');
      const hint = page
        .getByRole('listitem')
        .filter({ hasText: 'Should the retry cap apply per node' })
        .getByTestId('inbox-reply-hint');
      await expect(hint).toContainText('The agent responded');
      await expect(hint).toContainText('Dana Reyes replied');
      // Liveness of the list itself: other rows rendered too.
      await expect(page.getByTestId('inbox-row').nth(3)).toBeVisible();
      await check(page, `inbox-replies-needs-you-${viewport.label}`);
    });
  });
}
