#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { postToBuzz } from './buzz-cli.mjs';
import { validateApiUrl } from './configuration.mjs';

const experimentDir = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(experimentDir, 'buzz-sam-acp.mjs');
const channelId = '11111111-1111-4111-8111-111111111111';
const otherChannelId = '22222222-2222-4222-8222-222222222222';
const replyId = 'a'.repeat(64);
const projectPath = '/api/projects/project-1';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() - startedAt >= timeoutMs) reject(new Error('condition timed out'));
      else setTimeout(check, 5);
    };
    check();
  });
}

async function main() {
  assert.equal(validateApiUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(validateApiUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.throws(() => validateApiUrl('http://api.example.com'), /must use HTTPS/);
  assert.throws(
    () => validateApiUrl('https://user:password@api.example.com'),
    /must not contain embedded credentials/
  );
  assert.throws(
    () => validateApiUrl('https://api.example.com/proxy'),
    /must be an origin without a path/
  );

  const scratch = await mkdtemp(join(tmpdir(), 'sam-buzz-acp-smoke-'));
  const buzzLog = join(scratch, 'buzz.jsonl');
  const fakeBuzz = join(scratch, 'fake-buzz.mjs');
  const requests = [];
  const assistantMessages = [];
  let activeTurn = 0;
  let statePoll = 0;
  let promptPosts = 0;
  let cancelPosts = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const body = await readJson(request);
      requests.push({ method: request.method, path: url.pathname, search: url.search, body });
      assert.equal(request.headers.cookie, 'sam_session=smoke-cookie');

      if (request.method === 'POST' && url.pathname === `${projectPath}/tasks/submit`) {
        activeTurn = 1;
        statePoll = 0;
        return json(response, 202, {
          taskId: 'task-1',
          sessionId: 'sam-session-1',
          branchName: 'sam/smoke',
          status: 'queued',
        });
      }
      if (request.method === 'GET' && url.pathname === `${projectPath}/tasks/task-1`) {
        return json(response, 200, { id: 'task-1', status: 'in_progress' });
      }
      if (
        request.method === 'POST' &&
        url.pathname === `${projectPath}/sessions/sam-session-1/prompt`
      ) {
        activeTurn += 1;
        statePoll = 0;
        promptPosts += 1;
        return json(response, 200, { accepted: true });
      }
      if (
        request.method === 'POST' &&
        url.pathname === `${projectPath}/sessions/sam-session-1/cancel`
      ) {
        cancelPosts += 1;
        return json(response, 200, { status: 'cancelled' });
      }
      if (
        request.method === 'GET' &&
        url.pathname === `${projectPath}/sessions/sam-session-1/state`
      ) {
        statePoll += 1;
        return json(response, 200, {
          state: {
            activity: statePoll < 3 ? 'prompting' : 'idle',
            activityAt: Date.now(),
            statusError: null,
            lastStopReason: null,
          },
          agentSessionId: 'agent-session-1',
          agentType: 'openai-codex',
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === `${projectPath}/sessions/sam-session-1/messages`
      ) {
        if (activeTurn === 1 && statePoll >= 1 && assistantMessages.length === 0) {
          assistantMessages.push({
            id: 'first-1',
            role: 'assistant',
            content: 'Hello',
            createdAt: 1,
          });
        }
        if (activeTurn === 1 && statePoll >= 2 && assistantMessages.length === 1) {
          assistantMessages.push({
            id: 'first-2',
            role: 'assistant',
            content: ' from SAM.',
            createdAt: 2,
          });
        }
        if (activeTurn === 2 && statePoll >= 1 && assistantMessages.length === 2) {
          assistantMessages.push({
            id: 'second-1',
            role: 'assistant',
            content: 'Second turn.',
            createdAt: 3,
          });
        }
        return json(response, 200, { messages: assistantMessages, hasMore: false });
      }
      return json(response, 404, { error: 'NOT_FOUND', message: 'fake route not found' });
    } catch (error) {
      return json(response, 500, { error: 'FAKE_SERVER_ERROR', message: error.message });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  await writeFile(
    join(scratch, 'config.json'),
    `${JSON.stringify({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sessionCookie: 'sam_session=smoke-cookie',
    })}\n`
  );
  await writeFile(
    fakeBuzz,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const content = Buffer.concat(chunks).toString('utf8');
appendFileSync(process.env.BUZZ_FAKE_LOG, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  content,
  buzzPrivateKey: process.env.BUZZ_PRIVATE_KEY ?? null,
  secrets: {
    samSessionCookie: process.env.SAM_SESSION_COOKIE ?? null,
    samApiToken: process.env.SAM_API_TOKEN ?? null,
    samMcpToken: process.env.SAM_MCP_TOKEN ?? null,
    ghToken: process.env.GH_TOKEN ?? null,
    githubToken: process.env.GITHUB_TOKEN ?? null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    cloudflareToken: process.env.CF_TOKEN ?? null,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? null,
  },
}) + '\\n');
if (content === '__HANG__') setInterval(() => {}, 1_000);
`
  );
  await chmod(fakeBuzz, 0o755);

  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      SAM_API_URL: '',
      SAM_SESSION_COOKIE: '',
      SAM_CONFIG_DIR: scratch,
      SAM_PROJECT_ID: 'project-1',
      SAM_AGENT_PROFILE_ID: 'profile-1',
      SAM_API_TOKEN: 'must-not-reach-buzz',
      SAM_MCP_TOKEN: 'must-not-reach-buzz',
      GH_TOKEN: 'must-not-reach-buzz',
      GITHUB_TOKEN: 'must-not-reach-buzz',
      ANTHROPIC_API_KEY: 'must-not-reach-buzz',
      OPENAI_API_KEY: 'must-not-reach-buzz',
      CF_TOKEN: 'must-not-reach-buzz',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-buzz',
      BUZZ_CLI: fakeBuzz,
      BUZZ_FAKE_LOG: buzzLog,
      BUZZ_PRIVATE_KEY: 'nsec-demo-only',
      SAM_ACP_POLL_MS: '10',
      SAM_ACP_SETTLE_MS: '25',
      SAM_ACP_TURN_TIMEOUT_MS: '5000',
      SAM_ACP_HTTP_TIMEOUT_MS: '1000',
      SAM_ACP_KEEPALIVE_MS: '20',
      SAM_ACP_TASK_CHECK_MS: '10',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) {
      waiter.reject(
        new Error(`bridge exited before responding (code=${code}, signal=${signal}): ${stderr}`)
      );
    }
    pending.clear();
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && message.id !== null) {
      const waiter = pending.get(message.id);
      if (!waiter) throw new Error(`unexpected response id ${message.id}`);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    } else {
      notifications.push(message);
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${method} response timed out`)), 2_000);
      timeout.unref();
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return Promise.race([promise, timedOut]).finally(() => clearTimeout(timeout));
  };
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  const initialize = await request('initialize', { protocolVersion: 2 });
  assert.equal(initialize.protocolVersion, 2);
  assert.equal(initialize.agentCapabilities.loadSession, false);

  const created = await request('session/new', { cwd: scratch, mcpServers: [] });
  assert.match(created.sessionId, /^sam-prototype-/);

  const firstPrompt = `[Context]\nChannel: Demo (#${channelId})\nChannel: #${channelId}\nIMPORTANT: reply with --reply-to ${replyId}\nContent: hello`;
  assert.deepEqual(
    await request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: firstPrompt }],
    }),
    { stopReason: 'end_turn' }
  );

  const submit = requests.find((entry) => entry.path === `${projectPath}/tasks/submit`);
  assert.equal(submit.method, 'POST');
  assert.equal(submit.body.taskMode, 'conversation');
  assert.equal(submit.body.agentProfileId, 'profile-1');
  assert.match(submit.body.message, /Do not run the local `buzz` CLI/);

  for (const entry of requests.filter(
    (requestEntry) => requestEntry.path === `${projectPath}/sessions/sam-session-1/messages`
  )) {
    const query = new URLSearchParams(entry.search);
    assert.equal(entry.method, 'GET');
    assert.equal(query.get('roles'), 'assistant');
    assert.equal(query.get('compact'), 'false');
    assert.equal(query.get('order'), 'desc');
    assert.equal(query.get('limit'), '500');
  }

  const firstChunks = notifications
    .filter((message) => message.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map((message) => {
      assert.equal(message.jsonrpc, '2.0');
      assert.equal(message.method, 'session/update');
      assert.equal(message.params.sessionId, created.sessionId);
      assert.equal(message.params.update.content.type, 'text');
      return message.params.update.content.text;
    });
  assert.deepEqual(firstChunks, ['Hello', ' from SAM.']);

  assert.deepEqual(
    await request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: firstPrompt.replace('hello', 'again') }],
    }),
    { stopReason: 'end_turn' }
  );

  const allChunks = notifications
    .filter((message) => message.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map((message) => message.params.update.content.text);
  assert.deepEqual(allChunks, ['Hello', ' from SAM.', 'Second turn.']);

  const followup = requests.find(
    (entry) =>
      entry.method === 'POST' && entry.path === `${projectPath}/sessions/sam-session-1/prompt`
  );
  assert.deepEqual(Object.keys(followup.body), ['content']);
  assert.match(followup.body.content, /Content: again/);
  assert.match(followup.body.content, /SAM Buzz ACP prototype transport/);

  await assert.rejects(
    request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [
        {
          type: 'text',
          text: firstPrompt.replaceAll(channelId, otherChannelId),
        },
      ],
    }),
    /already bound to Buzz channel/
  );

  const cancelled = request('session/prompt', {
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: firstPrompt.replace('hello', 'cancel this') }],
  });
  await waitFor(() => promptPosts === 2);
  notify('session/cancel', { sessionId: created.sessionId });
  assert.deepEqual(await cancelled, { stopReason: 'cancelled' });
  assert.equal(cancelPosts, 1);
  assert.equal(
    requests.filter(
      (entry) =>
        entry.method === 'POST' && entry.path === `${projectPath}/sessions/sam-session-1/cancel`
    ).length,
    1
  );
  assert.ok(
    requests.some(
      (entry) =>
        entry.method === 'GET' && entry.path === `${projectPath}/sessions/sam-session-1/state`
    )
  );

  const buzzPosts = (await readFile(buzzLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(buzzPosts.length, 2, 'cancelled turn must not post a partial reply');
  assert.deepEqual(buzzPosts[0].args, [
    'messages',
    'send',
    '--channel',
    channelId,
    '--content',
    '-',
    '--reply-to',
    replyId,
  ]);
  assert.equal(buzzPosts[0].content, 'Hello from SAM.');
  assert.equal(buzzPosts[1].content, 'Second turn.');
  assert.equal(buzzPosts[0].buzzPrivateKey, 'nsec-demo-only');
  assert.deepEqual(buzzPosts[0].secrets, {
    samSessionCookie: null,
    samApiToken: null,
    samMcpToken: null,
    ghToken: null,
    githubToken: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    cloudflareToken: null,
    awsSecretAccessKey: null,
  });
  assert.equal(JSON.stringify(requests).includes('nsec-demo-only'), false);

  await assert.rejects(
    postToBuzz(
      { buzzCli: fakeBuzz, buzzStderrLimit: 1_000, buzzTimeoutMs: 1_000 },
      { channelId, replyTo: null },
      '__HANG__',
      {
        ...process.env,
        BUZZ_FAKE_LOG: buzzLog,
        BUZZ_PRIVATE_KEY: 'nsec-demo-only',
        SAM_SESSION_COOKIE: 'must-not-reach-buzz',
        OPENAI_API_KEY: 'must-not-reach-buzz',
      }
    ),
    /Buzz CLI timed out after 1000ms/
  );
  const timeoutPost = (await readFile(buzzLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(timeoutPost.content, '__HANG__');
  assert.throws(() => process.kill(timeoutPost.pid, 0), { code: 'ESRCH' });

  assert.equal(
    requests.some((entry) => entry.path.includes('/terminal/') || entry.path.includes('/agent/ws')),
    false,
    'prototype must stay on control-plane session/task endpoints'
  );

  child.stdin.end();
  await waitFor(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, stderr);
  assert.equal(pending.size, 0);

  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await rm(scratch, { recursive: true, force: true });
  console.log('Buzz ↔ SAM ACP smoke transcript passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
