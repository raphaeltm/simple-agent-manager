import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

import { loginWithToken } from './helpers/auth';

const PROMPT =
  'Use the available SAM MCP tools to inspect this project/workspace context, then inspect the repository root files. Reply with: 1. the project name, 2. the primary language/framework, 3. which SAM MCP tool or tools you called. Do not edit files.';

type ProjectSummary = {
  id: string;
  name?: string | null;
  repository?: string | null;
  defaultBranch?: string | null;
};

type WorkspaceResponse = {
  id: string;
  nodeId?: string | null;
  projectId?: string | null;
  chatSessionId?: string | null;
  status: string;
  branch?: string | null;
  repository?: string | null;
  errorMessage?: string | null;
};

type AgentSessionResponse = {
  id: string;
  status: string;
  agentType?: string | null;
};

type WsResult = {
  rawMessages: string[];
  responseText: string;
  toolNames: string[];
  statusMessages: string[];
  promptDone: boolean;
};

type TarEntry = {
  name: string;
  content: Buffer;
};

test.describe('Amp project-chat SAM MCP wiring', () => {
  test.describe.configure({ retries: 0 });

  test.skip(
    process.env.AMP_PROJECT_CHAT_MCP_SMOKE !== 'true',
    'Set AMP_PROJECT_CHAT_MCP_SMOKE=true to run the live Amp project-chat MCP verification.'
  );

  test('Amp calls SAM MCP tools during a staging project-chat run', async ({ context }, testInfo) => {
    test.setTimeout(30 * 60 * 1000);

    const apiUrl = process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';
    const appUrl = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
    const page = await loginWithToken(context, { apiUrl, appUrl });
    const request = page.request;

    const project = await chooseProject(request, apiUrl);
    const workspace = await createWorkspace(request, apiUrl, project);
    const evidence: Record<string, string | undefined> = {
      timestamp: new Date().toISOString(),
      apiUrl,
      projectId: project.id,
      projectName: project.name ?? undefined,
      projectRepository: project.repository ?? undefined,
      workspaceId: workspace.id,
      nodeId: workspace.nodeId ?? undefined,
      chatSessionId: workspace.chatSessionId ?? undefined,
    };

    let agentSessionId: string | undefined;
    try {
      const runningWorkspace = await waitForWorkspaceRunning(request, apiUrl, workspace.id);
      evidence.nodeId = runningWorkspace.nodeId ?? evidence.nodeId;
      evidence.chatSessionId = runningWorkspace.chatSessionId ?? evidence.chatSessionId;
      expect(runningWorkspace.nodeId, 'fresh workspace should have a node ID').toBeTruthy();
      expect(runningWorkspace.chatSessionId, 'fresh workspace should have a chat session ID').toBeTruthy();

      const agentSession = await createAgentSession(request, apiUrl, runningWorkspace.id);
      agentSessionId = agentSession.id;
      evidence.agentSessionId = agentSession.id;

      const wsResult = await runAmpPrompt(page, apiUrl, runningWorkspace, agentSession.id);
      const combinedWsText = wsResult.rawMessages.join('\n');
      const sanitizedAnswer = redactSecrets(wsResult.responseText).slice(0, 2000);

      evidence.ampToolNames = wsResult.toolNames.join(', ');
      evidence.ampStatusMessages = wsResult.statusMessages.join(' | ');
      evidence.ampAnswerExcerpt = sanitizedAnswer;

      expect(wsResult.promptDone, 'Amp session should finish the prompt').toBe(true);
      expect(combinedWsText).not.toMatch(/401|403|missing key|missing api key|insufficient credits|missing npm|missing cli/i);

      const chatText = await waitForPersistedChatText(
        request,
        apiUrl,
        project.id,
        runningWorkspace.chatSessionId!,
        project
      );
      evidence.persistedChatExcerpt = redactSecrets(chatText).slice(0, 2000);

      const debugEvidence = await fetchDebugEvidence(
        request,
        apiUrl,
        runningWorkspace.nodeId!,
        testInfo
      );
      evidence.debugLogExcerpts = debugEvidence.excerpts.join('\n---\n').slice(0, 6000);
      const combinedEvidence = `${combinedWsText}\n${chatText}\n${debugEvidence.combined}`;
      const samMcpIndicators = extractSamMcpIndicators(combinedEvidence);
      evidence.samMcpIndicators = samMcpIndicators.join(', ');
      console.log(`AMP_PROJECT_CHAT_MCP_EVIDENCE ${JSON.stringify(redactEvidence(evidence), null, 2)}`);

      expect(chatText, 'Amp response should be persisted in project chat').toMatch(projectFactPattern(project));
      expect(`${wsResult.responseText}\n${chatText}`, 'Amp answer should name the SAM MCP tool it called').toMatch(
        /get_workspace_info|get_instructions|sam-mcp/i
      );
      expect(samMcpIndicators.length, 'staging evidence should include explicit SAM MCP tool-call indicators').toBeGreaterThan(0);
      expect(debugEvidence.combined, 'VM debug package should show MCP server registration/injection').toMatch(
        /MCP servers registered for agent session|mcpServers"?[:=]\s*1|sam-mcp/i
      );
      expect(debugEvidence.combined, 'VM debug package should show Amp bootstrap/runtime evidence').toMatch(
        /acp-amp|@sourcegraph\/amp|AMP_API_KEY/i
      );
    } finally {
      if (agentSessionId) {
        await request
          .post(`${apiUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/agent-sessions/${encodeURIComponent(agentSessionId)}/stop`)
          .catch(() => undefined);
      }
      await request.delete(`${apiUrl}/api/workspaces/${encodeURIComponent(workspace.id)}`).catch(() => undefined);
    }
  });
});

