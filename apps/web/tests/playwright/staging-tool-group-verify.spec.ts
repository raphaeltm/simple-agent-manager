/**
 * STAGING verification for the tool-call activity cards — not part of the CI suite.
 *
 * Read-only pass (safe; touches one existing stopped session):
 *   PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-tool-group-verify \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 *
 * Including the live-agent run (starts a REAL Instant container and stops it again):
 *   SAM_STAGING_LIVE_TOOL_GROUP=1 PLAYWRIGHT_BASE_URL=https://app.sammy.party \
 *     npx playwright test staging-tool-group-verify \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 *
 * Authenticates the browser context via the staging token-login endpoint per
 * `.claude/rules/13-staging-verification.md`, then drives the real activity cards
 * against real persisted rows — no mocks anywhere in this file.
 *
 * Expected group shapes are DERIVED at runtime from the session's actual messages
 * rather than hardcoded, so the spec stays truthful if the session is mutated or
 * re-summarised. Screenshots land in `.codex/tmp/staging-screenshots/`.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';
import {
  dismissStagingOnboarding,
  STAGING_API,
  STAGING_APP,
  stagingLogin,
  stagingShot,
} from './staging-helpers';

/*
 * This file talks to real staging, so it must never run in the normal CI sweep — CI has
 * no smoke token and would either fail or, worse, mutate the shared environment. The
 * token's absence is the gate.
 */
test.skip(
  !process.env.SAM_PLAYWRIGHT_PRIMARY_USER,
  'Staging-only: requires SAM_PLAYWRIGHT_PRIMARY_USER'
);

/*
 * Every test here does a token-login, a cross-Atlantic navigation, and then waits on a
 * lazily-loaded route chunk — against a real, throttled environment. The project default
 * of 30s is smaller than the sum of those waits plus a single 30s locator timeout, so a
 * test could exhaust its whole budget waiting for the page and report the FEATURE as
 * missing when the app was still on "Verifying your session".
 */
test.describe.configure({ timeout: 120_000 });

// ---------------------------------------------------------------------------
// Fixture coordinates (overridable — a staging session is not a constant)
// ---------------------------------------------------------------------------

/**
 * Verified on 2026-09-17 as the smoke user via `GET /api/chats`: 33 messages
 * (26 assistant, 4 tool rows, 3 user). The 4 tool rows merge by `toolCallId`
 * into 2 tool calls — `mcp.sam-mcp.get_instructions` and
 * `Read file '/workspaces/.private/startup-check.txt'`. Whether those two calls
 * end up in one group or two depends on what sits between them, so nothing here
 * assumes a group count; see `deriveExpectedGroups`.
 */
const PROJECT_ID = process.env.SAM_STAGING_TOOL_GROUP_PROJECT ?? '01KJNR9R3TEN3KX1ETE33852R8';
const SESSION_ID =
  process.env.SAM_STAGING_TOOL_GROUP_SESSION ?? 'a5b33d02-2485-441d-bb18-373551a122d8';
/** A tool row that grouping ABSORBS — the deep-link target for the jump test. */
const ABSORBED_TOOL_MESSAGE_ID =
  process.env.SAM_STAGING_TOOL_GROUP_MESSAGE ?? '3b1c271d-7ecb-4e60-ad67-034790765c2a';
/** Title of the per-call card that must stay hidden while the group is collapsed. */
const READ_TOOL_TITLE =
  process.env.SAM_STAGING_TOOL_GROUP_TITLE ?? "Read file '/workspaces/.private/startup-check.txt'";

/** "Claude MCP Test" — claude-code on the cf-container Instant runtime (no VM). */
const LIVE_AGENT_PROFILE_ID =
  process.env.SAM_STAGING_TOOL_GROUP_PROFILE ?? '01KYQ60N603GE9G3Y767K9NSW4';
const LIVE_PROMPT =
  'Using your shell tool, run exactly these three commands one at a time: ' +
  '`date -u`, `ls /`, `uname -a`. Then reply with exactly: TOOLS DONE';
const LIVE_DONE_MARKER = 'TOOLS DONE';

