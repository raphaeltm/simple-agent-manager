import { expect, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

const PROTOTYPE = '/prototype/comments';

async function openAndCheck(page: Parameters<typeof assertNoOverflow>[0], path: string) {
  await page.goto(path);
  await expect(page.getByTestId('comments-prototype')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await assertNoOverflow(page);
}

async function resetPrototypeScroll(page: Parameters<typeof assertNoOverflow>[0]) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelector<HTMLElement>('[data-testid="comments-prototype"]')?.scrollTo(0, 0);
  });
}

test.describe('comments UX prototype — mobile', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    void _page;
    test.skip(!testInfo.project.name.includes('iPhone SE'), 'Mobile audit only runs at 375x667');
  });

  test('collaborator adds context at a conversation checkpoint', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=chat&role=collaborator&panel=closed`);
    await expect(page.getByRole('textbox', { name: 'Collaborator note' })).toBeVisible();
    await resetPrototypeScroll(page);
    await screenshot(page, 'comments-chat-collaborator-composer-mobile');

    await page.getByRole('button', { name: 'Add note at current conversation point' }).click();
    await expect(page.getByRole('heading', { name: 'Current conversation point' })).toBeVisible();
    await expect(page.getByText('Visible to everyone in this project').last()).toBeVisible();
    await screenshot(page, 'comments-chat-checkpoint-mobile');
  });

  test('collaborator opens notes on a specific message', async ({ page }) => {
    await openAndCheck(
      page,
      `${PROTOTYPE}?surface=chat&role=collaborator&panel=open&anchor=message`
    );
    await expect(page.getByRole('heading', { name: 'Message notes' })).toBeVisible();
    await screenshot(page, 'comments-chat-message-notes-mobile');
  });

  test('owner reviews notes before the next prompt', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=chat&role=owner&panel=closed`);
    await expect(
      page.getByRole('heading', { name: '2 notes waiting for your review' })
    ).toBeVisible();
    await expect(page.getByText('2 selected')).toBeVisible();

    await page.getByText('Maya Chen').last().click();
    await expect(page.getByText('1 selected')).toBeVisible();
    await screenshot(page, 'comments-chat-owner-review-mobile');
  });

  test('markdown selection opens its comment thread', async ({ page }) => {
    await openAndCheck(
      page,
      `${PROTOTYPE}?surface=library&file=markdown&view=rendered&panel=closed`
    );
    await expect(page.getByText('Multiplayer comments rollout')).toBeVisible();
    await screenshot(page, 'comments-library-markdown-selection-mobile');

    await page
      .getByText(
        'collaborators leave notes, the session owner reviews them, and only selected notes are attached to the next agent turn.'
      )
      .click();
    const panel = page.getByTestId('comments-panel');
    await expect(panel.getByRole('heading', { name: 'File comments' })).toBeVisible();
    await expect(panel.getByText('3', { exact: true })).toBeVisible();
    await screenshot(page, 'comments-library-markdown-thread-mobile');

    await panel.getByRole('button', { name: 'Close comments' }).click();
    await page.getByRole('button', { name: 'Source' }).click();
    await expect(page.getByText('# Multiplayer comments rollout')).toBeVisible();
    await resetPrototypeScroll(page);
    await screenshot(page, 'comments-library-markdown-source-mobile');
  });

  test('code selection and many-comment stress state remain contained', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=library&file=code&panel=closed&scenario=many`);
    await expect(page.getByText('collaboratorContext: notes.map(snapshotNote),')).toBeVisible();
    await resetPrototypeScroll(page);
    await screenshot(page, 'comments-library-code-anchor-mobile');

    await page.getByRole('button', { name: 'Open 2 comments on line 8' }).click();
    const panel = page.getByTestId('comments-panel');
    await expect(panel.getByRole('heading', { name: 'Code comments' })).toBeVisible();
    await expect(panel.getByText('32', { exact: true })).toBeVisible();
    await expect(panel.getByText(/A very long comment used to stress wrapping/)).toBeVisible();
    await screenshot(page, 'comments-library-code-many-mobile');
    await assertNoOverflow(page);
  });

  test('narrow 320px viewport does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 667 });
    await openAndCheck(page, `${PROTOTYPE}?surface=chat&role=collaborator&panel=closed`);
    await assertNoOverflow(page);
    await openAndCheck(page, `${PROTOTYPE}?surface=library&file=markdown&panel=closed`);
    await assertNoOverflow(page);
  });

  test('empty and refresh-error comment states are explicit', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=library&scenario=empty&panel=open`);
    await expect(page.getByRole('heading', { name: 'Start the conversation' })).toBeVisible();
    await screenshot(page, 'comments-empty-thread-mobile');

    await openAndCheck(page, `${PROTOTYPE}?surface=library&scenario=error&panel=open`);
    await expect(page.getByRole('alert')).toContainText(
      'previously loaded comments are still available'
    );
    await screenshot(page, 'comments-refresh-error-mobile');
  });
});

test.describe('comments UX prototype — desktop', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    void _page;
    test.skip(!testInfo.project.name.includes('Desktop'), 'Desktop audit only runs at 1280x800');
  });

  test('collaborator chat uses a contextual comments rail', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=chat&role=collaborator&panel=open`);
    const panel = page.getByTestId('comments-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('One constraint from the existing multiplayer work');
    await screenshot(page, 'comments-chat-collaborator-desktop');
  });

  test('owner review tray preserves the clean transcript', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=chat&role=owner&panel=closed`);
    await expect(page.getByText('They do not become prompts in the transcript.')).toBeVisible();
    await expect(page.getByLabel('Reply to agent')).toBeVisible();
    await screenshot(page, 'comments-chat-owner-review-desktop');
  });

  test('markdown and code comments use the same rail model', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=library&file=markdown&view=rendered&panel=open`);
    await expect(page.getByText('Multiplayer comments rollout')).toBeVisible();
    await screenshot(page, 'comments-library-markdown-desktop');

    await openAndCheck(page, `${PROTOTYPE}?surface=library&file=code&panel=open`);
    await expect(page.getByText('collaboratorContext: notes.map(snapshotNote),')).toBeVisible();
    await screenshot(page, 'comments-library-code-desktop');
  });

  test('stale markdown anchor offers a recovery action', async ({ page }) => {
    await openAndCheck(page, `${PROTOTYPE}?surface=library&file=markdown&view=rendered&panel=open`);
    await page.getByText('Anchors survive ordinary edits when possible').click();
    await expect(page.getByText('Original text · anchor is stale')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Re-anchor comment' })).toBeVisible();
    await screenshot(page, 'comments-library-stale-anchor-desktop');
  });
});
