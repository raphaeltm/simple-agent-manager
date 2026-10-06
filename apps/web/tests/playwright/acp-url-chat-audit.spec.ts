import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  screenshot,
  setupProjectChatMocks,
} from './audit-helpers';

const PROJECT = 'project-acp-url';
const SESSION = 'session-acp-url';
const URL_ID = 'd1111111-1111-4111-8111-111111111111';
const URL = 'https://auth.example.com/approve?state=SECRET_URL_CANARY';
const MESSAGE = `Review this remote service before continuing. ${'Long authorization context 漢字 ✅ '.repeat(9)}`;

async function setup(page: Page, isMine: boolean, url = URL) {
  const now = Date.now();
  let state = 'pending';
  let completedAt: number | null = null;
  let dropReceipt = false;
  let revoked = false;
  const captured: unknown[] = [];
  await setupProjectChatMocks(page, {
    projectId: PROJECT,
    project: {
      id: PROJECT,
      name: 'ACP URL service fixture',
      repository: 'sam/url',
      repoProvider: 'github',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    session: {
      id: SESSION,
      workspaceId: null,
      taskId: 'url-task',
      topic: 'Remote service approval',
      status: 'active',
      messageCount: 31,
      createdByUserId: 'owner',
      createdBy: {
        id: 'owner',
        name: 'Owner',
        email: 'owner@example.com',
        image: null,
        avatarUrl: null,
      },
      isMine,
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: null,
      cleanupAt: null,
      isIdle: false,
      agentCompletedAt: null,
      agentSessionId: 'url-agent',
      agentType: 'claude-code',
      attention: {
        markerId: 'url-attention',
        kind: 'needs_input',
        createdAt: now - 5000,
        expiresAt: null,
        reason: 'acp_interaction_pending',
        options: [],
      },
    },
    messages: Array.from({ length: 30 }, (_, index) => ({
      id: `url-history-${index}`,
      sessionId: SESSION,
      role: index % 2 ? 'assistant' : 'user',
      content: `History ${index + 1} with 漢字 and <script> text`,
      toolMetadata: null,
      createdAt: now - (60 - index) * 1000,
      sequence: index + 1,
    })),
    user: isMine
      ? { id: 'owner', name: 'Owner', email: 'owner@example.com' }
      : { id: 'member', name: 'Member', email: 'member@example.com' },
  });
  const summary = () => ({
    interactionId: URL_ID,
    kind: 'url',
    state,
    createdAt: now - 5000,
    updatedAt: Date.now(),
    deadlineAt: now + 10 * 60_000,
    answeredAt: state === 'pending' ? null : Date.now(),
    deliveryState: state === 'pending' ? null : 'pending',
    attentionMarkerId: null,
    toolCallId: null,
    urlCompletedAt: completedAt,
  });
  await page.route(`**/api/projects/${PROJECT}/sessions/${SESSION}/interactions`, (route: Route) =>
    route.fulfill({
      status: revoked ? 403 : 200,
      json: isMine
        ? {
            pending: state === 'pending' || state === 'answered' ? [summary()] : [],
            settled: state === 'cancelled' ? [summary()] : [],
            cursor: null,
          }
        : {
            pending: [
              {
                interactionId: URL_ID,
                kind: 'url',
                state,
                createdAt: now - 5000,
                deadlineAt: now + 10 * 60_000,
              },
            ],
            settled: [],
            cursor: null,
          },
    })
  );
  await page.route(
    `**/api/projects/${PROJECT}/sessions/${SESSION}/interactions/${URL_ID}`,
    (route: Route) =>
      route.fulfill({
        status: isMine ? 200 : 403,
        json: isMine
          ? { summary: summary(), detail: { message: MESSAGE, url, elicitationId: 'opaque' } }
          : { error: 'FORBIDDEN' },
        headers: { 'Cache-Control': 'private, no-store' },
      })
  );
  await page.route(
    `**/api/projects/${PROJECT}/sessions/${SESSION}/interactions/${URL_ID}/answer`,
    (route: Route) => {
      captured.push(route.request().postDataJSON());
      state = 'answered';
      if (dropReceipt) {
        dropReceipt = false;
        return route.abort('failed');
      }
      return route.fulfill({ status: 200, json: { accepted: true, state } });
    }
  );
  return {
    captured,
    complete: () => {
      completedAt = Date.now();
    },
    drop: () => {
      dropReceipt = true;
    },
    settle: () => {
      state = 'cancelled';
    },
    revoke: () => {
      revoked = true;
    },
  };
}

async function delayAcceptedDigest(page: Page) {
  await page.addInitScript(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (new TextDecoder().decode(data) !== 'accepted') return original(algorithm, data);
        return new Promise<ArrayBuffer>((resolve, reject) => {
          Object.assign(window, {
            releaseDecisionDigest: () => {
              void original(algorithm, data).then(resolve, reject);
            },
          });
        });
      },
    });
  });
}

