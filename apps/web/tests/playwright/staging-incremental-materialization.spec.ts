/**
 * Staging verification for incremental search materialization on session sleep.
 *
 * The defect: every streaming token is its own `chat_messages` row, so no raw row
 * holds a whole word and a multi-word query cannot match one. The grouped/FTS
 * index that fixes that only ran when a session terminalized, so sleeping
 * sessions — most recent work — were unsearchable.
 *
 * The discriminating assertion is NOT "some word is findable". It is that a token
 * which exists in **no single raw row** is findable — such a token can only come
 * from the grouped index, so a hit proves materialization ran. The spec derives
 * that token from the session's own output rather than assuming the agent echoes
 * a sentinel cleanly: on the 2026-09-21 run the agent's reply was concatenated
 * with adjacent text into `vestigialmuaterilIMPORTANT`, which a sentinel-equality
 * assertion would have read as a product failure when it was a fixture artifact.
 *
 * `ProjectData.searchMessages` is reachable only through the MCP `search_messages`
 * tool — the surface the bug was reported on — and that tool is scoped by the
 * token's PROJECT, not its workspace. The staging smoke user owns the project the
 * existing tokens belong to, so one pre-existing token (resolved out of band from
 * the staging KV `mcp:` prefix) can search a session this spec creates.
 *
 * Required env: SAM_STAGING_PROJECT_ID, SAM_STAGING_PROFILE_ID (a cf-container
 * profile — `/sessions/start` is Instant-only and 409s on a VM profile),
 * SAM_STAGING_MCP_TOKEN.
 *
 * Run: pnpm exec playwright test staging-incremental-materialization --project="Desktop (1280x800)"
 *
 * OPERATOR-RUN, NOT CI. `select-playwright-visual-audits.ts` refuses `staging-*`
 * specs by design. This one drives a real Instant container and a real LLM on a
 * shared staging environment, so it inherits their reliability: across four runs
 * on 2026-09-21 it was blocked once by a VM-runtime profile (fixed by
 * `SAM_STAGING_PROFILE_ID`), once by the agent not echoing a sentinel (fixed by
 * deriving the discriminator from whatever the agent actually wrote), twice by
 * the idle gate rejecting an early sleep (fixed by retrying on 409), and once by
 * the container never producing a second assistant row at all — which no spec
 * change can fix. Treat a failure here as "re-run and read the message" before
 * treating it as a product defect.
 *
 * The 2026-09-21 verification of this change was carried out step by step against
 * these same endpoints; this spec encodes that procedure for repeatability.
 */
import { expect, type Page, test } from '@playwright/test';

import { STAGING_API, STAGING_APP, stagingLogin } from './staging-helpers';

const RUN_ID = Date.now().toString(36);
/**
 * Only the FOLLOW-UP needs a sentinel, and it is the USER's own message — it is
 * persisted synchronously, so unlike an agent reply it is deterministic.
 */
const SECOND_SENTINEL = `cromulent${RUN_ID}`;

const TURN_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 5_000;

interface SearchHit {
  messageId: string;
  sessionId: string;
  role: string;
  snippet: string;
}

interface RawMessage {
  id: string;
  role: string;
  content: string;
}

