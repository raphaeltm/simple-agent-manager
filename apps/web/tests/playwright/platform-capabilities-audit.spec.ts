/**
 * Platform capabilities: voice input and read-aloud follow the installation (rule 17).
 *
 * `GET /api/config/platform-capabilities` says which services an installation has. A
 * self-hosted install has no speech-to-text and no server text-to-speech, so the project
 * chat must not offer a mic button, and agent messages must stop routing "Read aloud"
 * through the server `/api/tts` player.
 *
 * This spec mounts the real project chat route (`/projects/:id/chat/:sessionId`) against
 * mocked APIs in four configurations and, in each:
 *
 *  1. holds the capabilities response open and proves the mic is shown while the answer is
 *     outstanding (the documented "assumed available until the query answers" behaviour),
 *     then releases it, so the real fetch -> query -> hook -> render path drives the result
 *     (rule 62: no flag is hand-fed to a component);
 *  2. asserts the mic is present or absent as configured, next to a liveness assertion
 *     (the composer textarea and send button rendered);
 *  3. asserts the composer row has no dead space where the mic used to be, as measured
 *     coordinates (rule 17): the children plus the row gap exactly fill the row, and the
 *     send button is flush with the row's right edge;
 *  4. clicks "Read aloud" on the agent message and asserts which path took it: a POST to
 *     `/api/tts/synthesize` with server TTS, or the browser's `speechSynthesis.speak`
 *     without it.
 *
 * Screenshots differ only by the mic: the read-aloud button looks the same on the server and
 * browser paths, so step 4's click assertion is what tells the TTS configurations apart.
 *
 * Data includes a 200+ character agent message with a long unbroken URL, at the project's
 * mobile (375x667) and desktop (1280x800) viewports. `assertNoOverflow` also walks clipped
 * overflow (rule 56).
 */

import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeIdleSessionState,
  makeMockProject,
  makeMockUser,
  screenshot,
  setupSleepingChatMocks,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});
const MOCK_PROJECT = makeMockProject();
const PROJECT_ID = 'proj-test-1';

const LONG_URL = `https://example.com/${'long-unbroken-segment-'.repeat(8)}end`;
const AGENT_TEXT =
  'I traced the capability lookup through the public config route and the web hook. ' +
  'Voice input needs speech-to-text and read-aloud needs server text-to-speech, and a ' +
  'self-hosted installation has neither, so the entry points must not be offered. ' +
  `Details are at ${LONG_URL} <script>alert("xss")</script> &amp; ☃ \u{1F680}`;

const SESSION = {
  id: 'session-1',
  projectId: PROJECT_ID,
  taskId: 'task-session-1',
  topic: 'Capabilities audit: hide voice input and read-aloud on self-hosted installs',
  status: 'sleeping',
  workspaceId: null,
  nodeId: null,
  branch: 'sam/capabilities-audit',
  startedAt: Date.parse('2026-01-15T10:00:00Z'),
  lastMessageAt: Date.parse('2026-01-15T10:02:00Z'),
  createdAt: Date.parse('2026-01-15T10:00:00Z'),
  updatedAt: Date.parse('2026-01-15T10:05:00Z'),
  stoppedAt: null,
  viewerAccess: 'owner',
};

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Can I dictate a reply here?',
    messageIndex: 0,
    createdAt: Date.parse('2026-01-15T10:01:00Z'),
  },
  {
    id: 'msg-2',
    sessionId: 'session-1',
    role: 'assistant',
    content: AGENT_TEXT,
    messageIndex: 1,
    createdAt: Date.parse('2026-01-15T10:02:00Z'),
  },
];

const OWN_TASK = {
  id: 'task-session-1',
  status: 'sleeping',
  executionStep: null,
  errorMessage: null,
  outputBranch: 'sam/capabilities-audit',
  startedAt: '2026-01-15T08:00:00Z',
  workspaceId: null,
};

interface Capabilities {
  speechToText: boolean;
  textToSpeech: boolean;
  guidedCredentialSetup: boolean;
  analytics: boolean;
  workerLogSearch: boolean;
  artifacts: boolean;
  emailSending: boolean;
}

const CLOUDFLARE: Capabilities = {
  speechToText: true,
  textToSpeech: true,
  guidedCredentialSetup: true,
  analytics: true,
  workerLogSearch: true,
  artifacts: true,
  emailSending: true,
};

interface Config {
  name: string;
  capabilities: Capabilities;
}

