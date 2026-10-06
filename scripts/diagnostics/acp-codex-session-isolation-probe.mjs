import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureServer } from '../../tests/fixtures/acp-c2-remote-service.mjs';

const codexBin = process.env.CODEX_BIN ?? 'codex';
assert.equal(spawnSync(codexBin, ['--version'], { encoding: 'utf8' }).stdout?.trim(), 'codex-cli 0.156.1');
const home = mkdtempSync(join(tmpdir(), 'sam-codex-isolation-'));
const fixtureEvents = [];
const fixture = createFixtureServer({
  publicUrl: 'https://fixture.example.test',
  mcpToken: 'probe-only',
  samPortProxy: true,
  log: (event) => fixtureEvents.push(event.kind),
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await listen(fixture.listener);
const mcpPort = fixture.listener.address().port;
let modelCalls = 0;
const sse = (items) => items.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const model = createHttpServer((req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end();
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1e6) req.destroy();
  });
  req.on('end', () => {
    modelCalls++;
    const phase = ((modelCalls - 1) % 3) + 1;
    const id = `response-${modelCalls}`;
    const item = phase === 2
      ? { type: 'function_call', call_id: `call-${modelCalls}`, namespace: 'mcp__fixture', name: 'request_remote_url', arguments: '{}' }
      : { type: 'message', role: 'assistant', id: `message-${modelCalls}`, content: [{ type: 'output_text', text: phase === 1 ? 'Warmup' : 'Done' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
    ]));
  });
});
await listen(model);
const modelPort = model.address().port;
writeFileSync(join(home, 'config.toml'), `model = "mock-model"
approval_policy = "never"
sandbox_mode = "danger-full-access"
model_provider = "mock_provider"
[model_providers.mock_provider]
name = "Mock"
base_url = "http://127.0.0.1:${modelPort}/v1"
wire_api = "responses"
env_key = "PROBE_API_KEY"
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.fixture]
url = "http://127.0.0.1:${mcpPort}/mcp"
bearer_token_env_var = "PROBE_MCP_TOKEN"
`);

const reservation = createNetServer();
await listen(reservation);
const wsPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const spawnServer = () => spawn(codexBin, ['app-server', '--listen', `ws://127.0.0.1:${wsPort}`], {
  env: { ...process.env, CODEX_HOME: home, PROBE_API_KEY: 'probe-only', PROBE_MCP_TOKEN: 'probe-only' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
let child = spawnServer();

async function connect(enabled, holdElicitation = false) {
  let socket;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      await Promise.race([
        new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', reject, { once: true });
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 1000)),
      ]);
      break;
    } catch {
      socket?.close();
      if (attempt === 29) throw new Error('app-server did not accept a local connection');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const pending = new Map();
  const turnWaiters = [];
  const seen = { urlRequests: 0, modes: [], held: [] };
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'mcpServer/elicitation/request') {
      seen.urlRequests++;
      seen.modes.push(message.params?.request?.mode ?? message.params?.mode ?? null);
      if (holdElicitation) seen.held.push(message.id);
      else socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { action: 'decline', content: null, _meta: null } }));
    } else if (message.method === 'turn/completed') {
      turnWaiters.shift()?.(message.params?.turn?.status);
    } else if (message.id != null) {
      const done = pending.get(message.id);
      if (done) {
        pending.delete(message.id);
        done(message);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(`${method} failed with code ${message.error.code}`));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await request('initialize', {
    clientInfo: { name: 'sam-safe-isolation-probe', version: '1' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      ...(enabled == null ? {} : { extensions: { 'sam/acp-explicit-elicitation': { form: enabled, url: enabled } } }),
    },
  });
  return { socket, request, seen, turnWaiters };
}

async function turn(client, threadId, input) {
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn completion timed out')), 15000);
    client.turnWaiters.push((status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: input, text_elements: [] }],
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    model: 'mock-model',
  });
  assert.equal(await completed, 'completed');
}

async function exercise(client, threadId, expectedRequest) {
  const before = client.seen.urlRequests;
  await turn(client, threadId, 'Warm up');
  await turn(client, threadId, 'Call fixture remote URL tool');
  assert.equal(client.seen.urlRequests - before, expectedRequest ? 1 : 0);
}

