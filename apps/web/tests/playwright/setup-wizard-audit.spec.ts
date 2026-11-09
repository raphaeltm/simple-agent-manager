/**
 * First-run setup and email sign-in: every screen at each viewport project, with long values,
 * the error paths, and the request each primary action sends. Where SAM can email sign-in
 * codes, setup is one screen: the token, then straight to the code.
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

interface MockOptions {
  completed?: boolean;
  emailSignIn?: boolean;
  ownerEmail?: string | null;
  verifyFails?: boolean;
  oauthProviders?: boolean;
}

interface Captured {
  sessionChecks: number;
  complete: Array<Record<string, unknown>>;
  sendCode: Array<Record<string, unknown>>;
  signIn: Array<Record<string, unknown>>;
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(page: Page, options: MockOptions = {}): Promise<Captured> {
  const captured: Captured = { sessionChecks: 0, complete: [], sendCode: [], signIn: [] };
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = () => JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;

    if (path === '/api/auth/get-session') {
      captured.sessionChecks += 1;
      return json(route, 200, null);
    }
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
      });
    }
    if (path === '/api/setup/complete') {
      captured.complete.push(body());
      return json(route, 200, { completed: true, status: PLATFORM_STATUS });
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

  test('with email sign-in, the token is the only question and the code is already on its way', async ({
    page,
  }) => {
    const captured = await setupMocks(page, { ownerEmail: LONG_OWNER });
    await page.goto('/setup#token=installer-setup-token');
    await page.getByRole('button', { name: "Let's go" }).click();

    // Setup finished with no other screens, and the owner lands on the code step.
    const codeField = page.getByLabel('Sign-in code');
    await expect(codeField).toBeVisible();
    await expect(page.getByText(LONG_OWNER)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    expect(captured.complete).toEqual([{ token: 'installer-setup-token', config: {} }]);
    expect(captured.sendCode).toEqual([{ email: LONG_OWNER, type: 'sign-in' }]);
    await expect(page.getByText(/agents? (can )?receive email/i)).toHaveCount(0);
    // The setup token already vouched for this address: say so plainly instead of the
    // anonymous-visitor hedge, and don't re-sell SAM the owner just finished installing.
    await expect(page.getByText('We sent a code to')).toBeVisible();
    await expect(page.getByText(/can sign in here/)).toHaveCount(0);
    await expect(page.getByText('One step left')).toBeVisible();
    await expect(page.getByText('Claude Code')).toHaveCount(0);
    await expect(page.getByText('Learn more about SAM')).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'setup-email-code-sent', { scopeToProject: true });

    // Coming back from the mail app: the tab regains focus and the session is re-checked.
    // BetterAuth skips focus refetches within 5 s of the last session request.
    await codeField.fill('123456');
    await page.waitForTimeout(5_500);
    const sessionChecks = captured.sessionChecks;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(() => captured.sessionChecks).toBeGreaterThan(sessionChecks);
    await page.waitForTimeout(500);
    await expect(codeField).toHaveValue('123456');

    // The phone browser reloaded the tab while it was in the background.
    await page.reload();
    await expect(page.getByLabel('Sign-in code')).toBeVisible();
    await expect(page.getByText(LONG_OWNER)).toBeVisible();
    // No second code: the one already sent is still the one to enter.
    expect(captured.sendCode).toHaveLength(1);
  });

  test('without email sign-in, one OAuth provider is the way in', async ({ page }) => {
    const captured = await setupMocks(page, { emailSignIn: false, ownerEmail: null });
    await page.goto('/setup#token=t');
    await page.getByRole('button', { name: "Let's go" }).click();
    await expect(
      page.getByText('Connect one sign-in provider. You can add more later.')
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: "How you'll sign in" })).toBeFocused();
    // Google infrastructure OAuth (GCP) is admin-only; setup offers sign-in providers alone.
    await expect(page.getByText(/infrastructure/i)).toHaveCount(0);
    const finish = page.getByRole('button', { name: 'Finish setup' });
    await expect(finish).toBeDisabled();
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    await page.getByLabel('Client ID').fill('google-client-id.apps.googleusercontent.com');
    await expect(finish).toBeDisabled();
    await page.getByLabel('Client secret').fill('google-client-secret');
    await assertNoOverflow(page);
    await screenshot(page, 'setup-sign-in-oauth-only', { scopeToProject: true });
    await finish.click();
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
    expect(captured.sendCode).toEqual([]);
    await assertNoOverflow(page);
    await screenshot(page, 'setup-done', { scopeToProject: true });
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
    await setupMocks(page, { emailSignIn: false, ownerEmail: null });
    // Shorter than the step at every project viewport, mobile included.
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport?.width ?? 375, height: 560 });
    await page.goto('/setup#token=t');
    await page.getByRole('button', { name: "Let's go" }).click();
    await page.getByRole('button', { name: 'GitLab', exact: true }).click();
    const scroller = page.getByTestId('setup-scroll');
    const overflow = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(overflow).toBeGreaterThan(0);

    const finish = page.getByRole('button', { name: 'Finish setup' });
    await page.mouse.move((viewport?.width ?? 375) / 2, 280);
    await page.mouse.wheel(0, 3000);
    await expect
      .poll(async () => {
        const box = await finish.boundingBox();
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
    // An ordinary visitor typing an address gets the account-enumeration-safe hedge, not the
    // confident "we sent it" copy reserved for a setup-token-vouched owner (see the setup test).
    await expect(page.getByText(/can sign in here/)).toBeVisible();
    await expect(page.getByText('We sent a code to')).toHaveCount(0);
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
