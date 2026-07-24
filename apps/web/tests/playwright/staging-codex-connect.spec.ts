/**
 * Staging verification for the guided "Connect with Codex" setup terminal.
 *
 * SUCCESS BAR (per Raphaël, 2026-07-24): through the deployed feature on staging,
 * trigger `codex login --device-auth` and reach the device-code sign-in link.
 * The human ChatGPT sign-in itself is out of scope (cannot be automated).
 *
 * Two proofs:
 *  1. API + browser-WebSocket: create a session, wait for waiting_for_user, mint a
 *     terminal token, open the terminal WS in the real browser, auto-run the login
 *     command, and assert the device-auth URL/code streams back (the SERVER +
 *     sandbox + codex CLI + WS proxy all work end to end).
 *  2. Real UI: open Settings -> Agents, drive the Codex card's "Connect with Codex"
 *     modal, confirm it reaches "Waiting for sign-in", and screenshot it (the
 *     device link renders in the xterm canvas). A window.WebSocket hook records the
 *     frames so the link arrival is asserted programmatically too (rule 13).
 *
 * Run (needs SAM_PLAYWRIGHT_PRIMARY_USER):
 *   npx playwright test staging-codex-connect --project="Desktop (1280x800)"
 */
import { expect, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';
const SETUP_BASE = `${STAGING_API}/api/agent-credential-setup-sessions`;

// Sandbox cold-start + codex device-auth can take a while.
test.setTimeout(180_000);

/** Matches the codex device-auth prompt: a URL plus a device/sign-in indicator. */
function looksLikeDeviceAuth(text: string): boolean {
  const hasUrl = /https?:\/\/\S+/i.test(text);
  const hasIndicator = /(device|code|sign in|sign-in|chatgpt|openai|auth\.openai|activate)/i.test(text);
  return hasUrl && hasIndicator;
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  const resp = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(resp.status()).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test('API + terminal WS: codex login --device-auth reaches the device-code link', async ({
  page,
}) => {
  await login(page);

  // Feature must be enabled on staging.
  const cfg = await page.request.get(`${SETUP_BASE}/config`);
  expect(cfg.status()).toBe(200);
  const cfgBody = await cfg.json();
  expect(cfgBody.enabled).toBe(true);

  // Create a session.
  const created = await page.request.post(SETUP_BASE, {
    data: { agentType: 'openai-codex' },
    headers: { 'Content-Type': 'application/json' },
  });
  expect([201, 202]).toContain(created.status());
  const session = await created.json();
  if (created.status() === 202) {
    test.info().annotations.push({ type: 'note', description: 'No capacity — retry later' });
  }
  expect(session.id).toBeTruthy();
  const sessionId: string = session.id;
  const loginCommand: string = session.loginCommand;
  expect(loginCommand).toContain('codex login --device-auth');

  // Poll until the sandbox is provisioned and waiting for the user.
  let status = session.status as string;
  const deadline = Date.now() + 90_000;
  while (!['waiting_for_user', 'capturing', 'completed', 'failed', 'expired', 'cancelled'].includes(status)) {
    if (Date.now() > deadline) break;
    await page.waitForTimeout(2500);
    const poll = await page.request.get(`${SETUP_BASE}/${sessionId}`);
    const body = await poll.json();
    status = body.status;
  }
  test.info().annotations.push({ type: 'status', description: `reached status=${status}` });
  expect(status).toBe('waiting_for_user');

  // Mint a terminal token and open the terminal WS in the browser.
  const tokenResp = await page.request.get(`${SETUP_BASE}/${sessionId}/terminal-token`);
  expect(tokenResp.status()).toBe(200);
  const { token } = await tokenResp.json();
  expect(token).toBeTruthy();

  const wsUrl = `${SETUP_BASE.replace(/^https/, 'wss')}/${sessionId}/terminal/ws?token=${encodeURIComponent(
    token
  )}&cols=120&rows=40`;

  const captured: string = await page.evaluate(
    async ({ url, cmd }) => {
      return await new Promise<string>((resolve) => {
        let buf = '';
        const decoder = new TextDecoder();
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const done = (v: string) => {
          try {
            ws.close();
          } catch {
            /* noop */
          }
          resolve(v);
        };
        const overall = setTimeout(() => done(buf), 50_000);
        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            buf += decoder.decode(new Uint8Array(ev.data));
            if (/https?:\/\/\S+/i.test(buf) && /(device|code|sign|chatgpt|openai|activate)/i.test(buf)) {
              clearTimeout(overall);
              // give it a beat to flush the code line, then finish
              setTimeout(() => done(buf), 1500);
            }
          }
        };
        ws.onopen = () => {
          // matches SandboxAddon: input is a binary UTF-8 frame; resize is JSON.
          ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
          setTimeout(() => ws.send(new TextEncoder().encode(`${cmd}\r`)), 800);
        };
        ws.onerror = () => done(buf);
      });
    },
    { url: wsUrl, cmd: loginCommand }
  );

  // Bounded, non-secret evidence (device URL + code are login initiators, not the credential).
  console.log('=== terminal output (first 1200 chars) ===\n' + captured.slice(0, 1200));
  expect(looksLikeDeviceAuth(captured)).toBe(true);

  // Clean up the session (frees the sandbox + pool slot).
  await page.request.post(`${SETUP_BASE}/${sessionId}/cancel`).catch(() => {});
});