const CONFIGS: Config[] = [
  { name: 'cloudflare', capabilities: CLOUDFLARE },
  {
    name: 'self-hosted',
    capabilities: {
      ...CLOUDFLARE,
      speechToText: false,
      textToSpeech: false,
      guidedCredentialSetup: false,
      analytics: false,
      workerLogSearch: false,
      artifacts: false,
      emailSending: false,
    },
  },
  // The two flags are independent: neither may gate the other.
  { name: 'stt-off-only', capabilities: { ...CLOUDFLARE, speechToText: false } },
  { name: 'tts-off-only', capabilities: { ...CLOUDFLARE, textToSpeech: false } },
];

const MIC_NAME = 'Start voice input';

interface Harness {
  /** Releases the held capabilities response. */
  releaseCapabilities: () => void;
  capabilityRequests: () => number;
  ttsRequests: () => string[];
  /** Releases held `/api/tts/*` responses (they answer 503, which falls back to browser speech). */
  releaseTts: () => void;
}

async function setupHarness(page: Page, capabilities: Capabilities): Promise<Harness> {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
    // Record browser speech instead of speaking; headless Chromium has no audio sink.
    const spoken: string[] = [];
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
        spoken.push(utterance.text);
      };
    }
  });

  await setupSleepingChatMocks(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    session: SESSION,
    messages: MESSAGES,
    state: makeIdleSessionState(),
    ownTask: OWN_TASK,
  });

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let capabilityRequests = 0;
  const ttsRequests: string[] = [];

  // Registered after the shared mocks, so these win over their catch-all.
  await page.route('**/api/config/platform-capabilities', async (route: Route) => {
    capabilityRequests += 1;
    await released;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(capabilities),
    });
  });
  // Held until the test has asserted which path the click took: the player falls back to
  // browser speech when the server answers an error, so an immediate 503 would race it.
  let releaseTts!: () => void;
  const ttsReleased = new Promise<void>((resolve) => {
    releaseTts = resolve;
  });
  await page.route('**/api/tts/**', async (route: Route) => {
    ttsRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await ttsReleased;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'TTS_UNAVAILABLE', message: 'mock tts is offline' }),
    });
  });

  return {
    releaseCapabilities: release,
    capabilityRequests: () => capabilityRequests,
    ttsRequests: () => ttsRequests,
    releaseTts,
  };
}

