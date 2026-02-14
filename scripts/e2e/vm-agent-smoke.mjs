#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const WORKSPACE_ID = 'ws-e2e';
const VM_AGENT_PORT = 18080;
const CONTROL_PLANE_PORT = 19081;
const CALLBACK_TOKEN = 'callback-e2e-token';
const JWT_KID = 'e2e-key';
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.vm-agent.yml');
const WRANGLER_CLI_PATH = path.join(
  repoRoot,
  'apps',
  'api',
  'node_modules',
  'wrangler',
  'wrangler-dist',
  'cli.js'
);
const CONTROL_PLANE_MODES = new Set(['mock', 'worker']);

function log(message) {
  process.stdout.write(`[e2e-smoke] ${message}\n`);
}

function parseCliOptions(argv) {
  let controlPlane = process.env.E2E_CONTROL_PLANE ?? 'mock';

  for (const arg of argv) {
    if (arg.startsWith('--control-plane=')) {
      controlPlane = arg.slice('--control-plane='.length);
    }
  }

  if (!CONTROL_PLANE_MODES.has(controlPlane)) {
    throw new Error(
      `Invalid control-plane mode "${controlPlane}". Expected one of: ${Array.from(CONTROL_PLANE_MODES).join(', ')}`
    );
  }

  return { controlPlane };
}

function b64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload, privateKeyPem) {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: JWT_KID,
  };

  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`${command} ${args.join(' ')} failed with code ${code}\n${stderr || stdout}`)
        );
      }
    });
  });
}

async function buildVmAgentBinary() {
  const binaryPath = '/tmp/sam-vm-agent-e2e';
  await runCommand('go', ['build', '-o', binaryPath, '.'], {
    cwd: path.join(repoRoot, 'packages', 'vm-agent'),
  });
  return binaryPath;
}

function startControlPlaneMock(publicJwk) {
  const sockets = new Set();
  const state = {
    lastAgentKeyRequest: null,
    lastGitTokenRequest: null,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, use: 'sig', alg: 'RS256', kid: JWT_KID }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === `/api/workspaces/${WORKSPACE_ID}/agent-key`) {
      const auth = req.headers.authorization ?? '';
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json', message: 'Invalid JSON body' }));
          return;
        }

        state.lastAgentKeyRequest = {
          auth,
          body: parsed,
        };

        if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid callback token' }));
          return;
        }

        if (!parsed.agentType) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request', message: 'agentType is required' }));
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ apiKey: `sk-e2e-${parsed.agentType}` }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === `/api/workspaces/${WORKSPACE_ID}/git-token`) {
      const auth = req.headers.authorization ?? '';
      state.lastGitTokenRequest = { auth };

      if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid callback token' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          token: 'ghs-e2e-refresh-token',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === `/api/workspaces/${WORKSPACE_ID}/heartbeat`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          action: 'continue',
          idleSeconds: 0,
          maxIdleSeconds: 1800,
          shutdownDeadline: new Date(Date.now() + 1800_000).toISOString(),
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', message: 'Route not found' }));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    getIssuer() {
      return `http://127.0.0.1:${CONTROL_PLANE_PORT}`;
    },
    async getState() {
      return state;
    },
    async start() {
      await new Promise((resolve) => server.listen(CONTROL_PLANE_PORT, '127.0.0.1', resolve));
      log(`Control-plane mock listening on http://127.0.0.1:${CONTROL_PLANE_PORT}`);
    },
    async stop() {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          for (const socket of sockets) {
            socket.destroy();
          }
          resolve();
        }, 2_000);

        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

async function loadWranglerStartWorker() {
  let module;
  try {
    module = await import(pathToFileURL(WRANGLER_CLI_PATH).href);
  } catch (error) {
    throw new Error(
      `Unable to load Wrangler from ${WRANGLER_CLI_PATH}. Run pnpm install before using --control-plane=worker.`,
      { cause: error }
    );
  }

  if (typeof module.unstable_startWorker !== 'function') {
    throw new Error('Wrangler API unstable_startWorker is unavailable');
  }

  return module.unstable_startWorker;
}