async function chooseProject(request: APIRequestContext, apiUrl: string): Promise<ProjectSummary> {
  const response = await request.get(`${apiUrl}/api/projects?limit=50`);
  expect(response.ok(), `project list failed: ${response.status()} ${await response.text()}`).toBe(true);
  const body = await response.json();
  const projects = (body.projects ?? []) as ProjectSummary[];
  const requestedRepo = process.env.AMP_SMOKE_PROJECT_REPOSITORY?.trim().toLowerCase();
  const preferred = projects.find(
    (project) => project.repository?.toLowerCase() === (requestedRepo || 'tmp-srv-prs-org/crewai')
  );
  const fallback = projects.find((project) => Boolean(project.repository));
  const selected = preferred ?? fallback;
  expect(selected, 'smoke user should have at least one linked project with a repository').toBeTruthy();
  return selected!;
}

async function createWorkspace(
  request: APIRequestContext,
  apiUrl: string,
  project: ProjectSummary
): Promise<WorkspaceResponse> {
  const name = `Amp MCP ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const response = await request.post(`${apiUrl}/api/workspaces`, {
    data: {
      name,
      projectId: project.id,
      branch: project.defaultBranch || 'main',
      provider: 'hetzner',
      vmSize: 'small',
    },
  });
  expect(response.ok(), `workspace create failed: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as WorkspaceResponse;
}

async function waitForWorkspaceRunning(
  request: APIRequestContext,
  apiUrl: string,
  workspaceId: string
): Promise<WorkspaceResponse> {
  const deadline = Date.now() + 20 * 60 * 1000;
  let last: WorkspaceResponse | undefined;
  while (Date.now() < deadline) {
    const response = await request.get(`${apiUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`);
    expect(response.ok(), `workspace status failed: ${response.status()} ${await response.text()}`).toBe(true);
    last = (await response.json()) as WorkspaceResponse;
    if (last.status === 'running') {
      return last;
    }
    if (last.status === 'error' || last.status === 'deleted') {
      throw new Error(`workspace reached ${last.status}: ${last.errorMessage ?? 'no error message'}`);
    }
    await delay(15_000);
  }
  throw new Error(`workspace did not become running in time; last status=${last?.status ?? 'unknown'}`);
}

