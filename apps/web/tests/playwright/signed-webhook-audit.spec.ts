/**
 * Visual and layout audit for signed webhook automations (Slack and HMAC): the "who is calling?"
 * step of the create flow and the connect panel on the automation's page, at 375×667 and
 * 1280×800. Mock data covers every setup state, a long name and URL, special characters, a
 * refusal with a long hint, an empty and a 36-row call log, a read-only viewer and a refused
 * secret. Every capture is checked for overflow (including clipped overflow) and small targets.
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';

import { audit } from './automation-audit-helpers';
import {
  DAY,
  iso,
  LONG_NAME,
  PROJECT_ID,
  setupAutomationMocks,
  SPECIAL_TEXT,
  TRIGGERS,
  VIEWER_ID,
} from './automation-fixtures';

const BASE = `/projects/${PROJECT_ID}/automation`;
const TRIGGER_ID = 'trg-slack';
const ENDPOINT = `https://api.example.test/api/webhooks/in/${TRIGGER_ID}`;

type SetupState = 'needs_secret' | 'waiting_for_first_request' | 'receiving' | 'rejecting';

interface SignedOptions {
  state: SetupState;
  scheme?: 'slack_v0' | 'hmac_sha256_body';
  name?: string;
  endpointUrl?: string;
  waiting?: number;
  hint?: string;
  calls?: unknown[];
  /** Status the secret save answers with; 200 flips the automation to waiting. */
  secretStatus?: 200 | 400;
}

function signedTrigger(options: SignedOptions) {
  const secretSet = options.state !== 'needs_secret';
  const slack = (options.scheme ?? 'slack_v0') === 'slack_v0';
  return {
    ...TRIGGERS.webhook,
    id: TRIGGER_ID,
    name: options.name ?? 'Answer Slack mentions',
    credentialAttribution: undefined,
    promptTemplate: 'Someone mentioned you in Slack: {{webhook.body.event.text}}',
    webhookConfig: {
      sourceLabel: null,
      filterMode: 'all',
      filters: slack
        ? [
            { path: 'event.type', operator: 'equals', value: 'app_mention' },
            { path: 'event.bot_id', operator: 'notExists' },
          ]
        : [{ path: 'action', operator: 'equals', value: 'opened' }],
      includedHeaders: slack ? [] : ['x-github-event'],
      verification: slack
        ? { scheme: 'slack_v0' }
        : {
            scheme: 'hmac_sha256_body',
            header: 'x-a-very-long-vendor-specific-signature-header-name-sha256-v2-production',
          },
      eventId: slack
        ? { path: 'event_id' }
        : { header: 'x-a-very-long-vendor-specific-delivery-identifier-header-name' },
      endpointUrl: options.endpointUrl ?? ENDPOINT,
      tokenLastFour: null,
      tokenCreatedAt: null,
      tokenRotatedAt: null,
      signingSecret: secretSet
        ? { set: true, setAt: iso(-2 * DAY), setBy: 'owner-user' }
        : { set: false, setAt: null, setBy: null },
      setup: {
        state: options.state,
        secretEntryUrl: `https://app.example.test${BASE}/trigger/${TRIGGER_ID}#signing-secret`,
        lastEventAt: options.state === 'receiving' ? iso(-2 * 60_000) : null,
        waiting: options.waiting ?? 0,
        lastRejection:
          options.state === 'rejecting'
            ? {
                reason: 'invalid_signature',
                at: iso(-60_000),
                hint:
                  options.hint ??
                  "The signature did not match. Check that the saved signing secret is the sender's current one and that nothing rewrites the request on its way to SAM.",
              }
            : null,
      },
    },
  };
}

const call = (
  index: number,
  outcome: string,
  errorCode: string | null = null,
  executionId: string | null = null
) => ({
  id: `call-${index}`,
  triggerId: TRIGGER_ID,
  outcome,
  httpStatus: outcome === 'rejected' ? 401 : outcome === 'queue_full' ? 429 : 202,
  bodyBytes: 300 + index * 17,
  executionId,
  errorCode,
  receivedAt: iso(-index * 7 * 60_000),
  processedAt: iso(-index * 7 * 60_000),
});

/** One of every kind of call, then enough repeats to make a long list. */
const MANY_CALLS = [
  call(1, 'queued', null, 'exec-waiting-1'),
  call(2, 'queued', null, 'exec-waiting-2'),
  call(3, 'accepted', null, 'exec-started'),
  call(4, 'duplicate'),
  call(5, 'filtered'),
  call(6, 'challenge'),
  call(7, 'rejected', 'invalid_signature'),
  call(8, 'rejected', 'stale_timestamp'),
  call(9, 'rejected', 'missing_event_id'),
  call(10, 'rejected', 'not_configured'),
  call(11, 'queue_full', 'queue_full'),
  call(12, 'dropped', 'queue_expired', 'exec-dropped'),
  call(13, 'inactive', 'paused'),
  ...Array.from({ length: 23 }, (_, index) =>
    call(14 + index, index % 3 === 0 ? 'duplicate' : 'accepted', null, `exec-${index}`)
  ),
];

