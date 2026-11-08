/**
 * First-run setup wizard and email sign-in: every step at each viewport project, with long
 * values, the error paths, and the request each primary action sends.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

const LONG_OWNER =
  'the-administrator-with-a-very-long-mailbox-name+sam-installs@subdomain.example-company.co.uk';

const PLATFORM_STATUS = {
  setupCompleted: false,
  setupForced: false,
  integrations: {},
  feedbackProject: { configured: false, projectId: null, source: null },
};

const AGENT_EMAIL_PLAN = {
  state: 'needs_consent',
  domain: 'agents.sam2.party',
  mainDomain: 'sam2.party',
  mainDomainChanges: [
    {
      type: 'TXT',
      name: 'sam2.party',
      content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
      change: 'add',
    },
    { type: 'TXT', name: 'cf2024-1._domainkey.sam2.party', content: null, change: 'add' },
  ],
  zoneChanges: [
    {
      setting: 'subaddressing',
      description:
        'Turn on subaddressing for the zone, so agent+key@ addresses reach their trigger.',
      allowed: false,
    },
  ],
  consentToken: 'consent-token-1',
  reason:
    'Cloudflare adds its email records to sam2.party the first time the zone uses Email Routing.',
};

interface MockOptions {
  completed?: boolean;
  emailSignIn?: boolean;
  ownerEmail?: string | null;
  agentEmail?: typeof AGENT_EMAIL_PLAN | null;
  verifyFails?: boolean;
  agentEmailError?: string | null;
  oauthProviders?: boolean;
}

interface Captured {
  complete: Array<Record<string, unknown>>;
  sendCode: Array<Record<string, unknown>>;
  signIn: Array<Record<string, unknown>>;
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(page: Page, options: MockOptions = {}): Promise<Captured> {
  const captured: Captured = { complete: [], sendCode: [], signIn: [] };
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = () => JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;

    if (path === '/api/auth/get-session') return json(route, 200, null);
    if (path === '/api/config/login-providers') {
      const oauth = options.oauthProviders ?? false;
      return json(route, 200, { github: oauth, google: oauth, gitlab: false, email: true });
    }
    if (path === '/api/setup/status') {
      if (options.completed) {
        return json(route, 410, {
          error: 'SETUP_CLOSED',
          message: 'First-run setup has already been completed',
        });
      }
      return json(route, 200, {
        completed: false,
        open: true,
        forced: false,
        tokenConfigured: true,
      });
    }
    if (path === '/api/setup/verify') {
      if (options.verifyFails) {
        return json(route, 401, { error: 'UNAUTHORIZED', message: 'Invalid setup token' });
      }
      return json(route, 200, {
        ok: true,
        status: PLATFORM_STATUS,
        signIn: {
          email: options.emailSignIn ?? true,
          ownerEmail: options.ownerEmail === undefined ? 'owner@sam2.party' : options.ownerEmail,
        },
        agentEmail: options.agentEmail === undefined ? AGENT_EMAIL_PLAN : options.agentEmail,
      });
    }
    if (path === '/api/setup/complete') {
      const payload = body();
      captured.complete.push(payload);
      return json(route, 200, {
        completed: true,
        status: PLATFORM_STATUS,
        agentEmail: payload.agentEmail
          ? options.agentEmailError
            ? { plan: null, error: options.agentEmailError }
            : { plan: { ...AGENT_EMAIL_PLAN, state: 'on' }, error: null }
          : null,
      });
    }
    if (path === '/api/auth/email-otp/send-verification-otp') {
      captured.sendCode.push(body());
      return json(route, 200, { success: true });
    }
    if (path === '/api/auth/sign-in/email-otp') {
      captured.signIn.push(body());
      return json(route, 400, { code: 'INVALID_OTP', message: 'Invalid OTP' });
    }
    return json(route, 200, {});
  });
  return captured;
}

test.describe('First-run setup wizard', () => {
  test('welcome step with the token carried by the installer link', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/setup#token=installer-setup-token');
    await expect(page.getByRole('heading', { name: 'Welcome to your SAM' })).toBeVisible();
    await expect(page.getByText('Setup token filled in from your installer')).toBeVisible();
    // The step indicator appears once the token is checked and the step count is known.
    await expect(page.getByRole('list', { name: 'Setup steps' })).toHaveCount(0);
    // The token never stays in the address bar or history.
    expect(new URL(page.url()).hash).toBe('');
    await assertNoOverflow(page);
    await screenshot(page, 'setup-welcome-linked', { scopeToProject: true });
  });

  test('welcome step asks for the token, and explains a wrong one', async ({ page }) => {
    await setupMocks(page, { verifyFails: true });
    await page.goto('/setup');
    const letsGo = page.getByRole('button', { name: "Let's go" });
    await expect(letsGo).toBeDisabled();
    await page.getByLabel('Setup token').fill('wrong-token');
    await letsGo.click();
    await expect(page.getByRole('alert')).toContainText('Invalid setup token');
    await assertNoOverflow(page);
    await screenshot(page, 'setup-welcome-error', { scopeToProject: true });
  });

  test('email sign-in, agent email and finish send the previewed consent', async ({ page }) => {
    const captured = await setupMocks(page, { ownerEmail: LONG_OWNER });
    await page.goto('/setup#token=installer-setup-token');
    await page.getByRole('button', { name: "Let's go" }).click();

    await expect(page.getByRole('heading', { name: "How you'll sign in" })).toBeVisible();
    await expect(page.getByText('Email sign-in is ready')).toBeVisible();
    await expect(page.getByText(LONG_OWNER)).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'setup-sign-in-email', { scopeToProject: true });

    await page.getByRole('button', { name: /Also allow GitHub, Google or GitLab/ }).click();
    await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByText(/\/api\/auth\/callback\/github/)).toBeVisible();
    // Google infrastructure OAuth (GCP) is admin-only; setup offers sign-in providers alone.
    await expect(page.getByText(/infrastructure/i)).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'setup-sign-in-providers', { scopeToProject: true });

    // A half-entered provider would fail setup, so Continue waits for the rest of it.
    await page.getByLabel('Client ID').fill('half-entered-client-id');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByLabel('Client ID').fill('');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Email your agents' })).toBeVisible();
    // Focus follows the step, so keyboard and screen reader users start at the new heading.
    await expect(page.getByRole('heading', { name: 'Email your agents' })).toBeFocused();
    await expect(page.getByRole('switch', { name: 'Let agents receive email' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await page.getByRole('button', { name: /What changes on sam2.party/ }).click();
    await expect(page.getByText('Add TXT record cf2024-1._domainkey.sam2.party')).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'setup-agent-email', { scopeToProject: true });

    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    expect(captured.complete).toEqual([
      {
        token: 'installer-setup-token',
        config: {},
        agentEmail: { consentToken: 'consent-token-1' },
      },
    ]);
    await assertNoOverflow(page);
    await screenshot(page, 'setup-done', { scopeToProject: true });

    // Sign in carries the owner to the email form with their address filled in.
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByPlaceholder('you@example.com')).toHaveValue(LONG_OWNER);
  });

  test('turning agent email off finishes without it', async ({ page }) => {
    const captured = await setupMocks(page);
    await page.goto('/setup#token=t');
    await page.getByRole('button', { name: "Let's go" }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('switch', { name: 'Let agents receive email' }).click();
    await expect(page.getByRole('button', { name: /What changes on/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    expect(captured.complete).toEqual([{ token: 't', config: {} }]);
  });

  test('a deployment without email needs one OAuth provider and skips the email step', async ({
    page,
  }) => {
    const captured = await setupMocks(page, {
      emailSignIn: false,
      ownerEmail: null,
      agentEmail: null,
    });
    await page.goto('/setup#token=t');
    await page.getByRole('button', { name: "Let's go" }).click();
    await expect(
      page.getByText('Connect one sign-in provider. You can add more later.')
    ).toBeVisible();
    const continueButton = page.getByRole('button', { name: 'Continue' });
    await expect(continueButton).toBeDisabled();
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    await page.getByLabel('Client ID').fill('google-client-id.apps.googleusercontent.com');
    await page.getByLabel('Client secret').fill('google-client-secret');
    await assertNoOverflow(page);
    await screenshot(page, 'setup-sign-in-oauth-only', { scopeToProject: true });
    await continueButton.click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    expect(captured.complete).toEqual([
      {
        token: 't',
        config: {
          google: {
            clientId: 'google-client-id.apps.googleusercontent.com',
            clientSecret: 'google-client-secret',
          },
        },
      },
    ]);
  });

  test('says when agent email could not turn on', async ({ page }) => {
    await setupMocks(page, {
      agentEmailError:
        'What turning agent email on would change is different from what you allowed.',
    });
    await page.goto('/setup#token=t');
    await page.getByRole('button', { name: "Let's go" }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.getByText("Agent email didn't turn on", { exact: false })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'setup-done-agent-email-error', { scopeToProject: true });
  });

  test('a finished instance says so', async ({ page }) => {
    await setupMocks(page, { completed: true });
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'SAM is set up' })).toBeVisible();
    await assertNoOverflow(page);
  });
});

test.describe('First-run setup scrolling', () => {
  test('the tallest step scrolls to its button with the wheel, at every viewport', async ({
    page,
  }) => {
    await setupMocks(page);
    // Shorter than the step at every project viewport, mobile included.
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport?.width ?? 375, height: 560 });
    await page.goto('/setup#token=t');
    await page.getByRole('button', { name: "Let's go" }).click();
    await page.getByRole('button', { name: /Also allow GitHub, Google or GitLab/ }).click();
    await page.getByRole('button', { name: 'GitLab', exact: true }).click();
    const scroller = page.getByTestId('setup-scroll');
    const overflow = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(overflow).toBeGreaterThan(0);

    const continueButton = page.getByRole('button', { name: 'Continue' });
    await page.mouse.move((viewport?.width ?? 375) / 2, 280);
    await page.mouse.wheel(0, 3000);
    await expect
      .poll(async () => {
        const box = await continueButton.boundingBox();
        return box ? box.y + box.height <= 560 && box.y >= 0 : false;
      })
      .toBe(true);
    await assertNoOverflow(page);
    await screenshot(page, 'setup-sign-in-providers-scrolled', { scopeToProject: true });
  });
});

test.describe('Email sign-in', () => {
  test('email is the main way in when no OAuth provider is set up', async ({ page }) => {
    const captured = await setupMocks(page);
    await page.goto('/');
    const sendButton = page.getByRole('button', { name: 'Email me a sign-in code' });
    await expect(sendButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'sign-in-email-only', { scopeToProject: true });

    await page.getByLabel('Email').fill(LONG_OWNER);
    await sendButton.click();
    await expect(page.getByLabel('Sign-in code')).toBeVisible();
    expect(captured.sendCode).toEqual([{ email: LONG_OWNER, type: 'sign-in' }]);
    await assertNoOverflow(page);
    await screenshot(page, 'sign-in-email-code', { scopeToProject: true });

    await page.getByLabel('Sign-in code').fill('12a3456');
    await expect(page.getByLabel('Sign-in code')).toHaveValue('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText("That code didn't work");
    expect(captured.signIn).toEqual([{ email: LONG_OWNER, otp: '123456' }]);
    await assertNoOverflow(page);
    await screenshot(page, 'sign-in-email-wrong-code', { scopeToProject: true });
  });

  test('email sits under the OAuth buttons when both are available', async ({ page }) => {
    await setupMocks(page, { oauthProviders: true });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'sign-in-oauth-and-email', { scopeToProject: true });
  });
});