for (const viewport of ['iPhone SE (375x667)', 'Desktop (1280x800)']) {
  test.describe(`ACP URL card — ${viewport}`, () => {
    test(`long destination host stays within the chat; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const host = `${'a'.repeat(63)}.example.com`;
      await setup(page, true, `https://${host}/approve`);
      await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
      const link = page
        .getByTestId(`acp-url-${URL_ID}`)
        .getByRole('link', { name: `Open ${host}` });
      await expect(link).toBeVisible();
      await link.scrollIntoViewIfNeeded();
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(
        page,
        viewport.startsWith('iPhone') ? 'acp-url-long-host-mobile' : 'acp-url-long-host-desktop'
      );
      if (viewport.startsWith('iPhone')) {
        await page.setViewportSize({ width: 320, height: 640 });
        await assertNoOverflow(page);
      }
    });

    test(`concurrent decisions send one answer; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      await delayAcceptedDigest(page);
      const backend = await setup(page, true);
      await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
      const card = page.getByTestId(`acp-url-${URL_ID}`);
      await page
        .context()
        .route('https://auth.example.com/**', (route) =>
          route.fulfill({ status: 200, body: 'Fixture' })
        );
      const popupPromise = page.waitForEvent('popup');
      await card.getByRole('link', { name: 'Open auth.example.com' }).click();
      await (await popupPromise).close();
      await card.getByRole('button', { name: 'Continue after opening' }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              typeof (window as unknown as { releaseDecisionDigest?: () => void })
                .releaseDecisionDigest
          )
        )
        .toBe('function');
      await card.getByRole('button', { name: 'Decline' }).click();
      expect(backend.captured).toHaveLength(0);
      await page.evaluate(() =>
        (window as unknown as { releaseDecisionDigest: () => void }).releaseDecisionDigest()
      );
      await expect.poll(() => backend.captured.length).toBe(1);
      expect(backend.captured[0]).toMatchObject({ decision: { kind: 'accepted' } });
    });

    test(`owner reviews host and opens by gesture; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const backend = await setup(page, true);
      await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
      const card = page.getByTestId(`acp-url-${URL_ID}`);
      await expect(card).toBeVisible();
      await card.evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await card
        .getByRole('heading', { name: 'External service request' })
        .scrollIntoViewIfNeeded();
      await expect(card.getByText('Review the destination before opening it.')).toBeVisible();
      await screenshot(
        page,
        viewport.startsWith('iPhone') ? 'acp-url-owner-top-mobile' : 'acp-url-owner-top-desktop'
      );
      await card.getByRole('button', { name: 'Show full request' }).click();
      await expect(card.getByText(MESSAGE)).toBeVisible();
      await card.getByRole('button', { name: 'Show less' }).click();
      const link = card.getByRole('link', { name: 'Open auth.example.com' });
      await expect(link).toHaveAttribute('href', URL);
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(card.getByRole('button', { name: 'Continue after opening' })).toBeDisabled();
      await link.scrollIntoViewIfNeeded();
      await card.getByRole('button', { name: 'Continue after opening' }).scrollIntoViewIfNeeded();
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(
        page,
        viewport.startsWith('iPhone') ? 'acp-url-owner-mobile' : 'acp-url-owner-desktop'
      );
      await page.context().route('https://auth.example.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body><h1>External service fixture</h1></body></html>',
        })
      );
      const popupPromise = page.waitForEvent('popup');
      await link.click();
      const popup = await popupPromise;
      await expect(popup.getByRole('heading', { name: 'External service fixture' })).toBeVisible();
      await popup.close();
      await card.getByRole('button', { name: 'Continue after opening' }).click();
      await expect(card.getByText('Your decision was saved. Delivery is pending.')).toBeVisible();
      expect(backend.captured).toHaveLength(1);
      expect(backend.captured[0]).toMatchObject({ decision: { kind: 'accepted' } });
      backend.complete();
      await page.reload();
      await expect(
        page.getByTestId(`acp-url-${URL_ID}`).getByText('The external service reported completion.')
      ).toBeVisible();
      await screenshot(
        page,
        viewport.startsWith('iPhone') ? 'acp-url-complete-mobile' : 'acp-url-complete-desktop'
      );
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      if (viewport.startsWith('iPhone')) {
        await page.setViewportSize({ width: 320, height: 640 });
        await assertNoOverflow(page);
      }
    });

    test(`noncreator sees generic state; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      await setup(page, false);
      await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
      const card = page.getByTestId(`acp-url-${URL_ID}`);
      await expect(card.getByText('Waiting for the session creator to respond.')).toBeVisible();
      await expect(card.getByText(MESSAGE)).toHaveCount(0);
      await expect(card.getByRole('link')).toHaveCount(0);
      await screenshot(
        page,
        viewport.startsWith('iPhone') ? 'acp-url-noncreator-mobile' : 'acp-url-noncreator-desktop'
      );
    });

    test(`uncertain receipt retries the same decision; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const backend = await setup(page, true);
      await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
      const card = page.getByTestId(`acp-url-${URL_ID}`);
      await page
        .context()
        .route('https://auth.example.com/**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Fixture</h1>' })
        );
      const popupPromise = page.waitForEvent('popup');
      await card.getByRole('link', { name: 'Open auth.example.com' }).click();
      await (await popupPromise).close();
      backend.drop();
      await card.getByRole('button', { name: 'Continue after opening' }).click();
      await expect(
        card.getByText('Receipt unknown. Check it with the same answer key.')
      ).toBeVisible();
      await card.getByRole('button', { name: 'Check receipt' }).click();
      expect(backend.captured).toHaveLength(2);
      expect(backend.captured[0]).toEqual(backend.captured[1]);
      await screenshot(
        page,
        viewport.startsWith('iPhone') ? 'acp-url-receipt-mobile' : 'acp-url-receipt-desktop'
      );
    });

    for (const scenario of ['terminal state', 'access revocation'] as const) {
      test(`delayed decision cannot submit after ${scenario}; ${viewport}`, async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== viewport);
        await delayAcceptedDigest(page);
        const backend = await setup(page, true);
        await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
        const card = page.getByTestId(`acp-url-${URL_ID}`);
        await page
          .context()
          .route('https://auth.example.com/**', (route) =>
            route.fulfill({ status: 200, body: 'Fixture' })
          );
        const popupPromise = page.waitForEvent('popup');
        await card.getByRole('link', { name: 'Open auth.example.com' }).click();
        await (await popupPromise).close();
        await card.getByRole('button', { name: 'Continue after opening' }).click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                typeof (window as unknown as { releaseDecisionDigest?: () => void })
                  .releaseDecisionDigest
            )
          )
          .toBe('function');
        if (scenario === 'terminal state') {
          backend.settle();
          await expect(
            card.getByText('Request cancelled. External completion is unconfirmed.')
          ).toBeVisible({ timeout: 15_000 });
        } else {
          backend.revoke();
          await expect(card).toHaveCount(0, { timeout: 15_000 });
        }
        await page.evaluate(async () => {
          (window as unknown as { releaseDecisionDigest: () => void }).releaseDecisionDigest();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
        });
        expect(backend.captured).toHaveLength(0);
      });
    }
  });
}