/** How long the live agent gets to produce tool calls and settle. */
const DEFAULT_LIVE_RUN_TIMEOUT_MS = 240_000;
const LIVE_RUN_TIMEOUT_MS = Number.parseInt(
  process.env.SAM_STAGING_LIVE_RUN_TIMEOUT_MS ?? String(DEFAULT_LIVE_RUN_TIMEOUT_MS),
  10
);
/**
 * How long the run gets to SETTLE after the agent's closing text.
 *
 * Separate from `LIVE_RUN_TIMEOUT_MS` because it measures a different thing: the
 * assistant's marker is not the end of the turn — an agent can make further tool
 * calls after its closing message, and the first live run did exactly that
 * (ToolSearch -> get_instructions landed ~0.5 s after "TOOLS DONE").
 */
const DEFAULT_LIVE_SETTLE_TIMEOUT_MS = 90_000;
const LIVE_SETTLE_TIMEOUT_MS = Number.parseInt(
  process.env.SAM_STAGING_LIVE_SETTLE_TIMEOUT_MS ?? String(DEFAULT_LIVE_SETTLE_TIMEOUT_MS),
  10
);
const DEFAULT_LIVE_POLL_INTERVAL_MS = 3_000;
const LIVE_POLL_INTERVAL_MS = Number.parseInt(
  process.env.SAM_STAGING_LIVE_POLL_INTERVAL_MS ?? String(DEFAULT_LIVE_POLL_INTERVAL_MS),
  10
);

/**
 * The completion marker must be read from ASSISTANT output only.
 *
 * The prompt itself says "Then reply with exactly: TOOLS DONE", so a document-wide
 * `getByText(LIVE_DONE_MARKER)` matches the USER's bubble the instant the page paints.
 * That is what broke the first live run: phase 1 saw "done" before a single tool had
 * run, and phase 2 then passed on the prompt echo. The observation has to come from the
 * agent (`.claude/rules/62`).
 */
function assistantDoneMarker(page: Page) {
  return page.locator('.glass-msg-assistant', { hasText: LIVE_DONE_MARKER });
}

/**
 * Server-side activity values that mean the turn is still running.
 *
 * `SessionStateSnapshot['activity']` is `idle | prompting | recovering | error |
 * stopped` (`apps/web/src/lib/api/sessions.ts`) — there is no `responding`, which
 * is a client-only derivation. So anything outside this set means the agent is no
 * longer working.
 */
const SERVER_WORKING_ACTIVITY = new Set(['prompting', 'recovering']);

const GROUP = '[data-testid="tool-call-group"]';
const GLYPH = '[data-testid="tool-group-glyph"]';
/** Accessible-name shape of a group header, whatever the count turns out to be. */
const GROUP_HEADER_NAME = /^\d+ tool calls?/;

// ---------------------------------------------------------------------------
// Expected-shape derivation from the real rows
// ---------------------------------------------------------------------------

/** What the in-page observer records the first time a row flashes highlighted. */
interface HighlightObservation {
  landedOnGroup: boolean;
  label: string;
  rect: { top: number; bottom: number; left: number; right: number };
  viewport: { w: number; h: number };
}

declare global {
  // eslint-disable-next-line no-var
  var __samHighlight: HighlightObservation | undefined;
}

interface StagingMessage {
  id: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
}

/*
 * The grouping rules are reimplemented here instead of imported from
 * `src/components/project-message-view/tool-call-groups.ts`.
 *
 * That is not a preference: importing it pulls in `types.ts` →
 * `src/lib/api/client.ts:7`, which reads `import.meta.env.VITE_API_URL` at module
 * scope. Playwright's loader is plain Node with no Vite define step, so
 * `import.meta.env` is `undefined` and the import throws
 * "Cannot read properties of undefined (reading 'VITE_API_URL')" at collection
 * time — verified by probe on 2026-09-17. The unit suite (`vitest`, which DOES
 * run through Vite) is where the real functions are exercised; this derivation
 * exists only to keep the staging expectations honest about whatever rows the
 * session currently holds.
 */

