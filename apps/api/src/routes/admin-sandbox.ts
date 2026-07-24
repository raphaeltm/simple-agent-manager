/**
 * Admin Sandbox SDK debugging routes.
 *
 * Experimental admin-only endpoints for prototyping Cloudflare Sandbox SDK
 * capabilities (exec, file I/O, git checkout, backup/restore, streaming).
 * NOT exposed to regular users — gated behind requireSuperadmin().
 *
 * The user-facing instant-session launch lives in services/instant-session.ts
 * plus the project chat start endpoint.
 *
 * Kill switch: SANDBOX_ENABLED env var (default: false).
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getSandboxConfig,
  getSandboxInstance,
  requireSandbox,
} from '../services/sandbox';

const adminSandboxRoutes = new Hono<{ Bindings: Env }>();

adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * Reject admin-toolbox access to any sandbox that belongs to a guided
 * credential-setup session. Those containers transit a live OpenAI/ChatGPT
 * credential (auth.json read server-side), and this superadmin debug tool shares
 * the same `SANDBOX` namespace — without this guard it could read or overwrite
 * an in-flight user credential (cross-feature isolation).
 */
async function assertNotCredentialSetupSandbox(env: Env, sandboxId: string): Promise<void> {
  const row = await env.DATABASE.prepare(
    'SELECT 1 FROM agent_credential_setup_sessions WHERE sandbox_id = ? LIMIT 1'
  )
    .bind(sandboxId)
    .first();
  if (row) {
    throw errors.forbidden(
      'This sandbox belongs to a guided credential-setup session and cannot be accessed via the admin toolbox.'
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
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
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
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
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
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
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
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
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
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
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

export { adminSandboxRoutes };
