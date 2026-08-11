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
import * as v from 'valibot';

import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import { getSandboxConfig, getSandboxInstance, requireSandbox } from '../services/sandbox';

// All fields below are validated loosely (v.unknown(), wrapped in
// v.optional() so an entirely-missing key doesn't trip Valibot's own
// "Invalid key" rejection) so each handler's existing manual checks — which
// produce specific error messages — remain in control of the accepted
// domain. This is an experimental superadmin-only debug tool; the schemas
// only guarantee a JSON object with these keys.
const ExecCommandSchema = v.object({
  command: v.optional(v.unknown()),
  sandboxId: v.optional(v.unknown()),
});

const GitCheckoutSchema = v.object({
  repoUrl: v.optional(v.unknown()),
  branch: v.optional(v.unknown()),
  depth: v.optional(v.unknown()),
  sandboxId: v.optional(v.unknown()),
});

const SandboxFilesSchema = v.object({
  action: v.optional(v.unknown()),
  path: v.optional(v.unknown()),
  content: v.optional(v.unknown()),
  sandboxId: v.optional(v.unknown()),
});

const SandboxBackupSchema = v.object({
  action: v.optional(v.unknown()),
  dir: v.optional(v.unknown()),
  backupId: v.optional(v.unknown()),
  backupDir: v.optional(v.unknown()),
  sandboxId: v.optional(v.unknown()),
});

const adminSandboxRoutes = new Hono<{ Bindings: Env }>();

adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/** Resolve a sandboxId field (validated loosely as unknown) to a definite string, falling back to the shared prototype sandbox — mirrors the original `body.sandboxId || 'sam-prototype'` for every real string input. */
function resolveSandboxId(value: unknown): string {
  return typeof value === 'string' && value ? value : 'sam-prototype';
}

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
adminSandboxRoutes.post('/exec', jsonValidator(ExecCommandSchema), async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);

  const body = c.req.valid('json');
  const { command } = body;
  if (!command || typeof command !== 'string') {
    throw errors.badRequest('command is required and must be a string');
  }

  const sandboxId = resolveSandboxId(body.sandboxId);
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();
  const result = await sandbox.exec(command, {
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
adminSandboxRoutes.post('/git-checkout', jsonValidator(GitCheckoutSchema), async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);

  const body = c.req.valid('json');
  const { repoUrl } = body;
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw errors.badRequest('repoUrl is required and must be a string');
  }

  const sandboxId = resolveSandboxId(body.sandboxId);
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const depth = typeof body.depth === 'number' ? body.depth : undefined;

  const start = Date.now();
  await sandbox.gitCheckout(repoUrl, {
    branch,
    targetDir: '/workspace',
    depth: depth || 1,
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
adminSandboxRoutes.post('/files', jsonValidator(SandboxFilesSchema), async (c) => {
  requireSandbox(c.env);

  const body = c.req.valid('json');
  const { action, path } = body;
  // `path` also requires a string-type check (the original cast trusted the
  // caller-declared type); any other truthy `path` could never have
  // succeeded against the SDK's `string`-typed file methods either.
  if (!action || !path || typeof path !== 'string') {
    throw errors.badRequest('action and path are required');
  }

  const sandboxId = resolveSandboxId(body.sandboxId);
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();

  if (action === 'write') {
    const { content } = body;
    if (typeof content !== 'string') {
      throw errors.badRequest('content is required for write action');
    }
    await sandbox.writeFile(path, content);
    const durationMs = Date.now() - start;
    return c.json({ success: true, durationMs, sandboxId });
  }

  if (action === 'read') {
    const file = await sandbox.readFile(path);
    const durationMs = Date.now() - start;
    return c.json({ content: file.content, durationMs, sandboxId });
  }

  if (action === 'exists') {
    const result = await sandbox.exists(path);
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
adminSandboxRoutes.post('/backup', jsonValidator(SandboxBackupSchema), async (c) => {
  requireSandbox(c.env);

  const body = c.req.valid('json');
  const { action } = body;
  if (!action) {
    throw errors.badRequest('action is required');
  }

  const sandboxId = resolveSandboxId(body.sandboxId);
  await assertNotCredentialSetupSandbox(c.env, sandboxId);
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const start = Date.now();

  if (action === 'create') {
    const rawDir = body.dir;
    const dir = typeof rawDir === 'string' && rawDir ? rawDir : '/workspace';
    const backup = await sandbox.createBackup({ dir, name: 'sam-prototype-backup' });
    const durationMs = Date.now() - start;
    return c.json({ backupId: backup.id, dir: backup.dir, durationMs, sandboxId });
  }

  if (action === 'restore') {
    const { backupId } = body;
    // `backupId` also requires a string-type check (the original cast
    // trusted the caller-declared type); any other truthy `backupId` could
    // never have succeeded against the SDK's `string`-typed `id` field either.
    if (!backupId || typeof backupId !== 'string') {
      throw errors.badRequest('backupId is required for restore action');
    }
    const rawBackupDir = body.backupDir;
    const backupDir =
      typeof rawBackupDir === 'string' && rawBackupDir ? rawBackupDir : '/workspace';
    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: backupDir,
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
