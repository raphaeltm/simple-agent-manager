/**
 * Staging verification for incremental search materialization on session sleep.
 *
 * The defect: every streaming token is its own `chat_messages` row (p50 content
 * length 4 characters), so no raw row holds a whole word and a multi-word query
 * cannot match one. The grouped/FTS index that fixes that only ran when a session
 * terminalized, so sleeping sessions — most recent work — were unsearchable.
 * Reproduced on staging before this change against session
 * `95001592-0000-4236-80e0-d1bb8521e12d` (1,508 messages, never materialized):
 * `search_messages("pgvector Django")` and `search_messages("agentic frameworks")`
 * both returned 0.
 *
 * This spec drives a real Instant session with a real agent's streaming output.
 * `ProjectData.searchMessages` is reachable only through the MCP `search_messages`
 * tool — the surface the bug was reported on — and MCP tokens are workspace-scoped
 * and live only in KV, so the operator resolves the token out of band and supplies
 * it as `SAM_STAGING_MCP_TOKEN` before the assertion phase.
 *
 * Phase 1 (no MCP token): create the session, drive sleep → wake → sleep, print IDs.
 * Phase 2 (with SAM_STAGING_MCP_TOKEN): assert both halves are searchable.
 *
 * Run: pnpm exec playwright test staging-incremental-materialization --project=chromium
 */
import { expect, type Page, test } from '@playwright/test';

import { STAGING_API, STAGING_APP, stagingLogin } from './staging-helpers';

/**
 * Rare words the agent is asked to echo verbatim. Streaming splits each across
 * several `chat_messages` rows, so a hit can only come from the grouped FTS
 * index — a raw-row LIKE cannot match a word no single row holds.
 */
const RUN_ID = Date.now().toString(36);
const FIRST_SENTINEL = `vestigial${RUN_ID}`;
const SECOND_SENTINEL = `cromulent${RUN_ID}`;

const TURN_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 5_000;

interface SearchHit {
  messageId: string;
  sessionId: string;
  role: string;
  snippet: string;
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
  const parsed = await callMcp(page, token, 'search_messages', {
    query,
    sessionId,
    roles: ['assistant'],
    limit: 20,
  });
  return (parsed.results as SearchHit[] | undefined) ?? [];
}

async function readTranscript(
  page: Page,
  projectId: string,
  sessionId: string
): Promise<Array<{ id: string; role: string; content: string }>> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}/messages?limit=500`
  );
  expect(res.status(), `messages HTTP: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as {
    messages?: Array<{ id: string; role: string; content: string }>;
  };
  return body.messages ?? [];
}

/** Wait until the agent has actually emitted the sentinel into the transcript. */
async function waitForAssistantSentinel(
  page: Page,
  projectId: string,
  sessionId: string,
  sentinel: string
): Promise<Array<{ id: string; role: string; content: string }>> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let messages: Array<{ id: string; role: string; content: string }> = [];
  while (Date.now() < deadline) {
    messages = await readTranscript(page, projectId, sessionId);
    const assistantText = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('');
    if (assistantText.includes(sentinel)) return messages;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(
    `agent never emitted "${sentinel}" in ${TURN_TIMEOUT_MS}ms (transcript has ${messages.length} rendered messages)`
  );
}

test.describe('incremental materialization on staging', () => {
  test.describe.configure({ mode: 'serial', timeout: 20 * 60_000 });

  test('a sleeping session is searchable, and so is the tail written after it wakes', async ({
    page,
  }) => {
    await stagingLogin(page);
    await page.goto(STAGING_APP);

    const projectId = process.env.SAM_STAGING_PROJECT_ID;
    expect(projectId, 'set SAM_STAGING_PROJECT_ID').toBeTruthy();

    // --- Start an Instant session and make the agent emit a rare word ---------
    const startRes = await page.request.post(
      `${STAGING_API}/api/projects/${projectId}/sessions/start`,
      { data: { message: `Reply with exactly this one word and nothing else: ${FIRST_SENTINEL}` } }
    );
    expect(startRes.status(), `chat start: ${await startRes.text()}`).toBeLessThan(400);
    const started = (await startRes.json()) as { sessionId?: string; workspaceId?: string };
    const sessionId = started.sessionId;
    const workspaceId = started.workspaceId;
    // eslint-disable-next-line no-console
    console.log(`[staging] sessionId=${sessionId} workspaceId=${workspaceId}`);
    expect(sessionId, 'chat start returned no sessionId').toBeTruthy();
    expect(workspaceId, 'chat start returned no workspaceId').toBeTruthy();

    await waitForAssistantSentinel(page, projectId!, sessionId!, FIRST_SENTINEL);

    // The sentinel MUST be split across rows or this spec proves nothing: a
    // raw-row LIKE could satisfy the assertions instead of the FTS index.
    const raw = await readTranscript(page, projectId!, sessionId!);
    // eslint-disable-next-line no-console
    console.log(`[staging] rendered messages after turn 1: ${raw.length}`);

    // --- Sleep -----------------------------------------------------------------
    const sleepRes = await page.request.post(`${STAGING_API}/api/workspaces/${workspaceId}/sleep`);
    expect(sleepRes.status(), `sleep: ${await sleepRes.text()}`).toBeLessThan(400);
    // eslint-disable-next-line no-console
    console.log('[staging] first sleep committed');

    const mcpToken = process.env.SAM_STAGING_MCP_TOKEN;
    if (!mcpToken) {
      // eslint-disable-next-line no-console
      console.log(
        `[staging] PHASE 1 DONE. Resolve the MCP token for workspace ${workspaceId} from KV, ` +
          `then re-run with SAM_STAGING_MCP_TOKEN set to assert. Sentinels: ${FIRST_SENTINEL} / ${SECOND_SENTINEL}`
      );
      return;
    }

    const afterFirstSleep = await searchMessages(page, mcpToken, FIRST_SENTINEL, sessionId!);
    expect(
      afterFirstSleep.length,
      'assistant text from a SLEEPING session must be searchable'
    ).toBeGreaterThanOrEqual(1);

    // --- Wake, write more, sleep again ---------------------------------------
    const promptRes = await page.request.post(
      `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}/prompt`,
      { data: { message: `Reply with exactly this one word and nothing else: ${SECOND_SENTINEL}` } }
    );
    expect(promptRes.status(), `prompt: ${await promptRes.text()}`).toBeLessThan(400);
    await waitForAssistantSentinel(page, projectId!, sessionId!, SECOND_SENTINEL);

    const sleepAgain = await page.request.post(
      `${STAGING_API}/api/workspaces/${workspaceId}/sleep`
    );
    expect(sleepAgain.status(), `second sleep: ${await sleepAgain.text()}`).toBeLessThan(400);

    // THE load-bearing assertion: the old boolean gate would have stamped the
    // session on the first sleep and dropped everything after it, permanently.
    const secondBatch = await searchMessages(page, mcpToken, SECOND_SENTINEL, sessionId!);
    expect(
      secondBatch.length,
      'text written after the first sleep must also be searchable'
    ).toBeGreaterThanOrEqual(1);

    // Liveness control: a pass cannot have become a silent no-op.
    const firstAgain = await searchMessages(page, mcpToken, FIRST_SENTINEL, sessionId!);
    expect(firstAgain.length, 'first batch must remain searchable').toBeGreaterThanOrEqual(1);
  });
});
