import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

// ---------------------------------------------------------------------------
// Light Mode — Slice B (chat surfaces) Visual Audit
//
// Exercises the chat surfaces touched by the slice-b light-mode pass in BOTH
// themes at BOTH viewports (375 / 1280):
//   - the ACP utility colour ramp (gray text ramp, status colours) via a
//     persisted tool call + markdown body (code block, table, lists)
//   - the scroll-to-bottom button + CopyableId form-token surfaces
//   - empty-state and many-message variants
//
// PRIME DIRECTIVE: zero dark-mode delta. The dark screenshots must look exactly
// as they did before slice B; the light screenshots prove the additive
// [data-ui-theme='sam-light'] overrides make the same surfaces readable on a
// light canvas. Tokyo-Night code spans + the terminal island stay dark in both.
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-test-1';
const RICH_SESSION_ID = 'sess-slice-b-rich';
const EMPTY_SESSION_ID = 'sess-slice-b-empty';
const TOOL_TITLE = 'Bash: pnpm --filter @simple-agent-manager/web test';
const TOOL_BUTTON_NAME = new RegExp(TOOL_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Light Mode Slice B',
  repository: 'user/light-mode-slice-b',
  repoProvider: 'github',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function makeSession(overrides: { id: string; topic: string; messageCount: number }) {
  return {
    id: overrides.id,
    workspaceId: null,
    taskId: null,
    topic: overrides.topic,
    status: 'stopped',
    messageCount: overrides.messageCount,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 5_000,
    endedAt: Date.now() - 5_000,
    cleanupAt: null,
    isIdle: false,
    agentCompletedAt: null,
    agentSessionId: null,
    agentType: 'claude-code',
  };
}

const LONG_MARKDOWN = [
  'Here is a thorough walkthrough so we can see the **prose** ramp render on both themes.',
  '',
  '1. First we read the existing utilities.',
  '2. Then we add an additive light override.',
  '3. Finally we verify zero dark delta.',
  '',
  '| Surface | Dark | Light |',
  '| --- | --- | --- |',
  '| Gray ramp | bright-on-dark | dark-on-light |',
  '| Status text | pastel | saturated |',
  '| Terminal | dark | dark (pinned) |',
  '',
  'Inline `--sam-color-tn-green` code stays dark in both themes. A longer fenced block:',
  '',
  '```ts',
  'export function resolveTheme(stored: string | null): Theme {',
  "  return stored === 'light' ? 'sam-light' : 'sam';",
  '}',
  '```',
  '',
  'And a deliberately long unbroken token to stress wrapping: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
].join('\n');

const RICH_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: RICH_SESSION_ID,
    role: 'user',
    content: 'Convert the chat surfaces to light-mode tokens and show me the result.',
    toolMetadata: null,
    createdAt: Date.now() - 90_000,
    sequence: 1,
  },
  {
    id: 'msg-tool-start',
    sessionId: RICH_SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-slice-b',
      title: TOOL_TITLE,
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'term-slice-b' }],
    },
    createdAt: Date.now() - 70_000,
    sequence: 2,
  },
  {
    id: 'msg-tool-done',
    sessionId: RICH_SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: 'tc-slice-b',
      status: 'completed',
      contentSize: 256,
    },
    createdAt: Date.now() - 60_000,
    sequence: 3,
  },
  {
    id: 'msg-assistant-1',
    sessionId: RICH_SESSION_ID,
    role: 'assistant',
    content: LONG_MARKDOWN,
    toolMetadata: null,
    createdAt: Date.now() - 40_000,
    sequence: 4,
  },
];

// A longer thread to exercise scroll behaviour + the scroll-to-bottom button.
const MANY_MESSAGES = [
  ...RICH_MESSAGES,
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `msg-extra-${i}`,
    sessionId: RICH_SESSION_ID,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content:
      i % 2 === 0
        ? `Follow-up question number ${i + 1} about how the token ramp resolves.`
        : `Answer ${i + 1}: the value lives behind the light selector, so dark mode is untouched.`,
    toolMetadata: null,
    createdAt: Date.now() - (38_000 - i * 1_000),
    sequence: 5 + i,
  })),
];

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
    // Dismiss the first-run onboarding wizard so its modal overlay doesn't sit
    // on top of the chat surfaces we are screenshotting.
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  }, theme);
}

async function gotoSession(
  page: Page,
  sessionId: string,
  messages: unknown[],
  topic: string,
) {
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: makeSession({ id: sessionId, topic, messageCount: messages.length }),
    messages,
  });
  // Specific tool-content route, registered after the shared mocks so it wins.
  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${sessionId}/messages/*/tool-content`,
    (route: Route) =>
      route.fulfill({
        status: 200,
        json: { content: [{ type: 'content', content: { type: 'text', text: 'all tests passed' } }] },
      }),
  );
  await page.goto(`/projects/${PROJECT_ID}/chat/${sessionId}`);
  await page.waitForTimeout(1200);
}

async function expectTheme(page: Page, theme: 'dark' | 'light') {
  const attr = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  expect(attr).toBe(theme === 'dark' ? 'sam' : 'sam-light');
}

function runAudit(label: string, viewport: { width: number; height: number }, isMobile: boolean) {
  test.describe(`Light Mode Slice B — ${label}`, () => {
    test.use({ viewport, isMobile });

    for (const theme of ['dark', 'light'] as const) {
      test(`rich conversation (${theme})`, async ({ page }) => {
        await seedTheme(page, theme);
        await gotoSession(page, RICH_SESSION_ID, RICH_MESSAGES, 'Slice B rich conversation');
        await expectTheme(page, theme);
        await expect(page.getByText(TOOL_TITLE)).toBeVisible();
        // Expand the tool call to exercise the lazy-loaded content + gray ramp.
        const toolButton = page.getByRole('button', { name: TOOL_BUTTON_NAME });
        await toolButton.click();
        await expect(page.getByText('all tests passed')).toBeVisible();
        await screenshot(page, `slice-b-rich-${theme}`);
        await assertNoOverflow(page);
      });

      test(`empty conversation (${theme})`, async ({ page }) => {
        await seedTheme(page, theme);
        await gotoSession(page, EMPTY_SESSION_ID, [], 'Slice B empty conversation');
        await expectTheme(page, theme);
        await screenshot(page, `slice-b-empty-${theme}`);
        await assertNoOverflow(page);
      });

      test(`many messages (${theme})`, async ({ page }) => {
        await seedTheme(page, theme);
        await gotoSession(page, RICH_SESSION_ID, MANY_MESSAGES, 'Slice B many messages');
        await expectTheme(page, theme);
        await screenshot(page, `slice-b-many-${theme}`);
        await assertNoOverflow(page);
      });
    }
  });
}

runAudit('Mobile (375x667)', { width: 375, height: 667 }, true);
runAudit('Desktop (1280x800)', { width: 1280, height: 800 }, false);
