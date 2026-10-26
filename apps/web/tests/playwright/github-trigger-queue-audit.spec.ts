import { expect, test } from '@playwright/test';

import { audit } from './automation-audit-helpers';
import { PROJECT_ID, setupAutomationMocks, TRIGGERS } from './automation-fixtures';

for (const scenario of ['normal', 'many-long', 'empty', 'error'] as const) {
  test(`GitHub queue ${scenario}`, async ({ page }, info) => {
    test.skip(!['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(info.project.name));
    await setupAutomationMocks(page);
    const trigger = {
      ...TRIGGERS.github,
      ...(scenario === 'empty' ? { triggerCount: 0, lastTriggeredAt: null } : {}),
      githubConfig: { ...TRIGGERS.github.githubConfig, subjectAffinity: true },
      queueStats:
        scenario === 'empty'
          ? { queued: 0, routed: 0, dropped: 0, unconfirmed: 0 }
          : { queued: 2, routed: 3, dropped: 3, unconfirmed: 1 },
      ...(scenario === 'many-long'
        ? { name: 'Follow up on repository issues and pull requests '.repeat(6) }
        : {}),
    };
    await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}`, (route) =>
      route.fulfill({ json: trigger })
    );
    const statuses = [
      'waiting',
      'routing',
      'routed',
      'dropped',
      'dropped',
      'dropped',
      'dropped',
    ] as const;
    const runs = Array.from({ length: scenario === 'many-long' ? 35 : 7 }, (_, i) => ({
      id: `event-${i}`,
      triggerId: trigger.id,
      projectId: PROJECT_ID,
      status: statuses[i % 7],
      skipReason:
        i % 7 === 3
          ? 'queue_expired'
          : i % 7 === 4
            ? 'queue_full'
            : i % 7 === 5
              ? 'delivery_uncertain'
              : i % 7 === 6
                ? 'target_unavailable'
                : null,
      taskId: null,
      routedTaskId: i % 7 === 2 || i % 7 === 3 || i % 7 === 6 ? 'active-run' : null,
      subjectKey: 'github:42:7',
      routedSessionId: i % 7 === 2 ? 'active-session' : null,
      eventType: 'github.issue_comment.created',
      renderedPrompt: 'Follow up comment',
      errorMessage: null,
      scheduledAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      sequenceNumber: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}/executions*`, (route) =>
      route.fulfill(
        scenario === 'error'
          ? { status: 500, json: { error: 'INTERNAL_ERROR', message: 'Queue history unavailable' } }
          : { json: { executions: scenario === 'empty' ? [] : runs, nextCursor: null } }
      )
    );
    await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${trigger.id}`);
    if (scenario === 'empty') await expect(page.getByTestId('github-event-queue')).toHaveCount(0);
    else
      await expect(page.getByTestId('github-event-queue')).toContainText(
        'GitHub events: 2 waiting now · Retained history: 3 delivered · 3 dropped · 1 unconfirmed'
      );
    if (scenario === 'normal') {
      await expect(page.getByText('Queued until a run finishes')).toBeVisible();
      await expect(page.getByText('Dropped: waiting time expired')).toBeVisible();
      await expect(page.getByText('Dropped: queue was full')).toBeVisible();
      await expect(
        page
          .getByTestId('trigger-run')
          .filter({ hasText: 'Dropped: waiting time expired' })
          .getByRole('link')
      ).toHaveCount(0);
      await expect(
        page.getByTestId('automation-root').getByRole('link', { name: 'Open chat for event 3' })
      ).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/active-session`);
    }
    if (scenario === 'empty')
      await expect(
        page.getByText('Nothing yet. Runs show up here with what happened and a link to the chat.')
      ).toBeVisible();
    if (scenario === 'error')
      await expect(page.getByRole('alert')).toContainText('Could not load runs.');
    await audit(page, `github-trigger-queue-${scenario}`);
    if (scenario === 'normal') {
      await expect(
        page.getByText('May have reached the chat, but SAM could not confirm it')
      ).toBeVisible();
      await expect(page.getByText('Dropped: the target chat is unavailable')).toBeVisible();
      await expect(
        page
          .getByTestId('trigger-run')
          .filter({ hasText: 'the target chat is unavailable' })
          .getByRole('link')
      ).toHaveCount(0);
      await page.goto(`/projects/${PROJECT_ID}/automation/history?item=trigger:${trigger.id}`);
      await expect(
        page.getByRole('link', { name: /Open chat for .*Delivered to the running chat/ })
      ).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/active-session`);
      await audit(page, 'github-trigger-history');
    }
  });
}

test('GitHub queue controls', async ({ page }, info) => {
  test.skip(!['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(info.project.name));
  await setupAutomationMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${TRIGGERS.github.id}/edit`);
  await expect(page.getByRole('group', { name: 'When events overlap' })).toBeVisible();
  await expect(page.getByLabel('Pending event limit')).toHaveValue('50');
  await expect(page.getByLabel('Maximum wait (seconds)')).toHaveValue('86400');
  await audit(page, 'github-trigger-queue-controls-default');
  await page.getByRole('checkbox', { name: /Keep issue and PR follow-ups/ }).check();
  await page.getByLabel('Pending event limit').fill('7');
  await page.getByLabel('Maximum wait (seconds)').fill('120');
  await audit(page, 'github-trigger-queue-controls-enabled');
  await page.getByLabel('Maximum wait (seconds)').fill('0');
  await page.getByTestId('automation-editor-next').click();
  await expect(page.getByRole('alert')).toContainText('positive whole numbers');
  await audit(page, 'github-trigger-queue-controls-invalid');
});
