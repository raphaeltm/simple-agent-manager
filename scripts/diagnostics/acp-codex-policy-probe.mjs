import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createFixtureServer } from '../../tests/fixtures/acp-c2-remote-service.mjs';
const home = mkdtempSync(join(tmpdir(), 'sam-codex-mcp-'));
const codexBin = process.env.CODEX_BIN ?? 'codex';
const version = spawnSync(codexBin, ['--version'], { encoding: 'utf8' }).stdout?.trim();
assert.equal(version, 'codex-cli 0.156.1', 'probe requires the exact pinned Codex CLI');
const granular = process.env.PROBE_POLICY === 'granular';
const commandProbe = process.env.PROBE_TOOL === 'command';
const formProbe = process.env.PROBE_TOOL === 'form';
const deniedTool = process.env.PROBE_DENIED_TOOL === '1';
const explicitMcp = process.env.PROBE_EXPLICIT_MCP === '1';
const explicitMcpDisabled = process.env.PROBE_EXPLICIT_MCP === '0';
const policy = granular
  ? {
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: true,
      },
    }
  : 'never';
const policyToml = granular
  ? 'approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }'
  : 'approval_policy = "never"';
const events = [];
const fixture = createFixtureServer({
  publicUrl: 'https://fixture.example.test',
  mcpToken: 'probe-only',
  samPortProxy: true,
  formTool: formProbe,
  log: (e) => events.push(e.kind),
});
await new Promise((resolve) => fixture.listener.listen(0, '127.0.0.1', resolve));
const mcpPort = fixture.listener.address().port;
let modelCalls = 0;
let commandOutputSeen = false;
const sse = (items) =>
  items.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const created = (id) => ({ type: 'response.created', response: { id } });
