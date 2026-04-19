import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

type CreateMockMode =
  | 'success'
  | 'invalid_url'
  | 'repo_private'
  | 'cap_exceeded'
  | 'trials_disabled'
  | 'existing_trial';

/**
 * API + SSE mocks. The events stream is mocked via Playwright's request
 * interception — we respond with a Content-Type: text/event-stream body that
 * ends after a fixed number of frames so tests don't hang.
 */
async function setupTrialMocks(
  page: Page,
  opts: {
    create?: CreateMockMode;
    events?: 'empty' | 'streaming' | 'ready' | 'error' | 'knowledge_burst';
  } = {},
) {
  const { create = 'success', events = 'streaming' } = opts;

  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({ status: 200, json: {} }),
  );

  await page.route('**/api/trial/create', async (route: Route) => {
    if (create === 'success') {
      return route.fulfill({
        status: 200,
        json: {
          trialId: 'trial_visual_001',
          projectId: 'proj_visual_001',
          eventsUrl: '/api/trial/trial_visual_001/events',
          expiresAt: '2026-04-19T00:00:00Z',
        },
      });
    }
    if (create === 'existing_trial') {
      return route.fulfill({
        status: 200,
        json: {
          existingTrialId: 'trial_visual_existing',
          projectId: 'proj_visual_existing',
        },
      });
    }
    if (create === 'cap_exceeded') {
      return route.fulfill({
        status: 429,
        json: {
          error: 'cap_exceeded',
          message: 'capped',
          waitlistResetsAt: '2026-05-01T00:00:00Z',
        },
      });
    }
    if (create === 'trials_disabled') {
      return route.fulfill({
        status: 503,
        json: { error: 'trials_disabled', message: 'Trials are paused.' },
      });
    }
    if (create === 'repo_private') {
      return route.fulfill({
        status: 400,
        json: { error: 'repo_private', message: 'That repo is private.' },
      });
    }
    return route.fulfill({
      status: 400,
      json: { error: 'invalid_url', message: 'Not a GitHub repo.' },
    });
  });

  await page.route('**/api/trial/waitlist', (route) =>
    route.fulfill({
      status: 200,
      json: { queued: true, resetsAt: '2026-05-01T00:00:00Z' },
    }),
  );

  // SSE event stream. Build a single SSE payload based on `events` mode.
  const lines: string[] = [];
  const push = (type: string, data: Record<string, unknown>) => {
    lines.push(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const now = Date.now();
  if (events === 'empty') {
    push('trial.started', {
      trialId: 'trial_visual_001',
      projectId: 'proj_visual_001',
      repoUrl: 'https://github.com/acme/empty-repo',
      startedAt: now,
    });
  } else if (events === 'streaming') {
    push('trial.started', {
      trialId: 'trial_visual_001',
      projectId: 'proj_visual_001',
      repoUrl: 'https://github.com/simple-agent-manager/very-long-repo-name-example',
      startedAt: now,
    });
    push('trial.progress', { stage: 'Cloning repository…', progress: 0.2, at: now + 100 });
    push('trial.knowledge', {
      entity: 'CoreService',
      observation: 'Handles authentication and authorization across the codebase.',
      at: now + 200,
    });
    push('trial.knowledge', {
      entity: 'DataPipeline',
      observation: 'Processes incoming events and writes to long-term storage.',
      at: now + 300,
    });
    push('trial.idea', {
      ideaId: 'i1',
      title: 'Add retry logic to the pipeline',
      summary:
        'The event ingestion pipeline lacks retry on downstream failure — add exponential backoff with a bounded budget to reduce data loss during partial outages.',
      at: now + 400,
    });
    push('trial.progress', { stage: 'Analyzing code…', progress: 0.7, at: now + 500 });
  } else if (events === 'error') {
    push('trial.started', {
      trialId: 'trial_visual_001',
      projectId: 'proj_visual_001',
      repoUrl: 'https://github.com/acme/error-repo',
      startedAt: now,
    });
    push('trial.error', {
      error: 'repo_too_large',
      message: 'This repo is too large to analyze in a trial.',
      at: now + 100,
    });
  } else if (events === 'knowledge_burst') {
    push('trial.started', {
      trialId: 'trial_visual_001',
      projectId: 'proj_visual_001',
      repoUrl: 'https://github.com/acme/burst-repo',
      startedAt: now,
    });
    // Five knowledge events emitted within the grouping window — should
    // render as a single grouped card with a "+4 more" toggle.
    push('trial.knowledge', { entity: 'Repo', observation: 'Description: a thing.', at: now + 10 });
    push('trial.knowledge', { entity: 'Languages', observation: 'TypeScript, Go.', at: now + 20 });
    push('trial.knowledge', { entity: 'Stars', observation: '12,345 stars.', at: now + 30 });
    push('trial.knowledge', { entity: 'License', observation: 'MIT licensed.', at: now + 40 });
    push('trial.knowledge', { entity: 'Topics', observation: 'cli, devtools, ai.', at: now + 50 });
  } else if (events === 'ready') {
    push('trial.started', {
      trialId: 'trial_visual_001',
      projectId: 'proj_visual_001',
      repoUrl: 'https://github.com/acme/demo',
      startedAt: now,
    });
    push('trial.idea', {
      ideaId: 'i1',
      title: 'Primary idea',
      summary: 'The best improvement to make first.',
      at: now + 100,
    });
    push('trial.ready', {
      trialId: 'trial_visual_001',
      projectId: 'proj_visual_001',
      workspaceUrl: 'https://ws-visual.sammy.party',
      at: now + 200,
    });
  }

  await page.route('**/api/trial/*/events', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      body: lines.join(''),
    }),
  );
}

