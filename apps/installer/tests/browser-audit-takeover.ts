import { expect, type Page } from '@playwright/test';

/**
 * The idle panel of a service that takes over an existing SAM: the real service code with a
 * takeover manifest and the longest names a deployment may have. Leaves the service as it found
 * it, with no manifest stored, so the new-installation flow that follows starts clean.
 */
export async function auditTakeoverPanel(
  page: Page,
  target: string,
  env: Record<string, unknown>,
  storage: Map<unknown, unknown>,
  captureState: (page: Page, name: string) => Promise<number>
) {
  const installation = env.INSTALLATION_CONFIG as string;
  env.INSTALLATION_CONFIG = JSON.stringify({
    ...JSON.parse(installation),
    baseDomain: `${'very-long-subdomain-label-'.repeat(2)}sam.example.com`,
    ownerEmail: `${'owner.with.a.very.long.mailbox.name.'.repeat(3)}admin@example.com`,
    adoption: {
      prefix: `sam-${'prefix-'.repeat(5)}x`,
      environment: `production-${'environment-'.repeat(4)}x`,
      stateBucket: `team-${'deploy-state-'.repeat(4)}bucket`,
    },
  });
  await page.goto(target);
  await expect(page.locator('.deployment-status strong')).toHaveText('Ready to take over');
  await expect(page.getByText('the build deploys the approved source over it')).toBeVisible();
  // The approval states what is checked, and the settings the deploy applies outside that check.
  await expect(
    page.getByText(
      'The deploy also applies settings the source needs: the upload rule on its storage bucket, and an AI Gateway if your account has none.'
    )
  ).toBeVisible();
  await expect(page.getByText('nothing else would change')).toHaveCount(0);
  // The takeover is approved here and nowhere else: never pre-checked, disabled until ticked.
  const confirm = page.locator('input[name="confirmed"]');
  const takeOver = page.getByRole('button', { name: 'Take over SAM', exact: true });
  await expect(confirm).not.toBeChecked();
  await expect(takeOver).toBeDisabled();
  await confirm.check();
  await expect(takeOver).toBeEnabled();
  await confirm.uncheck();
  await page.locator('summary', { hasText: 'Installation details' }).click();
  // Long names must wrap inside the card, which a page-level overflow check cannot see.
  const inside = await page.locator('section.deployment').evaluate((card) => {
    const box = card.getBoundingClientRect();
    return [...card.querySelectorAll('h1, p, code, label')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1;
    });
  });
  expect(inside).toBe(true);
  let count = await captureState(page, 'maintenance-takeover-ready');
  // The finished takeover, with the same long names: it confirms only what a takeover keeps and
  // repeats what it reset.
  const config = JSON.parse(env.INSTALLATION_CONFIG as string) as { sourceCommit: string };
  storage.set('installation', {
    config,
    sourceMode: 'upstream',
    createdAt: Date.now(),
    lastSuccessfulCommit: config.sourceCommit,
  });
  await page.goto(target);
  await expect(page.getByRole('heading', { name: 'Takeover complete' })).toBeVisible();
  await expect(page.locator('.ready-lede')).toHaveText(
    'This service now builds and updates the SAM that was already running here. Its data, keys and users are as they were. The settings it ran with were kept, except container limits and web app build settings that your old deployment set in GitHub: those are now SAM defaults.'
  );
  const completeInside = await page.locator('section.deployment').evaluate((card) => {
    const box = card.getBoundingClientRect();
    return [...card.querySelectorAll('h1, p, a')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1;
    });
  });
  expect(completeInside).toBe(true);
  count += await captureState(page, 'maintenance-takeover-complete');
  env.INSTALLATION_CONFIG = installation;
  storage.delete('installation');
  return count;
}