async function createAgentSession(
  request: APIRequestContext,
  apiUrl: string,
  workspaceId: string
): Promise<AgentSessionResponse> {
  const response = await request.post(`${apiUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions`, {
    data: {
      label: 'Amp MCP verification',
      agentType: 'amp',
    },
  });
  expect(response.ok(), `agent session create failed: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as AgentSessionResponse;
}

async function runAmpPrompt(
  page: Page,
  apiUrl: string,
  workspace: WorkspaceResponse,
  agentSessionId: string
): Promise<WsResult> {
  const terminalResponse = await page.request.post(`${apiUrl}/api/terminal/token`, {
    data: { workspaceId: workspace.id },
  });
  expect(
    terminalResponse.ok(),
    `terminal token failed: ${terminalResponse.status()} ${await terminalResponse.text()}`
  ).toBe(true);
  const terminal = (await terminalResponse.json()) as { token: string };
  const baseDomain = new URL(apiUrl).hostname.replace(/^api\./, '');
  const wsUrl = `wss://ws-${workspace.id.toLowerCase()}.${baseDomain}/agent/ws?token=${encodeURIComponent(
    terminal.token
  )}&sessionId=${encodeURIComponent(agentSessionId)}`;

  return await page.evaluate(
    async ({ url, prompt }) => {
      const rawMessages: string[] = [];
      const statusMessages: string[] = [];
      const responseChunks: string[] = [];
      const toolNames = new Set<string>();
      let promptDone = false;
      let ready = false;

      const parseToolNames = (value: unknown) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        for (const match of text.matchAll(/(?:sam-mcp|get_workspace_info|get_instructions|tool[_ -]?call)["'\s:,-]*([A-Za-z0-9_.-]+)?/gi)) {
          if (/get_workspace_info|get_instructions|sam-mcp/i.test(match[0])) {
            toolNames.add(match[0].match(/get_workspace_info|get_instructions|sam-mcp/i)?.[0] ?? 'sam-mcp');
          }
        }
      };

        const extractText = (value: unknown) => {
          if (!value || typeof value !== 'object') {
            return;
          }
          const record = value as Record<string, unknown>;
          const method = typeof record.method === 'string' ? record.method : '';
          const params = record.params && typeof record.params === 'object'
            ? (record.params as Record<string, unknown>)
            : undefined;
          if (method === 'session/update' && params?.update && typeof params.update === 'object') {
            const update = params.update as Record<string, unknown>;
            const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
            if (sessionUpdate === 'agent_message_chunk') {
              const content = update.content && typeof update.content === 'object'
                ? (update.content as Record<string, unknown>)
                : undefined;
              if (content?.type === 'text' && typeof content.text === 'string') {
                responseChunks.push(content.text);
              }
            }
            if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
              parseToolNames(update);
            }
            return;
          }
          if (/tool|mcp/i.test(method) || JSON.stringify(value).match(/get_workspace_info|get_instructions|sam-mcp/i)) {
            parseToolNames(value);
          }
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        const timeout = window.setTimeout(() => {
          ws.close();
          reject(new Error('timed out waiting for Amp prompt completion'));
        }, 12 * 60 * 1000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'select_agent', agentType: 'amp' }));
        };
        ws.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('agent WebSocket error'));
        };
        ws.onmessage = (event) => {
          const text = String(event.data);
          rawMessages.push(text);
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return;
          }
          extractText(parsed);
          if (parsed.type === 'agent_status' || parsed.type === 'session_state') {
            statusMessages.push(text);
            if (parsed.status === 'ready') {
              ready = true;
              ws.send(JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/prompt',
                id: 1,
                params: {
                  messageId: `amp-mcp-${Date.now()}`,
                  prompt: [{ type: 'text', text: prompt }],
                },
              }));
            }
            if (parsed.status === 'error') {
              window.clearTimeout(timeout);
              reject(new Error(`agent status error: ${text}`));
            }
          }
          if (parsed.type === 'session_prompt_done') {
            promptDone = true;
            window.clearTimeout(timeout);
            ws.close();
            resolve();
          }
          if (parsed.id === 1 && (parsed.result || parsed.error)) {
            if (parsed.error) {
              window.clearTimeout(timeout);
              reject(new Error(`prompt returned error: ${JSON.stringify(parsed.error)}`));
            }
          }
        };
      });

      return {
        rawMessages,
        responseText: responseChunks.join('\n'),
        toolNames: Array.from(toolNames),
        statusMessages,
        promptDone,
      };
    },
    { url: wsUrl, prompt: PROMPT }
  );
}

async function waitForPersistedChatText(
  request: APIRequestContext,
  apiUrl: string,
  projectId: string,
  chatSessionId: string,
  project: ProjectSummary
): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastText = '';
  while (Date.now() < deadline) {
    const response = await request.get(
      `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(chatSessionId)}?limit=50`
    );
    expect(response.ok(), `chat fetch failed: ${response.status()} ${await response.text()}`).toBe(true);
    lastText = JSON.stringify(await response.json());
    if (projectFactPattern(project).test(lastText) && /get_workspace_info|get_instructions|sam-mcp/i.test(lastText)) {
      return lastText;
    }
    if (/Process exited with code|401|403|missing key|missing api key|insufficient credits|missing npm|missing cli/i.test(lastText)) {
      return lastText;
    }
    await delay(5_000);
  }
  return lastText;
}

async function fetchDebugEvidence(
  request: APIRequestContext,
  apiUrl: string,
  nodeId: string,
  testInfo: { attach: (name: string, options: { body: Buffer; contentType: string }) => Promise<void> }
): Promise<{ combined: string; excerpts: string[] }> {
  const response = await request.get(`${apiUrl}/api/nodes/${encodeURIComponent(nodeId)}/debug-package`);
  expect(response.ok(), `debug package failed: ${response.status()} ${await response.text()}`).toBe(true);
  const body = Buffer.from(await response.body());
  await testInfo.attach('debug-package', { body, contentType: 'application/gzip' });
  const entries = parseTar(gunzipSync(body));
  const excerpts: string[] = [];
  const interesting = /vm-agent|journal|docker|event|log/i;
  const patterns =
    /MCP servers registered for agent session|MCP servers recovered from SQLite|SessionHost created|NewSession|sam-mcp|acp-amp|@sourcegraph\/amp|AMP_API_KEY|get_workspace_info|get_instructions|tools\/call/i;
  for (const entry of entries) {
    if (!interesting.test(entry.name)) {
      continue;
    }
    const text = entry.content.toString('utf8');
    const lines = text.split(/\r?\n/).filter((line) => patterns.test(line));
    if (lines.length > 0) {
      excerpts.push(`${entry.name}\n${lines.slice(-40).map(redactSecrets).join('\n')}`);
    }
  }
  return {
    combined: excerpts.join('\n'),
    excerpts,
  };
}

function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const name = buffer.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) {
      break;
    }
    const sizeText = buffer.subarray(offset + 124, offset + 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeText || '0', 8);
    const contentStart = offset + 512;
    entries.push({ name, content: buffer.subarray(contentStart, contentStart + size) });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function projectFactPattern(project: ProjectSummary): RegExp {
  const facts = [project.name, project.repository, project.repository?.split('/').pop()]
    .filter(Boolean)
    .map((value) => escapeRegex(value!));
  return new RegExp(facts.join('|'), 'i');
}

function redactEvidence(evidence: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(evidence).map(([key, value]) => [key, value ? redactSecrets(value) : value])
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)[A-Z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/sam_test_[A-Za-z0-9_-]+/g, 'sam_test_[REDACTED]')
    .replace(/mcp:[A-Za-z0-9_-]+/g, 'mcp:[REDACTED]')
    .replace(/token=[^&\s"']+/gi, 'token=[REDACTED]');
}

function extractSamMcpIndicators(value: string): string[] {
  const indicators = new Set<string>();
  for (const pattern of [/get_workspace_info/gi, /get_instructions/gi, /sam-mcp/gi, /tools\/call/gi]) {
    for (const match of value.matchAll(pattern)) {
      indicators.add(match[0]);
    }
  }
  return Array.from(indicators);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
