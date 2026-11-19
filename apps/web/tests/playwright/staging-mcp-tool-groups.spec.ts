/**
 * Staging smoke: a real Instant agent finds and calls SAM's domain tool groups
 * (`ideas_read`, `knowledge_read`, `workspace_read`) through its harness tool search.
 *
 * Run only on a staging build of the tool-grouping branch, through exec_with_secrets.
 * Set MCP_GROUPS_PROJECT_ID to a staging project and MCP_GROUPS_PROFILE_ID to an Instant
 * (cf-container) profile in it. Run with one Playwright project and one worker. The test
 * creates one Instant chat and one idea, then deletes them.
 */
import { expect, test } from '@playwright/test';

const api = 'https://api.sammy.party';
const projectId = process.env.MCP_GROUPS_PROJECT_ID ?? '';
const profileId = process.env.MCP_GROUPS_PROFILE_ID ?? '';
const marker = `MCP-GROUPS-${Date.now()}`;
const route = (path: string) => `${api}/api/projects/${projectId}${path}`;

test.setTimeout(480_000);

test('a real agent calls domain tool groups by method', async ({ page }) => {
  // Opt-in: runs only when a staging project is named, so default runs skip it.
  test.skip(!process.env.MCP_GROUPS_PROJECT_ID, 'staging-only: set MCP_GROUPS_PROJECT_ID');
  expect(projectId, 'MCP_GROUPS_PROJECT_ID is required').not.toBe('');
  expect(profileId, 'MCP_GROUPS_PROFILE_ID is required').not.toBe('');
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  expect(token, 'Use exec_with_secrets for staging login').toBeTruthy();
  expect(token).not.toMatch(/^__SAM_SECRET/);

  const created: { sessionId?: string; taskId?: string; ideaId?: string } = {};
  async function request(
    method: 'get' | 'post' | 'delete',
    path: string,
    options: Record<string, unknown> = {},
    statuses = [200]
  ): Promise<Record<string, unknown>> {
    const response = await page.request[method](route(path), options);
    const body = await response.text();
    expect(statuses, `${method.toUpperCase()} ${path}: ${body.slice(0, 800)}`).toContain(
      response.status()
    );
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  }
  async function messages(): Promise<Array<Record<string, unknown>>> {
    const result = await request(
      'get',
      `/sessions/${created.sessionId}/messages?limit=1000&compact=false`
    );
    return (result.messages ?? result.items ?? []) as Array<Record<string, unknown>>;
  }
  async function waitForAssistant(text: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await messages();
      const assistant = rows
        .filter((row) => row.role === 'assistant')
        .map((row) => String(row.content))
        .join('');
      if (assistant.includes(text)) return { rows, assistant };
      await page.waitForTimeout(4000);
    }
    throw new Error(`assistant reply containing ${text} timed out`);
  }

  try {
    const login = await page.request.post(`${api}/api/auth/token-login`, { data: { token } });
    expect(login.status(), `staging login: ${await login.text()}`).toBe(200);

    const idea = await request(
      'post',
      '/ideas',
      { data: { title: `Grouped tools ${marker}`, content: `Seeded by ${marker}` } },
      [201]
    );
    created.ideaId = (idea.ideaId ?? idea.id ?? idea.taskId) as string;
    expect(created.ideaId).toBeTruthy();

    const started = await request(
      'post',
      '/sessions/start',
      {
        data: { agentProfileId: profileId, message: `Reply READY ${marker}, then wait.` },
      },
      [202]
    );
    created.taskId = started.taskId as string;
    created.sessionId = started.sessionId as string;
    await waitForAssistant(`READY ${marker}`, 240_000);

    await request(
      'post',
      `/sessions/${created.sessionId}/prompt`,
      {
        data: {
          content:
            `Use only SAM MCP tools. 1) Call ideas_read with method "search" and query "${marker}". ` +
            '2) Call knowledge_read with method "search" and query "test". ' +
            '3) Call workspace_read with method "info". ' +
            `Then reply with "REPORT ${marker}" on its own line, then one line per call in the form ` +
            '"<tool> <method> OK" on success or "<tool> <method> ERROR: <message>" on failure, ' +
            `then the idea ID from call 1 on its own line, and end with "DONE ${marker}". Do not change anything.`,
        },
      },
      [200, 202]
    );
    const { rows, assistant } = await waitForAssistant(`DONE ${marker}`, 300_000);
    // Only tool-call rows count: the prompt itself names the tools.
    const transcript = JSON.stringify(rows.filter((row) => row.role === 'tool'));
    for (const tool of ['ideas_read', 'knowledge_read', 'workspace_read']) {
      expect(transcript, `${tool} was called`).toContain(tool);
    }
    // The search found the idea this test created, through the ideas_read group.
    expect(assistant).toContain(created.ideaId);
    // Each call succeeded, per the agent's structured report.
    const reportLines = assistant
      .slice(assistant.lastIndexOf(`REPORT ${marker}`))
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const result of [
      'ideas_read search OK',
      'knowledge_read search OK',
      'workspace_read info OK',
    ]) {
      expect(reportLines).toContain(result);
    }
    console.log(`Agent report:\n${assistant.slice(assistant.indexOf(`DONE ${marker}`))}`);
  } finally {
    if (created.sessionId) {
      await page.request.post(route(`/sessions/${created.sessionId}/stop`)).catch(() => null);
    }
    if (created.taskId)
      await page.request.delete(route(`/tasks/${created.taskId}`)).catch(() => null);
    if (created.ideaId)
      await page.request.delete(route(`/tasks/${created.ideaId}`)).catch(() => null);
  }
});
