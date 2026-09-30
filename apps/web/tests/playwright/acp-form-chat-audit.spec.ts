import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT = 'project-acp-forms';
const SESSION = 'session-acp-forms';
const FORM_ID = 'c1111111-1111-4111-8111-111111111111';
const EXPIRED_ID = 'c2222222-2222-4222-8222-222222222222';
const LONG = `Please choose the correct storage and deployment plan. ${'Long context with a careful explanation and special characters 漢字 ✅ '.repeat(9)}`;

function summary(id: string, state: string, deadlineAt: number) {
  return { interactionId: id, kind: 'form', state, createdAt: Date.now() - 5000,
    updatedAt: Date.now() - 5000, deadlineAt, answeredAt: null, deliveryState: null,
    attentionMarkerId: null, toolCallId: null };
}

function formSchema() {
  return { type: 'object', properties: {
    plan: { type: 'string', title: 'Deployment plan', description: 'Choose exactly one plan.',
      oneOf: [{ const: 'Fast', title: 'Fast', description: 'Quick release' }, { const: 'Safe', title: 'Safe' }] },
    regions: { type: 'array', title: 'Regions', items: { anyOf: [
      { const: 'EU', title: 'Europe' }, { const: 'US', title: 'United States' }] } },
    note: { type: 'string', title: 'Other or note', description: 'Optional note for this choice.',
      maxLength: 200, _meta: { _askUserQuestionCustomAnswer: { questionId: 'plan', isCustomAnswer: true } } },
    count: { type: 'integer', title: 'Number of workers', minimum: 1, maximum: 10, default: 2 },
    confirmed: { type: 'boolean', title: 'Confirm the deployment' },
  }, required: ['plan', 'confirmed'] };
}