/** Delimiter-agnostic last segment, mirroring `normalizeToolName`. */
function normalizeToolName(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  const segments = toolName.split(/__|\/|\.|:/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : toolName;
}

const DOCUMENT_CARD_TOOLS = new Set([
  'upload_to_library',
  'replace_library_file',
  'display_from_library',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Best-effort read of the MCP result payload, mirroring `parseResultPayload`. */
function resultPayload(rawOutput: unknown): Record<string, unknown> | null {
  if (Array.isArray(rawOutput)) {
    for (const block of rawOutput) {
      const record = asRecord(block);
      if (record && typeof record.text === 'string') {
        try {
          const parsed: unknown = JSON.parse(record.text);
          const payload = asRecord(parsed);
          if (payload) return payload;
        } catch {
          // Not JSON — try the next block.
        }
      }
    }
    return null;
  }
  if (typeof rawOutput === 'string') {
    try {
      return asRecord(JSON.parse(rawOutput));
    } catch {
      return null;
    }
  }
  return asRecord(rawOutput);
}

/**
 * Whether a tool row renders as a typed DocumentCard, which grouping must NOT
 * absorb. Mirrors `matchToolCard` → `extractDocumentCardData`: the name must be a
 * library tool AND the payload must yield something renderable (a fileId, a
 * FILE_NOT_FOUND tombstone, or a call still in flight).
 */
function isTypedDocumentCard(meta: Record<string, unknown>): boolean {
  const name = typeof meta.toolName === 'string' ? meta.toolName : undefined;
  const title = typeof meta.title === 'string' ? meta.title : undefined;
  const base = normalizeToolName(name ?? title);
  if (!base || !DOCUMENT_CARD_TOOLS.has(base)) return false;

  const input = asRecord(meta.rawInput) ?? {};
  const payload = resultPayload(meta.rawOutput) ?? {};
  const existing = asRecord(payload.existingFile) ?? payload;
  const hasFileId =
    typeof existing.id === 'string' ||
    typeof existing.fileId === 'string' ||
    typeof input.fileId === 'string';
  const status = typeof meta.status === 'string' ? meta.status : '';
  return (
    hasFileId ||
    payload.error === 'FILE_NOT_FOUND' ||
    status === 'pending' ||
    status === 'in_progress'
  );
}

type DerivedItem =
  | { kind: 'tool_call'; toolCallId: string; typed: boolean }
  | { kind: 'thinking' }
  | { kind: 'other' };

/**
 * Reduce raw rows to the display shape the chat renders, then report the size of
 * every `tool_call_group` in order.
 *
 * Mirrors `chatMessagesToConversationItems` (tool rows merge by `toolCallId`,
 * consecutive thinking/assistant rows merge) followed by `groupToolCallItems`
 * (a maximal run of absorbable items containing at least one tool call becomes
 * one group; typed document cards and everything else break the run).
 */
function deriveExpectedGroups(messages: StagingMessage[]): number[] {
  const items: DerivedItem[] = [];
  const toolCallIndex = new Map<string, number>();

  for (const msg of messages) {
    if (msg.role === 'tool') {
      const meta = msg.toolMetadata ?? {};
      const toolCallId =
        typeof meta.toolCallId === 'string' && meta.toolCallId ? meta.toolCallId : msg.id;
      const existing = toolCallIndex.get(toolCallId);
      if (existing !== undefined) {
        // A status-only update merges into the row that created the call, which
        // keeps its ORIGINAL position — it never appends a new display item.
        const item = items[existing];
        if (item?.kind === 'tool_call' && isTypedDocumentCard(meta)) item.typed = true;
        continue;
      }
      toolCallIndex.set(toolCallId, items.length);
      items.push({ kind: 'tool_call', toolCallId, typed: isTypedDocumentCard(meta) });
      continue;
    }
    if (msg.role === 'thinking') {
      if (items[items.length - 1]?.kind !== 'thinking') items.push({ kind: 'thinking' });
      continue;
    }
    if (msg.role === 'assistant') {
      // Consecutive assistant chunks merge, but any assistant item is a boundary
      // either way, so one 'other' per run is enough.
      if (items[items.length - 1]?.kind !== 'other') items.push({ kind: 'other' });
      continue;
    }
    items.push({ kind: 'other' });
  }

  const sizes: number[] = [];
  let run: DerivedItem[] = [];
  const flush = () => {
    const toolCalls = run.filter((item) => item.kind === 'tool_call').length;
    if (toolCalls > 0) sizes.push(toolCalls);
    run = [];
  };
  for (const item of items) {
    const absorbable = item.kind === 'thinking' || (item.kind === 'tool_call' && !item.typed);
    if (absorbable) {
      run.push(item);
      continue;
    }
    flush();
  }
  flush();
  return sizes;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function fetchSessionMessages(page: Page): Promise<StagingMessage[]> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}?limit=500`
  );
  expect(res.status(), `session fetch failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { messages?: StagingMessage[] };
  return body.messages ?? [];
}

/**
 * The session's own activity snapshot — the authoritative "is the turn over"
 * signal, and the same one the UI hydrates from (`getChatSessionState`,
 * `GET …/sessions/:id/state`).
 *
 * Chosen over the composer placeholder: that string is derived from the CLIENT's
 * `agentActivity`, which lags behind through the verify-before-decay timer, and it
 * has five branches whose non-working text differs by session state
 * (`index.tsx:779`) — brittle to assert on, and a lagging signal is exactly what
 * this poll must not wait on. Returns null when the DO holds no snapshot.
 */
async function sessionActivity(page: Page, sessionId: string): Promise<string | null> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${PROJECT_ID}/sessions/${sessionId}/state`
  );
  if (res.status() !== 200) return null;
  const body = (await res.json()) as { state?: { activity?: string } | null };
  return body.state?.activity ?? null;
}

/** Role histogram for a session, for failure reports. */
async function roleCounts(page: Page, sessionId: string): Promise<string> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${PROJECT_ID}/sessions/${sessionId}?limit=500`
  );
  if (res.status() !== 200) return `session fetch returned ${res.status()}`;
  const body = (await res.json()) as { messages?: StagingMessage[] };
  const counts = new Map<string, number>();
  for (const msg of body.messages ?? []) {
    counts.set(msg.role, (counts.get(msg.role) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([role, n]) => `${role}=${n}`);
  return parts.length > 0 ? parts.join(' ') : 'no messages';
}

async function openFixtureSession(page: Page, query = ''): Promise<void> {
  await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/chat/${SESSION_ID}${query}`);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await dismissStagingOnboarding(page);
  // The conversation mounts at the last item, so an assistant bubble is the
  // first thing that must exist before anything else is measured.
  await expect(page.locator('.glass-msg-assistant').first()).toBeVisible({ timeout: 45_000 });
}

/**
 * Bring a group row into the mounted window.
 *
 * Real Virtuoso mounts at the LAST item with a 200px overscan, and the tool rows
 * sit in the middle of a 33-message conversation, so a group is usually NOT
 * mounted on first paint. Scrolling with the wheel over the conversation region
 * avoids coupling to react-virtuoso's internal test ids.
 */
async function scrollToFirstGroup(page: Page): Promise<boolean> {
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log).toBeVisible({ timeout: 30_000 });
  const box = await log.boundingBox();
  expect(box, 'conversation log must be laid out').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

  for (let step = 0; step < 24; step += 1) {
    if ((await page.locator(GROUP).count()) > 0) return true;
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(250);
  }
  return (await page.locator(GROUP).count()) > 0;
}

/**
 * Blocking, SUBTREE-scoped clipped-overflow check for the activity card.
 *
 * `assertNoOverflow` runs the document-wide walk in advisory mode (it prints
 * offenders; see `findClippedOverflow`'s rollout note), which cannot fail on the
 * card but also cannot prove the card is clean. Scoping the same rule to the
 * card's own subtree makes it blocking for THIS surface without importing the
 * unrelated app-chrome debt that keeps the document-wide sweep advisory.
 */
async function assertGroupCardNotClipped(page: Page): Promise<void> {
  const offenders = await page.evaluate((groupSelector: string) => {
    const found: string[] = [];
    for (const card of Array.from(document.querySelectorAll(groupSelector))) {
      for (const el of [card, ...Array.from(card.querySelectorAll('*'))]) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
        if (style.textOverflow === 'ellipsis') continue;
        if (el.clientWidth <= 1) continue;
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        found.push(
          `<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 80)}"> ` +
            `content ${el.scrollWidth}px clipped to ${el.clientWidth}px`
        );
      }
    }
    return found;
  }, GROUP);
  expect(offenders, `Clipped content inside the activity card:\n${offenders.join('\n')}`).toEqual(
    []
  );
}