function startControlPlaneWorker(publicJwk) {
  const workerEntrypoint = path.join(__dirname, 'control-plane-worker.mjs');
  const publicJwkWithMetadata = {
    ...publicJwk,
    use: 'sig',
    alg: 'RS256',
    kid: JWT_KID,
  };

  let worker = null;
  let issuer = `http://127.0.0.1:${CONTROL_PLANE_PORT}`;

  return {
    getIssuer() {
      return issuer;
    },
    async getState() {
      const response = await fetch(`${issuer}/__e2e/state`);
      if (!response.ok) {
        throw new Error(`Failed to read control-plane worker state: HTTP ${response.status}`);
      }
      return response.json();
    },
    async start() {
      const unstableStartWorker = await loadWranglerStartWorker();
      worker = await unstableStartWorker({
        name: 'sam-e2e-control-plane',
        entrypoint: workerEntrypoint,
        compatibilityDate: '2024-01-01',
        sendMetrics: false,
        bindings: {
          WORKSPACE_ID: { type: 'plain_text', value: WORKSPACE_ID },
          CALLBACK_TOKEN: { type: 'plain_text', value: CALLBACK_TOKEN },
          PUBLIC_JWK: { type: 'json', value: publicJwkWithMetadata },
        },
        dev: {
          remote: false,
          watch: false,
          persist: false,
          server: {
            hostname: '127.0.0.1',
            port: CONTROL_PLANE_PORT,
          },
        },
      });

      await worker.ready;
      issuer = (await worker.url).origin;
      log(`Control-plane worker listening on ${issuer}`);
    },
    async stop() {
      if (worker) {
        await worker.dispose();
      }
    },
  };
}

function connectWebSocket(url, timeoutMs = 10_000, options = undefined) {
  return new Promise((resolve, reject) => {
    const ws = options ? new WebSocket(url, options) : new WebSocket(url);

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connect timeout: ${url}`));
    }, timeoutMs);

    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true }
    );

    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error while connecting: ${url}`));
      },
      { once: true }
    );
  });
}

function decodeMessageData(data) {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer).toString('utf8');
  }

  return String(data);
}

function waitForJsonMessage(ws, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for matching WebSocket message'));
    }, timeoutMs);

    const onMessage = (event) => {
      try {
        const text = decodeMessageData(event.data);
        const parsed = JSON.parse(text);
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // Ignore non-JSON messages.
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before expected message was received'));
    };

    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose, { once: true });
  });
}

async function waitForHttpReady(url, timeoutMs = 15_000) {
  const start = Date.now();
  let lastError = 'unknown';

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

function startVmAgent(privateKeyPem, issuer, binaryPath) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const vmAgentEnv = {
    ...process.env,
    VM_AGENT_HOST: '127.0.0.1',
    VM_AGENT_PORT: String(VM_AGENT_PORT),
    CONTROL_PLANE_URL: issuer,
    JWKS_ENDPOINT: `${issuer}/.well-known/jwks.json`,
    JWT_ISSUER: issuer,
    JWT_AUDIENCE: 'workspace-terminal',
    WORKSPACE_ID,
    CALLBACK_TOKEN,
    CONTAINER_MODE: 'true',
    CONTAINER_LABEL_KEY: 'devcontainer.local_folder',
    CONTAINER_LABEL_VALUE: '/workspace-e2e',
    CONTAINER_WORK_DIR: '/workspace',
    CONTAINER_USER: 'root',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    IDLE_TIMEOUT: '24h',
    HEARTBEAT_INTERVAL: '24h',
    ACP_MAX_RESTART_ATTEMPTS: '1',
    PERSISTENCE_DB_PATH: '/tmp/sam-e2e-state.db',
    BOOTSTRAP_STATE_PATH: '/tmp/sam-e2e-bootstrap-state.json',
  };

  const sampleToken = signJwt(
    {
      iss: issuer,
      sub: 'user-e2e',
      aud: 'workspace-terminal',
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      workspace: WORKSPACE_ID,
    },
    privateKeyPem
  );

  const child = spawn(binaryPath, [], {
    env: vmAgentEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[vm-agent] ${chunk.toString()}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[vm-agent] ${chunk.toString()}`);
  });

  return {
    child,
    sampleToken,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 5_000);

        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function runTerminalSmoke(jwtToken) {
  const terminalWsUrl = `ws://127.0.0.1:${VM_AGENT_PORT}/terminal/ws?token=${encodeURIComponent(jwtToken)}&rows=24&cols=80`;
  const ws = await connectWebSocket(terminalWsUrl);

  try {
    await waitForJsonMessage(ws, (msg) => msg.type === 'session');

    ws.send(
      JSON.stringify({
        type: 'input',
        data: { data: 'echo terminal-smoke\n' },
      })
    );

    await waitForJsonMessage(
      ws,
      (msg) =>
        msg.type === 'output' &&
        typeof msg.data?.data === 'string' &&
        msg.data.data.includes('terminal-smoke'),
      15_000
    );

    log('Terminal smoke test passed');
  } finally {
    ws.close();
  }
}

async function runAcpSmoke(jwtToken, controlPlane) {
  const acpWsUrl = `ws://127.0.0.1:${VM_AGENT_PORT}/agent/ws?token=${encodeURIComponent(jwtToken)}`;
  const ws = await connectWebSocket(acpWsUrl, 10_000, {
    headers: {
      'X-SAM-Workspace-Id': WORKSPACE_ID,
      'X-SAM-Node-Id': WORKSPACE_ID,
    },
  });

  try {
    ws.send(JSON.stringify({ type: 'select_agent', agentType: 'claude-code' }));

    await waitForJsonMessage(
      ws,
      (msg) =>
        msg.type === 'agent_status' && msg.status === 'starting' && msg.agentType === 'claude-code',
      15_000
    );

    await waitForJsonMessage(
      ws,
      (msg) =>
        msg.type === 'agent_status' && msg.status === 'ready' && msg.agentType === 'claude-code',
      15_000
    );

    const controlPlaneState = await controlPlane.getState();

    if (!controlPlaneState.lastAgentKeyRequest) {
      throw new Error('Control-plane endpoint did not receive agent-key request');
    }

    if (controlPlaneState.lastAgentKeyRequest.auth !== `Bearer ${CALLBACK_TOKEN}`) {
      throw new Error('VM Agent did not send expected callback token to control-plane endpoint');
    }

    if (controlPlaneState.lastAgentKeyRequest.body.agentType !== 'claude-code') {
      throw new Error('VM Agent requested wrong agentType from control-plane endpoint');
    }

    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: {
          prompt: [{ type: 'text', text: 'ping' }],
        },
      })
    );

    await waitForJsonMessage(
      ws,
      (msg) =>
        msg.jsonrpc === '2.0' &&
        msg.method === 'session/update' &&
        msg.params?.update?.sessionUpdate === 'agent_message_chunk' &&
        typeof msg.params?.update?.content?.text === 'string' &&
        msg.params.update.content.text.includes('E2E:ping'),
      15_000
    );

    log('ACP smoke test passed');
  } finally {
    ws.close();
  }
}

