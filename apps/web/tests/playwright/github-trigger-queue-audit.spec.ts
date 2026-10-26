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
          ? { queued: 0, routed: 0, dropped: 0, unconfirmed: 0, retentionDays: 90 }
          : { queued: 2, routed: 3, dropped: 3, unconfirmed: 1, retentionDays: 90 },
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
      'queued',
    ] as const;
    const runs = Array.from({ length: scenario === 'many-long' ? 35 : 8 }, (_, i) => ({
      id: `event-${i}`,
      triggerId: trigger.id,
      projectId: PROJECT_ID,
      status: statuses[i % 8],
      skipReason:
        i % 8 === 3
          ? 'queue_expired'
          : i % 8 === 4
            ? 'queue_full'
            : i % 8 === 5
              ? 'delivery_uncertain'
              : i % 8 === 6
                ? 'target_unavailable'
                : null,
      taskId: null,
      queueExpiresAt: i % 8 === 7 ? new Date(Date.now() + 60000).toISOString() : null,
      routedTaskId: [1, 2, 3, 5, 6].includes(i % 8) ? 'active-run' : null,
      subjectKey: 'github:42:7',
      routedSessionId: [1, 2, 5].includes(i % 8) ? 'active-session' : null,
      eventType: 'github.issue_comment.created',
      renderedPrompt: 'Follow up comment',
      errorMessage: null,
      scheduledAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      sequenceNumber: i % 8 === 6 ? 0 : i + 1,
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
        'GitHub events: 2 waiting now · History (up to 90 days): 3 delivered · 3 dropped · 1 unconfirmed'
      );
    if (scenario === 'normal') {
      await expect(page.getByText(/\bEvent 0\b/)).toHaveCount(0);
      await expect(
        page.getByText(
          'Continue this automation’s active chat for the issue or PR, or start a new one with'
        )
      ).toBeVisible();
      await expect(page.getByText('Queued until a run finishes')).toBeVisible();
      await expect(page.getByText('Dropped: waiting time expired')).toBeVisible();
      await expect(page.getByText('Dropped: queue was full')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Clear stuck runs' })).toHaveCount(0);
      await expect(
        page.getByTestId('trigger-run').filter({ hasText: 'Waiting to start' }).getByRole('button')
      ).toHaveCount(0);
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
      await expect(page.getByText(/\bEvent 0\b/)).toHaveCount(0);
      await expect(
        page.getByText(
          'Continue this automation’s active chat for the issue or PR, or start a new one with'
        )
      ).toBeVisible();
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
      await page.getByText('Advanced', { exact: true }).click();
      await expect(page.getByText('Reuse this automation’s issue or PR chat')).toBeVisible();
      await expect(page.getByText('24 hours', { exact: true })).toBeVisible();
      await audit(page, 'github-trigger-queue-settings');
      await page.goto(`/projects/${PROJECT_ID}/automation/history?item=trigger:${trigger.id}`);
      await expect(
        page.getByRole('link', { name: /Open chat for .*Delivered to the running chat/ })
      ).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/active-session`);
      await audit(page, 'github-trigger-history');
      await page.route(`**/api/projects/${PROJECT_ID}/triggers`, (route) =>
        route.fulfill({ json: { triggers: [trigger] } })
      );
      await page.goto(`/projects/${PROJECT_ID}/automation`);
      if (info.project.name === 'Desktop (1280x800)')
        await expect(
          page.getByText(/Continue its issue or PR chat, or start one with/)
        ).toBeVisible();
      await audit(page, 'github-trigger-affinity-overview');
    }
  });
}

test('GitHub queue controls', async ({ page }, info) => {
  test.skip(!['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(info.project.name));
  await setupAutomationMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${TRIGGERS.github.id}/edit`);
  await page.getByTestId('automation-editor-next').click();
  await page.getByTestId('automation-editor-next').click();
  await page.getByText('Advanced options', { exact: true }).click();
  await expect(page.getByRole('group', { name: 'When GitHub events overlap' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /One run at a time/ })).toBeVisible();
  await expect(page.getByLabel('Pending event limit')).toHaveValue('50');
  await expect(page.getByLabel('Maximum wait (hours)')).toHaveValue('24');
  await audit(page, 'github-trigger-queue-controls-default');
  await page.getByRole('checkbox', { name: /Keep issue and PR follow-ups/ }).check();
  await expect(page.getByTestId('automation-sentence')).toContainText(
    'continue this automation’s active chat'
  );
  await page.getByLabel('Pending event limit').fill('7');
  await page.getByLabel('Maximum wait (hours)').fill('0.5');
  await audit(page, 'github-trigger-queue-controls-enabled');
  await page.getByLabel('Maximum wait (hours)').fill('0');
  await page.getByTestId('automation-editor-next').click();
  await expect(page.getByRole('alert')).toContainText('at least one second');
  await expect(page.getByLabel('Maximum wait (hours)')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Maximum wait (hours)')).toHaveAttribute('aria-describedby', /.+/);
  await audit(page, 'github-trigger-queue-controls-invalid');
  await page.getByLabel('Maximum wait (hours)').fill('0.5');
  await expect(page.getByLabel('Maximum wait (hours)')).toBeVisible();
  await expect(page.getByLabel('Maximum wait (hours)')).toHaveValue('0.5');
});

test('GitHub push never promises issue or PR affinity', async ({ page }) => {
  await setupAutomationMocks(page);
  const trigger = {
    ...TRIGGERS.github,
    name: 'Handle pushes',
    promptTemplate: 'Review {{github.branch}} at {{github.sha}}.',
    triggerCount: 0,
    lastTriggeredAt: null,
    githubConfig: {
      ...TRIGGERS.github.githubConfig,
      eventType: 'push',
      filters: { branches: ['main'] },
      subjectAffinity: true,
    },
  };
  await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}`, (route) =>
    route.fulfill({ json: trigger })
  );
  await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}/executions*`, (route) =>
    route.fulfill({ json: { executions: [], nextCursor: null } })
  );
  await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${trigger.id}`);
  await expect(page.getByText('Start a new chat with')).toBeVisible();
  await expect(
    page.getByText('Events can start a chat or wait for capacity.', { exact: true })
  ).toBeVisible();
  await page.getByText('Advanced', { exact: true }).click();
  await expect(page.getByText('Not applicable to push events', { exact: true })).toBeVisible();
  await audit(page, 'github-trigger-push-detail');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByTestId('automation-editor-next').click();
  await page.getByTestId('automation-editor-next').click();
  await expect(page.getByTestId('automation-sentence')).toContainText('start a new chat with');
  await expect(page.getByTestId('automation-sentence')).not.toContainText('active chat');
  await page.getByText('Advanced options', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Keep issue and PR follow-ups/ })).toHaveCount(0);
  await audit(page, 'github-trigger-push-review');
});

for (const source of ['github', 'webhook', 'schedule'] as const) {
  test(`${source} cleanup copy and run metadata stay scoped`, async ({ page }) => {
    await setupAutomationMocks(page);
    const trigger = source === 'schedule' ? TRIGGERS.morning : TRIGGERS[source];
    await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}/executions*`, (route) =>
      route.fulfill({
        json: {
          executions: [
            {
              id: 'legacy-startup',
              triggerId: trigger.id,
              projectId: PROJECT_ID,
              status: 'queued',
              taskId: null,
              queueExpiresAt: null,
              sequenceNumber: 0,
              subjectKey: null,
              eventType: source,
              scheduledAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              startedAt: null,
              completedAt: null,
            },
          ],
          nextCursor: null,
        },
      })
    );
    await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${trigger.id}`);
    await expect(page.getByText(/\bEvent 0\b/)).toHaveCount(0);
    if (source === 'github')
      await expect(
        page.getByText('Events can start a chat or wait for capacity.', { exact: true })
      ).toBeVisible();
    else await expect(page.getByTestId('trigger-run')).not.toContainText('Event');
    await page.getByRole('button', { name: 'Clear stuck runs', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear stuck runs?', exact: true });
    await expect(dialog).toContainText('Chats already running are not touched.');
    if (source === 'github')
      await expect(dialog).toContainText('GitHub events waiting their turn are kept.');
    else await expect(dialog).not.toContainText('GitHub');
    await audit(page, `github-trigger-cleanup-${source}`);
  });
}

for (const source of ['morning', 'webhook'] as const) {
  test(`effective concurrency for ${source}`, async ({ page }, info) => {
    test.skip(!['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(info.project.name));
    await setupAutomationMocks(page);
    const trigger = { ...TRIGGERS[source], skipIfRunning: true, maxConcurrent: 3 };
    await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}`, (route) =>
      route.fulfill({ json: trigger })
    );
    await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${trigger.id}`);
    await page.getByText('Advanced', { exact: true }).click();
    await expect(page.getByText('Most runs at once', { exact: true }).locator('..')).toContainText(
      '1'
    );
    await audit(page, `effective-concurrency-${source}`);
  });
}
