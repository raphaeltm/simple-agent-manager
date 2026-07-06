/**
 * Admin Sandbox SDK prototype routes.
 *
 * Experimental admin-only endpoints for prototyping Cloudflare Sandbox SDK
 * capabilities (exec, file I/O, git checkout, backup/restore, streaming,
 * terminal PTY, and agent CLI setup probes).
 * NOT exposed to regular users — gated behind requireSuperadmin().
 *
 * These routes exist solely to measure and evaluate whether the Sandbox SDK
 * is viable for SAM project-level and top-level agents.
 *
 * Kill switch: SANDBOX_ENABLED env var (default: false).
 */
import type { ISandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';

import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';

const adminSandboxRoutes = new Hono<{ Bindings: Env }>();

adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

const DEFAULT_SETUP_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_PROBE_OUTPUT_MAX_CHARS = 4000;
const TOKEN_LIKE_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
];

type SandboxTerminalProxy = ISandbox & {
  terminal(request: Request, options?: { cols?: number; rows?: number }): Promise<Response>;
};

/** Resolve sandbox configuration from env vars with defaults. */
function getSandboxConfig(env: Env) {
  return {
    enabled: env.SANDBOX_ENABLED === 'true',
    execTimeoutMs: parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '30000', 10),
    gitTimeoutMs: parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '120000', 10),
    setupProbeTimeoutMs: parseInt(
      env.SANDBOX_SETUP_PROBE_TIMEOUT_MS || String(DEFAULT_SETUP_PROBE_TIMEOUT_MS),
      10
    ),
    probeOutputMaxChars: parseInt(
      env.SANDBOX_PROBE_OUTPUT_MAX_CHARS || String(DEFAULT_PROBE_OUTPUT_MAX_CHARS),
      10
    ),
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
async function getSandboxInstance(env: Env, sandboxId: string): Promise<SandboxTerminalProxy> {
  try {
    // Dynamic import — @cloudflare/sandbox may not be available in all envs
    const { getSandbox } = await import('@cloudflare/sandbox');
    if (!env.SANDBOX) {
      throw errors.badRequest('SANDBOX binding not available.');
    }
    return getSandbox(env.SANDBOX, sandboxId) as unknown as SandboxTerminalProxy;
  } catch (err) {
    throw errors.internal(
      `Failed to initialize Sandbox SDK: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeProbeOutput(value: string, maxChars: number): string {
  let sanitized = value;
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  if (sanitized.length > maxChars) {
    return `${sanitized.slice(0, maxChars)}\n[TRUNCATED]`;
  }
  return sanitized;
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
      setupProbeTimeoutMs: config.setupProbeTimeoutMs,
      probeOutputMaxChars: config.probeOutputMaxChars,
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
 * GET /api/admin/sandbox/terminal — Proxy a browser terminal WebSocket to a sandbox PTY.
 *
 * Query: ?sandboxId=...&cols=120&rows=30
 * Returns: WebSocket upgrade response from the Sandbox SDK.
 */
adminSandboxRoutes.get('/terminal', async (c) => {
  requireSandbox(c.env);

  const sandboxId = c.req.query('sandboxId') || 'sam-prototype';
  const cols = parsePositiveInt(c.req.query('cols'), 120);
  const rows = parsePositiveInt(c.req.query('rows'), 30);
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  return sandbox.terminal(c.req.raw, { cols, rows });
});

/**
 * POST /api/admin/sandbox/cli-probe — Check whether setup CLIs are available.
 *
 * Body: { sandboxId?: string }
 * Returns version/path details. No credential flow is started.
 */
adminSandboxRoutes.post('/cli-probe', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);
  const body = await c.req.json<{ sandboxId?: string }>().catch((): { sandboxId?: string } => ({}));
  const sandboxId = body.sandboxId || 'sam-setup-cli-probe';
  const sandbox = await getSandboxInstance(c.env, sandboxId);

  const result = await sandbox.exec(
    [
      'set -u',
      'printf "node=%s\\n" "$(node --version 2>/dev/null || true)"',
      'printf "npm=%s\\n" "$(npm --version 2>/dev/null || true)"',
      'printf "codex_path=%s\\n" "$(command -v codex 2>/dev/null || true)"',
      'printf "codex_version=%s\\n" "$(codex --version 2>/dev/null || true)"',
      'printf "claude_path=%s\\n" "$(command -v claude 2>/dev/null || true)"',
      'printf "claude_version=%s\\n" "$(claude --version 2>/dev/null || true)"',
    ].join('\n'),
    { timeout: config.execTimeoutMs }
  );

  return c.json({
    sandboxId,
    success: result.success,
    exitCode: result.exitCode,
    stdout: sanitizeProbeOutput(result.stdout, config.probeOutputMaxChars),
    stderr: sanitizeProbeOutput(result.stderr, config.probeOutputMaxChars),
  });
});

/**
 * POST /api/admin/sandbox/setup-flow-probe — Start login setup commands with redaction.
 *
 * This intentionally does not save credentials. It validates whether the CLIs
 * can start their headless setup flows inside a Sandbox container.
 *
 * Body: { agentType: 'openai-codex' | 'claude-code', sandboxId?: string }
 */
adminSandboxRoutes.post('/setup-flow-probe', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);
  const body = await c.req.json<{
    agentType: 'openai-codex' | 'claude-code';
    sandboxId?: string;
  }>();
  if (body.agentType !== 'openai-codex' && body.agentType !== 'claude-code') {
    throw errors.badRequest('agentType must be openai-codex or claude-code');
  }

  const sandboxId = body.sandboxId || `sam-setup-${body.agentType}`;
  const sandbox = await getSandboxInstance(c.env, sandboxId);
  const setupHome = `/tmp/sam-setup-${body.agentType}`;
  const command =
    body.agentType === 'openai-codex'
      ? [
          `rm -rf ${setupHome}`,
          `mkdir -p ${setupHome}`,
          `cat > ${setupHome}/config.toml <<'EOF'`,
          'cli_auth_credentials_store = "file"',
          'EOF',
          `CODEX_HOME=${setupHome} HOME=${setupHome} timeout ${Math.ceil(
            config.setupProbeTimeoutMs / 1000
          )}s codex login --device-auth`,
        ].join('\n')
      : [
          `rm -rf ${setupHome}`,
          `mkdir -p ${setupHome}`,
          `CLAUDE_CONFIG_DIR=${setupHome} HOME=${setupHome} NO_BROWSER=1 timeout ${Math.ceil(
            config.setupProbeTimeoutMs / 1000
          )}s claude setup-token`,
        ].join('\n');

  const result = await sandbox.exec(command, {
    timeout: config.setupProbeTimeoutMs + 5000,
  });

  const authFileCheck =
    body.agentType === 'openai-codex'
      ? await sandbox.exec(
          `test -f ${setupHome}/auth.json && jq '{auth_mode, has_tokens: (.tokens != null), has_access_token: ((.tokens.access_token // "") != ""), has_refresh_token: ((.tokens.refresh_token // "") != "")}' ${setupHome}/auth.json || true`,
          { timeout: 5000 }
        )
      : null;

  await sandbox.exec(`rm -rf ${setupHome}`, { timeout: 5000 }).catch(() => undefined);

  return c.json({
    agentType: body.agentType,
    sandboxId,
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.exitCode === 124,
    stdout: sanitizeProbeOutput(result.stdout, config.probeOutputMaxChars),
    stderr: sanitizeProbeOutput(result.stderr, config.probeOutputMaxChars),
    authFileSummary: authFileCheck
      ? {
          success: authFileCheck.success,
          exitCode: authFileCheck.exitCode,
          stdout: sanitizeProbeOutput(authFileCheck.stdout, config.probeOutputMaxChars),
          stderr: sanitizeProbeOutput(authFileCheck.stderr, config.probeOutputMaxChars),
        }
      : null,
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

export { adminSandboxRoutes };