async function setup(page: Page, isMine: boolean) {
  const now = Date.now();
  let current = summary(FORM_ID, 'pending', now + 30 * 60_000);
  const captured: unknown[] = [];
  let dropNextAnswerReceipt = false;
  await setupProjectChatMocks(page, {
    projectId: PROJECT,
    project: { id: PROJECT, name: 'ACP form visual stress fixture', repository: 'sam/forms',
      repoProvider: 'github', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' },
    session: { id: SESSION, workspaceId: null, taskId: 'form-task', topic: 'Agent forms', status: 'active',
      messageCount: 31, createdByUserId: 'owner', createdBy: { id: 'owner', name: 'Owner',
        email: 'owner@example.com', image: null, avatarUrl: null }, isMine,
      createdAt: now - 120_000, startedAt: now - 120_000, endedAt: null, cleanupAt: null,
      isIdle: false, agentCompletedAt: null, agentSessionId: 'form-agent', agentType: 'openai-codex',
      attention: { markerId: 'form-attention', kind: 'needs_input', createdAt: now - 5000,
        expiresAt: null, reason: 'acp_interaction_pending', options: [] } },
    messages: Array.from({ length: 30 }, (_, index) => ({ id: `form-history-${index}`, sessionId: SESSION,
      role: index % 2 ? 'assistant' : 'user', content: `History ${index + 1} with 漢字 and <script> text`,
      toolMetadata: null, createdAt: now - (60 - index) * 1000, sequence: index + 1 })),
    user: isMine ? { id: 'owner', name: 'Owner', email: 'owner@example.com' } :
      { id: 'member', name: 'Member', email: 'member@example.com' },
  });
  await page.route(`**/api/projects/${PROJECT}/sessions/${SESSION}/interactions`, (route: Route) =>
    route.fulfill({ status: 200, json: isMine ? { pending: current.state === 'pending' ? [current] : [],
      settled: [summary(EXPIRED_ID, 'expired', now - 1000), ...(current.state !== 'pending' ? [current] : [])], cursor: null } :
      { pending: [{ interactionId: FORM_ID, kind: 'form', state: current.state,
        createdAt: current.createdAt, deadlineAt: current.deadlineAt }], settled: [], cursor: null } }));
  await page.route(`**/api/projects/${PROJECT}/sessions/${SESSION}/interactions/${FORM_ID}`, (route: Route) =>
    route.fulfill({ status: isMine ? 200 : 403, json: isMine ?
      { summary: current, detail: { message: LONG, schema: formSchema() } } : { error: 'FORBIDDEN' },
      headers: { 'Cache-Control': 'private, no-store' } }));
  await page.route(`**/api/projects/${PROJECT}/sessions/${SESSION}/interactions/${FORM_ID}/answer`, (route: Route) => {
    captured.push(route.request().postDataJSON());
    current = { ...current, state: 'answered', updatedAt: Date.now() };
    if (dropNextAnswerReceipt) { dropNextAnswerReceipt = false; return route.abort('failed'); }
    return route.fulfill({ status: 200, json: { accepted: true, state: 'answered' } });
  });
  return { captured, dropNextAnswerReceipt: () => { dropNextAnswerReceipt = true; } };
}

async function open(page: Page, isMine: boolean) {
  const backend = await setup(page, isMine);
  await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
  const card = page.getByTestId(`acp-form-${FORM_ID}`);
  await expect(card).toBeVisible();
  await card.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  return { backend, card };
}

for (const viewport of ['iPhone SE (375x667)', 'Desktop (1280x800)']) {
  test.describe(`ACP form card — ${viewport}`, () => {
    test(`owner answers and sees receipt; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const { backend, card } = await open(page, true);
      await expect(card.getByText(LONG)).toBeVisible();
      await expect(card.getByLabel('Deployment plan')).toBeVisible();
      await screenshot(page, viewport.startsWith('iPhone') ? 'acp-form-owner-mobile' : 'acp-form-owner-desktop');
      await card.getByRole('button', { name: 'Send answer' }).click();
      await expect(card.getByText('Check Deployment plan.')).toBeVisible();
      await expect(card.getByLabel('Deployment plan')).toBeFocused();
      await card.getByLabel('Deployment plan').selectOption('Fast');
      await expect(card.getByText('Quick release')).toBeVisible();
      await card.getByLabel('Confirm the deployment').selectOption('true');
      await card.getByLabel('Other or note').fill('Use the safe rollback path');
      await card.getByRole('button', { name: 'Send answer' }).scrollIntoViewIfNeeded();
      await screenshot(page, viewport.startsWith('iPhone') ? 'acp-form-actions-mobile' : 'acp-form-actions-desktop');
      await card.getByRole('button', { name: 'Send answer' }).click();
      await expect(card).toHaveAttribute('data-interaction-state', 'answered');
      const savedStatus = card.getByText('Answer saved. Waiting for delivery to the agent.');
      await savedStatus.scrollIntoViewIfNeeded();
      await expect(savedStatus).toBeInViewport();
      await screenshot(page, viewport.startsWith('iPhone') ? 'acp-form-receipt-mobile' : 'acp-form-receipt-desktop');
      expect(backend.captured).toHaveLength(1);
      expect(backend.captured[0]).toMatchObject({ decision: { kind: 'accepted', content: {
        plan: 'Fast', confirmed: true, note: 'Use the safe rollback path', count: 2 } } });
      await assertNoOverflow(page);
      await page.reload();
      await expect(page.getByTestId(`acp-form-${FORM_ID}`).getByText('Answer saved. Waiting for delivery to the agent.')).toBeVisible();
      if (viewport.startsWith('iPhone')) {
        await page.setViewportSize({ width: 320, height: 640 });
        await assertNoOverflow(page);
        await assertNoClippedOverflow(page);
      }
    });

    test(`declines without empty acceptance; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const { backend, card } = await open(page, true);
      await card.getByRole('button', { name: 'Decline' }).click();
      await expect(card).toHaveAttribute('data-interaction-state', 'answered');
      expect(backend.captured).toHaveLength(1);
      expect(backend.captured[0]).toMatchObject({ decision: { kind: 'declined' } });
      expect(JSON.stringify(backend.captured[0])).not.toContain('"content":{}');
    });

    test(`retries an uncertain receipt with the same key; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const { backend, card } = await open(page, true);
      backend.dropNextAnswerReceipt();
      await card.getByLabel('Deployment plan').selectOption('Fast');
      await card.getByLabel('Confirm the deployment').selectOption('true');
      await card.getByRole('button', { name: 'Send answer' }).click();
      await expect(card.getByText('Receipt unknown. Retry with the same answer key to check.')).toBeVisible();
      await card.getByRole('button', { name: 'Check receipt' }).click();
      await expect(card).toHaveAttribute('data-interaction-state', 'answered');
      expect(backend.captured).toHaveLength(2);
      expect(backend.captured[0]).toEqual(backend.captured[1]);
    });

    test(`noncreator sees generic state; ${viewport}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== viewport);
      const { card } = await open(page, false);
      await expect(card.getByText('Waiting for the session creator to answer.')).toBeVisible();
      await expect(card.getByText(LONG)).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
      await screenshot(page, viewport.startsWith('iPhone') ? 'acp-form-noncreator-mobile' : 'acp-form-noncreator-desktop');
    });
  });
}
