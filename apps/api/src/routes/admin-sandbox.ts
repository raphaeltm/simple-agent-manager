/**
 * Admin Sandbox SDK prototype routes.
 *
 * Experimental admin-only endpoints for prototyping Cloudflare Sandbox SDK
 * capabilities (exec, file I/O, git checkout, backup/restore, streaming).
 * NOT exposed to regular users — gated behind requireSuperadmin().
 *
 * These routes exist solely to measure and evaluate whether the Sandbox SDK
 * is viable for SAM project-level and top-level agents.
 *
 * Kill switch: SANDBOX_ENABLED env var (default: false).
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';

const adminSandboxRoutes = new Hono<{ Bindings: Env }>();

adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/** Resolve sandbox configuration from env vars with defaults. */
function getSandboxConfig(env: Env) {
  return {
    enabled: env.SANDBOX_ENABLED === 'true',
    execTimeoutMs: parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '30000', 10),
    gitTimeoutMs: parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '120000', 10),
    sleepAfter: env.SANDBOX_SLEEP_AFTER || '10m',
  };
}

/** Guard: check that sandbox is enabled and binding exists. */
function requireSandbox(env: Env): void {
  const config = getSandboxConfig(env);
  if (!config.enabled) {
    throw errors.badRequest('Sandbox prototype is disabled. Set SANDBOX_ENABLED=true to enable.');
  }
  if (!env.SANDBOX) {
    throw errors.badRequest(
      'SANDBOX binding not available. The Containers binding may not be configured on this environment.'
    );
  }
}

/**
 * Helper to get a sandbox instance via the SDK.
 *
 * The Sandbox SDK uses `getSandbox(env.Sandbox, id)` to obtain a proxy.
 * Since the SDK may not be available in all environments (e.g., Miniflare),
 * we dynamically import it and handle failures gracefully.
 */
