import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

// ---------------------------------------------------------------------------
// Chat Light-Mode Overlay Audit
//
// Regression guard for the light-mode dark-background contrast sweep. Several
// chat overlay surfaces previously carried a hardcoded near-black background
// (inline rgba(8,15,12,...) or bg-[rgba(...)] utilities that bypassed the
// theme token system) so their text was unreadable on the light canvas:
//   - the project chat composer textarea  (now bg-[var(--sam-form-bg)])
//   - the SessionHeader top panel + tooltip
//   - the project-message-view error banner
//
// This spec renders the project chat session in BOTH themes at BOTH viewports
// and asserts that, in light mode, the composer input's computed
// background-color is NOT a hardcoded near-black value — it must resolve to the
// light --sam-form-bg token. Dark mode is screenshotted for zero-delta review.
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-test-1';
const SESSION_ID = 'sess-chat-overlay';

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Chat Overlay Audit',
  repository: 'user/chat-overlay-audit',
  repoProvider: 'github',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function makeSession() {
  // An idle (not stopped) session keeps the live session view mounted — the
  // SessionHeader top panel AND the FollowUpInput composer both render. A
  // 'stopped' session collapses to a "This session has ended." footer with no
  // composer, which would hide the very surfaces this audit guards.
  return {
    id: SESSION_ID,
    workspaceId: null,
    taskId: null,
    topic: 'Chat overlay light-mode audit',
    status: 'active',
    messageCount: 1,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 5_000,
    endedAt: null,
    cleanupAt: Date.now() + 600_000,
    isIdle: true,
    agentCompletedAt: Date.now() - 5_000,
    agentSessionId: null,
    agentType: 'claude-code',
  };
}

const MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Make the chat overlay surfaces readable in light mode.',
    toolMetadata: null,
    createdAt: Date.now() - 90_000,
    sequence: 1,
  },
];

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
    // Dismiss the first-run onboarding wizard so its modal overlay doesn't sit
    // on top of the chat composer/header surfaces we are auditing.
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  }, theme);
}

async function gotoSession(page: Page) {
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: makeSession(),
    messages: MESSAGES,
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await page.waitForTimeout(1200);
}

async function expectTheme(page: Page, theme: 'dark' | 'light') {
  const attr = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  expect(attr).toBe(theme === 'dark' ? 'sam' : 'sam-light');
}

/**
 * Parses a `rgb(...)` / `rgba(...)` computed colour into a 0-1 relative
 * luminance value. A near-black background (the bug we are guarding against)
 * has luminance well under 0.2; the light --sam-form-bg token resolves to a
 * near-white surface with luminance well over 0.7.
 */
function relativeLuminance(color: string): number {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return 1; // unknown format — don't false-fail
  const [r, g, b] = match[1].split(',').map((n) => parseFloat(n.trim()));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function runAudit(label: string, viewport: { width: number; height: number }, isMobile: boolean) {
  test.describe(`Chat Light-Mode Overlay — ${label}`, () => {
    test.use({ viewport, isMobile });

    for (const theme of ['dark', 'light'] as const) {
      test(`composer + header (${theme})`, async ({ page }) => {
        await seedTheme(page, theme);
        await gotoSession(page);
        await expectTheme(page, theme);

        const composer = page.getByRole('combobox');
        await expect(composer).toBeVisible();

        await screenshot(page, `chat-overlay-${theme}`);
        await assertNoOverflow(page);

        const composerBg = await composer.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );

        if (theme === 'light') {
          // The composer textarea must adapt to the light form-bg token, not a
          // hardcoded near-black rgba(8,15,12,...) overlay.
          expect(relativeLuminance(composerBg)).toBeGreaterThan(0.5);
        } else {
          // Dark mode stays dark — the same token resolves to a near-black surface.
          expect(relativeLuminance(composerBg)).toBeLessThan(0.3);
        }
      });
    }
  });
}

runAudit('Mobile (375x667)', { width: 375, height: 667 }, true);
runAudit('Desktop (1280x800)', { width: 1280, height: 800 }, false);