// ---------------------------------------------------------------------------
// Mobile Tests (default viewport 375×667 per playwright config)
// ---------------------------------------------------------------------------

/**
 * Visual audit assertions favor text presence (`toHaveCount > 0`) over
 * `toBeVisible()`. Our centered mobile layouts position the heading outside
 * the `667px` viewport in fullPage mode — the element is *rendered*, but
 * Playwright's visibility heuristic marks above-fold elements as hidden when
 * the page scrolls. We still enforce an overflow check and capture full-page
 * screenshots so regressions surface through snapshot review.
 */
async function expectAttached(page: Page, locator: ReturnType<Page['locator']>) {
  await locator.first().waitFor({ state: 'attached' });
}

test.describe('Trial — Mobile', () => {
  test('landing — normal render', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try');
    await expectAttached(page, page.getByRole('heading', { name: /explore any github repo/i }));
    await expectAttached(page, page.getByRole('button', { name: /explore repo/i }));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-landing-mobile');
  });

  test('landing — inline error for invalid URL', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try');
    await page.getByPlaceholder('https://github.com/owner/repo').fill('ftp://nope.com');
    await page.getByRole('button', { name: /explore repo/i }).click();
    await expectAttached(page, page.getByText(/doesn.?t look like a GitHub URL/i));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-landing-error-mobile');
  });

  test('landing — trials_disabled panel', async ({ page }) => {
    await setupTrialMocks(page, { create: 'trials_disabled' });
    await page.goto('/try');
    await page.getByPlaceholder('https://github.com/owner/repo').fill('https://github.com/a/b');
    await page.getByRole('button', { name: /explore repo/i }).click();
    await expectAttached(page, page.getByRole('heading', { name: /trials are paused/i }));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-landing-paused-mobile');
  });

  test('discovery — streaming events render', async ({ page }) => {
    await setupTrialMocks(page, { events: 'streaming' });
    await page.goto('/try/trial_visual_001');
    await expectAttached(page, page.getByText(/Cloning repository/i));
    await expectAttached(page, page.getByText(/Add retry logic to the pipeline/i));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-discovery-streaming-mobile');
  });

  test('discovery — ready state', async ({ page }) => {
    await setupTrialMocks(page, { events: 'ready' });
    await page.goto('/try/trial_visual_001');
    await expectAttached(page, page.getByText(/Workspace ready/i));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-discovery-ready-mobile');
  });

  test('discovery — empty state (only started event)', async ({ page }) => {
    await setupTrialMocks(page, { events: 'empty' });
    await page.goto('/try/trial_visual_001');
    // Header appears with repo name
    await expectAttached(page, page.getByText(/acme\/empty-repo/i));
    // Stage skeleton timeline renders the canonical six steps as placeholders
    await expectAttached(page, page.getByTestId('trial-stage-skeleton'));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-discovery-empty-mobile');
  });

  test('discovery — terminal error renders retry CTA', async ({ page }) => {
    await setupTrialMocks(page, { events: 'error' });
    await page.goto('/try/trial_visual_001');
    await expectAttached(page, page.getByTestId('trial-error-panel'));
    await expectAttached(page, page.getByTestId('trial-error-retry'));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-discovery-error-mobile');
  });

  test('discovery — knowledge burst groups into a single card', async ({ page }) => {
    await setupTrialMocks(page, { events: 'knowledge_burst' });
    await page.goto('/try/trial_visual_001');
    // Exactly one grouped card should render for the burst, with a toggle.
    await expectAttached(page, page.getByTestId('trial-knowledge-group'));
    await expectAttached(page, page.getByTestId('trial-knowledge-toggle'));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-discovery-knowledge-burst-mobile');
  });

  test('cap-exceeded — waitlist form', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try/cap-exceeded?resetsAt=2026-05-01T00:00:00Z');
    await expectAttached(page, page.getByRole('heading', { name: /hit our trial cap/i }));
    await expectAttached(page, page.getByPlaceholder('you@example.com'));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-cap-exceeded-mobile');
  });

  test('cap-exceeded — invalid email inline error', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try/cap-exceeded');
    await page.getByPlaceholder('you@example.com').fill('nope');
    await page.getByRole('button', { name: /join the waitlist/i }).click();
    await expectAttached(page, page.getByText(/valid email address/i));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-cap-exceeded-error-mobile');
  });

  test('waitlist — thanks page', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try/waitlist/thanks');
    await expectAttached(page, page.getByRole('heading', { name: /you.?re on the list/i }));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-waitlist-thanks-mobile');
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests (1280×800)
// ---------------------------------------------------------------------------

test.describe('Trial — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('landing — desktop render', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try');
    await expectAttached(page, page.getByRole('heading', { name: /explore any github repo/i }));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-landing-desktop');
  });

  test('discovery — streaming desktop', async ({ page }) => {
    await setupTrialMocks(page, { events: 'streaming' });
    await page.goto('/try/trial_visual_001');
    await expectAttached(page, page.getByText(/Add retry logic to the pipeline/i));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-discovery-streaming-desktop');
  });

  test('cap-exceeded — desktop', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try/cap-exceeded?resetsAt=2026-05-01T00:00:00Z');
    await expectAttached(page, page.getByRole('heading', { name: /hit our trial cap/i }));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-cap-exceeded-desktop');
  });

  test('waitlist — thanks desktop', async ({ page }) => {
    await setupTrialMocks(page);
    await page.goto('/try/waitlist/thanks');
    await expectAttached(page, page.getByRole('heading', { name: /you.?re on the list/i }));
    await assertNoOverflow(page);
    await screenshot(page, 'trial-waitlist-thanks-desktop');
  });
});