async function getSandboxInstance(env: Env, sandboxId: string) {
  try {
    // Dynamic import — @cloudflare/sandbox may not be available in all envs
    const { getSandbox } = await import('@cloudflare/sandbox');
    if (!env.SANDBOX) {
      throw errors.badRequest('SANDBOX binding not available.');
    }
    return getSandbox(env.SANDBOX, sandboxId);
  } catch (err) {
    throw errors.internal(
      `Failed to initialize Sandbox SDK: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * GET /api/admin/sandbox/status — Check sandbox availability and config.
 */
adminSandboxRoutes.get('/status', async (c) => {
  const config = getSandboxConfig(c.env);
  return c.json({
    enabled: config.enabled,
    bindingAvailable: !!c.env.SANDBOX,
    config: {
      execTimeoutMs: config.execTimeoutMs,
      gitTimeoutMs: config.gitTimeoutMs,
      sleepAfter: config.sleepAfter,
    },
  });
});

/**
 * POST /api/admin/sandbox/exec — Execute a command in the sandbox.
 *
 * Body: { command: string, sandboxId?: string }
 * Returns: { stdout, stderr, exitCode, success, durationMs }
 */
adminSandboxRoutes.post('/exec', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);

  const body = await c.req.json<{ command: string; sandboxId?: string }>();
  if (!body.command || typeof body.command !== 'string') {
    throw errors.badRequest('command is required and must be a string');
  }

  const sandboxId = body.sandboxId || 'sam-prototype';
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();
  const result = await sandbox.exec(body.command, {
    timeout: config.execTimeoutMs,
  });
  const durationMs = Date.now() - start;

  return c.json({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    success: result.success,
    durationMs,
    sandboxId,
  });
});

/**
 * POST /api/admin/sandbox/git-checkout — Clone a git repo into the sandbox.
 *
 * Body: { repoUrl: string, branch?: string, depth?: number, sandboxId?: string }
 * Returns: { durationMs, sandboxId }
 */
adminSandboxRoutes.post('/git-checkout', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);

  const body = await c.req.json<{
    repoUrl: string;
    branch?: string;
    depth?: number;
    sandboxId?: string;
  }>();
  if (!body.repoUrl || typeof body.repoUrl !== 'string') {
    throw errors.badRequest('repoUrl is required and must be a string');
  }

  const sandboxId = body.sandboxId || 'sam-prototype';
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();
  await sandbox.gitCheckout(body.repoUrl, {
    branch: body.branch,
    targetDir: '/workspace',
    depth: body.depth || 1,
  });
  const durationMs = Date.now() - start;

  // Verify clone by listing files
  const lsResult = await sandbox.exec('ls -la /workspace', {
    timeout: config.execTimeoutMs,
  });

  return c.json({
    durationMs,
    sandboxId,
    files: lsResult.stdout,
  });
});

/**
 * POST /api/admin/sandbox/files — Read or write files in the sandbox.
 *
 * Body: { action: 'read' | 'write' | 'exists', path: string, content?: string, sandboxId?: string }
 * Returns: { content?, exists?, durationMs }
 */
adminSandboxRoutes.post('/files', async (c) => {
  requireSandbox(c.env);

  const body = await c.req.json<{
    action: 'read' | 'write' | 'exists';
    path: string;
    content?: string;
    sandboxId?: string;
  }>();
  if (!body.action || !body.path) {
    throw errors.badRequest('action and path are required');
  }

  const sandboxId = body.sandboxId || 'sam-prototype';
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();

  if (body.action === 'write') {
    if (typeof body.content !== 'string') {
      throw errors.badRequest('content is required for write action');
    }
    await sandbox.writeFile(body.path, body.content);
    const durationMs = Date.now() - start;
    return c.json({ success: true, durationMs, sandboxId });
  }

  if (body.action === 'read') {
    const file = await sandbox.readFile(body.path);
    const durationMs = Date.now() - start;
    return c.json({ content: file.content, durationMs, sandboxId });
  }

  if (body.action === 'exists') {
    const result = await sandbox.exists(body.path);
    const durationMs = Date.now() - start;
    return c.json({ exists: result.exists, durationMs, sandboxId });
  }

  throw errors.badRequest('action must be read, write, or exists');
});

/**
 * POST /api/admin/sandbox/backup — Create or restore a backup.
 *
 * Body: { action: 'create' | 'restore', dir?: string, backupId?: string, sandboxId?: string }
 * Returns: { backupId?, success?, durationMs }
 */
adminSandboxRoutes.post('/backup', async (c) => {
  requireSandbox(c.env);

  const body = await c.req.json<{
    action: 'create' | 'restore';
    dir?: string;
    backupId?: string;
    backupDir?: string;
    sandboxId?: string;
  }>();
  if (!body.action) {
    throw errors.badRequest('action is required');
  }

  const sandboxId = body.sandboxId || 'sam-prototype';
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();

  if (body.action === 'create') {
    const dir = body.dir || '/workspace';
    const backup = await sandbox.createBackup({ dir, name: 'sam-prototype-backup' });
    const durationMs = Date.now() - start;
    return c.json({ backupId: backup.id, dir: backup.dir, durationMs, sandboxId });
  }

  if (body.action === 'restore') {
    if (!body.backupId) {
      throw errors.badRequest('backupId is required for restore action');
    }
    const result = await sandbox.restoreBackup({
      id: body.backupId,
      dir: body.backupDir || '/workspace',
    });
    const durationMs = Date.now() - start;
    return c.json({ success: result.success, durationMs, sandboxId });
  }

  throw errors.badRequest('action must be create or restore');
});

/**
 * GET /api/admin/sandbox/exec-stream — Stream command output via SSE.
 *
 * Query: ?command=...&sandboxId=...
 * Returns: SSE stream of exec events
 */
adminSandboxRoutes.get('/exec-stream', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);

  const command = c.req.query('command');
  if (!command) {
    throw errors.badRequest('command query parameter is required');
  }

  const sandboxId = c.req.query('sandboxId') || 'sam-prototype';
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const stream = await sandbox.execStream(command, {
    timeout: config.execTimeoutMs,
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

/**
 * PUT /api/admin/sandbox/harness — Upload harness binary to R2 for sandbox experiments.
 *
 * Body: raw binary (application/octet-stream)
 * Returns: { key, size, durationMs }
 */
adminSandboxRoutes.put('/harness', async (c) => {
  const body = await c.req.arrayBuffer();
  if (!body || body.byteLength === 0) {
    throw errors.badRequest('Request body is required (raw binary)');
  }

  const key = 'experiments/harness-linux-amd64';
  const start = Date.now();
  await c.env.R2.put(key, body, {
    httpMetadata: { contentType: 'application/x-elf' },
  });
  const durationMs = Date.now() - start;

  return c.json({ key, size: body.byteLength, durationMs });
});

/**
 * GET /api/admin/sandbox/harness — Download harness binary from R2 (for sandbox curl).
 *
 * Returns: raw binary stream
 */
adminSandboxRoutes.get('/harness', async (c) => {
  const obj = await c.env.R2.get('experiments/harness-linux-amd64');
  if (!obj) {
    throw errors.notFound('Harness binary not found in R2');
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
    },
  });
});

/**
 * POST /api/admin/sandbox/run-harness — Run harness binary inside a sandbox container.
 *
 * Downloads the harness from R2 via the Worker, writes it into the sandbox,
 * creates a test fixture, and runs the harness against the SAM AI proxy.
 *
 * Body: { model?: string, prompt?: string, maxTurns?: number, sandboxId?: string, apiKey?: string }
 * Returns: { steps[], result, durationMs }
 */
adminSandboxRoutes.post('/run-harness', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);

  const body = await c.req.json<{
    model?: string;
    prompt?: string;
    maxTurns?: number;
    sandboxId?: string;
    apiKey?: string;
  }>();

  const sandboxId = body.sandboxId || 'harness-experiment';
  const model = body.model || '@cf/google/gemma-4-26b-a4b-it';
  const maxTurns = body.maxTurns || 5;
  const prompt = body.prompt || 'Use the read_file tool to read README.md, then summarize what this project contains.';
  const apiKey = body.apiKey || '';

  if (!apiKey) {
    throw errors.badRequest('apiKey is required (MCP token or callback token for SAM AI proxy)');
  }

  const sandbox = await getSandboxInstance(c.env, sandboxId);
  const steps: Array<{ step: string; durationMs: number; success: boolean; detail?: string }> = [];
  const totalStart = Date.now();

  // Step 1: Download harness binary from R2 and write to sandbox
  const r2Obj = await c.env.R2.get('experiments/harness-linux-amd64');
  if (!r2Obj) {
    throw errors.badRequest('Harness binary not found in R2. Upload it first via PUT /api/admin/sandbox/harness');
  }

  let step1Start = Date.now();
  const binaryData = await r2Obj.arrayBuffer();
  // Write binary via exec: base64 decode approach
  // Sandbox writeFile expects string, so we use exec with base64
  const base64Chunks: string[] = [];
  const uint8 = new Uint8Array(binaryData);
  // Convert to base64 in chunks to avoid string length limits
  const CHUNK_SIZE = 65536;
  for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
    const chunk = uint8.slice(i, i + CHUNK_SIZE);
    // Use btoa with binary string
    let binary = '';
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]!);
    }
    base64Chunks.push(btoa(binary));
  }
  const fullBase64 = base64Chunks.join('');
  steps.push({ step: 'r2_download', durationMs: Date.now() - step1Start, success: true, detail: `${binaryData.byteLength} bytes` });

  // Step 2: Write base64 to file and decode in sandbox
  step1Start = Date.now();
  // Write base64 string to a temp file
  await sandbox.writeFile('/tmp/harness.b64', fullBase64);
  // Decode it
  const decodeResult = await sandbox.exec('base64 -d /tmp/harness.b64 > /tmp/harness && chmod +x /tmp/harness && rm /tmp/harness.b64 && ls -la /tmp/harness', {
    timeout: config.execTimeoutMs,
  });
  steps.push({
    step: 'write_binary',
    durationMs: Date.now() - step1Start,
    success: decodeResult.success,
    detail: decodeResult.stdout || decodeResult.stderr,
  });

  if (!decodeResult.success) {
    return c.json({ steps, error: 'Failed to write harness binary', detail: decodeResult.stderr, durationMs: Date.now() - totalStart });
  }

  // Step 3: Create test fixture
  step1Start = Date.now();
  const mkdirResult = await sandbox.exec('mkdir -p /workspace/test-repo', { timeout: 5000 });
  await sandbox.writeFile('/workspace/test-repo/README.md', '# Test Project\n\nThis is a test project for the SAM harness experiment.\nIt demonstrates the harness running inside a Cloudflare Container.\n');
  await sandbox.writeFile('/workspace/test-repo/main.go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from the test project")\n}\n');
  steps.push({
    step: 'create_fixture',
    durationMs: Date.now() - step1Start,
    success: mkdirResult.success,
  });

  // Step 4: Run the harness
  step1Start = Date.now();
  const baseUrl = `https://api.${c.env.BASE_DOMAIN || 'sammy.party'}/ai/v1`;
  const harnessCmd = [
    '/tmp/harness',
    '--provider', 'openai-proxy',
    '--base-url', baseUrl,
    '--api-key', apiKey,
    '--model', model,
    '--tool-choice', 'auto',
    '--max-turns', String(maxTurns),
    '--dir', '/workspace/test-repo',
    '--transcript', '/tmp/harness-transcript.json',
    '--prompt', prompt,
  ].map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');

  const harnessResult = await sandbox.exec(harnessCmd, {
    timeout: 120000, // 2 min timeout for LLM calls
  });
  steps.push({
    step: 'run_harness',
    durationMs: Date.now() - step1Start,
    success: harnessResult.success,
    detail: (harnessResult.stdout + '\n' + harnessResult.stderr).trim(),
  });

  // Step 5: Read transcript if available
  let transcript: string | undefined;
  try {
    const transcriptFile = await sandbox.readFile('/tmp/harness-transcript.json');
    transcript = transcriptFile.content;
  } catch {
    // Transcript may not exist if harness failed early
  }

  return c.json({
    steps,
    stdout: harnessResult.stdout,
    stderr: harnessResult.stderr,
    exitCode: harnessResult.exitCode,
    transcript: transcript ? JSON.parse(transcript) : undefined,
    durationMs: Date.now() - totalStart,
    config: { model, maxTurns, baseUrl, sandboxId },
  });
});

export { adminSandboxRoutes };