async function callMcp(
  page: Page,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await page.request.post(`${STAGING_API}/mcp`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status(), `${name} HTTP: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as {
    error?: unknown;
    result?: { content?: Array<{ text?: string }> };
  };
  expect(body.error, `${name} JSON-RPC error: ${JSON.stringify(body.error)}`).toBeUndefined();
  const text = body.result?.content?.[0]?.text;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function searchMessages(
  page: Page,
  token: string,
  query: string,
  sessionId: string
): Promise<SearchHit[]> {
  const parsed = await callMcp(page, token, 'search_messages', { query, sessionId, limit: 20 });
  return (parsed.results as SearchHit[] | undefined) ?? [];
}

/** Raw `chat_messages` rows — one per streaming token, not grouped. */
async function readRawRows(page: Page, projectId: string, sessionId: string): Promise<RawMessage[]> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}/messages?limit=800`
  );
  expect(res.status(), `messages HTTP: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { messages?: RawMessage[] }).messages ?? [];
}

/** The same rows after consecutive same-role tokens are concatenated. */
async function readGroupedAssistantText(
  page: Page,
  token: string,
  sessionId: string
): Promise<string> {
  const parsed = await callMcp(page, token, 'get_session_messages', { sessionId, limit: 200 });
  const messages = (parsed.messages as RawMessage[] | undefined) ?? [];
  return messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n');
}

/**
 * Wait until the agent has streamed enough assistant tokens to group.
 *
 * Deliberately does NOT wait for a specific sentinel. An LLM may paraphrase,
 * tool-call first, or answer in a different shape, and a fixture that depends on
 * exact echo fails for reasons that have nothing to do with materialization —
 * observed on the 2026-09-21 re-run, where the agent produced 152 rows without
 * echoing the requested word. What this spec needs is only that consecutive
 * assistant rows exist to be concatenated.
 */
async function waitForStreamedAssistantRows(
  page: Page,
  projectId: string,
  sessionId: string,
  minRows: number
): Promise<RawMessage[]> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let rows: RawMessage[] = [];
  while (Date.now() < deadline) {
    rows = await readRawRows(page, projectId, sessionId);
    if (rows.filter((m) => m.role === 'assistant').length >= minRows) return rows;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(
    `agent produced fewer than ${minRows} assistant rows in ${TURN_TIMEOUT_MS}ms (${rows.length} rows total)`
  );
}

/**
 * Pick a token from the grouped assistant text that appears in NO single raw row.
 *
 * That token is the discriminator: it exists only because materialization
 * concatenated adjacent streaming rows, so a search hit on it cannot be satisfied
 * by the raw-row LIKE fallback.
 */
function pickGroupOnlyToken(groupedText: string, rawRows: RawMessage[]): string | null {
  const candidates = groupedText.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 12);
  for (const candidate of candidates) {
    if (!rawRows.some((row) => row.content.includes(candidate))) return candidate;
  }
  return null;
}

/** Retry `sleep` until the session is idle enough for the control plane to accept it. */
async function sleepWhenIdle(page: Page, workspaceId: string): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastBody = '';
  while (Date.now() < deadline) {
    const res = await page.request.post(`${STAGING_API}/api/workspaces/${workspaceId}/sleep`);
    if (res.status() < 400) return;
    lastBody = await res.text();
    // A 409 from sleep is always an eligibility conflict, and the control plane
    // has several phrasings for it ("Harness-owned background work is active",
    // "Workspace agent is not idle (prompting)", ...). Matching the text is
    // brittle; the status is the contract. Anything else is a real failure.
    if (res.status() !== 409) {
      throw new Error(`sleep failed with ${res.status()}: ${lastBody}`);
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(`session never became sleep-eligible in ${TURN_TIMEOUT_MS}ms: ${lastBody}`);
}

test.describe('incremental materialization on staging', () => {
  test.describe.configure({ mode: 'serial', timeout: 25 * 60_000 });

  test('a sleeping session is searchable, and the tail written after it is too', async ({
    page,
  }) => {
    await stagingLogin(page);
    await page.goto(STAGING_APP);

    const projectId = process.env.SAM_STAGING_PROJECT_ID;
    const profileId = process.env.SAM_STAGING_PROFILE_ID;
    const mcpToken = process.env.SAM_STAGING_MCP_TOKEN;
    expect(projectId, 'set SAM_STAGING_PROJECT_ID').toBeTruthy();
    expect(profileId, 'set SAM_STAGING_PROFILE_ID to a cf-container profile').toBeTruthy();
    expect(mcpToken, 'set SAM_STAGING_MCP_TOKEN').toBeTruthy();

    const startRes = await page.request.post(
      `${STAGING_API}/api/projects/${projectId}/sessions/start`,
      {
        data: {
          message: 'Write one short paragraph about why incremental indexing matters.',
          agentProfileId: profileId,
        },
      }
    );
    expect(startRes.status(), `chat start: ${await startRes.text()}`).toBeLessThan(400);
    const started = (await startRes.json()) as { sessionId?: string; workspaceId?: string };
    const sessionId = started.sessionId!;
    const workspaceId = started.workspaceId!;
    // eslint-disable-next-line no-console
    console.log(`[staging] sessionId=${sessionId} workspaceId=${workspaceId}`);

    // Two consecutive assistant rows are the minimum that can produce a token
    // spanning a row boundary, which is what the discriminator below needs.
    await waitForStreamedAssistantRows(page, projectId!, sessionId, 2);

    // --- Sleep: the transition this feature hooks ----------------------------
    // Sleep is gated on the session being idle ("Harness-owned background work is
    // active" 409s while the turn is still streaming), so poll the way a user
    // clicking Sleep would have to.
    await sleepWhenIdle(page, workspaceId);

    const rawAfterFirst = await readRawRows(page, projectId!, sessionId);
    const groupedAfterFirst = await readGroupedAssistantText(page, mcpToken!, sessionId);
    const groupOnlyToken = pickGroupOnlyToken(groupedAfterFirst, rawAfterFirst);
    expect(
      groupOnlyToken,
      'no token spans a raw-row boundary — the fixture cannot discriminate'
    ).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`[staging] rawRows=${rawAfterFirst.length} groupOnlyToken=${groupOnlyToken}`);

    // THE assertion: a token that exists in no raw row is findable, so the hit
    // can only come from the grouped index built while the session was asleep.
    const afterSleep = await searchMessages(page, mcpToken!, groupOnlyToken!, sessionId);
    expect(
      afterSleep.filter((h) => h.role === 'assistant').length,
      'grouped assistant text from a SLEEPING session must be searchable'
    ).toBeGreaterThanOrEqual(1);

    // --- Write past the watermark --------------------------------------------
    const promptRes = await page.request.post(
      `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}/prompt`,
      { data: { content: `Reply with exactly this word and nothing else: ${SECOND_SENTINEL}` } }
    );
    expect(promptRes.status(), `prompt: ${await promptRes.text()}`).toBeLessThan(400);

    // The follow-up is persisted immediately, past the watermark the sleep set.
    // It is not in the FTS index yet, so finding it proves `searchMessagesLike`
    // still reaches the unindexed tail of an already-materialized session — the
    // regression this change would otherwise have introduced.
    const tail = await searchMessages(page, mcpToken!, SECOND_SENTINEL, sessionId);
    expect(
      tail.length,
      'the tail written after a sleep must stay reachable through the raw-message fallback'
    ).toBeGreaterThanOrEqual(1);

    // --- Terminalize: a SECOND pass over the same session ---------------------
    const stopRes = await page.request.post(
      `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}/stop`,
      { data: {} }
    );
    expect(stopRes.status(), `stop: ${await stopRes.text()}`).toBeLessThan(400);

    // The second pass must index the tail AND must not duplicate the head. The
    // old `materialized_at IS NOT NULL` gate made this pass a no-op entirely.
    const tailAfterStop = await searchMessages(page, mcpToken!, SECOND_SENTINEL, sessionId);
    expect(tailAfterStop.length).toBeGreaterThanOrEqual(1);
    const headAfterStop = await searchMessages(page, mcpToken!, groupOnlyToken!, sessionId);
    expect(headAfterStop.length, 'head must remain indexed exactly once').toBe(1);
  });
});