const completed = (id) => ({
  type: 'response.completed',
  response: {
    id,
    usage: {
      input_tokens: 0,
      input_tokens_details: null,
      output_tokens: 0,
      output_tokens_details: null,
      total_tokens: 0,
    },
  },
});
const model = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (d) => {
    body += d;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    if (body.includes('SAM_SAFE_COMMAND_DONE')) commandOutputSeen = true;
    modelCalls++;
    const id = `resp-${modelCalls}`;
    let item;
    if (modelCalls === 1)
      item = {
        type: 'message',
        role: 'assistant',
        id: 'msg-0',
        content: [{ type: 'output_text', text: 'Warmup' }],
      };
    else if (modelCalls === 2)
      item = commandProbe
        ? {
            type: 'function_call',
            call_id: 'call-0',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'printf SAM_SAFE_COMMAND_DONE' }),
          }
        : {
            type: 'function_call',
            call_id: 'call-0',
            namespace: 'mcp__fixture',
            name: formProbe ? 'request_form' : 'request_remote_url',
            arguments: '{}',
          };
    else
      item = {
        type: 'message',
        role: 'assistant',
        id: 'msg-1',
        content: [{ type: 'output_text', text: 'Done' }],
      };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([created(id), { type: 'response.output_item.done', item }, completed(id)]));
  });
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelPort = model.address().port;
writeFileSync(
  join(home, 'config.toml'),
  `model = "mock-model"\n${policyToml}\nsandbox_mode = "danger-full-access"\nmodel_provider = "mock_provider"\n[model_providers.mock_provider]\nname = "Mock"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\nwire_api = "responses"\nenv_key = "PROBE_API_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\n[mcp_servers.fixture]\nurl = "http://127.0.0.1:${mcpPort}/mcp"\nbearer_token_env_var = "PROBE_MCP_TOKEN"\n${deniedTool ? 'disabled_tools = ["request_remote_url"]\n' : ''}`
);
const child = spawn(codexBin, ['app-server'], {
  env: {
    ...process.env,
    CODEX_HOME: home,
    PROBE_API_KEY: 'probe-only',
    PROBE_MCP_TOKEN: 'probe-only',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const send = (id, method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
const records = [];
let threadId = null;
let turnCount = 0;
child.stderr.on('data', () => {});
send(1, 'initialize', {
  clientInfo: { name: 'safe-probe', version: '1' },
  capabilities: {
    experimentalApi: true,
    requestAttestation: false,
    ...(explicitMcp || explicitMcpDisabled
      ? { extensions: { 'sam/acp-explicit-elicitation': { form: explicitMcp, url: explicitMcp } } }
      : {}),
  },
});
const timer = setTimeout(() => child.kill(), 15000);
for await (const line of createInterface({ input: child.stdout })) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (!msg.method && msg.id === 1) {
    records.push({ method: 'initialize', ok: !msg.error });
    send(2, 'thread/start', {
      cwd: '/tmp',
      model: 'mock-model',
      approvalPolicy: policy,
      sandbox: 'danger-full-access',
      ephemeral: true,
      ...(process.env.PROBE_THREAD_SOURCE === 'user' ? { threadSource: 'user' } : {}),
    });
  }
  if (!msg.method && msg.id === 2) {
    records.push({
      method: 'thread/start',
      ok: !msg.error,
      approvalPolicy: msg.result?.approvalPolicy ?? null,
    });
    threadId = msg.result?.thread?.id ?? null;
    if (threadId)
      send(3, 'turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Warm up', text_elements: [] }],
        approvalPolicy: policy,
        sandboxPolicy: { type: 'dangerFullAccess' },
        model: 'mock-model',
      });
  }
  if (!msg.method && msg.id === 3)
    records.push({ method: 'turn/start', ok: !msg.error, errorCode: msg.error?.code ?? null });
  if (msg.method === 'mcpServer/elicitation/request') {
    const mode = msg.params?.request?.mode ?? msg.params?.mode ?? null;
    records.push({
      method: msg.method,
      mode,
      server: msg.params?.serverName ?? null,
      elicitationIdPresent: !!msg.params?.elicitationId,
      requestedSchemaPresent: !!msg.params?.requestedSchema,
      metaKeys: Object.keys(msg.params?._meta ?? {}),
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          action: 'decline',
          content: null,
          _meta: null,
        },
      }) + '\n'
    );
  }
  if (msg.method === 'turn/completed') {
    turnCount++;
    records.push({ method: msg.method, status: msg.params?.turn?.status ?? null });
    if (turnCount === 1 && threadId)
      send(4, 'turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Call fixture remote URL tool', text_elements: [] }],
        approvalPolicy: policy,
        sandboxPolicy: { type: 'dangerFullAccess' },
        model: 'mock-model',
      });
    else break;
  }
}
clearTimeout(timer);
child.kill();
await fixture.close();
await new Promise((resolve) => fixture.listener.close(resolve));
await new Promise((resolve) => model.close(resolve));
rmSync(home, { recursive: true, force: true });
const evidence = JSON.stringify({
  version,
  policy: granular ? 'granular-mcp-only' : 'never',
  probe: commandProbe ? 'command' : formProbe ? 'mcp-form' : 'mcp-url',
  explicitMcp,
  deniedTool,
  extensionPresent: explicitMcp || explicitMcpDisabled,
  records,
  modelCalls,
  events,
  commandOutputSeen,
});
for (const canary of [
  'https://fixture.example.test',
  'probe-only',
  'Authorization',
  'bearer_token_env_var',
])
  assert.ok(!evidence.includes(canary), 'probe output contains a canary');
assert.ok(records.some((x) => x.method === 'turn/completed' && x.status === 'completed'));
if (deniedTool) {
  assert.deepEqual(events, [], 'denied tool must never invoke the MCP server');
  assert.equal(records.some((x) => x.method === 'mcpServer/elicitation/request'), false);
} else if (commandProbe) {
  assert.equal(commandOutputSeen, true);
  assert.equal(
    records.some((x) => x.method === 'mcpServer/elicitation/request'),
    false
  );
} else if (granular) {
  assert.ok(records.some((x) => x.method === 'mcpServer/elicitation/request' && x.mode === 'form'));
  if (!formProbe)
    assert.ok(records.some((x) => x.method === 'mcpServer/elicitation/request' && x.mode === 'url'));
  assert.deepEqual(events, ['requested', 'declined']);
} else if (explicitMcp) {
  assert.ok(records.some((x) => x.method === 'mcpServer/elicitation/request' && x.mode === (formProbe ? 'form' : 'url')), evidence);
  assert.deepEqual(events, ['requested', 'declined']);
} else {
  assert.equal(
    records.some((x) => x.method === 'mcpServer/elicitation/request'),
    false
  );
  assert.deepEqual(events, ['requested', 'declined']);
}
console.log(evidence);
