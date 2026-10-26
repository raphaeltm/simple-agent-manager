import { expect, test } from '@playwright/test';

import { audit } from './automation-audit-helpers';
import { PROJECT_ID, setupAutomationMocks, TRIGGERS } from './automation-fixtures';

for (const scenario of ['normal', 'many-long', 'empty', 'error'] as const) {
  test(`GitHub queue ${scenario}`, async ({ page }, info) => {
    test.skip(!['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(info.project.name));
    await setupAutomationMocks(page);
    const trigger = {
      ...TRIGGERS.github,
      queueStats: { queued: 2, routed: 3, dropped: 1 },
      ...(scenario === 'many-long'
        ? { name: 'Follow up on repository issues and pull requests '.repeat(6) }
        : {}),
    };
    await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}`, (route) =>
      route.fulfill({ json: trigger })
    );
    const statuses = ['waiting', 'routing', 'routed', 'dropped', 'dropped'] as const;
    const runs = Array.from({ length: scenario === 'many-long' ? 35 : 5 }, (_, i) => ({
      id: `event-${i}`,
      triggerId: trigger.id,
      projectId: PROJECT_ID,
      status: statuses[i % 5],
      skipReason: i % 5 === 3 ? 'queue_expired' : i % 5 === 4 ? 'queue_full' : null,
      taskId: null,
      routedTaskId: i % 5 === 2 ? 'active-run' : null,
      routedSessionId: i % 5 === 2 ? 'active-session' : null,
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
    await expect(page.getByLabel('GitHub event queue')).toContainText(
      '2 queued · 3 sent to an existing run · 1 dropped'
    );
    if (scenario === 'normal') {
      await expect(page.getByText('Queued until a run finishes')).toBeVisible();
      await expect(page.getByText('Dropped: waiting time expired')).toBeVisible();
      await expect(page.getByText('Dropped: queue was full')).toBeVisible();
      await expect(
        page.getByTestId('automation-root').getByRole('link', { name: 'Chat' })
      ).toHaveAttribute('href', `/projects/${PROJECT_ID}/tasks/active-run`);
    }
    if (scenario === 'empty')
      await expect(
        page.getByText('Nothing yet. Runs show up here with what happened and a link to the chat.')
      ).toBeVisible();
    if (scenario === 'error')
      await expect(page.getByRole('alert')).toContainText('Could not load runs.');
    await audit(page, `github-trigger-queue-${scenario}`);
  });
}