interface RowRect {
  tag: string;
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

/** Measured geometry of the composer row (the textarea's parent) and its visible children. */
async function measureComposerRow(page: Page) {
  const textarea = page.locator('textarea[role="combobox"]');
  await expect(textarea).toBeVisible();
  return textarea.evaluate((el) => {
    const row = el.parentElement as HTMLElement;
    const rowRect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const children: RowRect[] = Array.from(row.children)
      .filter((child) => child.getBoundingClientRect().width > 0)
      .map((child) => {
        const r = child.getBoundingClientRect();
        return {
          tag: child.tagName.toLowerCase(),
          label: child.getAttribute('aria-label') ?? child.getAttribute('title') ?? '',
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
        };
      })
      .sort((a, b) => a.left - b.left);
    return {
      row: { left: rowRect.left, right: rowRect.right, width: rowRect.width },
      gap: parseFloat(style.columnGap) || 0,
      children,
    };
  });
}

for (const config of CONFIGS) {
  test.describe(`Platform capabilities — ${config.name}`, () => {
    test('mic and read-aloud follow the capabilities answer', async ({ page }) => {
      const viewport = page.viewportSize()!;
      const viewportName = viewport.width <= 500 ? 'mobile' : 'desktop';
      const harness = await setupHarness(page, config.capabilities);
      const mic = page.getByRole('button', { name: MIC_NAME });
      const readAloud = page.getByRole('button', { name: 'Read aloud' });

      await page.goto(`/projects/${PROJECT_ID}/chat/session-1`);

      // The conversation and the composer are up while the capabilities answer is still
      // held: every service is assumed present, so the mic is offered.
      await expect(page.getByText('I traced the capability lookup')).toBeVisible();
      await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
      await expect.poll(() => harness.capabilityRequests()).toBeGreaterThan(0);
      await expect(mic).toHaveCount(1);
      await expect(readAloud).toHaveCount(1);

      // Release the answer and let the real query settle before asserting the outcome.
      const answered = page.waitForResponse('**/api/config/platform-capabilities');
      harness.releaseCapabilities();
      await answered;

      const expectedMics = config.capabilities.speechToText ? 1 : 0;
      await expect(mic).toHaveCount(expectedMics);
      // Liveness beside the absence assertion: the composer rendered and can send.
      await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Send|Sending\.\.\.)$/ })).toHaveCount(1);
      // Read aloud stays offered in every configuration: server player, or the browser's.
      await expect(readAloud).toHaveCount(1);
      await expect(readAloud).toBeVisible();

      // Composer layout: no dead space where the mic used to be.
      const geometry = await measureComposerRow(page);
      const labels = geometry.children.map((c) => c.label);
      expect(labels.includes(MIC_NAME)).toBe(config.capabilities.speechToText);
      const textarea = geometry.children.find((c) => c.tag === 'textarea')!;
      const send = geometry.children[geometry.children.length - 1];
      expect(send.tag).toBe('button');
      expect(send.label).not.toBe(MIC_NAME);
      // Send is flush with the row's right edge and sits just right of whatever precedes it.
      expect(Math.abs(send.right - geometry.row.right)).toBeLessThanOrEqual(1);
      for (let i = 1; i < geometry.children.length; i += 1) {
        const gap = geometry.children[i].left - geometry.children[i - 1].right;
        expect(Math.abs(gap - geometry.gap)).toBeLessThanOrEqual(1);
      }
      // Children plus gaps account for the whole row width: nothing is left over.
      const used =
        geometry.children.reduce((sum, c) => sum + c.width, 0) +
        geometry.gap * (geometry.children.length - 1);
      expect(Math.abs(used - geometry.row.width)).toBeLessThanOrEqual(1);
      // Textarea and send button stay bottom-aligned.
      expect(Math.abs(send.bottom - textarea.bottom)).toBeLessThanOrEqual(1);
      // Adjacency, stated the way the task puts it: the gap to send is the row gap when
      // there is no mic, and the mic sits in that gap when there is one.
      if (config.capabilities.speechToText) {
        const micBox = geometry.children.find((c) => c.label === MIC_NAME)!;
        expect(micBox.left).toBeGreaterThanOrEqual(textarea.right);
        expect(send.left).toBeGreaterThanOrEqual(micBox.right);
      } else {
        expect(Math.abs(send.left - textarea.right - geometry.gap)).toBeLessThanOrEqual(1);
      }

      await assertNoOverflow(page);
      await screenshot(page, `platform-capabilities-${config.name}-${viewportName}`);

      // Read aloud: which path the click takes.
      await readAloud.click();
      if (config.capabilities.textToSpeech) {
        await expect
          .poll(() => harness.ttsRequests().some((r) => r.startsWith('POST /api/tts/synthesize')))
          .toBe(true);
        // The server request is in flight and the browser has said nothing.
        expect(await page.evaluate(() => (window as never as { __spoken: string[] }).__spoken)).toEqual(
          []
        );
        harness.releaseTts();
      } else {
        await expect
          .poll(() => page.evaluate(() => (window as never as { __spoken: string[] }).__spoken.length))
          .toBeGreaterThan(0);
        expect(harness.ttsRequests()).toEqual([]);
      }
    });
  });
}

test.describe('Platform capabilities — endpoint failure', () => {
  test('a failing capabilities endpoint keeps every service offered', async ({ page }) => {
    const viewportName = page.viewportSize()!.width <= 500 ? 'mobile' : 'desktop';
    await page.addInitScript(() => {
      window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
    });
    await setupSleepingChatMocks(page, {
      user: MOCK_USER,
      project: MOCK_PROJECT,
      session: SESSION,
      messages: MESSAGES,
      state: makeIdleSessionState(),
      ownTask: OWN_TASK,
    });
    await page.route('**/api/config/platform-capabilities', (route: Route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    const ttsRequests: string[] = [];
    await page.route('**/api/tts/**', async (route: Route) => {
      ttsRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      // Never answered: the assertion is about which path the click takes, not playback.
    });
    const answered = page.waitForResponse('**/api/config/platform-capabilities');
    await page.goto(`/projects/${PROJECT_ID}/chat/session-1`);
    await answered;

    await expect(page.getByText('I traced the capability lookup')).toBeVisible();
    await expect(page.getByRole('button', { name: MIC_NAME })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Read aloud' })).toHaveCount(1);
    await assertNoOverflow(page);
    await screenshot(page, `platform-capabilities-endpoint-error-${viewportName}`);
    // The server read-aloud path stays offered, not only the browser fallback's button.
    await page.getByRole('button', { name: 'Read aloud' }).click();
    await expect
      .poll(() => ttsRequests.some((r) => r.startsWith('POST /api/tts/synthesize')))
      .toBe(true);
  });
});