const evidence = [];
try {
  const owner = await connect(true);
  const started = await owner.request('thread/start', {
    cwd: '/tmp', model: 'mock-model', approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false,
  });
  const threadId = started.thread.id;
  await exercise(owner, threadId, true);
  evidence.push({ scenario: 'new-enabled', elicitation: 'url', outcome: 'human-decline' });

  const disabled = await connect(false);
  await disabled.request('thread/resume', { threadId });
  await exercise(disabled, threadId, false);
  evidence.push({ scenario: 'warm-resume-disabled', elicitation: 'none', outcome: 'policy-decline' });

  const disabledNew = await disabled.request('thread/start', {
    cwd: '/tmp', model: 'mock-model', approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false,
  });
  await exercise(disabled, disabledNew.thread.id, false);
  evidence.push({ scenario: 'new-disabled', elicitation: 'none', outcome: 'policy-decline' });

  const absent = await connect(null);
  await absent.request('thread/resume', { threadId: disabledNew.thread.id });
  await exercise(absent, disabledNew.thread.id, false);
  evidence.push({ scenario: 'warm-resume-absent', elicitation: 'none', outcome: 'policy-decline' });

  const reconnected = await connect(true);
  await reconnected.request('thread/resume', { threadId });
  await exercise(reconnected, threadId, true);
  evidence.push({ scenario: 'warm-resume-enabled-turn', elicitation: 'url', outcome: 'human-decline' });

  const fork = await reconnected.request('thread/fork', { threadId, ephemeral: false });
  await exercise(reconnected, fork.thread.id, true);
  evidence.push({ scenario: 'fork-enabled', elicitation: 'url', outcome: 'human-decline' });

  const active = await connect(true, true);
  const activeThread = await active.request('thread/start', {
    cwd: '/tmp', model: 'mock-model', approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false,
  });
  await turn(active, activeThread.thread.id, 'Warm up');
  const activeDone = new Promise((resolve) => active.turnWaiters.push(resolve));
  const input = [{ type: 'text', text: 'Call fixture remote URL tool', text_elements: [] }];
  const turnParams = { threadId: activeThread.thread.id, input, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, model: 'mock-model' };
  await active.request('turn/start', turnParams);
  for (let i = 0; i < 100 && active.seen.held.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(active.seen.held.length, 1, 'active turn must await explicit human response');
  const competing = await connect(false);
  await competing.request('thread/resume', { threadId: activeThread.thread.id });
  const steer = await competing.request('turn/start', { ...turnParams, input: [{ type: 'text', text: 'Steer while elicitation waits', text_elements: [] }] });
  assert.equal(steer.turn.id != null, true);
  await assert.rejects(active.request('turn/start', { ...turnParams, input: [] }));
  assert.equal(active.seen.held.length, 1);
  active.socket.send(JSON.stringify({ jsonrpc: '2.0', id: active.seen.held.pop(), result: { action: 'decline', content: null, _meta: null } }));
  assert.equal(await activeDone, 'completed');
  evidence.push({ scenario: 'active-elicitation-resume-steer-reject', elicitation: 'url', outcome: 'human-decline' });

  for (const client of [owner, disabled, absent, reconnected, active, competing]) client.socket.close();
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await stopped;
  child = spawnServer();
  const cold = await connect(null);
  await cold.request('thread/resume', { threadId });
  await exercise(cold, threadId, false);
  cold.socket.close();
  evidence.push({ scenario: 'cold-restart-absent', elicitation: 'none', outcome: 'policy-decline' });
  const output = JSON.stringify({ version: 'codex-cli 0.156.1', scenarios: evidence, modelCalls, fixtureEvents });
  for (const canary of ['https://fixture.example.test', 'probe-only', 'Authorization', 'bearer_token_env_var'])
    assert.ok(!output.includes(canary), 'probe output contains a canary');
  console.log(output);
} finally {
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await stopped;
  await fixture.close();
  await new Promise((resolve) => fixture.listener.close(resolve));
  await new Promise((resolve) => model.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