test('UI: Settings -> Agents "Connect with Codex" modal reaches Waiting for sign-in', async ({
  page,
}) => {
  await login(page);

  // Record every WS frame the real SandboxAddon receives (rule 13: prove the
  // browser client actually gets the bytes, not just the wire).
  await page.addInitScript(() => {
    (window as unknown as { __wsText: string[] }).__wsText = [];
    const Orig = window.WebSocket;
    class HookedWS extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (ev: MessageEvent) => {
          const store = (window as unknown as { __wsText: string[] }).__wsText;
          try {
            if (ev.data instanceof ArrayBuffer) {
              store.push(new TextDecoder().decode(new Uint8Array(ev.data)));
            } else if (typeof ev.data === 'string') {
              store.push(ev.data);
            }
          } catch {
            /* noop */
          }
        });
      }
    }
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = HookedWS as unknown as typeof WebSocket;
  });

  await page.goto(`${STAGING_APP}/settings/agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/codex-connect-settings-agents.png`, fullPage: true });

  // Switch the Codex card to subscription/OAuth so the guided trigger shows, then click it.
  // Selectors are best-effort against the live app; screenshots capture the real state.
  const subscriptionToggle = page
    .getByText(/subscription|oauth|sign in with/i)
    .filter({ hasText: /subscription|oauth|sign in/i })
    .first();
  if (await subscriptionToggle.count()) {
    await subscriptionToggle.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const connectBtn = page.getByRole('button', { name: /connect with codex/i }).first();
  await expect(connectBtn).toBeVisible({ timeout: 15_000 });
  await connectBtn.click();

  // Modal should progress to "Waiting for sign-in" once the sandbox is up.
  const waiting = page.getByText(/waiting for sign-in/i).first();
  await expect(waiting).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(4000); // let the device link render in the xterm canvas
  await page.screenshot({ path: `${SCREENSHOT_DIR}/codex-connect-modal-desktop.png`, fullPage: true });

  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/codex-connect-modal-mobile.png`, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);

  // Wait for the device-auth link to arrive over the real addon's WS.
  let frames: string[] = [];
  const uiDeadline = Date.now() + 40_000;
  while (Date.now() < uiDeadline) {
    frames = await page.evaluate(() => (window as unknown as { __wsText: string[] }).__wsText ?? []);
    if (looksLikeDeviceAuth(frames.join(''))) break;
    await page.waitForTimeout(2000);
  }
  console.log('=== UI WS frames (first 1000 chars) ===\n' + frames.join('').slice(0, 1000));
  expect(looksLikeDeviceAuth(frames.join(''))).toBe(true);

  // Best-effort cleanup: cancel via the modal.
  await page.getByRole('button', { name: /^cancel$/i }).first().click().catch(() => {});
});
