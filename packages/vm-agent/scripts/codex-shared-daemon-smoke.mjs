#!/usr/bin/env node

import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createConnection, createServer } from 'node:net';

const VERSION = '0.156.1';
const CODEX_CLI = process.env.SAM_CODEX_SHARED_DAEMON_CLI ?? 'codex';
function positiveInteger(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const TIMEOUT_MS = positiveInteger('SAM_CODEX_SHARED_DAEMON_SMOKE_TIMEOUT_MS', 120_000);
const EXIT_TIMEOUT_MS = positiveInteger('SAM_CODEX_SHARED_DAEMON_SMOKE_EXIT_TIMEOUT_MS', 10_000);
const SOCKET_ATTEMPTS = positiveInteger('SAM_CODEX_SHARED_DAEMON_SMOKE_SOCKET_ATTEMPTS', 100);
const SOCKET_POLL_MS = positiveInteger('SAM_CODEX_SHARED_DAEMON_SMOKE_SOCKET_POLL_MS', 50);
const here = dirname(fileURLToPath(import.meta.url));
const bridge = resolve(here, '../internal/acp/codex_shared_daemon_bridge.mjs');

function fail(message) {
  throw new Error(message);
}
function hasExactVersionToken(identity, version) {
  return identity.split(/[\s/();]+/u).includes(version);
}
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function withTimeout(promise, label, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref();
    }),
  ]);
}

class ProtocolClient {
  constructor(name, env, cwd) {
    this.name = name;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.process = spawn(process.execPath, [bridge, 'app-server'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.exited = new Promise((resolveExit) => this.process.once('exit', resolveExit));
    createInterface({ input: this.process.stdout }).on('line', (line) =>
      this.receive(JSON.parse(line))
    );
  }
  receive(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        message.error
          ? pending.reject(new Error(`protocol error ${message.error.code ?? 'unknown'}`))
          : pending.resolve(message.result);
      }
      return;
    }
    this.events.push(message);
    let waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    while (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
      waiterIndex = this.waiters.findIndex((candidate) => candidate.predicate(message));
    }
  }
  call(method, params) {
    const id = String(++this.nextId);
    const promise = new Promise((resolveCall, reject) =>
      this.pending.set(id, { resolve: resolveCall, reject })
    );
    this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return withTimeout(promise, `${this.name} ${method}`);
  }
  notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }
  waitFor(predicate, label) {
    const existing = this.events.find((event) => predicate(event));
    if (existing) return Promise.resolve(existing);
    return withTimeout(
      new Promise((resolveWait) => this.waiters.push({ predicate, resolve: resolveWait })),
      `${this.name} ${label}`
    );
  }
  async initialize() {
    const response = await this.call('initialize', {
      clientInfo: { name: this.name, title: this.name, version: VERSION },
      capabilities: { experimentalApi: true },
    });
    if (!hasExactVersionToken(response?.userAgent ?? '', VERSION))
      fail(`${this.name} reported server version does not match the pinned version ${VERSION}`);
    this.notify('initialized', {});
  }
  async close() {
    if (this.closing !== undefined) return this.closing;
    this.process.stdin.end();
    this.process.kill('SIGTERM');
    this.closing = (async () => {
      const graceful =
        this.process.exitCode != null ||
        this.process.signalCode != null ||
        (await Promise.race([
          this.exited.then(() => true),
          delay(EXIT_TIMEOUT_MS).then(() => false),
        ]));
      if (!graceful) {
        this.process.kill('SIGKILL');
        await this.waitForExit();
      }
      this.process.stdout.destroy();
    })();
    return this.closing;
  }
  waitForExit() {
    return withTimeout(this.exited, `${this.name} bridge exit`, EXIT_TIMEOUT_MS);
  }
}

async function waitForSocket(path) {
  for (let attempt = 0; attempt < SOCKET_ATTEMPTS; attempt += 1) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch {}
    await delay(SOCKET_POLL_MS);
  }
  fail('pinned app-server socket did not appear');
}

async function completedOnBoth(a, b, threadId, turnId) {
  const matches = (message) =>
    message.method === 'turn/completed' &&
    message.params?.threadId === threadId &&
    message.params?.turn?.id === turnId;
  await Promise.all([a.waitFor(matches, `turn ${turnId}`), b.waitFor(matches, `turn ${turnId}`)]);
}