/**
 * The per-call card to click: the known `Read file …` call when it is mounted,
 * otherwise the first button inside `group` that is not the group header.
 */
async function pickPerCallButton(
  page: Page,
  group: Locator
): Promise<{ button: Locator; label: string } | null> {
  const known = page.getByRole('button', { name: READ_TOOL_TITLE });
  if ((await known.count()) > 0) return { button: known.first(), label: READ_TOOL_TITLE };

  const buttons = group.getByRole('button');
  const total = await buttons.count();
  for (let i = 0; i < total; i += 1) {
    const candidate = buttons.nth(i);
    const label = (await candidate.innerText()).trim();
    if (GROUP_HEADER_NAME.test(label)) continue;
    return { button: candidate, label: label.split('\n')[0] ?? label };
  }
  return null;
}

async function glyphStates(page: Page): Promise<Array<string | null>> {
  return page.locator(GLYPH).evaluateAll((els) => els.map((el) => el.getAttribute('data-state')));
}

// ---------------------------------------------------------------------------
// Read-only verification against the existing session
// ---------------------------------------------------------------------------

test.describe('Staging — tool activity cards', () => {
  test('groups are collapsed by default and hide their per-call cards', async ({ page }) => {
    await stagingLogin(page);
    const messages = await fetchSessionMessages(page);
    const expectedSizes = deriveExpectedGroups(messages);
    test.skip(
      expectedSizes.length === 0,
      `Fixture session ${SESSION_ID} no longer contains a groupable tool run`
    );
    test.info().annotations.push({
      type: 'derived-groups',
      description: `${expectedSizes.length} group(s), sizes [${expectedSizes.join(', ')}] from ${messages.length} rows`,
    });

    await openFixtureSession(page);

    // Liveness first: the prose the grouping exists to surface must be readable.
    const bubble = page.locator('.glass-msg-assistant').first();
    await expect(bubble).toBeVisible();
    expect((await bubble.innerText()).trim().length).toBeGreaterThan(0);

    await assertNoOverflow(page);
    await stagingShot(page, 'staging-tool-group-conversation-tail');

    const found = await scrollToFirstGroup(page);
    expect(found, 'no activity card was reachable by scrolling the conversation').toBe(true);

    // Whatever is mounted must be collapsed, must be labelled by its count, and
    // its count must be one the real rows can actually produce.
    const groups = page.locator(GROUP);
    const mounted = await groups.count();
    expect(mounted).toBeGreaterThan(0);
    const mountedSizes: number[] = [];
    for (let i = 0; i < mounted; i += 1) {
      const header = groups.nth(i).getByRole('button', { name: GROUP_HEADER_NAME });
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      const name = (await header.innerText()).trim();
      const match = /^(\d+) tool calls?/.exec(name);
      expect(match, `group header "${name}" does not state a tool-call count`).not.toBeNull();
      mountedSizes.push(Number(match![1]));
    }
    for (const size of mountedSizes) {
      expect(
        expectedSizes,
        `rendered group of ${size} is not derivable from the real rows`
      ).toContain(size);
    }

    // The per-call title must be behind the disclosure, not merely de-emphasised.
    await expect(page.getByText(READ_TOOL_TITLE)).toHaveCount(0);

    await assertGroupCardNotClipped(page);
    await assertNoOverflow(page);
    await stagingShot(page, 'staging-tool-group-collapsed');
  });

  test('expanding a group reveals its calls and one loads its output for real', async ({
    page,
  }) => {
    await stagingLogin(page);
    await openFixtureSession(page);
    const found = await scrollToFirstGroup(page);
    expect(found, 'no activity card was reachable by scrolling the conversation').toBe(true);

    const groups = page.locator(GROUP);
    const firstHeader = groups.first().getByRole('button', { name: GROUP_HEADER_NAME });
    await firstHeader.click();
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'true');

    // Level 2 is the existing ToolCallCard: its header is a role=button too, so
    // an expanded group holds strictly more buttons than its own header.
    await expect
      .poll(async () => groups.first().getByRole('button').count(), { timeout: 15_000 })
      .toBeGreaterThan(1);

    /*
     * Prefer the known `Read file …` call so the assertion names a specific tool,
     * but do not require it: whether that call lands in the FIRST group depends on
     * what sits between the two calls in this session, and the lazy-load path is
     * proved by any per-call card.
     */
    if ((await page.getByRole('button', { name: READ_TOOL_TITLE }).count()) === 0) {
      const mounted = await groups.count();
      for (let i = 1; i < mounted; i += 1) {
        const header = groups.nth(i).getByRole('button', { name: GROUP_HEADER_NAME });
        await header.click();
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        if ((await page.getByRole('button', { name: READ_TOOL_TITLE }).count()) > 0) break;
      }
    }
    const picked = await pickPerCallButton(page, groups.first());
    expect(picked, 'no per-call card was exposed by any expanded group').not.toBeNull();
    test.info().annotations.push({ type: 'tool-call-clicked', description: picked!.label });

    const callButton = picked!.button;
    // The per-call card is the button's parent; its text grows when output lands.
    const card = callButton.locator('xpath=..');
    const before = (await card.innerText()).trim();

    // The lazy fetch must be a REAL request, so arm the wait before the click.
    const requestPromise = page.waitForRequest('**/messages/*/tool-content', { timeout: 30_000 });
    await callButton.first().click();
    const request = await requestPromise;
    const response = await request.response();
    expect(response, 'tool-content request produced no response').not.toBeNull();
    expect(response!.status(), `tool-content failed: ${request.url()}`).toBe(200);

    // The error state is a failure, not an acceptable outcome.
    await expect(page.getByText('Failed to load content.')).toHaveCount(0);

    // Either real output rendered, or the honest "No output." fallback did.
    let outcome = '';
    await expect
      .poll(
        async () => {
          if ((await page.getByText('No output.').count()) > 0) {
            outcome = 'no-output-fallback';
            return true;
          }
          const after = (await card.innerText()).trim();
          if (after.length > before.length) {
            outcome = 'output-rendered';
            return true;
          }
          return false;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    test.info().annotations.push({ type: 'tool-content-outcome', description: outcome });

    await assertGroupCardNotClipped(page);
    await assertNoOverflow(page);
    await stagingShot(page, 'staging-tool-group-expanded');
  });

  test('a deep link to an absorbed tool row lands on and highlights the group', async ({
    page,
  }) => {
    await stagingLogin(page);
    test.info().annotations.push({
      type: 'deep-link-target',
      description: `${ABSORBED_TOOL_MESSAGE_ID} (a tool_call_update row — the item's messageId, not its id)`,
    });

    /*
     * `.sam-message-highlight` self-clears after ~2.2 s (the flash animation), and
     * `openFixtureSession` spends up to 2 s in the onboarding probe plus a bubble
     * wait BEFORE any assertion could run — so polling from Playwright races the
     * animation and a SUCCESSFUL jump can read as a failure.
     *
     * Record the flash inside the page instead, from a `MutationObserver`
     * installed before any app script runs: that observes the event the way
     * production produces it (`.claude/rules/62`) and captures the geometry at the
     * moment it happens rather than whenever the test next gets a turn.
     */
    await page.addInitScript(() => {
      const record = (el: Element) => {
        if (globalThis.__samHighlight) return;
        const group = el.querySelector('[data-testid="tool-call-group"]');
        const box = el.getBoundingClientRect();
        globalThis.__samHighlight = {
          landedOnGroup: group !== null,
          label: (group?.textContent ?? el.textContent ?? '').trim().slice(0, 60),
          rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
          viewport: { w: window.innerWidth, h: window.innerHeight },
        };
      };
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          // Path A: an already-mounted row GAINS the class. This is the fallback
          // case (the jump target was the last row, so it was never unmounted).
          const el = mutation.target as Element;
          if (el.classList?.contains('sam-message-highlight')) record(el);

          /*
           * Path B: the row is INSERTED with the class already on it — the success
           * case, and the one the attribute filter alone can never see. The jump
           * target sits mid-conversation while Virtuoso mounts at the bottom, so
           * `scrollToIndex` + `highlightedRowId` mount that row FRESH with
           * `sam-message-highlight` already in its className. No attribute ever
           * changes, so an attributes-only observer reports nothing and a
           * successful jump reads as "no row ever flashed highlighted".
           */
          for (const node of Array.from(mutation.addedNodes)) {
            const added = node as Element;
            if (added.matches?.('.sam-message-highlight')) {
              record(added);
              continue;
            }
            const nested = added.querySelectorAll?.('.sam-message-highlight');
            if (nested && nested.length > 0) record(nested[0]!);
          }
        }
      });
      const start = () =>
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class'],
        });
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start);
    });

    await openFixtureSession(page, `?commentMessage=${ABSORBED_TOOL_MESSAGE_ID}`);

    const highlight = await page
      .waitForFunction(() => globalThis.__samHighlight, null, { timeout: 15_000 })
      .then((handle) => handle.jsonValue());

    expect(highlight, 'no row ever flashed highlighted').toBeTruthy();
    expect(highlight!.landedOnGroup, `highlighted row was "${highlight!.label}"`).toBe(true);
    expect(highlight!.label).toMatch(GROUP_HEADER_NAME);
    // The jump must actually land: the group has to intersect the viewport AT THE
    // MOMENT OF THE FLASH, not merely exist in the DOM (rule 17, virtualized-list
    // section).
    expect(highlight!.rect.bottom).toBeGreaterThan(0);
    expect(highlight!.rect.top).toBeLessThan(highlight!.viewport.h);
    expect(highlight!.rect.right).toBeGreaterThan(0);
    expect(highlight!.rect.left).toBeLessThan(highlight!.viewport.w);

    // Taken after the assertions, so the 2.2 s flash is already gone — this shot
    // documents where the jump LANDED, not the highlight itself.
    await stagingShot(page, 'staging-tool-group-deep-link');
  });
});

