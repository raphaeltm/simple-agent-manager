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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { signCallbackToken, signNodeCallbackToken } from '../services/jwt';
import {
  createAgentSessionOnNode,
  createWorkspaceOnNode,
  startAgentSessionOnNode,
  waitForNodeAgentReady,
} from '../services/node-agent';
import { createNodeRecord } from '../services/nodes';
import * as projectDataService from '../services/project-data';

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runCfVmAgentPhase<T>(
  phase: string,
  detail: { nodeId?: string; workspaceId?: string; sandboxId?: string },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  log.info('cf_vm_agent_phase_start', { phase, ...detail });
  try {
    const result = await fn();
    log.info('cf_vm_agent_phase_success', {
      phase,
      durationMs: Date.now() - start,
      ...detail,
    });
    return result;
  } catch (err) {
    log.error('cf_vm_agent_phase_error', {
      phase,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : undefined,
      ...detail,
    });
    throw err;
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
 * POST /api/admin/sandbox/cf-vm-agent/start — start the Step 2 vm-agent spike.
 *
 * Creates a virtual cf-container node + single workspace, downloads the staged
 * vm-agent binary inside the Sandbox container, and starts NODE_ROLE=standalone.
 */
adminSandboxRoutes.post('/cf-vm-agent/start', async (c) => {
  requireSandbox(c.env);
  const config = getSandboxConfig(c.env);
  const userId = getUserId(c);
  const body = await c.req.json<{
    projectId: string;
    repository: string;
    branch?: string;
    workspaceName?: string;
    agentType?: string;
    initialPrompt?: string;
  }>();

  if (!body.projectId || typeof body.projectId !== 'string') {
    throw errors.badRequest('projectId is required');
  }
  if (!body.repository || typeof body.repository !== 'string') {
    throw errors.badRequest('repository is required');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const project = await db.query.projects.findFirst({
    where: (projects, { eq }) => eq(projects.id, body.projectId),
  });
  if (!project) {
    throw errors.notFound('Project not found');
  }

  const branch = body.branch?.trim() || 'main';
  const workspaceName = body.workspaceName?.trim() || 'CF Container Spike';
  const agentType =
    body.agentType?.trim() || project.defaultAgentType || c.env.DEFAULT_TASK_AGENT_TYPE || 'claude-code';
  const initialPrompt =
    body.initialPrompt?.trim()
    || 'Spike verification only: reply with one short sentence confirming this cf-container vm-agent chat session works.';
  const startedAt = Date.now();

  const node = await createNodeRecord(c.env, {
    userId,
    credentialAttributionUserId: userId,
    credentialAttributionSource: 'platform',
    name: `${workspaceName} Node`,
    vmSize: 'standard-1',
    vmLocation: 'cf-container',
    cloudProvider: 'cloudflare',
    heartbeatStaleAfterSeconds: c.env.NODE_HEARTBEAT_STALE_SECONDS
      ? parseInt(c.env.NODE_HEARTBEAT_STALE_SECONDS, 10)
      : 180,
    runtime: 'cf-container',
  });

  const workspaceId = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId: node.id,
    projectId: body.projectId,
    userId,
    name: workspaceName,
    displayName: workspaceName,
    normalizedDisplayName: workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    repository: body.repository,
    branch,
    status: 'creating',
    vmSize: 'standard-1',
    vmLocation: 'cf-container',
    workspaceProfile: 'lightweight',
    createdAt: now,
    updatedAt: now,
  });

  const chatSessionId = await projectDataService.createSession(
    c.env,
    body.projectId,
    workspaceId,
    workspaceName,
    null,
    userId
  );
  await db
    .update(schema.workspaces)
    .set({ chatSessionId, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  const sandboxId = node.id.toLowerCase();
  const sandbox = await getSandboxInstance(c.env, sandboxId);
  const nodeCallbackToken = await signNodeCallbackToken(node.id, c.env);
  const vmAgentPort = c.env.SANDBOX_VM_AGENT_PORT
    ? parseInt(c.env.SANDBOX_VM_AGENT_PORT, 10)
    : 8080;
  const controlPlaneUrl = `https://api.${c.env.BASE_DOMAIN}`;

  const phaseDetail = { nodeId: node.id, workspaceId, sandboxId };
  const installStart = Date.now();
  const install = await runCfVmAgentPhase('install', phaseDetail, () =>
    sandbox.exec(
      [
        'set -e',
        'mkdir -p /workspace /var/lib/vm-agent',
        `curl -fsSL "${controlPlaneUrl}/api/agent/download?os=linux&arch=amd64" -o /usr/local/bin/vm-agent.tmp`,
        'chmod +x /usr/local/bin/vm-agent.tmp',
        'mv /usr/local/bin/vm-agent.tmp /usr/local/bin/vm-agent',
        '/usr/local/bin/vm-agent --help >/dev/null 2>&1 || true',
        'ls -l /usr/local/bin/vm-agent',
      ].join('\n'),
      { timeout: config.execTimeoutMs }
    )
  );
  const installDurationMs = Date.now() - installStart;
  if (!install.success) {
    throw errors.internal(`vm-agent install failed: ${install.stderr || install.stdout}`);
  }

  const standaloneEnv = {
    NODE_ROLE: 'standalone',
    NODE_ID: node.id,
    WORKSPACE_ID: workspaceId,
    PROJECT_ID: body.projectId,
    CHAT_SESSION_ID: chatSessionId,
    CONTROL_PLANE_URL: controlPlaneUrl,
    CALLBACK_TOKEN: nodeCallbackToken,
    REPOSITORY: body.repository,
    BRANCH: branch,
    WORKSPACE_DIR: '/workspace',
    CONTAINER_MODE: 'false',
    PORT_SCAN_ENABLED: 'false',
    VM_AGENT_PORT: String(vmAgentPort),
    VM_AGENT_PROTOCOL: 'http',
    COOKIE_SECURE: 'true',
  };
  const processId = `vm-agent-${node.id.toLowerCase()}`;
  const envAssignments = Object.entries(standaloneEnv)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const start = await runCfVmAgentPhase('start', phaseDetail, () =>
    sandbox.exec(
      [
        'set -e',
        'test -x /usr/local/bin/vm-agent',
        `cd ${shellQuote('/workspace')}`,
        `nohup env ${envAssignments} /usr/local/bin/vm-agent > /tmp/vm-agent.log 2>&1 &`,
        'pid=$!',
        `echo "$pid" > ${shellQuote(`/tmp/${processId}.pid`)}`,
        'sleep 0.2',
        'if ! kill -0 "$pid" 2>/dev/null; then cat /tmp/vm-agent.log >&2 || true; exit 1; fi',
        'echo "$pid"',
      ].join('\n'),
      { timeout: config.execTimeoutMs }
    )
  );
  if (!start.success) {
    throw errors.internal(`vm-agent start failed: ${start.stderr || start.stdout}`);
  }

  const agentReadyStart = Date.now();
  await runCfVmAgentPhase('wait_for_ready', phaseDetail, () => waitForNodeAgentReady(node.id, c.env));
  const agentReadyDurationMs = Date.now() - agentReadyStart;

  const workspaceCreateStart = Date.now();
  const workspaceCallbackToken = await signCallbackToken(workspaceId, c.env);
  await runCfVmAgentPhase('create_workspace', phaseDetail, () =>
    createWorkspaceOnNode(node.id, c.env, userId, {
      workspaceId,
      repository: body.repository,
      branch,
      callbackToken: workspaceCallbackToken,
      lightweight: true,
    })
  );
  const workspaceCreateDurationMs = Date.now() - workspaceCreateStart;

  const acpSessionCreateStart = Date.now();
  const acpSession = await runCfVmAgentPhase('create_acp_session', phaseDetail, () =>
    projectDataService.createAcpSession(
      c.env,
      body.projectId,
      chatSessionId,
      initialPrompt,
      agentType
    )
  );
  await runCfVmAgentPhase('assign_acp_session', phaseDetail, () =>
    projectDataService.transitionAcpSession(c.env, body.projectId, acpSession.id, 'assigned', {
      actorType: 'system',
      actorId: userId,
      reason: 'CF container spike workspace assigned',
      workspaceId,
      nodeId: node.id,
    })
  );
  const acpSessionCreateDurationMs = Date.now() - acpSessionCreateStart;

  const acpSessionStartStart = Date.now();
  await runCfVmAgentPhase('create_vm_agent_session', phaseDetail, () =>
    createAgentSessionOnNode(
      node.id,
      workspaceId,
      acpSession.id,
      workspaceName,
      c.env,
      userId,
      chatSessionId,
      body.projectId
    )
  );
  await runCfVmAgentPhase('start_acp_session', phaseDetail, () =>
    startAgentSessionOnNode(
      node.id,
      workspaceId,
      acpSession.id,
      agentType,
      initialPrompt,
      c.env,
      userId
    )
  );
  const acpSessionStartDurationMs = Date.now() - acpSessionStartStart;

  await db
    .update(schema.workspaces)
    .set({ dispatchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspaceId));

  return c.json({
    nodeId: node.id,
    workspaceId,
    projectId: body.projectId,
    chatSessionId,
    acpSessionId: acpSession.id,
    agentType,
    sandboxId,
    processId,
    runtime: 'cf-container',
    workspaceUrl: `https://ws-${workspaceId.toLowerCase()}.${c.env.BASE_DOMAIN}`,
    timings: {
      setupDurationMs: Date.now() - startedAt,
      installDurationMs,
      agentReadyDurationMs,
      workspaceCreateDurationMs,
      acpSessionCreateDurationMs,
      acpSessionStartDurationMs,
    },
  });
});

export { adminSandboxRoutes };