/** Serves one signed automation on top of the shared Automation mocks. */
async function mockSigned(page: Page, options: SignedOptions, userId?: string) {
  await setupAutomationMocks(page, userId ? { userId } : {});
  let current = signedTrigger(options);
  const saved: string[] = [];
  await page.route(
    `**/api/projects/${PROJECT_ID}/triggers/${TRIGGER_ID}**`,
    async (route: Route) => {
      const url = new URL(route.request().url());
      const sub = url.pathname.split(`/triggers/${TRIGGER_ID}`)[1] ?? '';
      const respond = (status: number, body: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (sub === '') return respond(200, current);
      if (sub === '/webhook/deliveries')
        return respond(200, { deliveries: options.calls ?? [], nextCursor: null });
      if (sub === '/webhook/signing-secret') {
        if (options.secretStatus === 400)
          return respond(400, {
            error: 'BAD_REQUEST',
            message:
              "That looks like a Slack token. Paste the app's Signing Secret from Basic Information, App Credentials.",
          });
        saved.push(String(route.request().postDataJSON()?.secret));
        current = signedTrigger({ ...options, state: 'waiting_for_first_request' });
        return respond(200, { signingSecret: current.webhookConfig.signingSecret });
      }
      return route.fallback();
    }
  );
  return { saved };
}

function onlyOn(names: string[]) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(!names.includes(testInfo.project.name), 'audited on a phone and a desktop');
  };
}
test.beforeEach(onlyOn(['iPhone SE (375x667)', 'Desktop (1280x800)']));

const status = (page: Page) => page.getByTestId('webhook-setup-status');
const connection = (page: Page) => page.getByRole('region', { name: 'Webhook connection' });
const top = async (page: Page, name: string) =>
  (await page.getByRole('region', { name }).boundingBox())?.y ?? Number.NaN;