async function runGitCredentialSmoke(controlPlane) {
  const response = await fetch(`http://127.0.0.1:${VM_AGENT_PORT}/git-credential`, {
    headers: {
      Authorization: `Bearer ${CALLBACK_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`/git-credential returned HTTP ${response.status}`);
  }

  const body = await response.text();
  const requiredLines = [
    'protocol=https',
    'host=github.com',
    'username=x-access-token',
    'password=ghs-e2e-refresh-token',
  ];

  for (const line of requiredLines) {
    if (!body.includes(line)) {
      throw new Error(`/git-credential response missing expected line: ${line}`);
    }
  }

  const controlPlaneState = await controlPlane.getState();
  if (!controlPlaneState.lastGitTokenRequest) {
    throw new Error('Control-plane endpoint did not receive git-token request');
  }
  if (controlPlaneState.lastGitTokenRequest.auth !== `Bearer ${CALLBACK_TOKEN}`) {
    throw new Error('VM Agent did not send expected callback token to git-token endpoint');
  }

  log('Git credential smoke test passed');
}

async function ensureWorkspaceContainerUp() {
  await runCommand('docker', [
    'compose',
    '-f',
    COMPOSE_FILE,
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  await runCommand('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--build']);

  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const { stdout } = await runCommand('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        'sam-e2e-workspace',
      ]);
      if (stdout.trim() === 'true') {
        log('Workspace container is running');
        return;
      }
    } catch {
      // retry
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for workspace container to start');
}

async function teardownWorkspaceContainer() {
  await runCommand('docker', [
    'compose',
    '-f',
    COMPOSE_FILE,
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  log(`Selected control-plane mode: ${options.controlPlane}`);

  log('Generating ephemeral JWT keypair for test run');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicJwk = publicKey.export({ format: 'jwk' });

  const controlPlane =
    options.controlPlane === 'worker'
      ? startControlPlaneWorker(publicJwk)
      : startControlPlaneMock(publicJwk);
  let vmAgent;

  try {
    log('Building VM Agent binary for smoke run');
    const vmAgentBinary = await buildVmAgentBinary();

    await ensureWorkspaceContainerUp();
    await controlPlane.start();
    const issuer = controlPlane.getIssuer();

    vmAgent = startVmAgent(privateKeyPem, issuer, vmAgentBinary);
    await waitForHttpReady(`http://127.0.0.1:${VM_AGENT_PORT}/health`);

    await runTerminalSmoke(vmAgent.sampleToken);
    await runGitCredentialSmoke(controlPlane);
    await runAcpSmoke(vmAgent.sampleToken, controlPlane);

    log('All smoke checks passed');
  } finally {
    if (vmAgent) {
      await vmAgent.stop();
    }

    await controlPlane.stop().catch(() => {});
    await teardownWorkspaceContainer().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[e2e-smoke] failed:', err);
  process.exit(1);
});