async function main() {
  if (process.env.SAM_CODEX_SHARED_DAEMON_SMOKE !== '1')
    fail('set SAM_CODEX_SHARED_DAEMON_SMOKE=1 to authorize the live model smoke');
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) fail('CODEX_HOME must point to a dedicated test home');
  const version = spawnSync(CODEX_CLI, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== `codex-cli ${VERSION}`)
    fail(`requires codex-cli ${VERSION}`);

  const root = await mkdtemp(join(tmpdir(), 'sam-codex-shared-smoke-'));
  const workspace = join(root, 'workspace');
  const socketDir = join(workspace, '.sam-codex-shared-daemon');
  const runtimeDir = join(socketDir, 'runtime');
  const socket = join(socketDir, 'app-server.sock');
  let providerGeneration = 0;
  let providerSocket = join(socketDir, `provider-listener-${providerGeneration}.sock`);
  const ownerFile = `${socket}.sam-owner.json`;
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    SAM_CODEX_SHARED_DAEMON_CLI: CODEX_CLI,
    SAM_CODEX_SHARED_DAEMON_EXPECTED_VERSION: VERSION,
    SAM_CODEX_SHARED_DAEMON_SOCKET: socket,
    SAM_CODEX_SHARED_DAEMON_SOCKET_OWNER_FILE: ownerFile,
  };
  const startServer = () =>
    spawn(CODEX_CLI, ['app-server', '--listen', `unix://${providerSocket}`], {
      cwd: workspace,
      env,
      detached: true,
      stdio: 'ignore',
    });
  const startReplacementServer = () => {
    providerGeneration += 1;
    providerSocket = join(socketDir, `provider-listener-${providerGeneration}.sock`);
    return startServer();
  };
  const stopServer = (signal) => {
    if (server.exitCode == null && server.signalCode == null) {
      try {
        process.kill(-server.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  let server = startServer();
  let relay;
  const relayConnections = new Set();
  const clients = [];
  try {
    await waitForSocket(providerSocket);
    relay = createServer((downstream) => {
      const upstream = createConnection(providerSocket);
      relayConnections.add(downstream);
      relayConnections.add(upstream);
      downstream.pipe(upstream).pipe(downstream);
      const closeBoth = () => {
        downstream.destroy();
        upstream.destroy();
      };
      downstream.on('close', () => relayConnections.delete(downstream));
      upstream.on('close', () => relayConnections.delete(upstream));
      downstream.on('error', closeBoth);
      upstream.on('error', closeBoth);
    });
    await new Promise((resolveListen, rejectListen) => {
      relay.once('error', rejectListen);
      relay.listen(socket, resolveListen);
    });
    await chmod(socket, 0o600);
    await writeFile(
      ownerFile,
      `${JSON.stringify({ version: VERSION, socketPath: socket, realSocketPath: await realpath(socket) })}\n`,
      { mode: 0o600 }
    );
    const sam = new ProtocolClient('sam-spike', env, workspace);
    const native = new ProtocolClient('second-client', env, workspace);
    clients.push(sam, native);
    await Promise.all([sam.initialize(), native.initialize()]);
    if (process.env.SAM_CODEX_SHARED_DAEMON_SMOKE_PREFLIGHT_ONLY === '1') {
      const failedServerExit = new Promise((resolveExit) => server.once('exit', resolveExit));
      stopServer('SIGKILL');
      await withTimeout(failedServerExit, 'preflight daemon exit', EXIT_TIMEOUT_MS);
      await Promise.all([sam.waitForExit(), native.waitForExit()]);
      server = startReplacementServer();
      await waitForSocket(providerSocket);
      const recovered = new ProtocolClient('preflight-recovery-client', env, workspace);
      clients.push(recovered);
      await recovered.initialize();
      process.stdout.write(
        `${JSON.stringify({ version: VERSION, privateRelay: true, bridgeValidation: true, exactServerVersion: true, daemonFailureRecovery: true, modelTurns: 'not-run' }, null, 2)}\n`
      );
      return;
    }

    const started = await sam.call('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      baseInstructions: "Follow the user's request directly and keep replies short.",
    });
    const threadId = started.thread.id;
    const first = await sam.call('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: 'Create native-spike.txt containing exactly first-client, then reply done.',
        },
      ],
    });
    await sam.waitFor(
      (message) =>
        message.method === 'turn/completed' &&
        message.params?.threadId === threadId &&
        message.params?.turn?.id === first.turn.id,
      `turn ${first.turn.id}`
    );
    const resumed = await native.call('thread/resume', { threadId });
    if (resumed.thread.id !== threadId) fail('second client resumed a different thread');
    const second = await native.call('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: 'Append a newline and second-client to native-spike.txt, then reply done.',
        },
      ],
    });
    await completedOnBoth(sam, native, threadId, second.turn.id);

    const cancellable = await native.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Execute the shell command sleep 30, then reply done.' }],
    });
    await sam.waitFor(
      (message) =>
        message.method === 'item/started' &&
        message.params?.turnId === cancellable.turn.id &&
        message.params?.item?.type === 'commandExecution',
      'cancellable command start'
    );
    const steered = await sam.call('turn/steer', {
      threadId,
      expectedTurnId: cancellable.turn.id,
      input: [{ type: 'text', text: 'After the command, reply steered.' }],
    });
    if (steered.turnId !== cancellable.turn.id) fail('steering changed the active turn identity');
    await sam.call('turn/interrupt', { threadId, turnId: cancellable.turn.id });
    await completedOnBoth(sam, native, threadId, cancellable.turn.id);

    await native.close();
    const reconnected = new ProtocolClient('reconnected-client', env, workspace);
    clients.push(reconnected);
    await reconnected.initialize();
    await reconnected.call('thread/resume', { threadId });
    const replay = await reconnected.call('thread/read', { threadId, includeTurns: true });
    if (replay.thread.id !== threadId || replay.thread.turns.length < 3)
      fail('reconnect did not preserve thread history');
    const contents = await readFile(join(workspace, 'native-spike.txt'), 'utf8');
    if (contents.trim() !== 'first-client\nsecond-client')
      fail('workspace changes were not preserved across reconnect');

    const externalUser = sam.events.some(
      (event) =>
        event.method === 'item/completed' &&
        event.params?.item?.type === 'userMessage' &&
        event.params?.turnId === second.turn.id
    );
    const externalAssistant = sam.events.some(
      (event) =>
        event.method === 'item/completed' &&
        event.params?.item?.type === 'agentMessage' &&
        event.params?.turnId === second.turn.id
    );
    const externalTool = sam.events.some(
      (event) =>
        event.method === 'item/completed' &&
        ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.params?.item?.type) &&
        event.params?.turnId === second.turn.id
    );
    if (!externalUser || !externalAssistant || !externalTool)
      fail(
        "SAM-side client did not observe the second client's complete user/assistant/tool lifecycle"
      );

    // A daemon loss must close every proxy instead of leaving SAM falsely
    // connected. The persisted rollout can then be resumed by a replacement
    // daemon without changing the canonical thread identity.
    const failedServerExit = new Promise((resolveExit) => server.once('exit', resolveExit));
    stopServer('SIGKILL');
    await withTimeout(failedServerExit, 'failed daemon exit', EXIT_TIMEOUT_MS);
    await Promise.all([sam.waitForExit(), reconnected.waitForExit()]);
    server = startReplacementServer();
    await waitForSocket(providerSocket);
    const recovered = new ProtocolClient('failure-recovery-client', env, workspace);
    clients.push(recovered);
    await recovered.initialize();
    const recoveredThread = await recovered.call('thread/resume', { threadId });
    if (recoveredThread.thread.id !== threadId)
      fail('daemon recovery changed the canonical thread identity');

    process.stdout.write(
      `${JSON.stringify({ version: VERSION, threadId, sameThread: true, promptsFromBothClients: true, externalEvents: true, steering: true, interrupt: true, reconnectReplay: true, daemonFailureRecovery: true, workspacePreserved: true, nativeAppPairing: 'not-tested' }, null, 2)}\n`
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    for (const connection of relayConnections) connection.destroy();
    if (relay) await new Promise((resolveClose) => relay.close(resolveClose));
    stopServer('SIGTERM');
    const graceful =
      server.exitCode != null ||
      server.signalCode != null ||
      (await Promise.race([
        new Promise((resolveExit) => server.once('exit', () => resolveExit(true))),
        delay(EXIT_TIMEOUT_MS).then(() => false),
      ]));
    if (!graceful) {
      stopServer('SIGKILL');
      await withTimeout(
        new Promise((resolveExit) => server.once('exit', resolveExit)),
        'owned daemon cleanup',
        EXIT_TIMEOUT_MS
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`codex shared-daemon smoke failed: ${error.message}\n`);
  process.exitCode = 1;
}