test.describe('Signed webhook automation page', () => {
  test('needs a secret: the connect panel leads the page and saving flips the status', async ({
    page,
  }) => {
    const { saved } = await mockSigned(page, { state: 'needs_secret' });
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}`);
    await expect(status(page)).toHaveText(/Paste the signing secret to continue/);
    await expect(page.getByTestId('webhook-url')).toHaveText(ENDPOINT);
    await expect(page.getByText('Get a new token')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Calls received' })).toBeVisible();
    // Finishing setup is the first thing on the page at every width, above the call log.
    expect(await top(page, 'Webhook connection')).toBeLessThan(await top(page, 'Calls received'));
    // The panel never spills past the screen.
    const box = await connection(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    await audit(page, 'signed-webhook-needs-secret');

    const input = page.getByLabel('Signing secret');
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill('a-signing-secret-typed-on-the-page');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(status(page)).toHaveText(/Waiting for the first request/);
    await expect(page.getByTestId('signing-secret-saved')).toBeVisible();
    await expect(page.getByLabel('Signing secret')).toHaveCount(0);
    expect(saved).toEqual(['a-signing-secret-typed-on-the-page']);
    expect(await page.content()).not.toContain('a-signing-secret-typed-on-the-page');
    await audit(page, 'signed-webhook-waiting');
  });

  test('refused requests: long name, long hint, every kind of call in a long list', async ({
    page,
  }) => {
    await mockSigned(page, {
      state: 'rejecting',
      name: `Slack ${LONG_NAME} ${SPECIAL_TEXT}`,
      endpointUrl: `https://api.example.test/api/webhooks/in/${'01M75T87NC15D23HG4ZT73GZRY'.repeat(3)}`,
      hint: `The signature did not match. ${'Check that the saved signing secret is the sender’s current one. '.repeat(6)}https://example.test/a/very/long/unbroken/path/${'segment-'.repeat(20)}`,
      calls: MANY_CALLS,
    });
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}`);
    await expect(status(page)).toHaveAttribute('data-state', 'rejecting');
    await expect(status(page)).toContainText(
      'Requests are being refused: the signature doesn’t match'
    );
    const calls = page.getByRole('region', { name: 'Calls received' });
    for (const text of [
      'Waiting for a free run',
      'The service checked this address',
      'Refused: the signature did not match',
      'Refused: the request was too old',
      'Refused: the event had no ID',
      'Refused: no signing secret is saved yet',
      'Refused: too many events were already waiting',
      'Dropped: waited too long for a free run',
    ]) {
      await expect(calls.getByText(text).first()).toBeVisible();
    }
    expect(await calls.locator('li').count()).toBe(MANY_CALLS.length);
    expect(
      await page.evaluate(() => (window as { __automationXss?: number }).__automationXss)
    ).toBe(undefined);
    await audit(page, 'signed-webhook-rejecting-long');

    // Replacing the secret opens an empty field in place.
    await page.getByRole('button', { name: 'Replace secret' }).click();
    await expect(page.getByLabel('Signing secret')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await audit(page, 'signed-webhook-replace-secret');
  });

  test('receiving with events waiting: the panel moves below the page content', async ({
    page,
  }) => {
    await mockSigned(page, { state: 'receiving', waiting: 12, calls: MANY_CALLS.slice(0, 5) });
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}`);
    // The fixture clock is fixed at load, so the age grows with the run.
    await expect(status(page)).toContainText(/Receiving · last event \d+ min/);
    await expect(status(page)).toContainText('12 waiting for a free run');
    await expect(page.getByText(/Create a Slack app/)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Calls received' })).toBeVisible();
    const viewport = page.viewportSize();
    // Polled: the runs and the call log load separately and move things as they arrive.
    await expect
      .poll(async () => {
        const panel = await connection(page).boundingBox();
        const log = await page.getByRole('region', { name: 'Calls received' }).boundingBox();
        if (!panel || !log) return 'not laid out';
        if (viewport!.width >= 1024)
          // Desktop: in the side column, to the right of the call log.
          return panel.x >= log.x + log.width - 1 ? 'beside' : 'not beside';
        // Phone: after the call log, so a working automation leads with its runs.
        return panel.y > log.y ? 'below' : 'not below';
      })
      .toBe(viewport!.width >= 1024 ? 'beside' : 'below');
    await audit(page, 'signed-webhook-receiving');
  });

  test('generic signed service: long header names wrap, empty call log', async ({ page }) => {
    await mockSigned(page, {
      state: 'waiting_for_first_request',
      scheme: 'hmac_sha256_body',
      name: 'G',
      calls: [],
    });
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}`);
    await expect(status(page)).toHaveText(/Waiting for the first request/);
    await expect(connection(page)).toContainText(
      'x-a-very-long-vendor-specific-signature-header-name-sha256-v2-production'
    );
    await expect(page.getByText('No calls yet.')).toBeVisible();
    await expect(page.getByText(/reply in Slack/)).toHaveCount(0);
    await audit(page, 'signed-webhook-generic-empty');
  });

  test('a refused secret says why and keeps the field', async ({ page }) => {
    await mockSigned(page, { state: 'needs_secret', secretStatus: 400 });
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}`);
    await page.getByLabel('Signing secret').fill('not-the-signing-secret');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText(/That looks like a Slack token/).first()).toBeVisible();
    await expect(page.getByLabel('Signing secret')).toBeVisible();
    await expect(status(page)).toHaveText(/Paste the signing secret to continue/);
    await audit(page, 'signed-webhook-secret-refused');
  });

  test('a viewer sees the connection but cannot save a secret', async ({ page }) => {
    await mockSigned(page, { state: 'needs_secret' }, VIEWER_ID);
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}`);
    await expect(
      page.getByText('Not saved yet. Someone who can edit this automation has to save it.')
    ).toBeVisible();
    await expect(page.getByLabel('Signing secret')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save secret' })).toHaveCount(0);
    await audit(page, 'signed-webhook-viewer');
  });

  test('opening the secret link brings the secret field into view', async ({ page }) => {
    await mockSigned(page, { state: 'needs_secret', calls: MANY_CALLS });
    await page.goto(`${BASE}/trigger/${TRIGGER_ID}#signing-secret`);
    const input = page.getByLabel('Signing secret');
    await expect(input).toBeFocused();
    await expect(input).toBeInViewport();
  });
});

test.describe('Create flow: who is calling?', () => {
  test('Slack fills in its conditions; the choices fit a phone', async ({ page }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/new?start=webhook`);
    await expect(page.getByRole('radiogroup', { name: 'Who is calling?' })).toBeVisible();
    await audit(page, 'signed-webhook-editor-caller');
    await page.getByRole('radio', { name: /^Slack/ }).click();
    await expect(page.getByLabel('Filter 1 path')).toHaveValue('event.type');
    await expect(page.getByLabel('Filter 2 operator')).toHaveValue('notExists');
    await expect(page.getByText(/four steps/)).toBeVisible();
    await audit(page, 'signed-webhook-editor-slack');
  });

  test('a signed service asks for its header and event ID, and says what is missing', async ({
    page,
  }) => {
    await setupAutomationMocks(page);
    await page.goto(`${BASE}/new?start=webhook`);
    await page.getByRole('radio', { name: /Another service that signs/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(/Enter the header that carries the signature/)).toBeVisible();
    await expect(page.getByText(/Enter the header that carries the event ID/)).toBeVisible();
    await audit(page, 'signed-webhook-editor-signed-errors');
    await page.getByLabel('Signature header').fill('x-hub-signature-256');
    // Editing a field clears the message about its old value.
    await expect(page.getByText(/Enter the header that carries the signature/)).toHaveCount(0);
    await page.getByLabel('Event ID location').selectOption('path');
    await page.getByLabel('Where is the event ID?').fill(`event.${'deeply.nested.'.repeat(8)}id`);
    await audit(page, 'signed-webhook-editor-signed-filled');
  });
});