// ---------------------------------------------------------------------------
// Live run — acceptance A2 ("something is happening")
// ---------------------------------------------------------------------------

/*
 * A separate describe because this one creates real staging work: it starts an
 * Instant (cf-container) session, waits for the agent to run shell tools, and
 * stops it again. Opt-in only, and it needs a budget larger than the read-only
 * tests: the poll alone can run for LIVE_RUN_TIMEOUT_MS twice (running, then
 * settled) on top of login, session start and two navigations.
 */
test.describe('Staging — tool activity cards, live run', () => {
  test.describe.configure({ timeout: LIVE_RUN_TIMEOUT_MS * 2 + 120_000 });

  test.skip(
    process.env.SAM_STAGING_LIVE_TOOL_GROUP !== '1',
    'Creates a real Instant container: set SAM_STAGING_LIVE_TOOL_GROUP=1 to run'
  );

  test('the card shows a motion indicator while tools run, then settles', async ({ page }) => {
    await stagingLogin(page);

    /*
     * Same endpoint and payload the composer uses for an Instant chat
     * (`useProjectChatState.ts:722` → `startInstantChatSession`): the runtime is
     * resolved server-side FROM THE PROFILE, and `POST /sessions/start` rejects a
     * profile that resolves to a VM with 409. There is no `lightweight` or
     * `taskMode` field on this endpoint.
     */
    const startRes = await page.request.post(
      `${STAGING_API}/api/projects/${PROJECT_ID}/sessions/start`,
      {
        data: { message: LIVE_PROMPT, agentProfileId: LIVE_AGENT_PROFILE_ID },
        headers: { 'Content-Type': 'application/json' },
        timeout: 120_000,
      }
    );
    expect(startRes.status(), `session start failed: ${await startRes.text()}`).toBeLessThan(300);
    const started = (await startRes.json()) as {
      sessionId?: string;
      runtime?: { runtime?: string };
    };
    // Guard against a profile change quietly turning this into a VM provision.
    expect(started.runtime?.runtime, 'live run must stay on the cf-container runtime').toBe(
      'cf-container'
    );
    const liveSessionId = started.sessionId;
    expect(liveSessionId, 'session start returned no sessionId').toBeTruthy();

    let stopStatus: number | null = null;
    let runningObserved = false;

    try {
      await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/chat/${liveSessionId}`);
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await dismissStagingOnboarding(page);

      /*
       * Control for the scoping above: the marker IS on the page from the first
       * paint (the prompt echoes it) while the assistant-scoped locator is still
       * empty. If this ever inverts, phase 2 has stopped discriminating and is
       * passing on the echo again.
       */
      await expect(page.locator('.glass-msg-user', { hasText: LIVE_DONE_MARKER })).toHaveCount(1);
      expect(
        await assistantDoneMarker(page).count(),
        'the agent cannot have answered before it has run'
      ).toBe(0);

      // Phase 1: catch the motion indicator at least once. A fast run can finish
      // inside a single poll interval, which is recorded rather than failed.
      const runningDeadline = Date.now() + LIVE_RUN_TIMEOUT_MS;
      while (Date.now() < runningDeadline) {
        if ((await page.locator(`${GLYPH}[data-state="running"]`).count()) > 0) {
          runningObserved = true;
          await stagingShot(page, 'staging-tool-group-live-running');
          break;
        }
        if ((await assistantDoneMarker(page).count()) > 0) break;
        await page.waitForTimeout(LIVE_POLL_INTERVAL_MS);
      }
      test.info().annotations.push({
        type: 'running_observed',
        description: String(runningObserved),
      });

      // Phase 2: the run completes and the agent says so.
      await expect
        .poll(async () => assistantDoneMarker(page).count(), {
          timeout: LIVE_RUN_TIMEOUT_MS,
          intervals: [LIVE_POLL_INTERVAL_MS],
        })
        .toBeGreaterThan(0);

      // Phase 3: every card that ran has settled. Scrolling first because the
      // tail after completion is the agent's text, and the group above it can sit
      // outside Virtuoso's mounted window.
      const found = await scrollToFirstGroup(page);
      if (!found) {
        // Say whether tool rows existed at all, so a failure report separates
        // "the agent never called a tool" from "the card did not render".
        test.info().annotations.push({
          type: 'live-session-roles',
          description: await roleCounts(page, liveSessionId!),
        });
      }
      expect(found, 'the live run produced no activity card').toBe(true);
      /*
       * The assistant's marker is NOT the end of the turn, so a single-shot read
       * here asserts too early: the first live run made one more tool call after
       * its closing text, and that second tail group was legitimately `running`
       * when the assertion fired ("glyph states after completion: done, running").
       *
       * Poll until the rendered glyphs AND the session's own activity snapshot
       * agree the turn is over. Re-scroll each iteration because `followOutput`
       * pulls the list back to the bottom whenever another row arrives, which can
       * unmount the group again; `scrollToFirstGroup` returns immediately when one
       * is already mounted, so this is cheap after the first pass.
       */
      const settleStartedAt = Date.now();
      let lastStates: Array<string | null> = [];
      let lastActivity: string | null = null;
      try {
        await expect
          .poll(
            async () => {
              await scrollToFirstGroup(page);
              lastStates = await glyphStates(page);
              lastActivity = await sessionActivity(page, liveSessionId!);
              // `length > 0` is the liveness half: "every glyph settled" is also
              // satisfied by no glyphs at all (`.claude/rules/62`).
              const glyphsSettled =
                lastStates.length > 0 &&
                lastStates.every((state) => state === 'done' || state === 'failed');
              const turnEnded = lastActivity !== null && !SERVER_WORKING_ACTIVITY.has(lastActivity);
              return glyphsSettled && turnEnded;
            },
            { timeout: LIVE_SETTLE_TIMEOUT_MS, intervals: [LIVE_POLL_INTERVAL_MS] }
          )
          .toBe(true);
      } finally {
        // Annotated on failure too — the last run failed with no record of what it
        // had actually observed, which is why this exists.
        test.info().annotations.push({
          type: 'live-settle-result',
          description: `glyphs=[${lastStates.join(', ')}] activity=${lastActivity} after ${Date.now() - settleStartedAt}ms`,
        });
      }

      await assertGroupCardNotClipped(page);
      await assertNoOverflow(page);
      await stagingShot(page, 'staging-tool-group-live-settled');
    } finally {
      /*
       * Always stop the session, even on failure — an abandoned Instant container
       * costs real money and the next run would inherit a dirty environment.
       * Same endpoint the dock uses (`stopChatSession`).
       */
      const stopRes = await page.request.post(
        `${STAGING_API}/api/projects/${PROJECT_ID}/sessions/${liveSessionId}/stop`,
        { headers: { 'Content-Type': 'application/json' }, timeout: 60_000 }
      );
      stopStatus = stopRes.status();
      test.info().annotations.push({
        type: 'staging-cleanup',
        description: `stop ${liveSessionId} -> ${stopStatus}`,
      });
    }

    expect(
      stopStatus,
      'cleanup must succeed so no Instant container is left running'
    ).toBeGreaterThanOrEqual(200);
    expect(stopStatus!).toBeLessThan(300);
  });
});
